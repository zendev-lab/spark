import assert from "node:assert/strict";
import { test } from "vitest";

import { finalAssistantTextFromRoleRunEvents } from "./role-runtime.ts";

test("extracts the latest assistant text from RoleRun events", () => {
  const events = [
    { message: { role: "assistant", content: " earlier " } },
    {
      messages: [
        { role: "assistant", content: "middle" },
        {
          role: "assistant",
          content: [
            { type: "text", text: " final" },
            { type: "image", data: "ignored" },
            { type: "text", text: " answer " },
          ],
        },
      ],
    },
  ] as const;

  assert.equal(finalAssistantTextFromRoleRunEvents(events), "final answer");
  assert.deepEqual(
    events[1].messages.map((message) => message.role),
    ["assistant", "assistant"],
  );
});

test("prefers a direct event message over the same event messages array", () => {
  assert.equal(
    finalAssistantTextFromRoleRunEvents([
      {
        message: { role: "assistant", content: "direct" },
        messages: [{ role: "assistant", content: "nested" }],
      },
    ]),
    "direct",
  );
});

test("ignores non-assistant, empty, and malformed RoleRun messages", () => {
  assert.equal(
    finalAssistantTextFromRoleRunEvents([
      null,
      { message: { role: "user", content: "not assistant" } },
      { messages: "not an array" },
      { messages: [{ role: "assistant", content: [{ type: "image", data: "ignored" }] }] },
      { message: { role: "assistant", content: "   " } },
    ]),
    undefined,
  );
});
