import type {
  LensCapability,
  LensProvider,
  LensProviderSession,
  LensProviderSpec,
  LensWorkspaceContext,
  ProviderHealth,
  ProviderId,
  ProviderLaunchSpec,
  ProviderRequest,
  ProviderTrustGrant,
  ProviderVersion,
} from "@zendev-lab/spark-lens";

import {
  type ProviderProcessIdentity,
  type ProviderProcessLease,
  DaemonLensProcessBroker,
} from "./provider-process-broker.ts";
import { DaemonLensDocumentMirrors } from "./document-mirror.ts";

const MAX_LSP_MESSAGE_BYTES = 8 * 1024 * 1024;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface LspDocumentInput {
  uri: string;
  languageId: string;
  version: number;
  content: string;
}

interface LspProviderRequestInput {
  method?: string;
  params?: Record<string, unknown>;
  document?: LspDocumentInput;
  operation?: string;
}

interface BrokeredLspProviderOptions {
  spec: LensProviderSpec;
  providerVersion: ProviderVersion;
  launch(workspace: LensWorkspaceContext): Promise<ProviderLaunchSpec>;
  trustGrant?(
    workspace: LensWorkspaceContext,
    launch: ProviderLaunchSpec,
  ): Promise<ProviderTrustGrant | undefined>;
  broker: DaemonLensProcessBroker;
  mirrors: DaemonLensDocumentMirrors;
  initializationOptions?: unknown;
}

export function createBrokeredLspProvider(options: BrokeredLspProviderOptions): LensProvider {
  return {
    spec: options.spec,
    async open(workspace, signal) {
      const launch = await options.launch(workspace);
      const identity: ProviderProcessIdentity = {
        providerId: options.spec.id,
        worktreeRoot: workspace.worktreeRoot,
        projectRoot: workspace.projectRoot,
        configDigest: workspace.configDigest,
      };
      const lease = await options.broker.acquire({
        identity,
        launch,
        ...(options.trustGrant ? { trustGrant: await options.trustGrant(workspace, launch) } : {}),
      });
      try {
        return await BrokeredLspSession.open({
          providerId: options.spec.id,
          providerVersion: options.providerVersion,
          workspace,
          lease,
          mirrors: options.mirrors,
          initializationOptions: options.initializationOptions,
          signal,
        });
      } catch (error) {
        lease.release();
        throw error;
      }
    },
  };
}

interface BrokeredLspSessionOptions {
  providerId: ProviderId;
  providerVersion: ProviderVersion;
  workspace: LensWorkspaceContext;
  lease: ProviderProcessLease;
  mirrors: DaemonLensDocumentMirrors;
  initializationOptions?: unknown;
  signal: AbortSignal;
}

class BrokeredLspSession implements LensProviderSession {
  readonly providerId;
  readonly providerVersion;
  readonly workspaceRoot;
  readonly #workspace: LensWorkspaceContext;
  readonly #lease: ProviderProcessLease;
  readonly #mirrors: DaemonLensDocumentMirrors;
  readonly #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: unknown): void }
  >();
  readonly #openedDocuments = new Set<string>();
  #nextRequestId = 1;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #healthy = true;

  private constructor(options: BrokeredLspSessionOptions) {
    this.providerId = options.providerId;
    this.providerVersion = options.providerVersion;
    this.workspaceRoot = options.workspace.workspaceRoot;
    this.#workspace = options.workspace;
    this.#lease = options.lease;
    this.#mirrors = options.mirrors;
    options.lease.process.stdout.on("data", (chunk: Buffer) => this.#consume(chunk));
    void options.lease.process.exited.then(({ code, signal }) => {
      this.#healthy = false;
      this.#rejectPending(
        new Error(`LSP provider exited (code=${String(code)}, signal=${String(signal)})`),
      );
    });
  }

  static async open(options: BrokeredLspSessionOptions): Promise<BrokeredLspSession> {
    const session = new BrokeredLspSession(options);
    await session.#sendRequest(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileUri(options.workspace.projectRoot),
        capabilities: {
          textDocument: {
            diagnostic: { dynamicRegistration: false },
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
          },
          workspace: { workspaceFolders: true },
        },
        workspaceFolders: [
          {
            uri: pathToFileUri(options.workspace.projectRoot),
            name: options.workspace.projectRoot.split("/").at(-1) ?? "workspace",
          },
        ],
        ...(options.initializationOptions === undefined
          ? {}
          : { initializationOptions: options.initializationOptions }),
      },
      options.signal,
    );
    session.#sendNotification("initialized", {});
    return session;
  }

  async request(request: ProviderRequest, signal: AbortSignal): Promise<unknown> {
    const input = asLspInput(request.input);
    if (input.document) this.#syncDocument(input.document);
    const method = input.method ?? methodForCapability(request.capability, input.operation);
    return await this.#sendRequest(method, input.params ?? defaultParams(input), signal);
  }

  async health(): Promise<ProviderHealth> {
    return {
      status: this.#healthy && !this.#closed ? "healthy" : "unavailable",
      checkedAt: new Date().toISOString(),
      ...(!this.#healthy || this.#closed ? { message: "LSP process is not active" } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    try {
      await this.#sendRequest("shutdown", null, controller.signal);
      this.#sendNotification("exit", null);
    } catch {
      // The broker owns process-group termination if graceful LSP shutdown fails.
    } finally {
      clearTimeout(timeout);
      this.#lease.release();
      this.#rejectPending(new Error("LSP session closed"));
    }
  }

  #syncDocument(document: LspDocumentInput): void {
    const previous = this.#mirrors.get(this.#workspace.worktreeRoot, document.uri);
    const snapshot = this.#mirrors.sync({
      worktreeRoot: this.#workspace.worktreeRoot,
      ...document,
    });
    if (!previous) {
      this.#sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: snapshot.uri,
          languageId: snapshot.languageId,
          version: snapshot.version,
          text: snapshot.content,
        },
      });
      this.#openedDocuments.add(snapshot.uri);
      return;
    }
    this.#sendNotification("textDocument/didChange", {
      textDocument: { uri: snapshot.uri, version: snapshot.version },
      contentChanges: [{ text: snapshot.content }],
    });
  }

  async #sendRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.#closed && method !== "shutdown") throw new Error("LSP session is closed");
    if (signal.aborted) throw signal.reason;
    const id = this.#nextRequestId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    const abort = () => {
      this.#sendNotification("$/cancelRequest", { id });
      this.#pending.get(id)?.reject(signal.reason ?? new Error("LSP request cancelled"));
      this.#pending.delete(id);
    };
    signal.addEventListener("abort", abort, { once: true });
    this.#write({ jsonrpc: "2.0", id, method, params });
    try {
      return await response;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  #sendNotification(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #write(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.length > MAX_LSP_MESSAGE_BYTES) throw new Error("LSP message exceeds size limit");
    this.#lease.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.#lease.process.stdin.write(body);
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/iu.exec(header);
      if (!match) {
        this.#healthy = false;
        this.#rejectPending(new Error("invalid LSP framing"));
        return;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LSP_MESSAGE_BYTES) {
        this.#healthy = false;
        this.#rejectPending(new Error("invalid LSP content length"));
        return;
      }
      const messageEnd = headerEnd + 4 + length;
      if (this.#buffer.length < messageEnd) return;
      const body = this.#buffer.subarray(headerEnd + 4, messageEnd);
      this.#buffer = this.#buffer.subarray(messageEnd);
      this.#handleMessage(body);
    }
  }

  #handleMessage(body: Buffer): void {
    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      this.#healthy = false;
      this.#rejectPending(new Error("invalid LSP JSON"));
      return;
    }
    if (!isJsonRpcResponse(message)) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`LSP ${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function asLspInput(input: unknown): LspProviderRequestInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as LspProviderRequestInput;
}

function methodForCapability(capability: LensCapability, operation: string | undefined): string {
  switch (capability) {
    case "diagnostics":
      return "textDocument/diagnostic";
    case "navigate":
      if (operation === "references") return "textDocument/references";
      if (operation === "implementation") return "textDocument/implementation";
      return "textDocument/definition";
    case "format":
      return "textDocument/formatting";
    case "rename":
      return "textDocument/rename";
    case "completion":
      return "textDocument/completion";
    case "code_action":
      return "textDocument/codeAction";
    case "outline":
      return "textDocument/documentSymbol";
    case "search":
      return "workspace/symbol";
    default:
      throw new Error(`Lens capability is not routed through LSP: ${capability}`);
  }
}

function defaultParams(input: LspProviderRequestInput): Record<string, unknown> {
  return input.document ? { textDocument: { uri: input.document.uri } } : {};
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<JsonRpcResponse>;
  return candidate.jsonrpc === "2.0" && typeof candidate.id === "number";
}

function pathToFileUri(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `file://${encodeURI(normalized)}`;
}
