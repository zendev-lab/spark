<script lang="ts">
  import type { Snippet } from "svelte";
  import { OperationsShell } from "@zendev-lab/spark-ui";

  import type { AppMessages } from "$lib/i18n";
  import HubTopbar from "./HubTopbar.svelte";
  import type { HubDaemonSummary, HubSearchSession, HubSearchWorkspace } from "./hub-search";
  import "./shell-nav-link.css";

  type ContentMode = "padded" | "flush";
  type NavigationSize = "default" | "compact";

  interface Props {
    activeWorkspace?: HubSearchWorkspace | null;
    canManageDaemonAccess?: boolean;
    children: Snippet;
    closeNavigationLabel: string;
    common: AppMessages["common"];
    daemons?: HubDaemonSummary[];
    contentMode?: ContentMode;
    contextBar?: Snippet;
    layout: AppMessages["layout"];
    navigation: Snippet<[closeNavigation: () => void]>;
    navigationAriaLabel: string;
    navigationId: string;
    navigationSize?: NavigationSize;
    pathname: string;
    sessions?: HubSearchSession[];
    sessionMessages: AppMessages["sessions"];
    showNavigation?: boolean;
    showNavigationToggle?: boolean;
    showDaemonMenu?: boolean;
    workspaces?: HubSearchWorkspace[];
  }

  let {
    activeWorkspace = null,
    canManageDaemonAccess = false,
    children,
    closeNavigationLabel,
    common,
    daemons = [],
    contentMode = "padded",
    contextBar,
    layout,
    navigation,
    navigationAriaLabel,
    navigationId,
    navigationSize = "default",
    pathname,
    sessions = [],
    sessionMessages,
    showNavigation = true,
    showNavigationToggle = true,
    showDaemonMenu = true,
    workspaces = [],
  }: Props = $props();
</script>

{#snippet shellHeader(navigationExpanded: boolean, toggleNavigation: () => void)}
  <HubTopbar
    {activeWorkspace}
    {canManageDaemonAccess}
    {common}
    {daemons}
    {layout}
    navigationControls={navigationId}
    {navigationExpanded}
    onToggleNavigation={toggleNavigation}
    {sessions}
    {sessionMessages}
    showNavigationToggle={showNavigation && showNavigationToggle}
    {showDaemonMenu}
    {workspaces}
  />
{/snippet}

{#snippet skipLink()}
  <a class="skip-link" href="#hub-main-content">{layout.aria.skipToContent}</a>
{/snippet}

<OperationsShell
  header={shellHeader}
  {navigation}
  {navigationAriaLabel}
  {navigationId}
  {closeNavigationLabel}
  {contextBar}
  {showNavigation}
  {navigationSize}
  {contentMode}
  mainId="hub-main-content"
  navigationKey={pathname}
  designDirection="focus-pulse-5a7f18fc"
  {skipLink}
>
  {@render children()}
</OperationsShell>

<style>
  .skip-link {
    background: var(--color-primary);
    border-radius: var(--rounded-sm);
    clip-path: inset(50%);
    color: var(--color-on-primary);
    font-size: 13px;
    font-weight: 700;
    height: 1px;
    left: var(--spacing-md);
    overflow: hidden;
    padding: 0;
    position: absolute;
    text-decoration: none;
    top: var(--spacing-sm);
    white-space: nowrap;
    width: 1px;
    z-index: 200;
  }

  .skip-link:focus-visible {
    clip-path: none;
    height: auto;
    overflow: visible;
    padding: 8px 12px;
    width: auto;
  }
</style>
