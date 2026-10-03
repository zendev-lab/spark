import type { SparkModelRef, SparkSessionState } from "@zendev-lab/spark-protocol";

import type { DaemonSessionRegistry } from "../session-registry.ts";

const SESSION_NAME_MAX_LENGTH = 32;

const ANSI_OSC_SEQUENCE_PATTERN = new RegExp(
  String.raw`\u001B\][^\u0007]*(?:\u0007|\u001B\\)`,
  "gu",
);
const ANSI_CONTROL_SEQUENCE_PATTERN = new RegExp(
  String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`,
  "gu",
);
// C0/C1 controls and bidi embedding/override/isolate controls must never reach
// a terminal label. Newlines/tabs are normalized before this sanitizer.
const UNSAFE_TITLE_CONTROL_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]`,
  "gu",
);

interface AssignCompletedSessionNameInput {
  sessionId: string;
  prompt: string;
  model: SparkModelRef;
  signal?: AbortSignal;
}

interface CompletedSessionNameDependencies {
  modelControl: {
    generateSessionName(input: {
      prompt: string;
      model: SparkModelRef;
      signal?: AbortSignal;
    }): Promise<string | undefined>;
  };
  sessionRegistry: Pick<DaemonSessionRegistry, "get"> & {
    setNameIfMissing(sessionId: string, name: string): Promise<SparkSessionState>;
  };
  logError?: (message: string) => void;
}

/**
 * Best-effort post-turn naming for user-created local Sessions.
 *
 * Eligibility is checked before the advisory model call to avoid needless
 * work. The registry performs the authoritative compare-and-set afterwards,
 * protecting a title/channel/archive transition that races the leaf call.
 */
export async function assignCompletedSessionName(
  input: AssignCompletedSessionNameInput,
  dependencies: CompletedSessionNameDependencies,
): Promise<SparkSessionState | undefined> {
  if (isOwnershipCancellation(input.signal)) return undefined;
  const session = await safelyGetSession(input.sessionId, dependencies);
  if (isOwnershipCancellation(input.signal) || !session || !isUnassignedLocalSession(session)) {
    return undefined;
  }

  let name: string | undefined;
  try {
    const generated = await dependencies.modelControl.generateSessionName({
      prompt: input.prompt,
      model: input.model,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    name = normalizeGeneratedSessionName(generated);
  } catch {
    // Explicit cancellation is an ownership transition. A local classification
    // deadline is only model degradation, so persist the deterministic fallback.
    if (isOwnershipCancellation(input.signal)) return undefined;
    logError(
      dependencies,
      `[spark-daemon] session name generation failed for ${input.sessionId}; using fallback`,
    );
  }
  if (isOwnershipCancellation(input.signal)) return undefined;
  name ??= fallbackSessionName(input.prompt);

  try {
    return await dependencies.sessionRegistry.setNameIfMissing(input.sessionId, name);
  } catch {
    // Naming is advisory. The completed transcript remains authoritative and a
    // title persistence failure must never turn a successful user turn into a
    // failed/replayed invocation.
    logError(
      dependencies,
      `[spark-daemon] failed to persist generated name for ${input.sessionId}`,
    );
    return undefined;
  }
}

function isOwnershipCancellation(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason;
  return !(reason instanceof DOMException && reason.name === "TimeoutError");
}

function isUnassignedLocalSession(session: SparkSessionState): boolean {
  return (
    session.lifecycle === "open" &&
    session.placement === "active" &&
    !session.name?.trim() &&
    session.roleBinding.kind === "none" &&
    !session.bindings.some((binding) => binding.kind === "channel")
  );
}

async function safelyGetSession(
  sessionId: string,
  dependencies: CompletedSessionNameDependencies,
): Promise<SparkSessionState | undefined> {
  try {
    return await dependencies.sessionRegistry.get(sessionId);
  } catch {
    logError(dependencies, `[spark-daemon] failed to inspect Session ${sessionId} for naming`);
    return undefined;
  }
}

function normalizeGeneratedSessionName(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const normalized = sanitizeTitleFragment(
    sanitizeTitleFragment(firstLine)
      .replace(/^#{1,6}\s*/u, "")
      .replace(/^(?:session|name|title|会话|名称|标题)\s*[:：-]\s*/iu, "")
      .replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, ""),
  );
  return normalized ? truncateName(normalized) : undefined;
}

function fallbackSessionName(prompt: string): string {
  const normalized = prompt.toLowerCase();
  const chinese = /[\p{Script=Han}]/u.test(prompt);
  if (/运维|后台|守护进程|daemon|runtime|operations|deployment/u.test(normalized)) {
    return chinese ? "运行维护" : "Runtime Operations";
  }
  if (/网页|前端|界面|交互|hub|frontend|\bui\b|web/u.test(normalized)) {
    return chinese ? "前端体验" : "Frontend Engineering";
  }
  if (/消息平台|如流|飞书|qq|infoflow|channel|bot/u.test(normalized)) {
    return chinese ? "消息平台" : "Messaging Platforms";
  }
  if (/架构|设计|边界|architecture|design/u.test(normalized)) {
    return chinese ? "架构设计" : "Architecture";
  }
  if (/测试|验收|验证|审查|review|test|verify|quality/u.test(normalized)) {
    return chinese ? "质量验证" : "Quality Verification";
  }
  return chinese ? "通用执行" : "Generalist";
}

function sanitizeTitleFragment(value: string): string {
  return value
    .replaceAll(ANSI_OSC_SEQUENCE_PATTERN, "")
    .replaceAll(ANSI_CONTROL_SEQUENCE_PATTERN, "")
    .replaceAll(UNSAFE_TITLE_CONTROL_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateName(name: string): string {
  const characters = Array.from(name);
  if (characters.length <= SESSION_NAME_MAX_LENGTH) return name;
  return `${characters.slice(0, SESSION_NAME_MAX_LENGTH - 1).join("")}…`;
}

function logError(dependencies: CompletedSessionNameDependencies, message: string): void {
  (dependencies.logError ?? console.error)(message);
}
