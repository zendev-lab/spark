/**
 * Re-export of the canonical provider registry surface from `@zendev-lab/spark-llm`.
 *
 * The higher-level provider-plugin registry, provider config/model types, and
 * the active-selection shape moved to the `spark-llm` package so any host or
 * runtime can drive provider plugins without importing application internals.
 * This module stays as a stable internal import path for Spark native hosts.
 */

export {
  SparkProviderRegistry,
  type ProviderConfig,
  type ProviderModelDefinition,
  type ProviderRegistrationAPI,
  type SparkActiveSelection,
} from "@zendev-lab/spark-llm";
