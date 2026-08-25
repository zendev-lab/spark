import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { defaultSocketPath, type ScriptResult } from "../client/cue-client.ts";
import {
  cueCommandIssue,
  cueCommandSyntaxIssue,
  normalizeCueBoolean,
  normalizeCueStderrForDisplay,
  normalizeCueTerminalOutput,
  normalizeCueLimit,
  normalizeCueResourceNeeds,
  normalizeCueTailBytes,
  normalizeCueTimeoutSeconds,
  registerCueOperationDefinitions,
  renderCueScriptResult,
  resolveCueWorkingDirectory,
} from "../operations/definitions.ts";
import type { CueOperationContext, CueOperationHost } from "./host-types.ts";

type RegisteredCueOperation = Parameters<CueOperationHost["registerTool"]>[0];

test("defaultSocketPath treats an empty XDG_RUNTIME_DIR as unset", () => {
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = "";
  try {
    assert.equal(defaultSocketPath(), join(tmpdir(), "cue", "cued.sock"));
  } finally {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
  }
});

test("normalizeCueTerminalOutput keeps final carriage-return frame", () => {
  assert.equal(normalizeCueTerminalOutput("Working 1\rWorking 2\rDone\n"), "Done\n");
});

test("normalizeCueTerminalOutput preserves CRLF line content", () => {
  assert.equal(normalizeCueTerminalOutput("hello\r\n"), "hello\n");
});

test("normalizeCueTerminalOutput collapses repeated spinner progress lines", () => {
  const output = [
    "⠋ Running hooks... vp check --fix...",
    "⠙ Running hooks... vp check --fix...",
    "⠹ Running hooks... vp check --fix...",
    "Passed",
  ].join("\n");

  assert.equal(
    normalizeCueTerminalOutput(output),
    ["⠹ Running hooks... vp check --fix...", "Passed"].join("\n"),
  );
});

test("normalizeCueStderrForDisplay removes duplicated PTY merge note", () => {
  assert.equal(
    normalizeCueStderrForDisplay("[PTY: stdout and stderr are merged]\nhello\r\n", "hello\r\n"),
    "",
  );
  assert.equal(
    normalizeCueStderrForDisplay(
      ["[PTY: stdout and stderr are merged]", "[PTY: stdout and stderr are merged]", "hello"].join(
        "\n",
      ),
      "hello\n",
    ),
    "",
  );
});

test("renderCueScriptResult includes source, timeout, item identity, and status", () => {
  const result = {
    executionId: "E1",
    stepIds: ["E1/S1"],
    source: { kind: "inline" },
    status: "running",
    exitCode: null,
    failedStepIndex: null,
    stdout: "ok\n",
    stderr: "bad\n",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: true,
  } satisfies ScriptResult;

  const rendered = renderCueScriptResult(result, {
    pathLabel: "<inline>",
    timeout: 12,
    tailBytes: 1024,
  }).join("\n");

  assert.match(rendered, /Execution E1: .*running.*source=<inline>/);
  assert.match(rendered, /timed_out=true/);
  assert.match(rendered, /ok/);
  assert.match(rendered, /\[stderr\]\nbad/);
});

test("renderCueScriptResult summarizes a successful execution with no output", () => {
  const result = {
    executionId: "E2",
    stepIds: ["E2/S1", "E2/S2"],
    source: { kind: "file", path: "build.cue" },
    status: "done",
    exitCode: 0,
    failedStepIndex: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
  } satisfies ScriptResult;

  const rendered = renderCueScriptResult(result, {
    pathLabel: "build.cue",
    timeout: 300,
    tailBytes: 1024,
  }).join("\n");

  assert.match(rendered, /Execution E2: .*done.*source=build\.cue/);
  assert.match(rendered, /Execution E2 completed with no output/);
});

test("spark-cue numeric and boolean normalizers reject invalid explicit values", () => {
  assert.equal(normalizeCueTailBytes(undefined, 128), 128);
  assert.equal(normalizeCueTailBytes(4096), 4096);
  assert.throws(() => normalizeCueTailBytes("4096"), /tail_bytes must be a finite number/);
  assert.throws(() => normalizeCueTailBytes(0), /tail_bytes must be a positive integer/);
  assert.throws(() => normalizeCueTailBytes(1.5), /tail_bytes must be a positive integer/);
  assert.throws(() => normalizeCueTailBytes(-1), /tail_bytes must be a positive integer/);

  assert.equal(normalizeCueLimit(null, 10), 10);
  assert.equal(normalizeCueLimit(5), 5);
  assert.throws(() => normalizeCueLimit(Number.NaN), /limit must be a finite number/);
  assert.throws(() => normalizeCueLimit(0), /limit must be a positive integer/);
  assert.throws(() => normalizeCueLimit(2.25), /limit must be a positive integer/);

  assert.equal(normalizeCueTimeoutSeconds(undefined, 300), 300);
  assert.equal(normalizeCueTimeoutSeconds(0.25, 300), 0.25);
  assert.throws(() => normalizeCueTimeoutSeconds("300", 300), /timeout must be a finite number/);
  assert.throws(() => normalizeCueTimeoutSeconds(-1, 300), /timeout must be non-negative/);

  assert.equal(normalizeCueBoolean(undefined, false, "cue_exec background"), false);
  assert.equal(normalizeCueBoolean(true, false, "cue_exec background"), true);
  assert.throws(
    () => normalizeCueBoolean("true", false, "cue_exec background"),
    /must be a boolean/,
  );

  assert.deepEqual(normalizeCueResourceNeeds({ gpu: 1, gpu_mem: "24GiB" }), {
    gpu: 1,
    gpu_mem: "24GiB",
  });
  assert.equal(normalizeCueResourceNeeds({}), undefined);
  assert.throws(() => normalizeCueResourceNeeds(["gpu"]), /must be an object/);
  assert.throws(() => normalizeCueResourceNeeds({ "need.gpu": 1 }), /omit the need\. prefix/);
  assert.throws(() => normalizeCueResourceNeeds({ gpu: -1 }), /non-negative integer/);
  assert.throws(() => normalizeCueResourceNeeds({ gpu: " " }), /non-empty string/);
});

test("resolveCueWorkingDirectory anchors explicit relative cwd to the Pi context cwd", () => {
  assert.equal(
    resolveCueWorkingDirectory(".", "/tmp/pi-session", "/tmp/process-cwd"),
    "/tmp/pi-session",
  );
  assert.equal(
    resolveCueWorkingDirectory("worktree", "/tmp/pi-session", "/tmp/process-cwd"),
    "/tmp/pi-session/worktree",
  );
  assert.equal(
    resolveCueWorkingDirectory("/var/tmp/absolute", "/tmp/pi-session", "/tmp/process-cwd"),
    "/var/tmp/absolute",
  );
  assert.equal(
    resolveCueWorkingDirectory(undefined, undefined, "/tmp/process-cwd"),
    "/tmp/process-cwd",
  );
});

test("spark-cue tools validate bad parameters before connecting to cued", async () => {
  const tools = registerCueToolsForTest();
  const execTool = tools.get("cue_exec");
  const runTool = tools.get("cue_run");
  const scriptTool = tools.get("cue_script");
  const scopeTool = tools.get("cue_scope");
  const resourceTool = tools.get("cue_resources");
  assert.ok(execTool);
  assert.ok(runTool);
  assert.ok(scriptTool);
  assert.ok(scopeTool);
  assert.ok(resourceTool);

  await assert.rejects(
    () =>
      execTool.execute(
        "call-1",
        { command: "echo ok", tail_bytes: "4096" },
        new AbortController().signal,
        () => undefined,
        {},
      ),
    /cue_exec tail_bytes must be a finite number/,
  );

  await assert.rejects(
    () =>
      execTool.execute(
        "call-2",
        { command: "echo ok", tail: false },
        new AbortController().signal,
        () => undefined,
        {},
      ),
    /cue_exec tail is not supported; use tail_bytes/,
  );

  await assert.rejects(
    () =>
      scopeTool.execute(
        "call-3",
        { env_tail_bytes: 2048 },
        new AbortController().signal,
        () => undefined,
        {},
      ),
    /cue_scope env_tail_bytes is not supported; use tail_bytes/,
  );

  await assert.rejects(
    () =>
      execTool.execute(
        "call-3b",
        { command: "echo ok", needs: { "need.gpu": 1 } },
        new AbortController().signal,
        () => undefined,
        {},
      ),
    /cue_exec needs keys must omit the need\. prefix/,
  );

  await assert.rejects(
    () =>
      runTool.execute(
        "call-4",
        { path: "notes.txt" },
        new AbortController().signal,
        () => undefined,
        { cwd: "/tmp/spark-cue-test" },
      ),
    /cue_run path must end in \.cue \(got \/tmp\/spark-cue-test\/notes\.txt\)/,
  );

  await assert.rejects(
    () =>
      runTool.execute(
        "call-5",
        { path: "missing.cue" },
        new AbortController().signal,
        () => undefined,
        { cwd: "/tmp/spark-cue-test" },
      ),
    /cue_run failed to read \/tmp\/spark-cue-test\/missing\.cue:/,
  );

  await assert.rejects(
    () =>
      scriptTool.execute(
        "call-6",
        { script: "   " },
        new AbortController().signal,
        () => undefined,
        {},
      ),
    /cue_script script must be a non-empty string/,
  );
});

test("cue_resources explains empty provider state", async () => {
  const tools = registerCueToolsForTest();
  const resourceTool = tools.get("cue_resources");
  assert.ok(resourceTool);
  const result = await resourceTool.execute(
    "call-resources",
    { action: "providers" },
    new AbortController().signal,
    () => undefined,
    {
      cwd: "/work",
      cueClient: {
        isClosed: false,
        async listResources() {
          return [];
        },
      },
    } as unknown as CueOperationContext,
  );

  assert.match(result.content[0].text, /Providers: 0/);
  assert.match(result.content[0].text, /Hint: no Cue resource provider/);
  assert.match(result.content[0].text, /remove needs=\{\.\.\.\}/);
  assert.match(result.content[0].text, /gpu\/gpu_mem/);
  assert.match(String((result.details as { hint?: unknown }).hint), /resource provider/);
});

test("script_run executes python through uv run and script_eval uses uv run --script", async () => {
  const tools = registerCueToolsForTest();
  const runTool = tools.get("script_run");
  const evalTool = tools.get("script_eval");
  assert.ok(runTool);
  assert.ok(evalTool);
  const commands: string[] = [];
  const fakeClient = {
    isClosed: false,
    async runExecution(command: string) {
      commands.push(command);
      return {
        executionId: `E${commands.length}`,
        stepIds: [`E${commands.length}/S1`],
        status: "succeeded" as const,
        stdout: "ok\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        warnings: [],
        stdoutEncoding: "utf8" as const,
        stderrEncoding: "utf8" as const,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
  };
  const ctx = {
    cwd: "/work",
    cueClient: fakeClient,
    env: { PATH: "/usr/bin" },
  } as unknown as CueOperationContext;

  const defaultEval = await evalTool.execute(
    "call-default-python",
    {
      language: "python",
      script: "print('modern')",
    },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(commands[0], `printf %s "print('modern')" |> uv run --script -`);
  assert.deepEqual((defaultEval.details as { pythonRunner?: unknown }).pythonRunner, {
    executable: "uv",
    source: "uv",
    argv: ["uv", "run", "--script"],
    note: "Python scripts are executed through `uv run --script <path>` or `uv run --script -`; inline scripts are piped through stdin.",
  });
  assert.equal(
    (defaultEval.details as { temporaryScriptPath?: string }).temporaryScriptPath,
    undefined,
  );
  assert.equal((defaultEval.details as { resolvedScriptPath?: string }).resolvedScriptPath, "-");

  const fileResult = await runTool.execute(
    "call-venv-run",
    { language: "python", path: "tools/check.py", venv: ".venv" },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(commands[1], "uv run --python /work/.venv/bin/python --script /work/tools/check.py");
  assert.equal((fileResult.details as { venv?: string }).venv, "/work/.venv");

  const evalResult = await evalTool.execute(
    "call-venv-eval",
    {
      language: "python",
      script: "print('ok')",
      venv: "/opt/venv",
    },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(
    commands[2],
    "printf %s \"print('ok')\" |> uv run --python /opt/venv/bin/python --script -",
  );
  assert.equal((evalResult.details as { venv?: string }).venv, "/opt/venv");

  await assert.rejects(
    () =>
      runTool.execute(
        "call-bad-venv-run",
        { language: "cue", path: "script.cue", venv: ".venv" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
    /script_run venv is only supported for language=python/,
  );
  await assert.rejects(
    () =>
      evalTool.execute(
        "call-bad-venv-eval",
        { language: "cue", script: "msg", venv: ".venv" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
    /script_eval venv is only supported for language=python/,
  );
});

test("Cue command preflight explains bash syntax before dispatch", () => {
  assert.equal(cueCommandSyntaxIssue("cargo build |> grep error"), undefined);
  assert.equal(cueCommandSyntaxIssue("cargo build |&> grep error"), undefined);
  assert.equal(cueCommandSyntaxIssue("cargo build -> cargo test"), undefined);
  assert.equal(cueCommandSyntaxIssue("cargo build ~> cargo test"), undefined);
  assert.match(cueCommandSyntaxIssue("git status | head") ?? "", /bare bash pipe/u);
  assert.match(cueCommandSyntaxIssue("git status; git diff") ?? "", /bash ';' syntax/u);
  assert.match(cueCommandSyntaxIssue("git status 2>/dev/null") ?? "", /redirection/u);
  assert.equal(cueCommandSyntaxIssue("echo 'a | b'"), undefined);
});

test("structured preflight carries a verbatim rewrite suggestion", () => {
  assert.equal(cueCommandIssue("cargo build |> grep error"), undefined);
  assert.equal(cueCommandIssue("echo 'a | b'"), undefined);
  assert.equal(cueCommandIssue("(a ||| b) -> c"), undefined);

  const pipe = cueCommandIssue("git status | head");
  assert.ok(pipe);
  assert.match(pipe!.reason, /bare bash pipe/u);
  assert.equal(pipe!.suggestion, "git status |> head");

  const semi = cueCommandIssue("git status; git diff");
  assert.ok(semi);
  assert.match(semi!.reason, /bash ';' syntax/u);
  assert.equal(semi!.suggestion, "git status ~> git diff");

  const redirect = cueCommandIssue("git status 2>/dev/null");
  assert.ok(redirect);
  assert.match(redirect!.reason, /redirection/u);
  assert.equal(redirect!.suggestion, undefined);

  // Multi-bare-pipe chains rewrite only the first flagged pipe (the model
  // can re-issue and get the next one); quotes and legal operators survive.
  assert.equal(cueCommandIssue("ls | head | wc")?.suggestion, "ls |> head | wc");
  assert.equal(cueCommandIssue('echo "a|b" | c')?.suggestion, 'echo "a|b" |> c');
});

test("cue_schedule filters the cron statuses emitted by Cue", async () => {
  const scheduleTool = registerCueToolsForTest().get("cue_schedule");
  assert.ok(scheduleTool);

  const ctx = {
    cueClient: {
      isClosed: false,
      async listScheduleSummaries() {
        return [
          { id: "T1", schedule: "in 1h", command: "true", status: "scheduled" as const },
          { id: "T2", schedule: "in 1m", command: "false", status: "failed" as const },
        ];
      },
    },
  } as unknown as CueOperationContext;

  const failed = await scheduleTool.execute(
    "call-list-failed",
    { action: "list", status: "failed" },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.match(failed.content[0]?.text ?? "", /T2  \[failed\]/);
  assert.doesNotMatch(failed.content[0]?.text ?? "", /T1/);

  await assert.rejects(
    () =>
      scheduleTool.execute(
        "call-list-active",
        { action: "list", status: "active" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
    /cue_schedule status must be all, scheduled, paused, completed, expired, or failed/,
  );
});

test("script_run and script_eval do not pass removed scope to RunScript", async () => {
  const tools = registerCueToolsForTest();
  const runTool = tools.get("script_run");
  const evalTool = tools.get("script_eval");
  assert.ok(runTool);
  assert.ok(evalTool);
  const dir = await mkdtemp(join(tmpdir(), "spark-cue-script-scope-"));
  const scriptPath = join(dir, "build.cue");
  await writeFile(scriptPath, "msg\n", "utf8");
  const calls: Array<{ path: string; input: string; scope?: string }> = [];
  const fakeClient = {
    isClosed: false,
    async runScript(options: { path: string; input: string; scope?: string }) {
      calls.push(options);
      return {
        executionId: `E${calls.length}`,
        stepIds: [],
        source: { kind: "file" as const, path: options.path },
        status: "done" as const,
        exitCode: 0,
        failedStepIndex: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
      } satisfies ScriptResult;
    },
  };
  const ctx = { cwd: dir, cueClient: fakeClient } as unknown as CueOperationContext;

  const fileResult = await runTool.execute(
    "call-scope-run",
    { language: "cue", path: "build.cue", scope: "abc123" },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(calls[0]?.path, scriptPath);
  assert.equal(calls[0]?.input, "msg\n");
  assert.equal(calls[0]?.scope, undefined);
  assert.equal((fileResult.details as { scope?: string }).scope, undefined);

  await evalTool.execute(
    "call-scope-eval",
    { language: "cue", script: "msg", scope: "def456" },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(calls[1]?.path, "<inline>");
  assert.equal(calls[1]?.input, "msg");
  assert.equal(calls[1]?.scope, undefined);
});

function registerCueToolsForTest(): Map<string, RegisteredCueOperation> {
  const tools = new Map<string, RegisteredCueOperation>();
  registerCueOperationDefinitions({
    registerTool: (config) => tools.set(config.name, config),
  });
  return tools;
}
