export interface PiExtensionManifest {
  name?: unknown;
  pi?: unknown;
}

export interface PiExtensionValidationOptions {
  rootProfile?: boolean;
}

export function validatePiExtensionManifest(
  manifest: unknown,
  { rootProfile = false }: PiExtensionValidationOptions = {},
): string[] {
  const record = asRecord(manifest);
  const name = typeof record?.name === "string" ? record.name : "<unnamed>";
  const pi = asRecord(record?.pi);
  const extensions = pi?.extensions;
  const failures: string[] = [];

  if (extensions === undefined) return failures;
  if (!Array.isArray(extensions)) {
    return [`${name} pi.extensions must be an array.`];
  }

  const seen = new Set<string>();
  for (const specifier of extensions) {
    if (typeof specifier !== "string" || !specifier.trim()) {
      failures.push(`${name} pi.extensions contains a non-empty string.`);
      continue;
    }
    if (seen.has(specifier)) {
      failures.push(`${name} pi.extensions registers ${specifier} more than once.`);
    }
    seen.add(specifier);
  }

  if (rootProfile) {
    const standaloneWorkflow = extensions.some(
      (specifier): specifier is string =>
        typeof specifier === "string" && isStandaloneWorkflowExtension(specifier),
    );
    const composedSpark = extensions.some(
      (specifier): specifier is string =>
        typeof specifier === "string" && isSparkCompositionExtension(specifier),
    );
    if (standaloneWorkflow && composedSpark) {
      failures.push(
        "root Pi extension profile loads standalone spark-workflows together with spark-extension; " +
          "spark-extension already owns the workflow tool registration.",
      );
    }
  }

  return failures;
}

export function isStandaloneWorkflowExtension(specifier: string): boolean {
  const normalized = specifier.replaceAll("\\", "/");
  return (
    normalized === "@zendev-lab/spark-workflows/extension" ||
    normalized.endsWith("/packages/spark-workflows/src/extension-entry.ts") ||
    normalized.endsWith("/packages/spark-workflows/src/extension-entry.js")
  );
}

export function isSparkCompositionExtension(specifier: string): boolean {
  const normalized = specifier.replaceAll("\\", "/");
  return (
    normalized === "@zendev-lab/spark-extension/extension" ||
    normalized.endsWith("/packages/spark-extension/src/extension/index.ts") ||
    normalized.endsWith("/packages/spark-extension/src/extension/index.js")
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
