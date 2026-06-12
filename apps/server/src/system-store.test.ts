import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SystemStore, tokenHash } from "./system-store.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-meditations-system-store-"));
const systemRoot = path.join(root, "system");
const workspacesRoot = path.join(root, "workspaces");
const legacyWorkspaceRoot = path.join(workspacesRoot, "default");
const tokenEncryptionSecret = "test-token-encryption-secret";

const store = await SystemStore.open({
  systemRoot,
  workspacesRoot,
  legacyWorkspaceRoot,
  defaultScopes: "workspace:read workspace:write",
  tokenEncryptionSecret
});

try {
  store.ensureDefaultOwner("admin@example.com", "legacy-token");
  const alice = store.createManualUser({ email: "alice@example.com", password: "alice-password" });
  const bob = store.createManualUser({ email: "bob@example.com", password: "bob-password" });

  assert.notEqual(alice.user.id, bob.user.id);
  assert.notEqual(alice.workspace.id, bob.workspace.id);
  assert.notEqual(alice.workspace.rootPath, bob.workspace.rootPath);
  assert.equal(alice.workspace.rootPath, path.join(workspacesRoot, alice.user.id, "default"));
  assert.equal(bob.workspace.rootPath, path.join(workspacesRoot, bob.user.id, "default"));

  const activeToken = store.getActiveMcpToken(alice.user.id, alice.workspace.id);
  assert.equal(activeToken?.token, alice.mcpToken.token);

  const authToken = store.getActiveMcpTokenByTokenHash(tokenHash(alice.mcpToken.token));
  assert.equal(authToken?.token, "");
  assert.equal(authToken?.userId, alice.user.id);
  assert.equal(authToken?.workspaceId, alice.workspace.id);

  const db = new DatabaseSync(path.join(systemRoot, "app.db"));
  try {
    const row = db.prepare("SELECT token, token_ciphertext FROM mcp_tokens WHERE id = ?").get(alice.mcpToken.id) as
      | { token: string; token_ciphertext: string | null }
      | undefined;
    assert.ok(row);
    assert.equal(row.token, "");
    assert.ok(row.token_ciphertext);
    assert.notEqual(row.token_ciphertext, alice.mcpToken.token);
  } finally {
    db.close();
  }
} finally {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
}

