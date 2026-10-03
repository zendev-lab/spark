export function sparkWebTurnMessageMetadata(): Record<string, unknown> {
  return {
    origin: {
      kind: "user",
      host: "web",
      surface: "local",
      product: "spark-web",
    },
  };
}

export function explicitMemoryRefs(texts: Iterable<string>): string[] {
  const refs = new Set<string>();
  for (const text of texts) {
    for (const token of text.split(/\s+/u)) {
      const normalized = token.replace(/^[\s([{"'`]+|[\s)\]}"'`,.;!?]+$/gu, "");
      if (/^(?:memory|recall|learning[-:]).+/u.test(normalized)) refs.add(normalized);
    }
  }
  return [...refs];
}
