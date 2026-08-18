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
import sparkExtension from "@zendev-lab/spark-extension/extension";

/**
 * Single Pi product discovery entry. Registration order matches the previous
 * root `package.json#pi.extensions` list, with the native Baidu provider in
 * place of the deleted compatibility shim.
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
  sparkExtension(host);
}
