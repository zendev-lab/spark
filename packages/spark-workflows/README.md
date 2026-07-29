# spark-workflows

Generic saved-script workflow capability for Spark capability hosts.

`@zendev-lab/spark-workflows` discovers and previews saved scripts from controlled roots and owns host-neutral workflow runtime primitives. Project workflows use `.agents/workflows/*.js`, and user workflows use `$HOME/.agents/workflows/*.js`; explicit directory overrides remain available to embedded hosts and tests. It does not accept inline workflows and does not make goal state a workflow.

The generic ready-task orchestrator also packs Task execution policies against
the node inventory. `SPARK_TASK_RESOURCE_INVENTORY` accepts JSON in this shape:

```json
{
  "nodeId": "node-0",
  "gpus": [
    {
      "id": "0",
      "memoryGiB": 80,
      "topologyClasses": ["gpu-pair", "gpu-island-4"]
    }
  ]
}
```

`gpuCount` is per side, so a paired two-GPU comparison reserves four GPUs.
Queued/running TaskRuns are the durable lease source; reconstruction after a
daemon restart prevents duplicate allocation, while terminal runs release the
lease without a second resource-state store.
