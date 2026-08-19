/**
 * Ask-owned terminal key decode. Capability layer stays free of pi-tui /
 * spark-tui-adapter so Hub, channels, and tests can drive the same controller.
 */

const KITTY_CSI_U = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
const KITTY_ARROW = /^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/;
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;

const ARROW_BY_LETTER = { A: "up", B: "down", C: "right", D: "left" } as const;

const LOCK_MASK = 64 + 128;
const SHIFT = 1;
const ALT = 2;
const CTRL = 4;

export function parseAskRawKey(data: string): string | undefined {
  const kittyU = parseKittyCsiU(data);
  if (kittyU) return formatAskKey(kittyU.codepoint, kittyU.modifier);

  const arrow = data.match(KITTY_ARROW);
  if (arrow) {
    const modifier = Number.parseInt(arrow[1] ?? "1", 10) - 1;
    return formatNamedKey(ARROW_BY_LETTER[arrow[3] as keyof typeof ARROW_BY_LETTER], modifier);
  }

  const modifyOther = data.match(MODIFY_OTHER_KEYS);
  if (modifyOther) {
    const modifier = Number.parseInt(modifyOther[1] ?? "1", 10) - 1;
    const codepoint = Number.parseInt(modifyOther[2] ?? "", 10);
    return formatAskKey(codepoint, modifier);
  }

  switch (data) {
    case "\x1b":
      return "escape";
    case "\t":
      return "tab";
    case "\r":
    case "\n":
    case "\x1bOM":
      return "enter";
    case " ":
      return "space";
    case "\x7f":
    case "\b":
      return "backspace";
    case "\x1b[Z":
      return "shift+tab";
    case "\x1b[A":
    case "\x1bOA":
      return "up";
    case "\x1b[B":
    case "\x1bOB":
      return "down";
    case "\x1b[C":
    case "\x1bOC":
      return "right";
    case "\x1b[D":
    case "\x1bOD":
      return "left";
    default:
      break;
  }

  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
    if (code >= 32 && code <= 126) return data;
  }

  return undefined;
}

export function normalizeAskKey(key: string): string {
  return (parseAskRawKey(key) ?? key)
    .toLowerCase()
    .replace(/escape/g, "esc")
    .replace(/return/g, "enter")
    .replace(/control\+/g, "ctrl+")
    .trim();
}

export function printableAskText(data: string): string | undefined {
  const decoded = decodeAskKittyPrintable(data);
  if (decoded) return decoded;
  if (data.includes("\x1b")) return undefined;
  if (data.length === 0) return undefined;
  if (data === "\r" || data === "\n" || data === "\t" || data === "\x7f") return undefined;
  if (data.length === 1 && data < " ") return undefined;
  return data;
}

export function decodeAskKittyPrintable(data: string): string | undefined {
  const match = data.match(KITTY_CSI_U);
  if (!match) return undefined;

  const codepoint = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(codepoint)) return undefined;

  const shiftedKey = match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : undefined;
  const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
  const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;
  const effectiveMod = modifier & ~LOCK_MASK;
  if ((effectiveMod & ~(SHIFT)) !== 0) return undefined;
  if (effectiveMod & (ALT | CTRL)) return undefined;

  let effectiveCodepoint = codepoint;
  if (effectiveMod & SHIFT && typeof shiftedKey === "number") effectiveCodepoint = shiftedKey;
  if (!Number.isFinite(effectiveCodepoint) || effectiveCodepoint < 32) return undefined;

  try {
    return String.fromCodePoint(effectiveCodepoint);
  } catch {
    return undefined;
  }
}

function parseKittyCsiU(data: string): { codepoint: number; modifier: number } | undefined {
  const match = data.match(KITTY_CSI_U);
  if (!match) return undefined;
  const codepoint = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(codepoint)) return undefined;
  const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
  const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;
  return { codepoint, modifier };
}

function formatAskKey(codepoint: number, modifier: number): string | undefined {
  let name: string | undefined;
  if (codepoint === 27) name = "escape";
  else if (codepoint === 9) name = "tab";
  else if (codepoint === 13 || codepoint === 57414) name = "enter";
  else if (codepoint === 32) name = "space";
  else if (codepoint === 127) name = "backspace";
  else if (codepoint >= 48 && codepoint <= 57) name = String.fromCharCode(codepoint);
  else if (codepoint >= 97 && codepoint <= 122) name = String.fromCharCode(codepoint);
  else if (codepoint >= 65 && codepoint <= 90) name = String.fromCharCode(codepoint + 32);
  if (!name) return undefined;
  return formatNamedKey(name, modifier);
}

function formatNamedKey(name: string, modifier: number): string {
  const mods: string[] = [];
  const effective = modifier & ~LOCK_MASK;
  if (effective & SHIFT) mods.push("shift");
  if (effective & CTRL) mods.push("ctrl");
  if (effective & ALT) mods.push("alt");
  return mods.length > 0 ? `${mods.join("+")}+${name}` : name;
}
