# @zendev-lab/spark-docs

User-facing Spark documentation. This private workspace builds the bilingual
Astro/Starlight documentation site and has no runtime dependency on another
Spark workspace.

This tree owns **how users operate Spark**: installation, workflows, public
commands and tools, user-visible configuration and paths, client setup, and
troubleshooting. Repository-internal contracts and maintainer runbooks live in
[`../../docs`](../../docs/README.md) and must link here instead of maintaining a
second public reference.

Public behavior should be documented at the highest useful level. Keep
implementation ownership, internal state-machine detail, test matrices, CI/CD/CE
procedures, and design rationale out of the site unless they directly affect a
user-visible contract. When the runtime can report an exact value (`--help`,
`spark paths --json`, status output), prefer teaching that inspection path over
copying a larger implementation inventory into the site.

```text
pnpm run dev:docs
pnpm run check:docs
pnpm run build:docs
pnpm run preview:docs
```

Cloudflare Workers Builds owns production deployment through its GitHub
integration. The build uses the following Cloudflare-side configuration:

| Setting            | Value                                                        |
| ------------------ | ------------------------------------------------------------ |
| Worker             | `spark-docs`                                                 |
| Repository         | `zendev-lab/spark`                                           |
| Production branch  | `main`                                                       |
| Root directory     | `/apps/spark-docs`                                           |
| Build command      | `pnpm run build:cloudflare`                                  |
| Deploy command     | `pnpm run deploy:cloudflare`                                 |
| Production URL     | `https://spark-docs.2742392377.workers.dev`                  |
| Build variable     | `SPARK_DOCS_SITE_URL=https://spark-docs.2742392377.workers.dev` |

Keep `main` as the production source branch. A separate generated deployment
branch is intentionally unnecessary: the Worker root directory and build watch
paths isolate docs delivery while keeping documentation, shared validation
scripts, and the workspace lockfile in one atomic source commit. Cloudflare owns
the deployed artifact; do not commit `dist/`.

Limit production builds to documentation inputs:

```text
apps/spark-docs/**
scripts/require-docs-deploy-env.mjs
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
```

Cloudflare generates and owns the build token. GitHub Actions does not hold
Cloudflare deployment credentials; its docs lane only checks the site and runs
`wrangler deploy --dry-run`.

The fallback `https://spark-docs.invalid` URL exists only so local and pull
request builds can generate canonical and sitemap output. It must never be
deployed.

## Documentation versions

Unversioned routes (`/` and `/zh/`) are **Latest**. Archived releases use a
minor-version slug after the locale: `/0.2/` and `/zh/0.2/`. The version picker
keeps the current language and page whenever the destination exists, and search
on an archived page is limited to that version.

Archive one minor version at a time:

1. Add exactly one version to the `starlight-versions` configuration.
2. Run `pnpm run build:docs` locally once. The plugin snapshots English and
   Chinese content plus the sidebar under `src/content/`.
3. Review every generated page, locale pair, internal link, and copied asset,
   then include the snapshot in version control.
4. Run `pnpm run check:docs` and run a second docs build. The second build must
   not create or change source files.

Use minor versions such as `0.2`, not patch versions such as `0.2.1`, for
archives. Once archived, fix an old version by editing that version's snapshot
directly; do not regenerate it from Latest. Keep the early-development
`starlight-versions` dependency pinned to an exact version.

## Language selection

The language picker stores an explicit `root` or `zh` preference under
`spark-docs-locale`. On a first visit to exactly `/`, and only when storage is
available with no explicit preference, a browser language whose primary tag is
`zh` routes to `/zh/`. This inference is not stored. Deep links and archived
version roots are never redirected automatically.
