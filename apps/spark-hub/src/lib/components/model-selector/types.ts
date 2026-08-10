export type {
  ConversationModelGroup as ModelPickerGroup,
  ConversationModelOption as ModelPickerOption,
} from "@zendev-lab/spark-ui/conversation";

export type ModelRuntimeControlLabels = {
  aria: string;
  model: string;
  thinking: string;
  chooseModel: string;
  chooseModelHint: string;
  searchModels: string;
  noModelsFound: string;
  closeModelPicker: string;
  clearModelSearch: string;
  modelUnavailable: string;
  configureModels: string;
  thinkingLevels?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string>>;
};
