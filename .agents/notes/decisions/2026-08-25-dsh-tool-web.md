---
description: "Move Spark Web tools onto the official ctx.web seam as dsh-tool-web"
---

# DSH Web tool and provider boundary

Date: 2026-08-25

## Decision

Replace `@zendev-lab/spark-tool-web` with the Cordis-native
`@zendev-lab/dsh-tool-web` package. The package has two lifecycle-specific
plugin entries without introducing a second package or owner:

- the default entry registers the per-Agent `web_search`, `web_fetch`, and
  `get_search_content` tools;
- `@zendev-lab/dsh-tool-web/provider` registers the host-level Brave search and
  safe local HTTP fetch providers with the official `ctx.web` service.

The daemon mounts `@deepseek-ai/dsh-web` and the provider entry once on its
Cordis root. `spark-web-dsh` mounts the provider entry in the host overlay and
the tool entry from each managed Agent preset. This follows the service's real
lifecycle: provider ids are host-global, while tool registries are Agent-local.

## Public surface

- `web_search` adopts the DSH query-array shape and delegates provider selection
  to `ctx.web`.
- `web_fetch` replaces the old `fetch_content` name and delegates retrieval to
  `ctx.web`.
- `get_search_content` remains an additional local recovery tool for complete
  cached content.
- `code_search` is removed. It was only a query rewrite over the same Web
  provider, not a code index, repository search, permission, or state boundary.

This is an intentional hard cut: no public aliases remain for `code_search` or
`fetch_content`.

## Ownership and compatibility

`ctx.web` is the single provider registry and selection owner. The local plugin
does not implement a private cascade or call an LLM to synthesize provider
results. DeepSeek-backed, Brave, Exa, or future providers can coexist through
the same standard ABI; explicit `DSH_WEB_SEARCH_PROVIDER` and
`DSH_WEB_FETCH_PROVIDER` settings resolve multiple usable providers.

The tool keeps at most 64 complete responses in Agent-lifetime memory for
`get_search_content`. It owns no persistent state, so the `dsh-tool-*` package
remains a true stateless consumer. New ids use the `dsh-web:` prefix. The old
`.spark/web/content.json` file is neither read nor deleted by this hard cut;
there is no persisted-state migration.

The local HTTP provider validates every redirect and rejects private,
loopback, metadata, credential-bearing, and non-HTTP(S) targets by default.
Fetched content remains explicitly marked as untrusted before model exposure.

## Supersession

This decision supersedes only the earlier disposition that retained
`spark-tool-web` and `code_search` in:

- [DSH package naming](2026-08-20-dsh-package-naming.md)
- [Web replacement and package normalization](2026-08-23-web-replacement-and-package-normalization.md)

Their other package and migration decisions remain in force.
