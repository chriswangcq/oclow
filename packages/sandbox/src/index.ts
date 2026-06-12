import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AuditEvent, SandboxCommandResult, SandboxScope, WorkspaceFileEntry } from "@ai-meditations/shared";

export type SandboxActor = {
  actorType: AuditEvent["actorType"];
  actorId: string;
};

export type WorkspaceSandboxOptions = {
  outputLimitBytes?: number;
  readLimitBytes?: number;
  writeLimitBytes?: number;
  maxTreeDepth?: number;
  onAudit?: (event: AuditEvent) => void | Promise<void>;
};

export type RunOptions = {
  cwd?: string;
  scope?: SandboxScope;
  actor?: SandboxActor;
};

type ParsedCommand = {
  name: string;
  args: string[];
  body?: string;
};

type MarkdownHeading = {
  raw: string;
  title: string;
  level: number;
  line: number;
  offset: number;
};

type MarkdownSection = {
  heading: MarkdownHeading;
  startLine: number;
  endLine: number;
};

type MarkdownMetadata = {
  title?: string;
  summary?: string;
  status?: string;
  tags: string[];
  headings: number;
  firstParagraph?: string;
};

type DocumentInspectionPage = {
  role: "main" | "page";
  path: string;
  title: string;
  headings: number;
};

type DocumentInspectionChild = {
  path: string;
  readmePath?: string;
  title: string;
  summary?: string;
  status?: string;
  tags: string[];
  hasReadme: boolean;
};

type DocumentInspection = {
  kind: "document-package" | "same-document-page" | "file";
  path: string;
  readmePath?: string;
  currentFile?: string;
  title?: string;
  summary?: string;
  status?: string;
  tags?: string[];
  pages?: DocumentInspectionPage[];
  childDocuments?: DocumentInspectionChild[];
  warnings: string[];
  suggestions: string[];
  recommendedCommands: string[];
};

type WorkspaceHealthScan = {
  markdownFiles: number;
  directories: number;
  skippedMarkdownFiles: number;
  skippedDirectories: number;
  missingRoots: string[];
  issues: Set<string>;
};

type UnifiedDiffLine = {
  kind: "context" | "add" | "remove";
  text: string;
};

type UnifiedDiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: UnifiedDiffLine[];
};

type UnifiedDiffFilePatch = {
  oldPath?: string;
  newPath?: string;
  hunks: UnifiedDiffHunk[];
};

const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_READ_LIMIT = 256 * 1024;
const DEFAULT_WRITE_LIMIT = 128 * 1024;
const DEFAULT_TREE_DEPTH = 4;
const DOCUMENT_PAGE_COUNT_WARNING_THRESHOLD = 12;
const PAGE_HEADING_COUNT_WARNING_THRESHOLD = 24;
const WORKSPACE_HEALTH_DEFAULT_MARKDOWN_LIMIT = 80;
const WORKSPACE_HEALTH_MAX_MARKDOWN_LIMIT = 300;
const WORKSPACE_HEALTH_DIRECTORY_LIMIT = 120;
const WORKSPACE_HEALTH_ROOTS = ["docs", "sources", "self", "journal"];
const WORKSPACE_HEALTH_SPECIAL_FILES = ["AGENTS.md", "index.md"];
const PROTECTED_ROOT_DIRECTORIES = new Set(["docs", "sources", "journal", "archive"]);
const PROTECTED_SYSTEM_PATHS = new Set(["self", "docs/self"]);
const LEGACY_ROOT_ALIASES = new Map([["topics", "docs"]]);
const CHILD_DOCUMENTS_DIRECTORY = "sub_docs";
const DOCUMENT_ATTACHMENTS_DIRECTORY = "_attachments";
const DOCUMENT_AUXILIARY_DIRECTORIES = new Set([DOCUMENT_ATTACHMENTS_DIRECTORY, CHILD_DOCUMENTS_DIRECTORY]);
const DOCUMENT_STATUS_VALUES = new Set(["active", "draft", "reference", "archived"]);

const READ_COMMANDS = new Set([
  "help",
  "pwd",
  "ls",
  "tree",
  "find",
  "rg",
  "cat",
  "nl",
  "head",
  "tail",
  "stat",
  "diff",
  "changes",
  "workspace_health",
  "inspect_doc",
  "toc",
  "section",
  "lint_stale_append",
  "lint_doc"
]);
const WRITE_COMMANDS = new Set(["mkdir", "touch", "write", "append", "patch", "patch_many", "replace_section", "mv", "cp", "archive"]);
const READ_COMMAND_LIST = [...READ_COMMANDS].join(", ");
const WRITE_COMMAND_LIST = [...WRITE_COMMANDS].join(", ");
const ALL_COMMAND_LIST = [...READ_COMMANDS, ...WRITE_COMMANDS].join(", ");

export class SandboxError extends Error {
  constructor(message: string, public readonly code = "SANDBOX_ERROR") {
    super(message);
    this.name = "SandboxError";
  }
}

export class WorkspaceSandbox {
  private readonly changeBaselines = new Map<string, string | undefined>();

  private constructor(
    private readonly root: string,
    private readonly rootReal: string,
    private readonly options: Required<Omit<WorkspaceSandboxOptions, "onAudit">> & Pick<WorkspaceSandboxOptions, "onAudit">
  ) {}

  static async open(root: string, options: WorkspaceSandboxOptions = {}) {
    const resolvedRoot = path.resolve(root);
    await fs.mkdir(resolvedRoot, { recursive: true });
    await fs.mkdir(path.join(resolvedRoot, ".meditations", "trash"), { recursive: true });

    const rootReal = await fs.realpath(resolvedRoot);
    return new WorkspaceSandbox(rootReal, rootReal, {
      outputLimitBytes: options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT,
      readLimitBytes: options.readLimitBytes ?? DEFAULT_READ_LIMIT,
      writeLimitBytes: options.writeLimitBytes ?? DEFAULT_WRITE_LIMIT,
      maxTreeDepth: options.maxTreeDepth ?? DEFAULT_TREE_DEPTH,
      onAudit: options.onAudit
    });
  }

  async run(command: string, runOptions: RunOptions = {}): Promise<SandboxCommandResult> {
    const cwd = this.normalizeVirtualPath(runOptions.cwd ?? ".");

    try {
      const parsedCommands = parseCommands(command);
      for (const parsed of parsedCommands) {
        this.assertCommandAllowed(parsed.name, runOptions.scope ?? "read");
      }

      const stdout = await this.executeAll(parsedCommands, cwd, runOptions);
      return this.result(stdout, cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        stdout: "",
        stderr: message,
        errorType: error instanceof SandboxError ? error.code.toLowerCase() : "internal_error",
        cwd
      };
    }
  }

  private async executeAll(parsedCommands: ParsedCommand[], cwd: string, runOptions: RunOptions) {
    if (parsedCommands.length === 1) return this.execute(parsedCommands[0], cwd, runOptions);

    const transactional = parsedCommands.some((parsed) => WRITE_COMMANDS.has(parsed.name));
    const snapshot = transactional ? await this.createTransactionSnapshot() : undefined;
    const outputs: string[] = [];
    try {
      for (const parsed of parsedCommands) {
        const stdout = await this.execute(parsed, cwd, runOptions);
        outputs.push([`$ ${formatParsedCommandLabel(parsed)}`, stdout || "(ok)"].join("\n"));
      }
      return outputs.join("\n\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (snapshot) await this.restoreTransactionSnapshot(snapshot);
      throw new SandboxError(
        [`batch failed: ${message}`, snapshot ? "Workspace changes from this batch were rolled back." : undefined].filter(Boolean).join("\n"),
        error instanceof SandboxError ? error.code : "SANDBOX_ERROR"
      );
    } finally {
      if (snapshot) await fs.rm(snapshot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async listFiles(virtualPath = ".", cwd = "."): Promise<WorkspaceFileEntry[]> {
    const resolved = await this.resolvePath(virtualPath, cwd);
    const entries = await fs.readdir(resolved.abs, { withFileTypes: true });
    const rows: WorkspaceFileEntry[] = [];

    for (const entry of entries) {
      if (entry.name === ".meditations") continue;
      const rel = toVirtualPath(path.join(resolved.virtualPath, entry.name));
      const stat = await fs.stat(path.join(resolved.abs, entry.name));
      rows.push({
        path: rel,
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
        size: entry.isFile() ? stat.size : undefined,
        updatedAt: stat.mtime.toISOString()
      });
    }

    return rows.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async readFile(virtualPath: string, cwd = ".", range?: { startLine?: number; endLine?: number }) {
    const resolved = await this.resolvePath(virtualPath, cwd);
    await this.assertReadableFile(resolved.abs);
    const text = await fs.readFile(resolved.abs, "utf8");
    if (!range?.startLine && !range?.endLine) return text;

    const lines = text.split(/\r?\n/);
    const start = Math.max((range.startLine ?? 1) - 1, 0);
    const end = Math.min(range.endLine ?? lines.length, lines.length);
    return lines.slice(start, end).join("\n");
  }

  async writeTextFile(
    virtualPath: string,
    content: string,
    options: RunOptions & { mode?: "write" | "append" } = {}
  ): Promise<SandboxCommandResult> {
    const cwd = this.normalizeVirtualPath(options.cwd ?? ".");
    const mode = options.mode ?? "write";

    try {
      this.assertCommandAllowed(mode, options.scope ?? "read");
      return this.result(await this.write(virtualPath, content, cwd, options, mode), cwd);
    } catch (error) {
      return this.errorResult(error, cwd);
    }
  }

  async patchTextFile(
    virtualPath: string,
    oldText: string,
    newText: string,
    options: RunOptions & { dryRun?: boolean } = {}
  ): Promise<SandboxCommandResult> {
    const cwd = this.normalizeVirtualPath(options.cwd ?? ".");

    try {
      this.assertCommandAllowed("patch", options.scope ?? "read");
      const args = options.dryRun ? ["--dry-run"] : [];
      return this.result(await this.patch(virtualPath, JSON.stringify({ old_text: oldText, new_text: newText }), cwd, options, args), cwd);
    } catch (error) {
      return this.errorResult(error, cwd);
    }
  }

  async search(query: string, virtualPath = ".", cwd = ".", context = 0) {
    if (!query) throw new SandboxError("rg requires a query");
    if (!Number.isInteger(context) || context < 0 || context > 10) throw new SandboxError("rg context must be between 0 and 10");
    const resolved = await this.resolvePath(virtualPath, cwd);
    const files = await this.walkFiles(resolved.abs, resolved.virtualPath);
    const matchesQuery = createSearchMatcher(query);
    const matches: string[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      const stat = await fs.stat(file.abs);
      if (stat.size > this.options.readLimitBytes) continue;
      const text = await fs.readFile(file.abs, "utf8").catch(() => "");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (matchesQuery(line)) {
          const start = Math.max(0, index - context);
          const end = Math.min(lines.length - 1, index + context);
          for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
            const key = `${file.virtualPath}:${lineIndex + 1}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const marker = lineIndex === index ? ":" : "-";
            matches.push(`${file.virtualPath}${marker}${lineIndex + 1}${marker} ${lines[lineIndex].trim()}`);
          }
        }
      });
    }

    return matches.join("\n");
  }

  private async execute(parsed: ParsedCommand, cwd: string, runOptions: RunOptions) {
    const [first, second] = parsed.args;

    switch (parsed.name) {
      case "help":
        return helpText(first);
      case "pwd":
        return cwd;
      case "ls":
        return this.formatList(await this.listFiles(first ?? ".", cwd));
      case "tree":
        return this.tree(first ?? ".", cwd, parsed.args);
      case "find":
        return this.find(first ?? ".", second ?? "", cwd);
      case "rg":
        return this.searchCommand(parsed.args, cwd);
      case "cat":
        return this.readCat(cwd, parsed.args);
      case "nl":
        return this.readNumberedFile(first, cwd);
      case "head":
        return this.readHeadTail(cwd, parsed.args, "head");
      case "tail":
        return this.readHeadTail(cwd, parsed.args, "tail");
      case "stat":
        return this.stat(first, cwd);
      case "diff":
        return this.diff(cwd, parsed.args, parsed.body);
      case "changes":
        return this.changes(cwd, parsed.args);
      case "workspace_health":
        return this.workspaceHealth(cwd, parsed.args);
      case "inspect_doc":
        return this.inspectDoc(first ?? ".", cwd);
      case "toc":
        return this.toc(first, cwd);
      case "section":
        return this.section(cwd, parsed.args);
      case "lint_stale_append":
        return this.lintStaleAppend(first, cwd);
      case "lint_doc":
        return this.lintDoc(cwd, parsed.args);
      case "mkdir":
        return this.mkdir(first, cwd, runOptions);
      case "touch":
        return this.touch(first, cwd, runOptions);
      case "write":
        return this.write(first, requireHeredocBody(parsed, "write"), cwd, runOptions, "write");
      case "append":
        return this.write(first, requireHeredocBody(parsed, "append"), cwd, runOptions, "append");
      case "patch":
        return this.patch(first, requireHeredocBody(parsed, "patch"), cwd, runOptions, parsed.args);
      case "patch_many":
        return this.patchMany(first, requireHeredocBody(parsed, "patch_many"), cwd, runOptions, parsed.args);
      case "replace_section":
        return this.replaceSection(cwd, parsed.args, requireHeredocBody(parsed, "replace_section"), runOptions);
      case "mv":
        return this.move(first, second, cwd, runOptions, "mv");
      case "cp":
        return this.move(first, second, cwd, runOptions, "cp");
      case "archive":
        return this.archive(first, cwd, runOptions);
      default:
        throw new SandboxError(`unsupported command: ${parsed.name}`);
    }
  }

  private assertCommandAllowed(command: string, scope: SandboxScope) {
    if (READ_COMMANDS.has(command)) return;
    if (WRITE_COMMANDS.has(command) && (scope === "write" || scope === "admin")) return;
    if (WRITE_COMMANDS.has(command)) {
      throw new SandboxError(
        [
          `Command requires write scope: ${command}.`,
          `Read commands: ${READ_COMMAND_LIST}.`,
          `Write commands: ${WRITE_COMMAND_LIST}.`
        ].join("\n"),
        "FORBIDDEN"
      );
    }
    throw new SandboxError(
      [
        `Unsupported command: ${command}.`,
        "This sandbox is a limited file command interpreter, not bash.",
        `Supported commands: ${ALL_COMMAND_LIST}.`,
        "Try: help",
        "Try: tree docs --depth 2",
        "Try: cat AGENTS.md"
      ].join("\n"),
      "FORBIDDEN"
    );
  }

  private async readCat(cwd: string, args: string[]) {
    const { file, numbered } = parseCatArgs(args);
    if (!file) throw new SandboxError("cat requires a file");
    if (numbered) return this.readNumberedFile(file, cwd);
    return this.readFile(file, cwd);
  }

  private async readNumberedFile(file: string | undefined, cwd: string) {
    if (!file) throw new SandboxError("nl requires a file");
    return formatNumberedLines(await this.readFile(file, cwd));
  }

  private async searchCommand(args: string[], cwd: string) {
    const { query, targets, context } = parseRgArgs(args);
    if (targets.length === 1 && (await this.pathLooksResolvable(query, cwd)) && !(await this.pathLooksResolvable(targets[0], cwd))) {
      throw new SandboxError(
        [
          "rg arguments look reversed.",
          "Use: rg <pattern> <path>",
          `You wrote a path-like first argument (${query}) followed by a non-path target (${targets[0]}).`,
          "Example: rg 下一步 docs/novaic/README.md"
        ].join("\n")
      );
    }
    const outputs: string[] = [];
    for (const target of targets) {
      const output = await this.search(query, target, cwd, context);
      if (output) outputs.push(output);
    }
    return outputs.join("\n");
  }

  private async readHeadTail(cwd: string, args: string[], mode: "head" | "tail") {
    const { file, count } = parseHeadTailArgs(args, mode);
    if (!file) throw new SandboxError(`${mode} requires a file`);

    const text = await this.readFile(file, cwd);
    const lines = text.split(/\r?\n/);
    return (mode === "head" ? lines.slice(0, count) : lines.slice(-count)).join("\n");
  }

  private async stat(file: string | undefined, cwd: string) {
    if (!file) throw new SandboxError("stat requires a path");
    const resolved = await this.resolvePath(file, cwd);
    const stat = await fs.stat(resolved.abs);
    return [
      `path: ${resolved.virtualPath}`,
      `kind: ${stat.isDirectory() ? "directory" : "file"}`,
      `size: ${stat.size}`,
      `updated: ${stat.mtime.toISOString()}`
    ].join("\n");
  }

  private async diff(cwd: string, args: string[], body?: string) {
    const [first, second] = args;
    if (!first) throw new SandboxError("diff requires a file");

    const before = await this.readFile(first, cwd);
    if (body !== undefined) {
      if (Buffer.byteLength(body) > this.options.readLimitBytes) throw new SandboxError("diff body is too large");
      return formatSimpleDiff(first, "proposed", before, body);
    }

    if (!second) {
      const baselinePath = (await this.resolvePath(first, cwd)).virtualPath;
      if (this.changeBaselines.has(baselinePath)) {
        return formatSimpleDiff(first, "current", this.changeBaselines.get(baselinePath) ?? "", before);
      }
      throw new SandboxError(
        [
          "diff requires another file or heredoc content.",
          "Examples:",
          "diff docs/page.md docs/page-copy.md",
          "diff docs/page.md <<EOF",
          "proposed full file content",
          "EOF"
        ].join("\n")
      );
    }

    return formatSimpleDiff(first, second, before, await this.readFile(second, cwd));
  }

  private async changes(cwd: string, args: string[]) {
    const statOnly = args.includes("--stat");
    const paths = [...this.changeBaselines.keys()].sort();
    if (!paths.length) return "no recorded changes";

    const chunks: string[] = [];
    for (const virtualPath of paths) {
      const before = this.changeBaselines.get(virtualPath) ?? "";
      const after = await this.readTrackedCurrentText(virtualPath, cwd);
      const missing = after === undefined;
      const current = after ?? "";
      const summary = changeSummary(before, current);
      chunks.push(`${virtualPath}: ${missing ? "deleted/missing, " : ""}${summary}`);
      if (!statOnly) chunks.push(formatSimpleDiff(virtualPath, missing ? "missing" : "current", before, current));
    }
    return chunks.join("\n");
  }

  private async inspectDoc(target: string, cwd: string) {
    const resolved = await this.resolvePath(target, cwd);
    const stat = await fs.stat(resolved.abs);
    const info = stat.isDirectory()
      ? await this.describeDocumentPackage(resolved.virtualPath, resolved.abs, "document-package")
      : await this.describeFileAsDocument(resolved.virtualPath, resolved.abs, cwd);
    return formatDocumentInspection(info);
  }

  private async describeFileAsDocument(virtualPath: string, abs: string, cwd: string): Promise<DocumentInspection> {
    await this.assertReadableFile(abs);
    if (!virtualPath.endsWith(".md")) {
      return {
        kind: "file",
        path: virtualPath,
        currentFile: virtualPath,
        warnings: ["not a Markdown document file"],
        suggestions: ["Use Markdown files under docs/, journal/, sources/, or self/ for Reader-aware document operations."],
        recommendedCommands: [`cat ${virtualPath}`, `stat ${virtualPath}`]
      };
    }

    const parentPath = toVirtualPath(path.posix.dirname(virtualPath));
    const parent = await this.resolvePath(parentPath, cwd);
    const packageKind = path.posix.basename(virtualPath) === "README.md" ? "document-package" : "same-document-page";
    const info = await this.describeDocumentPackage(parent.virtualPath, parent.abs, packageKind);
    info.currentFile = virtualPath;
    if (packageKind === "same-document-page") {
      info.warnings.push("input is a same-document page, not a child document; inspect the parent package before adding new files");
      info.recommendedCommands.unshift(`toc ${virtualPath}`, `section ${virtualPath} "## Heading"`);
    }
    return info;
  }

  private async describeDocumentPackage(virtualPath: string, abs: string, kind: DocumentInspection["kind"]): Promise<DocumentInspection> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const readmeEntry = entries.find((entry) => entry.isFile() && entry.name === "README.md");
    const readmePath = readmeEntry ? toVirtualPath(path.posix.join(virtualPath, "README.md")) : undefined;
    const readmeAbs = readmeEntry ? path.join(abs, "README.md") : undefined;
    const metadata = readmeAbs ? await readMarkdownMetadata(readmeAbs, this.options.readLimitBytes) : undefined;
    const pages: DocumentInspectionPage[] = [];
    const childDocuments: DocumentInspectionChild[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    if (readmePath) {
      pages.push({
        role: "main",
        path: readmePath,
        title: metadata?.title ?? "README",
        headings: metadata?.headings ?? 0
      });
    } else {
      warnings.push("document package is missing README.md; Reader has no main body for this directory");
      suggestions.push(`Create ${toVirtualPath(path.posix.join(virtualPath, "README.md"))} before adding sibling pages or child documents.`);
    }

    const markdownPages = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of markdownPages) {
      const pagePath = toVirtualPath(path.posix.join(virtualPath, entry.name));
      const pageMeta = await readMarkdownMetadata(path.join(abs, entry.name), this.options.readLimitBytes);
      pages.push({
        role: "page",
        path: pagePath,
        title: pageMeta.title ?? entry.name.replace(/\.md$/, ""),
        headings: pageMeta.headings
      });
      if (pageMeta.headings >= PAGE_HEADING_COUNT_WARNING_THRESHOLD) {
        suggestions.push(`${pagePath} has ${pageMeta.headings} headings; consider splitting stable subtopics into child documents.`);
      }
    }

    if (markdownPages.length >= DOCUMENT_PAGE_COUNT_WARNING_THRESHOLD) {
      suggestions.push(
        `This package has ${markdownPages.length} same-document pages; consider moving durable subtopics into child document packages.`
      );
    }

    const directDocumentDirs = this.directDocumentDirectories(virtualPath, abs, entries);
    if (directDocumentDirs.length) {
      suggestions.push(
        ...directDocumentDirs.map(
          (entry) => `${entry.virtualPath} is not a child document in the current model; move it to ${virtualPath}/${CHILD_DOCUMENTS_DIRECTORY}/${entry.name}/README.md.`
        )
      );
    }

    const childDirs = await this.documentChildDirectories(virtualPath, abs, entries);
    for (const child of childDirs) {
      const childReadmeAbs = path.join(child.abs, "README.md");
      const hasReadme = await pathExists(childReadmeAbs);
      const childMeta = hasReadme ? await readMarkdownMetadata(childReadmeAbs, this.options.readLimitBytes) : undefined;
      childDocuments.push({
        path: child.virtualPath,
        readmePath: hasReadme ? toVirtualPath(path.posix.join(child.virtualPath, "README.md")) : undefined,
        title: childMeta?.title ?? child.name,
        summary: childMeta?.summary,
        status: childMeta?.status,
        tags: childMeta?.tags ?? [],
        hasReadme
      });
      if (!hasReadme) warnings.push(`child document is missing README.md: ${child.virtualPath}`);
      if (hasReadme && !childMeta?.summary) suggestions.push(`${child.virtualPath} has no README frontmatter summary; Reader card may be weak.`);
      if (hasReadme && !childMeta?.tags.length) suggestions.push(`${child.virtualPath} has no README frontmatter tags; Reader card may be weak.`);
    }

    if (virtualPath === "docs" && markdownPages.length > 0) {
      warnings.push("docs root has sibling Markdown pages; durable top-level subjects usually belong in docs/sub_docs/<slug>/README.md");
    }

    return {
      kind,
      path: virtualPath,
      readmePath,
      currentFile: readmePath,
      title: metadata?.title,
      summary: metadata?.summary,
      status: metadata?.status,
      tags: metadata?.tags ?? [],
      pages,
      childDocuments,
      warnings,
      suggestions,
      recommendedCommands: [
        readmePath ? `cat ${readmePath}` : `write ${toVirtualPath(path.posix.join(virtualPath, "README.md"))} <<EOF`,
        readmePath ? `toc ${readmePath}` : "# Title",
        readmePath ? `lint_doc ${readmePath}` : "EOF",
        `tree ${virtualPath} --depth 2`
      ]
    };
  }

  private async toc(file: string | undefined, cwd: string) {
    if (!file) throw new SandboxError("toc requires a file");
    const text = await this.readFile(file, cwd);
    const headings = markdownHeadings(text);
    if (!headings.length) return "no headings";
    return headings.map((heading) => `${"  ".repeat(heading.level - 1)}L${heading.line}: ${"#".repeat(heading.level)} ${heading.title}`).join("\n");
  }

  private async section(cwd: string, args: string[]) {
    const [file, headingArg] = args.filter((arg) => arg !== "--context" && !/^\d+$/.test(arg));
    if (!file || !headingArg) throw new SandboxError('section requires a file and heading, for example: section docs/page.md "## Heading"');
    const contextIndex = args.indexOf("--context");
    const context = contextIndex >= 0 ? Number(args[contextIndex + 1]) : 0;
    if (!Number.isInteger(context) || context < 0 || context > 20) throw new SandboxError("section context must be between 0 and 20");
    const text = await this.readFile(file, cwd);
    const match = findUniqueMarkdownSection(text, headingArg);
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, match.startLine - 1 - context);
    const end = Math.min(lines.length, match.endLine + context);
    return lines.slice(start, end).join("\n");
  }

  private async mkdir(file: string | undefined, cwd: string, runOptions: RunOptions) {
    if (!file) throw new SandboxError("mkdir requires a path");
    const resolved = await this.resolvePath(file, cwd, { allowMissing: true });
    await fs.mkdir(resolved.abs, { recursive: true });
    await this.audit("mkdir", resolved.virtualPath, runOptions);
    return `created ${resolved.virtualPath}`;
  }

  private async touch(file: string | undefined, cwd: string, runOptions: RunOptions) {
    if (!file) throw new SandboxError("touch requires a file");
    const resolved = await this.resolvePath(file, cwd, { allowMissing: true });
    await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
    const handle = await fs.open(resolved.abs, "a");
    await handle.close();
    await this.audit("touch", resolved.virtualPath, runOptions);
    return `touched ${resolved.virtualPath}`;
  }

  private async write(file: string | undefined, body: string, cwd: string, runOptions: RunOptions, mode: "write" | "append") {
    if (!file) throw new SandboxError(`${mode} requires a file`);
    if (Buffer.byteLength(body) > this.options.writeLimitBytes) throw new SandboxError("write body is too large");

    const resolved = await this.resolvePath(file, cwd, { allowMissing: true });
    await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
    await this.recordChangeBaseline(resolved.virtualPath, resolved.abs);
    const before = await fs.readFile(resolved.abs, "utf8").catch(() => "");
    const beforeHash = await hashFileIfExists(resolved.abs);

    if (mode === "append") {
      await fs.appendFile(resolved.abs, body);
    } else {
      await fs.writeFile(resolved.abs, body);
    }

    const afterHash = await hashFileIfExists(resolved.abs);
    const after = await fs.readFile(resolved.abs, "utf8");
    await this.audit(mode, resolved.virtualPath, runOptions, beforeHash, afterHash, Buffer.byteLength(body));
    return formatWriteResult(mode, resolved.virtualPath, before, after, undefined, Buffer.byteLength(body));
  }

  private async patch(file: string | undefined, body: string, cwd: string, runOptions: RunOptions, args: string[]) {
    if (Buffer.byteLength(body) > this.options.writeLimitBytes) throw new SandboxError("patch body is too large");
    if (looksLikeUnifiedDiff(body)) return this.patchUnifiedDiff(file, body, cwd, runOptions, args);

    let payload: { old_text?: string; new_text?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      throw new SandboxError(
        [
          "patch body must be either a unified diff or JSON with string old_text and new_text.",
          "Preferred unified diff example:",
          "patch <<'EOF'",
          "--- a/docs/sub_docs/example/README.md",
          "+++ b/docs/sub_docs/example/README.md",
          "@@ -1,3 +1,3 @@",
          " # Example",
          "-old text",
          "+new text",
          "EOF",
          "",
          "Legacy JSON example:",
          "patch docs/sub_docs/example/README.md <<'EOF'",
          "{\"old_text\":\"# Old\\n\\nText\",\"new_text\":\"# New\\n\\nText with \\\"quotes\\\"\"}",
          "EOF",
          "",
          "JSON strings cannot contain literal line breaks; use \\n for newlines, escape double quotes with a backslash, and escape backslashes as \\\\."
        ].join("\n")
      );
    }

    if (!file) throw new SandboxError("JSON patch requires a file. For git-style unified diff, use: patch <<EOF ... EOF");
    if (typeof payload.old_text !== "string" || typeof payload.new_text !== "string") {
      throw new SandboxError("patch requires old_text and new_text");
    }

    const resolved = await this.resolvePath(file, cwd);
    await this.assertReadableFile(resolved.abs);
    const before = await fs.readFile(resolved.abs, "utf8");
    const occurrences = countOccurrences(before, payload.old_text);
    if (occurrences === 0) throw new SandboxError(patchNotFoundMessage(resolved.virtualPath, before, payload.old_text));
    if (occurrences > 1) {
      throw new SandboxError(
        [
          `patch conflict: old_text matched ${occurrences} locations.`,
          "Make old_text longer by including a few unique lines before or after the target span."
        ].join("\n")
      );
    }

    const beforeHash = await hashFileIfExists(resolved.abs);
    const after = before.replace(payload.old_text, payload.new_text);
    const dryRun = args.includes("--dry-run");
    if (dryRun) {
      return formatWriteResult("patch dry-run", resolved.virtualPath, before, after, nearestHeadingBefore(before, before.indexOf(payload.old_text)));
    }
    await this.recordChangeBaseline(resolved.virtualPath, resolved.abs);
    await fs.writeFile(resolved.abs, after);
    const afterHash = await hashFileIfExists(resolved.abs);
    await this.audit("patch", resolved.virtualPath, runOptions, beforeHash, afterHash, Buffer.byteLength(payload.new_text));
    return formatWriteResult("patch", resolved.virtualPath, before, after, nearestHeadingBefore(before, before.indexOf(payload.old_text)));
  }

  private async patchUnifiedDiff(file: string | undefined, body: string, cwd: string, runOptions: RunOptions, args: string[]) {
    const dryRun = args.includes("--dry-run");
    const filePatches = parseUnifiedDiff(body, file);
    const plans: Array<{
      virtualPath: string;
      abs: string;
      before: string;
      after: string;
      isDeletion: boolean;
    }> = [];

    for (const filePatch of filePatches) {
      if (filePatch.oldPath && filePatch.newPath && filePatch.oldPath !== filePatch.newPath) {
        throw new SandboxError(
          `unified diff rename is not supported in patch: ${filePatch.oldPath} -> ${filePatch.newPath}. Use mv first, then patch the target file.`
        );
      }
      const targetPath = filePatch.newPath ?? filePatch.oldPath;
      if (!targetPath) throw new SandboxError("unified diff file patch has no target path");
      const isDeletion = filePatch.newPath === undefined;
      const resolved = await this.resolvePath(targetPath, cwd, { allowMissing: filePatch.oldPath === undefined });
      const before = await fs.readFile(resolved.abs, "utf8").catch((error) => {
        if (filePatch.oldPath === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
      const after = applyUnifiedDiffToText(before, filePatch, resolved.virtualPath);
      plans.push({ virtualPath: resolved.virtualPath, abs: resolved.abs, before, after, isDeletion });
    }

    if (dryRun) return plans.map((plan) => formatWriteResult("patch dry-run", plan.virtualPath, plan.before, plan.after)).join("\n\n");

    const snapshot = plans.length > 1 ? await this.createTransactionSnapshot() : undefined;
    try {
      for (const plan of plans) {
        const beforeHash = await hashFileIfExists(plan.abs);
        await fs.mkdir(path.dirname(plan.abs), { recursive: true });
        await this.recordChangeBaseline(plan.virtualPath, plan.abs);
        if (plan.isDeletion && plan.after === "") {
          await fs.rm(plan.abs, { force: true });
        } else {
          await fs.writeFile(plan.abs, plan.after);
        }
        const afterHash = await hashFileIfExists(plan.abs);
        await this.audit("patch", plan.virtualPath, runOptions, beforeHash, afterHash, Buffer.byteLength(plan.after) - Buffer.byteLength(plan.before));
      }
    } catch (error) {
      if (snapshot) await this.restoreTransactionSnapshot(snapshot);
      throw error;
    } finally {
      if (snapshot) await fs.rm(snapshot, { recursive: true, force: true }).catch(() => undefined);
    }

    return plans.map((plan) => formatWriteResult("patch", plan.virtualPath, plan.before, plan.after)).join("\n\n");
  }

  private async patchMany(file: string | undefined, body: string, cwd: string, runOptions: RunOptions, args: string[]) {
    if (!file) throw new SandboxError("patch_many requires a file");
    if (Buffer.byteLength(body) > this.options.writeLimitBytes) throw new SandboxError("patch_many body is too large");
    const dryRun = args.includes("--dry-run");
    let payload: Array<{ old_text?: string; new_text?: string }>;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new SandboxError("patch_many body must be a JSON array of {old_text,new_text} objects");
    }
    if (!Array.isArray(payload) || payload.length === 0) throw new SandboxError("patch_many requires a non-empty JSON array");

    const resolved = await this.resolvePath(file, cwd);
    await this.assertReadableFile(resolved.abs);
    const before = await fs.readFile(resolved.abs, "utf8");
    const statuses: string[] = [];
    for (const [index, item] of payload.entries()) {
      if (typeof item.old_text !== "string" || typeof item.new_text !== "string") {
        throw new SandboxError(`patch_many item ${index + 1} requires old_text and new_text`);
      }
      const occurrences = countOccurrences(before, item.old_text);
      const heading = occurrences === 1 ? nearestHeadingBefore(before, before.indexOf(item.old_text)) : undefined;
      statuses.push(`${index + 1}: matches=${occurrences}${heading ? ` heading="${heading.raw}"` : ""}`);
      if (occurrences !== 1) {
        const details =
          occurrences === 0
            ? patchNotFoundMessage(resolved.virtualPath, before, item.old_text)
            : patchAmbiguousMessage(before, item.old_text, occurrences);
        throw new SandboxError([`patch_many aborted: item ${index + 1} matched ${occurrences} locations.`, ...statuses, details].join("\n"));
      }
    }

    let after = before;
    for (const item of payload) {
      after = after.replace(item.old_text as string, item.new_text as string);
    }
    if (dryRun) return [`patch_many dry-run ${resolved.virtualPath}`, ...statuses, changeSummary(before, after)].join("\n");

    const beforeHash = await hashFileIfExists(resolved.abs);
    await this.recordChangeBaseline(resolved.virtualPath, resolved.abs);
    await fs.writeFile(resolved.abs, after);
    const afterHash = await hashFileIfExists(resolved.abs);
    await this.audit("patch_many", resolved.virtualPath, runOptions, beforeHash, afterHash, Buffer.byteLength(after) - Buffer.byteLength(before));
    return [`patch_many ${resolved.virtualPath}`, ...statuses, changeSummary(before, after)].join("\n");
  }

  private async replaceSection(cwd: string, args: string[], body: string, runOptions: RunOptions) {
    const dryRun = args.includes("--dry-run");
    const positional = args.filter((arg) => arg !== "--dry-run");
    const [file, heading] = positional;
    if (!file || !heading) throw new SandboxError('replace_section requires a file and heading, for example: replace_section docs/page.md "## Heading" <<EOF');
    if (Buffer.byteLength(body) > this.options.writeLimitBytes) throw new SandboxError("replace_section body is too large");

    const resolved = await this.resolvePath(file, cwd);
    await this.assertReadableFile(resolved.abs);
    const before = await fs.readFile(resolved.abs, "utf8");
    const match = findUniqueMarkdownSection(before, heading);
    const replacementFirstLine = body.split(/\r?\n/, 1)[0]?.trim();
    if (replacementFirstLine !== match.heading.raw) {
      throw new SandboxError(
        [
          `replace_section body must start with the matched heading: ${match.heading.raw}`,
          `Your first line was: ${replacementFirstLine || "(empty)"}`,
          "Run section or toc, copy the exact heading line, and keep it as the first heredoc line.",
          `Example: replace_section <file> "${match.heading.raw}" <<EOF`
        ].join("\n")
      );
    }
    const lines = before.split(/\r?\n/);
    const after = [...lines.slice(0, match.startLine - 1), ...body.split(/\r?\n/), ...lines.slice(match.endLine)].join("\n");
    if (dryRun) return formatWriteResult("replace_section dry-run", resolved.virtualPath, before, after, match.heading);

    const beforeHash = await hashFileIfExists(resolved.abs);
    await this.recordChangeBaseline(resolved.virtualPath, resolved.abs);
    await fs.writeFile(resolved.abs, after);
    const afterHash = await hashFileIfExists(resolved.abs);
    await this.audit("replace_section", resolved.virtualPath, runOptions, beforeHash, afterHash, Buffer.byteLength(body));
    return formatWriteResult("replace_section", resolved.virtualPath, before, after, match.heading);
  }

  private async lintStaleAppend(file: string | undefined, cwd: string) {
    if (!file) throw new SandboxError("lint_stale_append requires a file");
    const text = await this.readFile(file, cwd);
    return lintStaleAppendText(text);
  }

  private async lintDoc(cwd: string, args: string[]) {
    const file = args.find((arg) => !arg.startsWith("--"));
    if (!file) throw new SandboxError("lint_doc requires a file");
    return this.lintDocument(file, cwd, args);
  }

  private async workspaceHealth(cwd: string, args: string[]) {
    const target = args.find((arg) => !arg.startsWith("--") && !/^\d+$/.test(arg));
    const markdownLimit = parseWorkspaceHealthLimit(args);
    const scan: WorkspaceHealthScan = {
      markdownFiles: 0,
      directories: 0,
      skippedMarkdownFiles: 0,
      skippedDirectories: 0,
      missingRoots: [],
      issues: new Set()
    };

    const roots = target ? [target] : WORKSPACE_HEALTH_ROOTS;
    for (const rootPath of roots) {
      try {
        const resolved = await this.resolvePath(rootPath, cwd);
        await this.collectWorkspaceHealth(resolved.virtualPath, resolved.abs, scan, markdownLimit);
      } catch (error) {
        if (isMissingPathError(error)) scan.missingRoots.push(rootPath);
        else throw error;
      }
    }

    if (!target) {
      for (const specialFile of WORKSPACE_HEALTH_SPECIAL_FILES) {
        try {
          const resolved = await this.resolvePath(specialFile, cwd);
          await this.collectWorkspaceHealth(resolved.virtualPath, resolved.abs, scan, markdownLimit);
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
        }
      }
    }

    return formatWorkspaceHealth(scan, target ? target : WORKSPACE_HEALTH_ROOTS.join(", "), markdownLimit);
  }

  private async collectWorkspaceHealth(virtualPath: string, abs: string, scan: WorkspaceHealthScan, markdownLimit: number): Promise<void> {
    const stat = await fs.stat(abs);
    if (stat.isFile()) {
      if (virtualPath.endsWith(".md")) await this.collectWorkspaceHealthMarkdown(virtualPath, abs, stat.size, scan, markdownLimit);
      return;
    }

    if (!stat.isDirectory()) return;
    if (isAttachmentsPath(canonicalWorkspacePath(virtualPath))) return;
    if (scan.directories >= WORKSPACE_HEALTH_DIRECTORY_LIMIT) {
      scan.skippedDirectories += 1;
      return;
    }

    scan.directories += 1;
    for (const issue of await this.lintDocumentDirectory(virtualPath, abs)) scan.issues.add(issue);

    const entries = (await fs.readdir(abs, { withFileTypes: true }))
      .filter((entry) => entry.name !== ".meditations")
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of entries) {
      const childVirtualPath = toVirtualPath(path.posix.join(virtualPath, entry.name));
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        await this.collectWorkspaceHealth(childVirtualPath, childAbs, scan, markdownLimit);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const childStat = await fs.stat(childAbs);
        await this.collectWorkspaceHealthMarkdown(childVirtualPath, childAbs, childStat.size, scan, markdownLimit);
      }
    }
  }

  private async collectWorkspaceHealthMarkdown(
    virtualPath: string,
    abs: string,
    size: number,
    scan: WorkspaceHealthScan,
    markdownLimit: number
  ) {
    if (scan.markdownFiles >= markdownLimit) {
      scan.skippedMarkdownFiles += 1;
      return;
    }
    if (size > this.options.readLimitBytes) {
      scan.skippedMarkdownFiles += 1;
      scan.issues.add(lintIssue("info", "scan-limit", `Markdown file is too large for initial health scan: ${virtualPath}`));
      return;
    }

    scan.markdownFiles += 1;
    for (const issue of await this.lintMarkdownDocument(virtualPath, abs, [])) scan.issues.add(issue);
  }

  private async lintDocument(target: string, cwd: string, args: string[]) {
    const resolved = await this.resolvePath(target, cwd);
    const stat = await fs.stat(resolved.abs);
    const issues: string[] = [];
    if (stat.isDirectory()) {
      issues.push(...(await this.lintDocumentDirectory(resolved.virtualPath, resolved.abs)));
      const readme = path.join(resolved.abs, "README.md");
      if (await pathExists(readme)) {
        const readmePath = toVirtualPath(path.posix.join(resolved.virtualPath, "README.md"));
        issues.push(...(await this.lintMarkdownDocument(readmePath, readme, args)));
      }
    } else {
      await this.assertReadableFile(resolved.abs);
      issues.push(...(await this.lintMarkdownDocument(resolved.virtualPath, resolved.abs, args)));
      const parent = await this.resolvePath(toVirtualPath(path.posix.dirname(resolved.virtualPath)), cwd);
      issues.push(...(await this.lintDocumentDirectory(parent.virtualPath, parent.abs, { shallow: true })));
    }
    return issues.length ? issues.join("\n") : "no document lint issues found";
  }

  private async lintDocumentDirectory(virtualPath: string, abs: string, options: { shallow?: boolean } = {}) {
    const issues: string[] = [];
    if (isNonDocumentContainerPath(virtualPath)) return issues;
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const hasReadme = entries.some((entry) => entry.isFile() && entry.name === "README.md");
    const mdPages = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md");
    const directDocumentDirs = this.directDocumentDirectories(virtualPath, abs, entries);
    const childDirs = await this.documentChildDirectories(virtualPath, abs, entries);
    const canonicalPath = canonicalWorkspacePath(virtualPath);

    if (!hasReadme && canonicalPath !== "." && isDocumentLikeDirectory(canonicalPath)) {
      issues.push(lintIssue("error", "document-package", `document package missing README.md: ${virtualPath}`));
    }
    if (mdPages.length >= DOCUMENT_PAGE_COUNT_WARNING_THRESHOLD) {
      issues.push(lintIssue("warn", "document-package", `document package has ${mdPages.length} same-document pages; consider splitting durable subtopics into child documents: ${virtualPath}`));
    }
    if (canonicalPath === "docs" && mdPages.length > 0) {
      issues.push(lintIssue("warn", "placement", `docs root contains same-document pages (${mdPages.map((entry) => entry.name).join(", ")}); top-level durable subjects should usually be child document packages`));
    }
    if (!options.shallow) {
      for (const entry of directDocumentDirs) {
        issues.push(
          lintIssue(
            "warn",
            "document-package",
            `direct child directory is not part of the document tree; move to ${virtualPath}/${CHILD_DOCUMENTS_DIRECTORY}/${entry.name}/README.md: ${entry.virtualPath}`
          )
        );
      }
      for (const entry of childDirs) {
        if (!(await pathExists(path.join(entry.abs, "README.md"))) && isDocumentLikeDirectory(canonicalWorkspacePath(entry.virtualPath))) {
          issues.push(lintIssue("error", "document-package", `child document missing README.md: ${entry.virtualPath}`));
        }
      }
    }
    return issues;
  }

  private async documentChildDirectories(virtualPath: string, abs: string, entries: Dirent[]) {
    const rows: Array<{ name: string; virtualPath: string; abs: string }> = [];
    const container = entries.find((entry) => entry.isDirectory() && entry.name === CHILD_DOCUMENTS_DIRECTORY);
    if (container) {
      const containerAbs = path.join(abs, CHILD_DOCUMENTS_DIRECTORY);
      const containerPath = toVirtualPath(path.posix.join(virtualPath, CHILD_DOCUMENTS_DIRECTORY));
      const containerEntries = await fs.readdir(containerAbs, { withFileTypes: true }).catch(() => []);
      for (const entry of containerEntries) {
        if (!entry.isDirectory() || !isDocumentChildDirectoryName(entry.name)) continue;
        rows.push({
          name: entry.name,
          virtualPath: toVirtualPath(path.posix.join(containerPath, entry.name)),
          abs: path.join(containerAbs, entry.name)
        });
      }
    }

    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  private directDocumentDirectories(virtualPath: string, abs: string, entries: Dirent[]) {
    if (!shouldPreferSubDocsContainer(virtualPath)) return [];
    const rows: Array<{ name: string; virtualPath: string; abs: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isDocumentChildDirectoryName(entry.name)) continue;
      const childPath = toVirtualPath(path.posix.join(virtualPath, entry.name));
      rows.push({
        name: entry.name,
        virtualPath: childPath,
        abs: path.join(abs, entry.name)
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async lintMarkdownDocument(virtualPath: string, abs: string, args: string[]) {
    const text = await fs.readFile(abs, "utf8");
    const issues: string[] = [];
    const headings = markdownHeadings(text);
    const root = canonicalWorkspacePath(virtualPath).split("/")[0] ?? "";
    const basename = path.posix.basename(virtualPath);

    if (args.includes("--stale-next-steps") || !args.length || args.some((arg) => !arg.startsWith("--"))) {
      const stale = lintStaleAppendText(text);
      if (stale !== "no stale append issues found") issues.push(...stale.split("\n").map((line) => lintIssue("warn", "stale-state", line)));
    }

    if (virtualPath.endsWith(".md") && headings.filter((heading) => heading.level === 1).length > 1) {
      issues.push(lintIssue("warn", "markdown-structure", `multiple H1 headings in one Markdown page: ${virtualPath}`));
    }
    if (headings.length >= PAGE_HEADING_COUNT_WARNING_THRESHOLD) {
      issues.push(lintIssue("info", "document-size", `Markdown page has ${headings.length} headings; consider splitting stable subtopics if navigation feels heavy: ${virtualPath}`));
    }
    for (let index = 1; index < headings.length; index += 1) {
      const previous = headings[index - 1];
      const current = headings[index];
      if (current.level > previous.level + 1) {
        issues.push(lintIssue("warn", "markdown-structure", `heading level jumps from H${previous.level} to H${current.level}: L${current.line} ${current.raw}`));
      }
    }
    if (basename === "README.md" && !headings.some((heading) => heading.level === 1)) {
      issues.push(lintIssue("warn", "markdown-structure", `README.md has no H1 heading: ${virtualPath}`));
    }

    const frontmatter = parseMarkdownFrontmatter(text);
    if (basename === "README.md" && root === "docs" && virtualPath.split("/").length >= 3) {
      if (!frontmatter.summary) issues.push(lintIssue("info", "reader-card", `README child-document card has no frontmatter summary: ${virtualPath}`));
      if (!frontmatter.tags.length) issues.push(lintIssue("info", "reader-card", `README child-document card has no frontmatter tags: ${virtualPath}`));
      if (frontmatter.status && !DOCUMENT_STATUS_VALUES.has(frontmatter.status)) {
        issues.push(
          lintIssue(
            "warn",
            "reader-card",
            `README frontmatter status should be one of ${[...DOCUMENT_STATUS_VALUES].join(", ")}: ${virtualPath}`
          )
        );
      }
    }

    if (root === "docs" && looksLikeJournalResidue(text)) {
      issues.push(lintIssue("warn", "placement", `docs file looks like journal/session residue; consider journal/YYYY/MM/YYYY-MM-DD.md unless this is stable synthesis: ${virtualPath}`));
    }
    if (root === "sources" && looksLikeCompiledWiki(text)) {
      issues.push(lintIssue("warn", "placement", `sources file looks like compiled wiki synthesis; preserve raw source here and move stable synthesis to docs/: ${virtualPath}`));
    }
    if (root === "self" && looksUnstableForSelf(text)) {
      issues.push(lintIssue("warn", "placement", `self file contains uncertain or temporary language; self/ should hold stable user-visible context only: ${virtualPath}`));
    }

    issues.push(...(await this.lintInternalLinks(virtualPath, text)));
    return issues;
  }

  private async lintInternalLinks(virtualPath: string, text: string) {
    const issues: string[] = [];
    const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
    const baseDir = toVirtualPath(path.posix.dirname(virtualPath));
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = linkPattern.exec(text))) {
      const rawTarget = match[1].trim();
      if (!rawTarget || rawTarget.startsWith("http://") || rawTarget.startsWith("https://") || rawTarget.startsWith("#") || rawTarget.startsWith("mailto:")) continue;
      const targetWithoutAnchor = rawTarget.split("#")[0];
      if (!targetWithoutAnchor || targetWithoutAnchor.includes("://")) continue;
      const resolvedVirtual = toVirtualPath(path.posix.join(baseDir === "." ? "" : baseDir, targetWithoutAnchor));
      if (seen.has(resolvedVirtual)) continue;
      seen.add(resolvedVirtual);
      try {
        await this.resolvePath(resolvedVirtual, ".");
      } catch (error) {
        if (isMissingPathError(error)) issues.push(lintIssue("error", "link", `broken internal link in ${virtualPath}: ${rawTarget} -> ${resolvedVirtual}`));
      }
    }
    return issues;
  }

  private async move(from: string | undefined, to: string | undefined, cwd: string, runOptions: RunOptions, mode: "mv" | "cp") {
    if (!from || !to) throw new SandboxError(`${mode} requires from and to paths`);
    const source = await this.resolvePath(from, cwd);
    if (mode === "mv") this.assertMutablePath(source.virtualPath, mode);
    const target = await this.resolvePath(to, cwd, { allowMissing: true });
    await fs.mkdir(path.dirname(target.abs), { recursive: true });

    if (mode === "cp") {
      await fs.cp(source.abs, target.abs, { recursive: true, errorOnExist: false, force: false });
    } else {
      await fs.rename(source.abs, target.abs);
    }

    await this.audit(mode, `${source.virtualPath} -> ${target.virtualPath}`, runOptions);
    return `${mode === "cp" ? "copied" : "moved"} ${source.virtualPath} -> ${target.virtualPath}`;
  }

  private async archive(file: string | undefined, cwd: string, runOptions: RunOptions) {
    if (!file) throw new SandboxError("archive requires a path");
    const source = await this.resolvePath(file, cwd);
    this.assertMutablePath(source.virtualPath, "archive");
    const stamp = new Date().toISOString().slice(0, 10);
    const targetRel = toVirtualPath(path.posix.join(".meditations", "trash", stamp, source.virtualPath));
    const targetAbs = await uniqueArchiveTarget(path.join(this.root, targetRel));
    await fs.mkdir(path.dirname(targetAbs), { recursive: true });
    await fs.rename(source.abs, targetAbs);
    await this.audit("archive", source.virtualPath, runOptions);
    return `archived ${source.virtualPath}`;
  }

  private async tree(virtualPath: string, cwd: string, args: string[]) {
    const depthFlag = args.indexOf("--depth");
    const maxDepth = depthFlag >= 0 ? Number(args[depthFlag + 1]) : this.options.maxTreeDepth;
    if (!Number.isFinite(maxDepth) || maxDepth < 1 || maxDepth > 10) throw new SandboxError("invalid tree depth");

    const resolved = await this.resolvePath(virtualPath, cwd);
    const lines: string[] = [resolved.virtualPath === "." ? "." : resolved.virtualPath];
    await this.treeInto(resolved.abs, resolved.virtualPath, lines, "", maxDepth);
    return lines.join("\n");
  }

  private async treeInto(abs: string, virtualPath: string, lines: string[], prefix: string, depth: number) {
    if (depth <= 0) return;
    const entries = await this.listFiles(".", virtualPath);
    for (const [index, entry] of entries.entries()) {
      const isLast = index === entries.length - 1;
      lines.push(`${prefix}${isLast ? "`-- " : "|-- "}${entry.name}${entry.kind === "directory" ? "/" : ""}`);
      if (entry.kind === "directory") {
        await this.treeInto(path.join(abs, entry.name), entry.path, lines, `${prefix}${isLast ? "    " : "|   "}`, depth - 1);
      }
    }
  }

  private async find(virtualPath: string, pattern: string, cwd: string) {
    const resolved = await this.resolvePath(virtualPath, cwd);
    const files = await this.walkFiles(resolved.abs, resolved.virtualPath);
    const rows = files
      .map((file) => file.virtualPath)
      .filter((file) => !pattern || file.includes(pattern));
    return rows.join("\n");
  }

  private async walkFiles(absRoot: string, virtualRoot: string) {
    const rows: Array<{ abs: string; virtualPath: string }> = [];
    const walk = async (abs: string, virtualPath: string) => {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".meditations") continue;
        const childAbs = path.join(abs, entry.name);
        const childVirtual = toVirtualPath(path.join(virtualPath, entry.name));
        if (entry.isDirectory()) {
          await walk(childAbs, childVirtual);
        } else if (entry.isFile()) {
          rows.push({ abs: childAbs, virtualPath: childVirtual });
        }
      }
    };
    const stat = await fs.stat(absRoot);
    if (stat.isDirectory()) await walk(absRoot, virtualRoot);
    else rows.push({ abs: absRoot, virtualPath: virtualRoot });
    return rows;
  }

  private async assertReadableFile(abs: string) {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw new SandboxError("path is not a file");
    if (stat.size > this.options.readLimitBytes) throw new SandboxError("file is too large to read directly");
    await fs.access(abs, constants.R_OK);
  }

  private formatList(entries: WorkspaceFileEntry[]) {
    return entries
      .map((entry) => `${entry.kind === "directory" ? "d" : "-"} ${entry.path}${entry.kind === "directory" ? "/" : ""}`)
      .join("\n");
  }

  private normalizeVirtualPath(input: string) {
    if (!input || input === ".") return ".";
    if (path.isAbsolute(input) || input.startsWith("/")) throw new SandboxError("absolute paths are not allowed");
    const parts = input.split(/[\\/]+/).filter(Boolean);
    if (parts.includes("..")) throw new SandboxError("parent path segments are not allowed");
    const normalized = path.posix.normalize(parts.join("/"));
    if (normalized === ".") return ".";
    if (normalized.startsWith("../")) throw new SandboxError("path escapes workspace");
    return normalized;
  }

  private async resolvePath(input: string, cwd = ".", options: { allowMissing?: boolean } = {}) {
    const normalizedCwd = this.normalizeVirtualPath(cwd);
    const inputPath = this.normalizeVirtualPath(input || ".");
    const virtualPath = toVirtualPath(path.posix.join(normalizedCwd === "." ? "" : normalizedCwd, inputPath));
    const candidates = workspacePathResolutionCandidates(virtualPath, Boolean(options.allowMissing));
    let accessError: unknown;

    for (const candidate of candidates) {
      if (candidate === ".meditations" || candidate.startsWith(".meditations/")) {
        throw new SandboxError(".meditations is reserved");
      }

      const abs = path.resolve(this.root, candidate === "." ? "" : candidate);
      const relFromRoot = path.relative(this.rootReal, abs);
      if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
        throw new SandboxError("path escapes workspace");
      }

      await this.assertNoSymlinkEscape(candidate);
      if (!options.allowMissing) {
        try {
          await fs.access(abs);
        } catch (error) {
          accessError = error;
          continue;
        }
      }
      return { abs, virtualPath: candidate };
    }

    if (accessError) throw new SandboxError(`path error: path not found: ${virtualPath}`, "PATH_ERROR");
    throw new SandboxError(`path error: path not found: ${virtualPath}`, "PATH_ERROR");
  }

  private async assertNoSymlinkEscape(virtualPath: string) {
    if (virtualPath === ".") return;
    const parts = virtualPath.split("/");
    let current = this.root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new SandboxError("symlinks are not allowed in workspace paths");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  private assertMutablePath(virtualPath: string, operation: string) {
    const canonicalPath = canonicalWorkspacePath(virtualPath);
    if (PROTECTED_ROOT_DIRECTORIES.has(canonicalPath)) {
      throw new SandboxError(`${operation} is not allowed for protected root directory: ${canonicalPath}`, "PROTECTED_ROOT");
    }
    if (isProtectedSystemPath(canonicalPath)) {
      throw new SandboxError(`${operation} is not allowed for protected system path: ${canonicalPath}`, "PROTECTED_SYSTEM_PATH");
    }
  }

  private async audit(
    operation: string,
    targetPath: string,
    runOptions: RunOptions,
    beforeHash?: string,
    afterHash?: string,
    bytesWritten?: number
  ) {
    const actor = runOptions.actor ?? { actorType: "system" as const, actorId: "system" };
    const event: AuditEvent = {
      id: randomUUID(),
      time: new Date().toISOString(),
      actorType: actor.actorType,
      actorId: actor.actorId,
      operation,
      path: targetPath,
      beforeHash,
      afterHash,
      bytesWritten,
      command: undefined
    };
    await this.options.onAudit?.(event);
  }

  private async recordChangeBaseline(virtualPath: string, abs: string) {
    if (this.changeBaselines.has(virtualPath)) return;
    const before = await fs.readFile(abs, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    this.changeBaselines.set(virtualPath, before);
  }

  private async readTrackedCurrentText(virtualPath: string, cwd: string) {
    try {
      const resolved = await this.resolvePath(virtualPath, cwd);
      return await fs.readFile(resolved.abs, "utf8");
    } catch (error) {
      if (isMissingPathError(error)) return undefined;
      throw error;
    }
  }

  private async pathLooksResolvable(input: string, cwd: string) {
    try {
      await this.resolvePath(input, cwd);
      return true;
    } catch {
      return false;
    }
  }

  private async createTransactionSnapshot() {
    const snapshot = await fs.mkdtemp(path.join(path.dirname(this.root), `.ai-meditations-txn-${path.basename(this.root)}-`));
    await copyWorkspaceContents(this.root, snapshot);
    return snapshot;
  }

  private async restoreTransactionSnapshot(snapshot: string) {
    await clearDirectoryContents(this.root);
    await copyWorkspaceContents(snapshot, this.root);
    await fs.mkdir(path.join(this.root, ".meditations", "trash"), { recursive: true });
  }

  private result(stdout: string, cwd: string): SandboxCommandResult {
    const bytes = Buffer.byteLength(stdout);
    if (bytes <= this.options.outputLimitBytes) return { ok: true, stdout, cwd };
    return {
      ok: true,
      stdout: Buffer.from(stdout).subarray(0, this.options.outputLimitBytes).toString("utf8"),
      cwd,
      truncated: true
    };
  }

  private errorResult(error: unknown, cwd: string): SandboxCommandResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      stdout: "",
      stderr: message,
      errorType: error instanceof SandboxError ? error.code.toLowerCase() : "internal_error",
      cwd
    };
  }
}

function parseCommands(command: string): ParsedCommand[] {
  const trimmed = command.trim();
  if (!trimmed) throw new SandboxError("empty command");
  const lines = trimmed.replace(/\r\n/g, "\n").split("\n");
  const commands: ParsedCommand[] = [];
  let lastHeredocClose: { delimiter: string; line: number } | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    if (line.includes("<<")) {
      const heredocHeader = line.match(/^([a-z_]+)(?:\s+(.*?))?\s+<<(?:(['"])([A-Za-z0-9_-]+)\3|([A-Za-z0-9_-]+))\s*$/);
      if (!heredocHeader) {
        throw new SandboxError(
          "parse_error: invalid heredoc syntax. Use: write path.md <<EOF\\ncontent\\nEOF",
          "PARSE_ERROR"
        );
      }

      const [, name, argText = "", , quotedDelimiter, bareDelimiter] = heredocHeader;
      const delimiter = quotedDelimiter ?? bareDelimiter;
      const bodyLines: string[] = [];
      let closed = false;
      index += 1;
      for (; index < lines.length; index += 1) {
        if (lines[index] === delimiter) {
          closed = true;
          break;
        }
        bodyLines.push(lines[index]);
      }

      if (!closed) {
        throw new SandboxError(`parse_error: missing heredoc terminator ${delimiter} on its own line`, "PARSE_ERROR");
      }

      commands.push({ name, args: tokenize(argText), body: bodyLines.join("\n") });
      lastHeredocClose = { delimiter, line: index + 1 };
      continue;
    }

    const parsed = parseSimpleCommand(line, lastHeredocClose);
    if (!READ_COMMANDS.has(parsed.name) && !WRITE_COMMANDS.has(parsed.name) && lastHeredocClose) {
      throw heredocDelimiterCollisionError(lastHeredocClose, line);
    }
    commands.push(parsed);
    lastHeredocClose = undefined;
  }

  if (!commands.length) throw new SandboxError("empty command");
  return commands;
}

function parseCommand(command: string): ParsedCommand {
  const commands = parseCommands(command);
  if (commands.length !== 1) {
    throw new SandboxError("parse_error: expected exactly one command", "PARSE_ERROR");
  }
  return commands[0];
}

function parseSimpleCommand(line: string, lastHeredocClose?: { delimiter: string; line: number }): ParsedCommand {
  if (line.includes("<<")) {
    throw new SandboxError(
      "parse_error: invalid heredoc syntax. Use: write path.md <<EOF\\ncontent\\nEOF",
      "PARSE_ERROR"
    );
  }

  const tokens = tokenize(line);
  const [name, ...args] = tokens;
  if (!name) throw new SandboxError("empty command");
  if (!/^[a-z_]+$/.test(name)) {
    if (lastHeredocClose) throw heredocDelimiterCollisionError(lastHeredocClose, line);
    throw new SandboxError(`parse_error: invalid command: ${name}`, "PARSE_ERROR");
  }
  return { name, args };
}

function formatParsedCommandLabel(parsed: ParsedCommand) {
  return [parsed.name, ...parsed.args].join(" ");
}

function heredocDelimiterCollisionError(lastHeredocClose: { delimiter: string; line: number }, nextLine: string) {
  return new SandboxError(
    [
      "parse_error: content after heredoc delimiter is not a supported command.",
      `The delimiter ${lastHeredocClose.delimiter} closed the previous heredoc at line ${lastHeredocClose.line}.`,
      `Next line was: ${nextLine}`,
      `If that ${lastHeredocClose.delimiter} line was intended as Markdown content, use a delimiter that does not appear alone in the body, for example <<DOC ... DOC.`,
      "A heredoc delimiter closes at the first line exactly equal to it."
    ].join("\n"),
    "PARSE_ERROR"
  );
}

function requireHeredocBody(parsed: ParsedCommand, command: "write" | "append" | "patch" | "patch_many" | "replace_section") {
  if (parsed.body !== undefined) return parsed.body;
  throw new SandboxError(
    [
      `${command} requires heredoc content.`,
      "Inline content is not accepted because it can silently lose Markdown formatting.",
      "Use <<EOF or <<'EOF'; both are accepted. Put the closing EOF on its own final line.",
      "Example:",
      `${command} path/to/file.md <<EOF`,
      "# Title",
      "content",
      "EOF",
      "",
      "If the content itself contains a line exactly equal to EOF, choose a unique delimiter such as DOC."
    ].join("\n"),
    "PARSE_ERROR"
  );
}

function tokenize(input: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) throw new SandboxError("parse_error: unterminated quote", "PARSE_ERROR");
  if (current) tokens.push(current);
  return tokens;
}

function parseHeadTailArgs(args: string[], mode: "head" | "tail") {
  let count = 20;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-n" || arg === "--lines") {
      count = parseLineCount(args[index + 1], mode);
      index += 1;
      continue;
    }

    const inlineLines = arg.match(/^--lines=(\d+)$/);
    if (inlineLines) {
      count = parseLineCount(inlineLines[1], mode);
      continue;
    }

    if (arg.startsWith("-")) throw new SandboxError(`parse_error: unsupported ${mode} flag: ${arg}`, "PARSE_ERROR");
    positional.push(arg);
  }

  if (positional.length === 2 && /^\d+$/.test(positional[1])) {
    count = parseLineCount(positional[1], mode);
    positional.pop();
  }

  if (positional.length !== 1) {
    throw new SandboxError(`parse_error: use ${mode} <file> [count] or ${mode} -n <count> <file>`, "PARSE_ERROR");
  }

  const file = positional[0];
  return { file, count };
}

function parseLineCount(value: string | undefined, mode: "head" | "tail") {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new SandboxError(`parse_error: ${mode} line count must be an integer between 1 and 1000`, "PARSE_ERROR");
  }
  return count;
}

function parseCatArgs(args: string[]) {
  const numbered = args.includes("-n");
  const file = args.find((arg) => arg !== "-n");
  return { file, numbered };
}

function parseRgArgs(args: string[]) {
  let context = 0;
  const rest: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-n" || arg === "--line-number") {
      continue;
    }

    if (arg === "-C" || arg === "--context") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 0 || value > 10) {
        throw new SandboxError("parse_error: rg context must be between 0 and 10", "PARSE_ERROR");
      }
      context = value;
      index += 1;
      continue;
    }

    const inlineContext = arg.match(/^--context=(\d+)$/);
    if (inlineContext) {
      context = Number(inlineContext[1]);
      if (context > 10) throw new SandboxError("parse_error: rg context must be between 0 and 10", "PARSE_ERROR");
      continue;
    }

    if (arg.startsWith("-")) {
      throw new SandboxError(`parse_error: unsupported rg flag: ${arg}. Use: rg [-n] [-C N] <pattern> [path...]`, "PARSE_ERROR");
    }

    rest.push(arg);
  }

  const [query, ...targets] = rest;
  if (!query) throw new SandboxError("parse_error: rg requires a pattern. Use: rg <pattern> [path...]", "PARSE_ERROR");
  return { query, targets: targets.length ? targets : ["."], context };
}

function createSearchMatcher(query: string) {
  try {
    const regex = new RegExp(query, "i");
    return (line: string) => regex.test(line);
  } catch {
    const needle = query.toLowerCase();
    return (line: string) => line.toLowerCase().includes(needle);
  }
}

function formatNumberedLines(text: string) {
  const lines = text.split(/\r?\n/);
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width, " ")}\t${line}`).join("\n");
}

function formatDocumentInspection(info: DocumentInspection) {
  const lines = [
    `kind: ${info.kind}`,
    `path: ${info.path}`,
    info.readmePath ? `body: ${info.readmePath}` : "body: (missing README.md)",
    info.currentFile ? `current_file: ${info.currentFile}` : undefined,
    info.title ? `title: ${info.title}` : undefined,
    info.summary ? `summary: ${info.summary}` : undefined,
    info.status ? `status: ${info.status}` : undefined,
    info.tags?.length ? `tags: ${info.tags.join(", ")}` : undefined,
    ""
  ].filter((line): line is string => line !== undefined);

  if (info.pages?.length) {
    lines.push(`same-document pages (${info.pages.length}):`);
    for (const page of info.pages) {
      lines.push(`- [${page.role}] ${page.path} title="${page.title}" headings=${page.headings}`);
    }
    lines.push("");
  } else {
    lines.push("same-document pages (0):", "");
  }

  if (info.childDocuments?.length) {
    lines.push(`child documents (${info.childDocuments.length}):`);
    for (const child of info.childDocuments) {
      const summary = child.summary ? ` summary="${child.summary}"` : "";
      const status = child.status ? ` status=${child.status}` : "";
      const tags = child.tags.length ? ` tags=[${child.tags.join(", ")}]` : "";
      lines.push(`- ${child.path}${child.hasReadme ? "" : " (missing README.md)"} title="${child.title}"${summary}${status}${tags}`);
    }
    lines.push("");
  } else {
    lines.push("child documents (0):", "");
  }

  if (info.warnings.length) {
    lines.push("warnings:");
    lines.push(...info.warnings.map((warning) => `- ${warning}`));
    lines.push("");
  }

  if (info.suggestions.length) {
    lines.push("suggestions:");
    lines.push(...info.suggestions.map((suggestion) => `- ${suggestion}`));
    lines.push("");
  }

  lines.push("recommended next commands:");
  lines.push(...info.recommendedCommands.map((command) => `- ${command}`));
  return lines.join("\n");
}

function isDocumentChildDirectoryName(name: string) {
  return name !== ".meditations" && !DOCUMENT_AUXILIARY_DIRECTORIES.has(name);
}

function shouldPreferSubDocsContainer(virtualPath: string) {
  const canonical = canonicalWorkspacePath(virtualPath);
  return (canonical === "docs" || canonical.startsWith("docs/")) && path.posix.basename(canonical) !== CHILD_DOCUMENTS_DIRECTORY;
}

function isNonDocumentContainerPath(virtualPath: string) {
  const canonical = canonicalWorkspacePath(virtualPath);
  return isAttachmentsPath(canonical) || path.posix.basename(canonical) === CHILD_DOCUMENTS_DIRECTORY;
}

function isAttachmentsPath(virtualPath: string) {
  return virtualPath.split("/").includes(DOCUMENT_ATTACHMENTS_DIRECTORY);
}

function formatSimpleDiff(beforeLabel: string, afterLabel: string, beforeText: string, afterText: string) {
  if (beforeText === afterText) return "no changes";

  const beforeLines = beforeText.split(/\r?\n/);
  const afterLines = afterText.split(/\r?\n/);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeChanged = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterChanged = afterLines.slice(prefix, afterLines.length - suffix);
  const beforeStart = prefix + 1;
  const afterStart = prefix + 1;
  const output = [
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    `@@ -${beforeStart},${beforeChanged.length} +${afterStart},${afterChanged.length} @@`
  ];

  output.push(...beforeChanged.map((line) => `- ${line}`));
  output.push(...afterChanged.map((line) => `+ ${line}`));
  return output.join("\n");
}

function markdownHeadings(text: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let inFence = false;
  let offset = 0;
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (match) {
        headings.push({
          raw: line.trim(),
          title: match[2].trim(),
          level: match[1].length,
          line: index + 1,
          offset
        });
      }
    }
    offset += Buffer.byteLength(line) + 1;
  }

  return headings;
}

async function readMarkdownMetadata(abs: string, readLimitBytes: number): Promise<MarkdownMetadata> {
  const stat = await fs.stat(abs);
  if (stat.size > readLimitBytes) {
    return { title: path.basename(abs, ".md"), tags: [], headings: 0, summary: "file is too large to summarize directly" };
  }
  const text = await fs.readFile(abs, "utf8");
  const frontmatter = parseMarkdownFrontmatter(text);
  const headings = markdownHeadings(text);
  const title = frontmatter.title ?? headings.find((heading) => heading.level === 1)?.title;
  const firstParagraph = firstMarkdownParagraph(stripMarkdownFrontmatter(text));
  return {
    title,
    summary: frontmatter.summary ?? firstParagraph,
    status: frontmatter.status,
    tags: frontmatter.tags,
    headings: headings.length,
    firstParagraph
  };
}

function parseMarkdownFrontmatter(text: string) {
  const empty = {
    title: undefined as string | undefined,
    summary: undefined as string | undefined,
    status: undefined as string | undefined,
    tags: [] as string[]
  };
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return empty;
  const body = match[1].split(/\r?\n/);
  let title: string | undefined;
  let summary: string | undefined;
  let status: string | undefined;
  let tags: string[] = [];
  for (const line of body) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "title") title = unquoteYamlScalar(value);
    if (key === "summary") summary = unquoteYamlScalar(value);
    if (key === "status") status = unquoteYamlScalar(value).toLowerCase();
    if (key === "tags") tags = parseInlineTags(value);
  }
  return { title, summary, status, tags };
}

function stripMarkdownFrontmatter(text: string) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function parseInlineTags(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(",")
    .map((tag) => unquoteYamlScalar(tag.trim()))
    .filter(Boolean);
}

function unquoteYamlScalar(value: string) {
  return value.replace(/^['"]|['"]$/g, "").trim();
}

function firstMarkdownParagraph(text: string) {
  const lines = text.split(/\r?\n/);
  const paragraph: string[] = [];
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || line.startsWith("#") || line.startsWith("- ") || line.startsWith("* ") || line.startsWith(">")) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line);
  }
  const joined = paragraph.join(" ").trim();
  return joined ? truncateLineForError(joined, 180) : undefined;
}

function normalizeHeadingQuery(input: string) {
  const trimmed = input.trim();
  const match = trimmed.match(/^(#{1,6})\s+(.+)$/);
  return {
    raw: trimmed,
    level: match ? match[1].length : undefined,
    title: (match ? match[2] : trimmed).replace(/\s+#+\s*$/, "").trim()
  };
}

function findUniqueMarkdownSection(text: string, headingQuery: string): MarkdownSection {
  const headings = markdownHeadings(text);
  const query = normalizeHeadingQuery(headingQuery);
  const matches = headings.filter((heading) => {
    if (query.level !== undefined && heading.level !== query.level) return false;
    return heading.title === query.title || heading.raw === query.raw;
  });

  if (!matches.length) {
    const candidates = nearestHeadingCandidates(headings, query.title);
    throw new SandboxError(
      [
        `section heading not found: ${headingQuery}`,
        ...(candidates.length ? ["Candidate headings:", ...candidates.map((heading) => `L${heading.line}: ${heading.raw}`)] : [])
      ].join("\n")
    );
  }

  if (matches.length > 1) {
    throw new SandboxError(
      [
        `section heading matched ${matches.length} locations: ${headingQuery}`,
        ...matches.map((heading) => `L${heading.line}: ${heading.raw}`)
      ].join("\n")
    );
  }

  const heading = matches[0];
  const next = headings.find((candidate) => candidate.line > heading.line && candidate.level <= heading.level);
  const lines = text.split(/\r?\n/);
  return {
    heading,
    startLine: heading.line,
    endLine: next ? next.line - 1 : lines.length
  };
}

function nearestHeadingCandidates(headings: MarkdownHeading[], title: string) {
  const ranked = headings
    .map((heading) => ({
      heading,
      score: patchCandidateScore(normalizePatchCandidate(heading.title), normalizePatchCandidate(title))
    }))
    .sort((a, b) => b.score - a.score || a.heading.line - b.heading.line)
    .slice(0, 5);
  const close = ranked.filter((candidate) => candidate.score >= 0.18).map((candidate) => candidate.heading);
  return close.length ? close : ranked.map((candidate) => candidate.heading);
}

function nearestHeadingBefore(text: string, offset: number): MarkdownHeading | undefined {
  return markdownHeadings(text)
    .filter((heading) => heading.offset <= offset)
    .sort((a, b) => b.offset - a.offset)[0];
}

function changeSummary(before: string, after: string) {
  const beforeBytes = Buffer.byteLength(before);
  const afterBytes = Buffer.byteLength(after);
  const beforeLines = lineCount(before);
  const afterLines = lineCount(after);
  return `bytes ${beforeBytes}->${afterBytes} (${signed(afterBytes - beforeBytes)}), lines ${beforeLines}->${afterLines} (${signed(afterLines - beforeLines)})`;
}

function formatWriteResult(
  operation: string,
  virtualPath: string,
  before: string,
  after: string,
  heading?: MarkdownHeading,
  bytesWritten?: number
) {
  return [
    `${operation} ${virtualPath}`,
    changeSummary(before, after),
    heading ? `heading: L${heading.line} ${heading.raw}` : undefined,
    bytesWritten !== undefined ? `bytes_written: ${bytesWritten}` : undefined,
    formatSimpleDiff(virtualPath, "after", before, after)
  ]
    .filter(Boolean)
    .join("\n");
}

function lineCount(text: string) {
  if (text === "") return 0;
  return text.split(/\r?\n/).length;
}

function signed(value: number) {
  return value >= 0 ? `+${value}` : String(value);
}

function lintStaleAppendText(text: string) {
  const headings = markdownHeadings(text);
  const issues: string[] = [];
  const repeatedHeadingKeywords = ["当前状态", "最新", "稳定基线", "下一步", "Next Steps", "Current Status", "Stable Baseline"];
  const matchingHeadings = headings.filter((heading) => repeatedHeadingKeywords.some((keyword) => heading.title.includes(keyword)));
  const grouped = new Map<string, MarkdownHeading[]>();
  for (const heading of matchingHeadings) {
    const key = repeatedHeadingKeywords.find((keyword) => heading.title.includes(keyword)) ?? heading.title;
    grouped.set(key, [...(grouped.get(key) ?? []), heading]);
  }
  for (const [key, group] of grouped.entries()) {
    if (group.length > 1) {
      issues.push(`possible repeated current-state heading "${key}": ${group.map((heading) => `L${heading.line} ${heading.raw}`).join("; ")}`);
    }
  }

  const lines = text.split(/\r?\n/);
  const completionWords = /\b(done|settled|deployed|completed|closed|retired|已完成|已部署|已关闭|已删除)\b/i;
  for (const heading of headings) {
    if (!/(下一步|待办|Next Steps|TODO|Todo)/i.test(heading.title)) continue;
    const endLine = markdownSectionEndLine(headings, heading, lines.length);
    const body = lines.slice(heading.line - 1, endLine).join("\n");
    if (completionWords.test(body)) {
      issues.push(`possible completed work still in next-step section: L${heading.line} ${heading.raw}`);
    }
  }

  const dateHeadingCount = headings.filter((heading) => /\b20\d{2}-\d{2}-\d{2}\b/.test(heading.title)).length;
  if (dateHeadingCount >= 3) {
    issues.push(`document has ${dateHeadingCount} date-like headings; consider folding durable conclusions into current-state sections`);
  }

  const contradictionWords = ["pending", "settled", "deployed", "retired"];
  const present = contradictionWords.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
  if (present.includes("pending") && (present.includes("settled") || present.includes("deployed") || present.includes("retired"))) {
    issues.push(`mixed status language found (${present.join(", ")}); check for stale appended conclusions`);
  }

  if (!issues.length) return "no stale append issues found";
  return issues.join("\n");
}

function lintIssue(severity: "error" | "warn" | "info", category: string, message: string) {
  return `[${severity}] ${category}: ${message}`;
}

function parseWorkspaceHealthLimit(args: string[]) {
  const limitFlag = args.indexOf("--limit");
  const raw = limitFlag >= 0 ? args[limitFlag + 1] : undefined;
  if (raw === undefined) return WORKSPACE_HEALTH_DEFAULT_MARKDOWN_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > WORKSPACE_HEALTH_MAX_MARKDOWN_LIMIT) {
    throw new SandboxError(`workspace_health --limit must be between 1 and ${WORKSPACE_HEALTH_MAX_MARKDOWN_LIMIT}`);
  }
  return parsed;
}

function formatWorkspaceHealth(scan: WorkspaceHealthScan, scope: string, markdownLimit: number) {
  const issues = [...scan.issues].sort(compareLintIssues);
  const totals = countLintIssueSeverities(issues);
  const status = totals.error > 0 ? "needs repair" : totals.warn > 0 ? "attention recommended" : "healthy";
  const lines = [
    "# Workspace Entropy Snapshot",
    "",
    `status: ${status}`,
    `scope: ${scope}`,
    `scanned: ${scan.markdownFiles} Markdown files, ${scan.directories} document-like directories`
  ];

  if (scan.skippedMarkdownFiles || scan.skippedDirectories) {
    lines.push(`skipped: ${scan.skippedMarkdownFiles} Markdown files, ${scan.skippedDirectories} directories`);
  }
  if (scan.missingRoots.length) lines.push(`missing roots: ${scan.missingRoots.join(", ")}`);

  lines.push(`totals: error ${totals.error}, warn ${totals.warn}, info ${totals.info}`);
  lines.push("");

  if (!issues.length) {
    lines.push("top entropy signals:");
    lines.push("- no current lint signals found in the initial scan");
  } else {
    const visibleIssues = issues.slice(0, 12);
    lines.push("top entropy signals:");
    lines.push(...visibleIssues.map((issue) => `- ${issue}`));
    if (issues.length > visibleIssues.length) lines.push(`- ... ${issues.length - visibleIssues.length} more signals hidden by the connection snapshot limit`);
  }

  lines.push("");
  lines.push("recommended next commands:");
  lines.push("- read ai-meditations://skills/organize-workspace before broad cleanup");
  lines.push("- inspect_doc docs");
  lines.push("- lint_doc <specific-path> for a full check of one package or file");
  lines.push("- rg <keyword> docs sources self journal when deciding where knowledge belongs");
  lines.push("");
  lines.push(`notes: initial scan is capped at ${markdownLimit} Markdown files and is advisory; it is meant to orient a newly connected agent, not replace targeted lint_doc checks.`);

  return lines.join("\n");
}

function countLintIssueSeverities(issues: string[]) {
  return issues.reduce(
    (totals, issue) => {
      const severity = lintIssueSeverity(issue);
      totals[severity] += 1;
      return totals;
    },
    { error: 0, warn: 0, info: 0 }
  );
}

function compareLintIssues(a: string, b: string) {
  const severityDiff = lintIssueSeverityRank(a) - lintIssueSeverityRank(b);
  if (severityDiff !== 0) return severityDiff;
  return a.localeCompare(b);
}

function lintIssueSeverityRank(issue: string) {
  const severity = lintIssueSeverity(issue);
  if (severity === "error") return 0;
  if (severity === "warn") return 1;
  return 2;
}

function lintIssueSeverity(issue: string): "error" | "warn" | "info" {
  const match = issue.match(/^\[(error|warn|info)\]/);
  if (match?.[1] === "error" || match?.[1] === "warn" || match?.[1] === "info") return match[1];
  return "info";
}

function markdownSectionEndLine(headings: MarkdownHeading[], heading: MarkdownHeading, totalLines: number) {
  const next = headings.find((candidate) => candidate.line > heading.line && candidate.level <= heading.level);
  return next ? next.line - 1 : totalLines;
}

function toVirtualPath(input: string) {
  const normalized = input.replaceAll(path.sep, "/").replace(/^\.\//, "");
  return normalized === "" ? "." : path.posix.normalize(normalized);
}

function workspacePathResolutionCandidates(virtualPath: string, allowMissing: boolean) {
  const canonical = canonicalWorkspacePath(virtualPath);
  if (allowMissing) return [canonical];
  const candidates = [canonical];
  const legacy = legacyWorkspacePath(canonical);
  if (legacy !== canonical) candidates.push(legacy);
  if (virtualPath !== canonical && !candidates.includes(virtualPath)) candidates.push(virtualPath);
  return candidates;
}

function canonicalWorkspacePath(virtualPath: string) {
  const root = virtualPath.split("/")[0] ?? "";
  const canonicalRoot = LEGACY_ROOT_ALIASES.get(root);
  if (!canonicalRoot) return virtualPath;
  return replaceRootSegment(virtualPath, canonicalRoot);
}

function isProtectedSystemPath(virtualPath: string) {
  for (const protectedPath of PROTECTED_SYSTEM_PATHS) {
    if (virtualPath === protectedPath || virtualPath.startsWith(`${protectedPath}/`)) return true;
  }
  return false;
}

function isDocumentLikeDirectory(virtualPath: string) {
  if (virtualPath === "." || virtualPath === "archive") return false;
  if (isNonDocumentContainerPath(virtualPath)) return false;
  const root = virtualPath.split("/")[0] ?? "";
  return ["docs", "sources", "journal", "self"].includes(root);
}

function looksLikeJournalResidue(text: string) {
  return (
    /^type:\s*(session|change|decision|question|note)\s*$/m.test(text) ||
    /^status:\s*(pending|settled)\s*$/m.test(text) ||
    /^##\s+\d{1,2}:\d{2}\s+/m.test(text)
  );
}

function looksLikeCompiledWiki(text: string) {
  return /##\s+(Current Understanding|当前理解|Decisions|决策|Next Steps|下一步|Open Questions|开放问题)/i.test(text);
}

function looksUnstableForSelf(text: string) {
  return /(maybe|probably|temporary|today only|可能|也许|临时|今天|待确认|不确定)/i.test(text);
}

function legacyWorkspacePath(virtualPath: string) {
  const root = virtualPath.split("/")[0] ?? "";
  for (const [legacyRoot, canonicalRoot] of LEGACY_ROOT_ALIASES.entries()) {
    if (root === canonicalRoot) return replaceRootSegment(virtualPath, legacyRoot);
  }
  return virtualPath;
}

function replaceRootSegment(virtualPath: string, replacementRoot: string) {
  if (virtualPath === ".") return ".";
  const parts = virtualPath.split("/");
  parts[0] = replacementRoot;
  return toVirtualPath(parts.join("/"));
}

async function hashFileIfExists(abs: string) {
  try {
    const data = await fs.readFile(abs);
    return `sha256:${createHash("sha256").update(data).digest("hex")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
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

async function copyWorkspaceContents(from: string, to: string) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    await fs.cp(path.join(from, entry.name), path.join(to, entry.name), {
      recursive: true,
      force: true,
      errorOnExist: false
    });
  }
}

async function clearDirectoryContents(abs: string) {
  await fs.mkdir(abs, { recursive: true });
  const entries = await fs.readdir(abs);
  await Promise.all(entries.map((entry) => fs.rm(path.join(abs, entry), { recursive: true, force: true })));
}

function isMissingPathError(error: unknown) {
  if (error instanceof SandboxError && /path not found/i.test(error.message)) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function looksLikeUnifiedDiff(body: string) {
  const trimmed = body.trimStart();
  return trimmed.startsWith("diff --git ") || trimmed.startsWith("--- ") || trimmed.startsWith("@@ ");
}

function parseUnifiedDiff(body: string, fallbackFile?: string): UnifiedDiffFilePatch[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  if (fallbackFile && lines.some((line) => line.startsWith("@@ "))) {
    const firstMeaningfulLine = lines.find((line) => line.trim());
    if (firstMeaningfulLine?.startsWith("@@ ")) {
      return [{ oldPath: fallbackFile, newPath: fallbackFile, hunks: parseUnifiedDiffHunks(lines, 0).hunks }];
    }
  }

  const filePatches: UnifiedDiffFilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    const oldHeaderIndex = findNextUnifiedDiffHeader(lines, index);
    if (oldHeaderIndex < 0) break;
    if (!lines[oldHeaderIndex + 1]?.startsWith("+++ ")) {
      throw new SandboxError(`invalid unified diff: expected +++ header after line ${oldHeaderIndex + 1}`);
    }

    const oldPath = parseUnifiedDiffPath(lines[oldHeaderIndex]);
    const newPath = parseUnifiedDiffPath(lines[oldHeaderIndex + 1]);
    const parsed = parseUnifiedDiffHunks(lines, oldHeaderIndex + 2);
    if (!parsed.hunks.length) throw new SandboxError(`invalid unified diff: no hunks for ${newPath ?? oldPath ?? "(unknown file)"}`);
    filePatches.push({ oldPath, newPath, hunks: parsed.hunks });
    index = parsed.nextIndex;
  }

  if (!filePatches.length) {
    throw new SandboxError(
      [
        "invalid unified diff: no file patches found.",
        "Use a git-style diff body with ---/+++ headers, or a hunk-only body when patching one explicit file.",
        "Example: patch <<EOF",
        "--- a/docs/example.md",
        "+++ b/docs/example.md",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "EOF"
      ].join("\n")
    );
  }
  return filePatches;
}

function findNextUnifiedDiffHeader(lines: string[], start: number) {
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) return index;
  }
  return -1;
}

function parseUnifiedDiffPath(header: string) {
  const raw = header.slice(4).split("\t")[0]?.trim();
  if (!raw || raw === "/dev/null") return undefined;
  const unquoted = raw.replace(/^"|"$/g, "");
  return stripUnifiedDiffPathPrefix(unquoted);
}

function stripUnifiedDiffPathPrefix(input: string) {
  if (input.startsWith("a/") || input.startsWith("b/")) return input.slice(2);
  return input;
}

function parseUnifiedDiffHunks(lines: string[], start: number) {
  const hunks: UnifiedDiffHunk[] = [];
  let index = start;
  while (index < lines.length) {
    if (lines[index].startsWith("diff --git ") || (lines[index].startsWith("--- ") && lines[index + 1]?.startsWith("+++ "))) break;
    if (!lines[index].startsWith("@@ ")) {
      index += 1;
      continue;
    }

    const header = lines[index];
    const match = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!match) throw new SandboxError(`invalid unified diff hunk header: ${header}`);
    const hunk: UnifiedDiffHunk = {
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? "1"),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? "1"),
      lines: []
    };

    index += 1;
    while (index < lines.length) {
      const line = lines[index];
      if (line.startsWith("@@ ") || line.startsWith("diff --git ") || (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ "))) break;
      if (line.startsWith("\\ No newline at end of file")) {
        index += 1;
        continue;
      }
      const marker = line[0];
      if (marker !== " " && marker !== "+" && marker !== "-") {
        throw new SandboxError(`invalid unified diff line: ${line}`);
      }
      hunk.lines.push({
        kind: marker === " " ? "context" : marker === "+" ? "add" : "remove",
        text: line.slice(1)
      });
      index += 1;
    }
    validateUnifiedDiffHunk(hunk, header);
    hunks.push(hunk);
  }
  return { hunks, nextIndex: index };
}

function validateUnifiedDiffHunk(hunk: UnifiedDiffHunk, header: string) {
  const oldLineCount = hunk.lines.filter((line) => line.kind !== "add").length;
  const newLineCount = hunk.lines.filter((line) => line.kind !== "remove").length;
  if (oldLineCount !== hunk.oldCount || newLineCount !== hunk.newCount) {
    throw new SandboxError(
      `invalid unified diff hunk counts in ${header}: expected -${hunk.oldCount} +${hunk.newCount}, got -${oldLineCount} +${newLineCount}`
    );
  }
}

function applyUnifiedDiffToText(before: string, filePatch: UnifiedDiffFilePatch, virtualPath: string) {
  const hadFinalNewline = before.endsWith("\n");
  const lines = before === "" ? [] : (hadFinalNewline ? before.slice(0, -1) : before).split("\n");
  let offset = 0;
  let finalNewline = hadFinalNewline;

  for (const hunk of filePatch.hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.kind !== "remove").map((line) => line.text);
    const expectedIndex = Math.max(0, (hunk.oldStart === 0 ? 0 : hunk.oldStart - 1) + offset);
    const matchIndex = findUnifiedDiffHunkMatch(lines, oldLines, expectedIndex);
    if (matchIndex < 0) {
      throw new SandboxError(unifiedDiffHunkNotFoundMessage(virtualPath, hunk, lines, expectedIndex));
    }
    lines.splice(matchIndex, oldLines.length, ...newLines);
    offset += newLines.length - oldLines.length;
    finalNewline = true;
  }

  if (!lines.length) return "";
  return lines.join("\n") + (finalNewline ? "\n" : "");
}

function findUnifiedDiffHunkMatch(lines: string[], oldLines: string[], expectedIndex: number) {
  if (!oldLines.length) return Math.min(expectedIndex, lines.length);
  if (linesMatchAt(lines, oldLines, expectedIndex)) return expectedIndex;

  const start = Math.max(0, expectedIndex - 5);
  const end = Math.min(lines.length - oldLines.length, expectedIndex + 5);
  for (let index = start; index <= end; index += 1) {
    if (index !== expectedIndex && linesMatchAt(lines, oldLines, index)) return index;
  }
  return -1;
}

function linesMatchAt(lines: string[], oldLines: string[], index: number) {
  if (index < 0 || index + oldLines.length > lines.length) return false;
  for (let offset = 0; offset < oldLines.length; offset += 1) {
    if (lines[index + offset] !== oldLines[offset]) return false;
  }
  return true;
}

function unifiedDiffHunkNotFoundMessage(virtualPath: string, hunk: UnifiedDiffHunk, lines: string[], expectedIndex: number) {
  const firstLine = hunk.lines.find((line) => line.kind !== "add")?.text ?? "";
  const candidates = firstLine
    ? lines
        .map((line, index) => ({ line, index, score: patchCandidateScore(normalizePatchCandidate(line), normalizePatchCandidate(firstLine)) }))
        .filter((candidate) => candidate.score >= 0.18)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, 3)
    : [];
  return [
    `unified diff hunk did not match ${virtualPath} near line ${expectedIndex + 1}.`,
    "The diff context must match the file exactly. Run nl or rg, then regenerate the diff against current content.",
    ...(candidates.length ? ["Closest candidate lines:", ...candidates.map((candidate) => `${candidate.index + 1}: ${truncateLineForError(candidate.line)}`)] : [])
  ].join("\n");
}

async function uniqueArchiveTarget(abs: string) {
  if (!(await pathExists(abs))) return abs;

  const dir = path.dirname(abs);
  const ext = path.extname(abs);
  const base = path.basename(abs, ext);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = randomUUID().slice(0, 8);
    const candidate = path.join(dir, `${base}-${suffix}${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }

  throw new SandboxError("could not allocate unique archive target");
}

function countOccurrences(text: string, needle: string) {
  if (needle === "") throw new SandboxError("old_text cannot be empty");
  let count = 0;
  let position = 0;
  while (true) {
    const index = text.indexOf(needle, position);
    if (index === -1) return count;
    count += 1;
    position = index + needle.length;
  }
}

function patchNotFoundMessage(filePath: string, text: string, oldText: string) {
  const lines = nearestPatchCandidateLines(text, oldText);
  const parts = [
    "patch conflict: old_text not found.",
    "old_text must match the file exactly, including punctuation, smart quotes, whitespace, and newlines."
  ];

  if (lines.length) {
    parts.push("Closest candidate lines:");
    for (const line of lines) {
      parts.push(`${line.number}: ${line.text}`);
    }
  }

  parts.push(`Tip: run rg "<distinct phrase>" ${filePath}, then copy the exact text into old_text.`);
  return parts.join("\n");
}

function patchAmbiguousMessage(text: string, oldText: string, occurrences: number) {
  const locations = exactMatchLineLocations(text, oldText);
  return [
    `old_text matched ${occurrences} locations.`,
    "Make old_text longer by including a few unique lines before or after the target span.",
    ...(locations.length ? ["Matched lines:", ...locations.map((line) => `${line.number}: ${line.text}`)] : [])
  ].join("\n");
}

function exactMatchLineLocations(text: string, oldText: string) {
  const firstLine = oldText.split(/\r?\n/).find((line) => line.trim()) ?? oldText;
  const needle = firstLine.trim();
  if (!needle) return [];
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ number: index + 1, text: truncateLineForError(line) }))
    .filter((line) => line.text.includes(needle))
    .slice(0, 5);
}

function nearestPatchCandidateLines(text: string, oldText: string) {
  const normalizedNeedle = normalizePatchCandidate(oldText);
  if (!normalizedNeedle) return [];

  return text
    .split(/\r?\n/)
    .map((line, index) => ({
      number: index + 1,
      text: truncateLineForError(line),
      score: patchCandidateScore(normalizePatchCandidate(line), normalizedNeedle)
    }))
    .filter((line) => line.text && line.score >= 0.18)
    .sort((a, b) => b.score - a.score || a.number - b.number)
    .slice(0, 3)
    .map(({ number, text }) => ({ number, text }));
}

function normalizePatchCandidate(input: string) {
  return input
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function patchCandidateScore(line: string, needle: string) {
  if (!line || !needle) return 0;
  if (line === needle) return 1;
  if (line.includes(needle)) return 0.95;
  if (needle.includes(line) && line.length >= Math.min(needle.length, 12)) return 0.9;

  const lineBigrams = charBigrams(line);
  const needleBigrams = charBigrams(needle);
  if (!lineBigrams.size || !needleBigrams.size) return 0;

  let shared = 0;
  for (const item of lineBigrams) {
    if (needleBigrams.has(item)) shared += 1;
  }
  return (2 * shared) / (lineBigrams.size + needleBigrams.size);
}

function charBigrams(input: string) {
  const compact = input.slice(0, 400);
  if (compact.length < 2) return new Set(compact ? [compact] : []);
  const grams = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.add(compact.slice(index, index + 2));
  }
  return grams;
}

function truncateLineForError(line: string, maxLength = 160) {
  const compact = line.replace(/\t/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function helpText(document?: string) {
  const normalized = document?.toLowerCase();

  if (normalized === "write") {
    return [
      "write creates or replaces a file with heredoc content.",
      "Multiple commands can be submitted in one run_shell call when each command starts on its own line.",
      "The whole batch is parsed before execution, so malformed trailing heredocs do not partially write earlier files.",
      "If a multi-command batch includes writes and a later command fails during execution, earlier workspace file changes in that batch are rolled back.",
      "Choose a delimiter that does not appear alone in the body. If Markdown content contains literal EOF lines, use a different delimiter such as DOC.",
      "",
      "Example document package README:",
      "write docs/sub_docs/example/README.md <<EOF",
      "---",
      "title: Example",
      "summary: What this document is for.",
      "tags: [document]",
      "status: active",
      "---",
      "",
      "# Example",
      "",
      "Current understanding goes here.",
      "EOF",
      "",
      "Prefer patch or append when updating an existing file.",
      "Use README frontmatter title/summary/tags/status when you want the Reader child-document card to be clearer."
    ].join("\n");
  }

  if (normalized === "append") {
    return [
      "append adds heredoc content to the end of a file.",
      "Choose a delimiter that does not appear alone in the body. If Markdown content contains literal EOF lines, use a different delimiter such as DOC.",
      "",
      "Example:",
      "append journal/2026/04/2026-04-28.md <<EOF",
      "",
      "## 14:30 Short title",
      "type: session | change | decision | question | note",
      "status: settled",
      "tags: [example]",
      "links:",
      "- docs/sub_docs/example/README.md",
      "",
      "- What happened",
      "- What changed",
      "- What remains open",
      "",
      "EOF",
      "",
      "Use append for journal events and short additions. Use patch for precise edits in durable document pages."
    ].join("\n");
  }

  if (normalized === "patch") {
    return [
      "patch applies a git-style unified diff, or the legacy JSON exact-text patch format.",
      "Use heredoc syntax: <<EOF or <<'EOF' are both accepted.",
      "Choose a delimiter that does not appear alone in the patch body. If needed, use a different delimiter such as PATCH.",
      "Inline patch content after the command is rejected.",
      "",
      "Preferred git/unified diff example:",
      "patch <<'EOF'",
      "--- a/docs/sub_docs/example/README.md",
      "+++ b/docs/sub_docs/example/README.md",
      "@@ -1,3 +1,3 @@",
      " # Example",
      " ",
      "-old text",
      "+new text",
      "EOF",
      "",
      "Hunk-only example for one explicit file:",
      "patch docs/sub_docs/example/README.md <<'EOF'",
      "@@ -1,3 +1,3 @@",
      " # Example",
      " ",
      "-old text",
      "+new text",
      "EOF",
      "",
      "Legacy JSON example:",
      "patch docs/sub_docs/example/README.md <<'EOF'",
      "{\"old_text\":\"old text\",\"new_text\":\"new text\"}",
      "EOF",
      "",
      "Legacy JSON multiline example:",
      "patch docs/sub_docs/example/README.md <<'EOF'",
      "{\"old_text\":\"# Old\\n\\nParagraph\",\"new_text\":\"# New\\n\\nParagraph with \\\"quotes\\\"\"}",
      "EOF",
      "",
      "Unified diff notes:",
      "- Supports multiple file patches in one command.",
      "- Supports modifying existing files and creating new files.",
      "- Rename diffs are rejected; use mv first, then patch the target file.",
      "- Use --dry-run to check the diff without writing.",
      "- Hunk context must match the current file; on mismatch, patch reports nearby candidate lines.",
      "",
      "Legacy JSON notes:",
      "- Use \\n inside JSON strings for newlines; literal line breaks inside a JSON string are invalid.",
      "- Escape double quotes inside JSON strings as \\\".",
      "- Escape backslashes inside JSON strings as \\\\.",
      "",
      "For JSON mode, old_text must match exactly, including punctuation, smart quotes, whitespace, and newlines.",
      "If old_text appears multiple times, make it longer by including nearby unique text."
    ].join("\n");
  }

  if (normalized === "rg" || normalized === "search") {
    return [
      "rg searches workspace text with case-insensitive matching.",
      "Usage: rg [-n] [-C <lines>] <pattern> [path...]",
      "Canonical: rg <pattern> <path> [path...]",
      "",
      "Examples:",
      "rg keyword docs",
      "rg \"two words\" docs",
      "rg -n \"summary|摘要|tool result\" docs/file.md docs/other.md",
      "rg -C 2 keyword docs",
      "rg --context 2 keyword docs",
      "rg 下一步 docs/novaic/README.md",
      "",
      "Notes:",
      "- Patterns use JavaScript RegExp when valid; invalid regex falls back to literal text matching.",
      "- -n / --line-number is accepted for shell compatibility. Line numbers are always shown.",
      "- Glob flags and shell pipes are not supported.",
      "- If you write rg <path> <pattern>, the sandbox will warn that the arguments look reversed.",
      "- Context must be between 0 and 10 lines.",
      "- Use docs/ first for compiled wiki answers; search sources/ when provenance matters."
    ].join("\n");
  }

  if (normalized === "head" || normalized === "tail") {
    const command = normalized;
    return [
      `${command} reads a bounded slice of a file.`,
      `Usage: ${command} <file> [count]`,
      "",
      "Examples:",
      `${command} docs/sub_docs/example/README.md`,
      `${command} docs/sub_docs/example/README.md 5`,
      `${command} -n 5 docs/sub_docs/example/README.md`,
      `${command} docs/sub_docs/example/README.md --lines 5`,
      "",
      "Notes:",
      "- Default line count is 20.",
      "- Count must be an integer between 1 and 1000.",
      "- Unsupported extra arguments are rejected instead of ignored."
    ].join("\n");
  }

  if (normalized === "cat" || normalized === "nl") {
    return [
      "cat reads a file. nl reads a file with line numbers.",
      "",
      "Examples:",
      "cat docs/sub_docs/example/README.md",
      "cat -n docs/sub_docs/example/README.md",
      "nl docs/sub_docs/example/README.md",
      "",
      "Use numbered output when preparing an exact patch or pointing the user to a specific line."
    ].join("\n");
  }

  if (normalized === "diff") {
    return [
      "diff compares two files, compares a file with proposed full-file heredoc content, or shows recorded changes for a file.",
      "",
      "Examples:",
      "diff docs/page.md",
      "diff docs/page.md docs/page-copy.md",
      "diff docs/page.md <<EOF",
      "# Proposed full file content",
      "EOF",
      "",
      "changes shows files modified in this sandbox instance.",
      "changes --stat shows only file-level byte and line deltas.",
      "",
      "This is a small review aid, not full Unix diff. It shows the changed span after trimming shared prefix and suffix.",
      "Use it to check a proposed replacement before write, or to compare two workspace files."
    ].join("\n");
  }

  if (normalized === "replace_section" || normalized === "section" || normalized === "toc") {
    return [
      "Markdown structure commands help agents update existing sections instead of appending stale conclusions.",
      "",
      "Read commands:",
      "toc docs/page.md",
      "section docs/page.md \"## Heading\"",
      "section docs/page.md \"## Heading\" --context 2",
      "",
      "Write command:",
      "replace_section docs/page.md \"## Heading\" <<'EOF'",
      "## Heading",
      "",
      "New section body.",
      "EOF",
      "",
      "replace_section replaces from the matched heading to the next same-or-higher-level heading.",
      "The heredoc body must start with the exact matched heading.",
      "Repeated headings return candidates instead of guessing."
    ].join("\n");
  }

  if (normalized === "inspect_doc" || normalized === "inspect") {
    return [
      "inspect_doc explains the folder-as-document model for one path.",
      "",
      "Usage:",
      "inspect_doc docs",
      "inspect_doc docs/sub_docs/example",
      "inspect_doc docs/sub_docs/example/README.md",
      "inspect_doc docs/sub_docs/example/second-page.md",
      "",
      "It returns:",
      "- whether the target is a document package, same-document page, or file",
      "- the README body path",
      "- same-document pages",
      "- child documents",
      "- Reader card title/summary/tags/status when available",
      "- structural warnings, suggestions, and recommended next commands",
      "",
      "Use inspect_doc before creating a new page or child document."
    ].join("\n");
  }

  if (normalized === "workspace_health" || normalized === "health" || normalized === "entropy") {
    return [
      "workspace_health returns a capped, read-only entropy snapshot for the workspace.",
      "It is meant for newly connected agents: orient first, then inspect specific packages before editing.",
      "",
      "Usage:",
      "workspace_health",
      "workspace_health docs",
      "workspace_health docs/sub_docs/<slug> --limit 120",
      "",
      "It scans docs/, sources/, self/, journal/, AGENTS.md, and index.md by default.",
      "It reports severity totals plus the top [error], [warn], and [info] signals from lint_doc-style checks.",
      "",
      "Use it at connection time, after large migrations, and before cleanup.",
      "Use lint_doc <path> for a full targeted check when the snapshot points at a specific document."
    ].join("\n");
  }

  if (normalized === "patch_many") {
    return [
      "patch_many applies multiple exact replacements to one file atomically.",
      "",
      "Example:",
      "patch_many docs/page.md --dry-run <<'EOF'",
      "[",
      "  {\"old_text\":\"old A\", \"new_text\":\"new A\"},",
      "  {\"old_text\":\"old B\", \"new_text\":\"new B\"}",
      "]",
      "EOF",
      "",
      "All old_text spans must match exactly once. If any item fails, no changes are written.",
      "Use --dry-run to check matches before applying."
    ].join("\n");
  }

  if (normalized === "changes") {
    return [
      "changes shows files modified in this sandbox instance.",
      "",
      "Examples:",
      "changes",
      "changes --stat",
      "diff docs/page.md",
      "",
      "Use changes after write, append, patch, patch_many, or replace_section to verify what changed.",
      "changes is not a version-control system. Multi-command write batches roll back on execution failure, but committed successful edits should be reviewed with diff/changes and restored from backup if a broad mistake was already accepted."
    ].join("\n");
  }

  if (normalized === "lint_stale_append" || normalized === "lint_doc") {
    return [
      "lint_doc checks one Markdown file or document package for common LLM Wiki entropy.",
      "lint_stale_append is the older narrow check for stale appended conclusions.",
      "",
      "Examples:",
      "lint_stale_append docs/page.md",
      "lint_doc docs/page.md",
      "lint_doc docs/sub_docs/example",
      "lint_doc docs/page.md --stale-next-steps",
      "",
      "lint_doc reports:",
      "- repeated or stale current-state / next-step sections",
      "- heading-level jumps and multiple H1 headings",
      "- page-heavy document packages that may need child documents",
      "- missing README.md in document packages",
      "- missing child-document card summary/tags",
      "- invalid README frontmatter status",
      "- wrong-layer writes between docs/, sources/, journal/, and self/",
      "- docs files that look like journal/session residue",
      "- sources files that look like compiled wiki synthesis",
      "- self files with uncertain or temporary language",
      "- broken relative Markdown links",
      "",
      "Each issue is prefixed as [error], [warn], or [info] plus a category.",
      "The lint is advisory. Use inspect_doc, toc, section, and patch/replace_section to repair issues."
    ].join("\n");
  }

  if (normalized === "document-package" || normalized === "documents" || normalized === "docs") {
    return [
      "AI Meditations stores compiled wiki knowledge as Markdown document packages.",
      "",
      "Anti-entropy writing rules:",
      "- Preserve raw source material in sources/ with provenance.",
      "- Default fresh/uncertain context to journal/YYYY/MM/YYYY-MM-DD.md.",
      "- Compile to docs/ only when knowledge is stable, reusable, and has a clear durable home.",
      "- Use self/ only for stable user preferences, principles, durable context, or explicit memory requests.",
      "- self/ is user-visible Agent context, not hidden agent memory or an ordinary document; do not move or archive it.",
      "- Prefer patch for durable edits, append for journal events, and write only for new files or intentional replacement.",
      "- Read nearby README.md files and sibling pages before creating new files.",
      "- Do not paste raw chat transcripts; distill decisions, state, open questions, and reusable context.",
      "",
      "Reader rendering contract:",
      "- Directory = document package.",
      "- README.md = document body.",
      "- Sibling .md files = pages in the same document; Reader expands them after README.md.",
      "- docs/sub_docs/<slug>/ directories are top-level documents under the compiled-wiki root document.",
      "- sub_docs/<slug>/ directories = child documents; Reader shows them in navigation and as cards below the current document.",
      "- _attachments/ = files that belong to the current document; it is not a child document.",
      "- Document: docs/sub_docs/<slug>/README.md.",
      "- Child document: <parent>/sub_docs/<slug>/README.md.",
      "- Same-document page: <parent>/<page>.md.",
      "",
      "Tree contract:",
      "- The physical directory tree is the source of truth for parent/child relationships.",
      "- Do not create hidden JSON indexes, node manifests, or ID-only folders unless the user explicitly asks.",
      "- Keep slugs stable and readable. Prefer lowercase-kebab-case for directory and page names.",
      "",
      "Recommended README frontmatter for durable docs:",
      "---",
      "title: Example Document",
      "summary: One sentence explaining what this document is for.",
      "tags: [example, guide]",
      "status: active",
      "---",
      "",
      "status values: active, draft, reference, archived.",
      "",
      "Child-document cards:",
      "- Title: README frontmatter title, then README # heading, then directory name.",
      "- Summary: README frontmatter summary, then first prose paragraph.",
      "- Tags: README frontmatter tags, then path-derived tags.",
      "- Status is advisory metadata for agents and future UI; it does not change file permissions.",
      "",
      "Journal:",
      "- Journal note: journal/YYYY/MM/YYYY-MM-DD.md.",
      "- Journal entries should use ## HH:mm title plus type/status/tags/links metadata.",
      "",
      "Recommended first steps:",
      "Read MCP resource ai-meditations://llms.txt when available.",
      "cat AGENTS.md",
      "inspect_doc docs",
      "tree docs --depth 2",
      "tree sources --depth 2",
      "tree journal --depth 3",
      "cat docs/README.md",
      "cat sources/README.md",
      "cat self/README.md",
      "",
      "MCP resources:",
      "ai-meditations://skills/wiki-maintenance",
      "ai-meditations://skills/organize-workspace"
    ].join("\n");
  }

  if (normalized === "wiki" || normalized === "llm-wiki" || normalized === "ingest") {
    return [
      "AI Meditations follows a Karpathy-style LLM Wiki pattern.",
      "",
      "Layers:",
      "- sources/: raw source material with provenance; preserve existing sources.",
      "- docs/: compiled wiki; stable synthesis, concepts, entities, decisions, and cross-links.",
      "- AGENTS.md: schema / operating contract.",
      "- journal/: chronological operation log for ingests, queries, lint passes, and unsettled context.",
      "",
      "Ingest:",
      "1. Read AGENTS.md, docs/README.md, sources/README.md, and relevant nearby wiki pages.",
      "2. Create or preserve a source note under sources/YYYY/MM/YYYY-MM-DD-<slug>.md when needed.",
      "3. Patch relevant docs/ pages with durable synthesis and links back to sources/ when provenance matters.",
      "4. Update docs/README.md if discoverability changes.",
      "5. Append a journal event listing the source and changed files.",
      "",
      "Query:",
      "- Search/read docs/ first.",
      "- Consult sources/ only for citations, provenance, or unresolved details.",
      "- File durable synthesis back into docs/ when useful.",
      "",
      "Lint:",
      "- Check contradictions, stale claims, orphan pages, missing source links, and important concepts without pages.",
      "- Record lint findings in journal before broad reorganization.",
      "- Use inspect_doc to understand document package boundaries before moving or creating files.",
      "- Use lint_doc <path> after edits to catch wrong-layer writes, broken links, and Reader-card issues.",
      "",
      "Useful commands:",
      "inspect_doc docs/sub_docs/<slug>",
      "toc docs/sub_docs/<slug>/README.md",
      "section docs/sub_docs/<slug>/README.md \"## Heading\"",
      "lint_doc docs/sub_docs/<slug>",
      "",
      "MCP resource:",
      "ai-meditations://skills/wiki-maintenance"
    ].join("\n");
  }

  return [
    "AI Meditations sandbox help",
    "",
    "This is a limited file command interpreter, not bash.",
    "For the LLM-facing workspace map, read MCP resource ai-meditations://llms.txt or call get_workspace_info.",
    "For Karpathy-style ingest/query/lint workflow, read MCP resource ai-meditations://skills/wiki-maintenance or run help wiki.",
    "For canonical rules, read AGENTS.md.",
    "",
    `Read commands: ${READ_COMMAND_LIST}.`,
    `Write commands: ${WRITE_COMMAND_LIST}.`,
    "",
    "Common first steps:",
    "cat AGENTS.md",
    "cat docs/README.md",
    "cat sources/README.md",
    "cat self/README.md",
    "cat journal/README.md",
    "workspace_health",
    "tree docs --depth 2",
    "tree sources --depth 2",
    "tree journal --depth 3",
    "inspect_doc docs",
    "rg <keyword> docs sources",
    "",
    "MCP resources:",
    "- ai-meditations://llms.txt",
    "- ai-meditations://workspace/info",
    "- ai-meditations://skills/wiki-maintenance",
    "- ai-meditations://skills/organize-workspace",
    "",
    "Document conventions:",
    "- Directory = document package; README.md = body.",
    "- docs/sub_docs/<slug>/ directories are top-level documents under the compiled-wiki root document.",
    "- Sibling .md files = pages; sub_docs/<slug>/ directories = child documents.",
    "- _attachments/ stores files for the current document; it is not a child document.",
    "- The physical directory tree is the source of truth; do not create hidden JSON indexes unless the user asks.",
    "- Reader renders sub_docs/<slug>/ directories as preview cards using README title/summary/tags/status.",
    "- sources/ holds raw source material; docs/ holds compiled wiki pages.",
    "- Journal note: journal/YYYY/MM/YYYY-MM-DD.md",
    "- Default fresh context to journal; compile only stable reusable knowledge to docs.",
    "- self/ is user-visible Agent context; update it sparingly and never move/archive it.",
    "",
    "More help:",
    "help document-package",
    "help wiki",
    "help write",
    "help append",
      "help patch",
      "help rg",
      "help diff",
      "help inspect_doc",
      "help replace_section",
      "help patch_many",
      "help changes",
    "help lint_stale_append"
  ].join("\n");
}
