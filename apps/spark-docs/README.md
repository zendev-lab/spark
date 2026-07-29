# @zendev-lab/spark-docs

User-facing Spark documentation. This private workspace builds a bilingual
Astro/Starlight static site and has no runtime dependency on another Spark
workspace.

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
scripts/check-user-docs.mjs
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
