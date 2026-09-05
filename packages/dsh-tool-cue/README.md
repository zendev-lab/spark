# `@zendev-lab/dsh-tool-cue`

Private adapter for the supported DeepSeek Harness release and ten canonical Cue tools
owned by the `@zendev-lab/dsh-cue` Cordis service.

The adapter consumes `ctx.cue`, owns DSH schemas, presenters, sandbox approval,
and per-execution spawn brokers, and never constructs a second Cue runtime.
Confined local executions pass through the DSH sandbox broker. SSH execution
requires persistent `danger-full-access` because a local broker cannot confine
the remote host.
