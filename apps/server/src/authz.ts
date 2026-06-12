import type { SandboxScope } from "@ai-meditations/shared";
import type { UserRecord, WorkspaceRecord } from "./system-store.js";

export class AuthzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthzError";
  }
}

export function assertWorkspaceBelongsToUser(user: UserRecord, workspace: WorkspaceRecord) {
  if (workspace.userId !== user.id) {
    throw new AuthzError("workspace does not belong to authenticated user");
  }
}

export function mcpScopesToSandboxScope(scopes: string): SandboxScope {
  return scopeIncludes(scopes, "workspace:write") ? "write" : "read";
}

export function scopeIncludes(scopes: string, scope: string) {
  return scopes.split(/\s+/).filter(Boolean).includes(scope);
}

