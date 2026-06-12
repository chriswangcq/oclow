import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDefaultWorkspace } from "./workspace-template.js";

async function exists(abs: string) {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-meditations-workspace-template-"));

try {
  await fs.mkdir(path.join(root, "docs", "legacy-root", "child"), { recursive: true });
  await fs.mkdir(path.join(root, "docs", "legacy-root", "sub_docs", "notes"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "README.md"), "# Docs\n");
  await fs.writeFile(path.join(root, "docs", "legacy-root", "README.md"), "# Legacy Root\n");
  await fs.writeFile(path.join(root, "docs", "legacy-root", "child", "README.md"), "# Child\n");
  await fs.writeFile(path.join(root, "docs", "legacy-root", "brief.md"), "# Brief\n");
  await fs.writeFile(path.join(root, "docs", "legacy-root", "notes.md"), "# Notes Page\n");
  await fs.writeFile(path.join(root, "docs", "legacy-root", "sub_docs", "notes", "README.md"), "# Existing Notes\n");

  await ensureDefaultWorkspace(root);

  assert.equal(await exists(path.join(root, "docs", "legacy-root")), false);
  assert.equal(await exists(path.join(root, "docs", "sub_docs", "legacy-root", "README.md")), true);
  assert.equal(await exists(path.join(root, "docs", "sub_docs", "legacy-root", "sub_docs", "child", "README.md")), true);
  assert.equal(await exists(path.join(root, "docs", "sub_docs", "legacy-root", "brief.md")), false);
  assert.equal(await exists(path.join(root, "docs", "sub_docs", "legacy-root", "sub_docs", "brief", "README.md")), true);
  assert.equal(await exists(path.join(root, "docs", "sub_docs", "legacy-root", "notes.md")), false);
  assert.equal(await exists(path.join(root, "docs", "sub_docs", "legacy-root", "sub_docs", "notes", "README.md")), true);
  assert.equal(await exists(path.join(root, "docs", "sub_docs", "legacy-root", "sub_docs", "notes-page", "README.md")), true);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-meditations-workspace-template-fresh-"));

try {
  await ensureDefaultWorkspace(freshRoot);

  assert.equal(await exists(path.join(freshRoot, "docs", "ai-meditations-guide")), false);
  assert.equal(await exists(path.join(freshRoot, "docs", "sub_docs", "ai-meditations-guide", "README.md")), true);
  assert.equal(await exists(path.join(freshRoot, "docs", "sub_docs", "ai-meditations-guide", "connect-agent.md")), false);
  assert.equal(await exists(path.join(freshRoot, "docs", "sub_docs", "ai-meditations-guide", "sub_docs", "connect-agent", "README.md")), true);
} finally {
  await fs.rm(freshRoot, { recursive: true, force: true });
}
