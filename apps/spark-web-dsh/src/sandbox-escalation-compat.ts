/**
 * DSH rc.7 derives filesystem escalation fields from a deployment-level
 * capability even though a strictly wider target and approval availability are
 * per-session facts. Project `write` and `edit` inside each Agent's exact scope
 * while leaving execution, sandbox enforcement, and approval owned by DSH.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { escalationHintMarker, WIDER_MODES } from "@deepseek-ai/dsh-sandbox";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolDefinition, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import type { ApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-sandbox-policy";

declare module "@deepseek-ai/cordis" {
  interface Events {
    "agent-preset/selected"(sessionId: SessionId, agentPreset: string): void;
  }
}

const TARGET_TOOLS = ["write", "edit"] as const;
type TargetToolName = (typeof TARGET_TOOLS)[number];

const WRAPPER_PROTOCOL = Symbol.for("dsh.tool-wrapper.v1");
const WRAPPER_OWNER = "@zendev-lab/spark-web-dsh/sandbox-escalation";
interface PolicyView {
  effectiveMode: SandboxMode;
  viableTargets: readonly SandboxMode[];
}

interface WrapperLayer {
  readonly owner: string;
  readonly priority: number;
  projectParameters?(parameters: Record<string, unknown>): Record<string, unknown>;
  execute?(
    args: unknown,
    exec: Parameters<ToolDefinition["execute"]>[1],
    next: (args: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

interface WrapperProtocolV1 {
  readonly version: 1;
  readonly owner: string;
  readonly name: string;
  contribute(layer: WrapperLayer): () => void;
}

type CooperativeDefinition = ToolDefinition & {
  readonly [WRAPPER_PROTOCOL]?: WrapperProtocolV1;
};

interface WrapperBinding {
  readonly definition: ToolDefinition;
  updateDelegate(delegate: ToolDefinition): void;
}

type Attachment =
  | { readonly kind: "dormant" }
  | { readonly kind: "owned"; readonly unregister: () => unknown }
  | { readonly kind: "cooperative"; readonly release: () => void }
  | { readonly kind: "incompatible"; readonly reason: string };

interface TargetState {
  readonly name: TargetToolName;
  binding?: WrapperBinding;
  attachment: Attachment;
  lastReportedError?: string;
}

interface AgentState {
  readonly agent: Agent;
  readonly targets: Map<TargetToolName, TargetState>;
  readonly disposers: Array<() => unknown>;
  disposed: boolean;
}

export function viableEscalationTargets(
  effectiveMode: SandboxMode,
  approvalPolicy: ApprovalPolicy,
): readonly SandboxMode[] {
  return approvalPolicy === "never" ? [] : (WIDER_MODES[effectiveMode] ?? []);
}

function policyFor(ctx: Context, agent: Agent): PolicyView {
  const effectiveMode = ctx.sandboxPolicy.resolve({ session: agent.session }).mode;
  const approvalPolicy =
    ctx.approval.overrideOf(agent.session) ?? ctx.approval.config.policy ?? "ask";
  return {
    effectiveMode,
    viableTargets: viableEscalationTargets(effectiveMode, approvalPolicy),
  };
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`spark web: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function projectEscalationParameters(
  parameters: Record<string, unknown>,
  targets: readonly SandboxMode[],
): Record<string, unknown> {
  const projected = structuredClone(parameters);
  const root = objectRecord(projected, "tool parameters");
  if (root.type !== "object") {
    throw new Error('spark web: tool parameters root must have type "object"');
  }
  const properties = objectRecord(root.properties, "tool parameters.properties");
  const permissions = properties.sandbox_permissions;
  const justification = properties.justification;
  if (permissions === undefined && justification === undefined) return projected;
  if (permissions === undefined || justification === undefined) {
    throw new Error(
      "spark web: escalation schema must declare sandbox_permissions and justification together",
    );
  }
  const permissionsSchema = objectRecord(permissions, "sandbox_permissions schema");
  const justificationSchema = objectRecord(justification, "justification schema");
  if (
    permissionsSchema.type !== "string" ||
    !Array.isArray(permissionsSchema.enum) ||
    !permissionsSchema.enum.every((value) => typeof value === "string")
  ) {
    throw new Error("spark web: sandbox_permissions must be a string enum");
  }
  if (justificationSchema.type !== "string") {
    throw new Error("spark web: justification must be a string");
  }
  if (targets.length === 0) {
    delete properties.sandbox_permissions;
    delete properties.justification;
    if (Array.isArray(root.required)) {
      const required = root.required.filter(
        (value) => value !== "sandbox_permissions" && value !== "justification",
      );
      if (required.length === 0) delete root.required;
      else root.required = required;
    }
  } else {
    permissionsSchema.enum = [...targets];
  }
  return projected;
}

export function normalizeEscalationArguments(args: unknown, effectiveMode: SandboxMode): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  if (!Object.hasOwn(record, "sandbox_permissions") || !Object.hasOwn(record, "justification")) {
    return args;
  }
  if (record.sandbox_permissions !== effectiveMode) return args;
  const normalized = { ...record };
  delete normalized.sandbox_permissions;
  delete normalized.justification;
  return normalized;
}

function validateTarget(definition: ToolDefinition): void {
  if (!TARGET_TOOLS.includes(definition.name as TargetToolName)) {
    throw new Error(`spark web: unsupported sandbox compatibility tool "${definition.name}"`);
  }
  if (typeof definition.description !== "string" || typeof definition.execute !== "function") {
    throw new Error(`spark web: tool "${definition.name}" has an incompatible definition`);
  }
  const parameters = objectRecord(definition.parameters, `tool "${definition.name}" parameters`);
  if (parameters.type !== "object") {
    throw new Error(`spark web: tool "${definition.name}" parameters must have type "object"`);
  }
  const properties = objectRecord(
    parameters.properties,
    `tool "${definition.name}" parameters.properties`,
  );
  const escalationFields = ["sandbox_permissions", "justification"].filter(
    (field) => properties[field] !== undefined,
  );
  if (escalationFields.length === 1) {
    throw new Error(
      `spark web: tool "${definition.name}" must expose sandbox_permissions and justification together or omit both`,
    );
  }
  const output = objectRecord(definition.output, `tool "${definition.name}" output`);
  if (
    typeof output.render !== "function" ||
    typeof output.schema !== "object" ||
    output.schema === null
  ) {
    throw new Error(`spark web: tool "${definition.name}" output contract is incompatible`);
  }
}

function protocolOf(definition: ToolDefinition): WrapperProtocolV1 | undefined {
  const protocol = (definition as CooperativeDefinition)[WRAPPER_PROTOCOL];
  if (protocol === undefined) return undefined;
  if (
    protocol.version !== 1 ||
    typeof protocol.owner !== "string" ||
    typeof protocol.name !== "string" ||
    typeof protocol.contribute !== "function"
  ) {
    throw new Error(`spark web: tool "${definition.name}" exposes an invalid wrapper protocol`);
  }
  return protocol;
}

function orderedLayers(layers: ReadonlyMap<string, WrapperLayer>): WrapperLayer[] {
  return [...layers.values()].sort(
    (left, right) => left.priority - right.priority || left.owner.localeCompare(right.owner),
  );
}

function createWrapperBinding(
  initialDelegate: ToolDefinition,
  ownLayer: WrapperLayer,
): WrapperBinding {
  let delegate = initialDelegate;
  const layers = new Map<string, WrapperLayer>([[ownLayer.owner, ownLayer]]);
  const definition: CooperativeDefinition = {
    name: initialDelegate.name,
    get description(): string {
      return delegate.description;
    },
    get parameters(): Record<string, unknown> {
      return orderedLayers(layers).reduce(
        (value, layer) => layer.projectParameters?.(value) ?? value,
        delegate.parameters,
      );
    },
    get output() {
      return delegate.output;
    },
    execute(args, exec): Promise<unknown> {
      const currentDelegate = delegate;
      const active = orderedLayers(layers).filter(
        (layer): layer is WrapperLayer & Required<Pick<WrapperLayer, "execute">> =>
          layer.execute !== undefined,
      );
      const dispatch = (index: number, current: unknown): Promise<unknown> => {
        const layer = active[index];
        if (layer === undefined) {
          return currentDelegate.execute(current, exec);
        }
        let called = false;
        return layer.execute(current, exec, (nextArgs) => {
          if (called) {
            throw new Error(
              `spark web: wrapper "${layer.owner}" called next() twice for "${delegate.name}"`,
            );
          }
          called = true;
          return dispatch(index + 1, nextArgs);
        });
      };
      return dispatch(0, args);
    },
    [WRAPPER_PROTOCOL]: {
      version: 1,
      owner: WRAPPER_OWNER,
      name: initialDelegate.name,
      contribute(layer): () => void {
        if (layers.has(layer.owner)) {
          throw new Error(
            `spark web: wrapper owner "${layer.owner}" is already registered for "${delegate.name}"`,
          );
        }
        layers.set(layer.owner, layer);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          layers.delete(layer.owner);
        };
      },
    },
  };
  Object.defineProperty(definition, "timeoutMs", {
    enumerable: true,
    get: () => delegate.timeoutMs,
  });
  if (initialDelegate.finalizeContent !== undefined) {
    definition.finalizeContent = (exec, result) =>
      delegate.finalizeContent?.call(delegate, exec, result);
  }
  if (initialDelegate.isConcurrencySafe !== undefined) {
    definition.isConcurrencySafe = (args) =>
      delegate.isConcurrencySafe?.call(delegate, args) === true;
  }
  if (initialDelegate.presentCall !== undefined) {
    definition.presentCall = (args) => delegate.presentCall?.call(delegate, args);
  }
  if (initialDelegate.presentResult !== undefined) {
    definition.presentResult = (args, result) =>
      delegate.presentResult?.call(delegate, args, result);
  }
  return {
    definition,
    updateDelegate(next): void {
      if (next.name !== initialDelegate.name) {
        throw new Error(
          `spark web: delegate name changed from "${initialDelegate.name}" to "${next.name}"`,
        );
      }
      delegate = next;
    },
  };
}

function ownLayer(ctx: Context, agent: Agent): WrapperLayer {
  return {
    owner: WRAPPER_OWNER,
    priority: 100,
    projectParameters(parameters): Record<string, unknown> {
      return projectEscalationParameters(parameters, policyFor(ctx, agent).viableTargets);
    },
    execute(args, exec, next): Promise<unknown> {
      const effectiveAgent = exec.agent ?? agent;
      return next(normalizeEscalationArguments(args, policyFor(ctx, effectiveAgent).effectiveMode));
    },
  };
}

function removeEscalationHint(text: string, hint: string): string {
  const lines = text.split("\n");
  return lines.includes(hint) ? lines.filter((line) => line !== hint).join("\n") : text;
}

function rewriteFsFailure(
  ctx: Context,
  agent: Agent,
  result: ToolExecutionResult,
): ToolExecutionResult {
  if (!result.isError || result.error.info?.code !== "FS_SANDBOX_DENIED") return result;
  const policy = policyFor(ctx, agent);
  if (policy.viableTargets.length > 0) return result;
  const message = removeEscalationHint(result.error.message, escalationHintMarker("operation"));
  if (message === result.error.message) return result;
  return {
    ...result,
    error: { ...result.error, message },
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}

export class SandboxEscalationSupervisor {
  private readonly ctx: Context;
  private readonly states = new Map<Agent, AgentState>();
  private reconciling = 0;
  private expectedToolChanges = 0;
  private reconcilePending = false;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  start(): () => Promise<void> {
    const stopCreated = this.ctx.on("agent/created", ({ agent }) => this.install(agent));
    const stopDisposed = this.ctx.on("agent/disposed", ({ agent }) => {
      try {
        this.remove(agent);
      } catch (error) {
        this.ctx.logger.warn(
          `spark web: agent "${agent.id}" sandbox compatibility cleanup failed: ${String(error)}`,
        );
      }
    });
    const stopPreset = this.ctx.on("agent-preset/selected", (sessionId) => {
      const agent = this.ctx.agents.get(sessionId);
      if (agent !== undefined) this.reconcileAgent(agent);
    });
    const stopTools = this.ctx.on("tools/change", () => {
      if (this.expectedToolChanges > 0) {
        this.expectedToolChanges -= 1;
      } else if (this.reconciling > 0) {
        this.reconcilePending = true;
      } else {
        this.reconcileAll();
      }
    });
    for (const agent of this.ctx.agents.list()) this.install(agent);
    return async () => {
      stopTools();
      stopPreset();
      stopDisposed();
      stopCreated();
      const states = [...this.states.values()];
      this.states.clear();
      for (const state of states) {
        try {
          this.coordinate(() => this.disposeState(state));
        } catch (error) {
          this.ctx.logger.warn(
            `spark web: agent "${state.agent.id}" sandbox compatibility cleanup failed: ${String(error)}`,
          );
        }
      }
    };
  }

  private install(agent: Agent): void {
    if (this.states.has(agent)) return;
    const targets = new Map<TargetToolName, TargetState>(
      TARGET_TOOLS.map((name) => [name, { name, attachment: { kind: "dormant" } }]),
    );
    const state: AgentState = { agent, targets, disposers: [], disposed: false };
    this.states.set(agent, state);
    try {
      this.coordinate(() => this.reconcileState(state, true));
      state.disposers.push(
        this.ctx.on(
          "tools/execute",
          async (exec, next): Promise<ToolExecutionResult> => {
            const result = await next();
            return exec.agent === agent && TARGET_TOOLS.includes(exec.name as TargetToolName)
              ? rewriteFsFailure(this.ctx, agent, result)
              : result;
          },
          { prepend: true },
        ),
      );
    } catch (error) {
      this.states.delete(agent);
      this.coordinate(() => this.disposeState(state));
      throw error;
    }
  }

  private remove(agent: Agent): void {
    const state = this.states.get(agent);
    if (state === undefined) return;
    this.states.delete(agent);
    this.coordinate(() => this.disposeState(state));
  }

  private reconcileAgent(agent: Agent): void {
    if (this.reconciling > 0) return;
    const state = this.states.get(agent);
    if (state !== undefined) this.coordinate(() => this.reconcileState(state, false));
  }

  private reconcileAll(): void {
    if (this.reconciling > 0) return;
    this.coordinate(() => {
      for (const state of this.states.values()) this.reconcileState(state, false);
    });
  }

  private reconcileState(state: AgentState, strict: boolean): void {
    if (state.disposed) return;
    for (const target of state.targets.values()) {
      try {
        this.reconcileTarget(state.agent, target);
      } catch (error) {
        if (strict) throw error;
        this.reportFailure(state.agent, target, error);
      }
    }
  }

  private reconcileTarget(agent: Agent, target: TargetState): void {
    this.detachTarget(target);
    const delegate = this.ctx.tools.get(target.name, agent);
    if (delegate === undefined) {
      delete target.lastReportedError;
      return;
    }
    try {
      validateTarget(delegate);
      const protocol = protocolOf(delegate);
      if (protocol !== undefined) {
        target.attachment = {
          kind: "cooperative",
          release: protocol.contribute(ownLayer(this.ctx, agent)),
        };
      } else {
        const binding = target.binding ?? createWrapperBinding(delegate, ownLayer(this.ctx, agent));
        if (target.binding === undefined) target.binding = binding;
        else binding.updateDelegate(delegate);
        const registrationCtx = agent.ctx.extend({ fiber: this.ctx.fiber });
        target.attachment = {
          kind: "owned",
          unregister: this.mutateTools(() => registrationCtx.tools.register(binding.definition)),
        };
      }
      delete target.lastReportedError;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      target.attachment = { kind: "incompatible", reason };
      throw error;
    }
  }

  private detachTarget(target: TargetState): void {
    const attachment = target.attachment;
    if (attachment.kind === "dormant") return;
    if (attachment.kind === "incompatible") {
      target.attachment = { kind: "dormant" };
      return;
    }
    if (attachment.kind === "owned") this.mutateTools(attachment.unregister);
    else attachment.release();
    target.attachment = { kind: "dormant" };
  }

  private disposeState(state: AgentState): void {
    if (state.disposed) return;
    state.disposed = true;
    const errors: unknown[] = [];
    for (const target of [...state.targets.values()].reverse()) {
      try {
        this.detachTarget(target);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const dispose of state.disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `agent "${state.agent.id}" cleanup failed`);
    }
  }

  private reportFailure(agent: Agent, target: TargetState, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (target.lastReportedError === message) return;
    target.lastReportedError = message;
    this.ctx.logger.warn(
      `spark web: agent "${agent.id}" tool "${target.name}" sandbox compatibility reconciliation failed: ${message}`,
    );
  }

  private coordinate(action: () => void): void {
    this.reconciling += 1;
    try {
      action();
    } finally {
      this.reconciling -= 1;
      if (this.reconciling === 0 && this.reconcilePending) {
        this.reconcilePending = false;
        this.reconcileAll();
      }
    }
  }

  private mutateTools<T>(action: () => T): T {
    this.expectedToolChanges += 1;
    const expected = this.expectedToolChanges;
    try {
      return action();
    } finally {
      if (this.expectedToolChanges === expected) this.expectedToolChanges -= 1;
    }
  }
}

export function startSandboxEscalationCompatibility(ctx: Context): () => Promise<void> {
  return new SandboxEscalationSupervisor(ctx).start();
}
