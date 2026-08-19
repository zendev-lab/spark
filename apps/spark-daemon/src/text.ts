/** String helpers shared across daemon surfaces. Kept dependency-free so any
 *  daemon module can import them without introducing a cycle through the
 *  CLI/local-RPC graph. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
