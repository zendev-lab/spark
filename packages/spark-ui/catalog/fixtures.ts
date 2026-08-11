export type CatalogState =
  | "empty"
  | "loading"
  | "recording"
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
    description: "Actor, status, body, actions, and responsive layout.",
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
    id: "attachments",
    group: "conversation",
    title: "Attachments and media",
    description: "Explicit preview URLs and consumer-owned removal callbacks.",
    scenarios: [
      { id: "empty", state: "empty", title: "No attachments" },
      { id: "success", state: "success", title: "Selected attachments" },
      { id: "overflow", state: "overflow", title: "Overflowing file name" },
    ],
  },
  {
    id: "message-controls",
    group: "conversation",
    title: "Message controls",
    description: "Controlled branch, edit, retry, feedback, download, and share surfaces.",
    scenarios: [
      { id: "success", state: "success", title: "Available actions" },
      { id: "disabled", state: "disabled", title: "Unavailable actions" },
    ],
  },
  {
    id: "sources",
    group: "conversation",
    title: "Sources and citations",
    description: "Structured source views without parsing links from rendered Markdown.",
    scenarios: [
      { id: "empty", state: "empty", title: "No sources" },
      { id: "success", state: "success", title: "Structured sources" },
      { id: "overflow", state: "overflow", title: "Long source metadata" },
    ],
  },
  {
    id: "prompt-controls",
    group: "conversation",
    title: "Prompt controls",
    description: "Suggestions, context usage, and controlled speech state.",
    scenarios: [
      { id: "empty", state: "empty", title: "No suggestions" },
      { id: "recording", state: "recording", title: "Recording speech" },
      { id: "loading", state: "loading", title: "Processing speech" },
      { id: "disabled", state: "disabled", title: "Disabled controls" },
    ],
  },
  {
    id: "model-selector",
    group: "conversation",
    title: "Model selector",
    description: "Searchable, protocol-neutral model groups with consumer-owned commits.",
    scenarios: [
      { id: "empty", state: "empty", title: "No selected model" },
      { id: "success", state: "success", title: "Selected model" },
      { id: "disabled", state: "disabled", title: "Unavailable selector" },
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
