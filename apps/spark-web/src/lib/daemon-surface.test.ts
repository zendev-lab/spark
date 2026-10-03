import assert from "node:assert/strict";
import { test } from "vitest";

import {
  isUnregisteredWorkspaceError,
  isWorkspaceAdministrator,
  ordinaryDaemonSessions,
  ordinarySessionsForWorkspace,
  sessionWorkspaceId,
  workspaceAdministratorSessionId,
} from "./daemon-surface.ts";

const admin = {
  sessionId: "sess_admin",
  name: "Administrator",
  activity: "idle",
  scope: { kind: "workspace", workspaceId: "ws_a" },
  lineage: { kind: "root" },
  roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
};
const child = {
  sessionId: "sess_child",
  name: "Investigate",
  activity: "running",
  scope: { kind: "workspace", workspaceId: "ws_a" },
  lineage: { kind: "child" },
  roleBinding: { kind: "none" },
};
const other = {
  sessionId: "sess_other",
  name: "Other",
  activity: "idle",
  scope: { kind: "workspace", workspaceId: "ws_b" },
  lineage: { kind: "child" },
  roleBinding: { kind: "none" },
};

test("workspace identity is read from daemon session scope", () => {
  assert.equal(sessionWorkspaceId(child), "ws_a");
  assert.equal(isWorkspaceAdministrator(admin), true);
  assert.equal(isWorkspaceAdministrator(child), false);
  assert.equal(workspaceAdministratorSessionId([admin, child, other], "ws_a"), "sess_admin");
  assert.deepEqual(
    ordinarySessionsForWorkspace([admin, child, other], "ws_a").map((session) => session.sessionId),
    ["sess_child"],
  );
  assert.deepEqual(
    ordinaryDaemonSessions([admin, child, other]).map((session) => session.sessionId),
    ["sess_child", "sess_other"],
  );
});

test("unregistered cwd is a missing daemon binding, not a web identity", () => {
  assert.equal(isUnregisteredWorkspaceError({ code: "workspace_not_found" }), true);
  assert.equal(isUnregisteredWorkspaceError(new Error("missing")), false);
});
