<script lang="ts">
  import { goto } from "$app/navigation";
  import { parseSparkModelValue } from "@zendev-lab/spark-protocol";
  import { SafeMarkdown } from "@zendev-lab/spark-ui/markdown";
  import { Artifact } from "@zendev-lab/spark-ui/workbench";
  import {
    ordinarySessionsForWorkspace,
    workspaceAdministratorSessionId,
    type SparkWebSession,
  } from "$lib/daemon-surface";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
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
  let artifactContent = $state<{ ref: string; title: string; format: string; content: string } | null>(null);
  let artifactError = $state("");
  let artifactLoading = $state(false);
  let sessionCreateToken = 0;
  let roleCreateToken = 0;
  let artifactRequestToken = 0;
  const sessions = $derived(
    ordinarySessionsForWorkspace(data.sessions as SparkWebSession[], data.workspace.id),
  );

  $effect(() => {
    data.workspace.id;
    sessionCreateToken += 1;
    roleCreateToken += 1;
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
      createError = "Workspace administrator session is missing on this daemon.";
      return;
    }
    let requestedModel: ReturnType<typeof parseSparkModelValue> | undefined;
    try {
      requestedModel = modelValue ? parseSparkModelValue(modelValue) : undefined;
    } catch {
      if (ownsPage()) createError = "Select a valid provider/model before creating the Session.";
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
        createError = `Session ${created.sessionId} was created, but its model or thinking configuration failed: ${message}`;
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
        createError = `Session ${created.sessionId} is ready, but navigation failed: ${message}`;
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
</script>

{#snippet artifactActions(view: { id: string })}
  <button type="button" class="secondary" onclick={() => void openArtifact(view.id)} disabled={artifactLoading}>Preview</button>
{/snippet}

<section class="page">
  <header>
    <div>
      <p class="crumb"><a href="/">Workspaces</a></p>
      <h1>{data.workspace.displayName}</h1>
      <p>{data.workspace.localPath}</p>
    </div>
    <button type="button" onclick={() => (showCreate = !showCreate)} disabled={creating}>
      {showCreate ? "Hide session form" : "New session"}
    </button>
  </header>
  {#if showCreate}
    <form class="session-create" onsubmit={(event) => { event.preventDefault(); void createSession(); }}>
      <h2>Session context</h2>
      <label>Name<input type="text" bind:value={sessionName} placeholder="optional" /></label>
      <label>Role<select bind:value={roleRef}>{#each data.roleCatalog.roles as role (role.ref)}<option value={role.ref}>{role.id} · {role.source}</option>{/each}</select></label>
      <label>Mode<select disabled title="Plan and Fleet require the pending DSH rc.8 daemon-root adapter"><option>execute</option></select></label>
      <label>Model<select bind:value={modelValue}><option value="">Inherit default</option>{#each data.modelCatalog.providers as provider}{#each provider.models as entry (entry.model.modelId)}<option value={`${entry.model.providerName}/${entry.model.modelId}`} disabled={!entry.available}>{entry.model.modelLabel ?? entry.model.modelId} · {provider.label}</option>{/each}{/each}</select></label>
      <label>Thinking<select bind:value={thinkingLevel}><option value="off">off</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label>
      <label>Working directory<select bind:value={cwdArtifactRef} onchange={() => { cwdRelativePath = ""; directoryView = null; directoryOpen = false; directoryLoading = false; directoryError = ""; directoryRequestToken += 1; }}><option value="">Workspace default</option>{#each data.artifactCatalog.artifacts.filter((artifact) => artifact.kind === "git_change") as artifact}<option value={artifact.ref}>{artifact.title} · owning worktree</option>{/each}</select><button type="button" class="secondary" onclick={() => void browseDirectory(cwdRelativePath)} disabled={directoryLoading}>{directoryLoading ? "Loading…" : "Browse subdirectory"}</button>{#if cwdRelativePath}<small>Selected: {cwdRelativePath}</small>{/if}</label>
      <button type="submit" disabled={creating || createdSessionId !== null}>{creating ? "Creating…" : "Create Session"}</button>
      <p class="hint">Directory choices are daemon-owned Workspace roots or GitChange owning worktrees. Plan/Fleet mode remains disabled until the DSH rc.8 adapter lands.</p>
    </form>
  {/if}
  {#if directoryError}<p class="error" role="alert">{directoryError}</p>{/if}
  {#if directoryOpen && directoryView}
    <dialog open class="directory-picker" aria-label="Choose Session working directory">
      <header><div><h2>Choose directory</h2><code>{directoryView.current.relativePath || "."}</code></div><button type="button" class="secondary" onclick={() => (directoryOpen = false)}>Close</button></header>
      <div class="directory-actions">
        <button type="button" class="secondary" disabled={!directoryView.current.relativePath} onclick={() => void browseDirectory(parentDirectory(directoryView!.current.relativePath))}>Up</button>
        <button type="button" onclick={() => { cwdArtifactRef = directoryView!.cwdArtifactRef ?? ""; cwdRelativePath = directoryView!.current.relativePath; directoryOpen = false; }}>Use this directory</button>
      </div>
      <ul>
        {#each directoryView.entries as entry (entry.ref)}
          <li><button type="button" class="directory-entry" disabled={!entry.selectable} title={entry.blockedReason} onclick={() => void browseDirectory(entry.relativePath)}><span>{entry.kind === "symlink" ? "↪" : entry.kind === "directory" ? "▸" : "·"}</span><strong>{entry.name}</strong>{#if entry.blockedReason}<small>{entry.blockedReason}</small>{/if}</button></li>
        {/each}
      </ul>
    </dialog>
  {/if}
  {#if createError}
    <p class="error">{createError}</p>
  {/if}
  {#if createdSessionId}
    <p><a href={`/sessions/${createdSessionId}`}>Open created Session</a></p>
  {/if}
  {#if sessions.length === 0}
    <p>No sessions in this workspace yet.</p>
  {:else}
    <ul>
      {#each sessions as session (session.sessionId)}
        <li>
          <a href="/sessions/{session.sessionId}">{session.name ?? session.sessionId}</a>
          <span>{session.activity}</span>
        </li>
      {/each}
    </ul>
  {/if}

  <details class="role-create">
    <summary>Create project Role</summary>
    <form onsubmit={(event) => { event.preventDefault(); void createRole(); }}>
      <label>Role id<input type="text" pattern="[a-z0-9]+([-_/][a-z0-9]+)*" bind:value={roleId} required /></label>
      <label>Description<input type="text" bind:value={roleDescription} required /></label>
      <label>Model type<input type="text" bind:value={roleModelType} required /></label>
      <fieldset><legend>Skills</legend><div class="skill-grid">{#each data.skillCatalog.skills as skill (skill.name)}<label class="checkbox"><input type="checkbox" bind:group={selectedRoleSkills} value={skill.name} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span></label>{/each}</div></fieldset>
      <label>System prompt<textarea rows="8" bind:value={rolePrompt} required></textarea></label>
      <button type="submit" disabled={roleCreating}>{roleCreating ? "Creating…" : "Create Role"}</button>
      {#if roleStatus}<p role="status">{roleStatus}</p>{/if}
      <p class="hint">Same-name creation is rejected. Existing Role definitions remain file-owned under the project.</p>
    </form>
  </details>

  <section class="artifacts" aria-labelledby="artifact-center-heading">
    <header>
      <div>
        <h2 id="artifact-center-heading">Artifacts</h2>
        <p>{data.artifactCatalog.total} daemon-owned Artifact{data.artifactCatalog.total === 1 ? "" : "s"}</p>
      </div>
    </header>
    {#if artifactError}<p class="error" role="alert">{artifactError}</p>{/if}
    {#if data.artifactCatalog.artifacts.length === 0}
      <p>No Artifacts in this workspace.</p>
    {:else}
      <div class="artifact-grid">
        {#each data.artifactCatalog.artifacts as artifact (artifact.ref)}
          <Artifact
            view={{ id: artifact.ref, title: artifact.title, kind: artifact.kind, summary: `${artifact.format} · ${artifact.sizeBytes} bytes` }}
            previewLabel="Preview"
            statusLabel={(value) => value}
            actions={artifactActions}
          />
        {/each}
      </div>
    {/if}
  </section>

  {#if artifactContent}
    <section class="artifact-preview" aria-label={`Artifact preview: ${artifactContent.title}`}>
      <header>
        <div><h2>{artifactContent.title}</h2><code>{artifactContent.ref}</code></div>
        <button type="button" class="secondary" onclick={() => (artifactContent = null)}>Close</button>
      </header>
      {#if artifactContent.format === "markdown"}
        <SafeMarkdown source={artifactContent.content} />
      {:else}
        <pre>{artifactContent.content}</pre>
      {/if}
    </section>
  {/if}
</section>

<style>
  .page {
    padding: 24px;
    display: grid;
    gap: 16px;
  }
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
  header p {
    margin: 4px 0 0;
    color: var(--color-ink-muted);
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
  button {
    background: var(--color-primary);
    color: var(--color-on-primary);
    border: 0;
    border-radius: 8px;
    padding: 8px 12px;
  }
  .error {
    color: var(--color-danger, #f87171);
  }
  .session-create,
  .role-create form {
    display: grid;
    gap: 12px;
    padding: 16px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
  }
  .session-create {
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  }
  .session-create h2,
  .session-create .hint {
    grid-column: 1 / -1;
    margin: 0;
  }
  .session-create label,
  .role-create label {
    display: grid;
    gap: 6px;
    color: var(--color-ink-muted);
    font-size: 0.88rem;
  }
  .session-create input,
  .role-create input,
  select,
  textarea {
    min-width: 0;
    padding: 8px 10px;
    background: var(--color-canvas, var(--color-surface));
    color: var(--color-ink);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font: inherit;
  }
  .hint,
  .role-create small {
    color: var(--color-ink-muted);
    font-size: 0.82rem;
  }
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
  .checkbox {
    grid-template-columns: auto 1fr !important;
    align-items: start;
  }
  .checkbox span {
    display: grid;
    gap: 2px;
  }
  .directory-picker {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    box-shadow: var(--shadow-card-raised);
    display: grid;
    gap: 10px;
    max-height: 60vh;
    overflow: auto;
    padding: 16px;
  }
  .directory-picker h2 {
    margin: 0;
  }
  .directory-actions {
    display: flex;
    gap: 8px;
  }
  .directory-picker li {
    padding: 0;
  }
  .directory-entry {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--color-ink);
    display: grid;
    gap: 8px;
    grid-template-columns: auto 1fr auto;
    text-align: start;
    width: 100%;
  }
  .directory-entry:disabled {
    color: var(--color-ink-muted);
    cursor: not-allowed;
  }
  .artifacts, .artifact-preview { display: grid; gap: 12px; }
  .artifacts h2, .artifact-preview h2 { margin: 0; }
  .artifact-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .artifact-preview { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 12px; padding: 16px; }
  .artifact-preview pre { font-family: var(--font-mono); margin: 0; max-height: 60vh; overflow: auto; white-space: pre-wrap; }
  button.secondary { background: transparent; border: 1px solid var(--color-border); color: var(--color-ink); }
</style>
