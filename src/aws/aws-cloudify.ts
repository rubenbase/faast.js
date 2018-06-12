import * as aws from "aws-sdk";
import debug from "debug";
import humanStringify from "human-stringify";
import { Readable } from "stream";
import * as uuidv4 from "uuid/v4";
import { AnyFunction, Response, ResponsifiedFunction } from "../cloudify";
import { log } from "../log";
import { packer, PackerResult } from "../packer";
import { FunctionCall, FunctionReturn } from "../shared";

export type RoleHandling = "createTemporaryRole" | "createOrReuseCachedRole";

export interface Options {
    region?: string;
    PolicyArn?: string;
    rolePolicy?: RoleHandling;
    RoleName?: string;
    timeout?: number;
    memorySize?: number;
    useQueue?: boolean;
    awsLambdaOptions?: Partial<aws.Lambda.Types.CreateFunctionRequest>;
}

export interface AWSResources {
    FunctionName: string;
    RoleName: string;
    RequestTopicArn?: string;
    ResponseQueueUrl?: string;
    DeadLetterQueueUrl?: string;
    rolePolicy: RoleHandling;
    logGroupName: string;
    region: string;
    SNSLambdaSubscriptionArn?: string;
    SNSFeedbackRole?: string;
}

export interface AWSServices {
    readonly lambda: aws.Lambda;
    readonly cloudwatch: aws.CloudWatchLogs;
    readonly iam: aws.IAM;
    readonly sqs: aws.SQS;
    readonly sns: aws.SNS;
}

export const name: string = "aws";

export interface State {
    resources: AWSResources;
    services: AWSServices;
    useQueue?: boolean;
    callResultPromises: Map<string, Deferred<QueuedResponse<any>>>;
    resultCollectorPromise?: Promise<void>;
}

export function carefully<U>(arg: aws.Request<U, aws.AWSError>) {
    return arg.promise().catch(err => log(err));
}

export function quietly<U>(arg: aws.Request<U, aws.AWSError>) {
    return arg.promise().catch(_ => {});
}

function zipStreamToBuffer(zipStream: Readable): Promise<Buffer> {
    const buffers: Buffer[] = [];
    return new Promise((resolve, reject) => {
        zipStream.on("data", data => buffers.push(data as Buffer));
        zipStream.on("end", () => resolve(Buffer.concat(buffers)));
        zipStream.on("error", reject);
    });
}

function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}

export let defaults: Required<Options> = {
    region: "us-west-1",
    PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
    rolePolicy: "createOrReuseCachedRole",
    RoleName: "cloudify-cached-lambda-role",
    timeout: 60,
    memorySize: 128,
    useQueue: true,
    awsLambdaOptions: {}
};

export function createAWSApis(region: string): AWSServices {
    return {
        iam: new aws.IAM({ apiVersion: "2010-05-08", region }),
        lambda: new aws.Lambda({ apiVersion: "2015-03-31", region }),
        cloudwatch: new aws.CloudWatchLogs({ apiVersion: "2014-03-28", region }),
        sqs: new aws.SQS({ apiVersion: "2012-11-05", region }),
        sns: new aws.SNS({ apiVersion: "2010-03-31", region })
    };
}

async function createSNSFeedbackRole(RoleName: string, services: AWSServices) {
    const { iam } = services;
    const previousRole = await quietly(iam.getRole({ RoleName }));
    if (previousRole) {
        return previousRole;
    }
    log(`Creating role "${RoleName}" for SNS failure feedback`);
    const AssumeRolePolicyDocument = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Principal: { Service: "sns.amazonaws.com" },
                Action: "sts:AssumeRole",
                Effect: "Allow"
            }
        ]
    });
    const roleParams: aws.IAM.CreateRoleRequest = {
        AssumeRolePolicyDocument,
        RoleName,
        Description: "role for SNS failures created by cloudify",
        MaxSessionDuration: 36000
    };
    const roleResponse = await iam.createRole(roleParams).promise();
    log(`Putting SNS role policy`);
    const PolicyArn = "arn:aws:iam::aws:policy/service-role/AmazonSNSRole";
    await iam.attachRolePolicy({ RoleName, PolicyArn }).promise();
    return roleResponse;
}

async function createLambdaRole(
    RoleName: string,
    PolicyArn: string,
    services: AWSServices
) {
    const { iam } = services;
    const previousRole = await quietly(iam.getRole({ RoleName }));
    if (previousRole) {
        return previousRole;
    }
    log(`Creating role "${RoleName}" for cloudify trampoline function`);
    const AssumeRolePolicyDocument = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Principal: { Service: "lambda.amazonaws.com" },
                Action: "sts:AssumeRole",
                Effect: "Allow"
            }
        ]
    });
    const roleParams: aws.IAM.CreateRoleRequest = {
        AssumeRolePolicyDocument,
        RoleName,
        Description: "role for lambda functions created by cloudify",
        MaxSessionDuration: 3600
    };
    const roleResponse = await iam.createRole(roleParams).promise();
    await iam.attachRolePolicy({ RoleName, PolicyArn }).promise();
    return roleResponse;
}

async function addNoCreateLogPolicyToRole(
    RoleName: string,
    PolicyName: string,
    services: AWSServices
) {
    const { iam } = services;
    log(`Adding inline policy to not allow log group creation to role "${RoleName}"`);
    const NoCreateLogGroupPolicy = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Resource: "*",
                Action: "logs:CreateLogGroup",
                Effect: "Deny"
            }
        ]
    });

    await iam
        .putRolePolicy({
            RoleName,
            PolicyName,
            PolicyDocument: NoCreateLogGroupPolicy
        })
        .promise();
}

async function createQueue(
    QueueName: string,
    VTimeout: number,
    services: AWSServices,
    deadLetterTargetArn?: string
) {
    const { sqs } = services;
    const createQueueRequest: aws.SQS.CreateQueueRequest = {
        QueueName,
        Attributes: {
            VisibilityTimeout: `${VTimeout}`
        }
    };
    if (deadLetterTargetArn) {
        createQueueRequest.Attributes!.RedrivePolicy = JSON.stringify({
            maxReceiveCount: "5",
            deadLetterTargetArn
        });
    }
    const response = await sqs.createQueue(createQueueRequest).promise();
    return response.QueueUrl!;
    // XXX Need to set the VisibilityTimeout when the message is being processed but not finished yet.
}

async function createDLQ(FunctionName: string, Timeout: number, state: State) {
    const { sqs } = state.services;
    state.resources.DeadLetterQueueUrl = await createQueue(
        `${FunctionName}-DLQ`,
        Timeout,
        state.services
    );
    const attributeResponse = await sqs
        .getQueueAttributes({
            QueueUrl: state.resources.DeadLetterQueueUrl,
            AttributeNames: ["QueueArn"]
        })
        .promise();
    return attributeResponse.Attributes!.QueueArn;
}

function sendQueueStopMessage(QueueUrl: string, sqs: aws.SQS) {
    log(`Sending queue stop message to: ${QueueUrl}`);
    return carefully(
        sqs.sendMessage({
            QueueUrl,
            MessageBody: "empty",
            MessageAttributes: {
                cloudify: { DataType: "String", StringValue: "stop" }
            }
        })
    );
}

function isQueueStopMessage({ MessageAttributes }: aws.SQS.Message) {
    return (
        MessageAttributes &&
        MessageAttributes.cloudify &&
        MessageAttributes.cloudify.StringValue === "stop"
    );
}

async function deadLetterQueueCollector(state: State) {
    const { sqs } = state.services;
    const { DeadLetterQueueUrl } = state.resources;
    let continueMonitoring = true;
    while (continueMonitoring) {
        const response = await sqs
            .receiveMessage({
                QueueUrl: DeadLetterQueueUrl!,
                WaitTimeSeconds: 20,
                MaxNumberOfMessages: 10,
                MessageAttributeNames: ["cloudify"]
            })
            .promise();
        const { Messages = [] } = response;
        if (Messages.length > 0) {
            log(`received ${Messages.length} dead letter queue messages`);
        }
        deleteSQSMessages(DeadLetterQueueUrl!, Messages, sqs);
        Messages.forEach(m => {
            if (isQueueStopMessage(m)) {
                log(`Dead letter queue received stop message.`);
                continueMonitoring = false;
            } else {
                log(`Dead letter message: %O`, m);
            }
        });
    }
}

async function pollAWSRequest<T>(
    n: number,
    description: string,
    fn: () => aws.Request<T, aws.AWSError>
) {
    await sleep(2000);
    let success = false;
    for (let i = 0; i < n; i++) {
        log(`Polling ${description}...`);
        const result = await quietly(fn());
        if (result) {
            return result;
        }
        await sleep(1000);
    }
    throw new Error("Polling failed for ${description}");
}

// XXX The log group created by SNS doesn't have a programmatic API to get the name. Skip?
// Try testing with limited function concurrency to see what errors are generated.
async function createSNSNotifier(Name: string, RoleArn: string, services: AWSServices) {
    const { sns } = services;
    log(`Creating SNS notifier`);
    const topic = await sns.createTopic({ Name }).promise();
    const TopicArn = topic.TopicArn!;
    log(`Created SNS notifier with TopicArn: ${TopicArn}`);
    let success = await pollAWSRequest(
        100,
        "role for SNS invocation of lambda function failure feedback",
        () =>
            sns.setTopicAttributes({
                TopicArn,
                AttributeName: "LambdaFailureFeedbackRoleArn",
                AttributeValue: RoleArn
            })
    );

    if (!success) {
        throw new Error("Could not initialize lambda execution role");
    }

    return TopicArn!;
}

async function createLogGroup(logGroupName: string, services: AWSServices) {
    const { cloudwatch } = services;
    const response = await cloudwatch.createLogGroup({ logGroupName }).promise();
    await cloudwatch.putRetentionPolicy({ logGroupName, retentionInDays: 1 }).promise();
    return response;
}

function addSnsInvokePermissionsToFunction(
    FunctionName: string,
    RequestTopicArn: string,
    services: AWSServices
) {
    const { lambda } = services;
    return lambda
        .addPermission({
            FunctionName,
            Action: "lambda:invokeFunction",
            Principal: "sns.amazonaws.com",
            StatementId: `${FunctionName}-Invoke`,
            SourceArn: RequestTopicArn
        })
        .promise();
}

export async function initialize(fModule: string, options: Options = {}): Promise<State> {
    const nonce = uuidv4();
    log(`Nonce: ${nonce}`);

    let {
        region = defaults.region,
        PolicyArn = defaults.PolicyArn,
        rolePolicy = defaults.rolePolicy,
        RoleName = defaults.RoleName,
        timeout: Timeout = defaults.timeout,
        memorySize: MemorySize = defaults.memorySize,
        useQueue = defaults.useQueue,
        awsLambdaOptions = {},
        ...rest
    } = options;
    const services = createAWSApis(region);
    const { lambda, iam, cloudwatch, sqs, sns } = services;
    const FunctionName = `cloudify-${nonce}`;
    const logGroupName = `/aws/lambda/${FunctionName}`;
    const noCreateLogGroupPolicy = `cloudify-deny-create-log-group-policy`;

    if (rolePolicy === "createTemporaryRole") {
        RoleName = `cloudify-role-${nonce}`;
    }

    async function createFunction(DeadLetterQueueUrl?: string) {
        let roleResponse = await createLambdaRole(RoleName, PolicyArn, services);
        await addNoCreateLogPolicyToRole(RoleName, noCreateLogGroupPolicy, services);
        const { archive } = await pack(fModule);
        const previous = await quietly(lambda.getFunction({ FunctionName }));
        if (previous) {
            throw new Error("Function name hash collision");
        }
        const createFunctionRequest: aws.Lambda.Types.CreateFunctionRequest = {
            FunctionName,
            Role: roleResponse.Role.Arn,
            Runtime: "nodejs6.10",
            Handler: useQueue ? "index.snsTrampoline" : "index.trampoline",
            Code: { ZipFile: await zipStreamToBuffer(archive) },
            Description: "cloudify trampoline function",
            Timeout,
            MemorySize,
            DeadLetterConfig: { TargetArn: DeadLetterQueueUrl },
            ...rest,
            ...awsLambdaOptions
        };
        log(`createFunctionRequest: ${humanStringify(createFunctionRequest)}`);
        const func = await pollAWSRequest(100, "creating function", () =>
            lambda.createFunction(createFunctionRequest)
        );
        log(`Created function ${func.FunctionName}, FunctionArn: ${func.FunctionArn}`);
        return func.FunctionArn!;
    }

    let state: State = {
        useQueue,
        callResultPromises: new Map(),
        resources: {
            FunctionName,
            RoleName,
            rolePolicy,
            logGroupName,
            region
        },
        services: { lambda, cloudwatch, iam, sqs, sns }
    };

    try {
        await createLogGroup(logGroupName, services);
        const { resources } = state;
        const DeadLetterQueueArn = await createDLQ(FunctionName, Timeout, state);
        deadLetterQueueCollector(state);

        let createFunctionPromise = createFunction(DeadLetterQueueArn);
        if (useQueue) {
            let SNSFeedbackRoleName = "cloudify-cached-SNSFeedbackRole";
            if (rolePolicy === "createTemporaryRole") {
                SNSFeedbackRoleName = `${FunctionName}-SNSRole`;
            }
            const snsRole = await createSNSFeedbackRole(SNSFeedbackRoleName, services);
            resources.SNSFeedbackRole = snsRole.Role.RoleName;
            resources.RequestTopicArn = await createSNSNotifier(
                `${FunctionName}-Requests`,
                snsRole.Role.Arn,
                services
            );
            resources.ResponseQueueUrl = await createQueue(
                `${FunctionName}-Responses`,
                Timeout,
                services,
                DeadLetterQueueArn
            );
        }
        const FunctionArn = await createFunctionPromise;
        if (useQueue) {
            const addPermissionResponse = await addSnsInvokePermissionsToFunction(
                FunctionName,
                resources.RequestTopicArn!,
                services
            );
            const snsRepsonse = await sns
                .subscribe({
                    TopicArn: resources.RequestTopicArn!,
                    Protocol: "lambda",
                    Endpoint: FunctionArn
                })
                .promise();
            log(`Created SNS subscription: ${snsRepsonse.SubscriptionArn}`);
            state.resources.SNSLambdaSubscriptionArn = snsRepsonse.SubscriptionArn!;
            startResultCollectorIfNeeded(state);
        }
        return state;
    } catch (err) {
        log(`ERROR: ${err}`);
        await cleanup(state);
        throw err;
    }
}

interface QueuedResponse<T> {
    returned: T;
    rawResponse: any;
}

interface Deferred<T> {
    resolve: (arg?: T) => void;
    reject: (err?: any) => void;
    promise: Promise<T>;
}

function createDeferred<T>(): Deferred<T> {
    let resolver!: (arg?: any) => void;
    let rejector!: (err?: any) => void;
    const promise = new Promise<any>((resolve, reject) => {
        resolver = resolve;
        rejector = reject;
    });
    return {
        resolve: resolver,
        reject: rejector,
        promise
    };
}

interface CallResults {
    CallId?: string;
    message: aws.SQS.Message;
    deferred?: Deferred<QueuedResponse<any>>;
}

function deleteSQSMessages(QueueUrl: string, Messages: aws.SQS.Message[], sqs: aws.SQS) {
    if (Messages.length > 0) {
        carefully(
            sqs.deleteMessageBatch({
                QueueUrl,
                Entries: Messages.map(m => ({
                    Id: m.MessageId!,
                    ReceiptHandle: m.ReceiptHandle!
                }))
            })
        );
    }
}

async function resultCollector(state: State) {
    const { sqs } = state.services;
    const { ResponseQueueUrl } = state.resources;
    const log = debug("cloudify:collector");
    const { callResultPromises } = state;

    function resolvePromises(results: CallResults[]) {
        for (const { message, CallId, deferred } of results) {
            if (!CallId) {
                const { MessageId, MessageAttributes, Body } = message;
                log(
                    `No CallId for MessageId: ${MessageId}, attributes: ${MessageAttributes}, Body: ${Body}`
                );
            }
            if (!message.Body) continue;
            const returned: FunctionReturn = JSON.parse(message.Body);
            if (!deferred) {
                log(`Deferred promise not found for CallID: ${CallId}`);
            } else {
                deferred.resolve({ returned, rawResponse: message });
            }
        }
    }

    function cleanup() {
        state.resultCollectorPromise = undefined;
    }

    function rejectAll() {
        log(`Rejecting ${callResultPromises.size} result promises`);
        for (const [key, promise] of callResultPromises) {
            log(`Rejecting call result: ${key}`);
            promise.reject(new Error("Call to cloud function cancelled in cleanup"));
        }
    }

    while (callResultPromises.size > 0) {
        log(
            `Polling response queue (size ${
                callResultPromises.size
            }): ${ResponseQueueUrl}`
        );

        const response = await sqs
            .receiveMessage({
                QueueUrl: ResponseQueueUrl!,
                WaitTimeSeconds: 20,
                MaxNumberOfMessages: 10,
                MessageAttributeNames: ["All"]
            })
            .promise();

        const { Messages = [] } = response;
        log(`received ${Messages.length} messages.`);

        deleteSQSMessages(ResponseQueueUrl!, Messages, sqs);

        try {
            const callResults: CallResults[] = [];
            for (const m of Messages) {
                if (isQueueStopMessage(m)) {
                    rejectAll();
                    cleanup();
                    return;
                }
                const CallId = m.MessageAttributes!.CallId.StringValue!;
                callResults.push({
                    CallId,
                    message: m,
                    deferred: callResultPromises.get(CallId)
                });
                callResultPromises.delete(CallId);
            }
            setTimeout(() => resolvePromises(callResults), 0);
        } catch (err) {
            log(err);
        }
    }
    cleanup();
    setTimeout(() => {
        startResultCollectorIfNeeded(state);
    }, 0);
}

function startResultCollectorIfNeeded(state: State) {
    if (state.callResultPromises.size > 0 && !state.resultCollectorPromise) {
        state.resultCollectorPromise = resultCollector(state);
    }
}

function enqueueCallRequest(state: State, CallId: string): Deferred<any> {
    const deferred = createDeferred<QueuedResponse<any>>();
    log(`Enqueuing call request CallId: ${CallId}, deferred: ${deferred}`);
    state.callResultPromises.set(CallId, deferred);
    startResultCollectorIfNeeded(state);
    return deferred;
}

export function cloudifyWithResponse<F extends AnyFunction>(
    state: State,
    fn: F
): ResponsifiedFunction<F> {
    const responsifedFunc = async (...args: any[]) => {
        const CallId = uuidv4();
        const { FunctionName, RequestTopicArn, ResponseQueueUrl } = state.resources;
        let callArgs: FunctionCall = {
            name: fn.name,
            args,
            CallId,
            ResponseQueueUrl
        };
        const callArgsStr = JSON.stringify(callArgs);
        log(`Calling cloud function "${fn.name}" with args: ${callArgsStr}`, "");
        const { lambda } = state.services;
        let returned: FunctionReturn | undefined;
        let error: Error | undefined;
        let rawResponse: any;
        if (state.useQueue) {
            const { sns } = state.services;
            const responsePromise = enqueueCallRequest(state, CallId).promise;
            const snsResponse = await sns
                .publish({ TopicArn: RequestTopicArn, Message: callArgsStr })
                .promise();
            ({ returned, rawResponse } = await responsePromise);
        } else {
            const request: aws.Lambda.Types.InvocationRequest = {
                FunctionName: FunctionName,
                LogType: "Tail",
                Payload: callArgsStr
            };
            log(`Invocation request: ${humanStringify(request)}`);
            rawResponse = await lambda.invoke(request).promise();
            log(`  returned: ${humanStringify(rawResponse)}`);
            log(`  requestId: ${rawResponse.$response.requestId}`);
            if (rawResponse.FunctionError) {
                if (rawResponse.LogResult) {
                    log(Buffer.from(rawResponse.LogResult!, "base64").toString());
                }
                error = new Error(rawResponse.Payload as string);
            }
            returned =
                !error &&
                rawResponse.Payload &&
                JSON.parse(rawResponse.Payload as string);
        }

        if (returned && returned.type === "error") {
            const errValue = returned.value;
            error = new Error(errValue.message);
            error.name = errValue.name;
            error.stack = errValue.stack;
        }
        const value = !error && returned && returned.value;
        let rv: Response<ReturnType<F>> = { value, error, rawResponse };
        return rv;
    };
    return responsifedFunc as any;
}

export async function deleteRole(RoleName: string, iam: aws.IAM) {
    const policies = await carefully(iam.listAttachedRolePolicies({ RoleName }));
    const AttachedPolicies = (policies && policies.AttachedPolicies) || [];
    await Promise.all(
        AttachedPolicies.map(p => p.PolicyArn!).map(PolicyArn =>
            carefully(iam.detachRolePolicy({ RoleName, PolicyArn }))
        )
    ).catch(log);
    const rolePolicyListResponse = await carefully(iam.listRolePolicies({ RoleName }));
    const RolePolicies =
        (rolePolicyListResponse && rolePolicyListResponse.PolicyNames) || [];
    await Promise.all(
        RolePolicies.map(PolicyName =>
            carefully(iam.deleteRolePolicy({ RoleName, PolicyName }))
        )
    ).catch(log);
    await carefully(iam.deleteRole({ RoleName }));
}

type PartialState = Exclude<State, "resources"> & {
    resources: Partial<AWSResources>;
};

export async function cleanup(state: PartialState) {
    const {
        FunctionName,
        RoleName,
        logGroupName,
        rolePolicy,
        RequestTopicArn,
        ResponseQueueUrl,
        SNSLambdaSubscriptionArn,
        region,
        DeadLetterQueueUrl,
        SNSFeedbackRole,
        ...rest
    } = state.resources;
    const _exhaustiveCheck: Required<typeof rest> = {};

    const { cloudwatch, iam, lambda, sqs, sns } = state.services;
    log(`Cleaning up cloudify state`);
    if (SNSLambdaSubscriptionArn) {
        log(`Deleting request queue subscription to lambda`);
        await quietly(sns.unsubscribe({ SubscriptionArn: SNSLambdaSubscriptionArn }));
    }
    const cancelPromise = cancelWithoutCleanup(state);
    if (FunctionName) {
        log(`Deleting function: ${FunctionName}`);
        await quietly(lambda.deleteFunction({ FunctionName }));
    }
    if (logGroupName) {
        log(`Deleting log group: ${logGroupName}`);
        await quietly(cloudwatch.deleteLogGroup({ logGroupName }));
    }
    if (RoleName && rolePolicy === "createTemporaryRole") {
        log(`Deleting temporary role: ${RoleName}`);
        await deleteRole(RoleName, iam);
    }
    if (SNSFeedbackRole && rolePolicy === "createTemporaryRole") {
        log(`Deleting SNS feedback role: ${SNSFeedbackRole}`);
        await deleteRole(SNSFeedbackRole, iam);
    }
    await cancelPromise;
    if (RequestTopicArn) {
        log(`Deleting request queue topic: ${RequestTopicArn}`);
        await quietly(sns.deleteTopic({ TopicArn: RequestTopicArn }));
    }
    if (ResponseQueueUrl) {
        log(`Deleting response queue: ${ResponseQueueUrl}`);
        await quietly(sqs.deleteQueue({ QueueUrl: ResponseQueueUrl }));
    }
    if (DeadLetterQueueUrl) {
        log(`Deleting dead letter queue: ${DeadLetterQueueUrl}`);
        await quietly(sqs.deleteQueue({ QueueUrl: DeadLetterQueueUrl }));
    }
}

export async function pack(functionModule: string): Promise<PackerResult> {
    return packer({
        trampolineModule: require.resolve("./aws-trampoline"),
        functionModule,
        packageBundling: "bundleNodeModules",
        webpackOptions: { externals: "aws-sdk" }
    });
}

export function getResourceList(state: State) {
    return JSON.stringify(state.resources);
}

export function cleanupResources(resourceString: string) {
    const resources: AWSResources = JSON.parse(resourceString);
    if (!resources.region) {
        throw new Error("Resources missing 'region'");
    }
    const services = createAWSApis(resources.region);
    return cleanup({ resources, services, callResultPromises: new Map() });
}

export async function cancelWithoutCleanup(state: State) {
    const { sqs } = state.services;
    const { ResponseQueueUrl } = state.resources;
    let tasks = [];
    if (ResponseQueueUrl && state.resultCollectorPromise) {
        tasks.push(sendQueueStopMessage(ResponseQueueUrl, sqs));
        log(`Stopping result collector`);
        tasks.push(state.resultCollectorPromise);
    }
    const { DeadLetterQueueUrl } = state.resources;
    if (DeadLetterQueueUrl) {
        log(`Stopping dead letter queue collector`);
        tasks.push(sendQueueStopMessage(DeadLetterQueueUrl, sqs));
    }
    await Promise.all(tasks);
}
