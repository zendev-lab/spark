import {
  parseSparkSessionProjection,
  parseSparkSessionProjections,
  type SparkSessionBindRequest,
  type SparkSessionCloseRequest,
  type SparkSessionCreateRequest,
  type SparkSessionListRequest,
  type SparkSessionProjection,
  type SparkSessionUnbindRequest,
  type SparkLocalRpcInput,
} from "@zendev-lab/spark-protocol";
import { requestSparkDaemon, type SparkDaemonClientOptions } from "@zendev-lab/spark-daemon-client";

export interface SparkDaemonManagedSessionsClient {
  create(input: SparkSessionCreateRequest): Promise<SparkSessionProjection>;
  list(options?: SparkSessionListRequest): Promise<SparkSessionProjection[]>;
  get(sessionId: string): Promise<SparkSessionProjection>;
  bind(sessionId: string, externalKey: string): Promise<SparkSessionProjection>;
  unbind(sessionId: string, externalKey: string): Promise<SparkSessionProjection>;
  archive(sessionId: string): Promise<SparkSessionProjection>;
  restore?(sessionId: string): Promise<SparkSessionProjection>;
  close?(sessionId: string): Promise<SparkSessionProjection>;
}

/** Client-side adapter only. Session persistence and mutation stay behind the
 * daemon acknowledgement boundary. */
export function createDaemonManagedSessionsClient(
  options: SparkDaemonClientOptions = {},
): SparkDaemonManagedSessionsClient {
  const requestRecord = async <
    M extends
      | "session.create"
      | "session.get"
      | "session.bind"
      | "session.unbind"
      | "session.archive"
      | "session.restore"
      | "session.close",
  >(
    method: M,
    params: SparkLocalRpcInput<M>,
  ) => parseSparkSessionProjection(await requestSparkDaemon(method, params, options));
  return {
    create: async (input) => await requestRecord("session.create", input),
    list: async (params = {}) =>
      parseSparkSessionProjections(await requestSparkDaemon("session.list", params, options)),
    get: async (sessionId) => await requestRecord("session.get", { sessionId }),
    bind: async (sessionId, externalKey) =>
      await requestRecord("session.bind", {
        sessionId,
        externalKey,
      } satisfies SparkSessionBindRequest),
    unbind: async (sessionId, externalKey) =>
      await requestRecord("session.unbind", {
        sessionId,
        externalKey,
      } satisfies SparkSessionUnbindRequest),
    archive: async (sessionId) => await requestRecord("session.archive", { sessionId }),
    restore: async (sessionId) => await requestRecord("session.restore", { sessionId }),
    close: async (sessionId) =>
      await requestRecord("session.close", { sessionId } satisfies SparkSessionCloseRequest),
  };
}

export function renderManagedSession(record: SparkSessionProjection): string {
  const bindings =
    record.bindings.length === 0
      ? "none"
      : record.bindings.map((binding) => binding.externalKey).join(", ");
  const tags = record.tags?.length ? ` tags=${JSON.stringify(record.tags)}` : "";
  return `${record.sessionId} ${record.lifecycle}/${record.placement}/${record.activity ?? "idle"} workspace=${record.scope.kind === "workspace" ? record.scope.workspaceId : "daemon"} owner=${record.owner.kind} bindings=${bindings}${
    record.name ? ` name=${JSON.stringify(record.name)}` : ""
  }${tags}\n`;
}
