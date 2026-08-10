import assert from "node:assert/strict";
import { test } from "vitest";

import { findSourceMirrorAssertions } from "../scripts/check-test-quality.mjs";

test("source-mirror detector catches Vitest fragment assertions on production source", () => {
  const findings = findSourceMirrorAssertions(`
    import { readFileSync } from "node:fs";
    import { expect, test } from "vitest";
    const pagePath = new URL("../src/page.svelte", import.meta.url);
    test("mirrors implementation text", () => {
      const source = readFileSync(pagePath, "utf8");
      expect(source).toContain("function startConnectPlatform()");
      expect(source).not.toContain("legacyDeviceMode");
    });
  `);

  assert.deepEqual(
    findings.map(({ sourceVariable, assertion }) => ({ sourceVariable, assertion })),
    [
      { sourceVariable: "source", assertion: "expect(source).toContain" },
      { sourceVariable: "source", assertion: "expect(source).not.toContain" },
    ],
  );
});

test("source-mirror detector follows aliased async reads and node assert matchers", () => {
  const findings = findSourceMirrorAssertions(`
    import assert from "node:assert/strict";
    import { readFile as load } from "node:fs/promises";
    const implementationPath = new URL("../src/runtime.ts", import.meta.url);
    async function check() {
      const implementation = await load(implementationPath, "utf8");
      assert.match(implementation, /required helper/);
      assert.doesNotMatch(implementation, /retired helper/);
    }
  `);

  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map(({ assertion }) => assertion),
    ["assert.match", "assert.doesNotMatch"],
  );
});

test("source-mirror detector follows local read wrappers and repository configuration", () => {
  const findings = findSourceMirrorAssertions(`
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    const root = new URL("../", import.meta.url);
    const pagePath = new URL("src/page.svelte", root);
    const source = (path) => readFileSync(path, "utf8");
    const workflowSource = () => readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
    const page = source(pagePath);
    const workflow = workflowSource();
    assert.match(page, /implementation detail/);
    assert.doesNotMatch(workflow, /retired job/);
  `);

  assert.deepEqual(
    findings.map(({ sourceVariable }) => sourceVariable),
    ["page", "workflow"],
  );
});

test("source-mirror detector rejects implementation parsers in code tests", () => {
  const findings = findSourceMirrorAssertions(`
    import { parse } from "svelte/compiler";
    import ts from "typescript";
    parse("<p>implementation</p>");
    ts.createSourceFile("source.ts", "export {}", ts.ScriptTarget.Latest);
  `);

  assert.deepEqual(
    findings.map(({ sourceVariable, assertion }) => ({ sourceVariable, assertion })),
    [
      { sourceVariable: "svelte/compiler", assertion: "implementation parser import" },
      { sourceVariable: "typescript", assertion: "implementation parser import" },
    ],
  );
});

test("source-mirror detector ignores persisted state and rendered output assertions", () => {
  const findings = findSourceMirrorAssertions(`
    import { readFile } from "node:fs/promises";
    import { expect } from "vitest";
    async function check() {
      const persisted = await readFile("/tmp/state.json", "utf8");
      expect(persisted).toContain('"status":"ready"');
      const rendered = renderComponent();
      expect(rendered).toContain("Ready");
    }
  `);

  assert.deepEqual(findings, []);
});
