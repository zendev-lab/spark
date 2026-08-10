import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import Artifact from "./Artifact.svelte";
import CodeBlock from "./CodeBlock.svelte";
import Commit from "./Commit.svelte";
import Confirmation from "./Confirmation.svelte";
import DiffView from "./DiffView.svelte";
import FileTree from "./FileTree.svelte";
import Plan from "./Plan.svelte";
import SchemaView from "./SchemaView.svelte";
import StackTrace from "./StackTrace.svelte";
import Task from "./Task.svelte";
import Terminal from "./Terminal.svelte";
import TestResults from "./TestResults.svelte";
import Tool from "./Tool.svelte";
import WebPreview from "./WebPreview.svelte";
import WebPreviewBody from "./WebPreviewBody.svelte";
import WorkbenchPanel from "./WorkbenchPanel.svelte";

const statusLabel = (status: string) => `Status: ${status}`;

describe("workbench component SSR contracts", () => {
  it("renders compound owner facts without protocol types", () => {
    const tool = render(Tool, {
      props: {
        view: {
          id: "tool:one",
          name: "workspace.read",
          status: "completed",
          input: { path: "README.md" },
          output: { files: 1 },
        },
        statusLabel,
        inputLabel: "Input",
        outputLabel: "Output",
        errorLabel: "Error",
        emptyLabel: "No result",
        defaultOpen: true,
      },
    }).body;
    const confirmation = render(Confirmation, {
      props: {
        view: { id: "confirm:one", title: "Allow write", status: "requested" },
        statusLabel,
      },
    }).body;
    const plan = render(Plan, {
      props: {
        view: {
          id: "plan:one",
          title: "Plan",
          status: "running",
          steps: [{ id: "step", title: "Build", status: "running" }],
        },
        statusLabel,
        stepLabel: "Steps",
      },
    }).body;
    const task = render(Task, {
      props: {
        view: { id: "task:one", title: "Focused test", status: "completed" },
        statusLabel,
        taskLabel: "Task",
      },
    }).body;
    const artifact = render(Artifact, {
      props: {
        view: { id: "artifact:one", title: "Report", status: "completed" },
        previewLabel: "Preview",
        statusLabel,
      },
    }).body;
    const panel = render(WorkbenchPanel, {
      props: { id: "panel", title: "Panel", status: "pending" },
    }).body;

    expect(tool).toContain("workspace.read");
    expect(tool).toContain('"path": "README.md"');
    expect(confirmation).toContain("Allow write");
    expect(plan).toContain("Build");
    expect(task).toContain("task:one");
    expect(artifact).toContain("artifact:one");
    expect(panel).toContain("workbench-panel");
  });

  it("renders inert developer projections", () => {
    const code = render(CodeBlock, {
      props: { view: { code: "const safe = true;", language: "ts" }, copyLabel: "Copy" },
    }).body;
    const diff = render(DiffView, {
      props: {
        view: {
          id: "diff",
          title: "owner.ts",
          lines: [{ kind: "addition", text: "const safe = true;", newLine: 1 }],
        },
        additionsLabel: "added",
        deletionsLabel: "removed",
      },
    }).body;
    const tree = render(FileTree, {
      props: {
        entries: [{ id: "file", name: "owner.ts", kind: "file", depth: 0 }],
        label: "Files",
      },
    }).body;
    const terminal = render(Terminal, {
      props: {
        view: { id: "terminal", command: "pnpm test", output: "passed", status: "completed" },
        statusLabel,
      },
    }).body;
    const tests = render(TestResults, {
      props: {
        results: [{ id: "test", name: "owner test", status: "passed" }],
        label: "Tests",
        statusLabel,
        durationLabel: (value: number) => `${value} ms`,
      },
    }).body;
    const stack = render(StackTrace, {
      props: { title: "Failure", frames: [{ id: "frame", file: "owner.ts", line: 4 }] },
    }).body;
    const schema = render(SchemaView, {
      props: { title: "Schema", schema: { type: "object" }, copyLabel: "Copy" },
    }).body;
    const commit = render(Commit, {
      props: { view: { hash: "abc123", title: "Safe commit" }, openLabel: "Open" },
    }).body;
    const preview = render(WebPreview, {
      props: {
        view: { id: "preview", title: "Preview" },
        openLabel: "Open",
        imageAlt: "Preview image",
      },
    }).body;

    expect(code).toContain("const safe = true;");
    expect(diff).toContain("owner.ts");
    expect(tree).toContain('role="tree"');
    expect(terminal).toContain("pnpm test");
    expect(tests).toContain("owner test");
    expect(stack).toContain("owner.ts:4");
    expect(schema).toContain('"type": "object"');
    expect(commit).toContain("abc123");
    expect(preview).not.toContain("iframe");
  });

  it("rejects executable or non-web URLs", () => {
    const artifact = render(Artifact, {
      props: {
        view: { id: "artifact", title: "Unsafe", previewHref: "javascript:alert(1)" },
        previewLabel: "Preview",
        statusLabel,
      },
    }).body;
    const commit = render(Commit, {
      props: {
        view: { hash: "abc", title: "Unsafe", href: "data:text/html,<script>alert(1)</script>" },
        openLabel: "Open",
      },
    }).body;
    const preview = render(WebPreview, {
      props: {
        view: { id: "preview", title: "Unsafe", href: "javascript:alert(1)" },
        openLabel: "Open",
        imageAlt: "Preview",
      },
    }).body;
    const previewBody = render(WebPreviewBody, {
      props: { title: "Unsafe", src: "javascript:alert(1)" },
    }).body;

    expect(artifact).not.toContain("href=");
    expect(commit).not.toContain("href=");
    expect(preview).not.toContain("href=");
    expect(preview).not.toContain("iframe");
    expect(previewBody).not.toContain("iframe");
  });

  it("embeds only explicit preview documents in an inert iframe", () => {
    const linked = render(WebPreviewBody, {
      props: { title: "Owner preview", src: "/preview/owner" },
    }).body;
    const rendered = render(WebPreviewBody, {
      props: {
        title: "Rendered artifact",
        documentHtml: "<!doctype html><html><body><h1>Artifact</h1></body></html>",
      },
    }).body;

    expect(linked).toContain('src="/preview/owner"');
    expect(linked).toContain('sandbox=""');
    expect(linked).toContain('referrerpolicy="no-referrer"');
    expect(rendered).toContain("srcdoc=");
    expect(rendered).toContain('sandbox=""');
    expect(rendered).not.toContain("allow-scripts");
  });
});
