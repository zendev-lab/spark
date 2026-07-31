# Terminal renderer readiness

Spark's private `SparkTerminalController` is the renderer-neutral contract.
The current production adapter remains Pi TUI. OpenTUI is not a production
dependency and must be evaluated with:

```bash
pnpm run audit:renderer
```

The audit fails closed. `ready: false` means no Node-baseline increase and no
production dependency.

## OpenTUI hard gates

All gates require reproducible evidence in one isolated decision change:

1. the Spark launcher supplies Node's required FFI flags automatically;
2. clean release tarballs contain the correct native artifact on supported
   macOS, Linux, and Windows architectures;
3. split-footer scrollback, resize, custom streams, signals, shell suspend, and
   terminal restoration pass;
4. `60x18`, `80x24`, `120x30`, and `160x40` preserve the editor, status, and
   complete latest logical message;
5. session selection, model/auth, Ask, Markdown, tool/thinking folding, action
   bar, queued-input behavior, and daemon restart satisfy the controller contract;
6. production installation needs neither Bun nor Zig, and license, audit, and
   package-size release gates pass.

As currently observed, the repository supports Node `>=26.0.0 <27`, while a
Node OpenTUI native renderer requires Node 26.4.0 and experimental FFI. The
readiness audit therefore reports the exact unmet gates rather than importing
OpenTUI or changing the engine constraint.
