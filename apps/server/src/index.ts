import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { brotliCompress, gzip } from "node:zlib";
import { WorkspaceSandbox } from "@ai-meditations/sandbox";
import type { AuditEvent, SandboxCommandResult, WorkspaceFileEntry } from "@ai-meditations/shared";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import matter from "gray-matter";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as z from "zod/v4";
import { AuthzError, assertWorkspaceBelongsToUser, mcpScopesToSandboxScope } from "./authz.js";
import { renderWorkspaceFile } from "./markdown.js";
import { SystemStore, normalizeEmail, tokenHash, type UserRecord, type WorkspaceRecord } from "./system-store.js";
import { ensureDefaultWorkspace as ensureWorkspaceTemplate } from "./workspace-template.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const repoRoot = path.resolve(__dirname, "../../..");
const gzipAsync = promisify(gzip);
const brotliCompressAsync = promisify(brotliCompress);
const defaultWorkspacesRoot = path.join(repoRoot, ".meditations-data", "workspaces");
const configuredWorkspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? path.join(process.env.WORKSPACES_ROOT ?? defaultWorkspacesRoot, "default"));
const configuredWorkspacesRoot = path.resolve(process.env.WORKSPACES_ROOT ?? path.dirname(configuredWorkspaceRoot));
const configuredSystemRoot = path.resolve(process.env.SYSTEM_ROOT ?? path.join(path.dirname(configuredWorkspacesRoot), "system"));
const configuredBackupsRoot = path.resolve(process.env.BACKUPS_ROOT ?? path.join(configuredSystemRoot, "backups"));

const config = {
  port: Number(process.env.PORT ?? 8787),
  baseUrl: process.env.BASE_URL ?? "http://localhost:8787",
  adminEmail: process.env.ADMIN_EMAIL ?? "local@example.com",
  adminPassword: process.env.ADMIN_PASSWORD ?? "local_dev_password",
  mcpToken: process.env.MCP_TOKEN ?? "local-dev-mcp-token",
  workspaceRoot: configuredWorkspaceRoot,
  systemRoot: configuredSystemRoot,
  backupsRoot: configuredBackupsRoot,
  backupRetentionCount: Number(process.env.BACKUP_RETENTION_COUNT ?? 14),
  backupHour: Number(process.env.BACKUP_HOUR ?? 3),
  backupMinute: Number(process.env.BACKUP_MINUTE ?? 30),
  workspacesRoot: configuredWorkspacesRoot,
  tokenEncryptionSecret: process.env.TOKEN_ENCRYPTION_SECRET ?? process.env.SESSION_SECRET ?? process.env.MCP_TOKEN ?? "local-dev-token-encryption-secret",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ?? `${process.env.BASE_URL ?? "http://localhost:8787"}/auth/google/callback`,
  googleAllowedEmails: parseCsvList(process.env.GOOGLE_ALLOWED_EMAILS)
};

assertProductionSecurityConfig();

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const GOOGLE_LOGIN_COOKIE = "google_login_state";
const GOOGLE_LOGIN_TTL_SECONDS = 10 * 60;
const AGENT_CONTEXT_ROOT = "self";
const LEGACY_AGENT_CONTEXT_ROOT = "docs/self";
const SOURCES_ROOT = "sources";
const SYSTEM_DOCUMENT_PATHS = new Set([AGENT_CONTEXT_ROOT, LEGACY_AGENT_CONTEXT_ROOT]);
const CHILD_DOCUMENTS_DIRECTORY = "sub_docs";
const DOCUMENT_ATTACHMENTS_DIRECTORY = "_attachments";
const DOCUMENT_AUXILIARY_DIRECTORIES = new Set([DOCUMENT_ATTACHMENTS_DIRECTORY, CHILD_DOCUMENTS_DIRECTORY]);
const CANONICAL_AGENT_CONTRACT = "AGENTS.md is the canonical operating contract. If any MCP/resource/help text conflicts with AGENTS.md, follow AGENTS.md and leave a note about the drift.";
const AGENT_DOCUMENT_LOOP = "read -> locate -> patch -> verify -> organize";
const RUN_SHELL_DSL_SUMMARY =
  "run_shell is a constrained document-workspace DSL, not bash. Core commands include workspace_health, inspect_doc, rg, toc, section, patch, replace_section, changes, and lint_doc.";
const STRUCTURED_WRITE_TOOLS_SUMMARY =
  "For large content or external CLI/JSON callers, prefer write_file and patch_file over embedding heredocs inside run_shell.";

const MCP_RUN_SHELL_DESCRIPTION = [
  "Run a limited filesystem command inside the user's AI Meditations workspace.",
  "This is not bash and cannot run arbitrary executables.",
  "",
  "LLM Wiki entry map:",
  "- Start with ai-meditations://llms.txt for the compact workspace map.",
  `- ${CANONICAL_AGENT_CONTRACT}`,
  "- Read ai-meditations://skills/wiki-maintenance before ingesting sources, answering from the wiki, or linting the wiki.",
  "- Use get_workspace_info when you need bootstrap pointers inside a tool call flow.",
  `- Standard document loop: ${AGENT_DOCUMENT_LOOP}.`,
  "",
  "Language policy:",
  "- System contracts, tool descriptions, and MCP resources are English-first for broad agent compatibility.",
  "- User documents may be in any language. Preserve the user's language and wording unless asked to translate.",
  "- When answering the user, follow the user's current language.",
  "",
  "Supported read commands: help, pwd, ls, tree, find, rg, cat, nl, head, tail, stat, diff, changes, workspace_health, inspect_doc, toc, section, lint_stale_append, lint_doc.",
  "Supported write commands: mkdir, touch, write, append, patch, patch_many, replace_section, mv, cp, archive.",
  RUN_SHELL_DSL_SUMMARY,
  STRUCTURED_WRITE_TOOLS_SUMMARY,
  "write, append, patch, patch_many, and replace_section require heredoc content; <<EOF and <<'EOF' are both accepted. Inline Markdown or JSON after the path is rejected.",
  "Choose a heredoc delimiter that does not appear alone in the body. If writing Markdown that contains literal EOF lines, use another delimiter such as DOC.",
  "Multiple commands are allowed in one call when each command starts on its own line. The whole batch is parsed before execution, so malformed trailing heredocs do not partially write earlier files.",
  "",
  "Karpathy-style layers:",
  "- sources/ is raw source material. Treat it as curated input; preserve provenance and avoid rewriting existing sources.",
  "- docs/ is the compiled wiki. Agents maintain summaries, concept pages, entity pages, decisions, and cross-links here.",
  "- AGENTS.md is the schema / operating contract.",
  "- journal/ is the chronological operation log for ingests, queries, lint passes, and document changes.",
  "- self/ is durable user context; archive/ is cooled-down material.",
  "- self/ is user-visible personal context, not hidden agent memory or an ordinary document. Read it when relevant; write only stable, durable user context.",
  "",
  "Reader contract:",
  "- Directory = document package; README.md = document body; sibling .md files = pages; sub_docs/<slug>/ directories = child documents.",
  "- _attachments/ stores files that belong to the current document and is not a child document.",
  "- The physical directory tree is the source of truth for parent/child relationships; do not create hidden JSON indexes or ID-only folders unless the user explicitly asks.",
  "- Durable README.md files may use frontmatter: title, summary, tags, status. Status values: active, draft, reference, archived.",
  "- Reader opens a directory as README.md plus sibling pages, and previews sub_docs/<slug>/ directories as child-document cards.",
  "- Child-document cards use sub_docs/<slug>/README.md frontmatter title/summary/tags/status when present, then fall back to # heading, first paragraph, and path tags.",
  "",
  "Safe operating loop:",
  "- Read the map and nearby files before writing.",
  "- Locate the right document package with inspect_doc, tree, rg, toc, and section before creating or editing files.",
  "- Ingest: preserve the raw source, compile the stable synthesis into docs, then append a journal event.",
  "- Query: answer from the compiled wiki first; consult sources only when citations or unresolved details are needed.",
  "- Lint: look for contradictions, stale claims, orphan pages, missing source links, and important concepts without pages.",
  "- Anti-entropy rule: default to journal for fresh context, promote stable reusable knowledge into docs, preserve source material in sources, and write to self only for durable user memory.",
  "- Prefer patch/append over whole-file rewrites. Create new files or directories only when the content has a clear durable home.",
  "- Verify after writing with changes, inspect_doc, toc, and lint_doc on the changed package or file.",
  "- For broad or risky edits, use diff/changes first and rely on workspace backups/snapshots rather than assuming edits are reversible forever.",
  "- For git-style unified diff patch syntax, legacy JSON patch syntax, and multiline examples, run help patch.",
  "- For section-level replacement, run help replace_section.",
  "- For batch atomic exact replacements, run help patch_many.",
  "- For line-numbered reading, run nl <file> or cat -n <file>.",
  "- For search context, run rg -C 2 <keyword> <path>.",
  "- For document package structure, run inspect_doc <path>.",
  "- For Markdown structure navigation, run toc <file> and section <file> \"## Heading\".",
  "- For proposed full-file replacement review, run diff <file> <<EOF ... EOF.",
  "- For this session's write review, run changes or diff <file>.",
  "",
  "Recommended first commands:",
  "help",
  "help document-package",
  "help wiki",
  "help patch",
  "help replace_section",
  "help patch_many",
  "help rg",
  "help diff",
  "help changes",
  "help workspace_health",
  "help inspect_doc",
  "cat AGENTS.md",
  "nl AGENTS.md",
  "tree docs --depth 2",
  "tree sources --depth 2",
  "cat self/README.md",
  "tree journal --depth 3",
  "cat docs/README.md",
  "workspace_health",
  "inspect_doc docs",
  "",
  "Before workspace cleanup, read MCP resource ai-meditations://skills/organize-workspace."
].join("\n");

const WORKSPACE_INFO_BASE_TEXT = [
  "# AI Meditations LLM Wiki Map",
  "",
  "AI Meditations is a private Markdown memory workspace shaped as a Karpathy-style LLM Wiki.",
  "This response is a compact LLM map, not the canonical rulebook.",
  `Canonical source: ${CANONICAL_AGENT_CONTRACT}`,
  "Language policy: MCP system contracts are English-first; user documents may be in any language; preserve user language and answer in the user's current language.",
  `Standard document loop: ${AGENT_DOCUMENT_LOOP}.`,
  "",
  "## MCP Surface",
  "",
  "- Tool: get_workspace_info returns this LLM map.",
  "- Tool: get_workspace_info includes a current workspace_health entropy snapshot so newly connected agents can orient before editing.",
  "- Tool: run_shell runs a limited file command interpreter. It is not bash.",
  "- Tool: write_file writes or appends UTF-8 text using structured JSON fields. Prefer it for large content and external CLI callers.",
  "- Tool: patch_file applies exact-text old_text/new_text replacement using structured JSON fields.",
  `- Inner DSL: ${RUN_SHELL_DSL_SUMMARY}`,
  `- Structured write guidance: ${STRUCTURED_WRITE_TOOLS_SUMMARY}`,
  `- Protocol: ${AGENT_DOCUMENT_LOOP}. Use inspect_doc before creating files in an unfamiliar area.`,
  "- Resource: ai-meditations://llms.txt is the shortest LLM-facing entrypoint.",
  "- Resource: ai-meditations://workspace/info mirrors this map.",
  "- Resource: ai-meditations://skills/wiki-maintenance gives the ingest/query/lint workflow.",
  "- Resource: ai-meditations://skills/organize-workspace gives the cleanup workflow.",
  "- Resource template: ai-meditations://file/{path} reads Markdown by workspace path.",
  "",
  "## Read Order",
  "",
  "1. ai-meditations://llms.txt",
  "2. AGENTS.md",
  "3. docs/README.md",
  "4. sources/README.md",
  "5. self/README.md",
  "6. journal/README.md",
  "7. Nearby README.md files, sibling pages, child documents, and source files relevant to the task.",
  "",
  "## LLM Wiki Layers",
  "",
  "- sources/: raw source material. Preserve provenance; avoid rewriting existing sources.",
  "- docs/: compiled wiki. Agents maintain stable synthesis, concept pages, entity pages, decisions, and cross-links here.",
  "- AGENTS.md: schema / operating contract for how agents maintain the wiki.",
  "- journal/: chronological operation log for ingests, queries, lint passes, document changes, and uncertain context.",
  "- self/: user-visible agent context for durable preferences, principles, and working style.",
  "- archive/: cooled-down or historical material.",
  "- .meditations/: reserved system metadata.",
  "",
  "## Authoritative Files",
  "",
  "- AGENTS.md: canonical agent operating contract and writing rules.",
  "- docs/README.md: compiled wiki index and active document overview.",
  "- sources/README.md: source layer policy and source note convention.",
  "- self/README.md: scope and rules for durable user context.",
  "- journal/README.md: timeline and daily note convention.",
  "",
  "## Standard Operations",
  "",
  "- Ingest: read or create the source in sources/, update relevant compiled wiki pages in docs/, update docs/README.md when discoverability changes, then append a journal event.",
  "- Query: search and read docs/ first, consult sources/ for citations or unresolved details, answer with file references, and offer to file durable synthesis back into docs/.",
  "- Lint: inspect docs/ and journal/ for contradictions, stale claims, orphan documents, missing cross-links, missing source links, wrong-layer writes, broken links, and concepts that deserve pages.",
  "",
  "## Write Policy",
  "",
  "- System guidance is English-first for broad agent compatibility. Do not translate user-authored documents unless the user asks.",
  "- Preserve the user's language, wording, and uncertainty in notes and summaries.",
  "- Read broadly; write sparingly.",
  "- Preserve raw source material in sources/. Prefer new source notes over editing old source notes.",
  "- Default fresh or uncertain context to journal/YYYY/MM/YYYY-MM-DD.md.",
  "- Promote stable reusable knowledge into docs/ when it has a clear durable home.",
  "- Write self/ only for stable user preferences, principles, durable context, or explicit memory requests.",
  "- Prefer append for journal events and patch for durable edits. Use write_file for large structured content from MCP clients. Use write for new files or intentional replacement only.",
  "- Before creating a page or child document, run inspect_doc on the parent package.",
  "- After edits, run changes and lint_doc on the changed file or package.",
  "- Multi-command write batches roll back on execution failure, but successful edits still need review; use backups/snapshots for broad recovery.",
  "- Never paste raw chat transcripts. Distill decisions, state, open questions, links, and reusable context.",
  "",
  "## Reader Contract",
  "",
  "- Directory = document package; README.md = body; sibling .md files = pages; sub_docs/<slug>/ directories = child documents.",
  "- _attachments/ stores files that belong to the current document and is not a child document.",
  "- The physical directory tree is the source of truth. Do not create hidden JSON indexes, node manifests, or ID-only folders unless the user explicitly asks.",
  "- Reader opens a directory as README.md plus sibling pages.",
  "- Reader previews sub_docs/<slug>/ directories as child-document cards.",
  "- Child-document cards prefer README frontmatter title/summary/tags/status, then fall back to heading, first paragraph, and path tags.",
  "",
  "## Protected Layout",
  "",
  "- docs, sources, self, journal, archive, AGENTS.md, and index.md must not be moved or archived unless the user explicitly requests it.",
  "- self is special agent context: user-visible, agent-readable, and conservative to update.",
  "",
  "## Cleanup",
  "",
  "- Before workspace cleanup, read ai-meditations://skills/organize-workspace.",
  "- Prefer patch/append/mv with clear rationale over broad rewrites.",
  "",
  "## First Shell Commands",
  "",
  "- help",
  "- help document-package",
  "- help wiki",
  "- help patch",
  "- help replace_section",
  "- help patch_many",
  "- help rg",
  "- help diff",
  "- help changes",
  "- help workspace_health",
  "- help inspect_doc",
  "- cat AGENTS.md",
  "- nl AGENTS.md",
  "- cat docs/README.md",
  "- cat sources/README.md",
  "- cat self/README.md",
  "- cat journal/README.md",
  "- workspace_health",
  "- tree docs --depth 3",
  "- inspect_doc docs",
  "- tree sources --depth 3",
  "- tree journal --depth 4",
  "- tree archive --depth 3",
  "- rg <keyword> docs sources self journal",
  "- rg -C 2 <keyword> docs sources self journal",
  "- inspect_doc docs/<slug>",
  "- lint_doc docs/<slug>",
  "- toc docs/README.md",
  "- changes"
].join("\n");

async function workspaceInfoText(sandbox: WorkspaceSandbox) {
  const health = await sandbox.run("workspace_health", { scope: "read" });
  const snapshot = health.ok
    ? health.stdout
    : [
        "# Workspace Entropy Snapshot",
        "",
        "status: unavailable",
        `workspace_health failed: ${health.stderr ?? "unknown error"}`
      ].join("\n");

  return [
    WORKSPACE_INFO_BASE_TEXT,
    "",
    "## Current Entropy Snapshot",
    "",
    "This section is generated at connection time. Use it to decide whether to inspect or clean up before editing.",
    "",
    snapshot
  ].join("\n");
}

const LLMS_TXT_RESOURCE_TEXT = [
  "# AI Meditations",
  "",
  "> Private Karpathy-style LLM Wiki: raw sources in, compiled Markdown wiki out.",
  "",
  "## Purpose",
  "",
  "AI Meditations stores human memory as Markdown. Agents access it through MCP as a predictable file workspace and maintain a compiled wiki over raw sources.",
  "System-facing MCP guidance is English-first; user-authored workspace documents may be Chinese, English, or any other language. Preserve the user's language and answer in the user's current language.",
  CANONICAL_AGENT_CONTRACT,
  `Standard document loop: ${AGENT_DOCUMENT_LOOP}.`,
  "",
  "## Start Here",
  "",
  "- Canonical rules: `AGENTS.md`.",
  "- Workspace map: `ai-meditations://workspace/info` or `get_workspace_info`.",
  "- Current entropy snapshot: call `get_workspace_info` or run `workspace_health`.",
  "- Wiki workflow: `ai-meditations://skills/wiki-maintenance`.",
  "- Cleanup workflow: `ai-meditations://skills/organize-workspace`.",
  "- File reader: `ai-meditations://file/{path}`.",
  "- Structured file writer: `write_file` for JSON-safe multiline content, including optional `content_base64`.",
  "- Structured exact patcher: `patch_file` with `old_text` and `new_text` JSON fields.",
  "- Shell-like document DSL: `run_shell` with limited commands. It is not bash.",
  "- Document inspector: `run_shell` command `inspect_doc <path>`.",
  `- Inner DSL: ${RUN_SHELL_DSL_SUMMARY}`,
  "",
  "## Architecture",
  "",
  "- `sources/`: raw source layer. Curated input, provenance, minimal mutation.",
  "- `docs/`: compiled wiki layer. Stable synthesis, concept pages, entity pages, decisions, and cross-links.",
  "- `AGENTS.md`: schema layer. The operating contract for agents.",
  "- `journal/`: operation log. Ingests, queries, lint passes, changes, and unsettled context.",
  "- `self/`: user-visible Agent context. Use only for durable preferences, principles, and long-lived user context.",
  "- `archive/`: cooled-down or historical material.",
  "",
  "## Operations",
  "",
  "- Ingest: preserve or create a source, update the compiled wiki by editing document packages, append a journal event.",
  "- Query: search/read the compiled wiki first, consult sources for citations, then optionally file durable synthesis back into docs.",
  "- Lint: find contradictions, stale claims, orphan pages, missing cross-links, missing source links, wrong-layer writes, broken links, and concepts without pages.",
  "",
  "## Document Model",
  "",
  "- Directory = document package.",
  "- `README.md` = document body.",
  "- Sibling `.md` files = same-document pages.",
  "- `sub_docs/<slug>/` directories = child documents.",
  "- `_attachments/` = files that belong to the current document; not a child document.",
  "- The physical directory tree is the source of truth for parent/child relationships.",
  "- Reader cards use README frontmatter `title`, `summary`, `tags`, and `status` when available.",
  "",
  "## Write Policy",
  "",
  "- Read nearby README files before writing.",
  "- Run `inspect_doc <path>` before creating a sibling page or child document in an unfamiliar package.",
  "- Preserve raw material in `sources/`; do not use it as a dumping ground for chat residue.",
  "- Default fresh context to `journal/YYYY/MM/YYYY-MM-DD.md`.",
  "- Compile stable reusable knowledge into `docs/`.",
  "- Update `self/` sparingly and only for durable user context.",
  "- Prefer `append` for journal events and `patch` for durable edits.",
  "- After writing, run `changes` and `lint_doc <changed-path>`.",
  "- For broad edits, use `diff`, `changes`, and workspace backups/snapshots instead of assuming manual rollback will be easy.",
  "- Never paste raw chat transcripts; distill state, decisions, open questions, links, and reusable context.",
  "",
  "## First Commands",
  "",
  "```text",
  "help",
  "help document-package",
  "help wiki",
  "cat AGENTS.md",
  "cat docs/README.md",
  "cat sources/README.md",
  "cat self/README.md",
  "cat journal/README.md",
  "workspace_health",
  "inspect_doc docs",
  "nl AGENTS.md",
  "tree docs --depth 2",
  "tree sources --depth 2",
  "tree journal --depth 3",
  "rg <keyword> docs sources self journal",
  "rg -C 2 <keyword> docs sources self journal",
  "lint_doc docs/<slug>",
  "```",
  "",
  "## Safety",
  "",
  "- `run_shell` is not bash and cannot run arbitrary executables.",
  "- Use `write_file` for large content from external MCP clients instead of nesting heredocs inside JSON command strings.",
  "- Use `patch_file` for exact old_text/new_text edits from external MCP clients.",
  "- Absolute paths and `..` are rejected.",
  "- `docs/`, `sources/`, `self/`, `journal/`, `archive/`, `AGENTS.md`, and `index.md` are protected roots unless the user explicitly asks otherwise.",
  "- For git-style unified diff patch syntax or legacy JSON patch syntax, run `help patch`.",
  "- For line-numbered reading, run `nl <file>` or `cat -n <file>`.",
  "- For contextual search, run `rg -C 2 <keyword> <path>`.",
  "- For full-file replacement review, run `diff <file> <<EOF ... EOF` before `write`."
].join("\n");

const WIKI_MAINTENANCE_SKILL_TEXT = [
  "# Skill: Maintain AI Meditations LLM Wiki",
  "",
  "Use this skill when the user asks an agent to ingest material, answer from the knowledge base, compile knowledge, or health-check the wiki.",
  "This follows the Karpathy LLM Wiki pattern: raw sources are preserved, the wiki is compiled once and kept current, and the schema tells agents how to maintain it.",
  "Language policy: this skill is English-first for agent compatibility. Preserve user-authored language in workspace files and answer in the user's current language.",
  CANONICAL_AGENT_CONTRACT,
  `Standard document loop: ${AGENT_DOCUMENT_LOOP}.`,
  "",
  "## Three Layers",
  "",
  "- `sources/`: raw source material. Preserve provenance and avoid rewriting existing source files.",
  "- `docs/`: compiled wiki. Agents maintain stable summaries, concept pages, entity pages, decisions, comparisons, and cross-links.",
  "- `AGENTS.md`: schema / operating contract. Read it before changing the wiki.",
  "",
  "Supporting layers:",
  "",
  "- `journal/`: chronological operation log for ingests, queries, lint passes, document changes, and unsettled context.",
  "- `self/`: durable user-visible Agent context, updated sparingly.",
  "- `archive/`: cooled-down or historical material.",
  "",
  "## Source Note Convention",
  "",
  "When the user provides material that should become a source, prefer this path shape unless a better local convention exists:",
  "",
  "```text",
  "sources/YYYY/MM/YYYY-MM-DD-<short-slug>.md",
  "```",
  "",
  "Recommended source frontmatter:",
  "",
  "```markdown",
  "---",
  "title: Source title",
  "type: article | conversation | meeting | note | file | web | other",
  "date: YYYY-MM-DD",
  "status: raw",
  "tags: [source]",
  "source_url:",
  "---",
  "```",
  "",
  "Do not paste huge raw transcripts into `docs/`. If a raw transcript must be preserved, put it in `sources/` with provenance and compile the useful synthesis into `docs/`.",
  "",
  "## Ingest Workflow",
  "",
  "1. Read `AGENTS.md`, `docs/README.md`, `sources/README.md`, and nearby wiki pages.",
  "2. If the material is not already in `sources/`, create a source note with provenance.",
  "3. Extract durable claims, entities, concepts, decisions, contradictions, and open questions.",
  "4. Run `inspect_doc <parent>` before adding a sibling page or child document.",
  "5. Update the relevant `docs/` pages with stable synthesis and links back to source files.",
  "6. Create a new docs page only when the concept or entity has durable independent value.",
  "7. Update `docs/README.md` when discoverability changes.",
  "8. Run `changes` and `lint_doc <changed-path>` after writing.",
  "9. Append a journal event recording the ingest and changed files.",
  "",
  "## Query Workflow",
  "",
  "1. Read `docs/README.md` and use `rg` over `docs/` first.",
  "2. Read relevant compiled wiki pages before opening raw sources.",
  "3. Consult `sources/` only for citations, provenance, or unresolved details.",
  "4. Answer with file references and uncertainty where needed.",
  "5. If the answer produces durable synthesis, update or create a `docs/` page and append a journal event.",
  "",
  "## Lint Workflow",
  "",
  "Look for:",
  "",
  "- Contradictions between pages.",
  "- Claims in `docs/` with no source link when provenance matters.",
  "- Stale claims superseded by newer sources or journal decisions.",
  "- Orphan documents with no inbound or obvious parent links.",
  "- Important recurring concepts that lack a page.",
  "- Raw notes in `journal/` that should be promoted into `docs/`.",
  "- Personal facts in `docs/` that belong in `self/`, or uncertain personal facts that should stay out of `self/`.",
  "- Same-document pages confused with child documents.",
  "- Missing README.md files in document packages.",
  "- Page-heavy document packages that should be split into child documents.",
  "- Broken relative Markdown links.",
  "",
  "Write lint results as a concise journal event first. Only reorganize files when the user asks or the local destination is obvious.",
  "",
  "## Useful Commands",
  "",
  "```text",
  "cat AGENTS.md",
  "cat docs/README.md",
  "cat sources/README.md",
  "tree docs --depth 3",
  "tree sources --depth 3",
  "rg <keyword> docs sources journal",
  "rg -C 2 <keyword> docs sources journal",
  "inspect_doc docs/<slug>",
  "toc docs/<slug>/README.md",
  "section docs/<slug>/README.md \"## Heading\"",
  "lint_doc docs/<slug>",
  "changes",
  "nl docs/README.md",
  "diff docs/page.md <<EOF",
  "# proposed full file content",
  "EOF",
  "help patch",
  "```"
].join("\n");

const ORGANIZE_WORKSPACE_SKILL_TEXT = [
  "# Skill: Organize AI Meditations Workspace",
  "",
  "Use this skill when a user asks an agent to organize, clean up, migrate, or reduce entropy in an AI Meditations workspace.",
  "The goal is to make the workspace easier for both humans and agents to keep using over time.",
  "Language policy: system guidance is English-first, but user-authored documents keep their original language. Do not translate content during cleanup unless asked.",
  CANONICAL_AGENT_CONTRACT,
  `Standard cleanup loop: ${AGENT_DOCUMENT_LOOP}.`,
  RUN_SHELL_DSL_SUMMARY,
  "",
  "## Operating Principles",
  "",
  "- Preserve user intent. Do not delete content during cleanup.",
  "- Prefer small reversible moves, precise patches, and explicit archive notes.",
  "- Keep raw file-system access as the source of truth; do not invent product-specific APIs.",
  "- Preserve `sources/` as raw input; move compiled, stable synthesis into `docs/` instead of editing sources into summaries.",
  "- Reduce future entropy, not just today's visual clutter.",
  "- Distill chat residue into state, decisions, open questions, links, and reusable knowledge.",
  "- Never fabricate user preferences or personal facts.",
  "",
  "## When To Use",
  "",
  "- The user asks to organize the workspace, tidy files, clean docs, migrate local notes, or summarize the current space.",
  "- There are too many top-level docs, duplicate files, generated profile pages, or unclear README files.",
  "- Journal content has become stable enough to promote into a durable document.",
  "- Child documents lack frontmatter needed by the Reader card UI.",
  "- `workspace_health` reports connection-time entropy signals.",
  "- `inspect_doc` reports structural suggestions.",
  "- `lint_doc` reports `[error]`, `[warn]`, or `[info]` issues.",
  "",
  "## Entropy Signals",
  "",
  "Treat these as signals to inspect before changing files:",
  "",
  "- `[error] document-package`: missing README.md or malformed document package. Fix before adding content.",
  "- `[error] link`: broken relative Markdown link. Repair or remove the link.",
  "- `[warn] placement`: content may be in the wrong layer, such as journal residue in docs/ or synthesis in sources/.",
  "- `[warn] document-package`: too many same-document pages or child documents without a proper body.",
  "- `[warn] stale-state`: repeated current-state/next-step sections or completed work still listed as pending.",
  "- `[info] reader-card`: missing summary/tags. Improve when the child document is important for humans.",
  "- `[info] document-size`: heading-heavy pages. Split only when navigation is genuinely suffering.",
  "",
  "Do not blindly apply every lint suggestion. Use lint severity to decide how aggressively to act.",
  "",
  "## Hard Limits",
  "",
  "- Do not remove docs/, sources/, self/, journal/, archive/, AGENTS.md, or root README/index files.",
  "- Do not move or archive broad areas without explicit user permission.",
  "- Do not rewrite a whole file when a patch can make the change.",
  "- Do not paste raw chat transcripts into docs.",
  "- Do not promote inferred or low-confidence personal information into self/.",
  "- Do not create a new top-level document for a passing thought or a one-off event.",
  "",
  "## First Audit",
  "",
  "Run these commands before changing structure:",
  "",
  "```text",
  "cat AGENTS.md",
  "help document-package",
  "tree docs --depth 3",
  "tree sources --depth 3",
  "tree journal --depth 4",
  "tree archive --depth 3",
  "cat docs/README.md",
  "cat sources/README.md",
  "cat journal/README.md",
  "workspace_health",
  "inspect_doc docs",
  "lint_doc docs",
  "```",
  "",
  "Then inspect likely target packages before creating or moving anything:",
  "",
  "```text",
  "inspect_doc docs/<slug>",
  "toc docs/<slug>/README.md",
  "lint_doc docs/<slug>",
  "```",
  "",
  "## Classification Rules",
  "",
  "- Stable reusable knowledge belongs in docs/.",
  "- Raw source material belongs in sources/ and should be preserved with provenance.",
  "- Fresh, time-based, uncertain, or session-shaped material belongs in journal/YYYY/MM/YYYY-MM-DD.md.",
  "- Durable user preferences, principles, and long-lived personal context may go in self/, but only sparingly. Treat it as user-visible agent context, never hidden agent memory.",
  "- Low-confidence generated profiles, imports, obsolete experiments, and cooled-down material belong in archive/ with an explanatory README.",
  "- Product implementation details should stay under the product document instead of becoming root docs.",
  "",
  "Severity response:",
  "",
  "- `[error]`: fix during cleanup unless the user explicitly says not to.",
  "- `[warn]`: inspect and fix when the destination is obvious; otherwise record a journal note.",
  "- `[info]`: improve opportunistically only when it helps Reader navigation or future agents.",
  "",
  "## Document Package Rules",
  "",
  "- Directory = document package.",
  "- README.md = main body of that document package.",
  "- Sibling .md files = pages in the same document.",
  "- sub_docs/<slug>/ directories = child documents.",
  "- _attachments/ = files that belong to the current document and are hidden from child-document navigation.",
  "- Use <parent>/sub_docs/<slug>/README.md for a child document.",
  "- Use <parent>/<page>.md for a same-document page.",
  "- If a continuation is small, patch the README or add a sibling page instead of creating a child document.",
  "- If a package has many same-document pages, use `inspect_doc` suggestions to decide which durable subtopics deserve child document packages.",
  "- A same-document page is not a child document. Do not move it under a directory unless the content has a durable independent shape.",
  "",
  "## Reader Card Metadata",
  "",
  "For important child documents, add concise frontmatter so the human Reader can show useful preview cards:",
  "",
  "```markdown",
  "---",
  "title: Clear Document Title",
  "summary: One sentence explaining what this document is for.",
  "tags: [product, mcp, reader]",
  "status: active",
  "---",
  "```",
  "",
  "Card title falls back from frontmatter title to the first # heading to the directory name.",
  "Card summary falls back from frontmatter summary to the first prose paragraph.",
  "Card tags fall back from frontmatter tags to lightweight path-derived tags.",
  "Status values are advisory: active, draft, reference, archived.",
  "",
  "## Safe Actions",
  "",
  "- Add or improve frontmatter summary/tags on important README files.",
  "- Patch parent README overview sections when moving or adding child documents.",
  "- Move low-confidence or generated material to archive/<reason>/ and create an archive README explaining why.",
  "- Append a journal entry describing what was organized and why.",
  "- Append implementation-log notes when the cleanup changes product behavior, docs, or MCP contract.",
  "- Link journal events to durable document pages instead of duplicating long content.",
  "- Use multi-command batches for small related edits; if a later command fails, write changes in that batch are rolled back.",
  "- For broad or risky cleanup, create or rely on workspace backups/snapshots and inspect `changes` before finalizing.",
  "",
  "## Cleanup Playbooks",
  "",
  "Page-heavy document package:",
  "",
  "```text",
  "inspect_doc docs/<slug>",
  "lint_doc docs/<slug>",
  "toc docs/<slug>/README.md",
  "tree docs/<slug> --depth 2",
  "```",
  "",
  "Then move only durable independent subtopics into child documents. Keep small continuations as sibling pages or README sections.",
  "",
  "Wrong-layer write:",
  "",
  "```text",
  "lint_doc docs/<path-or-package>",
  "inspect_doc docs/<parent>",
  "inspect_doc journal",
  "```",
  "",
  "Move session residue to journal/ when it is time-shaped. Compile only stable synthesis back into docs/.",
  "",
  "Broken link repair:",
  "",
  "```text",
  "lint_doc docs/<slug>",
  "rg \"link text or target\" docs sources journal",
  "patch <<'EOF'",
  "--- a/docs/<file>.md",
  "+++ b/docs/<file>.md",
  "@@ -1,3 +1,3 @@",
  " # Title",
  " ",
  "-old link",
  "+new link",
  "EOF",
  "```",
  "",
  "Reader-card cleanup:",
  "",
  "```text",
  "inspect_doc docs/<parent>",
  "patch <<'EOF'",
  "--- a/docs/<child>/README.md",
  "+++ b/docs/<child>/README.md",
  "@@ -1,1 +1,6 @@",
  "+---",
  "+summary: One sentence.",
  "+tags: [tag]",
  "+---",
  "+",
  " # Title",
  "EOF",
  "```",
  "",
  "## Command Patterns",
  "",
  "Create an archive bucket:",
  "",
  "```text",
  "mkdir archive/<reason>",
  "write archive/<reason>/README.md <<EOF",
  "# Archive Reason",
  "",
  "Why this material was archived and what should happen before restoring it.",
  "EOF",
  "```",
  "",
  "Move a low-confidence document:",
  "",
  "```text",
  "mv docs/<old-slug> archive/<reason>/<old-slug>",
  "```",
  "",
  "Add Reader card metadata:",
  "",
  "```text",
  "patch <<'EOF'",
  "--- a/docs/<slug>/README.md",
  "+++ b/docs/<slug>/README.md",
  "@@ -1,1 +1,6 @@",
  "+---",
  "+summary: One sentence.",
  "+tags: [tag]",
  "+---",
  "+",
  " # Title",
  "EOF",
  "```",
  "",
  "Patch syntax notes:",
  "",
  "- `<<EOF` and `<<'EOF'` are both accepted.",
  "- Prefer git-style unified diff bodies with `---` / `+++` headers and `@@` hunks.",
  "- `patch <<EOF ... EOF` may apply multiple file patches in one command.",
  "- `patch <file> <<EOF ... EOF` may use hunk-only unified diff for one explicit file.",
  "- Legacy JSON `{old_text,new_text}` is still accepted for exact replacements.",
  "- In JSON mode, use `\\n` for newlines and escape quotes/backslashes.",
  "- If a hunk or `old_text` fails, use the closest candidate lines from the error or run `rg <phrase> <file>` and regenerate the diff against current content.",
  "- Prefer `replace_section` when updating a whole Markdown section.",
  "- Run `changes` and `lint_doc <path>` after edits.",
  "",
  "Append a cleanup journal event:",
  "",
  "```text",
  "append journal/YYYY/MM/YYYY-MM-DD.md <<EOF",
  "",
  "## HH:mm Workspace cleanup",
  "type: change",
  "status: settled",
  "tags: [workspace, cleanup]",
  "links:",
  "- docs/README.md",
  "",
  "- What changed.",
  "- Why it reduces entropy.",
  "- What remains open.",
  "EOF",
  "```",
  "",
  "## Final Verification",
  "",
  "Run these commands after cleanup:",
  "",
  "```text",
  "tree docs --depth 3",
  "tree journal --depth 4",
  "tree archive --depth 3",
  "cat docs/README.md",
  "inspect_doc docs",
  "lint_doc docs",
  "changes --stat",
  "```",
  "",
  "If files were moved, verify key old and new paths. If journal or implementation logs were changed, tail the files.",
  "If cleanup touched many files, report that successful edits are not automatically reversible and point to backups/snapshots if broad recovery is needed.",
  "",
  "## Final Response Shape",
  "",
  "Report:",
  "",
  "- What changed.",
  "- What was archived and why.",
  "- What was left untouched.",
  "- Any residual risk or follow-up cleanup."
].join("\n");

type Session = {
  id: string;
  userId: string;
  workspaceId: string;
  email: string;
  createdAt: number;
  expiresAt: number;
};

type WorkspaceContext = {
  user: UserRecord;
  workspace: WorkspaceRecord;
  sandbox: WorkspaceSandbox;
};

type McpAuthContext = WorkspaceContext & {
  actorId: string;
  scopes: string;
};

type GoogleLoginState = {
  state: string;
  nonce: string;
  returnTo: string;
  createdAt: number;
};

type McpSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  auth: McpAuthContext;
  createdAt: number;
  lastSeenAt: number;
};

type OAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  scope: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  clientSecretHash?: string;
  createdAt: number;
};

type OAuthAuthorizationCode = {
  code: string;
  clientId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scope: string;
  resource: string;
  expiresAt: number;
};

type OAuthTokenRecord = {
  accessTokenHash: string;
  refreshTokenHash?: string;
  clientId: string;
  userId: string;
  workspaceId: string;
  scope: string;
  resource: string;
  createdAt: number;
  expiresAt: number;
  refreshExpiresAt?: number;
};

type OAuthState = {
  clients: OAuthClient[];
  tokens: OAuthTokenRecord[];
};

type JournalBlockType = "session" | "change" | "decision" | "question" | "note";
type JournalBlockStatus = "pending" | "settled";

type JournalBlock = {
  id: string;
  sourcePath: string;
  line: number;
  date: string;
  title: string;
  type: JournalBlockType;
  status: JournalBlockStatus;
  tags: string[];
  links: string[];
  body: string;
  excerpt: string;
};

type ChildDocumentCard = {
  path: string;
  readmePath?: string;
  title: string;
  summary: string;
  status?: string;
  tags: string[];
  updatedAt: string;
  pageCount: number;
  childCount: number;
};

type DocumentPage = {
  sourcePath: string;
  displayPath: string;
  html: string;
  depth: number;
  pageNumber: number;
};

type DocumentPackage = {
  path: string;
  entries: WorkspaceFileEntry[];
  siblingDocuments: ChildDocumentCard[];
  childDocuments: ChildDocumentCard[];
  pages: DocumentPage[];
};

const sessions = new Map<string, Session>();
const mcpSessions = new Map<string, McpSession>();
const oauthClients = new Map<string, OAuthClient>();
const oauthCodes = new Map<string, OAuthAuthorizationCode>();
const oauthAccessTokens = new Map<string, OAuthTokenRecord>();
const oauthRefreshTokens = new Map<string, OAuthTokenRecord>();
const sandboxCache = new Map<string, WorkspaceSandbox>();
const MCP_SESSION_TTL_MS = 30 * 60 * 1000;
const WEB_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_CODE_TTL_MS = 10 * 60 * 1000;
const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_SCOPES = ["workspace:read", "workspace:write"];
const MAX_EXPANDED_PAGES = 60;
const MAX_EXPAND_DEPTH = 4;
const MIN_COMPRESSIBLE_BYTES = 1024;

const systemStore = await SystemStore.open({
  systemRoot: config.systemRoot,
  workspacesRoot: config.workspacesRoot,
  legacyWorkspaceRoot: config.workspaceRoot,
  defaultScopes: OAUTH_SCOPES.join(" "),
  tokenEncryptionSecret: config.tokenEncryptionSecret
});
systemStore.deleteExpiredWebSessions();
systemStore.ensureDefaultOwner((config.googleAllowedEmails[0] || config.adminEmail).toLowerCase(), config.mcpToken);
const defaultWorkspace = systemStore.getDefaultWorkspace();
await ensureWorkspaceTemplate(defaultWorkspace.rootPath);
await loadOAuthState();
scheduleDailyBackups();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AuthzError) {
      sendJson(res, 403, { error: message });
      return;
    }
    sendJson(res, 500, { error: message });
  }
});

server.listen(config.port, () => {
  console.log(`AI Meditations server listening on ${config.baseUrl}`);
  console.log(`Login email: ${config.adminEmail}`);
});

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", config.baseUrl);

  if (isOAuthDiscoveryPath(url.pathname) || url.pathname.startsWith("/oauth/")) {
    return handleOAuth(req, res, url);
  }

  if (req.method === "GET" && url.pathname === "/api/auth/providers") return authProviders(req, res);
  if (req.method === "GET" && url.pathname === "/api/bootstrap") return bootstrap(req, res, url);
  if (url.pathname.startsWith("/auth/google/")) return handleGoogleAuth(req, res, url);
  if (req.method === "POST" && url.pathname === "/api/login") return login(req, res);
  if (req.method === "POST" && url.pathname === "/api/logout") return logout(req, res);
  if (url.pathname === "/mcp") return handleMcp(req, res);

  if (url.pathname.startsWith("/api/")) {
    const context = await requireWebContext(req, res);
    if (!context) return;
    return handleApi(req, res, url, context);
  }

  return serveStatic(req, res, url);
}

function authProviders(_req: http.IncomingMessage, res: http.ServerResponse) {
  return sendJson(res, 200, authProvidersPayload());
}

function authProvidersPayload() {
  return {
    google: {
      enabled: isGoogleLoginEnabled()
    },
    password: {
      enabled: true
    }
  };
}

async function bootstrap(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const providers = authProvidersPayload();
  const session = sessionFromRequest(req);
  if (!session) return sendJson(res, 200, { user: null, providers });

  const context = await getSessionWorkspaceContext(session);
  const requestedPath = url.searchParams.get("path") ?? "docs";
  const document = await buildDocumentPackage(context.sandbox, requestedPath);
  return sendJson(res, 200, {
    user: { id: context.user.id, email: session.email },
    providers,
    document
  });
}

async function handleGoogleAuth(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (req.method === "GET" && url.pathname === "/auth/google/start") return startGoogleLogin(res, url);
  if (req.method === "GET" && url.pathname === "/auth/google/callback") return completeGoogleLogin(req, res, url);
  return sendJson(res, 404, { error: "not found" });
}

function startGoogleLogin(res: http.ServerResponse, url: URL) {
  if (!isGoogleLoginEnabled()) {
    return sendHtml(res, 503, googleLoginErrorPage("Google sign-in is not configured yet."));
  }

  const state: GoogleLoginState = {
    state: randomBytes(24).toString("base64url"),
    nonce: randomBytes(24).toString("base64url"),
    returnTo: safeReturnPath(url.searchParams.get("return_to")),
    createdAt: Date.now()
  };

  setCookie(res, GOOGLE_LOGIN_COOKIE, encodeGoogleLoginState(state), {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: GOOGLE_LOGIN_TTL_SECONDS,
    secure: isSecurePublicBaseUrl()
  });

  const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  authorizationUrl.searchParams.set("client_id", config.googleClientId);
  authorizationUrl.searchParams.set("redirect_uri", config.googleRedirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", "openid email profile");
  authorizationUrl.searchParams.set("state", state.state);
  authorizationUrl.searchParams.set("nonce", state.nonce);

  res.writeHead(302, { location: authorizationUrl.toString() });
  res.end();
}

async function completeGoogleLogin(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (!isGoogleLoginEnabled()) {
    return sendHtml(res, 503, googleLoginErrorPage("Google sign-in is not configured yet."));
  }

  const cookieState = decodeGoogleLoginState(parseCookies(req.headers.cookie ?? "")[GOOGLE_LOGIN_COOKIE]);
  setCookie(res, GOOGLE_LOGIN_COOKIE, "", {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 0,
    secure: isSecurePublicBaseUrl()
  });

  const providerError = url.searchParams.get("error");
  if (providerError) {
    return sendHtml(res, 400, googleLoginErrorPage(`Google sign-in was canceled or failed: ${providerError}`));
  }

  const code = url.searchParams.get("code") ?? "";
  const returnedState = url.searchParams.get("state") ?? "";
  if (!cookieState || cookieState.createdAt + GOOGLE_LOGIN_TTL_SECONDS * 1000 < Date.now()) {
    return sendHtml(res, 400, googleLoginErrorPage("The sign-in state expired. Please start again."));
  }
  if (!code || !returnedState || returnedState !== cookieState.state) {
    return sendHtml(res, 400, googleLoginErrorPage("The sign-in state check failed. Please start again."));
  }

  try {
    const tokenSet = await exchangeGoogleAuthorizationCode(code);
    const idToken = typeof tokenSet.id_token === "string" ? tokenSet.id_token : "";
    if (!idToken) throw new Error("Google token response missing id_token");

    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      audience: config.googleClientId,
      issuer: GOOGLE_ISSUERS
    });

    const email = typeof payload.email === "string" ? payload.email : "";
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    if (!subject || !email) throw new Error("Google id_token missing sub or email");
    if (payload.nonce !== cookieState.nonce) throw new Error("Google id_token nonce mismatch");
    if (payload.email_verified !== true) return sendHtml(res, 403, googleLoginErrorPage("This Google email address is not verified."));
    if (!isGoogleEmailAllowed(email)) return sendHtml(res, 403, googleLoginErrorPage("This Google account does not have access."));

    const context = await getOrCreateGoogleUserContext(subject, email);
    createSession(res, context);
    res.writeHead(302, { location: cookieState.returnTo });
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendHtml(res, 400, googleLoginErrorPage(`Google sign-in failed: ${message}`));
  }
}

async function exchangeGoogleAuthorizationCode(code: string) {
  const params = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: config.googleRedirectUri,
    grant_type: "authorization_code"
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = typeof body.error === "string" ? body.error : response.statusText;
    const description = typeof body.error_description === "string" ? body.error_description : "";
    throw new Error(description ? `${error}: ${description}` : error);
  }
  return body;
}

function isGoogleLoginEnabled() {
  return Boolean(config.googleClientId && config.googleClientSecret && config.googleRedirectUri);
}

function isGoogleEmailAllowed(email: string) {
  const allowed = config.googleAllowedEmails.length ? config.googleAllowedEmails : [config.adminEmail.toLowerCase()];
  return allowed.includes(email.toLowerCase());
}

function encodeGoogleLoginState(state: GoogleLoginState) {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeGoogleLoginState(value: string | undefined): GoogleLoginState | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<GoogleLoginState>;
    if (
      typeof parsed.state === "string" &&
      typeof parsed.nonce === "string" &&
      typeof parsed.returnTo === "string" &&
      typeof parsed.createdAt === "number"
    ) {
      return parsed as GoogleLoginState;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function safeReturnPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function googleLoginErrorPage(message: string) {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\" />",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "<title>Google sign-in failed</title>",
    "<style>",
    "body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f7f8;color:#172026}",
    ".wrap{max-width:460px;margin:12vh auto;padding:28px;background:white;border:1px solid #d9e0e5;border-radius:8px;box-shadow:0 18px 50px rgb(16 24 32 / .08)}",
    "h1{margin:0 0 12px;font-size:24px}.muted{color:#64727d;line-height:1.55}a{color:#0f766e;font-weight:700}",
    "</style>",
    "</head>",
    "<body>",
    "<main class=\"wrap\">",
    "<h1>Google sign-in failed</h1>",
    `<p class="muted">${escapeHtml(message)}</p>`,
    "<p><a href=\"/\">Return to sign-in</a></p>",
    "</main>",
    "</body>",
    "</html>"
  ].join("");
}

async function login(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJsonBody<{ email?: string; password?: string }>(req);
  const email = body.email ?? "";
  const password = body.password ?? "";

  const context = await authenticatePasswordContext(email, password);
  if (!context) {
    return sendJson(res, 401, { error: "invalid credentials" });
  }

  const user = createSession(res, context);
  return sendJson(res, 200, { user });
}

async function logout(req: http.IncomingMessage, res: http.ServerResponse) {
  const sid = parseCookies(req.headers.cookie ?? "").sid;
  if (sid) revokeWebSession(sid);
  setCookie(res, "sid", "", { httpOnly: true, sameSite: "Lax", maxAge: 0, secure: isSecurePublicBaseUrl() });
  return sendJson(res, 200, { ok: true });
}

function createSession(res: http.ServerResponse, context: WorkspaceContext, displayEmail = context.user.email) {
  const session: Session = {
    id: randomBytes(24).toString("base64url"),
    userId: context.user.id,
    workspaceId: context.workspace.id,
    email: displayEmail,
    createdAt: Date.now(),
    expiresAt: Date.now() + WEB_SESSION_TTL_SECONDS * 1000
  };
  sessions.set(session.id, session);
  saveWebSession(session);
  setCookie(res, "sid", session.id, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: WEB_SESSION_TTL_SECONDS,
    secure: isSecurePublicBaseUrl()
  });
  return { id: session.userId, email: session.email };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: WorkspaceContext) {
  const { user, workspace, sandbox } = context;
  if (req.method === "GET" && url.pathname === "/api/me") {
    return sendJson(res, 200, { user: { id: user.id, email: user.email } });
  }

  if (req.method === "GET" && url.pathname === "/api/workspaces/current") {
    return sendJson(res, 200, {
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        root: ".",
        virtualRoot: ".",
        mcpUrl: `${config.baseUrl}/mcp`
      }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/workspaces/export") {
    return exportWorkspace(res, context);
  }

  if (req.method === "GET" && url.pathname === "/api/backups") {
    return sendJson(res, 200, {
      backups: await listWorkspaceBackups(user, workspace),
      retentionCount: normalizedBackupRetentionCount()
    });
  }

  if (req.method === "POST" && url.pathname === "/api/backups") {
    const backup = await createWorkspaceBackup(user, workspace, "manual");
    return sendJson(res, 201, {
      backup,
      backups: await listWorkspaceBackups(user, workspace),
      retentionCount: normalizedBackupRetentionCount()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/backups/download") {
    const id = url.searchParams.get("id") ?? "";
    return downloadWorkspaceBackup(res, user, workspace, id);
  }

  if (req.method === "GET" && url.pathname === "/api/files/render") {
    const requestedPath = url.searchParams.get("path");
    if (!requestedPath) return sendJson(res, 400, { error: "path is required" });
    const content = await sandbox.readFile(requestedPath);
    const html = await renderWorkspaceFile(requestedPath, content);
    return sendJson(res, 200, { path: requestedPath, html });
  }

  if (req.method === "GET" && url.pathname === "/api/documents/children") {
    const requestedPath = url.searchParams.get("path") ?? ".";
    const childDocuments = await listChildDocumentCards(sandbox, requestedPath);
    return sendJson(res, 200, { path: requestedPath, childDocuments });
  }

  if (req.method === "GET" && url.pathname === "/api/documents/package") {
    const requestedPath = url.searchParams.get("path") ?? ".";
    return sendJson(res, 200, await buildDocumentPackage(sandbox, requestedPath));
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    const query = url.searchParams.get("q") ?? "";
    const stdout = query ? await sandbox.search(query) : "";
    const results = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [file, rawLine, ...snippet] = line.split(":");
        return { file, line: Number(rawLine), snippet: snippet.join(":").trim() };
      });
    return sendJson(res, 200, { query, results });
  }

  if (req.method === "GET" && url.pathname === "/api/journal/blocks") {
    const blocks = await readJournalBlocks(workspace.rootPath);
    return sendJson(res, 200, {
      blocks,
      summary: summarizeJournalBlocks(blocks)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/recent") {
    const recent = await listRecentFiles(workspace.rootPath);
    return sendJson(res, 200, { recent });
  }

  if (req.method === "GET" && url.pathname === "/api/audit/recent") {
    return sendJson(res, 200, { events: await readRecentAuditEvents(workspace.rootPath) });
  }

  if (req.method === "GET" && url.pathname === "/api/mcp-config") {
    const token = systemStore.ensureActiveMcpToken(user.id, workspace.id);
    return sendJson(res, 200, {
      serverName: "ai-meditations",
      url: `${config.baseUrl}/mcp`,
      token,
      config: {
        mcpServers: {
          "ai-meditations": {
            url: `${config.baseUrl}/mcp`,
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        }
      }
    });
  }

  return sendJson(res, 404, { error: "not found" });
}

async function handleOAuth(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (req.method === "GET" && isProtectedResourceMetadataPath(url.pathname)) {
    return sendJson(res, 200, protectedResourceMetadata());
  }

  if (req.method === "GET" && isAuthorizationServerMetadataPath(url.pathname)) {
    return sendJson(res, 200, authorizationServerMetadata());
  }

  if (req.method === "POST" && url.pathname === "/oauth/register") {
    return registerOAuthClient(req, res);
  }

  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    return showOAuthAuthorizePage(req, res, url);
  }

  if (req.method === "POST" && url.pathname === "/oauth/authorize") {
    return completeOAuthAuthorize(req, res);
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    return issueOAuthToken(req, res);
  }

  return sendJson(res, 404, { error: "not found" });
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!validateMcpOrigin(req, res)) return;
  normalizeMcpRequestHeaders(req);

  if (req.method === "OPTIONS") {
    res.writeHead(204, mcpCorsHeaders(req, { allow: "GET, POST, DELETE, OPTIONS" }));
    res.end();
    return;
  }

  const auth = req.headers.authorization ?? "";
  const authContext = await mcpBearerAuthContext(auth);
  if (!authContext) {
    res.writeHead(401, {
      ...mcpCorsHeaders(req),
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": mcpWwwAuthenticateHeader()
    });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "missing or invalid MCP authorization" }
      })
    );
    return;
  }

  if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) {
    res.writeHead(405, {
      ...mcpCorsHeaders(req, { allow: "GET, POST, DELETE, OPTIONS" }),
      "content-type": "application/json; charset=utf-8"
    });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Method not allowed." }
      })
    );
    return;
  }

  cleanupMcpSessions();

  if (req.method === "GET" || req.method === "DELETE") {
    const sessionId = getMcpSessionId(req);
    const session = sessionId ? mcpSessions.get(sessionId) : undefined;
    if (!session) return sendMcpHttpError(req, res, 404, -32001, "MCP session not found");
    if (session.auth.workspace.id !== authContext.workspace.id) return sendMcpHttpError(req, res, 403, -32003, "MCP session workspace mismatch");
    session.lastSeenAt = Date.now();
    return handleMcpSessionRequest(req, res, session);
  }

  const body = await readJsonBody<unknown>(req);
  const sessionId = getMcpSessionId(req);

  if (sessionId) {
    const session = mcpSessions.get(sessionId);
    if (!session) return sendMcpHttpError(req, res, 404, -32001, "MCP session not found");
    if (session.auth.workspace.id !== authContext.workspace.id) return sendMcpHttpError(req, res, 403, -32003, "MCP session workspace mismatch");
    session.lastSeenAt = Date.now();
    return handleMcpSessionRequest(req, res, session, body);
  }

  if (containsInitializeRequest(body)) {
    const session = await createMcpSession(authContext);
    return handleMcpSessionRequest(req, res, session, body);
  }

  return handleStatelessMcpRequest(req, res, body, authContext);
}

async function handleStatelessMcpRequest(req: http.IncomingMessage, res: http.ServerResponse, body: unknown, authContext: McpAuthContext) {
  const mcpServer = createMcpServer(authContext);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  transport.onerror = (error) => {
    console.error("MCP transport error:", error);
  };

  let closed = false;
  const closeTransport = async () => {
    if (closed) return;
    closed = true;
    await transport.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
  };

  res.on("close", () => {
    void closeTransport();
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.writeHead(500, {
        ...mcpCorsHeaders(req),
        "content-type": "application/json; charset=utf-8"
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal server error" }
        })
      );
    }
  } finally {
    await closeTransport();
  }
}

async function createMcpSession(authContext: McpAuthContext) {
  const mcpServer = createMcpServer(authContext);
  let session: McpSession;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      mcpSessions.set(sessionId, session);
    }
  });

  session = {
    server: mcpServer,
    transport,
    auth: authContext,
    createdAt: Date.now(),
    lastSeenAt: Date.now()
  };

  transport.onerror = (error) => {
    console.error("MCP transport error:", error);
  };
  transport.onclose = () => {
    for (const [sessionId, candidate] of mcpSessions) {
      if (candidate === session) mcpSessions.delete(sessionId);
    }
  };

  await mcpServer.connect(transport);
  return session;
}

async function handleMcpSessionRequest(req: http.IncomingMessage, res: http.ServerResponse, session: McpSession, body?: unknown) {
  try {
    await session.transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("MCP session request error:", error);
    if (!res.headersSent) {
      sendMcpHttpError(req, res, 500, -32603, "Internal server error");
    }
  }
}

function createMcpServer(authContext: McpAuthContext) {
  const { sandbox, workspace } = authContext;
  const mcpServer = new McpServer({
    name: "ai-meditations",
    version: "0.1.0"
  });

	  mcpServer.registerTool(
	    "run_shell",
    {
      title: "Run Workspace Shell",
      description: MCP_RUN_SHELL_DESCRIPTION,
      inputSchema: {
	        command: z
	          .string()
	          .min(1)
	          .describe(
	            "One or more sandbox commands in the AI Meditations document DSL. This is not bash. Start new sessions with workspace_health for a capped entropy snapshot. For large JSON/CLI content, prefer write_file or patch_file. For DSL writes, use heredoc: write path.md <<EOF\\ncontent\\nEOF or <<'EOF'. patch accepts git-style unified diff bodies and legacy JSON exact replacements; run help patch for examples. Pick a delimiter not present alone in the body. Each command starts on its own line; inline content after a file path is rejected. Multi-command write batches roll back on execution failure. For structure use inspect_doc/toc/section; for section edits run help replace_section."
	          ),
        cwd: z.string().optional().describe("Optional workspace-relative current directory. Absolute paths and .. are not allowed.")
      },
      outputSchema: {
        ok: z.boolean(),
        stdout: z.string(),
        stderr: z.string(),
        errorType: z.string().optional(),
        cwd: z.string(),
        command: z.string(),
        truncated: z.boolean()
      },
      annotations: {
        title: "Run Workspace Shell",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ command, cwd }) => {
      const result = await sandbox.run(command, {
        cwd,
        scope: mcpScopesToSandboxScope(authContext.scopes),
        actor: { actorType: "mcp_token", actorId: authContext.actorId }
      });

      return {
        content: [{ type: "text", text: formatMcpShellResult(command, result) }],
        structuredContent: {
          ok: result.ok,
          stdout: result.stdout,
          stderr: result.stderr ?? "",
          errorType: result.errorType,
          cwd: result.cwd,
          command,
          truncated: Boolean(result.truncated)
        },
        isError: !result.ok
      };
    }
	  );

  mcpServer.registerTool(
    "write_file",
    {
      title: "Write Workspace File",
      description:
        "Structured file write for MCP clients. Use this instead of run_shell heredocs when sending large content through JSON or CLI adapters. This is still sandboxed: paths are workspace-relative, absolute paths and .. are rejected, and write scope is required.",
      inputSchema: {
        path: z.string().min(1).describe("Workspace-relative destination path, for example docs/example/README.md."),
        content: z.string().optional().describe("UTF-8 text content to write or append. Provide exactly one of content or content_base64."),
        content_base64: z
          .string()
          .optional()
          .describe("Base64-encoded UTF-8 content. Useful when external CLI/JSON quoting makes multiline content awkward."),
        mode: z.enum(["write", "append"]).optional().describe("write replaces the file; append adds content to the end. Defaults to write."),
        cwd: z.string().optional().describe("Optional workspace-relative current directory. Absolute paths and .. are not allowed.")
      },
      outputSchema: {
        ok: z.boolean(),
        stdout: z.string(),
        stderr: z.string(),
        errorType: z.string().optional(),
        cwd: z.string(),
        operation: z.string(),
        path: z.string(),
        mode: z.string(),
        truncated: z.boolean()
      },
      annotations: {
        title: "Write Workspace File",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ path: targetPath, content, content_base64, mode = "write", cwd }) => {
      const operation = `write_file ${targetPath}`;
      const decoded = decodeStructuredFileContent(content, content_base64);
      if (!decoded.ok) {
        return mcpSandboxResult(operation, sandboxErrorResult(decoded.error, cwd), { path: targetPath, mode });
      }

      const result = await sandbox.writeTextFile(targetPath, decoded.content, {
        cwd,
        mode,
        scope: mcpScopesToSandboxScope(authContext.scopes),
        actor: { actorType: "mcp_token", actorId: authContext.actorId }
      });
      return mcpSandboxResult(operation, result, { path: targetPath, mode });
    }
  );

  mcpServer.registerTool(
    "patch_file",
    {
      title: "Patch Workspace File",
      description:
        "Structured exact-text patch for MCP clients. Use this instead of run_shell JSON patch heredocs when old_text/new_text can be passed as normal JSON fields. The patch must match exactly one location unless dry_run is true, and write scope is required.",
      inputSchema: {
        path: z.string().min(1).describe("Workspace-relative file path to patch."),
        old_text: z.string().min(1).describe("Exact text to replace. Include enough surrounding context to match exactly once."),
        new_text: z.string().describe("Replacement text."),
        dry_run: z.boolean().optional().describe("Preview the patch without writing."),
        cwd: z.string().optional().describe("Optional workspace-relative current directory. Absolute paths and .. are not allowed.")
      },
      outputSchema: {
        ok: z.boolean(),
        stdout: z.string(),
        stderr: z.string(),
        errorType: z.string().optional(),
        cwd: z.string(),
        operation: z.string(),
        path: z.string(),
        dryRun: z.boolean(),
        truncated: z.boolean()
      },
      annotations: {
        title: "Patch Workspace File",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ path: targetPath, old_text, new_text, dry_run = false, cwd }) => {
      const operation = `patch_file ${targetPath}`;
      const result = await sandbox.patchTextFile(targetPath, old_text, new_text, {
        cwd,
        dryRun: dry_run,
        scope: mcpScopesToSandboxScope(authContext.scopes),
        actor: { actorType: "mcp_token", actorId: authContext.actorId }
      });
      return mcpSandboxResult(operation, result, { path: targetPath, dryRun: dry_run });
    }
  );

  mcpServer.registerTool(
    "get_workspace_info",
    {
      title: "Get Workspace Info",
      description:
        "Return the LLM-facing workspace map plus a current workspace_health entropy snapshot: wiki layers, canonical schema, Reader contract, safe write policy, resources, and first commands.",
      inputSchema: {},
      outputSchema: {
        text: z.string()
      },
      annotations: {
        title: "Get Workspace Info",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const text = await workspaceInfoText(sandbox);
      return {
        content: [{ type: "text", text }],
        structuredContent: { text }
      };
    }
  );

  mcpServer.registerResource(
    "workspace-info",
    "ai-meditations://workspace/info",
    {
      title: "Workspace LLM Map",
      description:
        "LLM-facing map for this Karpathy-style Markdown wiki: layers, write policy, Reader contract, first commands, and current entropy snapshot.",
      mimeType: "text/markdown"
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: await workspaceInfoText(sandbox) }]
    })
  );

  mcpServer.registerResource(
    "llms-txt",
    "ai-meditations://llms.txt",
    {
      title: "llms.txt",
      description: "Compact LLM entrypoint for this AI Meditations workspace.",
      mimeType: "text/markdown"
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: LLMS_TXT_RESOURCE_TEXT }]
    })
  );

  mcpServer.registerResource(
    "wiki-maintenance-skill",
    "ai-meditations://skills/wiki-maintenance",
    {
      title: "Maintain LLM Wiki Skill",
      description: "Agent skill for Karpathy-style wiki maintenance: ingest sources, query compiled docs, and lint the wiki.",
      mimeType: "text/markdown"
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: WIKI_MAINTENANCE_SKILL_TEXT }]
    })
  );

  mcpServer.registerResource(
    "organize-workspace-skill",
    "ai-meditations://skills/organize-workspace",
    {
      title: "Organize Workspace Skill",
      description: "Agent skill for safely organizing an AI Meditations workspace without increasing entropy.",
      mimeType: "text/markdown"
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: ORGANIZE_WORKSPACE_SKILL_TEXT }]
    })
  );

  mcpServer.registerResource(
    "workspace-file",
    new ResourceTemplate("ai-meditations://file/{+path}", {
      list: async () => {
        const resources = await listMcpWorkspaceResources(workspace.rootPath);
        return {
          resources: resources.map((file) => ({
            uri: mcpFileUri(file.path),
            name: file.path,
            title: file.title,
            description: file.description,
            mimeType: "text/markdown"
          }))
        };
      },
      complete: {
        path: async (value) => {
          const resources = await listMcpWorkspaceResources(workspace.rootPath);
          return resources
            .map((file) => file.path)
            .filter((file) => file.toLowerCase().includes(value.toLowerCase()))
            .slice(0, 50);
        }
      }
    }),
    {
      title: "Workspace Markdown File",
      description:
        "Read a Markdown workspace file by URI. Use AGENTS.md for schema, sources/ for raw sources, docs/ for compiled wiki pages, journal/ for operation logs, and self/ for durable user context.",
      mimeType: "text/markdown"
    },
    async (uri, variables) => {
      const rawPath = variables.path;
      const requestedPath = Array.isArray(rawPath) ? rawPath.join("/") : rawPath;
      if (!requestedPath) throw new Error("path is required");
      const text = await sandbox.readFile(requestedPath);
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text }]
      };
    }
  );

  return mcpServer;
}

function isOAuthDiscoveryPath(pathname: string) {
  return isProtectedResourceMetadataPath(pathname) || isAuthorizationServerMetadataPath(pathname);
}

function isProtectedResourceMetadataPath(pathname: string) {
  return pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp";
}

function isAuthorizationServerMetadataPath(pathname: string) {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/.well-known/openid-configuration"
  );
}

function publicBaseUrl() {
  return config.baseUrl.replace(/\/+$/, "");
}

function isSecurePublicBaseUrl() {
  return publicBaseUrl().startsWith("https://");
}

function mcpResourceUrl() {
  return `${publicBaseUrl()}/mcp`;
}

function protectedResourceMetadata() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [publicBaseUrl()],
    bearer_methods_supported: ["header"],
    scopes_supported: OAUTH_SCOPES,
    resource_documentation: `${publicBaseUrl()}/`
  };
}

function authorizationServerMetadata() {
  return {
    issuer: publicBaseUrl(),
    authorization_endpoint: `${publicBaseUrl()}/oauth/authorize`,
    token_endpoint: `${publicBaseUrl()}/oauth/token`,
    registration_endpoint: `${publicBaseUrl()}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: OAUTH_SCOPES,
    resource_parameter_supported: true
  };
}

async function registerOAuthClient(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJsonBody<Record<string, unknown>>(req);
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string") : [];
  if (redirectUris.length === 0) return oauthError(res, 400, "invalid_client_metadata", "redirect_uris is required");

  const tokenEndpointAuthMethod = normalizeTokenEndpointAuthMethod(body.token_endpoint_auth_method);
  const clientSecret = tokenEndpointAuthMethod === "none" ? undefined : randomBytes(32).toString("base64url");
  const client: OAuthClient = {
    clientId: `ai-meditations-${randomBytes(18).toString("base64url")}`,
    clientName: typeof body.client_name === "string" ? body.client_name : "MCP Client",
    redirectUris,
    grantTypes: stringArrayOrDefault(body.grant_types, ["authorization_code", "refresh_token"]),
    responseTypes: stringArrayOrDefault(body.response_types, ["code"]),
    scope: typeof body.scope === "string" ? body.scope : OAUTH_SCOPES.join(" "),
    tokenEndpointAuthMethod,
    clientSecretHash: clientSecret ? tokenHash(clientSecret) : undefined,
    createdAt: Date.now()
  };

  oauthClients.set(client.clientId, client);
  await saveOAuthState();

  const response: Record<string, unknown> = {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(client.createdAt / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    scope: client.scope,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod
  };

  if (clientSecret) {
    response.client_secret = clientSecret;
    response.client_secret_expires_at = 0;
  }

  return sendJson(res, 201, response);
}

function normalizeTokenEndpointAuthMethod(value: unknown): OAuthClient["tokenEndpointAuthMethod"] {
  if (value === "client_secret_post" || value === "client_secret_basic") return value;
  return "none";
}

function stringArrayOrDefault(value: unknown, fallback: string[]) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

async function showOAuthAuthorizePage(req: http.IncomingMessage, res: http.ServerResponse, url: URL, errorMessage = "") {
  const validation = validateOAuthAuthorizeParams(url.searchParams);
  if (!validation.ok) return oauthError(res, 400, "invalid_request", validation.error);
  const { client, params } = validation;
  const session = sessionFromRequest(req);
  let context: WorkspaceContext | undefined;

  if (session) {
    try {
      context = await getSessionWorkspaceContext(session);
    } catch {
      sessions.delete(session.id);
    }
  }

  if (!context && isGoogleLoginEnabled() && !errorMessage) {
    const returnTo = `${url.pathname}${url.search}`;
    res.writeHead(302, { location: `/auth/google/start?return_to=${encodeURIComponent(returnTo)}` });
    res.end();
    return;
  }

  const accountBlock = context
    ? [
        `<p class="muted">Signed in as <strong>${escapeHtml(context.user.email)}</strong></p>`,
        hiddenInput("confirmed", "1")
      ]
    : [
        "<label for=\"email\">Email</label>",
        "<input id=\"email\" name=\"email\" type=\"email\" autocomplete=\"username\" autofocus />",
        "<label for=\"password\">Password</label>",
        "<input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"current-password\" />"
      ];

  return sendHtml(
    res,
    200,
    [
      "<!doctype html>",
      "<html lang=\"en\">",
      "<head>",
      "<meta charset=\"utf-8\" />",
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
      "<title>Authorize AI Meditations</title>",
      "<style>",
      "body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f7f7;color:#142024}",
      ".wrap{max-width:520px;margin:8vh auto;padding:32px;background:white;border:1px solid #d5dde1;border-radius:14px;box-shadow:0 18px 40px rgba(20,32,36,.08)}",
      "h1{margin:0 0 8px;font-size:28px}.muted{color:#60707a;line-height:1.55}.client{font-weight:700;color:#00645b}",
      "label{display:block;margin:18px 0 6px;font-weight:650}input{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #b9c5cc;border-radius:10px;font-size:16px}",
      "button{margin-top:22px;width:100%;padding:13px 16px;border:0;border-radius:10px;background:#00645b;color:white;font-size:16px;font-weight:750}",
      ".error{margin-top:14px;color:#a40000;background:#fff0f0;border:1px solid #ffc9c9;padding:10px;border-radius:10px}",
      "</style>",
      "</head>",
      "<body>",
      "<main class=\"wrap\">",
      "<h1>Authorize AI Meditations</h1>",
      `<p class="muted">The app <span class="client">${escapeHtml(client.clientName)}</span> is requesting access to your private Markdown workspace.</p>`,
      `<p class="muted">Scope: ${escapeHtml(params.scope)}</p>`,
      "<p class=\"muted\" lang=\"zh-CN\">此应用正在请求访问你的私有 Markdown 工作区。请只授权你信任的客户端。</p>",
      errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : "",
      "<form method=\"post\" action=\"/oauth/authorize\">",
      hiddenInput("client_id", params.clientId),
      hiddenInput("redirect_uri", params.redirectUri),
      hiddenInput("response_type", params.responseType),
      hiddenInput("code_challenge", params.codeChallenge),
      hiddenInput("code_challenge_method", params.codeChallengeMethod),
      hiddenInput("scope", params.scope),
      hiddenInput("state", params.state),
      hiddenInput("resource", params.resource),
      ...accountBlock,
      "<button type=\"submit\">Authorize</button>",
      "</form>",
      "</main>",
      "</body>",
      "</html>"
    ].join("")
  );
}

async function completeOAuthAuthorize(req: http.IncomingMessage, res: http.ServerResponse) {
  const form = await readFormBody(req);
  const url = new URL("/oauth/authorize", publicBaseUrl());
  for (const key of ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "scope", "state", "resource"]) {
    const value = form.get(key);
    if (value) url.searchParams.set(key, value);
  }

  const validation = validateOAuthAuthorizeParams(url.searchParams);
  if (!validation.ok) return oauthError(res, 400, "invalid_request", validation.error);

  const session = sessionFromRequest(req);
  let context: WorkspaceContext | undefined;
  if (session) {
    try {
      context = await getSessionWorkspaceContext(session);
    } catch {
      sessions.delete(session.id);
    }
  }

  if (!context) {
    const email = form.get("email") ?? "";
    const password = form.get("password") ?? "";
    context = await authenticatePasswordContext(email, password);
    if (!context) {
      return showOAuthAuthorizePage(req, res, url, "Email or password is incorrect.");
    }
  }

  const { params } = validation;
  const code = randomBytes(32).toString("base64url");
  oauthCodes.set(code, {
    code,
    clientId: params.clientId,
    userId: context.user.id,
    workspaceId: context.workspace.id,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: "S256",
    scope: params.scope,
    resource: params.resource,
    expiresAt: Date.now() + OAUTH_CODE_TTL_MS
  });

  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  res.writeHead(302, { location: redirect.toString() });
  res.end();
}

type OAuthAuthorizeParams = {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scope: string;
  state: string;
  resource: string;
};

function validateOAuthAuthorizeParams(searchParams: URLSearchParams):
  | { ok: true; client: OAuthClient; params: OAuthAuthorizeParams }
  | { ok: false; error: string } {
  const clientId = searchParams.get("client_id") ?? "";
  const client = oauthClients.get(clientId);
  if (!client) return { ok: false, error: "unknown client_id" };

  const redirectUri = searchParams.get("redirect_uri") ?? "";
  if (!client.redirectUris.includes(redirectUri)) return { ok: false, error: "redirect_uri is not registered" };

  const responseType = searchParams.get("response_type") ?? "";
  if (responseType !== "code") return { ok: false, error: "response_type must be code" };

  const codeChallenge = searchParams.get("code_challenge") ?? "";
  if (!codeChallenge) return { ok: false, error: "code_challenge is required" };

  const codeChallengeMethod = searchParams.get("code_challenge_method") ?? "";
  if (codeChallengeMethod !== "S256") return { ok: false, error: "code_challenge_method must be S256" };

  const scope = normalizeScope(searchParams.get("scope") ?? client.scope);
  const resource = normalizeOAuthResource(searchParams.get("resource"));
  const state = searchParams.get("state") ?? "";

  return {
    ok: true,
    client,
    params: { clientId, redirectUri, responseType, codeChallenge, codeChallengeMethod, scope, state, resource }
  };
}

async function issueOAuthToken(req: http.IncomingMessage, res: http.ServerResponse) {
  const params = await readOAuthRequestParams(req);
  const grantType = params.get("grant_type") ?? "";
  const clientAuth = authenticateOAuthClient(req, params);
  if (!clientAuth.ok) return oauthError(res, 401, "invalid_client", clientAuth.error);

  if (grantType === "authorization_code") {
    return issueOAuthTokenFromCode(res, params, clientAuth.client);
  }

  if (grantType === "refresh_token") {
    return issueOAuthTokenFromRefreshToken(res, params, clientAuth.client);
  }

  return oauthError(res, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

function authenticateOAuthClient(req: http.IncomingMessage, params: URLSearchParams):
  | { ok: true; client: OAuthClient }
  | { ok: false; error: string } {
  const basic = parseBasicAuth(req.headers.authorization);
  const clientId = basic?.username ?? params.get("client_id") ?? "";
  const client = oauthClients.get(clientId);
  if (!client) return { ok: false, error: "unknown client_id" };

  if (client.tokenEndpointAuthMethod === "none") return { ok: true, client };

  const secret = basic?.password ?? params.get("client_secret") ?? "";
  if (!secret || !client.clientSecretHash || !constantTimeEqual(tokenHash(secret), client.clientSecretHash)) {
    return { ok: false, error: "invalid client_secret" };
  }

  return { ok: true, client };
}

function parseBasicAuth(authorization: string | undefined) {
  if (!authorization?.toLowerCase().startsWith("basic ")) return undefined;
  try {
    const decoded = Buffer.from(authorization.slice("basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return undefined;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1)
    };
  } catch {
    return undefined;
  }
}

async function issueOAuthTokenFromCode(res: http.ServerResponse, params: URLSearchParams, client: OAuthClient) {
  const code = params.get("code") ?? "";
  const record = oauthCodes.get(code);
  oauthCodes.delete(code);

  if (!record || record.expiresAt < Date.now()) return oauthError(res, 400, "invalid_grant", "authorization code is invalid or expired");
  if (record.clientId !== client.clientId) return oauthError(res, 400, "invalid_grant", "authorization code was not issued to this client");
  if (record.redirectUri !== (params.get("redirect_uri") ?? "")) return oauthError(res, 400, "invalid_grant", "redirect_uri mismatch");

  const codeVerifier = params.get("code_verifier") ?? "";
  if (!codeVerifier || pkceChallenge(codeVerifier) !== record.codeChallenge) {
    return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
  }

  const resource = normalizeOAuthResource(params.get("resource"));
  if (resource !== record.resource) return oauthError(res, 400, "invalid_target", "resource mismatch");

  return sendTokenResponse(res, await createOAuthTokenRecord(client, record.scope, record.resource, record.userId, record.workspaceId));
}

async function issueOAuthTokenFromRefreshToken(res: http.ServerResponse, params: URLSearchParams, client: OAuthClient) {
  const refreshToken = params.get("refresh_token") ?? "";
  const record = oauthRefreshTokens.get(tokenHash(refreshToken));
  if (!record || record.clientId !== client.clientId || !record.refreshExpiresAt || record.refreshExpiresAt < Date.now()) {
    return oauthError(res, 400, "invalid_grant", "refresh token is invalid or expired");
  }

  oauthAccessTokens.delete(record.accessTokenHash);
  if (record.refreshTokenHash) oauthRefreshTokens.delete(record.refreshTokenHash);
  return sendTokenResponse(res, await createOAuthTokenRecord(client, record.scope, record.resource, record.userId, record.workspaceId));
}

async function createOAuthTokenRecord(client: OAuthClient, scope: string, resource: string, userId: string, workspaceId: string) {
  const accessToken = `oauth_${randomBytes(32).toString("base64url")}`;
  const refreshToken = `oauth_refresh_${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  const record: OAuthTokenRecord = {
    accessTokenHash: tokenHash(accessToken),
    refreshTokenHash: tokenHash(refreshToken),
    clientId: client.clientId,
    userId,
    workspaceId,
    scope,
    resource,
    createdAt: now,
    expiresAt: now + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000,
    refreshExpiresAt: now + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000
  };

  oauthAccessTokens.set(record.accessTokenHash, record);
  oauthRefreshTokens.set(record.refreshTokenHash!, record);
  await saveOAuthState();

  return { accessToken, refreshToken, record };
}

function sendTokenResponse(res: http.ServerResponse, token: { accessToken: string; refreshToken: string; record: OAuthTokenRecord }) {
  return sendJson(res, 200, {
    access_token: token.accessToken,
    token_type: "Bearer",
    expires_in: Math.max(0, Math.floor((token.record.expiresAt - Date.now()) / 1000)),
    refresh_token: token.refreshToken,
    scope: token.record.scope
  });
}

function oauthError(res: http.ServerResponse, status: number, error: string, description?: string) {
  return sendJson(res, status, {
    error,
    ...(description ? { error_description: description } : {})
  });
}

function normalizeScope(scope: string) {
  const requested = scope
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = requested.filter((item) => OAUTH_SCOPES.includes(item));
  return (allowed.length ? allowed : OAUTH_SCOPES).join(" ");
}

function normalizeOAuthResource(resource: string | null) {
  return resource || mcpResourceUrl();
}

function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function mcpWwwAuthenticateHeader() {
  return [
    'Bearer realm="ai-meditations-mcp"',
    `resource_metadata="${publicBaseUrl()}/.well-known/oauth-protected-resource/mcp"`,
    `scope="${OAUTH_SCOPES.join(" ")}"`
  ].join(", ");
}

function formatMcpShellResult(command: string, result: SandboxCommandResult) {
  const output = result.ok ? result.stdout || "(ok)" : result.stderr || "error";
  const lines = [
    `cwd: ${result.cwd}`,
    `command: ${command}`,
    `status: ${result.ok ? "ok" : "error"}`
  ];

  if (!result.ok && result.errorType) lines.push(`error_type: ${result.errorType}`);
  if (result.truncated) lines.push("truncated: true");

  return [...lines, "", output].join("\n");
}

function mcpSandboxResult(operation: string, result: SandboxCommandResult, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: formatMcpShellResult(operation, result) }],
    structuredContent: {
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr ?? "",
      errorType: result.errorType,
      cwd: result.cwd,
      operation,
      truncated: Boolean(result.truncated),
      ...extra
    },
    isError: !result.ok
  };
}

function sandboxErrorResult(message: string, cwd = "."): SandboxCommandResult {
  return {
    ok: false,
    stdout: "",
    stderr: message,
    errorType: "validation_error",
    cwd
  };
}

function decodeStructuredFileContent(content: string | undefined, contentBase64: string | undefined):
  | { ok: true; content: string }
  | { ok: false; error: string } {
  const hasContent = content !== undefined;
  const hasBase64 = contentBase64 !== undefined;
  if (hasContent === hasBase64) return { ok: false, error: "Provide exactly one of content or content_base64." };
  if (hasContent) return { ok: true, content };

  const normalizedBase64 = (contentBase64 ?? "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedBase64) || normalizedBase64.length % 4 === 1) {
    return { ok: false, error: "content_base64 must be valid standard base64 text." };
  }

  try {
    return { ok: true, content: Buffer.from(normalizedBase64, "base64").toString("utf8") };
  } catch {
    return { ok: false, error: "content_base64 must be valid base64-encoded UTF-8 text." };
  }
}

function normalizeMcpRequestHeaders(req: http.IncomingMessage) {
  const accept = headerValue(req.headers.accept);
  const acceptsJson = accept.includes("application/json");
  const acceptsSse = accept.includes("text/event-stream");

  if (!acceptsJson || !acceptsSse) {
    req.headers.accept = "application/json, text/event-stream";
    setRawHeader(req, "accept", "application/json, text/event-stream");
  }
}

function setRawHeader(req: http.IncomingMessage, name: string, value: string) {
  const index = req.rawHeaders.findIndex((header) => header.toLowerCase() === name.toLowerCase());
  if (index >= 0) {
    req.rawHeaders[index + 1] = value;
    return;
  }
  req.rawHeaders.push(name, value);
}

function getMcpSessionId(req: http.IncomingMessage) {
  return headerValue(req.headers["mcp-session-id"]) || undefined;
}

function containsInitializeRequest(body: unknown) {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => isInitializeRequest(message));
}

function cleanupMcpSessions() {
  const cutoff = Date.now() - MCP_SESSION_TTL_MS;
  for (const [sessionId, session] of mcpSessions) {
    if (session.lastSeenAt >= cutoff) continue;
    mcpSessions.delete(sessionId);
    void session.transport.close().catch(() => undefined);
    void session.server.close().catch(() => undefined);
  }
}

function sendMcpHttpError(req: http.IncomingMessage, res: http.ServerResponse, httpStatus: number, code: number, message: string) {
  res.writeHead(httpStatus, {
    ...mcpCorsHeaders(req, { allow: "GET, POST, DELETE, OPTIONS" }),
    "content-type": "application/json; charset=utf-8"
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code, message }
    })
  );
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join(", ") : value ?? "";
}

function validateMcpOrigin(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = req.headers.origin;
  if (!origin) return true;

  const allowed = new Set([
    new URL(config.baseUrl).origin,
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`
  ]);

  if (allowed.has(origin)) return true;

  res.writeHead(403, {
    ...mcpCorsHeaders(req),
    "content-type": "application/json; charset=utf-8"
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32003, message: "forbidden origin" }
    })
  );
  return false;
}

function mcpCorsHeaders(req: http.IncomingMessage, options: { allow?: string } = {}) {
  const origin = req.headers.origin;
  const headers: Record<string, string> = {
    vary: "Origin",
    "access-control-allow-methods": options.allow ?? "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": [
      "Authorization",
      "Content-Type",
      "Accept",
      "MCP-Protocol-Version",
      "MCP-Session-Id",
      "MCP-Method",
      "MCP-Name",
      "Last-Event-ID"
    ].join(", "),
    "access-control-expose-headers": "MCP-Session-Id"
  };

  if (origin) headers["access-control-allow-origin"] = origin;
  if (options.allow) headers.allow = options.allow;
  return headers;
}

async function listMcpWorkspaceResources(root: string) {
  const core = ["AGENTS.md", "index.md", "docs/README.md", "sources/README.md", "self/README.md", "self/context.md", "journal/README.md"];
  const recent = (await listRecentFiles(root)).map((file) => file.path);
  const paths = [...new Set([...core, ...recent])];
  const resources: Array<{ path: string; title: string; description: string }> = [];

  for (const filePath of paths) {
    if (!filePath.endsWith(".md")) continue;
    if (!(await pathExists(path.join(root, filePath)))) continue;
    resources.push({
      path: filePath,
      title: path.basename(filePath),
      description: filePath.startsWith("self/")
        ? "User-visible Agent context; durable preferences, principles, and long-lived user context only"
        : filePath.startsWith("docs/")
        ? "Compiled wiki document package or page"
        : filePath.startsWith("sources/")
        ? "Raw source material with provenance; compile stable synthesis into docs/"
        : filePath.startsWith("journal/")
          ? "Timeline note, session summary, document-change event, or uncertain context"
          : filePath === "AGENTS.md"
            ? "Canonical agent operating contract and writing rules"
            : "Workspace root control or index file"
    });
  }

  return resources;
}

function mcpFileUri(filePath: string) {
  return `ai-meditations://file/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function listChildDocumentCards(sandbox: WorkspaceSandbox, parentPath: string): Promise<ChildDocumentCard[]> {
  const entries = await sandbox.listFiles(parentPath);
  const directories = await collectChildDocumentEntries(sandbox, parentPath, entries);
  const cards = await Promise.all(directories.map((entry) => describeChildDocument(sandbox, entry.path)));
  return cards.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
}

async function buildDocumentPackage(sandbox: WorkspaceSandbox, documentPath: string): Promise<DocumentPackage> {
  const entries = await sandbox.listFiles(documentPath);
  const [siblingDocuments, childDocuments, pages] = await Promise.all([
    listSiblingDocumentCards(sandbox, documentPath),
    listChildDocumentCards(sandbox, documentPath),
    collectDocumentPages(sandbox, documentPath, entries)
  ]);
  return {
    path: documentPath,
    entries,
    siblingDocuments,
    childDocuments,
    pages
  };
}

async function listSiblingDocumentCards(sandbox: WorkspaceSandbox, documentPath: string) {
  if (isDocumentRootPath(documentPath)) return [];
  if (isSystemDocumentPath(documentPath)) return [];
  const parentPath = siblingDocumentParentPath(documentPath);
  const entries = await sandbox.listFiles(parentPath).catch(() => []);
  return listChildDocumentCardsFromEntries(sandbox, entries);
}

function isDocumentRootPath(documentPath: string) {
  return documentPath.replace(/\/+$/, "") === "docs";
}

function isSystemDocumentPath(documentPath: string) {
  return SYSTEM_DOCUMENT_PATHS.has(documentPath.replace(/\/+$/, ""));
}

function isAuxiliaryDocumentDirectory(entry: WorkspaceFileEntry) {
  return entry.kind === "directory" && DOCUMENT_AUXILIARY_DIRECTORIES.has(entry.name);
}

function isChildDocumentEntry(entry: WorkspaceFileEntry) {
  return entry.kind === "directory" && !isSystemDocumentPath(entry.path) && !isAuxiliaryDocumentDirectory(entry);
}

function siblingDocumentParentPath(documentPath: string) {
  const normalized = documentPath.replace(/\/+$/, "") || ".";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return normalized;
  parts.pop();
  return parts.join("/");
}

async function listChildDocumentCardsFromEntries(sandbox: WorkspaceSandbox, entries: WorkspaceFileEntry[]) {
  const directories = entries.filter((entry) => entry.kind === "directory" && !isAuxiliaryDocumentDirectory(entry) && !isSystemDocumentPath(entry.path));
  const cards = await Promise.all(directories.map((entry) => describeChildDocument(sandbox, entry.path)));
  return cards.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
}

async function collectChildDocumentEntries(sandbox: WorkspaceSandbox, parentPath: string, entries: WorkspaceFileEntry[]) {
  const rows: WorkspaceFileEntry[] = [];
  const subDocsPath = `${parentPath.replace(/\/+$/, "")}/${CHILD_DOCUMENTS_DIRECTORY}`.replace(/^\.\//, "");
  const hasSubDocs = entries.some((entry) => entry.kind === "directory" && entry.name === CHILD_DOCUMENTS_DIRECTORY);
  if (hasSubDocs) {
    const subDocEntries = await sandbox.listFiles(subDocsPath).catch(() => []);
    rows.push(...subDocEntries.filter(isChildDocumentEntry));
  }
  return rows;
}

async function collectDocumentPages(
  sandbox: WorkspaceSandbox,
  documentPath: string,
  entries: WorkspaceFileEntry[],
  depth = 0,
  pages: DocumentPage[] = []
) {
  if (pages.length >= MAX_EXPANDED_PAGES || depth > MAX_EXPAND_DEPTH) return pages;

  const readme = entries.find(isReadmeEntry);
  if (readme) {
    await addRenderedDocumentPage(sandbox, pages, readme.path, pageDisplayPath(documentPath), depth);
  }

  const sameDocumentFiles = entries.filter((entry) => entry.kind === "file" && isMarkdownEntry(entry) && !isReadmeEntry(entry));
  for (const entry of sortDocumentEntries(sameDocumentFiles)) {
    if (pages.length >= MAX_EXPANDED_PAGES) break;
    await addRenderedDocumentPage(sandbox, pages, entry.path, pageDisplayPath(entry.path), depth + 1);
  }

  return pages;
}

async function addRenderedDocumentPage(
  sandbox: WorkspaceSandbox,
  pages: DocumentPage[],
  sourcePath: string,
  displayPath: string,
  depth: number
) {
  const content = await sandbox.readFile(sourcePath);
  const html = await renderWorkspaceFile(sourcePath, content);
  pages.push({
    sourcePath,
    displayPath,
    html,
    depth,
    pageNumber: pages.length + 1
  });
}

async function describeChildDocument(sandbox: WorkspaceSandbox, documentPath: string): Promise<ChildDocumentCard> {
  const entries = await sandbox.listFiles(documentPath);
  const readme = entries.find((entry) => entry.kind === "file" && entry.name.toLowerCase() === "readme.md");
  const markdownPages = entries.filter((entry) => entry.kind === "file" && /\.(md|markdown)$/i.test(entry.name));
  const childDirs = await collectChildDocumentEntries(sandbox, documentPath, entries);
  const auxiliaryDirs = entries.filter(isAuxiliaryDocumentDirectory);
  const readmePath = readme?.path;
  const readmeText = readmePath ? await sandbox.readFile(readmePath).catch(() => "") : "";
  const parsed = parseDocumentReadme(readmeText, documentPath);
  const updatedAt = latestEntryUpdate([readme, ...markdownPages, ...childDirs, ...auxiliaryDirs]);

  return {
    path: documentPath,
    readmePath,
    title: parsed.title,
    summary: parsed.summary,
    status: parsed.status,
    tags: parsed.tags.length ? parsed.tags : inferDocumentTags(documentPath),
    updatedAt,
    pageCount: markdownPages.length,
    childCount: childDirs.length
  };
}

function parseDocumentReadme(content: string, documentPath: string) {
  if (!content.trim()) {
    return {
      title: titleFromPath(documentPath),
      summary: "",
      status: undefined as string | undefined,
      tags: [] as string[]
    };
  }

  const parsed = matter(content);
  const body = parsed.content.trimStart();
  const title = typeof parsed.data.title === "string" && parsed.data.title.trim()
    ? parsed.data.title.trim()
    : firstMarkdownHeading(body) ?? titleFromPath(documentPath);
  const summary = typeof parsed.data.summary === "string" && parsed.data.summary.trim()
    ? parsed.data.summary.trim()
    : firstMarkdownParagraph(body);

  return {
    title,
    summary,
    status: typeof parsed.data.status === "string" && parsed.data.status.trim()
      ? parsed.data.status.trim().toLowerCase()
      : undefined,
    tags: normalizeDocumentTags(parsed.data.tags)
  };
}

function firstMarkdownHeading(content: string) {
  return content
    .split(/\r?\n/)
    .find((line) => /^#\s+\S/.test(line))
    ?.replace(/^#\s+/, "")
    .trim();
}

function firstMarkdownParagraph(content: string) {
  const withoutTitle = content.replace(/^#\s+.+(?:\r?\n|$)/, "").trim();
  const paragraphs = withoutTitle.split(/\n{2,}/).map((item) => item.trim());
  const paragraph = paragraphs.find((item) => {
    if (!item) return false;
    if (/^(#{1,6}|```|~~~|>|[-*]\s|\d+\.\s)/.test(item)) return false;
    return true;
  });
  return stripMarkdownInline(paragraph ?? "").slice(0, 180);
}

function stripMarkdownInline(value: string) {
  return value
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[`*_~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDocumentTags(value: unknown) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，\s]+/)
      : [];
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))].slice(0, 6);
}

function inferDocumentTags(documentPath: string) {
  const parts = documentPath.split("/").filter(Boolean);
  if (documentPath.replace(/\/+$/, "") === AGENT_CONTEXT_ROOT) return ["agent-context"];
  if (parts[0] === "docs") {
    if (parts.length <= 2) return ["document"];
    return parts.slice(1, -1).slice(-2);
  }
  if (parts[0] === SOURCES_ROOT) return ["source"];
  if (parts[0] === "journal") return ["timeline"];
  if (parts[0] === "archive") return ["archive"];
  return ["document"];
}

function isReadmeEntry(entry: WorkspaceFileEntry) {
  return entry.kind === "file" && entry.name.toLowerCase() === "readme.md";
}

function isMarkdownEntry(entry: WorkspaceFileEntry) {
  return entry.kind === "file" && /\.(md|markdown)$/i.test(entry.name);
}

function sortDocumentEntries(entries: WorkspaceFileEntry[]) {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "file" ? -1 : 1;
    return displayEntryName(a).localeCompare(displayEntryName(b), "zh-CN");
  });
}

function displayEntryName(entry: WorkspaceFileEntry) {
  if (entry.kind === "directory") return entry.name;
  return entry.name.replace(/\.(md|markdown)$/i, "");
}

function pageDisplayPath(documentPath: string) {
  if (!documentPath || documentPath === ".") return "Workspace";
  if (documentPath.toLowerCase().endsWith("/readme.md")) return documentPath.slice(0, -"/README.md".length);
  return documentPath.replace(/\.(md|markdown)$/i, "");
}

function titleFromPath(documentPath: string) {
  const name = documentPath.split("/").filter(Boolean).pop() ?? documentPath;
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => (/^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function latestEntryUpdate(entries: Array<{ updatedAt?: string } | undefined>) {
  return entries
    .map((entry) => entry?.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.localeCompare(a))[0] ?? "";
}

async function exportWorkspace(res: http.ServerResponse, context: WorkspaceContext) {
  const tempDir = path.join(config.systemRoot, "exports", randomUUID());
  await fs.mkdir(tempDir, { recursive: true });
  const filename = archiveFilename(context.workspace, "export");
  const archivePath = path.join(tempDir, filename);

  try {
    await createTarGz(context.workspace.rootPath, archivePath);
    return sendArchiveFile(res, archivePath, filename, { cleanupDir: tempDir });
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function createWorkspaceBackup(user: UserRecord, workspace: WorkspaceRecord, reason: "manual" | "scheduled") {
  const dir = workspaceBackupDir(user, workspace);
  await fs.mkdir(dir, { recursive: true });
  await ensureWorkspaceTemplate(workspace.rootPath);

  const filename = archiveFilename(workspace, reason);
  const archivePath = path.join(dir, filename);
  await createTarGz(workspace.rootPath, archivePath);
  await pruneWorkspaceBackups(dir);

  const stat = await fs.stat(archivePath);
  return backupInfoFromStat(filename, stat);
}

async function listWorkspaceBackups(user: UserRecord, workspace: WorkspaceRecord) {
  const dir = workspaceBackupDir(user, workspace);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const backups = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && isSafeBackupId(entry.name))
      .map(async (entry) => backupInfoFromStat(entry.name, await fs.stat(path.join(dir, entry.name))))
  );
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function downloadWorkspaceBackup(res: http.ServerResponse, user: UserRecord, workspace: WorkspaceRecord, id: string) {
  if (!isSafeBackupId(id)) return sendJson(res, 400, { error: "invalid backup id" });

  const backupPath = path.join(workspaceBackupDir(user, workspace), id);
  if (!(await pathExists(backupPath))) return sendJson(res, 404, { error: "backup not found" });
  return sendArchiveFile(res, backupPath, id);
}

async function createTarGz(root: string, archivePath: string) {
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await runProcess("tar", ["-czf", archivePath, "-C", root, "."]);
}

function runProcess(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function sendArchiveFile(
  res: http.ServerResponse,
  archivePath: string,
  filename: string,
  options: { cleanupDir?: string } = {}
) {
  const stat = await fs.stat(archivePath);
  const cleanup = async () => {
    if (options.cleanupDir) await fs.rm(options.cleanupDir, { recursive: true, force: true }).catch(() => undefined);
  };

  res.writeHead(200, {
    "content-type": "application/gzip",
    "content-length": String(stat.size),
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store"
  });

  const stream = createReadStream(archivePath);
  stream.on("error", () => {
    res.destroy();
  });
  res.on("finish", () => void cleanup());
  res.on("close", () => void cleanup());
  stream.pipe(res);
}

function workspaceBackupDir(user: UserRecord, workspace: WorkspaceRecord) {
  return path.join(config.backupsRoot, safePathSegment(user.id), safePathSegment(workspace.id));
}

function archiveFilename(workspace: WorkspaceRecord, reason: "export" | "manual" | "scheduled") {
  return `ai-meditations-${safePathSegment(workspace.slug)}-${reason}-${archiveTimestamp(new Date())}.tar.gz`;
}

function archiveTimestamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function isSafeBackupId(value: string) {
  return /^[a-zA-Z0-9_.-]+\.tar\.gz$/.test(value) && !value.includes("..") && path.basename(value) === value;
}

function backupInfoFromStat(id: string, stat: { size: number; mtime: Date; birthtime?: Date }) {
  const filenameTime = backupTimestampFromId(id);
  return {
    id,
    size: stat.size,
    createdAt: filenameTime ?? stat.mtime.toISOString(),
    downloadUrl: `/api/backups/download?id=${encodeURIComponent(id)}`
  };
}

function backupTimestampFromId(id: string) {
  const match = id.match(/-(\d{8}T\d{6}Z)\.tar\.gz$/);
  if (!match) return undefined;
  const raw = match[1];
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
}

async function pruneWorkspaceBackups(dir: string) {
  const retentionCount = normalizedBackupRetentionCount();
  if (retentionCount <= 0) return;
  const backups = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && isSafeBackupId(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const stale of backups.slice(retentionCount)) {
    await fs.rm(path.join(dir, stale), { force: true }).catch(() => undefined);
  }
}

function normalizedBackupRetentionCount() {
  return Number.isFinite(config.backupRetentionCount) && config.backupRetentionCount > 0
    ? Math.floor(config.backupRetentionCount)
    : 14;
}

function scheduleDailyBackups() {
  const scheduleNext = () => {
    const timer = setTimeout(async () => {
      await runScheduledBackups();
      scheduleNext();
    }, msUntilNextBackupWindow());
    timer.unref();
  };
  scheduleNext();
}

function msUntilNextBackupWindow() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(config.backupHour, config.backupMinute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return Math.max(1000, next.getTime() - now.getTime());
}

async function runScheduledBackups() {
  const workspaces = systemStore.listWorkspaces();
  for (const workspace of workspaces) {
    try {
      const user = systemStore.getUserById(workspace.userId);
      if (user.status !== "active") continue;
      await createWorkspaceBackup(user, workspace, "scheduled");
    } catch (error) {
      console.error("scheduled backup failed:", error);
    }
  }
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const candidatePaths = staticPathCandidates(requested).map((candidate) => path.resolve(publicDir, `.${candidate}`));

  for (const abs of candidatePaths) {
    const rel = path.relative(publicDir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return sendText(res, 403, "Forbidden");
    try {
      const data = await fs.readFile(abs);
      await sendStaticBuffer(req, res, abs, data, staticCacheControl(abs, url));
      return;
    } catch {
      // Try the next candidate.
    }
  }

  const fallbackPath = path.join(publicDir, "index.html");
  const fallback = await fs.readFile(fallbackPath);
  await sendStaticBuffer(req, res, fallbackPath, fallback, "no-cache");
}

function staticPathCandidates(requested: string) {
  const candidates = [requested];
  if (!path.posix.extname(requested)) {
    candidates.push(`${requested}.html`);
    candidates.push(path.posix.join(requested, "index.html"));
  }
  return candidates;
}

async function sendStaticBuffer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  abs: string,
  data: Buffer,
  cacheControl: string
) {
  const type = contentType(abs);
  const headers: Record<string, string> = {
    "content-type": type,
    "cache-control": cacheControl
  };
  let body = data;

  if (req.method !== "HEAD" && isCompressible(type, data)) {
    const encoded = await compressForRequest(req, data);
    if (encoded) {
      body = encoded.body;
      headers["content-encoding"] = encoded.encoding;
      headers.vary = "Accept-Encoding";
    }
  }

  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

function staticCacheControl(abs: string, url: URL) {
  if (path.basename(abs).toLowerCase() === "index.html") return "no-cache";
  if (url.searchParams.has("v")) return "public, max-age=31536000, immutable";
  return "no-cache";
}

function isCompressible(contentTypeValue: string, data: Buffer) {
  if (data.byteLength < MIN_COMPRESSIBLE_BYTES) return false;
  return /^(text\/|application\/javascript|application\/json|image\/svg\+xml)/i.test(contentTypeValue);
}

async function compressForRequest(req: http.IncomingMessage, data: Buffer) {
  const header = req.headers["accept-encoding"];
  const accepted = Array.isArray(header) ? header.join(",") : header ?? "";
  if (/\bbr\b/.test(accepted)) {
    return { encoding: "br", body: await brotliCompressAsync(data) };
  }
  if (/\bgzip\b/.test(accepted)) {
    return { encoding: "gzip", body: await gzipAsync(data) };
  }
  return undefined;
}

function sessionFromRequest(req: http.IncomingMessage) {
  const sid = parseCookies(req.headers.cookie ?? "").sid;
  if (!sid) return undefined;

  const cached = sessions.get(sid);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached;
    sessions.delete(sid);
  }

  const row = systemStore.getWebSessionByIdHash(tokenHash(sid));
  if (!row) return undefined;
  if (row.expiresAt <= Date.now()) {
    revokeWebSession(sid);
    return undefined;
  }

  const session: Session = {
    id: sid,
    userId: row.userId,
    workspaceId: row.workspaceId,
    email: row.email,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt
  };
  sessions.set(sid, session);
  return session;
}

async function requireWebContext(req: http.IncomingMessage, res: http.ServerResponse) {
  const session = sessionFromRequest(req);
  if (!session) {
    setCookie(res, "sid", "", { httpOnly: true, sameSite: "Lax", maxAge: 0, secure: isSecurePublicBaseUrl() });
    sendJson(res, 401, { error: "not authenticated" });
    return undefined;
  }
  return getSessionWorkspaceContext(session);
}

async function pathExists(abs: string) {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

async function getDefaultWorkspaceContext() {
  const workspace = systemStore.getDefaultWorkspace();
  return workspaceContext(systemStore.getUserById(workspace.userId), workspace);
}

async function authenticatePasswordContext(email: string, password: string) {
  const auth = systemStore.authenticatePassword(email, password);
  if (auth) {
    return workspaceContext(auth.user, auth.workspace);
  }

  if (normalizeEmail(email) === normalizeEmail(config.adminEmail) && password === config.adminPassword) {
    return getDefaultWorkspaceContext();
  }

  return undefined;
}

async function getSessionWorkspaceContext(session: Session) {
  return workspaceContext(systemStore.getUserById(session.userId), systemStore.getWorkspaceById(session.workspaceId));
}

async function getOrCreateGoogleUserContext(googleSub: string, email: string) {
  const { user, workspace } = systemStore.getOrCreateGoogleUser(googleSub, email);
  return workspaceContext(user, workspace);
}

async function workspaceContext(user: UserRecord, workspace: WorkspaceRecord): Promise<WorkspaceContext> {
  if (user.status !== "active") throw new AuthzError("user is disabled");
  assertWorkspaceBelongsToUser(user, workspace);
  return {
    user,
    workspace,
    sandbox: await getWorkspaceSandbox(workspace)
  };
}

async function getWorkspaceSandbox(workspace: WorkspaceRecord) {
  const cached = sandboxCache.get(workspace.id);
  if (cached) return cached;

  await ensureWorkspaceTemplate(workspace.rootPath);
  const workspaceSandbox = await WorkspaceSandbox.open(workspace.rootPath, {
    onAudit: (event) => appendAuditEvent(event, workspace.rootPath)
  });
  sandboxCache.set(workspace.id, workspaceSandbox);
  return workspaceSandbox;
}

function saveWebSession(session: Session) {
  systemStore.saveWebSession({
    idHash: tokenHash(session.id),
    userId: session.userId,
    workspaceId: session.workspaceId,
    email: session.email,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt
  });
}

function revokeWebSession(sessionId: string) {
  sessions.delete(sessionId);
  systemStore.revokeWebSessionByIdHash(tokenHash(sessionId));
}

async function mcpBearerAuthContext(authHeader: string): Promise<McpAuthContext | undefined> {
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return undefined;
  const token = match[1];
  const hash = tokenHash(token);

  const tokenRow = systemStore.getActiveMcpTokenByTokenHash(hash);
  if (tokenRow) {
    return mcpAuthContextFromTokenRecord(tokenRow.userId, tokenRow.workspaceId, tokenRow.id, tokenRow.scopes);
  }

  if (constantTimeEqual(token, config.mcpToken)) {
    const context = await getDefaultWorkspaceContext();
    return {
      ...context,
      actorId: "legacy-env-token",
      scopes: OAUTH_SCOPES.join(" ")
    };
  }

  const record = oauthAccessTokens.get(hash);
  if (!record) return undefined;
  if (record.expiresAt < Date.now()) {
    oauthAccessTokens.delete(hash);
    if (record.refreshTokenHash) oauthRefreshTokens.delete(record.refreshTokenHash);
    void saveOAuthState();
    return undefined;
  }

  return mcpAuthContextFromTokenRecord(record.userId, record.workspaceId, record.clientId, record.scope);
}

async function mcpAuthContextFromTokenRecord(userId: string, workspaceId: string, actorId: string, scopes: string): Promise<McpAuthContext | undefined> {
  try {
    const context = await workspaceContext(systemStore.getUserById(userId), systemStore.getWorkspaceById(workspaceId));
    return {
      ...context,
      actorId,
      scopes
    };
  } catch (error) {
    if (error instanceof AuthzError) return undefined;
    throw error;
  }
}

async function loadOAuthState() {
  try {
    const text = await readOAuthStateText();
    const state = JSON.parse(text) as OAuthState;
    const now = Date.now();
    const defaultWorkspace = systemStore.getDefaultWorkspace();

    for (const client of state.clients ?? []) {
      oauthClients.set(client.clientId, client);
    }

    for (const token of state.tokens ?? []) {
      const normalizedToken: OAuthTokenRecord = {
        ...token,
        userId: token.userId || defaultWorkspace.userId,
        workspaceId: token.workspaceId || defaultWorkspace.id
      };
      if (normalizedToken.expiresAt > now) oauthAccessTokens.set(normalizedToken.accessTokenHash, normalizedToken);
      if (normalizedToken.refreshTokenHash && normalizedToken.refreshExpiresAt && normalizedToken.refreshExpiresAt > now) {
        oauthRefreshTokens.set(normalizedToken.refreshTokenHash, normalizedToken);
      }
    }
  } catch {
    // Missing or malformed OAuth state should not prevent the workspace from starting.
  }
}

async function readOAuthStateText() {
  const candidates = [oauthStatePath(), legacyOAuthStatePath()];
  for (const file of candidates) {
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      // Try the next known state location for smooth migration.
    }
  }
  throw new Error("OAuth state not found");
}

async function saveOAuthState() {
  const now = Date.now();
  for (const [hash, token] of oauthAccessTokens) {
    if (token.expiresAt <= now) oauthAccessTokens.delete(hash);
  }
  for (const [hash, token] of oauthRefreshTokens) {
    if (!token.refreshExpiresAt || token.refreshExpiresAt <= now) oauthRefreshTokens.delete(hash);
  }

  const tokens = [...new Set([...oauthAccessTokens.values(), ...oauthRefreshTokens.values()])];
  const state: OAuthState = {
    clients: [...oauthClients.values()],
    tokens
  };

  const file = oauthStatePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2));
}

function oauthStatePath() {
  return path.join(config.systemRoot, "oauth.json");
}

function legacyOAuthStatePath() {
  return path.join(config.workspaceRoot, ".meditations", "oauth.json");
}

async function appendAuditEvent(event: AuditEvent, root: string) {
  const file = path.join(root, ".meditations", "audit.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(event)}\n`);
}

async function readRecentAuditEvents(root: string) {
  const file = path.join(root, ".meditations", "audit.jsonl");
  try {
    const text = await fs.readFile(file, "utf8");
    const events = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-50)
      .reverse()
      .map((line) => JSON.parse(line) as AuditEvent);
    return Promise.all(events.map((event) => withDocumentPath(event, root)));
  } catch {
    return [];
  }
}

async function withDocumentPath(event: AuditEvent, root: string): Promise<AuditEvent> {
  const documentPath = await currentDocumentPathForAuditEvent(event, root);
  return documentPath ? { ...event, documentPath } : event;
}

async function currentDocumentPathForAuditEvent(event: AuditEvent, root: string) {
  if (!["write", "append", "patch", "touch", "mkdir", "mv", "cp"].includes(event.operation)) return "";
  const target = auditTargetPath(event.path ?? "");
  if (!target || target === "." || target === ".meditations" || target.startsWith(".meditations/")) return "";

  for (const candidate of workspacePathCandidates(target)) {
    const abs = path.join(root, candidate);
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile() && candidate.toLowerCase().endsWith(".md")) return candidate;
    } catch {
      continue;
    }
  }

  return "";
}

function auditTargetPath(auditPath: string) {
  return auditPath.split(" -> ").pop()?.trim() ?? "";
}

function workspacePathCandidates(target: string) {
  const normalized = normalizeWorkspacePathRoot(target);
  return normalized === target ? [target] : [normalized, target];
}

function normalizeWorkspacePathRoot(target: string) {
  return target.replace(/^topics(?=\/|$)/, "docs");
}

async function readJournalBlocks(root: string) {
  const journalRoot = path.join(root, "journal");
  const files = await listMarkdownFiles(journalRoot, "journal").catch(() => []);
  const blocks: JournalBlock[] = [];

  for (const filePath of files) {
    if (path.basename(filePath).toLowerCase() === "readme.md") continue;
    const abs = path.join(root, filePath);
    const text = await fs.readFile(abs, "utf8").catch(() => "");
    blocks.push(...parseJournalFile(filePath, text));
  }

  return blocks
    .sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return b.line - a.line;
    })
    .slice(0, 200);
}

async function listMarkdownFiles(absDir: string, virtualDir: string) {
  const rows: string[] = [];
  const entries = await fs.readdir(absDir, { withFileTypes: true });

  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const virtualPath = path.posix.join(virtualDir, entry.name);
    if (entry.isDirectory()) {
      rows.push(...await listMarkdownFiles(abs, virtualPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      rows.push(virtualPath);
    }
  }

  return rows;
}

function parseJournalFile(sourcePath: string, text: string) {
  const lines = text.split(/\r?\n/);
  const date = journalDateFromPath(sourcePath) ?? journalDateFromHeading(lines) ?? "";
  const headingIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^##\s+/.test(line));

  if (headingIndexes.length === 0) {
    const body = lines.filter((line) => !/^#\s+/.test(line)).join("\n").trim();
    if (!body) return [];
    return [journalBlockFromParts(sourcePath, 1, date, "Note", body)];
  }

  return headingIndexes
    .map(({ line, index }, position) => {
      const nextIndex = headingIndexes[position + 1]?.index ?? lines.length;
      const title = line.replace(/^##\s+/, "").trim();
      const body = lines.slice(index + 1, nextIndex).join("\n").trim();
      return journalBlockFromParts(sourcePath, index + 1, date, title, body);
    })
    .filter((block) => block.body || block.title);
}

function journalBlockFromParts(sourcePath: string, line: number, date: string, title: string, rawBody: string): JournalBlock {
  const metadata = parseJournalMetadata(rawBody);
  const body = metadata.body.trim();
  const inferredType = inferJournalBlockType(title, body);
  const type = normalizeJournalType(metadata.values.type) ?? inferredType;
  const status = normalizeJournalStatus(metadata.values.status) ?? (type === "question" ? "pending" : "settled");
  const links = [...new Set([...metadata.links, ...extractMarkdownLinks(body)])];
  const tags = [...new Set(metadata.tags)];
  const excerpt = journalExcerpt(body || title);

  return {
    id: createHash("sha1").update(`${sourcePath}:${line}:${title}`).digest("hex").slice(0, 16),
    sourcePath,
    line,
    date,
    title,
    type,
    status,
    tags,
    links,
    body,
    excerpt
  };
}

function parseJournalMetadata(rawBody: string) {
  const lines = rawBody.split(/\r?\n/);
  const values: Record<string, string> = {};
  const tags: string[] = [];
  const links: string[] = [];
  let index = 0;
  let sawMetadata = false;

  while (index < lines.length && lines[index].trim() === "") index += 1;

  while (index < lines.length) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!match) break;

    sawMetadata = true;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    values[key] = value;

    if (key === "tags") tags.push(...parseJournalListValue(value));
    if (key === "links") {
      links.push(...parseJournalListValue(value));
      index += 1;
      while (index < lines.length) {
        const item = lines[index].match(/^\s*-\s+(.+)$/);
        if (!item) break;
        links.push(item[1].trim());
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  if (sawMetadata && lines[index]?.trim() === "") index += 1;

  return {
    values,
    tags,
    links,
    body: lines.slice(index).join("\n")
  };
}

function parseJournalListValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const unwrapped = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return unwrapped
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function normalizeJournalType(value: string | undefined): JournalBlockType | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["session", "change", "decision", "question", "note"].includes(normalized)) return normalized as JournalBlockType;
  return undefined;
}

function normalizeJournalStatus(value: string | undefined): JournalBlockStatus | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["pending", "todo", "open"].includes(normalized)) return "pending";
  if (["settled", "done", "closed"].includes(normalized)) return "settled";
  return undefined;
}

function inferJournalBlockType(title: string, body: string): JournalBlockType {
  const text = `${title}\n${body}`.toLowerCase();
  if (/决策|决定|判断|decision/.test(text)) return "decision";
  if (/问题|疑问|open questions?|question|待思考/.test(text)) return "question";
  if (/变更|改动|修复|部署|迁移|实现|完成|验证|change|fixed|deployed|migrated/.test(text)) return "change";
  if (/session|会话|发生|今天|本轮|讨论/.test(text)) return "session";
  return "note";
}

function extractMarkdownLinks(body: string) {
  const links = new Set<string>();
  for (const match of body.matchAll(/\(([^)]+\.md(?:#[^)]+)?)\)/g)) links.add(normalizeWorkspacePathRoot(match[1]));
  for (const match of body.matchAll(/(?:^|\s)((?:docs|topics)\/[^\s`]+\.md|journal\/[^\s`]+\.md)/g)) {
    links.add(normalizeWorkspacePathRoot(match[1]));
  }
  return [...links];
}

function journalExcerpt(body: string) {
  return body
    .replace(/^[-*]\s+/gm, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function journalDateFromPath(sourcePath: string) {
  return sourcePath.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
}

function journalDateFromHeading(lines: string[]) {
  return lines.find((line) => /^#\s+\d{4}-\d{2}-\d{2}\s*$/.test(line))?.replace(/^#\s+/, "").trim();
}

function summarizeJournalBlocks(blocks: JournalBlock[]) {
  const byType = Object.fromEntries(["session", "change", "decision", "question", "note"].map((type) => [type, 0]));
  for (const block of blocks) byType[block.type] += 1;
  return {
    total: blocks.length,
    pending: blocks.filter((block) => block.status === "pending").length,
    byType
  };
}

async function listRecentFiles(root: string) {
  const rows: Array<{ path: string; updatedAt: string; size: number }> = [];
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".meditations") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        rows.push({
          path: path.relative(root, abs).replaceAll(path.sep, "/"),
          updatedAt: stat.mtime.toISOString(),
          size: stat.size
        });
      }
    }
  };
  await walk(root);
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
}

async function readBodyText(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const raw = await readBodyText(req);
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

async function readFormBody(req: http.IncomingMessage) {
  return new URLSearchParams(await readBodyText(req));
}

async function readOAuthRequestParams(req: http.IncomingMessage) {
  const raw = await readBodyText(req);
  const contentType = req.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") params.set(key, value);
    }
    return params;
  }
  return new URLSearchParams(raw);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function sendHtml(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function parseCookies(header: string) {
  const out: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (!key) continue;
    out[key] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function setCookie(
  res: http.ServerResponse,
  name: string,
  value: string,
  options: { httpOnly?: boolean; sameSite?: "Lax" | "Strict" | "None"; maxAge?: number; secure?: boolean }
) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push("Secure");

  const cookie = parts.join("; ");
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing.map(String), cookie]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), cookie]);
  }
}

function constantTimeEqual(a: string, b: string) {
  const left = Buffer.from(createHash("sha256").update(a).digest("hex"));
  const right = Buffer.from(createHash("sha256").update(b).digest("hex"));
  return timingSafeEqual(left, right);
}

function hiddenInput(name: string, value: string) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function contentType(abs: string) {
  if (abs.endsWith(".html")) return "text/html; charset=utf-8";
  if (abs.endsWith(".css")) return "text/css; charset=utf-8";
  if (abs.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (abs.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function parseCsvList(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function assertProductionSecurityConfig() {
  if (isLocalBaseUrl(config.baseUrl)) return;

  const problems: string[] = [];
  if (!config.adminPassword || config.adminPassword === "local_dev_password") {
    problems.push("ADMIN_PASSWORD is empty or using the development default");
  }
  if (!config.mcpToken || config.mcpToken === "local-dev-mcp-token") {
    problems.push("MCP_TOKEN is empty or using the development default");
  }
  if (!config.tokenEncryptionSecret || config.tokenEncryptionSecret === "local-dev-token-encryption-secret") {
    problems.push("TOKEN_ENCRYPTION_SECRET is empty or using the development default");
  }

  if (problems.length) {
    throw new Error(`Refusing to start with insecure production config: ${problems.join("; ")}`);
  }
}

function isLocalBaseUrl(rawUrl: string) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
