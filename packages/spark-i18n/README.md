# @zendev-lab/spark-i18n

Shared Spark localization helpers and Inlang/Paraglide message boundary.

This package owns Spark locale types, language matching, formatting helpers, CLI/extension strings, generated Paraglide message functions, and Hub product UI catalogs under `@zendev-lab/spark-i18n/hub`. App-specific policy such as Hub cookie names and localized routing remains in the app layer.

Generate Paraglide output before checking or consuming generated exports:

```sh
pnpm --filter @zendev-lab/spark-i18n generate
```
