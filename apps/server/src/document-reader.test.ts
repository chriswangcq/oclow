import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceSandbox } from "@ai-meditations/sandbox";
import { buildDocumentPackage } from "./document-reader.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-meditations-document-reader-"));

try {
  await fs.mkdir(path.join(root, "docs", "sub_docs", "alpha"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "README.md"), "# Docs\n\nRoot body.\n");
  await fs.writeFile(path.join(root, "docs", "sub_docs", "alpha", "README.md"), "# Alpha\n\nAlpha body.\n");
  await fs.writeFile(path.join(root, "docs", "sub_docs", "alpha", "old-page.md"), "# Old Page\n");

  const sandbox = await WorkspaceSandbox.open(root);
  const documentPackage = await buildDocumentPackage(sandbox, "docs/sub_docs/alpha", async (filePath, content) => {
    return `<p data-path="${filePath}">${content}</p>`;
  });

  assert.equal(documentPackage.body?.sourcePath, "docs/sub_docs/alpha/README.md");
  assert.equal(documentPackage.body?.displayPath, "docs/alpha");
  assert.equal(Object.hasOwn(documentPackage, "pages"), false);
  assert.equal(documentPackage.childDocuments.length, 0);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
