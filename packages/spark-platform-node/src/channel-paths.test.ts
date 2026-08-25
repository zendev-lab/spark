import { lstat, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  channelConfigPath,
  channelRuntimeDir,
  channelSessionWorkspacePath,
  ensureChannelSessionWorkspace,
  validateChannelSessionWorkspace,
} from "./channel-paths.ts";

function roots(root: string) {
  return {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    runtimeDir: join(root, "run"),
  };
}

describe("daemon Channel paths", () => {
  it("derives global config, runtime, and private per-Session cwd", async () => {
    const root = join(tmpdir(), `spark-channel-paths-${crypto.randomUUID()}`);
    const paths = roots(root);
    const cwd = await ensureChannelSessionWorkspace(paths, "sess_safe_1");

    expect(channelConfigPath(paths)).toBe(join(root, "config", "channels.json"));
    expect(channelRuntimeDir(paths)).toBe(join(root, "run", "channels"));
    expect(cwd).toBe(channelSessionWorkspacePath(paths, "sess_safe_1"));
    expect((await lstat(cwd)).mode & 0o777).toBe(0o700);
    await expect(validateChannelSessionWorkspace(paths, "sess_safe_1", cwd)).resolves.toBe(cwd);
  });

  it("rejects provider-derived ids, caller cwd overrides, and linked path components", async () => {
    const root = join(tmpdir(), `spark-channel-paths-${crypto.randomUUID()}`);
    const paths = roots(root);
    expect(() => channelSessionWorkspacePath(paths, "../../conversation")).toThrow(/not safe/u);
    await ensureChannelSessionWorkspace(paths, "sess_safe_2");
    await expect(
      validateChannelSessionWorkspace(paths, "sess_safe_2", join(root, "outside")),
    ).rejects.toThrow(/does not match/u);

    const linked = roots(join(tmpdir(), `spark-channel-linked-${crypto.randomUUID()}`));
    await mkdir(linked.dataDir, { recursive: true });
    await symlink(root, join(linked.dataDir, "channels"), "dir");
    await expect(ensureChannelSessionWorkspace(linked, "sess_safe_3")).rejects.toThrow(
      /real directory/u,
    );
  });
});
