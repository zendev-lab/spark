<script lang="ts">
  import { goto } from "$app/navigation";
  import { parseSparkModelValue, sparkThinkingLevelOptions } from "@zendev-lab/spark-protocol";
  import {
    Button,
    Checkbox,
    Dialog,
    Field,
    Input,
    Notice,
    PageHeader,
    PageLayout,
    Panel,
    Select,
    StatusPill,
    Textarea,
    type SelectGroup,
  } from "@zendev-lab/spark-ui";
  import { DialogClose, DialogTitle } from "@zendev-lab/spark-ui/headless";
  import { SafeMarkdown } from "@zendev-lab/spark-ui/markdown";
  import { Artifact } from "@zendev-lab/spark-ui/workbench";
  import {
    ordinarySessionsForWorkspace,
    workspaceAdministratorSessionId,
    type SparkWebSession,
  } from "$lib/daemon-surface";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let copy = $derived(data.messages.web.workspace);
  let creating = $state(false);
  let showCreate = $state(false);
  let createError = $state("");
  let createdSessionId = $state<string | null>(null);
  let sessionName = $state("");
  let roleRef = $state("role:builtin-executor");
  let modelValue = $state("");
  let thinkingLevel = $state<"off" | "minimal" | "low" | "medium" | "high" | "xhigh">("high");
  let cwdArtifactRef = $state("");
  let cwdRelativePath = $state("");
  let directoryOpen = $state(false);
  let directoryLoading = $state(false);
  let directoryError = $state("");
  let directoryReturnFocus: HTMLElement | null = null;
  let directoryRequestToken = 0;
  let directoryView = $state<{
    cwdArtifactRef?: string;
    current: { relativePath: string };
    entries: Array<{
      ref: string;
      name: string;
      relativePath: string;
      kind: "directory" | "file" | "symlink";
      selectable: boolean;
      blockedReason?: string;
    }>;
  } | null>(null);
  let roleId = $state("");
  let roleDescription = $state("");
  let rolePrompt = $state("");
  let roleModelType = $state("custom");
  let selectedRoleSkills = $state<string[]>([]);
  let roleCreating = $state(false);
  let roleStatus = $state("");
  let roleModelEntriesOverride = $state<typeof data.roleModelSettings.entries | null>(null);
  let roleModelEntries = $derived(roleModelEntriesOverride ?? data.roleModelSettings.entries);
  let roleModelSource = $state<Record<string, "project" | "user">>({});
  let roleModelSelection = $state<Record<string, string>>({});
  let roleModelBusy = $state("");
  let roleModelStatus = $state("");
  let artifactContent = $state<{ ref: string; title: string; format: string; content: string } | null>(null);
  let artifactError = $state("");
  let artifactLoading = $state(false);
  let sessionCreateToken = 0;
  let roleCreateToken = 0;
  let roleModelRequestToken = 0;
  let artifactRequestToken = 0;
  const sessions = $derived(
    ordinarySessionsForWorkspace(data.sessions as SparkWebSession[], data.workspace.id),
  );
  let roleGroups = $derived<SelectGroup[]>([
    {
      id: "roles",
      options: data.roleCatalog.roles.map((role) => ({
        value: role.ref,
        label: `${role.id} · ${role.source}`,
      })),
    },
  ]);
  let modelGroups = $derived<SelectGroup[]>([
    {
      id: "models",
      options: [
        { value: "", label: copy.inheritDefault },
        ...data.modelCatalog.providers.flatMap((provider) =>
          provider.models.map((entry) => ({
            value: `${entry.model.providerName}/${entry.model.modelId}`,
            label: `${entry.model.modelLabel ?? entry.model.modelId} · ${provider.label}`,
            disabled: !entry.available,
          })),
        ),
      ],
    },
  ]);
  let roleModelGroups = $derived<SelectGroup[]>([
    {
      id: "role-models",
      options: [
        { value: "", label: copy.noModelSetting },
        ...modelGroups[0]!.options.filter((option) => option.value),
      ],
    },
  ]);
  let thinkingGroups = $derived.by((): SelectGroup[] => {
    const labels = data.messages.shared.workbench.slashActions.actions as Record<string, string>;
    return [
      {
        id: "thinking-levels",
        options: sparkThinkingLevelOptions.map((level) => ({
          value: level,
          label: labels[`thinking-${level}`] ?? level,
        })),
      },
    ];
  });
  let cwdGroups = $derived<SelectGroup[]>([
    {
      id: "working-directories",
      options: [
        { value: "", label: copy.workspaceDefault },
        ...data.artifactCatalog.artifacts
          .filter((artifact) => artifact.kind === "git_change")
          .map((artifact) => ({
            value: artifact.ref,
            label: `${artifact.title} · ${copy.owningWorktree}`,
          })),
      ],
    },
  ]);
  let sourceGroups = $derived<SelectGroup[]>([
    {
      id: "model-source",
      options: [
        { value: "project", label: copy.project },
        { value: "user", label: copy.user },
      ],
    },
  ]);

  $effect(() => {
    data.workspace.id;
    sessionCreateToken += 1;
    roleCreateToken += 1;
    roleModelRequestToken += 1;
    artifactRequestToken += 1;
    directoryRequestToken += 1;
    creating = false;
    showCreate = false;
    createError = "";
    createdSessionId = null;
    sessionName = "";
    roleRef = "role:builtin-executor";
    modelValue = "";
    thinkingLevel = "high";
    cwdArtifactRef = "";
    cwdRelativePath = "";
    directoryOpen = false;
    directoryLoading = false;
    directoryError = "";
    directoryView = null;
    roleId = "";
    roleDescription = "";
    rolePrompt = "";
    roleModelType = "custom";
    selectedRoleSkills = [];
    roleCreating = false;
    roleStatus = "";
    roleModelEntriesOverride = null;
    roleModelSource = {};
    roleModelSelection = {};
    roleModelBusy = "";
    roleModelStatus = "";
    artifactContent = null;
    artifactError = "";
    artifactLoading = false;
  });

  async function createSession() {
    const ownerWorkspaceId = data.workspace.id;
    const requestToken = ++sessionCreateToken;
    const ownsPage = () =>
      requestToken === sessionCreateToken && data.workspace.id === ownerWorkspaceId;
    const supervisorSessionId = workspaceAdministratorSessionId(
      data.sessions as SparkWebSession[],
      ownerWorkspaceId,
    );
    if (!supervisorSessionId) {
      createError = copy.missingAdministrator;
      return;
    }
    let requestedModel: ReturnType<typeof parseSparkModelValue> | undefined;
    try {
      requestedModel = modelValue ? parseSparkModelValue(modelValue) : undefined;
    } catch {
      if (ownsPage()) createError = copy.validModelRequired;
      return;
    }
    const requestedName = sessionName.trim();
    const requestedRoleRef = roleRef;
    const requestedCwdArtifactRef = cwdArtifactRef;
    const requestedCwdRelativePath = cwdRelativePath;
    const requestedThinkingLevel = thinkingLevel;
    creating = true;
    createError = "";
    createdSessionId = null;
    let created: { sessionId: string };
    try {
      created = await webRpc("session.create", {
        scope: { kind: "workspace", workspaceId: ownerWorkspaceId },
        supervisorSessionId,
        placement: "child",
        roleBinding: { kind: "explicit", roleRef: requestedRoleRef },
        ...(requestedName ? { name: requestedName } : {}),
        ...(requestedCwdRelativePath ? { cwd: requestedCwdRelativePath } : {}),
        ...(requestedCwdArtifactRef ? { cwdArtifactRef: requestedCwdArtifactRef } : {}),
      });
    } catch (caught) {
      if (ownsPage()) {
        createError = caught instanceof Error ? caught.message : String(caught);
        creating = false;
      }
      return;
    }

    if (ownsPage()) createdSessionId = created.sessionId;
    try {
      if (requestedModel) {
        await webRpc("session.model.set", {
          sessionId: created.sessionId,
          model: requestedModel,
        });
      }
      await webRpc("session.thinking.set", {
        sessionId: created.sessionId,
        thinkingLevel: requestedThinkingLevel,
      });
    } catch (caught) {
      if (ownsPage()) {
        const message = caught instanceof Error ? caught.message : String(caught);
        createError = `${copy.sessionLabel} ${created.sessionId} ${copy.createdButConfigurationFailed}: ${message}`;
        creating = false;
      }
      return;
    }

    if (!ownsPage()) return;
    try {
      await goto(`/sessions/${created.sessionId}`);
    } catch (caught) {
      if (ownsPage()) {
        const message = caught instanceof Error ? caught.message : String(caught);
        createError = `${copy.sessionLabel} ${created.sessionId} ${copy.readyButNavigationFailed}: ${message}`;
        creating = false;
      }
    }
  }

  async function browseDirectory(relativePath = "") {
    if (directoryLoading) return;
    const ownerWorkspaceId = data.workspace.id;
    const ownerArtifactRef = cwdArtifactRef;
    const requestToken = ++directoryRequestToken;
    directoryLoading = true;
    directoryError = "";
    if (!directoryOpen && globalThis.document?.activeElement instanceof HTMLElement) {
      directoryReturnFocus = globalThis.document.activeElement;
    }
    try {
      const view = await webRpc("workspace.directory.list", {
        workspaceId: ownerWorkspaceId,
        ...(ownerArtifactRef ? { cwdArtifactRef: ownerArtifactRef } : {}),
        relativePath,
        limit: 300,
      });
      if (
        requestToken !== directoryRequestToken ||
        data.workspace.id !== ownerWorkspaceId
      ) {
        return;
      }
      directoryView = view;
      directoryOpen = true;
    } catch (caught) {
      if (
        requestToken !== directoryRequestToken ||
        data.workspace.id !== ownerWorkspaceId
      ) {
        return;
      }
      directoryError = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (
        requestToken === directoryRequestToken &&
        data.workspace.id === ownerWorkspaceId
      ) {
        directoryLoading = false;
      }
    }
  }

  function closeDirectory() {
    directoryOpen = false;
  }

  function restoreDirectoryFocus(open: boolean) {
    if (!open) requestAnimationFrame(() => directoryReturnFocus?.focus());
  }

  function toggleRoleSkill(skill: string, checked: boolean) {
    selectedRoleSkills = checked
      ? [...selectedRoleSkills, skill]
      : selectedRoleSkills.filter((candidate) => candidate !== skill);
  }

  function controlId(prefix: string, value: string) {
    return `${prefix}-${value.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
  }

  function parentDirectory(path: string): string {
    const segments = path.split("/").filter(Boolean);
    segments.pop();
    return segments.join("/");
  }

  async function createRole() {
    if (!roleId.trim() || !roleDescription.trim() || !rolePrompt.trim() || roleCreating) return;
    const ownerWorkspaceId = data.workspace.id;
    const requestToken = ++roleCreateToken;
    roleCreating = true;
    roleStatus = "";
    try {
      const result = await webRpc("role.create", {
        workspaceId: ownerWorkspaceId,
        id: roleId.trim(),
        description: roleDescription.trim(),
        systemPrompt: rolePrompt.trim(),
        capabilities: [],
        ...(selectedRoleSkills.length > 0 ? { skills: selectedRoleSkills } : {}),
        modelType: roleModelType.trim() || "custom",
      });
      if (requestToken !== roleCreateToken || data.workspace.id !== ownerWorkspaceId) return;
      roleStatus = result.created
        ? `Created ${result.role.ref}. Reload this page to select it.`
        : `Role name already exists as ${result.role.ref}; no file was changed.`;
    } catch (caught) {
      if (requestToken !== roleCreateToken || data.workspace.id !== ownerWorkspaceId) return;
      roleStatus = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (requestToken === roleCreateToken && data.workspace.id === ownerWorkspaceId) {
        roleCreating = false;
      }
    }
  }

  async function openArtifact(artifactRef: string) {
    const ownerWorkspaceId = data.workspace.id;
    const artifact = data.artifactCatalog.artifacts.find((entry) => entry.ref === artifactRef);
    if (!artifact || artifactLoading) return;
    const requestToken = ++artifactRequestToken;
    artifactLoading = true;
    artifactError = "";
    artifactContent = null;
    try {
      const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(ownerWorkspaceId)}/artifacts/${encodeURIComponent(artifactRef)}`);
      if (!response.ok) throw new Error(`Artifact preview failed: ${response.status}`);
      const content = await response.text();
      if (
        requestToken !== artifactRequestToken ||
        data.workspace.id !== ownerWorkspaceId
      ) {
        return;
      }
      artifactContent = {
        ref: artifact.ref,
        title: artifact.title,
        format: artifact.format,
        content,
      };
    } catch (caught) {
      if (
        requestToken !== artifactRequestToken ||
        data.workspace.id !== ownerWorkspaceId
      ) {
        return;
      }
      artifactError = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (requestToken === artifactRequestToken && data.workspace.id === ownerWorkspaceId) {
        artifactLoading = false;
      }
    }
  }

  function modelSetting(modelType: string, source: "project" | "user") {
    return roleModelEntries.find(
      (entry) => entry.modelType === modelType && entry.source === source,
    );
  }

  function ownsRoleModelRequest(ownerWorkspaceId: string, requestToken: number) {
    return data.workspace.id === ownerWorkspaceId && roleModelRequestToken === requestToken;
  }

  async function inspectRoleModel(roleRef: string) {
    if (roleModelBusy) return;
    const ownerWorkspaceId = data.workspace.id;
    const requestToken = ++roleModelRequestToken;
    roleModelBusy = roleRef;
    roleModelStatus = "";
    try {
      const result = await webRpc("role.model.get", {
        workspaceId: ownerWorkspaceId,
        roleRef,
      });
      if (!ownsRoleModelRequest(ownerWorkspaceId, requestToken)) return;
      roleModelStatus = result.setting
        ? `${result.role?.id ?? roleRef}: ${result.setting.model} · ${result.setting.source}`
        : `${result.role?.id ?? roleRef}: ${copy.noModelSetting}`;
    } catch (caught) {
      if (!ownsRoleModelRequest(ownerWorkspaceId, requestToken)) return;
      roleModelStatus = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (ownsRoleModelRequest(ownerWorkspaceId, requestToken)) roleModelBusy = "";
    }
  }

  async function saveRoleModel(roleRef: string) {
    const model = roleModelSelection[roleRef];
    if (!model || roleModelBusy) return;
    const ownerWorkspaceId = data.workspace.id;
    const requestToken = ++roleModelRequestToken;
    const source = roleModelSource[roleRef] ?? "project";
    roleModelBusy = roleRef;
    roleModelStatus = "";
    try {
      const result = await webRpc("role.model.set", {
        workspaceId: ownerWorkspaceId,
        roleRef,
        model,
        source,
      });
      if (!ownsRoleModelRequest(ownerWorkspaceId, requestToken)) return;
      roleModelEntriesOverride = [
        ...roleModelEntries.filter(
          (entry) =>
            entry.modelType !== result.setting.modelType || entry.source !== result.setting.source,
        ),
        result.setting,
      ];
      roleModelStatus = `${result.role.id}: ${result.setting.model} · ${result.setting.source}`;
    } catch (caught) {
      if (!ownsRoleModelRequest(ownerWorkspaceId, requestToken)) return;
      roleModelStatus = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (ownsRoleModelRequest(ownerWorkspaceId, requestToken)) roleModelBusy = "";
    }
  }

  async function deleteRoleModel(roleRef: string) {
    if (roleModelBusy) return;
    const ownerWorkspaceId = data.workspace.id;
    const requestToken = ++roleModelRequestToken;
    const source = roleModelSource[roleRef] ?? "project";
    roleModelBusy = roleRef;
    roleModelStatus = "";
    try {
      const result = await webRpc("role.model.delete", {
        workspaceId: ownerWorkspaceId,
        roleRef,
        source,
      });
      if (!ownsRoleModelRequest(ownerWorkspaceId, requestToken)) return;
      if (result.deleted) {
        roleModelEntriesOverride = roleModelEntries.filter(
          (entry) => entry.modelType !== result.role.modelType || entry.source !== source,
        );
      }
      roleModelStatus = `${result.role.id}: ${result.deleted ? copy.deleteModel : copy.noModelSetting}`;
    } catch (caught) {
      if (!ownsRoleModelRequest(ownerWorkspaceId, requestToken)) return;
      roleModelStatus = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (ownsRoleModelRequest(ownerWorkspaceId, requestToken)) roleModelBusy = "";
    }
  }
</script>

{#snippet artifactActions(view: { id: string })}
  <Button variant="secondary" size="compact" onclick={() => void openArtifact(view.id)} disabled={artifactLoading}>{copy.preview}</Button>
{/snippet}

{#snippet pageActions()}
  <Button onclick={() => (showCreate = !showCreate)} disabled={creating}>
      {showCreate ? copy.hideSessionForm : copy.newSession}
  </Button>
{/snippet}

<PageLayout width="wide">
  <p class="crumb"><a href="/">← {data.messages.web.shell.workspaces}</a></p>
  <PageHeader title={data.workspace.displayName} lede={data.workspace.localPath} actions={pageActions} />
  {#if showCreate}
    <Panel title={copy.context} compact>
      <form class="session-create" onsubmit={(event) => { event.preventDefault(); void createSession(); }}>
        <Field id="session-name" label={copy.name} reserveMeta={false}><Input id="session-name" bind:value={sessionName} placeholder={data.messages.web.home.optional} /></Field>
        <Field id="session-role" label={copy.role} reserveMeta={false}><Select id="session-role" bind:value={roleRef} groups={roleGroups} label={copy.role} /></Field>
        <Field id="session-model" label={copy.model} reserveMeta={false}><Select id="session-model" bind:value={modelValue} groups={modelGroups} label={copy.model} /></Field>
        <Field id="session-thinking" label={copy.thinking} reserveMeta={false}><Select id="session-thinking" bind:value={thinkingLevel} groups={thinkingGroups} label={copy.thinking} /></Field>
        <Field id="session-cwd" label={copy.workingDirectory} hint={cwdRelativePath ? `${copy.selected}: ${cwdRelativePath}` : copy.directoryHint}>
          <div class="directory-field">
            <Select id="session-cwd" bind:value={cwdArtifactRef} groups={cwdGroups} label={copy.workingDirectory} onValueChange={() => { cwdRelativePath = ""; directoryView = null; directoryOpen = false; directoryLoading = false; directoryError = ""; directoryRequestToken += 1; }} />
            <Button variant="secondary" onclick={() => void browseDirectory(cwdRelativePath)} disabled={directoryLoading}>{directoryLoading ? copy.loading : copy.browseSubdirectory}</Button>
          </div>
        </Field>
        <div class="form-actions"><Button type="submit" loading={creating} disabled={createdSessionId !== null}>{creating ? copy.creating : copy.createSession}</Button></div>
      </form>
    </Panel>
  {/if}
  {#if directoryError}<Notice tone="danger" message={directoryError} />{/if}
  {#if createError}<Notice tone="danger" message={createError} />{/if}
  {#if createdSessionId}
    <Button variant="secondary" href={`/sessions/${createdSessionId}`}>{copy.openCreatedSession}</Button>
  {/if}
  <Panel title={data.messages.web.sessions.title} badge={String(sessions.length)} compact padded={sessions.length === 0}>
    {#if sessions.length === 0}
      <p class="empty">{copy.noSessions}</p>
    {:else}
      <ul class="session-list">
        {#each sessions as session (session.sessionId)}
          <li><a href="/sessions/{session.sessionId}">{session.name ?? session.sessionId}</a><StatusPill label={session.activity ?? "idle"} status={session.activity ?? "idle"} /></li>
        {/each}
      </ul>
    {/if}
  </Panel>

  <details class="role-create">
    <summary>{copy.roleCreate}</summary>
    <form onsubmit={(event) => { event.preventDefault(); void createRole(); }}>
      <Field id="role-id" label={copy.roleId} required reserveMeta={false}><Input id="role-id" pattern="[a-z0-9]+([-_/][a-z0-9]+)*" bind:value={roleId} required /></Field>
      <Field id="role-description" label={copy.description} required reserveMeta={false}><Input id="role-description" bind:value={roleDescription} required /></Field>
      <Field id="role-model-type" label={copy.modelType} required reserveMeta={false}><Input id="role-model-type" bind:value={roleModelType} required /></Field>
      <fieldset><legend>{copy.skills}</legend><div class="skill-grid">{#each data.skillCatalog.skills as skill (skill.name)}<Checkbox id={controlId("role-skill", skill.name)} label={skill.name} description={skill.description} checked={selectedRoleSkills.includes(skill.name)} onchange={(event) => toggleRoleSkill(skill.name, event.currentTarget.checked)} />{/each}</div></fieldset>
      <Field id="role-system-prompt" label={copy.systemPrompt} hint={copy.roleHint} required><Textarea id="role-system-prompt" rows={8} bind:value={rolePrompt} required /></Field>
      <Button type="submit" loading={roleCreating}>{roleCreating ? copy.creatingRole : copy.createRole}</Button>
      {#if roleStatus}<Notice tone="success" message={roleStatus} />{/if}
    </form>
  </details>

  <Panel title={copy.roleModels} note={copy.roleModelsHint} id="role-model-settings-heading">
    <div class="role-model-grid">
      {#each data.roleCatalog.roles as role (role.ref)}
        {@const source = roleModelSource[role.ref] ?? "project"}
        {@const current = modelSetting(role.modelType, source)}
        <article>
          <header><div><strong>{role.id}</strong><code>{role.modelType}</code></div><small>{copy.effectiveModel}: {modelSetting(role.modelType, "project")?.model ?? modelSetting(role.modelType, "user")?.model ?? copy.noModelSetting}</small></header>
          <Field id={controlId("role-source", role.ref)} label={copy.source} reserveMeta={false}><Select id={controlId("role-source", role.ref)} value={source} groups={sourceGroups} label={copy.source} onValueChange={(value) => (roleModelSource[role.ref] = value as "project" | "user")} /></Field>
          <Field id={controlId("role-model", role.ref)} label={copy.model} reserveMeta={false}><Select id={controlId("role-model", role.ref)} value={roleModelSelection[role.ref] ?? current?.model ?? ""} groups={roleModelGroups} label={copy.model} onValueChange={(value) => (roleModelSelection[role.ref] = value)} /></Field>
          <div class="role-model-actions"><Button variant="secondary" size="compact" disabled={Boolean(roleModelBusy)} onclick={() => void inspectRoleModel(role.ref)}>{copy.inspectModel}</Button><Button size="compact" disabled={Boolean(roleModelBusy) || !(roleModelSelection[role.ref] ?? current?.model)} onclick={() => { if (!roleModelSelection[role.ref] && current?.model) roleModelSelection[role.ref] = current.model; void saveRoleModel(role.ref); }}>{copy.saveModel}</Button><Button variant="danger" size="compact" disabled={Boolean(roleModelBusy) || !current} onclick={() => void deleteRoleModel(role.ref)}>{copy.deleteModel}</Button></div>
        </article>
      {/each}
    </div>
    {#if roleModelStatus}<Notice tone="success" message={roleModelStatus} />{/if}
  </Panel>

  <Panel title={copy.artifacts} note={`${data.artifactCatalog.total} ${data.artifactCatalog.total === 1 ? copy.daemonOwnedArtifact : copy.daemonOwnedArtifacts}`} id="artifact-center-heading">
    {#if artifactError}<Notice tone="danger" message={artifactError} />{/if}
    {#if data.artifactCatalog.artifacts.length === 0}
      <p>{copy.noArtifacts}</p>
    {:else}
      <div class="artifact-grid">
        {#each data.artifactCatalog.artifacts as artifact (artifact.ref)}
          <Artifact
            view={{ id: artifact.ref, title: artifact.title, kind: artifact.kind, summary: `${artifact.format} · ${artifact.sizeBytes} bytes` }}
            previewLabel={copy.preview}
            statusLabel={(value) => value}
            actions={artifactActions}
          />
        {/each}
      </div>
    {/if}
  </Panel>

  {#if artifactContent}
    <Panel title={artifactContent.title} badge={artifactContent.ref} compact>
      <header>
        <Button variant="secondary" size="compact" onclick={() => (artifactContent = null)}>{copy.close}</Button>
      </header>
      {#if artifactContent.format === "markdown"}
        <SafeMarkdown source={artifactContent.content} />
      {:else}
        <pre>{artifactContent.content}</pre>
      {/if}
    </Panel>
  {/if}
</PageLayout>

<Dialog bind:open={directoryOpen} width="min(680px, calc(100vw - 32px))" maxHeight="min(720px, calc(100dvh - 32px))" layout="grid" overflow="hidden" mobile="sheet" onOpenChangeComplete={restoreDirectoryFocus}>
  {#if directoryView}
    <section class="directory-picker" aria-label={copy.chooseDirectory}>
      <header><div><DialogTitle class="directory-title">{copy.chooseDirectory}</DialogTitle><code>{directoryView.current.relativePath || "."}</code></div><DialogClose class="dialog-close" aria-label={copy.close}>{copy.close}</DialogClose></header>
      <div class="directory-actions">
        <Button variant="secondary" disabled={!directoryView.current.relativePath} onclick={() => void browseDirectory(parentDirectory(directoryView!.current.relativePath))}>{copy.up}</Button>
        <Button onclick={() => { cwdArtifactRef = directoryView!.cwdArtifactRef ?? ""; cwdRelativePath = directoryView!.current.relativePath; closeDirectory(); }}>{copy.useDirectory}</Button>
      </div>
      <ul>
        {#each directoryView.entries as entry (entry.ref)}
          <li><Button variant="ghost" class="directory-entry" disabled={!entry.selectable} title={entry.blockedReason} onclick={() => void browseDirectory(entry.relativePath)}><span>{entry.kind === "symlink" ? "↪" : entry.kind === "directory" ? "▸" : "·"}</span><strong>{entry.name}</strong>{#if entry.blockedReason}<small>{entry.blockedReason}</small>{/if}</Button></li>
        {/each}
      </ul>
    </section>
  {/if}
</Dialog>

<style>
  header {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 16px;
  }
  .crumb {
    margin: 0 0 8px;
    font-size: 0.85rem;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 8px;
  }
  li {
    display: flex;
    justify-content: space-between;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 12px 16px;
  }
  a {
    color: inherit;
    text-decoration: none;
  }
  .session-create,
  .role-create form {
    display: grid;
    gap: 12px;
  }
  .role-create form > :global(.ui-button) { justify-self: start; }
  .session-create {
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  }
  .form-actions { align-items: end; display: flex; }
  .directory-field { align-items: start; display: grid; gap: var(--spacing-xs); grid-template-columns: minmax(0, 1fr) auto; }
  .role-create summary {
    cursor: pointer;
    font-weight: 650;
    padding: 8px 0;
  }
  .role-create fieldset {
    min-width: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }
  .skill-grid {
    display: grid;
    gap: 8px;
    max-height: 240px;
    overflow: auto;
  }
  .role-model-grid article {
    display: grid;
    gap: 8px;
  }
  .role-model-grid {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  }
  .role-model-grid article {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 12px;
  }
  .role-model-grid article header div {
    display: grid;
    gap: 3px;
  }
  .role-model-grid article small {
    color: var(--color-ink-muted);
    font-size: 0.82rem;
  }
  .role-model-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  :global(.directory-picker) {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    min-height: 320px;
  }
  :global(.directory-picker > header) {
    border-bottom: 1px solid var(--color-border);
    padding: var(--spacing-lg) var(--spacing-xl);
  }
  :global(.directory-title) { font-size: var(--text-section-title); font-weight: var(--weight-section-title); margin: 0; }
  :global(.dialog-close) { background: transparent; border: 0; border-radius: var(--rounded-md); color: var(--color-ink-muted); cursor: pointer; padding: var(--spacing-xs); }
  :global(.dialog-close:hover) { background: var(--color-surface-soft); }
  :global(.directory-actions) {
    display: flex;
    gap: var(--spacing-xs);
    padding: var(--spacing-md) var(--spacing-xl);
  }
  :global(.directory-picker ul) { border-top: 1px solid var(--color-border); gap: 0; overflow: auto; padding: var(--spacing-xs); }
  :global(.directory-picker li) {
    background: transparent;
    border: 0;
    padding: 0;
  }
  :global(.directory-entry.ui-button) {
    display: grid;
    gap: var(--spacing-xs);
    grid-template-columns: auto 1fr auto;
    justify-content: stretch;
    text-align: start;
    width: 100%;
  }
  .session-list { gap: 0; }
  .session-list li { border: 0; border-top: 1px solid var(--color-border); border-radius: 0; }
  .session-list li:first-child { border-top: 0; }
  .artifact-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  pre { font-family: var(--font-mono); margin: 0; max-height: 60vh; overflow: auto; white-space: pre-wrap; }
  .empty { color: var(--color-ink-muted); margin: 0; }
  @media (max-width: 640px) { .session-create { grid-template-columns: 1fr; } .directory-field { grid-template-columns: 1fr; } }
</style>
