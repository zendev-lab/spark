# @zendev-lab/dsh-tool-fusion

Cordis-native, bounded multi-model deliberation over the invocation-scoped
`ctx.sparkExecution.runLeaf` capability.

The capability runs two to four independent panel calls concurrently, asks a
separate judge for a strict comparison, and returns that comparison to the
calling model. The judge does not write the user-facing answer: the active
Spark model remains the writer and must verify the advisory result.

The package is a thin, stateless DSH ToolRuntime adapter. It owns no provider,
credential, Session, Invocation, workflow, or persistence state.

## DSH tool surface

The extension registers one canonical action tool:

```text
fusion action=deliberate question="..."
```

Panel and judge calls have no tools, sessions, or recursive Fusion access. The
tool requires approval because explicit model choices can cross provider
boundaries and every deliberation incurs additional model cost. Invalid model
output is never accepted as a successful panel or judge result.

The Cordis plugin registers the `fusion` DSH tool, its prompt guidance, and
Spark effect/mode/approval metadata. Parameter bounds remain enforced by the
same TypeBox contract as the prior Spark tool even though rc.8's supported DSH
JSON Schema subset cannot advertise numeric or string-length keywords.

## Owner boundary

Model calls enter through the injected leaf runner. The result is neither
runtime evidence nor an Artifact, and it cannot satisfy a workflow proof or
gate.

The temporary `@zendev-lab/dsh-tool-fusion/legacy` export exists only for the
stack-internal `SparkHostAPI` loader. It is removed when product composition
loads the Cordis plugin directly; it is not a public compatibility ABI.
