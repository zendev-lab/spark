import { getHubDictionary } from "@zendev-lab/spark-i18n/hub";
import { sparkSlashActionBarForInput } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";
import {
  hubComposerFeedbackAfterInput,
  hubOpenSearchEvent,
  hubSessionSelectionShortcutForInput,
  hubSlashCatalogActionBarForInput,
  hubSlashSuggestionsForInput,
  hubSlashSubmissionError,
  localizeHubSlashActionBar,
  scheduleHubActionAfterCurrentEvent,
} from "./slash-actions";

describe("Hub slash action presentation", () => {
  it("clears stale composer feedback without disturbing an active submission", () => {
    expect(hubComposerFeedbackAfterInput("error")).toEqual({
      state: "idle",
      clearFeedback: true,
    });
    expect(hubComposerFeedbackAfterInput("success")).toEqual({
      state: "idle",
      clearFeedback: true,
    });
    expect(hubComposerFeedbackAfterInput("idle")).toEqual({
      state: "idle",
      clearFeedback: true,
    });
    expect(hubComposerFeedbackAfterInput("submitting")).toEqual({
      state: "submitting",
      clearFeedback: false,
    });
  });

  it("defers dialog actions until the selecting click has completed", () => {
    const scheduled: Array<() => void> = [];
    let open = false;

    scheduleHubActionAfterCurrentEvent(
      () => {
        open = true;
      },
      (callback) => scheduled.push(callback),
    );

    expect(open).toBe(false);
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(open).toBe(true);
  });

  it("localizes protocol presentation copy without changing semantic intents", () => {
    const source = sparkSlashActionBarForInput("/model");
    if (!source) throw new Error("Missing model action bar");

    const localized = localizeHubSlashActionBar(
      source,
      getHubDictionary("zh-CN").sessions.workbench.slashActions,
    );

    expect(localized).toMatchObject({
      id: "model",
      title: "模型控制",
      description: "选择当前模型，或查看已配置的模型服务商。",
      actions: expect.arrayContaining([
        expect.objectContaining({
          id: "select-model",
          label: "选择模型",
          intent: "model.select",
        }),
        expect.objectContaining({
          id: "choose-thinking",
          label: "推理强度",
          intent: "thinking.select",
        }),
      ]),
    });
  });

  it("presents localized slash completions without duplicating aliases", () => {
    const messages = getHubDictionary("zh-CN").sessions.workbench.slashActions;
    const initial = hubSlashSuggestionsForInput("/", messages);

    expect(initial.map((suggestion) => suggestion.command)).toContain("session");
    expect(initial.map((suggestion) => suggestion.command)).toContain("workflow");
    expect(initial.map((suggestion) => suggestion.command)).not.toContain("sessions");
    expect(initial.map((suggestion) => suggestion.command)).not.toContain("workflow-runs");
    expect(initial.find((suggestion) => suggestion.command === "model")).toMatchObject({
      canonicalCommand: "model",
      title: "模型控制",
      description: "选择当前模型，或查看已配置的模型服务商。",
    });

    expect(hubSlashSuggestionsForInput("/res", messages)).toEqual([
      expect.objectContaining({
        command: "resume",
        canonicalCommand: "session",
        title: "会话控制",
      }),
    ]);
    expect(hubSlashSuggestionsForInput("/sessions", messages)).toEqual([]);
    expect(hubSlashSuggestionsForInput("/workflow-", messages)).toEqual([]);
    expect(hubSlashSuggestionsForInput("//sessions", messages)).toEqual([]);
    expect(sparkSlashActionBarForInput("/workflow-runs")?.id).toBe("workflow");
  });

  it("routes only the explicit session picker commands directly on Enter", () => {
    for (const input of ["/session", "/sessions", " /SESSION ", " /SESSIONS "]) {
      expect(hubSessionSelectionShortcutForInput(input)).toBe(true);
    }

    for (const input of [
      "/session inspect",
      "/sessions current",
      "/resume",
      "/new",
      "//sessions",
      "open /sessions",
    ]) {
      expect(hubSessionSelectionShortcutForInput(input)).toBe(false);
    }
  });

  it("recognizes catalog commands with arguments for the submission guard", () => {
    expect(hubSlashCatalogActionBarForInput("/model baidu-oneapi/gpt-5.6-sol")?.id).toBe("model");
    expect(hubSlashCatalogActionBarForInput("/goal restart")?.id).toBe("goal");
    expect(hubSlashCatalogActionBarForInput("/not-a-spark-command value")).toBeUndefined();
  });

  it("returns a localized server fallback and a stable search event", () => {
    const messages = getHubDictionary("zh-CN").sessions.workbench.slashActions;

    expect(hubSlashSubmissionError("/help anything", messages)).toBe(
      "请使用输入框上方的“Spark 帮助”操作栏；这条 slash 命令没有发送给模型。",
    );
    for (const input of ["/clear", "/compact", "/new", "/runs now"]) {
      expect(hubSlashSubmissionError(input, messages)).toContain("没有发送给模型");
    }
    expect(hubSlashSubmissionError("/definitely-not-a-spark-command", messages)).toContain(
      "尚不识别或不支持",
    );
    expect(hubSlashSubmissionError("//clear", messages)).toBeNull();
    expect(hubOpenSearchEvent).toBe("spark-hub:open-search");
  });
});
