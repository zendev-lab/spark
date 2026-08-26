# @zendev-lab/dsh-tool-web

Provider-neutral Cordis/DeepSeek Harness plugin for Spark's supported Web tool
family. It implements the standard DSH plugin ABI (`name`, `inject`, `Config`,
and `apply(ctx)`) over the official provider-neutral `ctx.web` service. It does
not require a DeepSeek-hosted search backend.

The plugin registers:

- `web_search` — up to four provider-neutral Web queries;
- `web_fetch` — safe HTTP(S) retrieval through the selected `ctx.web` provider;
- `get_search_content` — recovery of cached results by `responseId` when the
  earlier model-facing result was truncated.

`code_search` is intentionally absent. The former tool only rewrote a query
with “code examples documentation API reference” before calling the same Web
provider. Coding agents should express that intent in `web_search`; it is not a
separate provider, index, or state boundary.

## Provider boundary

The plugin registers a Brave search adapter and a safe local HTTP fetch adapter
with `ctx.web`. The Brave adapter is usable when `BRAVE_API_KEY` is set. Hosts
may register any additional standard `WebSearchProvider` or `WebFetchProvider`;
`ctx.web` remains the single owner of provider selection, ambiguity, availability,
cancellation, and normalized results.

The tool layer does not call a model or choose a provider. The standard
`DSH_WEB_SEARCH_PROVIDER` and `DSH_WEB_FETCH_PROVIDER` settings select an
explicit provider when more than one usable implementation is registered.

The local fetch provider supports direct, Jina, and GitHub raw-file retrieval
as deployment configuration. It validates every redirect and rejects local,
private, metadata, credential-bearing, and non-HTTP(S) targets by default.

## Recovery cache

The tool plugin keeps at most 64 complete responses in Agent-lifetime memory.
`get_search_content` resolves its `dsh-web:` response IDs without making the
`dsh-tool-*` consumer a persistent state owner. The old
`.spark/web/content.json` file is neither read nor deleted by this hard cut.

All model-facing text is capped at 32,000 characters. URL fetches reject local,
private, metadata, and non-HTTP(S) targets by default, and retrieved text is
wrapped as untrusted Web content before it reaches the model.
