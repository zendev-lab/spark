export interface RenamedEnvironmentVariable {
  canonical: string;
  legacy: string;
}

/** Resolve one renamed environment variable without silently choosing conflicting values. */
export function resolveRenamedEnvironmentVariable(
  env: Record<string, string | undefined>,
  names: RenamedEnvironmentVariable,
): string | undefined {
  const canonical = nonEmpty(env[names.canonical]);
  const legacy = nonEmpty(env[names.legacy]);
  if (canonical && legacy && canonical !== legacy) {
    throw new Error(
      `${names.canonical} conflicts with retired ${names.legacy}; remove the legacy variable after copying its value.`,
    );
  }
  return canonical ?? legacy;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
