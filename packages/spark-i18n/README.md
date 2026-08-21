# @zendev-lab/spark-i18n

Shared Spark localization helpers and Inlang/Paraglide message boundary.

This package owns Spark locale types, language matching, formatting helpers, CLI/extension strings, generated Paraglide message functions, and Hub product UI catalogs under `@zendev-lab/spark-i18n/hub`. App-specific policy such as Hub cookie names and localized routing remains in the app layer.

`@zendev-lab/spark-i18n/cli` also owns the shared plain-text failure frame used
by public executables: a diagnostic code and outcome, followed by optional
explanation, actionable hints, and separate low-level detail. Domain owners
still choose the error code, recovery actions, and process exit status.

Generate Paraglide output before checking or consuming generated exports:

```sh
pnpm --filter @zendev-lab/spark-i18n generate
```
