import path from "node:path";
import { fileURLToPath } from "node:url";
import { SystemStore, initialPasswordFromEmail, normalizeEmail, type UserRecord } from "./system-store.js";
import { ensureDefaultWorkspace } from "./workspace-template.js";

type AdminConfig = {
  baseUrl: string;
  systemRoot: string;
  workspacesRoot: string;
  legacyWorkspaceRoot: string;
  defaultScopes: string;
};

type ParsedArgs = {
  command: string;
  options: Map<string, string | boolean>;
};

const OAUTH_SCOPES = ["workspace:read", "workspace:write"];
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const defaultWorkspacesRoot = path.join(repoRoot, ".meditations-data", "workspaces");
const configuredWorkspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? path.join(process.env.WORKSPACES_ROOT ?? defaultWorkspacesRoot, "default"));
const configuredWorkspacesRoot = path.resolve(process.env.WORKSPACES_ROOT ?? path.dirname(configuredWorkspaceRoot));
const configuredSystemRoot = path.resolve(process.env.SYSTEM_ROOT ?? path.join(path.dirname(configuredWorkspacesRoot), "system"));

const config: AdminConfig = {
  baseUrl: process.env.BASE_URL ?? "http://localhost:8787",
  systemRoot: configuredSystemRoot,
  workspacesRoot: configuredWorkspacesRoot,
  legacyWorkspaceRoot: configuredWorkspaceRoot,
  defaultScopes: OAUTH_SCOPES.join(" ")
};

await main();

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const store = await SystemStore.open(config);
    try {
      const result = await runCommand(store, args);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      store.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    process.exitCode = 1;
  }
}

async function runCommand(store: SystemStore, args: ParsedArgs) {
  switch (args.command) {
    case "create":
      return createUser(store, required(args, "email"), required(args, "password"), Boolean(args.options.get("must-rotate")));
    case "create-derived": {
      const email = required(args, "email");
      return createUser(store, email, initialPasswordFromEmail(email), Boolean(args.options.get("must-rotate")), true);
    }
    case "show":
      return showUser(store, userIdentifier(args));
    case "reset-password": {
      const user = store.resetPassword(userIdentifier(args), required(args, "password"), Boolean(args.options.get("must-rotate")));
      return { ok: true, action: "reset-password", user: publicUser(user) };
    }
    case "disable": {
      const user = store.disableUser(userIdentifier(args));
      return { ok: true, action: "disable", user: publicUser(user) };
    }
    case "rotate-token": {
      const user = store.resolveUser(userIdentifier(args));
      const token = store.rotateMcpToken(user.id);
      const workspace = store.getWorkspaceById(token.workspaceId);
      return {
        ok: true,
        action: "rotate-token",
        user: publicUser(user),
        workspace,
        mcp: mcpConfig(token.token)
      };
    }
    default:
      throw new Error(usage());
  }
}

async function createUser(store: SystemStore, email: string, password: string, mustRotate: boolean, derived = false) {
  const result = store.createManualUser({
    email,
    password,
    passwordMustRotate: mustRotate,
    createdBy: "admin-cli"
  });
  await ensureDefaultWorkspace(result.workspace.rootPath);
  return {
    ok: true,
    action: derived ? "create-derived" : "create",
    user: publicUser(result.user),
    workspace: result.workspace,
    initialPassword: derived ? password : undefined,
    mcp: mcpConfig(result.mcpToken.token)
  };
}

function showUser(store: SystemStore, identifier: string) {
  const user = store.resolveUser(identifier);
  const workspace = store.getDefaultWorkspaceForUser(user.id);
  const token = user.status === "active" ? store.ensureActiveMcpToken(user.id, workspace.id) : "";
  return {
    ok: true,
    action: "show",
    user: publicUser(user),
    workspace,
    mcp: token ? mcpConfig(token) : undefined
  };
}

function mcpConfig(token: string) {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/mcp`;
  return {
    url,
    token,
    header: `Authorization: Bearer ${token}`,
    config: {
      mcpServers: {
        "ai-meditations": {
          url,
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      }
    }
  };
}

function publicUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    passwordMustRotate: Boolean(user.passwordMustRotate),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function userIdentifier(args: ParsedArgs) {
  const email = optional(args, "email");
  const userId = optional(args, "user-id");
  if (email && userId) throw new Error("provide either --email or --user-id, not both");
  if (email) return normalizeEmail(email);
  if (userId) return userId;
  throw new Error("missing --email or --user-id");
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? "";
  const options = new Map<string, string | boolean>();
  for (let index = 1; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) throw new Error(`unexpected argument: ${raw}`);
    const key = raw.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options.set(key, true);
    } else {
      options.set(key, next);
      index += 1;
    }
  }
  return { command, options };
}

function required(args: ParsedArgs, key: string) {
  const value = optional(args, key);
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function optional(args: ParsedArgs, key: string) {
  const value = args.options.get(key);
  return typeof value === "string" ? value : "";
}

function usage() {
  return [
    "usage:",
    "  admin create --email <email> --password <password> [--must-rotate]",
    "  admin create-derived --email <email> [--must-rotate]",
    "  admin show (--email <email> | --user-id <id>)",
    "  admin reset-password (--email <email> | --user-id <id>) --password <password> [--must-rotate]",
    "  admin disable (--email <email> | --user-id <id>)",
    "  admin rotate-token (--email <email> | --user-id <id>)"
  ].join("\n");
}
