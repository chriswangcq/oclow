import fs from "node:fs/promises";
import path from "node:path";

const AGENT_CONTEXT_ROOT = "self";
const LEGACY_AGENT_CONTEXT_ROOT = "docs/self";
const SOURCES_ROOT = "sources";
const CHILD_DOCUMENTS_DIRECTORY = "sub_docs";
const DOCUMENT_ATTACHMENTS_DIRECTORY = "_attachments";
const DOCUMENT_AUXILIARY_DIRECTORIES = new Set([CHILD_DOCUMENTS_DIRECTORY, DOCUMENT_ATTACHMENTS_DIRECTORY]);

export async function ensureDefaultWorkspace(root: string) {
  const dirs = ["docs", SOURCES_ROOT, AGENT_CONTEXT_ROOT, "journal", "archive", ".meditations/trash"];
  for (const dir of dirs) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }

  await migrateAgentContextRoot(root);
  await migrateChildDocumentsToSubDocs(root);
  await writeIfMissing(path.join(root, "AGENTS.md"), defaultAgentsContent());
  await writeIfMissing(
    path.join(root, "index.md"),
    [
      "# AI Meditations",
      "",
      "A private Markdown workspace for human reflection and agent-assisted continuity.",
      "",
      "Start from `docs/` for the compiled wiki, `sources/` for raw source material, and `journal/` for the timeline."
    ].join("\n")
  );

  await writeIfMissing(
    path.join(root, "docs", "README.md"),
    [
      "# Docs",
      "",
      "This is the compiled wiki root and human-facing document index.",
      "",
      "Use a top-level directory for each durable document, product area, concept, entity, or long-running thread.",
      "",
      "Document packages follow the Reader rendering contract:",
      "",
      "- `docs/<slug>/` directories are top-level documents under this compiled-wiki root.",
      "- A directory is a document package.",
      "- `README.md` is the document body.",
      "- Sibling `.md` files are pages in the same document.",
      "- `sub_docs/<slug>/` directories are child documents.",
      "- `_attachments/` stores files that belong to this document and is not a child document.",
      "",
      "Recommended README frontmatter:",
      "",
      "```yaml",
      "---",
      "title: Example Document",
      "summary: One sentence explaining what this document is for.",
      "tags: [example, guide]",
      "status: active",
      "---",
      "```",
      "",
      "Status values: `active`, `draft`, `reference`, `archived`.",
      "",
      "Use `sources/` for raw inputs, `journal/` for timeline notes, and `self/` only for stable user context."
    ].join("\n")
  );

  await writeIfMissing(
    path.join(root, SOURCES_ROOT, "README.md"),
    [
      "# Sources",
      "",
      "This is the raw source layer for the LLM Wiki.",
      "",
      "Put curated input here when source material should be preserved: articles, meeting notes, pasted research, imported files, conversation exports, or other raw evidence.",
      "",
      "Rules:",
      "",
      "- Preserve provenance.",
      "- Prefer creating a new source note over rewriting an old one.",
      "- Compile stable synthesis into `../docs/`.",
      "- Record ingest work in `../journal/YYYY/MM/YYYY-MM-DD.md`."
    ].join("\n")
  );

  await writeIfMissing(
    path.join(root, "journal", "README.md"),
    [
      "# Journal",
      "",
      "This is the workspace timeline.",
      "",
      "Use date paths for time-based notes, session logs, document changes, and thoughts that have not yet settled into durable docs.",
      "",
      "Path convention:",
      "",
      "```text",
      "journal/YYYY/MM/YYYY-MM-DD.md",
      "```",
      "",
      "Stable reusable knowledge should move or link into `docs/`."
    ].join("\n")
  );

  await writeIfMissing(
    path.join(root, AGENT_CONTEXT_ROOT, "README.md"),
    [
      "---",
      "title: Agent Context",
      "summary: Durable user-visible context for preferences, principles, and long-lived working style.",
      "tags: [self, memory]",
      "---",
      "",
      "# Agent Context",
      "",
      "This area is user-visible personal context for agents, not hidden agent memory and not an ordinary document.",
      "",
      "Agents may read it when relevant and should update it only for stable, durable preferences, principles, and long-lived working style.",
      "",
      "中文：这里是用户可见的长期 Agent 上下文，不是隐藏记忆，也不是普通文档。只记录稳定、长期有用的偏好、原则和工作方式。"
    ].join("\n")
  );

  await writeIfMissing(
    path.join(root, AGENT_CONTEXT_ROOT, "context.md"),
    ["# Context", "", "This workspace belongs to one user and is exposed to agents through a sandboxed MCP interface."].join("\n")
  );

  await ensureStarterDocument(root);
}

async function migrateAgentContextRoot(root: string) {
  const legacy = path.join(root, LEGACY_AGENT_CONTEXT_ROOT);
  const target = path.join(root, AGENT_CONTEXT_ROOT);
  if (!(await pathExists(legacy))) return;

  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(legacy, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const from = path.join(legacy, entry.name);
    const to = path.join(target, entry.name);
    if (await pathExists(to)) continue;
    await fs.rename(from, to);
  }

  const remaining = await fs.readdir(legacy).catch(() => []);
  if (!remaining.length) await fs.rm(legacy, { recursive: true, force: true });
}

async function migrateChildDocumentsToSubDocs(root: string) {
  for (const docsRootName of ["docs", "topics"]) {
    const docsRoot = path.join(root, docsRootName);
    if (await pathExists(docsRoot)) await migrateDocumentPackageChildren(docsRoot, true);
  }
}

async function migrateDocumentPackageChildren(packageAbs: string, isRoot: boolean) {
  const entries = await fs.readdir(packageAbs, { withFileTypes: true }).catch(() => []);

  const subDocsAbs = path.join(packageAbs, CHILD_DOCUMENTS_DIRECTORY);
  if (await pathExists(subDocsAbs)) {
    const subDocEntries = await fs.readdir(subDocsAbs, { withFileTypes: true }).catch(() => []);
    for (const entry of subDocEntries) {
      if (entry.isDirectory()) await migrateDocumentPackageChildren(path.join(subDocsAbs, entry.name), false);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || DOCUMENT_AUXILIARY_DIRECTORIES.has(entry.name)) continue;
    const childAbs = path.join(packageAbs, entry.name);
    const childHasReadme = await pathExists(path.join(childAbs, "README.md"));

    if (isRoot) {
      await migrateDocumentPackageChildren(childAbs, false);
      continue;
    }

    if (!childHasReadme) continue;
    await fs.mkdir(subDocsAbs, { recursive: true });
    const targetAbs = path.join(subDocsAbs, entry.name);
    if (await pathExists(targetAbs)) continue;
    await fs.rename(childAbs, targetAbs);
    await migrateDocumentPackageChildren(targetAbs, false);
  }
}

async function ensureStarterDocument(root: string) {
  const markerPath = path.join(root, ".meditations", "starter-created");
  if (await pathExists(markerPath)) return;

  const docsRoot = path.join(root, "docs");
  const entries = await fs.readdir(docsRoot, { withFileTypes: true }).catch(() => []);
  const hasUserDocument = entries.some((entry) => entry.isDirectory() && !["self", "ai-meditations-guide"].includes(entry.name));
  if (hasUserDocument) {
    await writeIfMissing(markerPath, `Existing document workspace detected at ${new Date().toISOString()}.\n`);
    return;
  }

  const guideRoot = path.join(docsRoot, "ai-meditations-guide");
  await writeIfMissing(
    path.join(guideRoot, "README.md"),
    [
      "---",
      "summary: Start here to understand the workspace model and agent access.",
      "tags: [guide, onboarding]",
      "---",
      "# How To Use AI Meditations",
      "",
      "AI Meditations is a private Markdown workspace for long-term human reflection and stable agent-assisted writing.",
      "",
      "Think of it as two views over the same files:",
      "",
      "- Humans see a lightweight document space.",
      "- Agents see an MCP-exposed LLM Wiki workspace.",
      "- `sources/` keeps raw material, `docs/` keeps compiled wiki pages, and `journal/` keeps the timeline.",
      "",
      "## Document Structure",
      "",
      "A folder is a document package:",
      "",
      "```text",
      "docs/example/",
      "  README.md",
      "  second-page.md",
      "  _attachments/",
      "  sub_docs/",
      "    child-document/",
      "      README.md",
      "```",
      "",
      "`README.md` is the main page. Other Markdown files in the same directory are pages in the same document. `sub_docs/<slug>/` folders are child documents. `_attachments/` belongs to the current document and is not shown as a child document.",
      "",
      "The physical directory tree is the source of truth. Do not create hidden JSON indexes, node manifests, or ID-only folders unless the user explicitly asks.",
      "",
      "## 中文",
      "",
      "AI 沉思录是一个给人长期保存思考、给 Agent 稳定读写的私有 Markdown 工作区。",
      "",
      "- 人看到的是一个轻量文档空间。",
      "- Agent 看到的是一个通过 MCP 暴露的 LLM Wiki 工作区。",
      "- `sources/` 保存原始资料，`docs/` 保存编译后的 wiki，`journal/` 保存操作时间线。"
    ].join("\n")
  );

  await writeIfMissing(
    path.join(guideRoot, "connect-agent.md"),
    [
      "# Connect Agent",
      "",
      "After connecting, the agent should read:",
      "",
      "```text",
      "AGENTS.md",
      "docs/README.md",
      "sources/README.md",
      "journal/README.md",
      "```",
      "",
      "When writing, prefer MCP `run_shell` with `append` or `patch`. Avoid whole-file replacement unless it is intentional.",
      "",
      "Use `sources/` for raw material. Use `journal/YYYY/MM/YYYY-MM-DD.md` for daily or temporary context. Compile stable memory into `docs/`."
    ].join("\n")
  );

  await writeIfMissing(markerPath, `Starter document created at ${new Date().toISOString()}.\n`);
}

function defaultAgentsContent() {
  return [
    "# AGENTS",
    "",
    "This workspace is AI Meditations: a private Karpathy-style LLM Wiki for one human and many agents.",
    "",
    "`AGENTS.md` is the canonical operating contract for agents. If MCP help, docs, or other guidance conflicts with this file, follow `AGENTS.md` and leave a note about the drift.",
    "",
    "## Language Policy",
    "",
    "System contracts, tool descriptions, and MCP resources are English-first for broad agent compatibility. User-authored documents may be in any language. Preserve the user's language and answer in the user's current language.",
    "",
    "## LLM Wiki Layers",
    "",
    "- `sources/`: raw source material. Preserve provenance and avoid rewriting existing source files.",
    "- `docs/`: compiled wiki. Agents maintain stable summaries, concept pages, decisions, and cross-links.",
    "- `journal/`: chronological operation log and unsettled context.",
    "- `self/`: user-visible durable Agent context. Update conservatively.",
    "- `archive/`: cooled-down or historical material.",
    "",
    "## Document Package Model",
    "",
    "Directories are document packages:",
    "",
    "```text",
    "docs/example-document/",
    "  README.md",
    "  second-page.md",
    "  _attachments/",
    "  sub_docs/",
    "    child-document/",
    "      README.md",
    "```",
    "",
    "`docs/<slug>/` directories are top-level documents under the compiled-wiki root. `README.md` is the body of its directory. Other `.md` files in the same directory are pages in the same document. `sub_docs/<slug>/` directories are child documents. `_attachments/` stores files that belong to the current document and is not a child document.",
    "",
    "The physical directory tree is the source of truth for parent/child relationships. Do not create hidden JSON indexes, node manifests, or ID-only folders unless the user explicitly asks.",
    "",
    "Durable document README files should use lightweight frontmatter when possible:",
    "",
    "```yaml",
    "---",
    "title: Example Document",
    "summary: One sentence explaining what this document is for.",
    "tags: [example, guide]",
    "status: active",
    "---",
    "```",
    "",
    "Allowed status values: `active`, `draft`, `reference`, `archived`.",
    "",
    "## Standard Operations",
    "",
    "Ingest: preserve source in `sources/`, compile stable synthesis into `docs/`, then append a concise event in `journal/`.",
    "",
    "Query: search `docs/` first, consult `sources/` for provenance, answer with uncertainty and file references.",
    "",
    "Lint: look for contradictions, stale claims, orphan pages, missing links, and concepts without pages.",
    "",
    "## Anti-Entropy Rules",
    "",
    "- Read broadly, write sparingly.",
    "- Prefer small patches over whole-file rewrites.",
    "- Prefer updating an existing document over creating a new one.",
    "- Do not paste raw chat transcripts. Distill decisions, state, open questions, and reusable context.",
    "- Default fresh or uncertain context to `journal/YYYY/MM/YYYY-MM-DD.md`.",
    "- Promote stable reusable knowledge into `docs/` only when it has a clear durable home.",
    "- Write `self/` only for stable user preferences, principles, and long-lived working style.",
    "- Do not create new top-level directories unless the user explicitly asks.",
    "",
    "## Reserved Areas",
    "",
    "`docs/`, `sources/`, `journal/`, `self/`, `archive/`, `AGENTS.md`, `index.md`, and `.meditations/` are protected layout entries.",
    "",
    "The MCP `run_shell` tool is a limited file command interpreter, not a real shell. For large content from external MCP clients, prefer `write_file`; for exact replacements, prefer `patch_file`.",
    "",
    "Guiding principle: this workspace should help future agents continue the user's thinking without making memory heavier, noisier, or less trustworthy."
  ].join("\n");
}

async function writeIfMissing(abs: string, content: string) {
  try {
    await fs.access(abs);
  } catch {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

async function pathExists(abs: string) {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}
