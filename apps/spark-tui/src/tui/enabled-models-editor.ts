/**
 * Multi-select overlay for editing Spark config.json enabledModels.
 *
 * Space toggles the current row. Enter saves the checked catalog ids.
 * Esc / Ctrl+C cancels without writing.
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
} from "@zendev-lab/spark-tui-adapter/pi-tui";
import type { SparkNativeCustomUi } from "../native-tui/session-contracts.ts";
import {
  selectListThemeFromTheme,
  type SparkModelSelectorTheme,
  type SparkModelSelectorTuiLike,
} from "./model-selector.ts";
import type {
  SparkEnabledModelCatalogState,
  SparkEnabledModelEditorItem,
} from "../host/model-selector.ts";

const DEFAULT_MAX_VISIBLE = 12;

export async function runSparkEnabledModelsEditor(
  ui: Pick<SparkNativeCustomUi, "custom">,
  state: SparkEnabledModelCatalogState,
): Promise<string[] | undefined> {
  if (typeof ui.custom !== "function") return undefined;
  const result = await ui.custom<string[] | null>(
    (tui, theme, _keybindings, done) =>
      createSparkEnabledModelsEditorComponent({
        state,
        theme,
        onSave: done,
        onCancel: () => done(null),
        requestRender: () => tui.requestRender(),
        terminal: tui,
      }),
    {
      overlay: true,
      overlayOptions: { width: "70%", minWidth: 56, maxHeight: "80%" },
    },
  );
  return result ?? undefined;
}

export interface SparkEnabledModelsEditorComponentOptions {
  state: SparkEnabledModelCatalogState;
  title?: string;
  maxVisible?: number;
  theme?: SparkModelSelectorTheme;
  onSave: (modelValues: string[] | null) => void;
  onCancel?: () => void;
  requestRender?: () => void;
  terminal?: SparkModelSelectorTuiLike;
}

export interface SparkEnabledModelsEditorComponentHandle extends Component {
  handleInput(data: string): void;
  render(width: number): string[];
}

export function createSparkEnabledModelsEditorComponent(
  options: SparkEnabledModelsEditorComponentOptions,
): SparkEnabledModelsEditorComponentHandle {
  return new SparkEnabledModelsEditorComponent(options);
}

class SparkEnabledModelsEditorComponent implements Component {
  private readonly title: string;
  private readonly items: SparkEnabledModelEditorItem[];
  private readonly enabled = new Set<string>();
  private readonly maxVisible: number;
  private readonly requestRender?: () => void;
  private readonly onSave: (modelValues: string[] | null) => void;
  private readonly onCancel?: () => void;
  private readonly theme: ReturnType<typeof selectListThemeFromTheme>;
  private selectedIndex = 0;
  private scrollOffset = 0;

  constructor(options: SparkEnabledModelsEditorComponentOptions) {
    this.title = options.title ?? "Edit enabled models";
    this.items = options.state.items;
    this.maxVisible = Math.max(1, options.maxVisible ?? DEFAULT_MAX_VISIBLE);
    this.requestRender = options.requestRender;
    this.onSave = options.onSave;
    this.onCancel = options.onCancel;
    this.theme = selectListThemeFromTheme(options.theme ?? {});
    for (const item of this.items) {
      if (item.enabled) this.enabled.add(item.value);
    }
    const firstEnabled = this.items.findIndex((item) => item.enabled);
    if (firstEnabled >= 0) this.selectedIndex = firstEnabled;
    this.ensureVisible();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || data === "k") {
      this.move(-1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.move(1);
    } else if (matchesKey(data, Key.space) || data === " ") {
      this.toggleCurrent();
    } else if (matchesKey(data, Key.enter) || data === "\r") {
      this.onSave(
        this.items.filter((item) => this.enabled.has(item.value)).map((item) => item.value),
      );
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.onCancel) this.onCancel();
      else this.onSave(null);
    }
    this.requestRender?.();
  }

  render(width: number): string[] {
    const visible = this.items.slice(this.scrollOffset, this.scrollOffset + this.maxVisible);
    const lines = [
      truncateToWidth(this.title, width),
      truncateToWidth("".padEnd(Math.min(width, 80), "─"), width),
    ];
    if (this.items.length === 0) {
      lines.push(truncateToWidth(this.theme.noMatch("No providers or models registered."), width));
    } else {
      for (const [offset, item] of visible.entries()) {
        const index = this.scrollOffset + offset;
        lines.push(truncateToWidth(this.renderRow(item, index === this.selectedIndex), width));
      }
      if (this.items.length > visible.length) {
        lines.push(this.theme.scrollInfo(`  (${this.selectedIndex + 1}/${this.items.length})`));
      }
    }
    lines.push(
      truncateToWidth(
        `↑↓ navigate • space toggle • enter save (${this.enabled.size}) • esc cancel`,
        width,
      ),
    );
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderRow(item: SparkEnabledModelEditorItem, selected: boolean): string {
    const mark = this.enabled.has(item.value) ? "[x]" : "[ ]";
    const label = `${mark} ${item.modelLabel}  ${item.value}`;
    const description = item.available
      ? item.description
      : (item.unavailableReason ?? "Authentication required");
    const row = `${label} — ${description}`;
    return selected ? this.theme.selectedText(row) : row;
  }

  private move(step: number): void {
    if (this.items.length === 0) return;
    this.selectedIndex = (this.selectedIndex + step + this.items.length) % this.items.length;
    this.ensureVisible();
  }

  private toggleCurrent(): void {
    const item = this.items[this.selectedIndex];
    if (!item) return;
    if (this.enabled.has(item.value)) this.enabled.delete(item.value);
    else this.enabled.add(item.value);
  }

  private ensureVisible(): void {
    if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
    else if (this.selectedIndex >= this.scrollOffset + this.maxVisible) {
      this.scrollOffset = this.selectedIndex - this.maxVisible + 1;
    }
  }
}
