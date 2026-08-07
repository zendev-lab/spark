import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

test("public docs own usage while engineering docs own contracts and runbooks", async () => {
  const [
    engineeringIndex,
    publicIndex,
    commandPlanes,
    toolContracts,
    pathContract,
    acpRunbook,
    mcpRunbook,
    releaseRunbook,
    publicCli,
    publicTools,
    publicPaths,
  ] = await Promise.all([
    source("docs/README.md"),
    source("apps/spark-docs/README.md"),
    source("docs/specs/command-planes.md"),
    source("docs/specs/tools.md"),
    source("docs/specs/configuration-and-paths.md"),
    source("docs/operations/acp.md"),
    source("docs/operations/mcp.md"),
    source("docs/operations/releases.md"),
    source("apps/spark-docs/src/content/docs/reference/cli.md"),
    source("apps/spark-docs/src/content/docs/reference/tools.md"),
    source("apps/spark-docs/src/content/docs/reference/configuration-and-paths.md"),
  ]);

  assert.match(engineeringIndex, /\| `apps\/spark-docs` \| Spark users and operators \|/u);
  assert.match(engineeringIndex, /\| `docs\/specs` \| Spark implementers and reviewers \|/u);
  assert.match(engineeringIndex, /\| `docs\/operations` \| Spark maintainers \|/u);
  assert.match(publicIndex, /This tree owns \*\*how users operate Spark\*\*/u);

  assert.match(commandPlanes, /apps\/spark-docs\/src\/content\/docs\/reference\/cli\.md/u);
  assert.doesNotMatch(commandPlanes, /^## Canonical examples$/mu);
  assert.doesNotMatch(commandPlanes, /spark-daemon session list --json/u);

  assert.match(toolContracts, /apps\/spark-docs\/src\/content\/docs\/reference\/tools\.md/u);
  assert.doesNotMatch(toolContracts, /^## Foreground commands$/mu);
  assert.doesNotMatch(toolContracts, /^### Native `\/btw`$/mu);

  assert.match(
    pathContract,
    /apps\/spark-docs\/src\/content\/docs\/reference\/configuration-and-paths\.md/u,
  );
  assert.doesNotMatch(pathContract, /^## Inspecting paths$/mu);
  assert.doesNotMatch(pathContract, /spark paths --json/u);

  assert.match(acpRunbook, /reference\/cli\.md#acp-clients/u);
  assert.doesNotMatch(acpRunbook, /^## Run$/mu);

  assert.match(mcpRunbook, /reference\/cli\.md#mcp-clients/u);
  assert.doesNotMatch(mcpRunbook, /^## Client configuration$/mu);
  assert.doesNotMatch(mcpRunbook, /"mcpServers"/u);

  assert.match(releaseRunbook, /reference\/cli\.md#managed-installation-and-updates/u);
  assert.match(releaseRunbook, /reference\/configuration-and-paths\.md#managed-installation-paths/u);
  assert.doesNotMatch(releaseRunbook, /^## Managed layout$/mu);
  assert.doesNotMatch(releaseRunbook, /^Useful commands:$/mu);
  assert.doesNotMatch(releaseRunbook, /spark update status --json/u);

  assert.match(publicCli, /^## Dispatcher$/mu);
  assert.match(publicCli, /^## ACP clients$/mu);
  assert.match(publicCli, /^## MCP clients$/mu);
  assert.match(publicCli, /^## Managed installation and updates$/mu);
  assert.match(publicTools, /^## Default native profile$/mu);
  assert.match(publicPaths, /^## Self-contained SPARK_HOME$/mu);
  assert.match(publicPaths, /^## Managed installation paths$/mu);
});
