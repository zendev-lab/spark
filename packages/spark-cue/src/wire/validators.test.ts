import assert from "node:assert/strict";
import { test } from "vitest";

import {
  validateCueErrorPayload,
  validateCueEventPayload,
  validateCueOkPayload,
} from "./validators.ts";

const stepId = { execution: 7, index: 0 };
const scopeHash = Array.from({ length: 32 }, (_, index) => index);
const spec = {
  plan: {
    kind: "pipeline",
    pipeline: {
      segments: [
        {
          env: { REGION: "test" },
          command: ["printf", "%s", "ok"],
          pipe_to_next: null,
        },
      ],
    },
  },
  start_scope: scopeHash,
  launch_context: {
    pty: false,
    needs: { cpu: { kind: "count", value: 1 } },
    wrapper_enabled: true,
    spawn_adapter: { endpoint: "/run/user/501/cue/adapters/a.sock", token: "opaque" },
  },
  source: { name: "build.cue", line: 2, column: 1 },
};
const execution = {
  id: 7,
  state: { status: "running" },
  steps: [{ id: stepId, state: { status: "running" }, pipeline: "printf %s ok" }],
  spec,
};
const output = {
  id: stepId,
  stdout: { data: "ok", truncated: false, encoding: "utf8" },
  stderr: { data: "", truncated: false, encoding: "utf8" },
  stderr_pty_merged: false,
};
const schedule = {
  id: 4,
  schedule: { Interval: { secs: 60, nanos: 0 } },
  execution: spec,
  status: "scheduled",
  next_trigger_at_ms: 1_800_000_000_000,
};
const scope = { hash: "scope-1", parent: null, cwd: "/work", env_count: 2 };

const okPayloads: unknown[] = [
  { Ack: {} },
  { ExecutionCreated: { execution } },
  { ExecutionInfo: execution },
  { ExecutionList: [execution] },
  { ExecutionOutput: { id: 7, steps: [output] } },
  { ScheduleCreated: { schedule } },
  { ScheduleList: [schedule] },
  {
    ResourceList: [
      {
        id: "local",
        keys: ["cpu"],
        active_reservations: 1,
        captured_at_ms: 42,
        units: [{ id: "cpu-0", attrs: { cpu: { kind: "count", value: 1 } } }],
      },
    ],
  },
  { ScopeCreated: { hash: "scope-1", summary: "cwd=/work" } },
  { ScopeInfo: scope },
  { ScopeList: [scope] },
  {
    ScopeListPage: {
      scopes: [scope],
      page: { total: 1, shown: 1, limit: null, truncated: false },
    },
  },
  { TextOutput: { text: "ok", truncated: false, encoding: "utf8" } },
  {
    FgAttached: {
      id: stepId,
      attachment_id: 1,
      role: "observer",
      control_available: true,
      snapshot: "",
      snapshot_truncated: false,
    },
  },
  {
    FgRoleChanged: {
      id: stepId,
      attachment_id: 1,
      role: "controller",
      control_available: false,
    },
  },
  {
    Pong: {
      version: "0.2.0",
      protocol_version: 3,
      capabilities: ["execution-v3"],
      instance_id: "00000000-0000-4000-8000-000000000001",
      generation_id: "00000000-0000-4000-8000-000000000002",
      ready: true,
    },
  },
];

const eventPayloads: unknown[] = [
  { ExecutionCreated: { execution } },
  {
    ExecutionStateChanged: {
      id: 7,
      old_state: { status: "queued" },
      new_state: { status: "running" },
    },
  },
  {
    StepStateChanged: {
      id: stepId,
      old_state: { status: "running" },
      new_state: { status: "failed", failure: { kind: "exit", code: 2 } },
    },
  },
  { ExecutionFinished: { execution: { ...execution, state: { status: "failed" } } } },
  { OutputChunk: { id: stepId, stream: "stdout", data: "b2s=" } },
  { FgOutput: { id: stepId, attachment_id: 1, data: "b2s=" } },
  { FgControlChanged: { id: stepId, attachment_id: 1, control_available: true } },
  { FgExited: { id: stepId, attachment_id: 1, reason: "done" } },
  { ShuttingDown: { reason: "restart" } },
];

test("accepts every IPC v3 response variant", () => {
  for (const payload of okPayloads) assert.equal(validateCueOkPayload(payload), payload);
});

test("accepts every IPC v3 event variant", () => {
  for (const payload of eventPayloads) assert.equal(validateCueEventPayload(payload), payload);
});

test("accepts strict error payloads", () => {
  const payload = { code: "NOT_FOUND", message: "missing" };
  assert.equal(validateCueErrorPayload(payload), payload);
});

test("requires every IPC v3 Pong identity and readiness field", () => {
  const pong = (
    okPayloads.find((payload) => "Pong" in (payload as object)) as {
      Pong: Record<string, unknown>;
    }
  ).Pong;
  for (const field of ["instance_id", "generation_id", "ready"]) {
    const malformed = { ...pong };
    delete malformed[field];
    assert.throws(
      () => validateCueOkPayload({ Pong: malformed }),
      new RegExp(`missing field ${field}`),
    );
  }
});

test("rejects removed v2 response and event variants", () => {
  for (const payload of [
    { JobCreated: { job_id: "J1" } },
    { ChainCreated: { chain_id: "CH1" } },
    { ScriptCreated: { script_id: "R1" } },
    { CronAdded: { cron_id: "C1" } },
    { CompletionList: { items: [] } },
  ]) {
    assert.throws(() => validateCueOkPayload(payload), /unknown protocol variant/);
  }
  for (const payload of [
    { JobStateChanged: { job_id: "J1" } },
    { ChainProgress: { chain: {} } },
    { ScriptFinished: { script_id: "R1" } },
    { CronTriggered: { cron_id: "C1" } },
  ]) {
    assert.throws(() => validateCueEventPayload(payload), /unknown protocol variant/);
  }
});

test("rejects unknown fields at every typed boundary", () => {
  assert.throws(
    () => validateCueOkPayload({ ExecutionInfo: { ...execution, legacy_id: "J1" } }),
    /unknown field legacy_id/,
  );
  assert.throws(
    () =>
      validateCueOkPayload({
        ExecutionInfo: {
          ...execution,
          spec: { ...spec, plan: { ...spec.plan, old_chain: true } },
        },
      }),
    /unknown field old_chain/,
  );
  assert.throws(
    () =>
      validateCueEventPayload({
        OutputChunk: { id: stepId, stream: "stdout", data: "", seq: 1 },
      }),
    /unknown field seq/,
  );
  assert.throws(
    () => validateCueErrorPayload({ code: "BAD", message: "bad", detail: "hidden" }),
    /unknown field detail/,
  );
});

test("rejects invalid execution states and adapter handles", () => {
  assert.throws(
    () =>
      validateCueOkPayload({
        ExecutionInfo: { ...execution, spec: { ...spec, start_scope: [0, 1] } },
      }),
    /expected a 32-byte scope hash/,
  );
  assert.throws(
    () => validateCueOkPayload({ ExecutionInfo: { ...execution, state: { status: "killed" } } }),
    /unknown execution status killed/,
  );
  assert.throws(
    () =>
      validateCueOkPayload({
        ExecutionInfo: {
          ...execution,
          spec: {
            ...spec,
            launch_context: { spawn_adapter: { endpoint: 42, token: "opaque" } },
          },
        },
      }),
    /spawn_adapter.endpoint.*expected a string/,
  );
});

test("rejects malformed base64 process output", () => {
  assert.throws(
    () =>
      validateCueEventPayload({
        OutputChunk: { id: stepId, stream: "stdout", data: "x" },
      }),
    /canonical base64/,
  );
  const payload = {
    TextOutput: { text: "�", truncated: false, encoding: "base64", base64: "/w==" },
  };
  assert.equal(validateCueOkPayload(payload), payload);
});
