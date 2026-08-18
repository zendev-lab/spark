/** Theme / key helpers for the native TUI editor chrome. */

import type { OverlayOptions, SelectListTheme } from "@zendev-lab/spark-tui-adapter/pi-tui";
import {
  BUILTIN_SPARK_THEMES,
  createSparkHostRenderTheme,
  type SparkTheme,
} from "../host/theme.ts";

export const DEFAULT_NATIVE_THEME = BUILTIN_SPARK_THEMES.find((theme) => theme.id === "dark")!;
export function createEditorTheme(theme: SparkTheme) {
  const renderTheme = createSparkHostRenderTheme(theme);
  const editorSelectListTheme: SelectListTheme = {
    selectedPrefix: (text) => renderTheme.fg("selected", text),
    selectedText: (text) => renderTheme.fg("selected", text),
    description: (text) => renderTheme.fg("muted", text),
    scrollInfo: (text) => renderTheme.fg("muted", text),
    noMatch: (text) => renderTheme.fg("warning", text),
  };
  return {
    borderColor: (text: string) => renderTheme.fg("border", text),
    selectList: editorSelectListTheme,
  };
}

export function isOverlayRequest(value: unknown): value is {
  overlay?: boolean;
  overlayOptions?: OverlayOptions;
} {
  return typeof value === "object" && value !== null;
}
