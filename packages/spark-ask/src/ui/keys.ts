/**
 * Terminal key parsing used by the ask overlay. This is a Spark-owned subset of
 * the sequences the overlay actually consumes: named keys, legacy arrows,
 * Kitty CSI arrows, CSI-u printable text, and Ctrl+letter.
 */

const ARROW_BY_LETTER = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
} as const;

const SHIFT = 1;
const ALT = 2;
const CTRL = 4;
const LOCK_MASK = 64 + 128;
const PRINTABLE_ALLOWED_MODIFIERS = SHIFT | LOCK_MASK;

export function parseKey(data: string): string | undefined {
  const kittyArrow = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/u);
  if (kittyArrow) {
    const name = ARROW_BY_LETTER[kittyArrow[3] as keyof typeof ARROW_BY_LETTER];
    const modifier = Number.parseInt(kittyArrow[1] ?? "1", 10) - 1;
    return formatKey(name, modifier);
  }

  const csiU = parseKittyCsiU(data);
  if (csiU) {
    const name = keyNameFromCodepoint(csiU.codepoint);
    return name ? formatKey(name, csiU.modifier) : undefined;
  }

  if (data === "\x1b[A" || data === "\x1bOA") return "up";
  if (data === "\x1b[B" || data === "\x1bOB") return "down";
  if (data === "\x1b[C" || data === "\x1bOC") return "right";
  if (data === "\x1b[D" || data === "\x1bOD") return "left";
  if (data === "\x1b") return "escape";
  if (data === "\t") return "tab";
  if (data === "\x1b[Z") return "shift+tab";
  if (data === "\r" || data === "\n") return "enter";
  if (data === "\x7f" || data === "\x08") return "backspace";
  if (data === " ") return "space";
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
    if (code >= 32 && code <= 126) return data;
  }
  return undefined;
}

export function decodeKittyPrintable(data: string): string | undefined {
  const parsed = parseKittyCsiU(data);
  if (!parsed) return undefined;
  if ((parsed.modifier & ~PRINTABLE_ALLOWED_MODIFIERS) !== 0) return undefined;
  if (parsed.modifier & (ALT | CTRL)) return undefined;
  const codepoint =
    parsed.modifier & SHIFT && parsed.shiftedKey !== undefined
      ? parsed.shiftedKey
      : parsed.codepoint;
  if (!Number.isFinite(codepoint) || codepoint < 32) return undefined;
  try {
    return String.fromCodePoint(codepoint);
  } catch {
    return undefined;
  }
}

function parseKittyCsiU(data: string): {
  codepoint: number;
  shiftedKey?: number;
  modifier: number;
} | null {
  const match = data.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/u);
  if (!match) return null;
  const codepoint = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(codepoint)) return null;
  const shiftedRaw = match[2];
  const shiftedKey =
    shiftedRaw && shiftedRaw.length > 0 ? Number.parseInt(shiftedRaw, 10) : undefined;
  const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
  const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;
  return { codepoint, ...(shiftedKey === undefined ? {} : { shiftedKey }), modifier };
}

function keyNameFromCodepoint(codepoint: number): string | undefined {
  if (codepoint === 27) return "escape";
  if (codepoint === 9) return "tab";
  if (codepoint === 13 || codepoint === 57414) return "enter";
  if (codepoint === 32) return "space";
  if (codepoint === 127) return "backspace";
  if (codepoint >= 48 && codepoint <= 57) return String.fromCharCode(codepoint);
  if (codepoint >= 97 && codepoint <= 122) return String.fromCharCode(codepoint);
  return undefined;
}

function formatKey(name: string, modifier: number): string {
  const bits = modifier & ~LOCK_MASK;
  const parts: string[] = [];
  if (bits & CTRL) parts.push("ctrl");
  if (bits & SHIFT) parts.push("shift");
  if (bits & ALT) parts.push("alt");
  parts.push(name);
  return parts.join("+");
}
