export type CatalogState =
  | "empty"
  | "loading"
  | "streaming"
  | "success"
  | "error"
  | "disabled"
  | "overflow";

export type CatalogFixture = Readonly<{
  id: string;
  group: "conversation" | "workbench";
  title: string;
  description: string;
  states: readonly CatalogState[];
}>;

/**
 * Catalog metadata is the package-local coverage contract. Preview components
 * consume the same fixture ids as browser and accessibility tests.
 */
export const catalogFixtures: readonly CatalogFixture[] = [
  {
    id: "message-shell",
    group: "conversation",
    title: "Message shell",
    description: "Actor identity, status, body, actions, and responsive alignment.",
    states: ["streaming", "success", "error", "overflow"],
  },
  {
    id: "composer",
    group: "conversation",
    title: "Composer",
    description: "Controlled prompt input with consumer-owned attachments and actions.",
    states: ["empty", "loading", "disabled", "error"],
  },
  {
    id: "tool-call",
    group: "workbench",
    title: "Tool call",
    description: "Display-safe tool lifecycle summary with explicit disclosure state.",
    states: ["loading", "streaming", "success", "error", "overflow"],
  },
] as const;
