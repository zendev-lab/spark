import type { SparkSessionProjection } from "@zendev-lab/spark-protocol";
import {
  Key,
  ProcessTerminal,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectListTheme,
} from "@zendev-lab/spark-tui-adapter/pi-tui";
import {
  selectListThemeFromTheme,
  type SparkModelSelectorCustomUi,
  type SparkModelSelectorTheme,
} from "./model-selector.ts";

export const CREATE_SPARK_SESSION_SELECTION = "__spark_create_session__";
export const LAUNCH_CWD_WORKSPACE_SELECTION = "__spark_launch_cwd_workspace__";

const UNTITLED_SESSION_LABEL = "New conversation";
const ORPHAN_GROUP_KEY = "diagnostic:session-lineage";

/** Native selection exposes active workspace sessions only. */
export function isSelectableSparkSession(session: SparkSessionProjection): boolean {
  return session.placement !== "archived" && isUserFacingWorkspaceSession(session);
}

function isUserFacingWorkspaceSession(session: SparkSessionProjection): boolean {
  const legacy = session as SparkSessionProjection & {
    role?: unknown;
    relation?: unknown;
    status?: unknown;
  };
  return (
    legacy.role === undefined &&
    legacy.relation === undefined &&
    legacy.status === undefined &&
    session.scope.kind === "workspace"
  );
}

const plain = (text: string): string => text;

const PLAIN_SESSION_SELECTOR_THEME: SelectListTheme = {
  selectedPrefix: plain,
  selectedText: plain,
  description: plain,
  scrollInfo: plain,
  noMatch: plain,
};

export interface SparkSessionSelectorWorkspace {
  /** Registry identity or a compatibility alias accepted by existing sessions. */
  id: string;
  /** Canonical daemon workspace identity used by new sessions and leases. */
  canonicalId: string;
  displayName: string;
  localPath: string;
  registration?: "registered" | "suggested";
}

export type SparkSessionSelectorSelection =
  | { kind: "session"; sessionId: string; workspaceId: string }
  | { kind: "create"; workspaceId: string };

export interface SparkSessionSelectorOptions {
  sessions: SparkSessionProjection[];
  workspaces: SparkSessionSelectorWorkspace[];
  /** Launch cwd is only a visual/default suggestion; rendering never registers it. */
  suggestedWorkspaceId?: string;
  title?: string;
  maxVisible?: number;
}

export async function runNativeSparkSessionSelector(
  options: SparkSessionSelectorOptions,
): Promise<SparkSessionSelectorSelection | null> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  let resolveSelection: ((selection: SparkSessionSelectorSelection | null) => void) | undefined;
  const selection = new Promise<SparkSessionSelectorSelection | null>((resolve) => {
    resolveSelection = resolve;
  });
  const component = createSparkSessionSelectorComponent({
    ...options,
    onSelect: (value) => resolveSelection?.(value),
    onCancel: () => resolveSelection?.(null),
    requestRender: () => tui.requestRender(),
  });
  tui.addChild(component);
  tui.setFocus(component);
  terminal.setTitle("Select Spark Session");
  tui.start();
  tui.requestRender(true);
  try {
    return await selection;
  } finally {
    tui.stop();
    await terminal.drainInput();
  }
}

export async function selectSparkSessionFromCustomUi(
  ui: SparkModelSelectorCustomUi,
  options: SparkSessionSelectorOptions,
): Promise<SparkSessionSelectorSelection | null> {
  if (typeof ui.custom !== "function") return null;
  return await ui.custom<SparkSessionSelectorSelection | null>(
    (tui, theme, _keybindings, done) =>
      createSparkSessionSelectorComponent({
        ...options,
        theme: selectListThemeFromTheme(theme as SparkModelSelectorTheme),
        onSelect: done,
        onCancel: () => done(null),
        requestRender: () => tui.requestRender(),
      }),
    {
      overlay: true,
      overlayOptions: { width: "72%", minWidth: 56, maxHeight: "82%" },
    },
  );
}

export interface SparkSessionSelectorComponentOptions extends SparkSessionSelectorOptions {
  theme?: SelectListTheme;
  onSelect: (selection: SparkSessionSelectorSelection) => void;
  onCancel?: () => void;
  requestRender?: () => void;
}

export function createSparkSessionSelectorComponent(
  options: SparkSessionSelectorComponentOptions,
): Component {
  return new SparkSessionSelectorComponent(options);
}

interface SparkSessionSelectionItem {
  value: string;
  selection: SparkSessionSelectorSelection;
  label: string;
  description: string;
}

interface SparkSessionSelectionGroup {
  key: string;
  label: string;
  tabLabel: string;
  suggested: boolean;
  items: SparkSessionSelectionItem[];
}

class SparkSessionSelectorComponent implements Component {
  private readonly title: string;
  private readonly requestRender?: () => void;
  private readonly onSelect: (selection: SparkSessionSelectorSelection) => void;
  private readonly onCancel?: () => void;
  private readonly theme: SelectListTheme;
  private readonly options: SparkSessionSelectorOptions;
  private groups: SparkSessionSelectionGroup[];
  private readonly selectedByGroup = new Map<string, number>();
  private readonly maxVisible: number;
  private activeGroupIndex = 0;
  private archivedVisible = false;

  constructor(options: SparkSessionSelectorComponentOptions) {
    this.title = options.title ?? "Open Spark Session";
    this.requestRender = options.requestRender;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
    this.theme = options.theme ?? PLAIN_SESSION_SELECTOR_THEME;
    this.options = options;
    this.groups = sessionSelectionGroups(options, this.archivedVisible);
    this.maxVisible = Math.max(1, options.maxVisible ?? 14);
    const suggestedIndex = this.groups.findIndex(
      (group) => group.key === `workspace:${options.suggestedWorkspaceId}`,
    );
    if (suggestedIndex >= 0) this.activeGroupIndex = suggestedIndex;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.left) || data === "h") {
      this.moveGroup(-1);
    } else if (matchesKey(data, Key.right) || data === "l") {
      this.moveGroup(1);
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.moveSelection(-1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.moveSelection(1);
    } else if ((data === "a" || data === "A") && archivedSessionCount(this.options) > 0) {
      this.toggleArchived();
    } else if (matchesKey(data, Key.enter)) {
      const selected = this.activeGroup().items[this.selectedIndex()];
      if (selected) this.onSelect(selected.selection);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
    this.requestRender?.();
  }

  render(width: number): string[] {
    const group = this.activeGroup();
    const visibleItems = this.visibleItems(group);
    const archivedCount = archivedSessionCount(this.options);
    const lines = [
      truncateToWidth(this.title, width),
      this.renderGroupTabs(width),
      truncateToWidth("".padEnd(Math.min(width, 80), "─"), width),
      ...visibleItems.map((item) => this.renderItem(item, width)),
    ];
    if (group.items.length > visibleItems.length) {
      lines.push(this.theme.scrollInfo(`  (${this.selectedIndex() + 1}/${group.items.length})`));
    }
    const archivedAction =
      archivedCount === 0
        ? ""
        : this.archivedVisible
          ? " • a Hide archived"
          : ` • a Show archived (${archivedCount})`;
    lines.push(
      truncateToWidth(`←→ workspace • ↑↓ session${archivedAction} • enter open • esc exit`, width),
    );
    return lines.map((line) => truncateToWidth(line, width));
  }

  private activeGroup(): SparkSessionSelectionGroup {
    return this.groups[this.activeGroupIndex]!;
  }

  private selectedIndex(group = this.activeGroup()): number {
    return Math.min(this.selectedByGroup.get(group.key) ?? 0, group.items.length - 1);
  }

  private moveGroup(step: number): void {
    this.activeGroupIndex =
      (this.activeGroupIndex + step + this.groups.length) % this.groups.length;
  }

  private moveSelection(step: number): void {
    const group = this.activeGroup();
    if (group.items.length === 0) return;
    const selected = (this.selectedIndex(group) + step + group.items.length) % group.items.length;
    this.selectedByGroup.set(group.key, selected);
  }

  private toggleArchived(): void {
    const activeKey = this.activeGroup().key;
    this.archivedVisible = !this.archivedVisible;
    this.groups = sessionSelectionGroups(this.options, this.archivedVisible);
    const nextIndex = this.groups.findIndex((group) => group.key === activeKey);
    this.activeGroupIndex = nextIndex >= 0 ? nextIndex : 0;
  }

  private visibleItems(group: SparkSessionSelectionGroup): SparkSessionSelectionItem[] {
    if (group.items.length <= this.maxVisible) return group.items;
    const selected = this.selectedIndex(group);
    let start = Math.max(0, selected - Math.floor(this.maxVisible / 2));
    start = Math.min(start, group.items.length - this.maxVisible);
    return group.items.slice(start, start + this.maxVisible);
  }

  private renderGroupTabs(width: number): string {
    const tabs = this.groups.map((group, index) => {
      const count = sessionGroupCount(group);
      const label = group.suggested ? group.tabLabel : `${group.tabLabel} (${count})`;
      return index === this.activeGroupIndex
        ? this.theme.selectedText(`[${label}]`)
        : this.theme.description(label);
    });
    const allTabs = `← ${tabs.join("  ")} →`;
    if (visibleWidth(allTabs) <= width) return allTabs;
    const active = tabs[this.activeGroupIndex]!;
    return truncateToWidth(
      `← ${active} →  ${this.activeGroupIndex + 1}/${this.groups.length}`,
      width,
    );
  }

  private renderItem(item: SparkSessionSelectionItem, width: number): string {
    const selected = item.value === this.activeGroup().items[this.selectedIndex()]?.value;
    const prefix = selected ? "→ " : "  ";
    const labelWidth =
      width > 56 ? Math.min(48, Math.max(24, Math.floor(width * 0.45))) : width - 4;
    const label = truncateToWidth(`  ${item.label}`, Math.max(1, labelWidth), "");
    const padded = `${prefix}${label}${" ".repeat(Math.max(2, labelWidth - visibleWidth(label) + 2))}`;
    const descriptionWidth = Math.max(0, width - visibleWidth(padded) - 1);
    const description =
      descriptionWidth > 10 ? truncateToWidth(item.description, descriptionWidth, "") : "";
    const line = `${padded}${description}`;
    return selected ? this.theme.selectedText(line) : line;
  }
}

export function formatSparkSessionListByWorkspace(options: SparkSessionSelectorOptions): string {
  const groups = sessionSelectionGroups(options, false)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !isCreateSelection(item.selection)),
    }))
    .filter((group) => group.items.length > 0);
  if (groups.length === 0) return "No managed Spark sessions in this workspace hierarchy.";
  return [
    "Spark workspace sessions:",
    ...groups.flatMap((group) => [
      `${group.label} (${group.items.length})`,
      ...group.items.map((item) => `  ${item.label} • ${item.description}`),
    ]),
  ].join("\n");
}

function sessionSelectionGroups(
  options: SparkSessionSelectorOptions,
  includeArchived: boolean,
): SparkSessionSelectionGroup[] {
  const workspaces = canonicalSelectorWorkspaces(options.workspaces);
  const byKey = new Map<string, SparkSessionSelectionGroup>();
  for (const workspace of workspaces) {
    const key = `workspace:${workspace.canonicalId}`;
    const suggested = workspace.registration === "suggested";
    byKey.set(key, {
      key,
      label: suggested ? "Open workspace" : workspace.displayName,
      tabLabel: suggested ? "Open workspace" : workspace.displayName,
      suggested,
      items: [
        {
          value: `${CREATE_SPARK_SESSION_SELECTION}:${workspace.canonicalId}`,
          selection: { kind: "create", workspaceId: workspace.canonicalId },
          label: "+ New session",
          description: suggested
            ? `Open a new session in ${workspace.localPath}`
            : "Create a daemon-managed session in this workspace",
        },
      ],
    });
  }

  const visibleSessions = options.sessions.filter(
    (session) =>
      isUserFacingWorkspaceSession(session) &&
      (includeArchived || session.placement !== "archived"),
  );
  const orphans: SparkSessionSelectionItem[] = [];
  for (const workspace of workspaces) {
    const group = byKey.get(`workspace:${workspace.canonicalId}`)!;
    const workspaceSessions = visibleSessions.filter(
      (session) =>
        session.scope.kind === "workspace" &&
        selectorWorkspaceMatches(workspace, session.scope.workspaceId, options.workspaces),
    );
    const byId = new Map(workspaceSessions.map((session) => [session.sessionId, session]));
    const orphanRoots: SparkSessionProjection[] = [];
    const roots = workspaceSessions
      .filter(
        (session) =>
          session.lineage.kind === "root" ||
          (!byId.has(session.lineage.parentSessionId) &&
            isImplicitWorkspaceAdministrator(session.lineage.parentSessionId)),
      )
      .sort(compareSessions);
    const children = new Map<string, SparkSessionProjection[]>();
    for (const session of workspaceSessions) {
      const relation = childRelation(session);
      if (!relation) continue;
      if (!byId.has(relation.parentSessionId)) {
        if (isImplicitWorkspaceAdministrator(relation.parentSessionId)) continue;
        orphanRoots.push(session);
        continue;
      }
      const siblings = children.get(relation.parentSessionId) ?? [];
      siblings.push(session);
      children.set(relation.parentSessionId, siblings);
    }
    const emitted = new Set<string>();
    for (const root of roots) {
      appendSessionTree(group.items, root, children, emitted, 0);
    }
    for (const orphan of orphanRoots.sort(compareSessions)) {
      appendDiagnosticSessionTree(orphans, orphan, children, emitted, "orphan");
    }
    for (const cyclic of workspaceSessions.filter((session) => !emitted.has(session.sessionId))) {
      appendDiagnosticSessionTree(orphans, cyclic, children, emitted, "cycle");
    }
  }

  if (orphans.length > 0) {
    byKey.set(ORPHAN_GROUP_KEY, {
      key: ORPHAN_GROUP_KEY,
      label: "Session lineage diagnostics",
      tabLabel: "Lineage",
      suggested: false,
      items: orphans.sort((left, right) => left.value.localeCompare(right.value)),
    });
  }

  if (byKey.size === 0) {
    byKey.set("diagnostic:no-workspaces", {
      key: "diagnostic:no-workspaces",
      label: "No registered or suggested workspaces",
      tabLabel: "No workspaces",
      suggested: false,
      items: [],
    });
  }
  return [...byKey.values()];
}

function canonicalSelectorWorkspaces(
  workspaces: SparkSessionSelectorWorkspace[],
): SparkSessionSelectorWorkspace[] {
  const result = new Map<string, SparkSessionSelectorWorkspace>();
  for (const workspace of workspaces) {
    const current = result.get(workspace.canonicalId);
    if (!current || workspace.id === workspace.canonicalId)
      result.set(workspace.canonicalId, workspace);
  }
  return [...result.values()];
}

function selectorWorkspaceMatches(
  workspace: SparkSessionSelectorWorkspace,
  workspaceId: string,
  allWorkspaces: SparkSessionSelectorWorkspace[],
): boolean {
  if (workspace.canonicalId === workspaceId || workspace.id === workspaceId) return true;
  return allWorkspaces.some(
    (candidate) =>
      candidate.canonicalId === workspace.canonicalId &&
      (candidate.id === workspaceId || candidate.canonicalId === workspaceId),
  );
}

function sessionGroupCount(group: SparkSessionSelectionGroup): number {
  return group.items.filter((item) => !isCreateSelection(item.selection)).length;
}

function isCreateSelection(selection: SparkSessionSelectorSelection): boolean {
  return selection.kind === "create";
}

function archivedSessionCount(options: SparkSessionSelectorOptions): number {
  return options.sessions.filter(
    (session) => isUserFacingWorkspaceSession(session) && session.placement === "archived",
  ).length;
}

function sessionSelectionItem(
  session: SparkSessionProjection,
  depth: number,
  diagnostic?: "orphan" | "cycle",
): SparkSessionSelectionItem {
  if (session.scope.kind !== "workspace") {
    throw new Error(`Session selector cannot render daemon session ${session.sessionId}.`);
  }
  const channel = session.bindings[0];
  const child = childRelation(session);
  const relation =
    child && !isImplicitWorkspaceAdministrator(child.parentSessionId) ? child : undefined;
  const archived = session.placement === "archived" ? " [archived]" : "";
  return {
    value: session.sessionId,
    selection: {
      kind: "session",
      sessionId: session.sessionId,
      workspaceId: session.scope.workspaceId,
    },
    label: `${depth > 0 ? `${"  ".repeat(depth)}└─ ` : ""}${sessionDisplayTitle(session)}${archived}`,
    description: [
      relation ? `origin=${relation.kind}` : undefined,
      relation ? `parent=${relation.parentSessionId}` : undefined,
      relation && "generation" in relation ? `generation=${relation.generation}` : undefined,
      diagnostic === "orphan" ? "lineage=missing-parent" : undefined,
      diagnostic === "cycle" ? "lineage=cycle" : undefined,
      session.sessionId,
      channel ? channel.adapter : undefined,
      session.model ? `${session.model.providerName}/${session.model.modelId}` : undefined,
      session.thinkingLevel ? `thinking=${session.thinkingLevel}` : undefined,
      `lifecycle=${session.lifecycle}`,
      `activity=${session.activity ?? "idle"}`,
      `updated=${session.updatedAt}`,
    ]
      .filter(Boolean)
      .join(" • "),
  };
}

function sessionDisplayTitle(session: SparkSessionProjection): string {
  const title = session.name?.trim();
  if (!title) return UNTITLED_SESSION_LABEL;
  if (!title.startsWith("role:")) return title;
  const roleRef = session.roleBinding.kind === "explicit" ? session.roleBinding.roleRef : title;
  const role = humanizeTechnicalRole(roleRef);
  return `${role} session`;
}

function humanizeTechnicalRole(roleRef: string): string {
  const roleId = roleRef
    .replace(/^role:/u, "")
    .replace(/^(?:builtin|extension|project|user)-/u, "");
  const words = roleId.split(/[-_/]+/u).filter(Boolean);
  if (words.length === 0) return "Managed";
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ");
}

function compareSessions(left: SparkSessionProjection, right: SparkSessionProjection): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId)
  );
}

function childRelation(session: SparkSessionProjection) {
  return session.lineage.kind === "child"
    ? { ...session.lineage.origin, parentSessionId: session.lineage.parentSessionId }
    : undefined;
}

function appendSessionTree(
  items: SparkSessionSelectionItem[],
  session: SparkSessionProjection,
  children: ReadonlyMap<string, SparkSessionProjection[]>,
  emitted: Set<string>,
  depth: number,
): void {
  if (emitted.has(session.sessionId)) return;
  emitted.add(session.sessionId);
  items.push(sessionSelectionItem(session, depth));
  for (const child of (children.get(session.sessionId) ?? []).sort(compareChildSessions)) {
    appendSessionTree(items, child, children, emitted, depth + 1);
  }
}

function appendDiagnosticSessionTree(
  items: SparkSessionSelectionItem[],
  session: SparkSessionProjection,
  children: ReadonlyMap<string, SparkSessionProjection[]>,
  emitted: Set<string>,
  diagnostic: "orphan" | "cycle",
): void {
  if (emitted.has(session.sessionId)) return;
  emitted.add(session.sessionId);
  items.push(sessionSelectionItem(session, 0, diagnostic));
  for (const child of (children.get(session.sessionId) ?? []).sort(compareChildSessions)) {
    appendSessionTree(items, child, children, emitted, 1);
  }
}

function isImplicitWorkspaceAdministrator(sessionId: string): boolean {
  return /(?:^|[_:-])admin(?:istrator)?(?:[_:-]|$)/iu.test(sessionId);
}

function compareChildSessions(left: SparkSessionProjection, right: SparkSessionProjection): number {
  const leftOrigin = left.lineage.kind === "child" ? left.lineage.origin : undefined;
  const rightOrigin = right.lineage.kind === "child" ? right.lineage.origin : undefined;
  const leftGeneration =
    leftOrigin && "generation" in leftOrigin ? leftOrigin.generation : undefined;
  const rightGeneration =
    rightOrigin && "generation" in rightOrigin ? rightOrigin.generation : undefined;
  if (leftGeneration !== undefined && rightGeneration !== undefined) {
    return leftGeneration - rightGeneration || compareSessions(left, right);
  }
  return compareSessions(left, right);
}
