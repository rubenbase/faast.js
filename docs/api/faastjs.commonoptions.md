---
id: faastjs.commonoptions
title: CommonOptions interface
hide_title: true
---
[faastjs](./faastjs.md) &gt; [CommonOptions](./faastjs.commonoptions.md)

## CommonOptions interface

Options common across all faast.js providers. Used as argument to [faast()](./faastjs.faast.md)<!-- -->.

<b>Signature:</b>

```typescript
export interface CommonOptions 
```

## Properties

|  Property | Type | Description |
|  --- | --- | --- |
|  [addDirectory](./faastjs.commonoptions.adddirectory.md) | <code>string &#124; string[]</code> | Add local directories to the code package. |
|  [addZipFile](./faastjs.commonoptions.addzipfile.md) | <code>string &#124; string[]</code> | Add zip files to the code package. |
|  [childProcess](./faastjs.commonoptions.childprocess.md) | <code>boolean</code> | If true, create a child process to isolate user code from faast scaffolding. Default: true. |
|  [concurrency](./faastjs.commonoptions.concurrency.md) | <code>number</code> | The maximum number of concurrent invocations to allow. Default: 100, except for the <code>local</code> provider, where the default is 10. |
|  [gc](./faastjs.commonoptions.gc.md) | <code>boolean</code> | Garbage collection is enabled if true. Default: true. |
|  [maxRetries](./faastjs.commonoptions.maxretries.md) | <code>number</code> | Maximum number of times that faast will retry each invocation. Default: 2 (invocations can therefore be attemped 3 times in total). |
|  [memorySize](./faastjs.commonoptions.memorysize.md) | <code>number</code> | Memory limit for each function in MB. This setting has an effect on pricing. Default varies by provider. |
|  [mode](./faastjs.commonoptions.mode.md) | <code>&quot;https&quot; &#124; &quot;queue&quot; &#124; &quot;auto&quot;</code> | Specify invocation mode. Default: <code>&quot;auto&quot;</code>. |
|  [packageJson](./faastjs.commonoptions.packagejson.md) | <code>string &#124; object</code> | Specify a package.json file to include with the code package. |
|  [retentionInDays](./faastjs.commonoptions.retentionindays.md) | <code>number</code> | Specify how many days to wait before reclaiming cloud garbage. Default: 1. |
|  [speculativeRetryThreshold](./faastjs.commonoptions.speculativeretrythreshold.md) | <code>number</code> | <b><i>(BETA)</i></b> Reduce tail latency by retrying invocations that take substantially longer than other invocations of the same function. Default: 3. |
|  [timeout](./faastjs.commonoptions.timeout.md) | <code>number</code> | Execution time limit for each invocation, in seconds. Default: 60. |
|  [useDependencyCaching](./faastjs.commonoptions.usedependencycaching.md) | <code>boolean</code> | Cache installed dependencies from [CommonOptions.packageJson](./faastjs.commonoptions.packagejson.md)<!-- -->. Only applies to AWS. Default: true. |
|  [webpackOptions](./faastjs.commonoptions.webpackoptions.md) | <code>webpack.Configuration</code> | Extra webpack options to use to bundle the code package. |

## Remarks

There are also more specific options for each provider. See [AwsOptions](./faastjs.awsoptions.md)<!-- -->, [GoogleOptions](./faastjs.googleoptions.md)<!-- -->, and [LocalOptions](./faastjs.localoptions.md)<!-- -->.