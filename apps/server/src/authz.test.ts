import assert from "node:assert/strict";
import { AuthzError, assertWorkspaceBelongsToUser, mcpScopesToSandboxScope, scopeIncludes } from "./authz.js";
import type { UserRecord, WorkspaceRecord } from "./system-store.js";

const user: UserRecord = {
  id: "usr_a",
  email: "a@example.com",
  status: "active",
  createdAt: 1,
  updatedAt: 1
};

const ownedWorkspace: WorkspaceRecord = {
  id: "wks_a",
  userId: "usr_a",
  slug: "default",
  rootPath: "/tmp/a/default",
  createdAt: 1
};

const foreignWorkspace: WorkspaceRecord = {
  ...ownedWorkspace,
  id: "wks_b",
  userId: "usr_b",
  rootPath: "/tmp/b/default"
};

assert.doesNotThrow(() => assertWorkspaceBelongsToUser(user, ownedWorkspace));
assert.throws(() => assertWorkspaceBelongsToUser(user, foreignWorkspace), AuthzError);

assert.equal(scopeIncludes("workspace:read workspace:write", "workspace:read"), true);
assert.equal(scopeIncludes("workspace:read", "workspace:write"), false);
assert.equal(mcpScopesToSandboxScope("workspace:read workspace:write"), "write");
assert.equal(mcpScopesToSandboxScope("workspace:read"), "read");
assert.equal(mcpScopesToSandboxScope(""), "read");

