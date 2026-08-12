/**
 * oRPC client for the daemon-orpc.sock MessagePort transport.
 * The protocol-aware facade decides whether a pre-dispatch connection failure
 * may use the temporary 0.1.x legacy transport.
 */
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import {
  sparkLocalRpcOrpcLiveMethods,
  sparkLocalRpcProcedureSchemas,
  type SparkLocalRpcInput,
  type SparkLocalRpcMethod,
  type SparkLocalRpcOrpcClient,
  type SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import {
  isSparkSideThreadErrorCode,
  type SparkSideThreadErrorCode,
} from "@zendev-lab/spark-protocol/side-thread";
import { resolveSparkPaths, type SparkPaths } from "@zendev-lab/spark-system";
import {
  createSocketMessagePort,
  type SocketMessagePortLike,
} from "@zendev-lab/spark-system/socket-message-port";

export interface SparkDaemonOrpcClientOptions {
  paths?: Pick<SparkPaths, "runtimeDir">;
  socketPath?: string;
  env?: Record<string, string | undefined>;
  connectTimeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export function sparkDaemonOrpcSocketPath(
  paths: Pick<SparkPaths, "runtimeDir"> = resolveSparkPaths({ app: "daemon" }),
): string {
  return join(paths.runtimeDir, "daemon-orpc.sock");
}

export function isSparkDaemonOrpcLiveMethod(method: string): method is SparkLocalRpcMethod {
  return (sparkLocalRpcOrpcLiveMethods as readonly string[]).includes(method);
}

/** @deprecated Prefer the contract-derived {@link SparkLocalRpcOrpcClient}. */
export type SparkDaemonOrpcClient = SparkLocalRpcOrpcClient;

export interface SparkDaemonOrpcInvokeOptions {
  signal?: AbortSignal;
}

export interface SparkDaemonOrpcClientHandle {
  client: SparkDaemonOrpcClient;
  port: SocketMessagePortLike;
  invoke<M extends SparkLocalRpcMethod>(
    method: M,
    params: SparkLocalRpcInput<M>,
    options?: SparkDaemonOrpcInvokeOptions,
  ): Promise<SparkLocalRpcOutput<M>>;
  close(): void;
}

type EmptyClientContext = Record<never, never>;

/** A typed Side Thread domain error returned by the daemon oRPC surface. */
export type SparkDaemonSideThreadOrpcError = Error & { code: SparkSideThreadErrorCode };

/**
 * Narrows a client rejection to the Side Thread errors explicitly declared in
 * the protocol contract. oRPC INTERNAL and transport failures intentionally do
 * not pass this check.
 */
export function isSparkDaemonSideThreadOrpcError(
  error: unknown,
): error is SparkDaemonSideThreadOrpcError {
  return (
    error instanceof Error &&
    "code" in error &&
    isSparkSideThreadErrorCode((error as { code?: unknown }).code)
  );
}

type SparkDaemonOrpcProcedureInvoker<M extends SparkLocalRpcMethod> = (
  client: SparkDaemonOrpcClient,
  input: SparkLocalRpcInput<M>,
  options: SparkDaemonOrpcInvokeOptions,
) => Promise<SparkLocalRpcOutput<M>>;

type SparkDaemonOrpcProcedureInvokerMap = {
  [M in SparkLocalRpcMethod]: SparkDaemonOrpcProcedureInvoker<M>;
};

async function parseSparkDaemonOrpcOutput<TOutput>(
  schema: { parse(value: unknown): TOutput },
  output: Promise<TOutput>,
): Promise<TOutput> {
  return schema.parse(await output);
}

const toolExecutionInvokers = {
  "file.execute": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["file.execute"].output,
      client.file.execute(input, options),
    ),
  "artifact.execute": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["artifact.execute"].output,
      client.artifact.execute(input, options),
    ),
  "git.execute": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["git.execute"].output,
      client.git.execute(input, options),
    ),
  "lens.execute": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["lens.execute"].output,
      client.lens.execute(input, options),
    ),
} satisfies Pick<
  SparkDaemonOrpcProcedureInvokerMap,
  "file.execute" | "artifact.execute" | "git.execute" | "lens.execute"
>;

const daemonChannelTurnInvokers = {
  "daemon.status": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["daemon.status"].output,
      client.daemon.status(input, options),
    ),
  "daemon.stop": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["daemon.stop"].output,
      client.daemon.stop(input, options),
    ),
  "daemon.restart": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["daemon.restart"].output,
      client.daemon.restart(input, options),
    ),
  "channel.status": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["channel.status"].output,
      client.channel.status(input, options),
    ),
  "channel.configure": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["channel.configure"].output,
      client.channel.configure(input, options),
    ),
  "channel.reload": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["channel.reload"].output,
      client.channel.reload(input, options),
    ),
  "channel.notify": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["channel.notify"].output,
      client.channel.notify(input, options),
    ),
  "turn.submit": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["turn.submit"].output,
      client.turn.submit(input, options),
    ),
  "turn.status": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["turn.status"].output,
      client.turn.status(input, options),
    ),
  "turn.result": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["turn.result"].output,
      client.turn.result(input, options),
    ),
  "turn.stream": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["turn.stream"].output,
      client.turn.stream(input, options),
    ),
  "turn.cancel": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["turn.cancel"].output,
      client.turn.cancel(input, options),
    ),
} satisfies Pick<
  SparkDaemonOrpcProcedureInvokerMap,
  | "daemon.status"
  | "daemon.stop"
  | "daemon.restart"
  | "channel.status"
  | "channel.configure"
  | "channel.reload"
  | "channel.notify"
  | "turn.submit"
  | "turn.status"
  | "turn.result"
  | "turn.stream"
  | "turn.cancel"
>;

const invocationLoopInvokers = {
  "invocation.list": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["invocation.list"].output,
      client.invocation.list(input, options),
    ),
  "invocation.retry": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["invocation.retry"].output,
      client.invocation.retry(input, options),
    ),
  "invocation.retention.preview": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["invocation.retention.preview"].output,
      client.invocation.retention.preview(input, options),
    ),
  "invocation.retention.apply": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["invocation.retention.apply"].output,
      client.invocation.retention.apply(input, options),
    ),
  "usage.summary": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["usage.summary"].output,
      client.usage.summary(input, options),
    ),
  "usage.persistence": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["usage.persistence"].output,
      client.usage.persistence(input, options),
    ),
  "usage.backfill": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["usage.backfill"].output,
      client.usage.backfill(input, options),
    ),
  "repro.formal-evidence.record": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["repro.formal-evidence.record"].output,
      client.repro.formalEvidence.record(input, options),
    ),
  "loop.start": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["loop.start"].output,
      client.loop.start(input, options),
    ),
  "loop.status": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["loop.status"].output,
      client.loop.status(input, options),
    ),
  "loop.stop": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["loop.stop"].output,
      client.loop.stop(input, options),
    ),
  "loop.restart": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["loop.restart"].output,
      client.loop.restart(input, options),
    ),
  "loop.wake": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["loop.wake"].output,
      client.loop.wake(input, options),
    ),
  "loop.schedule": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["loop.schedule"].output,
      client.loop.schedule(input, options),
    ),
  "loop.control": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["loop.control"].output,
      client.loop.control(input, options),
    ),
} satisfies Pick<
  SparkDaemonOrpcProcedureInvokerMap,
  | "invocation.list"
  | "invocation.retry"
  | "invocation.retention.preview"
  | "invocation.retention.apply"
  | "usage.summary"
  | "usage.persistence"
  | "usage.backfill"
  | "repro.formal-evidence.record"
  | "loop.start"
  | "loop.status"
  | "loop.stop"
  | "loop.restart"
  | "loop.wake"
  | "loop.schedule"
  | "loop.control"
>;

const workspaceInvokers = {
  "workspace.list": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.list"].output,
      client.workspace.list(input, options),
    ),
  "workspace.register": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.register"].output,
      client.workspace.register(input, options),
    ),
  "workspace.relocate": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.relocate"].output,
      client.workspace.relocate(input, options),
    ),
  "workspace.ensure-local": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.ensure-local"].output,
      client.workspace.ensureLocal(input, options),
    ),
  "workspace.resolve-session-cwd": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.resolve-session-cwd"].output,
      client.workspace.resolveSessionCwd(input, options),
    ),
  "workspace.attach": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.attach"].output,
      client.workspace.attach(input, options),
    ),
  "workspace.stop": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.stop"].output,
      client.workspace.stop(input, options),
    ),
  "workspace.lifecycle": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.lifecycle"].output,
      client.workspace.lifecycle(input, options),
    ),
  "workspace.client.attach": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.client.attach"].output,
      client.workspace.client.attach(input, options),
    ),
  "workspace.client.heartbeat": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.client.heartbeat"].output,
      client.workspace.client.heartbeat(input, options),
    ),
  "workspace.client.release": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.client.release"].output,
      client.workspace.client.release(input, options),
    ),
  "workspace.executor.ensure": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.executor.ensure"].output,
      client.workspace.executor.ensure(input, options),
    ),
  "workspace.transfer.pending": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.transfer.pending"].output,
      client.workspace.transfer.pending(input, options),
    ),
  "workspace.transfer.respond": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["workspace.transfer.respond"].output,
      client.workspace.transfer.respond(input, options),
    ),
} satisfies Pick<
  SparkDaemonOrpcProcedureInvokerMap,
  | "workspace.list"
  | "workspace.register"
  | "workspace.relocate"
  | "workspace.ensure-local"
  | "workspace.resolve-session-cwd"
  | "workspace.attach"
  | "workspace.stop"
  | "workspace.lifecycle"
  | "workspace.client.attach"
  | "workspace.client.heartbeat"
  | "workspace.client.release"
  | "workspace.executor.ensure"
  | "workspace.transfer.pending"
  | "workspace.transfer.respond"
>;

const uplinkInvokers = {
  "uplink.park": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["uplink.park"].output,
      client.uplink.park(input, options),
    ),
  "uplink.unpark": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["uplink.unpark"].output,
      client.uplink.unpark(input, options),
    ),
  "uplink.prefer": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["uplink.prefer"].output,
      client.uplink.prefer(input, options),
    ),
  "uplink.status": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["uplink.status"].output,
      client.uplink.status(input, options),
    ),
} satisfies Pick<
  SparkDaemonOrpcProcedureInvokerMap,
  "uplink.park" | "uplink.unpark" | "uplink.prefer" | "uplink.status"
>;

const sessionInvokers = {
  "session.list": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.list"].output,
      client.session.list(input, options),
    ),
  "session.get": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.get"].output,
      client.session.get(input, options),
    ),
  "session.snapshot": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.snapshot"].output,
      client.session.snapshot(input, options),
    ),
  "session.create": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.create"].output,
      client.session.create(input, options),
    ),
  "session.bind": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.bind"].output,
      client.session.bind(input, options),
    ),
  "session.unbind": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.unbind"].output,
      client.session.unbind(input, options),
    ),
  "session.archive": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.archive"].output,
      client.session.archive(input, options),
    ),
  "session.restore": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.restore"].output,
      client.session.restore(input, options),
    ),
  "session.close": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.close"].output,
      client.session.close(input, options),
    ),
  "session.send": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.send"].output,
      client.session.send(input, options),
    ),
  "session.inbox": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.inbox"].output,
      client.session.inbox(input, options),
    ),
  "session.mail.read": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.mail.read"].output,
      client.session.mail.read(input, options),
    ),
  "session.mail.ack": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.mail.ack"].output,
      client.session.mail.ack(input, options),
    ),
  "session.notification.deliver": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.notification.deliver"].output,
      client.session.notification.deliver(input, options),
    ),
  "session.model.set": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.model.set"].output,
      client.session.model.set(input, options),
    ),
  "session.mode.set": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.mode.set"].output,
      client.session.mode.set(input, options),
    ),
  "session.thinking.set": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["session.thinking.set"].output,
      client.session.thinking.set(input, options),
    ),
} satisfies Pick<
  SparkDaemonOrpcProcedureInvokerMap,
  | "session.list"
  | "session.get"
  | "session.snapshot"
  | "session.create"
  | "session.bind"
  | "session.unbind"
  | "session.archive"
  | "session.restore"
  | "session.close"
  | "session.send"
  | "session.inbox"
  | "session.mail.read"
  | "session.mail.ack"
  | "session.notification.deliver"
  | "session.model.set"
  | "session.mode.set"
  | "session.thinking.set"
>;

const sideThreadInvokers = {
  "side-thread.ensure": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["side-thread.ensure"].output,
      client.sideThread.ensure(input, options),
    ),
  "side-thread.snapshot": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["side-thread.snapshot"].output,
      client.sideThread.snapshot(input, options),
    ),
  "side-thread.submit": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["side-thread.submit"].output,
      client.sideThread.submit(input, options),
    ),
  "side-thread.reset": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["side-thread.reset"].output,
      client.sideThread.reset(input, options),
    ),
  "side-thread.configure": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["side-thread.configure"].output,
      client.sideThread.configure(input, options),
    ),
  "side-thread.handoff": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["side-thread.handoff"].output,
      client.sideThread.handoff(input, options),
    ),
} satisfies Pick<
  SparkDaemonOrpcProcedureInvokerMap,
  | "side-thread.ensure"
  | "side-thread.snapshot"
  | "side-thread.submit"
  | "side-thread.reset"
  | "side-thread.configure"
  | "side-thread.handoff"
>;

const modelProviderHumanInvokers = {
  "model.catalog": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["model.catalog"].output,
      client.model.catalog(input, options),
    ),
  "model.default.set": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["model.default.set"].output,
      client.model.default.set(input, options),
    ),
  "provider.auth.api-key.set": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["provider.auth.api-key.set"].output,
      client.provider.auth.apiKey.set(input, options),
    ),
  "provider.auth.import.pi": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["provider.auth.import.pi"].output,
      client.provider.auth.import.pi(input, options),
    ),
  "provider.auth.logout": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["provider.auth.logout"].output,
      client.provider.auth.logout(input, options),
    ),
  "provider.auth.login.start": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["provider.auth.login.start"].output,
      client.provider.auth.login.start(input, options),
    ),
  "provider.auth.login.status": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["provider.auth.login.status"].output,
      client.provider.auth.login.status(input, options),
    ),
  "provider.auth.login.respond": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["provider.auth.login.respond"].output,
      client.provider.auth.login.respond(input, options),
    ),
  "provider.auth.login.cancel": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["provider.auth.login.cancel"].output,
      client.provider.auth.login.cancel(input, options),
    ),
  "human.interaction.list": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["human.interaction.list"].output,
      client.human.interaction.list(input, options),
    ),
  "human.interaction.respond": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["human.interaction.respond"].output,
      client.human.interaction.respond(input, options),
    ),
} satisfies Pick<
  SparkDaemonOrpcProcedureInvokerMap,
  | "model.catalog"
  | "model.default.set"
  | "provider.auth.api-key.set"
  | "provider.auth.import.pi"
  | "provider.auth.logout"
  | "provider.auth.login.start"
  | "provider.auth.login.status"
  | "provider.auth.login.respond"
  | "provider.auth.login.cancel"
  | "human.interaction.list"
  | "human.interaction.respond"
>;

const taskClaimInvokers = {
  "task.claim.acquire": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["task.claim.acquire"].output,
      client.task.claim.acquire(input, options),
    ),
  "task.claim.release": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["task.claim.release"].output,
      client.task.claim.release(input, options),
    ),
  "task.claim.recover": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["task.claim.recover"].output,
      client.task.claim.recover(input, options),
    ),
} satisfies Pick<
  SparkDaemonOrpcProcedureInvokerMap,
  "task.claim.acquire" | "task.claim.release" | "task.claim.recover"
>;

const delegationInvokers = {
  "delegation.execute": (client, input, options) =>
    parseSparkDaemonOrpcOutput(
      sparkLocalRpcProcedureSchemas["delegation.execute"].output,
      client.delegation.execute(input, options),
    ),
} satisfies Pick<SparkDaemonOrpcProcedureInvokerMap, "delegation.execute">;

const sparkDaemonOrpcProcedureInvokers = {
  ...toolExecutionInvokers,
  ...daemonChannelTurnInvokers,
  ...invocationLoopInvokers,
  ...workspaceInvokers,
  ...uplinkInvokers,
  ...sessionInvokers,
  ...sideThreadInvokers,
  ...taskClaimInvokers,
  ...delegationInvokers,
  ...modelProviderHumanInvokers,
} satisfies SparkDaemonOrpcProcedureInvokerMap;

/** Exact method keys backed by the statically checked oRPC invoker table. */
export const sparkDaemonOrpcInvokerMethods = Object.freeze(
  Object.keys(sparkDaemonOrpcProcedureInvokers),
);

export async function invokeSparkDaemonOrpcLiveMethod<M extends SparkLocalRpcMethod>(
  client: SparkDaemonOrpcClient,
  method: M,
  params: SparkLocalRpcInput<M>,
  options: SparkDaemonOrpcInvokeOptions = {},
): Promise<SparkLocalRpcOutput<M>> {
  return await invokeSparkDaemonOrpcProcedure(client, method, params, options);
}

export async function createSparkDaemonOrpcClient(
  options: SparkDaemonOrpcClientOptions = {},
): Promise<SparkDaemonOrpcClientHandle> {
  const paths =
    options.paths ??
    resolveSparkPaths({
      app: "daemon",
      ...(options.env ? { env: options.env } : {}),
    });
  const socketPath = options.socketPath ?? sparkDaemonOrpcSocketPath(paths);
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;

  if (options.signal?.aborted) throw abortError();

  const socket: Socket = await new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let settled = false;
    const finish = (result: { socket: Socket } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if ("socket" in result) resolve(result.socket);
      else {
        conn.destroy();
        reject(result.error);
      }
    };
    const onAbort = () => finish({ error: abortError() });
    const timer = setTimeout(() => {
      finish({
        error: new Error(`Timed out connecting to Spark daemon oRPC socket: ${socketPath}`),
      });
    }, connectTimeoutMs);
    conn.once("connect", () => {
      finish({ socket: conn });
    });
    conn.once("error", (error) => {
      finish({ error });
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });

  let port: SocketMessagePortLike | undefined;
  try {
    port = createSocketMessagePort(socket, {
      ...(options.maxResponseBytes === undefined
        ? {}
        : { maxMessageBytes: options.maxResponseBytes }),
    });
    const link = new RPCLink<EmptyClientContext>({ port });
    const client = createSparkDaemonOrpcTypedClient(link);
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      port?.close();
      socket.destroy();
    };

    return {
      client,
      port,
      invoke: async <M extends SparkLocalRpcMethod>(
        method: M,
        params: SparkLocalRpcInput<M>,
        invokeOptions: SparkDaemonOrpcInvokeOptions = {},
      ): Promise<SparkLocalRpcOutput<M>> =>
        await invokeSparkDaemonOrpcProcedure(client, method, params, invokeOptions),
      close,
    };
  } catch (error) {
    port?.close();
    socket.destroy();
    throw error;
  }
}

function createSparkDaemonOrpcTypedClient(
  link: RPCLink<EmptyClientContext>,
): SparkDaemonOrpcClient {
  const client = createORPCClient<SparkLocalRpcOrpcClient>(link);
  // oRPC 1.15 reserves Function.prototype.bind on recursive client proxies.
  // Keep Spark's existing /session/bind transport path reachable through an
  // explicitly rooted procedure client instead of changing the wire contract.
  const sessionBind = createORPCClient<SparkLocalRpcOrpcClient["session"]["bind"]>(link, {
    path: ["session", "bind"],
  });
  const session = new Proxy(client.session, {
    get(target, key, receiver) {
      if (key === "bind") return sessionBind;
      return Reflect.get(target, key, receiver);
    },
  });
  return new Proxy(client, {
    get(target, key, receiver) {
      if (key === "session") return session;
      return Reflect.get(target, key, receiver);
    },
  });
}

async function invokeSparkDaemonOrpcProcedure<M extends SparkLocalRpcMethod>(
  client: SparkDaemonOrpcClient,
  method: M,
  params: SparkLocalRpcInput<M>,
  options: SparkDaemonOrpcInvokeOptions,
): Promise<SparkLocalRpcOutput<M>> {
  // Each table entry is checked against its method-specific input and output
  // above. Indexing a mapped type with a generic key loses that correlation in
  // TypeScript, so restore precisely the selected entry's generic signature.
  const invoke = sparkDaemonOrpcProcedureInvokers[
    method
  ] as unknown as SparkDaemonOrpcProcedureInvoker<M>;
  return await invoke(client, params, options);
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
