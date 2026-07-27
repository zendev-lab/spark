import { Type } from "typebox";
import type { ToolConfig, ToolRenderComponent, ToolRenderTheme } from "@zendev-lab/spark-core";

export type SparkContextAction = "list" | "preview";

export interface SparkContextBundle {
  providerId: string;
  label: string;
  content: string;
  budgetChars: number;
  truncated: boolean;
  empty?: boolean;
  revision?: string;
  priority?: number;
  refs?: string[];
}

export interface SparkContextProvider {
  id: string;
  label: string;
  description: string;
  defaultBudgetChars: number;
  priority?: number;
  render(
    ctx: unknown,
    budgetChars: number,
  ): Promise<
    | Omit<SparkContextBundle, "providerId" | "label" | "budgetChars" | "truncated">
    | string
    | undefined
  >;
}

export interface SparkContextHostApi {
  registerTool(config: ToolConfig): void;
}

export interface SparkContextToolOptions {
  providers?: SparkContextProvider[];
  registry?: SparkContextRegistry;
}

export interface SparkContextProviderSummary {
  id: string;
  label: string;
  description: string;
  defaultBudgetChars: number;
  priority?: number;
}

export interface SparkContextRenderOptions {
  providerIds?: readonly string[];
  budgetChars?: number;
}

export interface SparkContextRegistry {
  list(): SparkContextProviderSummary[];
  render(ctx: unknown, options?: SparkContextRenderOptions): Promise<SparkContextBundle[]>;
}

/** Shared provider registry used by both explicit previews and lifecycle projections. */
export function createSparkContextRegistry(
  contextProviders: readonly SparkContextProvider[] = [],
): SparkContextRegistry {
  const providers = new Map<string, SparkContextProvider>();
  for (const provider of contextProviders) {
    if (providers.has(provider.id)) throw new Error(`duplicate context provider: ${provider.id}`);
    providers.set(provider.id, provider);
  }
  return {
    list: () => [...providers.values()].map((provider) => compactProvider(provider)),
    async render(ctx, options = {}) {
      const selected = selectContextProviders(providers, options.providerIds);
      const bundles = await Promise.all(
        selected.map((provider) =>
          renderSparkContextProvider(
            provider,
            ctx,
            options.budgetChars ?? provider.defaultBudgetChars,
          ),
        ),
      );
      return bundles.filter((bundle): bundle is SparkContextBundle => Boolean(bundle));
    },
  };
}

class ToolCallText implements ToolRenderComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [
      this.text.length > width ? `${this.text.slice(0, Math.max(0, width - 1))}…` : this.text,
    ];
  }
}

export function registerSparkContextTool(
  pi: SparkContextHostApi,
  options: SparkContextToolOptions,
): void {
  const registry = resolveContextRegistry(options);
  pi.registerTool({
    name: "context",
    label: "Context",
    description:
      "Canonical registered context provider tool. List or preview bounded provider output; no freeform prompt injection.",
    promptGuidelines: [
      "Current-round hook snapshots identify their provider and supersede older snapshots; use context preview/list for explicit diagnostics, not routine refetching.",
      "Do not pass arbitrary system prompt text; context content must come from registered providers with budgets.",
      "Use providerIds and budgetChars to keep diagnostic context bounded and explicit.",
    ],
    policy: {
      effect: "read",
      executionMode: "parallel",
      domains: ["context"],
      phases: ["plan", "implement"],
      approval: "none",
    },
    parameters: Type.Object({
      action: Type.String({ description: "list | preview" }),
      providerIds: Type.Optional(
        Type.Array(Type.String({ description: "Provider ids to preview." })),
      ),
      budgetChars: Type.Optional(Type.Number({ description: "Per-provider preview budget." })),
    }),
    renderCall(args, theme) {
      return renderContextCall(args, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = normalizeContextAction(params.action);
      if (action === "list") {
        const rows = registry.list();
        return {
          content: [
            {
              type: "text" as const,
              text: rows.length
                ? rows
                    .map(
                      (provider) =>
                        `- ${provider.id}: ${provider.label} (budget=${provider.defaultBudgetChars})`,
                    )
                    .join("\n")
                : "No context providers registered.",
            },
          ],
          details: { providers: rows },
        };
      }

      const providerIds = normalizeProviderIds(params.providerIds);
      const budgetChars = normalizeBudget(params.budgetChars);
      const visible = await registry.render(ctx, { providerIds, budgetChars });
      return {
        content: [
          {
            type: "text" as const,
            text: visible.length
              ? visible
                  .map((bundle) => `## ${bundle.label} (${bundle.providerId})\n${bundle.content}`)
                  .join("\n\n")
              : "No context content available.",
          },
        ],
        details: { bundles: visible },
      };
    },
  });
}

function compactProvider(provider: SparkContextProvider): SparkContextProviderSummary {
  return {
    id: provider.id,
    label: provider.label,
    description: provider.description,
    defaultBudgetChars: provider.defaultBudgetChars,
    priority: provider.priority,
  };
}

export async function renderSparkContextProvider(
  provider: SparkContextProvider,
  ctx: unknown,
  budgetChars: number,
): Promise<SparkContextBundle | undefined> {
  const rendered = await provider.render(ctx, budgetChars);
  if (!rendered) return undefined;
  const content = typeof rendered === "string" ? rendered : rendered.content;
  const truncatedContent = truncateToBudget(content, budgetChars);
  return {
    providerId: provider.id,
    label: provider.label,
    content: truncatedContent.content,
    budgetChars,
    truncated: truncatedContent.truncated,
    empty: typeof rendered === "string" ? undefined : rendered.empty,
    revision: typeof rendered === "string" ? undefined : rendered.revision,
    priority: provider.priority,
    refs: typeof rendered === "string" ? undefined : rendered.refs,
  };
}

function truncateToBudget(
  content: string,
  budgetChars: number,
): { content: string; truncated: boolean } {
  if (content.length <= budgetChars) return { content, truncated: false };
  return {
    content: `${content.slice(0, Math.max(0, budgetChars - 1)).trimEnd()}…`,
    truncated: true,
  };
}

function resolveContextRegistry(options: SparkContextToolOptions): SparkContextRegistry {
  if (options.registry && options.providers)
    throw new Error("context tool accepts registry or providers, not both");
  return options.registry ?? createSparkContextRegistry(options.providers);
}

function selectContextProviders(
  providers: ReadonlyMap<string, SparkContextProvider>,
  providerIds: readonly string[] | undefined,
): SparkContextProvider[] {
  if (providerIds === undefined) return [...providers.values()];
  return providerIds.map((id) => {
    const provider = providers.get(id);
    if (!provider) throw new Error(`unknown context provider: ${id}`);
    return provider;
  });
}

function normalizeProviderIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("context.providerIds must be an array");
  return value.map((id, index) => {
    if (typeof id !== "string" || !id.trim())
      throw new Error(`context.providerIds[${index}] must be a string`);
    return id;
  });
}

function normalizeContextAction(value: unknown): SparkContextAction {
  if (value === "list" || value === "preview") return value;
  throw new Error("context.action must be list or preview");
}

function normalizeBudget(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("context.budgetChars must be a positive integer");
  }
  return value;
}

function renderContextCall(
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "?";
  const providers = Array.isArray(args.providerIds)
    ? `${args.providerIds.length} provider(s)`
    : undefined;
  const text = ["context", `action=${action}`, providers].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}
