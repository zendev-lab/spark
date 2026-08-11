import { getDatabase } from "$lib/server/db";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";

interface WorkspaceRouteEvent {
  params: { workspaceId: string };
}

export async function loadCanonicalWorkspaceRoute<Event extends WorkspaceRouteEvent, T>(
  event: Event,
  loader: (event: Event, workspaceId: string) => Promise<T>,
): Promise<T> {
  const workspace = requireWorkspaceByRouteId(getDatabase(), event.params.workspaceId);
  return await loader(event, workspace.id);
}
