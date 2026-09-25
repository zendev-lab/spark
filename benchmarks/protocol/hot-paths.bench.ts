import { test } from "vitest";

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

test("Spark protocol production paths", async ({ bench }) => {
  await bench(`parseSparkSessionView: ${SESSION_VIEW_MESSAGE_COUNT} messages`, () => {
    runParseSparkSessionView();
  }).run();

  await bench(`projectSparkConversationMessage: ${CONVERSATION_PART_COUNT} parts`, () => {
    runProjectSparkConversationMessage();
  }).run();

  await bench(`normalizeSparkA2uiDocument: ${A2UI_COMPONENT_COUNT} components`, () => {
    runNormalizeSparkA2uiDocument();
  }).run();

  await bench(`validateCompletedSparkAgentTrace: ${AGENT_TRACE_TOOL_COUNT} tool spans`, () => {
    runValidateCompletedSparkAgentTrace();
  }).run();
});
