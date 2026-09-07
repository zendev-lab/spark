<script lang="ts">
  import Icon from "./Icon.svelte";
  import qqLogo from "./assets/qq-logo.png";
  import {
    channelSessionScopeKind,
    type ChannelSessionAdapter,
    type ChannelSessionScope,
  } from "./channel-session";
  import type { IconName } from "./icons";

  let {
    adapter,
    scope,
    label,
    avatarUrl,
  }: {
    adapter: ChannelSessionAdapter;
    scope: ChannelSessionScope;
    label: string;
    avatarUrl?: string;
  } = $props();

  let failedAvatarUrl = $state<string | undefined>();
  let avatar = $derived(avatarUrl && avatarUrl !== failedAvatarUrl ? avatarUrl : undefined);

  let adapterIcon = $derived<IconName>(adapter === "feishu" ? "send" : "waves");
  let scopeKind = $derived(channelSessionScopeKind(adapter, scope));
  let scopeIcon = $derived<IconName>(
    scopeKind === "private"
      ? "user"
      : scopeKind === "group"
        ? "users"
        : scopeKind === "channel"
          ? "hash"
          : "message",
  );
</script>

<span
  class="channel-session-icon {adapter} scope-{scopeKind}"
  role="img"
  aria-label={label}
  title={label}
>
  {#if avatar}
    <img class="bot-avatar" src={avatar} width="22" height="22" alt="" draggable="false" referrerpolicy="no-referrer" onerror={() => failedAvatarUrl = avatarUrl} />
  {:else if adapter === "qqbot"}
    <img src={qqLogo} width="18" height="18" alt="" draggable="false" />
  {:else}
    <Icon name={adapterIcon} size={14} stroke={2.1} />
  {/if}
  <span class="scope-icon" aria-hidden="true">
    <Icon name={scopeIcon} size={10} stroke={2.5} />
  </span>
</span>

<style>
  .channel-session-icon {
    --channel-color: var(--color-primary);
    --scope-color: var(--color-ink-subtle);
    align-items: center;
    background: color-mix(in srgb, var(--channel-color) 11%, var(--color-surface));
    border: 1px solid color-mix(in srgb, var(--channel-color) 18%, var(--color-border-soft));
    border-radius: 6px;
    color: var(--channel-color);
    display: inline-flex;
    flex: 0 0 22px;
    height: 22px;
    justify-content: center;
    position: relative;
    width: 22px;
  }

  .bot-avatar { border-radius: inherit; object-fit: cover; }

  .channel-session-icon.qqbot {
    --channel-color: #1677d2;
  }

  .channel-session-icon.infoflow {
    --channel-color: #4c5ee5;
  }

  .channel-session-icon.feishu {
    --channel-color: #078a67;
  }

  .scope-icon {
    align-items: center;
    background: var(--scope-color);
    border: 0;
    border-radius: 4px;
    bottom: -3px;
    box-shadow: 0 0 0 2px var(--color-surface);
    color: white;
    display: inline-flex;
    height: 14px;
    justify-content: center;
    position: absolute;
    right: -3px;
    width: 14px;
  }

  .scope-private {
    --scope-color: var(--color-info);
  }

  .scope-private .scope-icon {
    border-radius: 999px;
  }

  .scope-group {
    --scope-color: var(--color-purple);
  }

  .scope-channel {
    --scope-color: #0f766e;
  }

  .scope-channel .scope-icon {
    border-radius: 3px;
  }

  @media (forced-colors: active) {
    .scope-icon {
      background: CanvasText;
      box-shadow: 0 0 0 1px Canvas;
      color: Canvas;
      forced-color-adjust: none;
    }
  }
</style>
