import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { createSparkMemoryDirectIntentTurnAuthority } from "@zendev-lab/spark-host/memory-direct-intent";
import { SPARK_CHANNEL_ALLOWED_TOOLS } from "@zendev-lab/spark-host/system-prompt";
import {
  createMemoryProposal,
  defaultSparkMemoryStore,
  MemoryApprovalError,
} from "@zendev-lab/spark-memory";
import {
  SPARK_MEMORY_DIRECT_INTENT_REASON,
  type SparkMemoryApprovalProof,
} from "@zendev-lab/spark-protocol";
import {
  DEFAULT_SPARK_EXTENSION_SPECS,
  SparkExtensionLoader,
  SparkHostRuntime,
  SparkProviderRegistry,
  createSparkExtensionImporter,
  loadBuiltinExtensionFactories,
  loadPlugins,
  loadSparkExtensions,
} from "../host/index.ts";
import {
  createSparkNativeLocalControlSlashCommands,
  createSparkNativeRuntimeSlashCommands,
} from "../native-tui.ts";
import { catalogSparkNativeCommands } from "../native-tui/command-presentation.ts";
import { nativeKernelSlashCommandEntries } from "../native-tui/slash-commands.ts";

async function memorySnapshotDigest(cwd: string): Promise<string> {
  try {
    return createHash("sha256")
      .update(await readFile(join(cwd, ".spark", "memory", "memory.json")))
      .digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return createHash("sha256").update("<missing>").digest("hex");
  }
}

test("loadBuiltinExtensionFactories exposes the retained Spark CLI builtin extension set", () => {
  const builtinExpected = [
    "@zendev-lab/spark-ask/extension",
    "@zendev-lab/spark-artifacts/extension",
    "@zendev-lab/spark-cue/extension",
    "@zendev-lab/spark-files/extension",
    "@zendev-lab/spark-fusion/extension",
    "@zendev-lab/spark-ai/models-extension",
    "@zendev-lab/spark-memory/extension",
    "@zendev-lab/spark-roles/extension",
    "@zendev-lab/spark-session/extension",
    "@zendev-lab/spark-web/extension",
    "@zendev-lab/spark-workflows/extension",
    "@zendev-lab/spark-graft/extension",
    "@zendev-lab/spark-extension/extension",
  ];
  const optInExtensions = new Set([
    "@zendev-lab/spark-fusion/extension",
    "@zendev-lab/spark-graft/extension",
  ]);
  const defaultExpected = builtinExpected.filter((specifier) => !optInExtensions.has(specifier));
  assert.deepEqual(
    loadBuiltinExtensionFactories().map((entry) => entry.specifier),
    builtinExpected,
  );
  assert.deepEqual([...DEFAULT_SPARK_EXTENSION_SPECS], defaultExpected);
});

test("native memory loader injects the Ask-backed verifier", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-memory-loader-approval-"));
  try {
    const host = new SparkHostRuntime({ cwd });
    const result = await new SparkExtensionLoader({
      api: host,
      extensions: ["@zendev-lab/spark-memory/extension"],
    }).load();
    assert.equal(result.outcomes[0]?.ok, true);
    const memory = host.getTool("memory")?.config;
    assert.ok(memory);

    const recordRef = "memory:loader-verifier";
    const content = {
      category: "preference",
      text: "Use the native Ask-backed memory verifier.",
      reason: "Verify composition-root injection.",
      evidenceRefs: [] as string[],
      tags: ["loader"],
      status: "active",
      forgottenReason: null,
    };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proposal = createMemoryProposal({
      proposalId: "proposal:loader-verifier",
      operation: "remember",
      workspaceId: cwd,
      scope: "workspace",
      recordRef,
      expectedRevision: 0,
      content,
      expiresAt,
    });
    const proof: SparkMemoryApprovalProof = {
      schema: "spark.memory.approval-proof/v1",
      proofRef: "evidence:missing-loader-ask",
      workspaceId: cwd,
      recordRef,
      proposalId: proposal.proposalId,
      operation: proposal.operation,
      proposalDigest: proposal.proposalDigest,
      scope: proposal.scope,
      expectedRevision: proposal.expectedRevision,
      issuedAt: new Date().toISOString(),
      expiresAt,
      nonce: "loader-verifier-nonce",
      answerDigest: "a".repeat(64),
    };
    await assert.rejects(
      async () =>
        await memory.execute(
          "memory-loader-verifier",
          {
            action: "remember",
            scope: "workspace",
            category: content.category,
            text: content.text,
            reason: content.reason,
            tags: content.tags,
            proposal,
            approvalProof: proof,
            transactionId: "transaction:loader-verifier",
          },
          new AbortController().signal,
          () => {},
          { cwd },
        ),
      (error: unknown) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_APPROVAL_INVALID");
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("native memory loader accepts one exact host-signed direct remember intent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-memory-loader-direct-intent-"));
  try {
    const sessionId = "session:loader-direct-intent";
    const authority = createSparkMemoryDirectIntentTurnAuthority();
    const receipt = await authority.issue({
      surface: "tui",
      workspaceId: cwd,
      sessionId,
      turnId: "turn:loader-direct-intent",
      messageId: "message:loader-direct-intent",
      prompt: "remember: use pnpm for this workspace",
    });
    assert.ok(receipt);
    const host = new SparkHostRuntime({ cwd, memoryDirectIntentAuthority: authority });
    host.setSessionId(sessionId);
    const loaded = await new SparkExtensionLoader({
      api: host,
      extensions: ["@zendev-lab/spark-memory/extension"],
    }).load();
    assert.equal(loaded.outcomes[0]?.ok, true);
    const memory = host.getTool("memory")?.config;
    assert.ok(memory);

    const result = await memory.execute(
      "memory-loader-direct-intent",
      {
        action: "remember",
        text: "use pnpm for this workspace",
      },
      new AbortController().signal,
      () => {},
      host.makeContext(),
    );

    assert.equal(result.isError, undefined);
    const entries = await defaultSparkMemoryStore(cwd, "workspace", undefined, {
      workspaceId: cwd,
    }).list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, receipt.recordRef);
    assert.equal(entries[0]?.text, "use pnpm for this workspace");
    assert.equal(entries[0]?.lifecycle.approval.proofRef, receipt.receiptId);
    const serializedParameters = JSON.stringify(memory.parameters);
    for (const forbidden of [
      "memoryDirectIntent",
      "publicKey",
      "privateKey",
      "keyId",
      "signature",
      "signer",
      "receiptWriter",
      "issueMemoryDirectIntent",
    ]) {
      assert.equal(serializedParameters.includes(forbidden), false, forbidden);
    }

    const forgetReceipt = await authority.issue({
      surface: "tui",
      workspaceId: cwd,
      sessionId,
      turnId: "turn:loader-direct-forget",
      messageId: "message:loader-direct-forget",
      prompt: `forget ${receipt.recordRef}`,
    });
    assert.ok(forgetReceipt);
    const storePath = join(cwd, ".spark", "memory", "memory.json");
    const beforeReasonDrift = createHash("sha256")
      .update(await readFile(storePath))
      .digest("hex");
    await assert.rejects(
      async () =>
        await memory.execute(
          "memory-loader-direct-forget-reason-drift",
          { action: "forget", id: receipt.recordRef, reason: "model-selected reason" },
          new AbortController().signal,
          () => {},
          host.makeContext(),
        ),
      (error: unknown) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_APPROVAL_PROPOSAL_MISMATCH");
        return true;
      },
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(storePath))
        .digest("hex"),
      beforeReasonDrift,
    );
    await memory.execute(
      "memory-loader-direct-forget",
      { action: "forget", id: receipt.recordRef },
      new AbortController().signal,
      () => {},
      host.makeContext(),
    );
    const forgotten = (
      await defaultSparkMemoryStore(cwd, "workspace", undefined, { workspaceId: cwd }).list({
        includeForgotten: true,
      })
    )[0];
    assert.equal(forgotten?.status, "forgotten");
    assert.equal(forgotten?.lifecycle.approval.proofRef, forgetReceipt.receiptId);

    const beforeReplay = createHash("sha256")
      .update(await readFile(storePath))
      .digest("hex");
    authority.clear();
    await assert.rejects(
      async () =>
        await memory.execute(
          "memory-loader-direct-intent-cross-turn-retry",
          {
            action: "forget",
            id: receipt.recordRef,
            reason: SPARK_MEMORY_DIRECT_INTENT_REASON,
          },
          new AbortController().signal,
          () => {},
          host.makeContext(),
        ),
      (error: unknown) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_APPROVAL_REQUIRED");
        return true;
      },
    );
    const afterReplay = createHash("sha256")
      .update(await readFile(storePath))
      .digest("hex");
    assert.equal(afterReplay, beforeReplay);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("native memory loader rejects invalid direct-intent vectors without durable mutation", async () => {
  const cases = [
    "ambiguous",
    "multiple-proposals",
    "stale-message",
    "cross-turn-retry",
    "proposal-drift",
    "message-replay",
    "cross-turn-session",
    "operation-mismatch",
    "high-risk-supersede",
    "tampered-signature",
    "foreign-key",
    "turn-id-drift",
    "message-id-drift",
    "nonce-drift",
    "expiry-drift",
  ] as const;

  for (const name of cases) {
    const cwd = await mkdtemp(join(tmpdir(), `spark-memory-direct-${name}-`));
    try {
      const sessionId = "session:invalid-direct-intent";
      const authority = createSparkMemoryDirectIntentTurnAuthority();
      let hostSessionId = sessionId;
      let params: Record<string, unknown> = { action: "remember", text: "exact" };
      let expectedCode: MemoryApprovalError["code"] = "MEMORY_APPROVAL_INVALID";
      let receipt;

      if (name === "ambiguous" || name === "multiple-proposals") {
        receipt = await authority.issue({
          surface: "tui",
          workspaceId: cwd,
          sessionId,
          turnId: `turn:${name}`,
          messageId: `message:${name}`,
          prompt:
            name === "ambiguous"
              ? "remember: one and forget memory:two"
              : "remember: first and remember: second",
        });
        params = {
          action: "remember",
          scope: "workspace",
          category: "insight",
          text: "one",
          reason: SPARK_MEMORY_DIRECT_INTENT_REASON,
        };
        expectedCode = "MEMORY_APPROVAL_REQUIRED";
      } else {
        const prompt =
          name === "operation-mismatch"
            ? "forget memory:not-authorized-for-create"
            : name === "high-risk-supersede"
              ? "remember: cannot authorize supersede"
              : name === "foreign-key"
                ? "remember: local authority"
                : name === "stale-message"
                  ? "remember: stale"
                  : "remember: exact";
        receipt = await authority.issue({
          surface: "tui",
          workspaceId: cwd,
          sessionId,
          turnId: `turn:${name}`,
          messageId: `message:${name}`,
          prompt,
          ...(name === "stale-message"
            ? { now: new Date("2000-01-01T00:00:00.000Z"), ttlMs: 1 }
            : {}),
        });
        assert.ok(receipt);
      }

      let contextReceipt = receipt;
      if (name === "cross-turn-retry") {
        authority.clear();
      } else if (name === "message-replay") {
        await authority.issue({
          surface: "tui",
          workspaceId: cwd,
          sessionId,
          turnId: "turn:message-replay-successor",
          messageId: "message:message-replay-successor",
          prompt: "remember: successor turn",
        });
      } else if (name === "proposal-drift") {
        params = { action: "remember", text: "changed" };
        expectedCode = "MEMORY_APPROVAL_PROPOSAL_MISMATCH";
      } else if (name === "cross-turn-session") {
        hostSessionId = "session:different-turn";
        expectedCode = "MEMORY_APPROVAL_SCOPE_MISMATCH";
      } else if (name === "operation-mismatch") {
        params = { action: "remember", text: "not authorized" };
        expectedCode = "MEMORY_CANONICAL_ASK_REQUIRED";
      } else if (name === "high-risk-supersede") {
        params = {
          kind: "learning",
          action: "supersede",
          id: "learning:old",
          supersededBy: ["learning:new"],
        };
        expectedCode = "MEMORY_CANONICAL_ASK_REQUIRED";
      } else if (name === "tampered-signature") {
        contextReceipt = { ...receipt!, signature: "tampered" };
      } else if (name === "foreign-key") {
        const foreignAuthority = createSparkMemoryDirectIntentTurnAuthority();
        contextReceipt = await foreignAuthority.issue({
          surface: "tui",
          workspaceId: cwd,
          sessionId,
          turnId: "turn:foreign",
          messageId: "message:foreign",
          prompt: "remember: exact",
        });
      } else if (name === "turn-id-drift") {
        contextReceipt = { ...receipt!, turnId: "turn:tampered" };
      } else if (name === "message-id-drift") {
        contextReceipt = { ...receipt!, messageId: "message:tampered" };
      } else if (name === "nonce-drift") {
        contextReceipt = { ...receipt!, nonce: "tampered" };
      } else if (name === "expiry-drift") {
        contextReceipt = { ...receipt!, expiresAt: "2099-01-01T00:00:00.000Z" };
      }

      const host = new SparkHostRuntime({ cwd, memoryDirectIntentAuthority: authority });
      host.setSessionId(hostSessionId);
      await new SparkExtensionLoader({
        api: host,
        extensions: ["@zendev-lab/spark-memory/extension"],
      }).load();
      const memory = host.getTool("memory")?.config;
      assert.ok(memory);
      const before = await memorySnapshotDigest(cwd);
      const context = contextReceipt
        ? host.makeContext({ memoryDirectIntent: contextReceipt })
        : host.makeContext();
      await assert.rejects(
        async () =>
          await memory.execute(
            `invalid-${name}`,
            params,
            new AbortController().signal,
            () => {},
            context,
          ),
        (error: unknown) => {
          assert.ok(error instanceof MemoryApprovalError);
          assert.equal(error.code, expectedCode);
          return true;
        },
      );
      assert.equal(await memorySnapshotDigest(cwd), before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("default Spark extension profile leaves optional capabilities available only for opt-in", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-extension-loader-default-opt-in" });
  const result = await new SparkExtensionLoader({ api: host }).load();

  assert.equal(
    result.outcomes.some((outcome) => outcome.specifier === "@zendev-lab/spark-graft/extension"),
    false,
  );
  assert.equal(
    host.getAllTools().some((tool) => tool.name.startsWith("graft_")),
    false,
  );
  assert.equal(
    result.outcomes.some((outcome) => outcome.specifier === "@zendev-lab/spark-fusion/extension"),
    false,
  );
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "fusion"),
    false,
  );
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "artifact"),
    true,
  );
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "evidence"),
    true,
  );
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "workflow"),
    true,
  );
});

test("default Spark extension profile exposes a bounded everyday TUI catalog", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-extension-loader-default-catalog" });
  await new SparkExtensionLoader({ api: host }).load();
  const commands = {
    ...createSparkNativeRuntimeSlashCommands(host),
    ...createSparkNativeLocalControlSlashCommands(),
  };
  const visible = catalogSparkNativeCommands(commands, nativeKernelSlashCommandEntries());
  const all = catalogSparkNativeCommands(commands, nativeKernelSlashCommandEntries(), {
    includeDeprecated: true,
  });

  const common = visible.filter((entry) => entry.group === "common").map((entry) => entry.name);
  assert.equal(common.length <= 7, true);
  assert.equal(
    common.every((name) =>
      ["help", "implement", "inbox", "plan", "retry", "status", "stop"].includes(name),
    ),
    true,
  );
  assert.equal(common.includes("help"), true);
  assert.equal(common.includes("plan"), true);
  assert.equal(common.includes("implement"), true);
  assert.equal(visible.find((entry) => entry.name === "automate")?.group, "automation");
  assert.equal(
    visible.some((entry) => entry.name === "inspect"),
    true,
  );
  assert.equal(
    visible.some((entry) => entry.name === "hub"),
    false,
  );
  assert.equal(
    visible.some((entry) => entry.name === "workflows" || entry.name === "workflow-pause"),
    false,
  );
  assert.equal(commands.workflows?.handler instanceof Function, true);
  assert.equal(commands["workflow-pause"]?.handler instanceof Function, true);
  assert.equal(
    all.find((entry) => entry.name === "workflows")?.deprecatedAliasFor,
    "/workflow list",
  );
  assert.equal(
    all.find((entry) => entry.name === "workflow-runs")?.deprecatedAliasFor,
    "/workflow runs [runRef]",
  );
  assert.equal(all.find((entry) => entry.name === "hub")?.deprecatedAliasFor, "/inspect");
});

test("SparkExtensionLoader loads builtin factories through explicit imports", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-extension-loader-test", hasUI: true });
  const result = await new SparkExtensionLoader({
    api: host,
    extensions: [
      "@zendev-lab/spark-ask/extension",
      "@zendev-lab/spark-cue/extension",
      "@zendev-lab/spark-files/extension",
      "@zendev-lab/spark-fusion/extension",
      "@zendev-lab/spark-ai/models-extension",
      "@zendev-lab/spark-memory/extension",
      "@zendev-lab/spark-roles/extension",
      "@zendev-lab/spark-session/extension",
      "@zendev-lab/spark-web/extension",
      "@zendev-lab/spark-graft/extension",
      "@zendev-lab/spark-extension/extension",
    ],
  }).load();

  assert.equal(
    result.outcomes.every((outcome) => outcome.ok && outcome.builtin),
    true,
  );
  const tools = host.getActiveTools();
  assert.ok(tools.includes("ask"));
  assert.ok(!tools.includes("ask_user"));
  assert.ok(!tools.includes("ask_flow"));
  assert.ok(tools.includes("cue_exec"));
  assert.ok(tools.includes("read"));
  assert.ok(tools.includes("fusion"));
  assert.ok(tools.includes("models"));
  assert.ok(tools.includes("memory"));
  assert.ok(tools.includes("role"));
  assert.ok(tools.includes("session"));
  assert.ok(tools.includes("web_search"));
  assert.ok(tools.includes("fetch_content"));
  assert.ok(tools.includes("get_search_content"));
  assert.ok(!tools.includes("list_roles"));
  assert.ok(tools.includes("graft"));
  assert.ok(!tools.includes("graft_status"));
  assert.ok(!tools.includes("graft_patch"));
  assert.ok(!tools.includes("patch"));
  assert.ok(!tools.includes("task"));
  assert.ok(tools.includes("task_read"));
  assert.ok(tools.includes("task_write"));
  assert.ok(tools.includes("assign"));
  assert.equal(
    tools.some((tool) => tool.startsWith("spark_")),
    false,
  );
  const commands = host.listCommands().map((command) => command.name);
  assert.ok(!commands.includes("spark"));
  assert.ok(!commands.includes("research"));
  assert.ok(commands.includes("workflow:research"));
  assert.ok(!commands.some((command) => command.startsWith("graft-")));
});

test("workflow loop ticks activate the canonical workflow tool through the host allowlist", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-extension-loader-workflow-loop",
    allowedTools: ["workflow"],
  });
  const result = await new SparkExtensionLoader({
    api: host,
    extensions: ["@zendev-lab/spark-extension/extension"],
  }).load();

  assert.equal(
    result.outcomes.every((outcome) => outcome.ok),
    true,
  );
  assert.deepEqual(host.getActiveTools(), ["workflow"]);
  assert.ok(host.getAllTools().some((tool) => tool.name === "workflow"));
});

test("channel host keeps only explicitly allowed tools active after extension handlers", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-extension-loader-channel",
    sessionSurface: "channel",
    allowedTools: SPARK_CHANNEL_ALLOWED_TOOLS,
  });
  const result = await new SparkExtensionLoader({ api: host }).load();
  assert.equal(
    result.outcomes.every((outcome) => outcome.ok),
    true,
  );

  await host.emit("session_start", { reason: "channel-turn" });
  assert.deepEqual(host.getActiveTools().sort(), ["ask", "context", "session", "todo"]);
});

test("SparkExtensionLoader isolates one extension failure and continues loading later extensions", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-extension-loader-failure" });
  const result = await loadSparkExtensions({
    api: host,
    extensions: ["bad-extension", "@zendev-lab/spark-ask/extension"],
    importer: async () => ({
      default: () => {
        throw new Error("boom");
      },
    }),
  });

  assert.equal(result.outcomes.length, 2);
  assert.equal(result.outcomes[0]!.ok, false);
  assert.match(result.outcomes[0]!.error ?? "", /boom/);
  assert.equal(result.outcomes[1]!.ok, true);
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "ask"),
    true,
  );
});

test("createSparkExtensionImporter resolves builtins without calling fallback importer", async () => {
  const importer = createSparkExtensionImporter(async () => {
    throw new Error("fallback should not be used for builtins");
  });
  const mod = await importer("@zendev-lab/spark-ask/extension");
  assert.equal(typeof (mod as { default?: unknown }).default, "function");
});

test("loadPlugins default importer is wired to builtin extension imports while providers stay dynamic", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-plugin-builtin-importer" });
  const registry = new SparkProviderRegistry();
  const result = await loadPlugins({
    extensionApi: host,
    providerApi: registry,
    extensions: ["@zendev-lab/spark-ask/extension"],
    providers: [],
  });

  assert.equal(result.outcomes[0]!.ok, true);
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "ask"),
    true,
  );
});
