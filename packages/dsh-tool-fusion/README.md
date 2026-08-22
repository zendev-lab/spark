# @zendev-lab/dsh-tool-fusion

Cordis-native, bounded multi-model deliberation over the DSH LLM service.

The capability runs two to four independent panel calls concurrently, asks a
separate judge for a strict comparison, and returns that comparison to the
calling model. The judge does not write the user-facing answer: the active
agent remains the writer and must verify the advisory result.

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

The Cordis plugin registers the `fusion` DSH tool and its prompt guidance.
Parameter bounds remain enforced by its TypeBox contract even when the supported
DSH JSON Schema subset cannot advertise numeric or string-length keywords.

## Owner boundary

Model calls enter through `ctx.llm` using the invoking Agent's provider/model,
or an explicit tool argument. They create no child Agent or Session and do not
write durable scheduling state.

Daemon product composition recognizes the root package specifier as a Cordis
Agent plugin, attaches product policy, and mounts it in the invocation scope.
There is no SparkHostAPI factory or legacy subpath.
