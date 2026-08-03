import {
  parseSparkSessionRegistryRecord,
  parseSparkSessionRegistryRecords,
  type SparkSessionBindRequest,
  type SparkSessionCreateRequest,
  type SparkSessionListRequest,
  type SparkSessionRegistryRecord,
  type SparkSessionUnbindRequest,
  type SparkLocalRpcInput,
} from "@zendev-lab/spark-protocol";
import { requestSparkDaemon, type SparkDaemonClientOptions } from "@zendev-lab/spark-daemon-client";

export interface SparkDaemonManagedSessionsClient {
  create(input: SparkSessionCreateRequest): Promise<SparkSessionRegistryRecord>;
  list(options?: SparkSessionListRequest): Promise<SparkSessionRegistryRecord[]>;
  get(sessionId: string): Promise<SparkSessionRegistryRecord>;
  bind(sessionId: string, externalKey: string): Promise<SparkSessionRegistryRecord>;
  unbind(sessionId: string, externalKey: string): Promise<SparkSessionRegistryRecord>;
  archive(sessionId: string): Promise<SparkSessionRegistryRecord>;
  restore?(sessionId: string): Promise<SparkSessionRegistryRecord>;
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
      | "session.restore",
  >(
    method: M,
    params: SparkLocalRpcInput<M>,
  ) => parseSparkSessionRegistryRecord(await requestSparkDaemon(method, params, options));
  return {
    create: async (input) => await requestRecord("session.create", input),
    list: async (params = {}) =>
      parseSparkSessionRegistryRecords(await requestSparkDaemon("session.list", params, options)),
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
  };
}

export function renderManagedSession(record: SparkSessionRegistryRecord): string {
  const bindings =
    record.bindings.length === 0
      ? "none"
      : record.bindings.map((binding) => binding.externalKey).join(", ");
  const tags = record.tags?.length ? ` tags=${JSON.stringify(record.tags)}` : "";
  return `${record.sessionId} ${record.status} workspace=${record.workspaceId} bindings=${bindings}${
    record.title ? ` title=${JSON.stringify(record.title)}` : ""
  }${tags}\n`;
}
