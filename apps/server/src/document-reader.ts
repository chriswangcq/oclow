import type { WorkspaceFileEntry } from "@ai-meditations/shared";
import type { WorkspaceSandbox } from "@ai-meditations/sandbox";
import matter from "gray-matter";
import { renderWorkspaceFile } from "./markdown.js";

const AGENT_CONTEXT_ROOT = "self";
const LEGACY_AGENT_CONTEXT_ROOT = "docs/self";
const SOURCES_ROOT = "sources";
const SYSTEM_DOCUMENT_PATHS = new Set([AGENT_CONTEXT_ROOT, LEGACY_AGENT_CONTEXT_ROOT]);
const WORKSPACE_DOCUMENT_ROOT = "docs";
const CHILD_DOCUMENTS_DIRECTORY = "sub_docs";
const DOCUMENT_ATTACHMENTS_DIRECTORY = "_attachments";
const DOCUMENT_AUXILIARY_DIRECTORIES = new Set([DOCUMENT_ATTACHMENTS_DIRECTORY, CHILD_DOCUMENTS_DIRECTORY]);

export type ChildDocumentCard = {
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

export type DocumentBody = {
  sourcePath: string;
  displayPath: string;
  html: string;
};

export type DocumentPackage = {
  path: string;
  urlPath: string;
  exists: boolean;
  entries: WorkspaceFileEntry[];
  siblingDocuments: ChildDocumentCard[];
  childDocuments: ChildDocumentCard[];
  body: DocumentBody | null;
};

type RenderMarkdown = (filePath: string, content: string) => Promise<string>;

export async function buildDocumentPackage(
  sandbox: WorkspaceSandbox,
  documentPath: string,
  renderMarkdown: RenderMarkdown = renderWorkspaceFile
): Promise<DocumentPackage> {
  const entries = await sandbox.listFiles(documentPath).catch(() => null);
  if (!entries) {
    return {
      path: documentPath,
      urlPath: workspaceDocumentPathToUrlPath(documentPath),
      exists: false,
      entries: [],
      siblingDocuments: await listSiblingDocumentCards(sandbox, documentPath).catch(() => []),
      childDocuments: [],
      body: null
    };
  }

  const [siblingDocuments, childDocuments, body] = await Promise.all([
    listSiblingDocumentCards(sandbox, documentPath),
    listChildDocumentCards(sandbox, documentPath),
    readDocumentBody(sandbox, documentPath, entries, renderMarkdown)
  ]);
  return {
    path: documentPath,
    urlPath: workspaceDocumentPathToUrlPath(documentPath),
    exists: true,
    entries,
    siblingDocuments,
    childDocuments,
    body
  };
}

export function urlPathToWorkspaceDocumentPath(urlPath: string) {
  const raw = urlPath.split(/[?#]/, 1)[0] ?? "";
  const normalized = raw.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === WORKSPACE_DOCUMENT_ROOT) return WORKSPACE_DOCUMENT_ROOT;
  const parts = normalized.split("/").filter(Boolean);
  if (parts[0] !== WORKSPACE_DOCUMENT_ROOT) return WORKSPACE_DOCUMENT_ROOT;

  const documentSegments = parts.slice(1);
  if (!documentSegments.length) return WORKSPACE_DOCUMENT_ROOT;
  if (documentSegments[0] === CHILD_DOCUMENTS_DIRECTORY) return parts.join("/");
  return [
    WORKSPACE_DOCUMENT_ROOT,
    ...documentSegments.flatMap((segment) => [CHILD_DOCUMENTS_DIRECTORY, segment])
  ].join("/");
}

export function workspaceDocumentPathToUrlPath(workspacePath: string) {
  const normalized = normalizeDocumentWorkspacePath(workspacePath);
  if (normalized === WORKSPACE_DOCUMENT_ROOT) return `/${WORKSPACE_DOCUMENT_ROOT}`;
  const parts = normalized.split("/").filter(Boolean);
  if (parts[0] !== WORKSPACE_DOCUMENT_ROOT) return `/${WORKSPACE_DOCUMENT_ROOT}`;
  const visibleSegments = parts.slice(1).filter((part) => part !== CHILD_DOCUMENTS_DIRECTORY);
  return `/${[WORKSPACE_DOCUMENT_ROOT, ...visibleSegments].map(encodeURIComponent).join("/")}`;
}

function normalizeDocumentWorkspacePath(workspacePath: string) {
  const trimmed = workspacePath.split(/[?#]/, 1)[0]?.replace(/^\/+|\/+$/g, "") || WORKSPACE_DOCUMENT_ROOT;
  if (trimmed.toLowerCase().endsWith("/readme.md")) return trimmed.slice(0, -"/README.md".length) || WORKSPACE_DOCUMENT_ROOT;
  if (trimmed.toLowerCase() === "readme.md") return WORKSPACE_DOCUMENT_ROOT;
  return trimmed.replace(/\.(md|markdown)$/i, "") || WORKSPACE_DOCUMENT_ROOT;
}

export async function listChildDocumentCards(sandbox: WorkspaceSandbox, parentPath: string): Promise<ChildDocumentCard[]> {
  const entries = await sandbox.listFiles(parentPath);
  const directories = await collectChildDocumentEntries(sandbox, parentPath, entries);
  const cards = await Promise.all(directories.map((entry) => describeChildDocument(sandbox, entry.path)));
  return cards.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
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
  const normalized = parentPath.replace(/\/+$/, "") || ".";
  const subDocsPath = `${normalized}/${CHILD_DOCUMENTS_DIRECTORY}`.replace(/^\.\//, "");
  const hasSubDocs = entries.some((entry) => entry.kind === "directory" && entry.name === CHILD_DOCUMENTS_DIRECTORY);
  if (hasSubDocs) {
    const subDocEntries = await sandbox.listFiles(subDocsPath).catch(() => []);
    rows.push(...subDocEntries.filter(isChildDocumentEntry));
  }
  return rows;
}

async function readDocumentBody(
  sandbox: WorkspaceSandbox,
  documentPath: string,
  entries: WorkspaceFileEntry[],
  renderMarkdown: RenderMarkdown
): Promise<DocumentBody | null> {
  const readme = entries.find(isReadmeEntry);
  if (!readme) return null;

  const content = await sandbox.readFile(readme.path);
  return {
    sourcePath: readme.path,
    displayPath: documentDisplayPath(documentPath),
    html: await renderMarkdown(readme.path, content)
  };
}

async function describeChildDocument(sandbox: WorkspaceSandbox, documentPath: string): Promise<ChildDocumentCard> {
  const entries = await sandbox.listFiles(documentPath);
  const readme = entries.find((entry) => entry.kind === "file" && entry.name.toLowerCase() === "readme.md");
  const markdownFiles = entries.filter((entry) => entry.kind === "file" && /\.(md|markdown)$/i.test(entry.name));
  const childDirs = await collectChildDocumentEntries(sandbox, documentPath, entries);
  const auxiliaryDirs = entries.filter(isAuxiliaryDocumentDirectory);
  const readmePath = readme?.path;
  const readmeText = readmePath ? await sandbox.readFile(readmePath).catch(() => "") : "";
  const parsed = parseDocumentReadme(readmeText, documentPath);
  const updatedAt = latestEntryUpdate([readme, ...markdownFiles, ...childDirs, ...auxiliaryDirs]);

  return {
    path: documentPath,
    readmePath,
    title: parsed.title,
    summary: parsed.summary,
    status: parsed.status,
    tags: parsed.tags.length ? parsed.tags : inferDocumentTags(documentPath),
    updatedAt,
    pageCount: readme ? 1 : 0,
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

function documentDisplayPath(documentPath: string) {
  if (!documentPath || documentPath === ".") return "Workspace";
  const pathWithoutExtension = documentPath.toLowerCase().endsWith("/readme.md")
    ? documentPath.slice(0, -"/README.md".length)
    : documentPath.replace(/\.(md|markdown)$/i, "");
  return humanDisplayPath(pathWithoutExtension);
}

function humanDisplayPath(documentPath: string) {
  return documentPath
    .split("/")
    .filter((part) => part && part !== CHILD_DOCUMENTS_DIRECTORY)
    .join("/") || ".";
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
