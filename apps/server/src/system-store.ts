import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type UserRecord = {
  id: string;
  googleSub?: string;
  email: string;
  status: "active" | "disabled";
  passwordMustRotate?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceRecord = {
  id: string;
  userId: string;
  slug: string;
  rootPath: string;
  createdAt: number;
};

export type McpTokenRecord = {
  id: string;
  token: string;
  userId: string;
  workspaceId: string;
  name: string;
  scopes: string;
  createdAt: number;
  revokedAt?: number;
};

export type WebSessionRecord = {
  idHash: string;
  userId: string;
  workspaceId: string;
  email: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
};

export type SaveWebSessionInput = {
  idHash: string;
  userId: string;
  workspaceId: string;
  email: string;
  createdAt: number;
  expiresAt: number;
};

export type SystemStoreConfig = {
  systemRoot: string;
  workspacesRoot: string;
  legacyWorkspaceRoot: string;
  defaultScopes: string;
  tokenEncryptionSecret: string;
};

export type CreateManualUserInput = {
  email: string;
  password: string;
  createdBy?: string;
  passwordMustRotate?: boolean;
};

type DbUserRow = {
  id: string;
  google_sub: string | null;
  email: string;
  status: string;
  password_hash: string | null;
  password_updated_at: number | null;
  password_must_rotate: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};

type DbWorkspaceRow = {
  id: string;
  user_id: string;
  slug: string;
  root_path: string;
  created_at: number;
};

type DbMcpTokenRow = {
  id: string;
  token_hash: string;
  token: string;
  token_ciphertext: string | null;
  user_id: string;
  workspace_id: string;
  name: string;
  scopes: string;
  created_at: number;
  revoked_at: number | null;
};

type DbWebSessionRow = {
  id_hash: string;
  user_id: string;
  workspace_id: string;
  email: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
};

export class SystemStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly config: SystemStoreConfig
  ) {}

  static async open(config: SystemStoreConfig) {
    await fs.mkdir(config.systemRoot, { recursive: true });
    const db = new DatabaseSync(path.join(config.systemRoot, "app.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    const store = new SystemStore(db, config);
    store.migrate();
    return store;
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        google_sub TEXT UNIQUE,
        email TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        password_hash TEXT,
        password_updated_at INTEGER,
        password_must_rotate INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, slug),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        token TEXT NOT NULL,
        token_ciphertext TEXT,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        id_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
      );
    `);
    this.ensureUserCredentialColumns();
    this.ensureMcpTokenCiphertextColumn();
    this.migratePlaintextMcpTokens();
  }

  ensureDefaultOwner(ownerEmail: string, legacyToken: string) {
    const now = Date.now();
    const normalizedEmail = normalizeEmail(ownerEmail);
    const existing = this.db.prepare("SELECT id FROM users WHERE id = ?").get("usr_default") as { id: string } | undefined;
    if (!existing) {
      this.db.prepare(
        "INSERT INTO users (id, google_sub, email, status, created_at, updated_at) VALUES (?, NULL, ?, 'active', ?, ?)"
      ).run("usr_default", normalizedEmail, now, now);
    } else if (!this.emailBelongsToAnotherUser(normalizedEmail, "usr_default")) {
      this.db.prepare("UPDATE users SET email = ?, updated_at = ? WHERE id = ? AND google_sub IS NULL").run(normalizedEmail, now, "usr_default");
    }

    const workspace = this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get("wks_default") as { id: string } | undefined;
    if (!workspace) {
      this.db.prepare(
        "INSERT INTO workspaces (id, user_id, slug, root_path, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run("wks_default", "usr_default", "default", this.config.legacyWorkspaceRoot, now);
    }

    this.ensureMcpToken("usr_default", "wks_default", legacyToken, "legacy-env-token", this.config.defaultScopes);
  }

  getDefaultWorkspace() {
    return this.getWorkspaceById("wks_default");
  }

  listUsers() {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY created_at ASC").all() as DbUserRow[];
    return rows.map(normalizeUserRow);
  }

  getUserById(userId: string) {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as DbUserRow | undefined;
    if (!row) throw new Error(`user not found: ${userId}`);
    return normalizeUserRow(row);
  }

  getUserByEmail(email: string) {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)) as DbUserRow | undefined;
    return row ? normalizeUserRow(row) : undefined;
  }

  resolveUser(identifier: string) {
    const normalized = normalizeEmail(identifier);
    const row = normalized.includes("@")
      ? (this.db.prepare("SELECT * FROM users WHERE email = ?").get(normalized) as DbUserRow | undefined)
      : (this.db.prepare("SELECT * FROM users WHERE id = ?").get(identifier) as DbUserRow | undefined);
    if (!row) throw new Error(`user not found: ${identifier}`);
    return normalizeUserRow(row);
  }

  getWorkspaceById(workspaceId: string) {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as DbWorkspaceRow | undefined;
    if (!row) throw new Error(`workspace not found: ${workspaceId}`);
    return normalizeWorkspaceRow(row);
  }

  listWorkspaces() {
    const rows = this.db.prepare("SELECT * FROM workspaces ORDER BY created_at ASC").all() as DbWorkspaceRow[];
    return rows.map(normalizeWorkspaceRow);
  }

  getDefaultWorkspaceForUser(userId: string) {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE user_id = ? AND slug = 'default'").get(userId) as DbWorkspaceRow | undefined;
    if (!row) throw new Error(`default workspace not found for user: ${userId}`);
    return normalizeWorkspaceRow(row);
  }

  ensureDefaultWorkspaceForUser(userId: string) {
    const existing = this.db.prepare("SELECT * FROM workspaces WHERE user_id = ? AND slug = 'default'").get(userId) as DbWorkspaceRow | undefined;
    if (existing) return normalizeWorkspaceRow(existing);

    this.getUserById(userId);
    const workspaceId = `wks_${randomBytes(10).toString("base64url")}`;
    const rootPath = path.join(this.config.workspacesRoot, userId, "default");
    this.db.prepare(
      "INSERT OR IGNORE INTO workspaces (id, user_id, slug, root_path, created_at) VALUES (?, ?, 'default', ?, ?)"
    ).run(workspaceId, userId, rootPath, Date.now());
    return this.getDefaultWorkspaceForUser(userId);
  }

  getOrCreateGoogleUser(googleSub: string, email: string) {
    const normalizedEmail = normalizeEmail(email);
    const now = Date.now();
    let userRow = this.db.prepare("SELECT * FROM users WHERE google_sub = ?").get(googleSub) as DbUserRow | undefined;

    if (!userRow) {
      userRow = this.db.prepare("SELECT * FROM users WHERE email = ?").get(normalizedEmail) as DbUserRow | undefined;
      if (userRow) {
        this.db.prepare("UPDATE users SET google_sub = ?, status = 'active', updated_at = ? WHERE id = ?").run(googleSub, now, userRow.id);
        userRow = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userRow.id) as DbUserRow;
      }
    }

    if (!userRow) {
      const userId = `usr_${randomBytes(10).toString("base64url")}`;
      this.db.prepare(
        "INSERT INTO users (id, google_sub, email, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
      ).run(userId, googleSub, normalizedEmail, now, now);
      userRow = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as DbUserRow;
    }

    const user = normalizeUserRow(userRow);
    if (user.status !== "active") throw new Error("user is disabled");
    const workspace = this.ensureDefaultWorkspaceForUser(user.id);
    this.ensureActiveMcpToken(user.id, workspace.id);
    return { user, workspace };
  }

  createManualUser(input: CreateManualUserInput) {
    const email = normalizeEmail(input.email);
    if (!email || !email.includes("@")) throw new Error("email is required");
    if (!input.password) throw new Error("password is required");
    if (this.getUserByEmail(email)) throw new Error(`user already exists: ${email}`);

    return this.runInTransaction(() => {
      const now = Date.now();
      const userId = `usr_${randomBytes(10).toString("base64url")}`;
      const workspaceId = `wks_${randomBytes(10).toString("base64url")}`;
      const rootPath = path.join(this.config.workspacesRoot, userId, "default");
      this.db.prepare(
        `INSERT INTO users
          (id, google_sub, email, status, password_hash, password_updated_at, password_must_rotate, created_by, created_at, updated_at)
          VALUES (?, NULL, ?, 'active', ?, ?, ?, ?, ?, ?)`
      ).run(
        userId,
        email,
        hashPassword(input.password),
        now,
        input.passwordMustRotate ? 1 : 0,
        input.createdBy ?? "admin-cli",
        now,
        now
      );
      this.db.prepare(
        "INSERT INTO workspaces (id, user_id, slug, root_path, created_at) VALUES (?, ?, 'default', ?, ?)"
      ).run(workspaceId, userId, rootPath, now);
      const token = this.createMcpToken(userId, workspaceId, "default", this.config.defaultScopes);
      return {
        user: this.getUserById(userId),
        workspace: this.getWorkspaceById(workspaceId),
        mcpToken: token
      };
    });
  }

  resetPassword(identifier: string, password: string, passwordMustRotate = false) {
    if (!password) throw new Error("password is required");
    const user = this.resolveUser(identifier);
    const now = Date.now();
    this.db.prepare(
      "UPDATE users SET password_hash = ?, password_updated_at = ?, password_must_rotate = ?, updated_at = ? WHERE id = ?"
    ).run(hashPassword(password), now, passwordMustRotate ? 1 : 0, now, user.id);
    return this.getUserById(user.id);
  }

  disableUser(identifier: string) {
    const user = this.resolveUser(identifier);
    const now = Date.now();
    this.db.prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?").run(now, user.id);
    this.db.prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, user.id);
    return this.getUserById(user.id);
  }

  authenticatePassword(email: string, password: string) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) return undefined;
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(normalizedEmail) as DbUserRow | undefined;
    if (!row || row.status === "disabled" || !row.password_hash) return undefined;
    if (!verifyPassword(password, row.password_hash)) return undefined;
    const user = normalizeUserRow(row);
    return {
      user,
      workspace: this.getDefaultWorkspaceForUser(user.id)
    };
  }

  getActiveMcpToken(userId: string, workspaceId: string) {
    const row = this.db.prepare(
      "SELECT * FROM mcp_tokens WHERE user_id = ? AND workspace_id = ? AND revoked_at IS NULL ORDER BY created_at ASC LIMIT 1"
    ).get(userId, workspaceId) as DbMcpTokenRow | undefined;
    return row ? normalizeMcpTokenRow(row, this.config.tokenEncryptionSecret, true) : undefined;
  }

  getActiveMcpTokenByTokenHash(hash: string) {
    const row = this.db.prepare(
      "SELECT * FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL"
    ).get(hash) as DbMcpTokenRow | undefined;
    return row ? normalizeMcpTokenRow(row, this.config.tokenEncryptionSecret, false) : undefined;
  }

  ensureActiveMcpToken(userId: string, workspaceId: string) {
    const user = this.getUserById(userId);
    if (user.status !== "active") throw new Error("user is disabled");
    this.assertWorkspaceOwner(userId, workspaceId);
    const existing = this.getActiveMcpToken(userId, workspaceId);
    if (existing) return existing.token;
    return this.createMcpToken(userId, workspaceId, "default", this.config.defaultScopes).token;
  }

  rotateMcpToken(identifier: string) {
    const user = this.resolveUser(identifier);
    if (user.status !== "active") throw new Error("user is disabled");
    const workspace = this.getDefaultWorkspaceForUser(user.id);
    return this.runInTransaction(() => {
      const now = Date.now();
      this.db.prepare(
        "UPDATE mcp_tokens SET revoked_at = ? WHERE user_id = ? AND workspace_id = ? AND revoked_at IS NULL"
      ).run(now, user.id, workspace.id);
      return this.createMcpToken(user.id, workspace.id, "rotated", this.config.defaultScopes);
    });
  }

  ensureMcpToken(userId: string, workspaceId: string, token: string, name: string, scopes: string) {
    this.assertWorkspaceOwner(userId, workspaceId);
    const existing = this.db.prepare("SELECT id FROM mcp_tokens WHERE token_hash = ?").get(tokenHash(token)) as { id: string } | undefined;
    if (existing) return;
    this.db.prepare(
      "INSERT INTO mcp_tokens (id, token_hash, token, token_ciphertext, user_id, workspace_id, name, scopes, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)"
    ).run(
      `mcp_${randomBytes(10).toString("base64url")}`,
      tokenHash(token),
      "",
      encryptToken(token, this.config.tokenEncryptionSecret),
      userId,
      workspaceId,
      name,
      scopes,
      Date.now()
    );
  }

  saveWebSession(session: SaveWebSessionInput) {
    this.db.prepare(
      `INSERT OR REPLACE INTO web_sessions
        (id_hash, user_id, workspace_id, email, created_at, expires_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)`
    ).run(session.idHash, session.userId, session.workspaceId, session.email, session.createdAt, session.expiresAt);
  }

  getWebSessionByIdHash(idHash: string) {
    const row = this.db.prepare("SELECT * FROM web_sessions WHERE id_hash = ? AND revoked_at IS NULL").get(idHash) as DbWebSessionRow | undefined;
    return row ? normalizeWebSessionRow(row) : undefined;
  }

  revokeWebSessionByIdHash(idHash: string) {
    this.db.prepare("UPDATE web_sessions SET revoked_at = ? WHERE id_hash = ?").run(Date.now(), idHash);
  }

  deleteExpiredWebSessions(now = Date.now()) {
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now);
  }

  private createMcpToken(userId: string, workspaceId: string, name: string, scopes: string) {
    const token = `mcp_${randomBytes(32).toString("base64url")}`;
    const id = `mcp_${randomBytes(10).toString("base64url")}`;
    const createdAt = Date.now();
    this.db.prepare(
      "INSERT INTO mcp_tokens (id, token_hash, token, token_ciphertext, user_id, workspace_id, name, scopes, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)"
    ).run(id, tokenHash(token), "", encryptToken(token, this.config.tokenEncryptionSecret), userId, workspaceId, name, scopes, createdAt);
    return { id, token, userId, workspaceId, name, scopes, createdAt };
  }

  private ensureUserCredentialColumns() {
    const rows = this.db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    const columns = new Set(rows.map((row) => row.name));
    const addColumn = (name: string, ddl: string) => {
      if (columns.has(name)) return;
      this.db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
      columns.add(name);
    };

    addColumn("password_hash", "password_hash TEXT");
    addColumn("password_updated_at", "password_updated_at INTEGER");
    addColumn("password_must_rotate", "password_must_rotate INTEGER NOT NULL DEFAULT 0");
    addColumn("created_by", "created_by TEXT");
  }

  private ensureMcpTokenCiphertextColumn() {
    const rows = this.db.prepare("PRAGMA table_info(mcp_tokens)").all() as Array<{ name: string }>;
    const columns = new Set(rows.map((row) => row.name));
    if (!columns.has("token_ciphertext")) {
      this.db.exec("ALTER TABLE mcp_tokens ADD COLUMN token_ciphertext TEXT");
    }
  }

  private migratePlaintextMcpTokens() {
    const rows = this.db.prepare("SELECT id, token, token_ciphertext FROM mcp_tokens").all() as Array<{
      id: string;
      token: string;
      token_ciphertext: string | null;
    }>;

    for (const row of rows) {
      if (!row.token || row.token_ciphertext) continue;
      this.db.prepare("UPDATE mcp_tokens SET token = '', token_ciphertext = ? WHERE id = ?").run(
        encryptToken(row.token, this.config.tokenEncryptionSecret),
        row.id
      );
    }
  }

  private emailBelongsToAnotherUser(email: string, userId: string) {
    const row = this.db.prepare("SELECT id FROM users WHERE email = ? AND id <> ?").get(normalizeEmail(email), userId) as { id: string } | undefined;
    return Boolean(row);
  }

  private assertWorkspaceOwner(userId: string, workspaceId: string) {
    const workspace = this.getWorkspaceById(workspaceId);
    if (workspace.userId !== userId) throw new Error("workspace does not belong to user");
  }

  private runInTransaction<T>(operation: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const key = scryptSync(password, salt, 32).toString("base64url");
  return `scrypt$1$${salt}$${key}`;
}

export function verifyPassword(password: string, passwordHash: string) {
  const [scheme, version, salt, expected] = passwordHash.split("$");
  if (scheme !== "scrypt" || version !== "1" || !salt || !expected) return false;
  try {
    const expectedBuffer = Buffer.from(expected, "base64url");
    const actualBuffer = scryptSync(password, salt, expectedBuffer.length);
    return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
  } catch {
    return false;
  }
}

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function encryptToken(token: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenEncryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

function decryptToken(value: string, secret: string) {
  const [version, iv, tag, ciphertext] = value.split(":");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("stored MCP token has an unsupported encryption format");
  const decipher = createDecipheriv("aes-256-gcm", tokenEncryptionKey(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

function tokenEncryptionKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

export function initialPasswordFromEmail(email: string) {
  return createHash("md5").update(normalizeEmail(email)).digest("hex").slice(-8);
}

function normalizeUserRow(row: DbUserRow): UserRecord {
  return {
    id: row.id,
    googleSub: row.google_sub ?? undefined,
    email: row.email,
    status: row.status === "disabled" ? "disabled" : "active",
    passwordMustRotate: Boolean(row.password_must_rotate),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeWorkspaceRow(row: DbWorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    slug: row.slug,
    rootPath: row.root_path,
    createdAt: row.created_at
  };
}

function normalizeMcpTokenRow(row: DbMcpTokenRow, tokenEncryptionSecret: string, revealToken: boolean): McpTokenRecord {
  return {
    id: row.id,
    token: revealToken ? storedTokenValue(row, tokenEncryptionSecret) : "",
    userId: row.user_id,
    workspaceId: row.workspace_id,
    name: row.name,
    scopes: row.scopes,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? undefined
  };
}

function storedTokenValue(row: DbMcpTokenRow, tokenEncryptionSecret: string) {
  if (row.token_ciphertext) return decryptToken(row.token_ciphertext, tokenEncryptionSecret);
  return row.token;
}

function normalizeWebSessionRow(row: DbWebSessionRow): WebSessionRecord {
  return {
    idHash: row.id_hash,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    email: row.email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? undefined
  };
}
