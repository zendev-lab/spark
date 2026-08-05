// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SessionAskPanel from "./SessionAskPanel.svelte";
import { getDictionary } from "./i18n";
import type { PendingWorkbenchAsk } from "./pending-ask";

const appMocks = vi.hoisted(() => ({ formSubmits: vi.fn(), invalidates: vi.fn() }));

vi.mock("$app/forms", () => ({
  enhance: (form: HTMLFormElement) => {
    const onSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      appMocks.formSubmits();
    };
    form.addEventListener("submit", onSubmit);
    return { destroy: () => form.removeEventListener("submit", onSubmit) };
  },
}));
vi.mock("$app/navigation", () => ({ invalidateAll: appMocks.invalidates }));

const messages = getDictionary("en").inboxDetail;
const ask: PendingWorkbenchAsk = {
  id: "inbox_preview",
  workspaceId: "ws_preview",
  workspaceSlug: "preview",
  sessionId: "sess_preview",
  title: "Choose a preview",
  prompt: "Pick the best direction or write another one.",
  questions: [
    {
      id: "direction",
      type: "preview",
      prompt: "Which direction?",
      required: true,
      options: [
        {
          value: "compact",
          label: "Compact",
          description: "Keep the change focused.",
          preview: "src/compact.ts\n+export const compact = true;",
        },
      ],
    },
  ],
  detailHref: "/preview/inbox/inbox_preview",
  createdAt: "2026-07-17T00:00:00.000Z",
  pendingCount: 2,
};

let mounted: Record<string, unknown> | undefined;

afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.replaceChildren();
  appMocks.formSubmits.mockClear();
  appMocks.invalidates.mockClear();
});

async function renderPanel() {
  const target = document.createElement("div");
  document.body.append(target);
  mounted = mount(SessionAskPanel, { target, props: { ask, messages } });
  await tick();
  return target;
}

describe("SessionAskPanel", () => {
  it("renders one accessible inline preview question with daemon-owned navigation", async () => {
    const target = await renderPanel();
    const title = target.querySelector<HTMLElement>("#session-ask-title");
    const form = target.querySelector<HTMLFormElement>("form");
    const option = target.querySelector<HTMLInputElement>('input[value="compact"]');
    const detail = target.querySelector<HTMLAnchorElement>(
      'a[href="/preview/inbox/inbox_preview"]',
    );

    expect(title?.textContent).toBe("Choose a preview");
    expect(form?.getAttribute("action")).toBe("/preview/inbox/inbox_preview?/respond");
    expect(form?.method).toBe("post");
    expect(option?.required).toBe(true);
    expect(option?.checked).toBe(false);
    expect(detail).not.toBeNull();
    expect(target.querySelector("dialog")).toBeNull();
    expect(target.querySelector(".pending-count")?.textContent).toBe("2");
    expect(target.querySelector(".option-preview")?.textContent).toContain(
      "export const compact = true",
    );
  });

  it("selects the preview answer and submits through the enhanced inline form", async () => {
    const target = await renderPanel();
    const form = target.querySelector<HTMLFormElement>("form");
    const option = target.querySelector<HTMLInputElement>('input[value="compact"]');
    if (!form || !option) throw new Error("Expected ask form controls");

    option.click();
    await tick();
    expect(option.checked).toBe(true);
    form.requestSubmit();
    expect(appMocks.formSubmits).toHaveBeenCalledOnce();
  });
});
