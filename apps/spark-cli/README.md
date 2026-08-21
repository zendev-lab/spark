# @zendev-lab/spark-cli

The native owner of the root `spark` parser, diagnostics, process routing, and
deployment/update commands. The npm artifact resolves one platform-specific
Rust binary and provides Node companion shims. `@zendev-lab/spark` remains the
complete-installation meta package that pins this package and the executable
apps.

## Usage

```sh
spark
spark web
spark web-dsh --host 0.0.0.0
spark run --wait --json "headless Spark prompt"
spark daemon auth import pi --json
spark daemon model status --json
spark daemon status --json
spark daemon workspace ls --json
spark --help
```

The dispatcher does not own browser rendering, daemon execution, provider/model state, or host runtime code. It only routes:

- `spark` to this help text.
- `spark web ...` to the local loopback browser workbench.
- `spark web-dsh ...` to the optional DeepSeek Harness compatibility workbench.
- `spark run ...` and `spark bg ...` to daemon-native headless execution.
- `spark daemon ...` to daemon execution, authentication, model, session, and
  administration surfaces.
- `spark version`, `spark install`, and `spark update` to the linked Rust update library.

Spark 0.2 rejects the former Pi-style `--print`, `--mode`, `--list-models`,
root session aliases, and resource-management commands. Provider authentication
is under `spark daemon auth`; `spark daemon login` remains machine connectivity
for daemon/Hub. The former `spark tui` surface has been removed.

Unknown subcommands fail loudly. If npm did not install the optional package for
the current macOS/Linux architecture, the resolver exits with
`NATIVE_PACKAGE_MISSING`; it never falls back to a Node root dispatcher. A
generated complete installation injects exact daemon, Hub, web, and DSH
compatibility app entrypoints. Source checkouts fingerprint the Cargo sources,
run an incremental build when necessary, and then execute the same Rust parser.
