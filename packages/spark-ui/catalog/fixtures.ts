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
  {
    id: "confirmation",
    group: "workbench",
    title: "Confirmation",
    description: "Consumer-owned approval actions with explicit lifecycle state.",
    scenarios: [
      { id: "loading", state: "loading", title: "Requested confirmation" },
      { id: "success", state: "success", title: "Approved confirmation" },
      { id: "error", state: "error", title: "Rejected confirmation" },
      { id: "disabled", state: "disabled", title: "Cancelled confirmation" },
    ],
  },
  {
    id: "plan",
    group: "workbench",
    title: "Plan",
    description: "Structured steps with independent status and optional selection callbacks.",
    scenarios: [
      { id: "empty", state: "empty", title: "No plan steps" },
      { id: "streaming", state: "streaming", title: "Running plan" },
      { id: "success", state: "success", title: "Completed plan" },
      { id: "error", state: "error", title: "Failed plan" },
    ],
  },
  {
    id: "task",
    group: "workbench",
    title: "Task",
    description: "Collapsible task identity, status, details, and action slot.",
    scenarios: [
      { id: "loading", state: "loading", title: "Pending task" },
      { id: "streaming", state: "streaming", title: "Running task" },
      { id: "success", state: "success", title: "Completed task" },
      { id: "error", state: "error", title: "Failed task" },
    ],
  },
  {
    id: "artifact",
    group: "workbench",
    title: "Artifact",
    description: "Explicit artifact identity, status, preview URL, and actions.",
    scenarios: [
      { id: "empty", state: "empty", title: "Artifact without summary" },
      { id: "loading", state: "loading", title: "Running artifact" },
      { id: "success", state: "success", title: "Completed artifact" },
      { id: "error", state: "error", title: "Failed artifact" },
    ],
  },
  {
    id: "code-block",
    group: "workbench",
    title: "Code block",
    description: "Display-only code with line numbers, highlights, and explicit copy callback.",
    scenarios: [
      { id: "success", state: "success", title: "Structured code" },
      { id: "overflow", state: "overflow", title: "Long code line" },
    ],
  },
  {
    id: "diff-view",
    group: "workbench",
    title: "Diff view",
    description: "Structured unified diff lines without parsing or applying patches.",
    scenarios: [
      { id: "empty", state: "empty", title: "Empty diff" },
      { id: "success", state: "success", title: "Structured diff" },
      { id: "overflow", state: "overflow", title: "Wide diff line" },
    ],
  },
  {
    id: "file-tree",
    group: "workbench",
    title: "File tree",
    description: "Flat owner projection with controlled directory and file callbacks.",
    scenarios: [
      { id: "empty", state: "empty", title: "Empty tree" },
      { id: "success", state: "success", title: "Interactive tree" },
      { id: "disabled", state: "disabled", title: "Disabled entry" },
      { id: "overflow", state: "overflow", title: "Deep long path" },
    ],
  },
  {
    id: "terminal",
    group: "workbench",
    title: "Terminal",
    description: "Read-only command and output projection with authoritative status.",
    scenarios: [
      { id: "loading", state: "loading", title: "Pending command" },
      { id: "streaming", state: "streaming", title: "Streaming output" },
      { id: "success", state: "success", title: "Completed command" },
      { id: "error", state: "error", title: "Failed command" },
      { id: "overflow", state: "overflow", title: "Large terminal output" },
    ],
  },
  {
    id: "test-results",
    group: "workbench",
    title: "Test results",
    description: "Structured pass, fail, skip, and running results.",
    scenarios: [
      { id: "empty", state: "empty", title: "No results" },
      { id: "loading", state: "loading", title: "Running tests" },
      { id: "success", state: "success", title: "Passing tests" },
      { id: "error", state: "error", title: "Failing tests" },
      { id: "overflow", state: "overflow", title: "Long test output" },
    ],
  },
  {
    id: "stack-trace",
    group: "workbench",
    title: "Stack trace",
    description: "Display-safe stack frames with optional consumer-owned navigation.",
    scenarios: [
      { id: "empty", state: "empty", title: "No stack frames" },
      { id: "error", state: "error", title: "Structured stack trace" },
      { id: "overflow", state: "overflow", title: "Long stack frame" },
    ],
  },
  {
    id: "schema-view",
    group: "workbench",
    title: "Schema view",
    description: "JSON-safe schema facts rendered as inert code.",
    scenarios: [
      { id: "empty", state: "empty", title: "Empty schema" },
      { id: "success", state: "success", title: "Structured schema" },
      { id: "overflow", state: "overflow", title: "Large schema" },
    ],
  },
  {
    id: "commit",
    group: "workbench",
    title: "Commit",
    description: "Canonical commit metadata with an explicit validated link.",
    scenarios: [
      { id: "success", state: "success", title: "Commit metadata" },
      { id: "overflow", state: "overflow", title: "Long commit metadata" },
    ],
  },
  {
    id: "web-preview",
    group: "workbench",
    title: "Web preview",
    description: "Screenshot and validated link only; no iframe or code execution.",
    scenarios: [
      { id: "empty", state: "empty", title: "Preview placeholder" },
      { id: "success", state: "success", title: "Validated preview link" },
      { id: "overflow", state: "overflow", title: "Long preview metadata" },
    ],
  },
] as const;

export function catalogScenarioKey(fixture: CatalogFixture, scenario: CatalogScenario) {
  return `${fixture.id}:${scenario.id}`;
}

export function catalogFixtureStates(fixture: CatalogFixture): readonly CatalogState[] {
  return [...new Set(fixture.scenarios.map((scenario) => scenario.state))];
}
