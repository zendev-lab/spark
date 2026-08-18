import { truncateToWidth } from "./layout.ts";

/** Truncated single-line tool-call renderer shared by capability extensions. */
export class ToolCallText {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }
}
