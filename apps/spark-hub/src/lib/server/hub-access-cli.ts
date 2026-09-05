import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createHubAccessToken,
  listHubAccessTokens,
  revokeHubAccessToken,
  type HubAccessTokenSummary,
} from "@zendev-lab/spark-hub-coordination/hub-access";
import { defaultDatabasePath, migrate, openDatabase } from "@zendev-lab/spark-hub-storage-sqlite";

export type HubAccessOperation = "create" | "list" | "revoke";

export interface HubAccessCliCommand {
  operation: string;
  databasePath?: string;
  label?: string;
  tokenId?: string;
  daemons?: string[];
  user?: string;
  json?: boolean;
}

export interface HubAccessCreateResult {
  plane: "hub";
  resource: "access";
  operation: "create";
  status: "created";
  tokenId: string;
  token: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  loginPath: "/login";
  text: string;
}

export interface HubAccessListResult {
  plane: "hub";
  resource: "access";
  operation: "list";
  status: "ok";
  tokens: HubAccessTokenSummary[];
  text: string;
}

export interface HubAccessRevokeResult {
  plane: "hub";
  resource: "access";
  operation: "revoke";
  status: "revoked" | "not_found";
  tokenId: string;
  text: string;
}

export type HubAccessCliResult =
  | HubAccessCreateResult
  | HubAccessListResult
  | HubAccessRevokeResult;

export async function handleHubAccessCliCommand(
  command: HubAccessCliCommand,
): Promise<HubAccessCliResult> {
  const operation = command.operation as HubAccessOperation;
  if (operation !== "create" && operation !== "list" && operation !== "revoke") {
    throw new Error(
      `unknown spark hub access operation: ${command.operation}. Use create, list, or revoke.`,
    );
  }
  if (operation === "revoke" && !command.tokenId?.trim()) {
    throw new Error("spark hub access revoke requires --id <token-id>");
  }
  if (operation === "create" && (command.daemons ?? []).length === 0) {
    throw new Error(
      "spark hub access create requires --daemon <runtime-id> (repeat or comma-separate for several daemons)",
    );
  }

  const databasePath = resolve(command.databasePath?.trim() || defaultDatabasePath());
  const db = openDatabase({ path: databasePath });
  try {
    migrate(db);
    switch (operation) {
      case "create":
        return createAccess(db, command.label, command.daemons ?? [], command.user);
      case "list":
        return listAccess(db);
      case "revoke":
        return revokeAccess(db, command.tokenId!.trim());
      default: {
        const _exhaustive: never = operation;
        void _exhaustive;
        throw new Error(`unhandled spark hub access operation: ${command.operation}`);
      }
    }
  } finally {
    db.close();
  }
}

function createAccess(
  db: DatabaseSync,
  label: string | undefined,
  daemons: string[],
  user?: string,
): HubAccessCreateResult {
  const created = createHubAccessToken(db, {
    daemonIds: daemons,
    memberName: user?.trim() || null,
    label: label?.trim() || "Hub browser access",
  });
  return {
    plane: "hub",
    resource: "access",
    operation: "create",
    status: "created",
    tokenId: created.id,
    token: created.token,
    label: label?.trim() || "Hub browser access",
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
    loginPath: "/login",
    text:
      `Hub access key created (shown once)\n` +
      `  token     ${created.token}\n` +
      `  expires   ${created.expiresAt}\n` +
      `  login     /login\n` +
      `  daemons   ${created.daemonIds.join(", ")}\n` +
      (created.memberName ? `  user      ${created.memberName}\n` : "") +
      `  id        ${created.id}\n`,
  };
}

function listAccess(db: DatabaseSync): HubAccessListResult {
  const tokens = listHubAccessTokens(db);
  const lines =
    tokens.length === 0
      ? "no Hub access tokens.\n"
      : tokens
          .map((token) => {
            const state = token.revokedAt ? "revoked" : token.usedAt ? "used" : "active";
            const grants =
              token.daemonIds.length > 0 ? `  daemons ${token.daemonIds.join(",")}` : "";
            const member = token.memberName ? `  user ${token.memberName}` : "";
            return `  ${token.id}  ${state}  expires ${token.expiresAt}${grants}${member}${token.label ? `  ${token.label}` : ""}`;
          })
          .join("\n") + "\n";
  return {
    plane: "hub",
    resource: "access",
    operation: "list",
    status: "ok",
    tokens,
    text: lines,
  };
}

function revokeAccess(db: DatabaseSync, tokenId: string): HubAccessRevokeResult {
  const revoked = revokeHubAccessToken(db, { tokenId });
  return {
    plane: "hub",
    resource: "access",
    operation: "revoke",
    status: revoked ? "revoked" : "not_found",
    tokenId,
    text: revoked
      ? `revoked Hub access token ${tokenId}\n`
      : `Hub access token ${tokenId} was not active\n`,
  };
}
