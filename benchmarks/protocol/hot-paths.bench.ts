import { bench, describe } from "vitest";

import {
  A2UI_COMPONENT_COUNT,
  AGENT_TRACE_TOOL_COUNT,
  CONVERSATION_PART_COUNT,
  SESSION_VIEW_MESSAGE_COUNT,
  runNormalizeSparkA2uiDocument,
  runParseSparkSessionView,
  runProjectSparkConversationMessage,
  runValidateCompletedSparkAgentTrace,
} from "./hot-paths-cases.ts";

describe("Spark protocol production paths", () => {
  bench(`parseSparkSessionView: ${SESSION_VIEW_MESSAGE_COUNT} messages`, () => {
    runParseSparkSessionView();
  });

  bench(`projectSparkConversationMessage: ${CONVERSATION_PART_COUNT} parts`, () => {
    runProjectSparkConversationMessage();
  });

  bench(`normalizeSparkA2uiDocument: ${A2UI_COMPONENT_COUNT} components`, () => {
    runNormalizeSparkA2uiDocument();
  });

  bench(`validateCompletedSparkAgentTrace: ${AGENT_TRACE_TOOL_COUNT} tool spans`, () => {
    runValidateCompletedSparkAgentTrace();
  });
});
