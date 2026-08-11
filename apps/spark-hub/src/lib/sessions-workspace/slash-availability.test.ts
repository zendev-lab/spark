import { describe, expect, it } from "vitest";

import type { SparkActionView } from "@zendev-lab/spark-protocol";
import { slashActionAvailability, type SlashAvailabilityContext } from "./slash-availability";

const fleetAction: SparkActionView = {
  id: "enter-fleet",
  label: "Enter Fleet",
  intent: "mode.select",
  payload: { mode: "fleet" },
};

function context(
  surface: "start" | "session",
  hasSelectedSession: boolean,
): SlashAvailabilityContext {
  return {
    surface,
    hasSelectedSession,
    canAssign: true,
    sessionsCount: 1,
    hasActiveWorkspace: true,
    modelProvidersCount: 1,
    modelState: "idle",
    thinkingState: "idle",
    queueItemCount: 0,
    conversationBusy: false,
    hasActiveTurn: false,
    cancelState: "idle",
    hasRetryPrompt: false,
    modelReady: true,
    retryState: "idle",
    reasons: {
      ownerOffline: "offline",
      noModel: "no model",
      modelUpdating: "model updating",
      thinkingUpdating: "thinking updating",
      sessionRequired: "session required",
      noSessions: "no sessions",
      workspaceRequired: "workspace required",
      queueEmpty: "queue empty",
      noActiveTurn: "no active turn",
      retryUnavailable: "retry unavailable",
      retryInProgress: "retry in progress",
      hotkeysUnavailable: "hotkeys unavailable",
      daemonExecutorUnavailable: "executor unavailable",
    },
  };
}

describe("Hub Fleet slash availability", () => {
  it("requires an existing selected Session", () => {
    expect(slashActionAvailability(fleetAction, context("start", false))).toEqual({
      enabled: false,
      reason: "session required",
    });
    expect(slashActionAvailability(fleetAction, context("session", true))).toEqual({
      enabled: true,
    });
  });
});
