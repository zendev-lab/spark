import { z } from "zod";

import { sparkProtocolJsonObjectSchema, type SparkProtocolJsonValue } from "./command-events.ts";
import { isoDateTimeSchema } from "./refs.ts";

export const SPARK_A2UI_VERSIONS = ["v0.9", "v0.9.1"] as const;
export const SPARK_A2UI_BASIC_CATALOG_PATTERN =
  /^https:\/\/a2ui\.org\/specification\/v0_9(?:_1)?\/catalogs\/basic\/catalog\.json$/u;
export const SPARK_A2UI_MAX_COMPONENTS = 500;

export const sparkA2uiVersionSchema = z.enum(SPARK_A2UI_VERSIONS);

/** Official v0.9 renderer-to-agent action envelope. */
export const sparkA2uiClientActionSchema = z.object({
  version: sparkA2uiVersionSchema,
  action: z.object({
    name: z.string().min(1),
    surfaceId: z.string().min(1),
    sourceComponentId: z.string().min(1),
    timestamp: isoDateTimeSchema,
    context: sparkProtocolJsonObjectSchema.default({}),
  }),
});

export const sparkWorkbenchActionIdSchema = z.enum([
  "pause",
  "resume",
  "run_now",
  "retry_checkpoint",
  "stop",
]);

/**
 * Spark's closed Workbench action vocabulary carried inside the official
 * A2UI v0.9 action envelope. This is a control request, never a generic
 * action-to-tool bridge.
 */
export const sparkWorkbenchActionRequestSchema = z
  .object({
    version: sparkA2uiVersionSchema,
    action: z.object({
      name: z.literal("spark.loop.control"),
      surfaceId: z.string().min(1),
      sourceComponentId: z.string().min(1),
      timestamp: isoDateTimeSchema,
      context: z.object({
        actionId: sparkWorkbenchActionIdSchema,
        artifactRef: z
          .string()
          .regex(/^artifact:.+/u)
          .transform((value) => value as `artifact:${string}`),
        revision: z.number().int().positive(),
        loopId: z.string().min(1),
        generation: z.number().int().positive(),
        idempotencyKey: z.string().min(1).max(256),
        confirm: z.literal(true).optional(),
      }),
    }),
  })
  .superRefine((request, context) => {
    if (request.action.context.actionId === "stop" && request.action.context.confirm !== true) {
      context.addIssue({
        code: "custom",
        path: ["action", "context", "confirm"],
        message: "stop requires explicit confirmation",
      });
    }
  });

export interface SparkA2uiComponent {
  id: string;
  component: string;
  [key: string]: unknown;
}

export interface SparkA2uiSurface {
  surfaceId: string;
  catalogId: string;
  components: Record<string, SparkA2uiComponent>;
  dataModel: unknown;
  deleted: boolean;
}

export interface SparkA2uiDocument {
  version: (typeof SPARK_A2UI_VERSIONS)[number];
  surfaces: SparkA2uiSurface[];
  latestSurfaceId?: string;
  diagnostics: string[];
}

/** Parse JSON, a `{ messages }` envelope, or JSONL and normalize surface state. */
export function normalizeSparkA2uiDocument(content: string): SparkA2uiDocument {
  const diagnostics: string[] = [];
  const messages = parseMessages(content, diagnostics);
  const surfaces = new Map<string, SparkA2uiSurface>();
  let latestSurfaceId: string | undefined;
  let version: SparkA2uiDocument["version"] = "v0.9.1";

  for (const [index, message] of messages.entries()) {
    if (!isRecord(message) || !isSparkA2uiVersion(message.version)) {
      diagnostics.push(`message ${index + 1}: expected A2UI version v0.9 or v0.9.1`);
      continue;
    }
    version = message.version;
    if (isRecord(message.createSurface)) {
      const surfaceId = stringValue(message.createSurface.surfaceId);
      const catalogId = stringValue(message.createSurface.catalogId);
      if (!surfaceId || !catalogId) {
        diagnostics.push(`message ${index + 1}: createSurface requires surfaceId and catalogId`);
        continue;
      }
      if (!SPARK_A2UI_BASIC_CATALOG_PATTERN.test(catalogId)) {
        diagnostics.push(`surface ${surfaceId}: unsupported catalog ${catalogId}`);
        continue;
      }
      surfaces.set(surfaceId, {
        surfaceId,
        catalogId,
        components: {},
        dataModel: {},
        deleted: false,
      });
      latestSurfaceId = surfaceId;
      continue;
    }
    if (isRecord(message.updateComponents)) {
      const surface = surfaceForMessage(surfaces, message.updateComponents, diagnostics, index);
      if (!surface) continue;
      const components = message.updateComponents.components;
      if (!Array.isArray(components)) {
        diagnostics.push(`message ${index + 1}: updateComponents.components must be an array`);
        continue;
      }
      let componentCount = Object.keys(surface.components).length;
      let surfaceLimitReached = false;
      for (const component of components.slice(0, SPARK_A2UI_MAX_COMPONENTS)) {
        if (!isRecord(component)) continue;
        const id = stringValue(component.id);
        const name = stringValue(component.component);
        if (!id || !name || isUnsafeObjectKey(id)) continue;
        const exists = Object.hasOwn(surface.components, id);
        if (!exists && componentCount >= SPARK_A2UI_MAX_COMPONENTS) {
          surfaceLimitReached = true;
          continue;
        }
        surface.components[id] = { ...component, id, component: name };
        if (!exists) componentCount += 1;
      }
      if (components.length > SPARK_A2UI_MAX_COMPONENTS) {
        diagnostics.push(
          `surface ${surface.surfaceId}: component count capped at ${SPARK_A2UI_MAX_COMPONENTS}`,
        );
      }
      if (surfaceLimitReached) {
        diagnostics.push(
          `surface ${surface.surfaceId}: total component count capped at ${SPARK_A2UI_MAX_COMPONENTS}`,
        );
      }
      latestSurfaceId = surface.surfaceId;
      continue;
    }
    if (isRecord(message.updateDataModel)) {
      const surface = surfaceForMessage(surfaces, message.updateDataModel, diagnostics, index);
      if (!surface) continue;
      surface.dataModel = updateSparkA2uiDataModel(
        surface.dataModel,
        stringValue(message.updateDataModel.path) ?? "/",
        message.updateDataModel.value,
      );
      latestSurfaceId = surface.surfaceId;
      continue;
    }
    if (isRecord(message.deleteSurface)) {
      const surfaceId = stringValue(message.deleteSurface.surfaceId);
      const surface = surfaceId ? surfaces.get(surfaceId) : undefined;
      if (surface) surface.deleted = true;
      continue;
    }
    diagnostics.push(`message ${index + 1}: unsupported A2UI envelope`);
  }

  return {
    version,
    surfaces: [...surfaces.values()].map(cloneSurface),
    ...(latestSurfaceId ? { latestSurfaceId } : {}),
    diagnostics,
  };
}

export function resolveSparkA2uiDataPath(root: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return root;
  let current = root;
  for (const token of pointer.split("/").slice(1).map(decodeJsonPointerToken)) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index < 0) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || isUnsafeObjectKey(token)) return undefined;
    current = current[token];
  }
  return current;
}

export function updateSparkA2uiDataModel(root: unknown, pointer: string, value: unknown): unknown {
  if (pointer === "" || pointer === "/") return value;
  const tokens = pointer.split("/").slice(1).map(decodeJsonPointerToken);
  if (tokens.length === 0 || tokens.some(isUnsafeObjectKey)) return root;
  const clone = structuredClone(isRecord(root) || Array.isArray(root) ? root : {});
  let current: Record<string, unknown> | unknown[] = clone as Record<string, unknown> | unknown[];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index] ?? "";
    const nextToken = tokens[index + 1] ?? "";
    const descended = descendContainer(current, token, nextToken);
    if (!descended) return root;
    current = descended;
  }
  return assignValue(current, tokens.at(-1) ?? "", value) ? clone : root;
}

function parseMessages(content: string, diagnostics: string[]): unknown[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (isRecord(parsed) && Array.isArray(parsed.messages)) return parsed.messages;
    return [parsed];
  } catch {
    const messages: unknown[] = [];
    for (const [index, line] of trimmed.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as unknown);
      } catch {
        diagnostics.push(`line ${index + 1}: invalid JSONL message`);
      }
    }
    return messages;
  }
}

function surfaceForMessage(
  surfaces: Map<string, SparkA2uiSurface>,
  payload: Record<string, unknown>,
  diagnostics: string[],
  index: number,
): SparkA2uiSurface | undefined {
  const surfaceId = stringValue(payload.surfaceId);
  const surface = surfaceId ? surfaces.get(surfaceId) : undefined;
  if (!surface || surface.deleted) {
    diagnostics.push(`message ${index + 1}: unknown surface ${surfaceId ?? "(missing)"}`);
    return undefined;
  }
  return surface;
}

function cloneSurface(surface: SparkA2uiSurface): SparkA2uiSurface {
  return {
    ...surface,
    components: structuredClone(surface.components),
    dataModel: structuredClone(surface.dataModel) as SparkProtocolJsonValue,
  };
}

function descendContainer(
  current: Record<string, unknown> | unknown[],
  token: string,
  nextToken: string,
): Record<string, unknown> | unknown[] | undefined {
  if (Array.isArray(current)) {
    const index = Number(token);
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    current[index] = jsonPointerContainer(current[index], nextToken);
    return current[index] as Record<string, unknown> | unknown[];
  }
  current[token] = jsonPointerContainer(current[token], nextToken);
  return current[token] as Record<string, unknown> | unknown[];
}

function assignValue(
  current: Record<string, unknown> | unknown[],
  token: string,
  value: unknown,
): boolean {
  if (Array.isArray(current)) {
    const index = Number(token);
    if (!Number.isSafeInteger(index) || index < 0) return false;
    current[index] = value;
    return true;
  }
  if (value === undefined) Reflect.deleteProperty(current, token);
  else current[token] = value;
  return true;
}

function jsonPointerContainer(
  value: unknown,
  nextToken: string,
): Record<string, unknown> | unknown[] {
  if (isRecord(value) || Array.isArray(value)) return value;
  return /^\d+$/u.test(nextToken) ? [] : {};
}

function decodeJsonPointerToken(value: string): string {
  return value.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function isSparkA2uiVersion(value: unknown): value is SparkA2uiDocument["version"] {
  return value === "v0.9" || value === "v0.9.1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isUnsafeObjectKey(value: string): boolean {
  return value === "__proto__" || value === "prototype" || value === "constructor";
}

export type SparkA2uiClientAction = z.infer<typeof sparkA2uiClientActionSchema>;
export type SparkWorkbenchActionId = z.infer<typeof sparkWorkbenchActionIdSchema>;
export type SparkWorkbenchActionRequest = z.infer<typeof sparkWorkbenchActionRequestSchema>;
