---
id: faastjs.functionstats.retries
title: FunctionStats.retries property
hide_title: true
---
[faastjs](./faastjs.md) &gt; [FunctionStats](./faastjs.functionstats.md) &gt; [retries](./faastjs.functionstats.retries.md)

## FunctionStats.retries property

The number of invocation retries attempted. This counts retries attempted by faast.js to recover from transient errors, but does not count retries by the cloud provider.

<b>Signature:</b>

```typescript
retries: number;
```