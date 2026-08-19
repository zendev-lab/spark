import type { SparkHostAPI } from "@zendev-lab/spark-core";
import sparkAskExtension from "@zendev-lab/spark-ask/extension";
import sparkArtifactsDaemonExtension from "@zendev-lab/spark-artifacts/daemon-extension";
import sparkCueExtension from "@zendev-lab/spark-cue/extension";
import sparkModelsExtension from "@zendev-lab/spark-llm/models-extension";
import registerNativeBaiduOneApiProvider from "@zendev-lab/spark-llm/baidu-oneapi-provider";
import sparkRolesExtension from "@zendev-lab/spark-roles/extension";
import sparkSessionExtension from "@zendev-lab/spark-session/extension";
import sparkMemoryExtension from "@zendev-lab/spark-memory/extension";
import sparkWebExtension from "@zendev-lab/spark-web/extension";

/**
 * Minimal Pi product discovery entry for additive, host-neutral capabilities.
 * Spark product policy, driver lifecycle, Goal, and Repro stay in Spark-native
 * composition and are intentionally absent here.
 */
export default function piSpark(api: SparkHostAPI): void {
  const host = api as never;
  sparkAskExtension(api);
  sparkArtifactsDaemonExtension(host);
  sparkCueExtension(api);
  sparkModelsExtension(host);
  sparkRolesExtension(api);
  sparkSessionExtension(host);
  sparkMemoryExtension(host, { enablePiCompatAliases: true });
  sparkWebExtension(host);
  registerNativeBaiduOneApiProvider(host);
}
