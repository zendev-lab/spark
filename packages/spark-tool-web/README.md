# @zendev-lab/spark-tool-web

Native Spark web search/fetch **tool family** and pi-web-access replacement
surface. This is a stateless tool adapter (`spark-tool-<family>`), not the
`spark web` application.

It registers the public network tool names expected by Spark roles, Pi
workflows, and existing web-access prompts:

- `web_search`
- `code_search`
- `fetch_content`
- `get_search_content`

The package is conservative by default:

- URL fetches run SSRF checks before network access.
- Retrieved page text is wrapped as untrusted web content so prompt-injection text is not treated as instructions.
- Provider keys are read from environment/config but never echoed in tool output.
- Content is cached under `.spark/web/content.json` and can be recovered with `get_search_content`.
- Every public web tool result is hard-capped at 32,000 characters; use the returned `responseId` to request cached content with an explicit bound.
- If a Pi host already registered the same tool name (for example through `pi-web-access`), registration skips by default rather than replacing it.
- If Pi blocks tool inspection during extension loading, Spark retries registration at `session_start`; this keeps coexistence safe while still allowing Spark-only replacement mode.

Search provider support starts with Brave Search via `BRAVE_API_KEY`; tests and hosts can inject a deterministic provider. When no provider is configured, search/code-search return a graceful no-provider result rather than failing startup.

Persisted cache keys keep the `spark-web:` `responseId` prefix and the
`.spark/web/content.json` store path so existing sessions remain recoverable
after the package rename.

## Compatibility notes

`web_search` accepts pi-web-access compatibility parameters including `provider`, `recencyFilter`, `domainFilter`, and `workflow`. Spark currently runs headless/no-curator and treats unsupported provider-specific filters as accepted compatibility metadata.

`fetch_content` accepts compatibility parameters including `forceClone`, `prompt`, `timestamp`, `frames`, and `model`. Direct URL, Jina reader, GitHub raw file, PDF placeholder, and long-content cache paths are covered. Browser/video/YouTube frame extraction is not implemented here; those parameters are accepted so existing prompts degrade predictably instead of breaking startup.

`get_search_content` supports:

- `responseId`
- `query` / `queryIndex` for search responses
- `url` / `urlIndex` for aggregate fetch responses
- `maxChars`

`code_search` is implemented through the configured Spark web search providers with a code/docs-oriented query rewrite and cached responseId output.

If another host already owns one of these tool names, registration skips it by default. Spark also retries registration at `session_start` when host inspection is unavailable, preserving coexistence without replacing the existing tool.

Persisted Spark configs that still list `@zendev-lab/spark-web/extension` are
rewritten to `@zendev-lab/spark-tool-web/extension` during profile migration.
