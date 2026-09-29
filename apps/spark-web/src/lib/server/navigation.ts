import type { SidebarData } from "../sidebar";
import { listSparkWebSessions } from "./session-list";
import { invokeSparkWebRpc, type SparkWebDaemonInvoker } from "./rpc";

export async function loadSparkWebNavigation(invoke?: SparkWebDaemonInvoker): Promise<SidebarData> {
  try {
    const [workspaces, sessions, channelStatus] = await Promise.all([
      invokeSparkWebRpc("workspace.list", {}, invoke),
      listSparkWebSessions({}, invoke),
      invokeSparkWebRpc("channel.status", {}, invoke).catch(() => undefined),
    ]);
    return {
      workspaces: workspaces.workspaces,
      sessions,
      unavailable: false,
      ...(channelStatus ? { channelAdapters: channelStatus.adapters } : {}),
    };
  } catch {
    // A disconnected daemon must not make the shell's settings and navigation inaccessible.
    return { workspaces: [], sessions: [], unavailable: true };
  }
}
