const LEGACY_MEMORY_FIXTURE_PERMIT = Symbol("spark-memory-legacy-fixture");

export type LegacyMemoryFixturePermit = typeof LEGACY_MEMORY_FIXTURE_PERMIT;

export function createLegacyMemoryFixturePermit(): LegacyMemoryFixturePermit {
  return LEGACY_MEMORY_FIXTURE_PERMIT;
}

export function hasLegacyMemoryFixturePermit(value: unknown): value is LegacyMemoryFixturePermit {
  return value === LEGACY_MEMORY_FIXTURE_PERMIT;
}
