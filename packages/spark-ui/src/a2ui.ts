import type {
  SparkWorkbenchActionRequest,
  SparkSessionReproWorkView,
} from "@zendev-lab/spark-protocol";

export { default as A2uiRenderer } from "./A2uiRenderer.svelte";

export type SparkA2uiInteractiveBinding = NonNullable<SparkSessionReproWorkView["workbench"]>;

export type SparkA2uiActionHandler = (action: SparkWorkbenchActionRequest) => void | Promise<void>;
