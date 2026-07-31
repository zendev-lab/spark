import type { SparkNativeCockpitPanel } from "./types.ts";

export interface SparkTerminalViewState {
  readonly focused: boolean;
  readonly toolsExpanded: boolean;
  readonly thinkingExpanded: boolean;
  readonly activeCockpitPanel?: SparkNativeCockpitPanel;
  readonly transcriptScrollOffset: number;
}

export type SparkTerminalIntent =
  | { readonly type: "focus.set"; readonly focused: boolean }
  | { readonly type: "tools.toggle" }
  | { readonly type: "thinking.toggle" }
  | { readonly type: "cockpit.toggle"; readonly panel: SparkNativeCockpitPanel }
  | { readonly type: "cockpit.open"; readonly panel: SparkNativeCockpitPanel }
  | { readonly type: "cockpit.close" }
  | {
      readonly type: "cockpit.cycle";
      readonly panels: readonly SparkNativeCockpitPanel[];
    }
  | { readonly type: "transcript.scroll"; readonly delta: number }
  | { readonly type: "transcript.tail" };

const INITIAL_SPARK_TERMINAL_VIEW_STATE: SparkTerminalViewState = Object.freeze({
  focused: false,
  toolsExpanded: false,
  thinkingExpanded: false,
  transcriptScrollOffset: 0,
});

/**
 * Renderer-neutral terminal interaction state. It owns presentation state
 * only; daemon/session execution truth remains behind their existing ports.
 */
export class SparkTerminalController {
  #state: SparkTerminalViewState = INITIAL_SPARK_TERMINAL_VIEW_STATE;

  get viewState(): SparkTerminalViewState {
    return this.#state;
  }

  dispatch(intent: SparkTerminalIntent): SparkTerminalViewState {
    const current = this.#state;
    switch (intent.type) {
      case "focus.set":
        this.#state = nextState(current, { focused: intent.focused });
        break;
      case "tools.toggle":
        this.#state = nextState(current, { toolsExpanded: !current.toolsExpanded });
        break;
      case "thinking.toggle":
        this.#state = nextState(current, { thinkingExpanded: !current.thinkingExpanded });
        break;
      case "cockpit.toggle":
        this.#state = nextState(current, {
          activeCockpitPanel:
            current.activeCockpitPanel === intent.panel ? undefined : intent.panel,
        });
        break;
      case "cockpit.open":
        this.#state = nextState(current, { activeCockpitPanel: intent.panel });
        break;
      case "cockpit.close":
        this.#state = nextState(current, { activeCockpitPanel: undefined });
        break;
      case "cockpit.cycle": {
        if (intent.panels.length === 0) break;
        const currentPanel = current.activeCockpitPanel ?? intent.panels[0];
        const index = currentPanel ? intent.panels.indexOf(currentPanel) : -1;
        const activeCockpitPanel = intent.panels[(Math.max(index, 0) + 1) % intent.panels.length];
        this.#state = nextState(current, { activeCockpitPanel });
        break;
      }
      case "transcript.scroll":
        this.#state = nextState(current, {
          transcriptScrollOffset: Math.max(0, current.transcriptScrollOffset + intent.delta),
        });
        break;
      case "transcript.tail":
        this.#state = nextState(current, { transcriptScrollOffset: 0 });
        break;
    }
    return this.#state;
  }
}

function nextState(
  current: SparkTerminalViewState,
  patch: Partial<SparkTerminalViewState>,
): SparkTerminalViewState {
  const next = { ...current, ...patch };
  if (next.activeCockpitPanel === undefined) delete next.activeCockpitPanel;
  return Object.freeze(next);
}
