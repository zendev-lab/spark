export type CatalogState =
  | "empty"
  | "loading"
  | "streaming"
  | "success"
  | "error"
  | "disabled"
  | "overflow";

export type CatalogScenario = Readonly<{
  id: string;
  state: CatalogState;
  title: string;
}>;

export type CatalogFixture = Readonly<{
  id: string;
  group: "conversation" | "workbench";
  title: string;
  description: string;
  scenarios: readonly CatalogScenario[];
}>;

/**
 * Every declared scenario is rendered by the catalog and exercised by the
 * package-local SSR, browser, accessibility, and visual tests.
 */
export const catalogFixtures: readonly CatalogFixture[] = [
  {
    id: "message-shell",
    group: "conversation",
    title: "Message shell",
    description: "Actor identity, status, body, actions, and responsive alignment.",
    scenarios: [
      { id: "streaming", state: "streaming", title: "Streaming response" },
      { id: "success", state: "success", title: "Completed response" },
      { id: "error", state: "error", title: "Failed response" },
      { id: "overflow", state: "overflow", title: "Long unbroken content" },
    ],
  },
  {
    id: "composer",
    group: "conversation",
    title: "Composer",
    description: "Controlled prompt input with consumer-owned attachments and actions.",
    scenarios: [
      { id: "empty", state: "empty", title: "Empty prompt" },
      { id: "loading", state: "loading", title: "Submitting prompt" },
      { id: "disabled", state: "disabled", title: "Unavailable prompt" },
      { id: "error", state: "error", title: "Submission error" },
    ],
  },
  {
    id: "tool-call",
    group: "workbench",
    title: "Tool call",
    description: "Display-safe tool lifecycle summary with explicit disclosure state.",
    scenarios: [
      { id: "loading", state: "loading", title: "Pending call" },
      { id: "streaming", state: "streaming", title: "Running call" },
      { id: "success", state: "success", title: "Completed call" },
      { id: "error", state: "error", title: "Failed call" },
      { id: "overflow", state: "overflow", title: "Large result summary" },
    ],
  },
] as const;

export function catalogScenarioKey(fixture: CatalogFixture, scenario: CatalogScenario) {
  return `${fixture.id}:${scenario.id}`;
}

export function catalogFixtureStates(fixture: CatalogFixture): readonly CatalogState[] {
  return [...new Set(fixture.scenarios.map((scenario) => scenario.state))];
}
