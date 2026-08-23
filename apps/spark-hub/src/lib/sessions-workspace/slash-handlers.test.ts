// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$app/navigation", () => ({
  goto: vi.fn(async () => undefined),
  invalidateAll: vi.fn(async () => undefined),
}));

import { goto } from "$app/navigation";
import { createSlashHandlers, type SlashHandlerDeps } from "./slash-handlers";
import type { SparkActionView } from "@zendev-lab/spark-protocol";

function action(intent: "status.inspect" | "session.inspect" | "queue.inspect"): SparkActionView {
  return {
    id: intent,
    intent,
    label: intent,
    payload: {},
  };
}

function createDeps(openActivityPane: () => void): SlashHandlerDeps {
  return {
    composer: {
      message: "/inspect",
      sendFeedback: "stale",
      renewSubmissionId: vi.fn(),
    } as unknown as SlashHandlerDeps["composer"],
    getSessionsHref: () => "/sessions",
    getStartSlashSuggestions: () => [],
    getSessionSlashSuggestions: () => [],
    isSlashActionEnabled: () => true,
    getLatestRetryPrompt: () => null,
    retryConversationTurn: vi.fn(),
    submitThinkingSelection: vi.fn(async () => undefined),
    submitDirectiveSelection: vi.fn(async () => undefined),
    openActivityPane,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      media: "(max-width: 1200px)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe("session slash activity routing", () => {
  it("routes Fleet as a one-shot directive command turn", async () => {
    const deps = createDeps(() => undefined);
    const handlers = createSlashHandlers(deps);

    await handlers.handleSlashAction(
      {
        id: "run-fleet",
        intent: "directive.run",
        label: "Run /fleet",
        payload: { directive: "fleet" },
      },
      "session",
    );

    expect(deps.composer.message).toBe("");
    expect(deps.submitDirectiveSelection).toHaveBeenCalledWith("fleet");
  });

  it("routes enabled-model settings to the models page", async () => {
    const deps = createDeps(() => undefined);
    const handlers = createSlashHandlers(deps);

    await handlers.handleSlashAction(
      {
        id: "edit-enabled",
        intent: "settings.enabled-models",
        label: "Edit enabled models",
        payload: {},
      },
      "session",
    );

    expect(goto).toHaveBeenCalledWith("/settings/models");
  });

  it.each([
    ["status.inspect", "[data-session-status-bar]"],
    ["session.inspect", "[data-session-inspector-surface]"],
    ["queue.inspect", "[data-session-queue]"],
  ] as const)(
    "opens the responsive activity surface before focusing %s",
    async (intent, selector) => {
      const mobileDetails = document.createElement("details");
      mobileDetails.className = "mobile-details";
      const target = document.createElement("section");
      const attribute = selector.slice(1, -1);
      target.setAttribute(attribute, "");
      target.tabIndex = -1;
      mobileDetails.append(target);
      document.body.append(mobileDetails);

      let activityPaneOpen = false;
      const handlers = createSlashHandlers(
        createDeps(() => {
          activityPaneOpen = true;
        }),
      );

      await handlers.handleSlashAction(action(intent), "session");

      expect(activityPaneOpen).toBe(true);
      expect(mobileDetails.open).toBe(true);
      expect(document.activeElement).toBe(target);
    },
  );
});
