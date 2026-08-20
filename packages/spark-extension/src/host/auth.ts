/**
 * Compatibility facade for local hosts.
 *
 * Spark credentials and provider control are product mechanisms shared with
 * daemon, local web, and other local hosts; presentation adapters only consume
 * them.
 */
export {
  SparkAuthStore,
  SparkProviderAuthResolver,
  defaultSparkAuthPath,
  listOAuthProviderSummaries,
  registerSparkOAuthProvider,
  resetSparkOAuthProviders,
} from "@zendev-lab/spark-llm/control";
export type {
  SparkAuthFile,
  SparkAuthStoreOptions,
  SparkOAuthProviderInterface,
  SparkProviderAuthResolverOptions,
  SparkProviderAuthStatus,
  SparkStoredCredential,
} from "@zendev-lab/spark-llm/control";
