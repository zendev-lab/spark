# `@zendev-lab/dsh-tool-cue`

Private adapter for the supported DeepSeek Harness release and ten canonical Cue tools
owned by `@zendev-lab/spark-cue/operations`.

The adapter executes Cue only when the calling DSH session currently resolves
to `danger-full-access`. This is a fail-closed permission gate: an external
`cued` process is not confined by DSH's file sandbox. SSH profiles require an
explicit `remoteCwd`, and the adapter never auto-starts a remote daemon.
