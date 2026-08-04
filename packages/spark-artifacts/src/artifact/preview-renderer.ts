import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

import {
  parseSparkUiSource,
  type SparkUiBlock,
  type SparkUiDocumentV1,
  type SparkUiJsonValue,
} from "../generative-ui.ts";
import { parseSafeMdxLite, type SafeMdxLiteBlock } from "./safe-mdx-lite.ts";
import type { PreviewContentFormat } from "./types.ts";

export interface ArtifactPreviewDocumentInput {
  title: string;
  format: PreviewContentFormat;
  content: string;
}

export interface ArtifactPreviewRenderResult {
  html: string;
  diagnostics: string[];
}

type JsonRecord = Record<string, unknown>;

const maximumA2uiComponents = 500;
const maximumA2uiDepth = 32;
const supportedA2uiVersions = new Set(["v0.9", "v0.9.1"]);
const supportedA2uiCatalogPattern =
  /a2ui\.org\/specification\/v0_9(?:_1)?\/catalogs\/basic\/catalog\.json$/u;

export function renderArtifactPreviewDocument(
  input: ArtifactPreviewDocumentInput,
): ArtifactPreviewRenderResult {
  const rendered = renderPreviewBody(input.format, input.content);
  const title = escapeHtml(input.title);
  const format = escapeHtml(input.format);
  const diagnostics = rendered.diagnostics;
  let diagnosticsHtml = "";
  if (diagnostics.length > 0) {
    const suffix = diagnostics.length === 1 ? "" : "s";
    diagnosticsHtml = `<details class="diagnostics"><summary>${diagnostics.length} preview diagnostic${suffix}</summary><ul>${diagnostics.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`;
  }
  const readOnlyNotice = previewReadOnlyNotice(input.format);

  return {
    diagnostics,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" />
<title>${title} · Spark Preview</title>
<style>${previewStyles}</style>
</head>
<body>
<header class="preview-header"><div><span class="brand">Spark Preview</span><h1>${title}</h1></div><div class="format-stack"><span class="format">${format}</span>${readOnlyNotice}</div></header>
<main class="preview-shell"><article class="preview-card ${format}">${rendered.html}</article>${diagnosticsHtml}</main>
</body>
</html>`,
  };
}

function previewReadOnlyNotice(format: PreviewContentFormat) {
  if (format === "a2ui") {
    return '<span class="readonly">A2UI v0.9.x · read-only catalog</span>';
  }
  if (format === "mdx") {
    return '<span class="readonly">Safe MDX-lite · no executable expressions</span>';
  }
  if (format === "spark-ui") {
    return '<span class="readonly">Legacy Spark UI · read-only compatibility</span>';
  }
  if (format === "html") {
    return '<span class="readonly">Sanitized HTML · scripts and network loads disabled</span>';
  }
  return "";
}

function renderPreviewBody(format: PreviewContentFormat, content: string) {
  if (format === "md") return { html: renderMarkdown(content), diagnostics: [] as string[] };
  if (format === "html") {
    return {
      html: `<section class="html-preview">${sanitizePreviewHtml(content)}</section>`,
      diagnostics: [],
    };
  }
  if (format === "a2ui") return renderA2ui(content);
  if (format === "mdx") return renderSafeMdxLite(content);
  return renderLegacySparkUi(content);
}

/** Canonical safe MDX document renderer. It never accepts the legacy JSON AST. */
function renderSafeMdxLite(content: string) {
  const document = parseSafeMdxLite(content);
  return {
    html: `<div class="mdx-lite">${document.blocks.map(renderSafeMdxLiteBlock).join("")}</div>`,
    diagnostics: document.diagnostics.map(
      (diagnostic) =>
        `${diagnostic.severity}${diagnostic.line ? ` at line ${diagnostic.line}` : ""}: ${diagnostic.message}`,
    ),
  };
}

/** Read adapter only for retired application/vnd.spark-ui+json and v1 source snapshots. */
function renderLegacySparkUi(content: string) {
  return renderLegacySparkUiDocument(
    sparkUiDocumentFromJson(content) ?? parseSparkUiSource(content),
    "spark-ui legacy",
  );
}

function renderSafeMdxLiteBlock(block: SafeMdxLiteBlock): string {
  if (block.type === "markdown") {
    return `<section class="markdown-block">${renderMarkdown(block.text)}</section>`;
  }
  return `<aside class="callout ${escapeHtml(block.tone)}">${block.title ? `<strong>${escapeHtml(block.title)}</strong>` : ""}${renderMarkdown(block.body)}</aside>`;
}

function renderLegacySparkUiDocument(document: SparkUiDocumentV1, className: string) {
  return {
    html: `<div class="${className}">${document.blocks.map(renderSparkUiBlock).join("")}</div>`,
    diagnostics: document.diagnostics.map(
      (diagnostic) =>
        `${diagnostic.severity}${diagnostic.line ? ` at line ${diagnostic.line}` : ""}: ${diagnostic.message}`,
    ),
  };
}

function sparkUiDocumentFromJson(content: string): SparkUiDocumentV1 | null {
  try {
    const value = JSON.parse(content) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1 || value.sourceFormat !== "mdx-lite")
      return null;
    if (!Array.isArray(value.blocks) || !Array.isArray(value.diagnostics)) return null;
    const blocks = value.blocks.flatMap((block) => {
      const normalized = sparkUiBlockFromJson(block);
      return normalized ? [normalized] : [];
    });
    const droppedBlockCount = value.blocks.length - blocks.length;
    const diagnostics: SparkUiDocumentV1["diagnostics"] = [];
    if (droppedBlockCount > 0) {
      const subject = droppedBlockCount === 1 ? "block was" : "blocks were";
      diagnostics.push({
        code: "invalid_component",
        severity: "error",
        message: `${droppedBlockCount} invalid Spark UI ${subject} omitted.`,
      });
    }
    return { schemaVersion: 1, sourceFormat: "mdx-lite", blocks, diagnostics };
  } catch {
    return null;
  }
}

function sparkUiBlockFromJson(value: unknown): SparkUiBlock | null {
  if (!isRecord(value)) return null;
  const type = stringValue(value.type);
  switch (type) {
    case "markdown":
      return sparkUiMarkdownFromJson(value);
    case "component":
      return sparkUiComponentFromJson(value);
    case "artifact":
      return sparkUiArtifactFromJson(value);
    case "task":
      return sparkUiTaskFromJson(value);
    case "run":
      return sparkUiRunFromJson(value);
    case "callout":
      return sparkUiCalloutFromJson(value);
    default:
      return null;
  }
}

function sparkUiMarkdownFromJson(value: JsonRecord): SparkUiBlock | null {
  const text = stringValue(value.text);
  return text === undefined ? null : { type: "markdown", text };
}

function sparkUiComponentFromJson(value: JsonRecord): SparkUiBlock | null {
  const name = stringValue(value.name);
  const props = asSparkUiJsonValue(value.props);
  if (!name || !props || typeof props !== "object" || Array.isArray(props)) return null;
  return { type: "component", name, props };
}

function sparkUiArtifactFromJson(value: JsonRecord): SparkUiBlock | null {
  const artifactRef = stringValue(value.artifactRef);
  return artifactRef ? { type: "artifact", artifactRef, title: stringValue(value.title) } : null;
}

function sparkUiTaskFromJson(value: JsonRecord): SparkUiBlock | null {
  const taskRef = stringValue(value.taskRef);
  return taskRef ? { type: "task", taskRef, title: stringValue(value.title) } : null;
}

function sparkUiRunFromJson(value: JsonRecord): SparkUiBlock | null {
  const runRef = stringValue(value.runRef);
  return runRef ? { type: "run", runRef, title: stringValue(value.title) } : null;
}

function sparkUiCalloutFromJson(value: JsonRecord): SparkUiBlock | null {
  const tone = stringValue(value.tone);
  if (tone !== "info" && tone !== "success" && tone !== "warning" && tone !== "error") {
    return null;
  }
  const body = stringValue(value.body);
  if (body === undefined) return null;
  return { type: "callout", tone, body, title: stringValue(value.title) };
}

function renderSparkUiBlock(block: SparkUiBlock): string {
  if (block.type === "markdown")
    return `<section class="markdown-block">${renderMarkdown(block.text)}</section>`;
  if (block.type === "callout") {
    return `<aside class="callout ${escapeHtml(block.tone)}">${block.title ? `<strong>${escapeHtml(block.title)}</strong>` : ""}${renderMarkdown(block.body)}</aside>`;
  }
  if (block.type === "artifact") {
    return renderReferenceCard("Artifact", block.title ?? block.artifactRef, block.artifactRef);
  }
  if (block.type === "task")
    return renderReferenceCard("Task", block.title ?? block.taskRef, block.taskRef);
  if (block.type === "run")
    return renderReferenceCard("Run", block.title ?? block.runRef, block.runRef);
  return renderReferenceCard("Component", block.name, JSON.stringify(block.props));
}

function renderReferenceCard(kind: string, title: string, detail: string) {
  return `<section class="reference-card"><span>${escapeHtml(kind)}</span><strong>${escapeHtml(title)}</strong><code>${escapeHtml(detail)}</code></section>`;
}

interface A2uiSurface {
  id: string;
  catalogId: string;
  components: Map<string, JsonRecord>;
  data: unknown;
  deleted: boolean;
}

interface A2uiState {
  surfaces: Map<string, A2uiSurface>;
  diagnostics: string[];
  latestSurfaceId?: string;
}

function renderA2ui(content: string): { html: string; diagnostics: string[] } {
  const state: A2uiState = { surfaces: new Map(), diagnostics: [] };
  const messages = parseA2uiMessages(content, state.diagnostics);
  for (const [index, message] of messages.entries()) applyA2uiMessage(state, message, index);

  const surface = state.latestSurfaceId ? state.surfaces.get(state.latestSurfaceId) : undefined;
  const { diagnostics } = state;
  if (!surface || surface.deleted) {
    return { html: '<div class="empty-state">No renderable A2UI surface.</div>', diagnostics };
  }
  if (!surface.components.has("root"))
    diagnostics.push(`surface ${surface.id}: missing root component`);
  const html = renderA2uiComponent(
    { surface, scope: "/", ancestors: new Set(), diagnostics, depth: 0 },
    "root",
  );
  return {
    html: `<section class="a2ui-surface" data-surface-id="${escapeHtml(surface.id)}">${html || '<div class="empty-state">Waiting for root component.</div>'}</section>`,
    diagnostics,
  };
}

function applyA2uiMessage(state: A2uiState, message: unknown, index: number): void {
  if (!isRecord(message) || !supportedA2uiVersions.has(stringValue(message.version) ?? "")) {
    state.diagnostics.push(`message ${index + 1}: expected A2UI version v0.9 or v0.9.1`);
    return;
  }
  if (isRecord(message.createSurface)) {
    applyA2uiCreateSurface(state, message.createSurface, index);
    return;
  }
  if (isRecord(message.updateComponents)) {
    applyA2uiComponentUpdate(state, message.updateComponents, index);
    return;
  }
  if (isRecord(message.updateDataModel)) {
    applyA2uiDataUpdate(state, message.updateDataModel, index);
    return;
  }
  if (isRecord(message.deleteSurface)) {
    applyA2uiDeleteSurface(state, message.deleteSurface);
    return;
  }
  state.diagnostics.push(`message ${index + 1}: unsupported A2UI envelope`);
}

function applyA2uiCreateSurface(state: A2uiState, payload: JsonRecord, index: number): void {
  const surfaceId = stringValue(payload.surfaceId);
  const catalogId = stringValue(payload.catalogId);
  if (!surfaceId || !catalogId) {
    state.diagnostics.push(`message ${index + 1}: createSurface requires surfaceId and catalogId`);
    return;
  }
  if (!supportedA2uiCatalogPattern.test(catalogId)) {
    state.diagnostics.push(`surface ${surfaceId}: unsupported catalog ${catalogId}`);
    return;
  }
  state.surfaces.set(surfaceId, {
    id: surfaceId,
    catalogId,
    components: new Map(),
    data: {},
    deleted: false,
  });
  state.latestSurfaceId = surfaceId;
}

function applyA2uiComponentUpdate(state: A2uiState, payload: JsonRecord, index: number): void {
  const surface = surfaceForMessage(state.surfaces, payload, state.diagnostics, index);
  if (!surface) return;
  const components = payload.components;
  if (!Array.isArray(components)) {
    state.diagnostics.push(`message ${index + 1}: updateComponents.components must be an array`);
    return;
  }
  for (const component of components.slice(0, maximumA2uiComponents)) {
    if (!isRecord(component)) continue;
    const id = stringValue(component.id);
    const name = stringValue(component.component);
    if (id && name) surface.components.set(id, component);
  }
  if (components.length > maximumA2uiComponents) {
    state.diagnostics.push(
      `surface ${surface.id}: component count capped at ${maximumA2uiComponents}`,
    );
  }
  state.latestSurfaceId = surface.id;
}

function applyA2uiDataUpdate(state: A2uiState, payload: JsonRecord, index: number): void {
  const surface = surfaceForMessage(state.surfaces, payload, state.diagnostics, index);
  if (!surface) return;
  surface.data = applyJsonPointerUpdate(
    surface.data,
    stringValue(payload.path) ?? "/",
    payload.value,
  );
  state.latestSurfaceId = surface.id;
}

function applyA2uiDeleteSurface(state: A2uiState, payload: JsonRecord): void {
  const surfaceId = stringValue(payload.surfaceId);
  const surface = surfaceId ? state.surfaces.get(surfaceId) : undefined;
  if (surface) surface.deleted = true;
}

function parseA2uiMessages(content: string, diagnostics: string[]): unknown[] {
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
  surfaces: Map<string, A2uiSurface>,
  payload: JsonRecord,
  diagnostics: string[],
  index: number,
) {
  const surfaceId = stringValue(payload.surfaceId);
  const surface = surfaceId ? surfaces.get(surfaceId) : undefined;
  if (!surface || surface.deleted) {
    diagnostics.push(`message ${index + 1}: unknown surface ${surfaceId ?? "(missing)"}`);
    return undefined;
  }
  return surface;
}

interface A2uiComponentContext {
  surface: A2uiSurface;
  scope: string;
  ancestors: Set<string>;
  diagnostics: string[];
  depth: number;
}

interface A2uiComponentView {
  context: A2uiComponentContext;
  component: JsonRecord;
  name: string;
  children(value?: unknown): string;
  child(): string;
  dynamic(key: string): unknown;
  label(): string;
}

function renderA2uiComponent(context: A2uiComponentContext, componentId: string): string {
  const { surface, ancestors, diagnostics, depth } = context;
  if (depth > maximumA2uiDepth) {
    diagnostics.push(`surface ${surface.id}: component depth capped at ${maximumA2uiDepth}`);
    return "";
  }
  if (ancestors.has(componentId)) {
    diagnostics.push(`surface ${surface.id}: component cycle at ${componentId}`);
    return "";
  }
  const component = surface.components.get(componentId);
  if (!component) return `<div class="missing-component">Missing ${escapeHtml(componentId)}</div>`;

  const descendantContext = {
    ...context,
    ancestors: new Set(ancestors).add(componentId),
    depth: depth + 1,
  };
  const dynamic = (key: string) => resolveDynamicValue(component[key], surface.data, context.scope);
  const view: A2uiComponentView = {
    context: descendantContext,
    component,
    name: stringValue(component.component) ?? "Unknown",
    children: (value: unknown = component.children) => renderA2uiChildren(descendantContext, value),
    child: () => renderA2uiChild(descendantContext, component.child),
    dynamic,
    label: () => escapeHtml(stringifyDynamic(dynamic("label"))),
  };

  for (const renderer of [renderA2uiLayout, renderA2uiControl, renderA2uiMedia]) {
    const html = renderer(view);
    if (html !== undefined) return html;
  }
  diagnostics.push(`surface ${surface.id}: unsupported component ${view.name}`);
  return `<div class="missing-component">Unsupported ${escapeHtml(view.name)}</div>`;
}

function renderA2uiLayout(view: A2uiComponentView): string | undefined {
  const { name, component } = view;
  if (name === "Row" || name === "Column" || name === "List") {
    return `<div class="a2ui-layout ${name.toLowerCase()}">${view.children()}</div>`;
  }
  if (name === "Card")
    return `<section class="a2ui-card">${view.child() || view.children()}</section>`;
  if (name === "Text") {
    const text = stringifyDynamic(view.dynamic("text"));
    const variant = stringValue(component.variant) ?? "body";
    return `<div class="a2ui-text ${escapeHtml(variant)}">${renderMarkdown(text)}</div>`;
  }
  if (name === "Divider") return '<hr class="a2ui-divider" />';
  if (name === "Tabs") return renderA2uiTabs(view);
  if (name === "Modal") {
    return `<section class="a2ui-card modal">${view.child() || view.children()}</section>`;
  }
  return undefined;
}

function renderA2uiTabs(view: A2uiComponentView): string {
  const tabs = Array.isArray(view.component.tabs) ? view.component.tabs : [];
  return `<div class="a2ui-tabs">${tabs
    .flatMap((tab) => {
      if (!isRecord(tab)) return [];
      const title = resolveDynamicValue(tab.title, view.context.surface.data, view.context.scope);
      const tabChild = stringValue(tab.child);
      const body = tabChild ? renderA2uiComponent(view.context, tabChild) : "";
      return [`<section><h3>${escapeHtml(stringifyDynamic(title))}</h3>${body}</section>`];
    })
    .join("")}</div>`;
}

function renderA2uiControl(view: A2uiComponentView): string | undefined {
  const { name, component, context } = view;
  if (name === "Button") {
    return `<button class="a2ui-button" disabled>${view.child() || view.label() || "Button"}</button>`;
  }
  if (name === "TextField" || name === "DateTimeInput") return renderA2uiTextInput(view);
  if (name === "CheckBox") {
    const checked = view.dynamic("value") === true ? "checked" : "";
    return `<label class="a2ui-check"><input type="checkbox" ${checked} disabled /><span>${view.label()}</span></label>`;
  }
  if (name === "ChoicePicker") {
    const options = Array.isArray(component.options) ? component.options : [];
    const rendered = options
      .flatMap((option) => {
        if (!isRecord(option)) return [];
        const label = resolveDynamicValue(option.label, context.surface.data, context.scope);
        return [`<option>${escapeHtml(stringifyDynamic(label))}</option>`];
      })
      .join("");
    return `<label class="a2ui-field"><span>${view.label()}</span><select disabled>${rendered}</select></label>`;
  }
  if (name === "Slider") {
    return `<label class="a2ui-field"><span>${view.label()}</span><input type="range" value="${escapeAttribute(stringifyDynamic(view.dynamic("value")))}" disabled /></label>`;
  }
  return undefined;
}

function renderA2uiTextInput(view: A2uiComponentView): string {
  const value = escapeAttribute(stringifyDynamic(view.dynamic("value")));
  return `<label class="a2ui-field"><span>${view.label()}</span><input type="text" value="${value}" disabled /></label>`;
}

function renderA2uiMedia(view: A2uiComponentView): string | undefined {
  if (view.name === "Icon") {
    const label = escapeAttribute(stringifyDynamic(view.dynamic("name")));
    return `<span class="a2ui-icon" aria-label="${label}">◇</span>`;
  }
  if (view.name === "Image") {
    const source = safeEmbeddedMediaUrl(
      stringifyDynamic(view.dynamic("url") || view.dynamic("src")),
    );
    if (!source) return '<div class="media-placeholder">Remote image omitted</div>';
    const alt = escapeAttribute(stringifyDynamic(view.dynamic("alt")));
    return `<img class="a2ui-image" src="${escapeAttribute(source)}" alt="${alt}" />`;
  }
  if (view.name === "Video" || view.name === "AudioPlayer") {
    return `<div class="media-placeholder">${escapeHtml(view.name)} omitted in read-only preview</div>`;
  }
  return undefined;
}

function renderA2uiChild(context: A2uiComponentContext, value: unknown): string {
  const id = stringValue(value);
  return id ? renderA2uiComponent(context, id) : "";
}

function renderA2uiChildren(context: A2uiComponentContext, value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => {
        const id = stringValue(entry);
        return id ? [renderA2uiComponent(context, id)] : [];
      })
      .join("");
  }
  if (!isRecord(value)) return "";
  const path = stringValue(value.path);
  const templateId = stringValue(value.componentId);
  const items = path
    ? resolveJsonPointer(context.surface.data, resolveScopedPath(path, context.scope))
    : undefined;
  if (!templateId || !Array.isArray(items)) return "";
  const absolutePath = resolveScopedPath(path ?? "/", context.scope);
  return items
    .slice(0, maximumA2uiComponents)
    .map((_, index) =>
      renderA2uiComponent(
        { ...context, scope: `${absolutePath.replace(/\/$/u, "")}/${index}` },
        templateId,
      ),
    )
    .join("");
}

function resolveDynamicValue(value: unknown, data: unknown, scope: string): unknown {
  if (!isRecord(value)) return value;
  const path = stringValue(value.path);
  if (path) return resolveJsonPointer(data, resolveScopedPath(path, scope));
  if (stringValue(value.call) === "formatString" && isRecord(value.args)) {
    const template = stringValue(value.args.value) ?? "";
    return template.replace(/\$\{([^}]+)\}/gu, (_match, expression: string) =>
      stringifyDynamic(resolveJsonPointer(data, resolveScopedPath(expression.trim(), scope))),
    );
  }
  return "";
}

function resolveScopedPath(path: string, scope: string) {
  if (path.startsWith("/")) return path;
  return `${scope.replace(/\/$/u, "")}/${path}`;
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
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

function applyJsonPointerUpdate(root: unknown, pointer: string, value: unknown): unknown {
  if (pointer === "" || pointer === "/") return value;
  const tokens = pointer.split("/").slice(1).map(decodeJsonPointerToken);
  if (tokens.some(isUnsafeObjectKey)) return root;
  const clone = structuredClone(isRecord(root) || Array.isArray(root) ? root : {});
  let current: JsonRecord | unknown[] = clone as JsonRecord | unknown[];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const descended = descendJsonPointerContainer(
      current,
      tokens[index] ?? "",
      tokens[index + 1] ?? "",
    );
    if (!descended) return root;
    current = descended;
  }
  return assignJsonPointerValue(current, tokens.at(-1) ?? "", value) ? clone : root;
}

function descendJsonPointerContainer(
  current: JsonRecord | unknown[],
  token: string,
  nextToken: string,
): JsonRecord | unknown[] | undefined {
  if (Array.isArray(current)) {
    const index = Number(token);
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    current[index] = jsonPointerContainer(current[index], nextToken);
    return current[index] as JsonRecord | unknown[];
  }
  current[token] = jsonPointerContainer(current[token], nextToken);
  return current[token] as JsonRecord | unknown[];
}

function assignJsonPointerValue(
  current: JsonRecord | unknown[],
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

function jsonPointerContainer(value: unknown, nextToken: string): JsonRecord | unknown[] {
  if (isRecord(value) || Array.isArray(value)) return value;
  return /^\d+$/u.test(nextToken) ? [] : {};
}

function decodeJsonPointerToken(value: string) {
  return value.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function isUnsafeObjectKey(value: string) {
  return value === "__proto__" || value === "prototype" || value === "constructor";
}

function stringifyDynamic(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function safeEmbeddedMediaUrl(value: string) {
  return /^data:(?:image|audio|video)\/[a-z0-9.+-]+;base64,/iu.test(value) ? value : "";
}

function renderMarkdown(source: string): string {
  const rendered = marked.parse(source, { async: false, gfm: true });
  return sanitizePreviewHtml(typeof rendered === "string" ? rendered : "");
}

function sanitizePreviewHtml(source: string): string {
  return sanitizeHtml(source, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "article",
      "aside",
      "details",
      "figcaption",
      "figure",
      "footer",
      "header",
      "img",
      "main",
      "section",
      "summary",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      code: ["class"],
      img: ["src", "alt", "title", "width", "height"],
      ol: ["start"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: { ...attributes, target: "_blank", rel: "noreferrer noopener" },
      }),
    },
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

const previewStyles = `
:root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b0e14; color: #e6edf3; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #182235 0, #0b0e14 42rem); }
.preview-header { align-items: flex-end; display: flex; gap: 2rem; justify-content: space-between; margin: 0 auto; max-width: 1040px; padding: 2.5rem 1.25rem 1.25rem; }
.preview-header h1 { font-size: clamp(1.55rem, 3vw, 2.35rem); letter-spacing: -0.035em; margin: .35rem 0 0; }
.brand { color: #70a5ff; font-size: .72rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.format-stack { align-items: flex-end; display: grid; gap: .4rem; justify-items: end; }
.format, .readonly { border: 1px solid #2e3a4e; border-radius: 999px; color: #a9b5c7; font: 700 .72rem ui-monospace, SFMono-Regular, Menlo, monospace; padding: .35rem .65rem; }
.readonly { border: 0; color: #748197; font-family: inherit; padding: 0; }
.preview-shell { display: grid; gap: 1rem; margin: 0 auto; max-width: 1040px; padding: 0 1.25rem 4rem; }
.preview-card { background: color-mix(in srgb, #121722 94%, transparent); border: 1px solid #293346; border-radius: 18px; box-shadow: 0 18px 60px rgb(0 0 0 / .3); line-height: 1.65; min-width: 0; overflow: hidden; padding: clamp(1.25rem, 4vw, 3rem); }
.preview-card > :first-child, .preview-card section > :first-child { margin-top: 0; }
.preview-card > :last-child, .preview-card section > :last-child { margin-bottom: 0; }
h1, h2, h3, h4 { color: #f3f6fb; line-height: 1.2; margin: 1.6em 0 .65em; }
h2 { border-bottom: 1px solid #293346; padding-bottom: .35em; }
p, li { color: #c7d0dd; }
a { color: #70a5ff; text-underline-offset: .2em; }
blockquote { border-left: 3px solid #70a5ff; color: #9facc0; margin-left: 0; padding-left: 1rem; }
pre, code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
code { background: #0c111b; border: 1px solid #202b3c; border-radius: 5px; color: #9bd8cc; padding: .1em .35em; }
pre { background: #090d14; border: 1px solid #202b3c; border-radius: 12px; max-width: 100%; overflow: auto; padding: 1rem; }
pre code { background: transparent; border: 0; color: #d6deeb; padding: 0; }
table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; }
th, td { border: 1px solid #2b374a; padding: .55rem .75rem; text-align: left; }
th { background: #161e2b; }
img { height: auto; max-width: 100%; }
.mdx-lite, .spark-ui, .a2ui-surface { display: grid; gap: .85rem; }
.callout, .reference-card, .a2ui-card { background: #0f1520; border: 1px solid #2a3649; border-radius: 12px; padding: 1rem; }
.callout { border-left: 4px solid #70a5ff; }
.callout.warning { border-left-color: #e8b84e; }
.callout.error { border-left-color: #ef6f7a; }
.callout.success { border-left-color: #69c58f; }
.reference-card { display: grid; gap: .25rem; }
.reference-card span { color: #748197; font-size: .68rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.reference-card code { overflow-wrap: anywhere; }
.a2ui-layout { display: flex; gap: .85rem; min-width: 0; }
.a2ui-layout.column, .a2ui-layout.list { flex-direction: column; }
.a2ui-layout.row { align-items: flex-start; flex-wrap: wrap; }
.a2ui-layout.row > * { flex: 1 1 12rem; }
.a2ui-text.h1 { font-size: 1.8rem; font-weight: 800; }
.a2ui-text.h2 { font-size: 1.35rem; font-weight: 750; }
.a2ui-text.caption { color: #8d9aaf; font-size: .8rem; }
.a2ui-field { display: grid; gap: .35rem; }
.a2ui-field > span, .a2ui-check span { color: #9facc0; font-size: .82rem; font-weight: 700; }
input, select, button { background: #0a1019; border: 1px solid #344158; border-radius: 9px; color: #cbd5e1; font: inherit; min-height: 2.5rem; padding: .55rem .7rem; }
button { color: #9facc0; width: fit-content; }
.a2ui-check { align-items: center; display: flex; gap: .55rem; }
.a2ui-check input { min-height: auto; }
.a2ui-divider { border: 0; border-top: 1px solid #2b374a; width: 100%; }
.a2ui-tabs { display: grid; gap: .75rem; }
.a2ui-tabs > section { border: 1px solid #2b374a; border-radius: 10px; padding: .75rem; }
.a2ui-icon { color: #70a5ff; font-size: 1.4rem; }
.media-placeholder, .missing-component, .empty-state { background: #101722; border: 1px dashed #344158; border-radius: 9px; color: #8794a8; padding: .75rem; }
.diagnostics { background: #16130d; border: 1px solid #4d3f21; border-radius: 12px; color: #dfc985; padding: .8rem 1rem; }
.diagnostics summary { cursor: pointer; font-weight: 750; }
.diagnostics li { color: #cdbb86; }
@media (prefers-color-scheme: light) {
  :root { background: #f4f7fb; color: #172033; }
  body { background: radial-gradient(circle at top, #dce9ff 0, #f4f7fb 42rem); }
  .preview-card { background: rgb(255 255 255 / .96); border-color: #d8e0ec; box-shadow: 0 18px 60px rgb(58 76 104 / .12); }
  h1, h2, h3, h4 { color: #101828; }
  p, li { color: #344054; }
  h2, th, td, .a2ui-divider { border-color: #d8e0ec; }
  th { background: #f2f5f9; }
  code, pre, .callout, .reference-card, .a2ui-card { background: #f5f7fa; border-color: #d8e0ec; }
  pre code { color: #24324a; }
  input, select, button { background: #f8fafc; border-color: #cbd5e1; color: #344054; }
  .format { border-color: #bdc9d9; color: #526174; }
  .readonly, .reference-card span { color: #667085; }
}
@media (max-width: 640px) { .preview-header { align-items: flex-start; flex-direction: column; gap: 1rem; } .format-stack { align-items: flex-start; justify-items: start; } .preview-card { border-radius: 12px; } }
`;

export function previewFormatAsArtifactFormat(format: PreviewContentFormat) {
  if (format === "md") return "markdown" as const;
  if (format === "html") return "html" as const;
  if (format === "a2ui") return "json" as const;
  return "mdx" as const;
}

export function asSparkUiJsonValue(value: unknown): SparkUiJsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map(asSparkUiJsonValue);
    return items.every((item) => item !== undefined) ? (items as SparkUiJsonValue[]) : undefined;
  }
  if (isRecord(value)) {
    const result: Record<string, SparkUiJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalized = asSparkUiJsonValue(entry);
      if (normalized === undefined) return undefined;
      result[key] = normalized;
    }
    return result;
  }
  return undefined;
}
