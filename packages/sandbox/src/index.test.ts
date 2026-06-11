import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceSandbox } from "./index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-meditations-sandbox-"));
const audit: unknown[] = [];
const sandbox = await WorkspaceSandbox.open(root, {
  onAudit: (event) => {
    audit.push(event);
  }
});

let result = await sandbox.run("mkdir docs", { scope: "write" });
assert.equal(result.ok, true);
result = await sandbox.run("mkdir archive", { scope: "write" });
assert.equal(result.ok, true);
result = await sandbox.run("mkdir sources", { scope: "write" });
assert.equal(result.ok, true);
result = await sandbox.run("mkdir self", { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("write docs/hello.md <<EOF\n# Hello\n\nWorld\nEOF", { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("cat docs/hello.md");
assert.equal(result.stdout, "# Hello\n\nWorld");

result = await sandbox.run("cat topics/hello.md");
assert.equal(result.stdout, "# Hello\n\nWorld");

result = await sandbox.run("write topics/legacy.md <<EOF\nLegacy alias\nEOF", { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("cat docs/legacy.md");
assert.equal(result.stdout, "Legacy alias");

result = await sandbox.run("write docs/inline.md # Inline content is rejected", { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /write requires heredoc content/);

result = await sandbox.run("cat docs/inline.md");
assert.equal(result.ok, false);

result = await sandbox.run("append docs/hello.md inline", { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /append requires heredoc content/);

result = await sandbox.run("patch docs/hello.md inline", { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /patch requires heredoc content/);
assert.match(result.stderr ?? "", /<<'EOF'/);
assert.equal(result.errorType, "parse_error");

result = await sandbox.run(`write docs/multi.md <<'EOF'
hello
EOF

write docs/multi2.md <<'EOF'
planet
EOF`, { scope: "write" });
assert.equal(result.ok, true);
assert.match(result.stdout, /\$ write docs\/multi\.md/);
assert.match(result.stdout, /\$ write docs\/multi2\.md/);

result = await sandbox.run("cat docs/multi.md");
assert.equal(result.stdout, "hello");

result = await sandbox.run("cat docs/multi2.md");
assert.equal(result.stdout, "planet");

result = await sandbox.run(`write docs/bad-multi.md <<'EOF'
hello
EOF

write docs/bad-multi2.md <<'EOF'
world`, { scope: "write" });
assert.equal(result.ok, false);
assert.equal(result.errorType, "parse_error");
assert.match(result.stderr ?? "", /missing heredoc terminator/);

result = await sandbox.run("cat docs/bad-multi.md");
assert.equal(result.ok, false);

result = await sandbox.run("write docs/rollback.md <<EOF\nbefore\nEOF", { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run(`write docs/rollback.md <<EOF
after
EOF

cat missing/rollback.md`, { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /Workspace changes from this batch were rolled back/);

result = await sandbox.run("cat docs/rollback.md");
assert.equal(result.stdout, "before");

result = await sandbox.run(`append docs/delimiter-collision.md <<EOF
\`\`\`text
write docs/example.md <<EOF
content
EOF
\`\`\`
EOF`, { scope: "write" });
assert.equal(result.ok, false);
assert.equal(result.errorType, "parse_error");
assert.match(result.stderr ?? "", /use a delimiter that does not appear alone in the body/);
assert.match(result.stderr ?? "", /DOC/);

result = await sandbox.run("cat docs/delimiter-collision.md");
assert.equal(result.ok, false);

result = await sandbox.run("head -n 1 docs/hello.md");
assert.equal(result.stdout, "# Hello");

result = await sandbox.run("write docs/lines.md <<EOF\none\ntwo\nthree\nfour\nfive\nEOF", { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("head docs/lines.md 3");
assert.equal(result.stdout, "one\ntwo\nthree");

result = await sandbox.run("tail docs/lines.md --lines 2");
assert.equal(result.stdout, "four\nfive");

result = await sandbox.run("head docs/lines.md 3 extra");
assert.equal(result.ok, false);
assert.equal(result.errorType, "parse_error");
assert.match(result.stderr ?? "", /use head <file>/);

result = await sandbox.run("tail -n 1 docs/hello.md");
assert.equal(result.stdout, "World");

result = await sandbox.run("tail docs/hello.md -n 1");
assert.equal(result.stdout, "World");

result = await sandbox.run("rg World docs");
assert.equal(result.stdout.trim(), "docs/hello.md:3: World");

result = await sandbox.run("write docs/search.md <<EOF\nfoo bar baz\nsummary line\nEOF", { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run('rg -n "foo|bar baz" docs/search.md docs/hello.md');
assert.equal(result.ok, true);
assert.match(result.stdout, /docs\/search\.md:1: foo bar baz/);

result = await sandbox.run("cat -n docs/hello.md");
assert.equal(result.stdout, "1\t# Hello\n2\t\n3\tWorld");

result = await sandbox.run("nl docs/hello.md");
assert.equal(result.stdout, "1\t# Hello\n2\t\n3\tWorld");

result = await sandbox.run("rg -C 1 World docs");
assert.match(result.stdout, /docs\/hello\.md-2- ?\n?docs\/hello\.md:3: World/);

result = await sandbox.run("rg World docs sources");
assert.equal(result.stdout.trim(), "docs/hello.md:3: World");

result = await sandbox.run("rg docs/hello.md World");
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /arguments look reversed/);
assert.match(result.stderr ?? "", /rg <pattern> <path>/);

result = await sandbox.run('rg "pattern" missing/path.md');
assert.equal(result.ok, false);
assert.equal(result.errorType, "path_error");
assert.match(result.stderr ?? "", /path error: path not found: missing\/path\.md/);

result = await sandbox.run("diff docs/hello.md <<EOF\n# Hello\n\nSandbox\nEOF");
assert.match(result.stdout, /--- docs\/hello\.md/);
assert.match(result.stdout, /\+\+\+ proposed/);
assert.match(result.stdout, /- World/);
assert.match(result.stdout, /\+ Sandbox/);

result = await sandbox.run("diff docs/hello.md <<EOF\n# Hello\n\nWorld\nEOF");
assert.equal(result.stdout, "no changes");

result = await sandbox.run("help");
assert.equal(result.ok, true);
assert.match(result.stdout, /AI Meditations sandbox help/);
assert.match(result.stdout, /help document-package/);
assert.match(result.stdout, /preview cards/);

result = await sandbox.run("help document-package");
assert.equal(result.ok, true);
assert.match(result.stdout, /Anti-entropy writing rules/);
assert.match(result.stdout, /Reader rendering contract/);
assert.match(result.stdout, /frontmatter title/);
assert.match(result.stdout, /user-visible Agent context/);
assert.match(result.stdout, /Journal entries/);

result = await sandbox.run("help append");
assert.equal(result.ok, true);
assert.match(result.stdout, /type: session/);
assert.match(result.stdout, /status: settled/);

result = await sandbox.run("help patch");
assert.equal(result.ok, true);
assert.match(result.stdout, /old_text/);
assert.match(result.stdout, /git\/unified diff/);
assert.match(result.stdout, /Legacy JSON multiline example/);
assert.match(result.stdout, /nearby candidate lines/i);

result = await sandbox.run("help rg");
assert.equal(result.ok, true);
assert.match(result.stdout, /--context/);
assert.match(result.stdout, /rg <pattern> <path>/);
assert.match(result.stdout, /-n/);

result = await sandbox.run("help head");
assert.equal(result.ok, true);
assert.match(result.stdout, /head <file>/);

result = await sandbox.run("help diff");
assert.equal(result.ok, true);
assert.match(result.stdout, /proposed full-file heredoc content/);

result = await sandbox.run('patch docs/hello.md <<EOF\n{"old_text":"World","new_text":"Sandbox"}\nEOF', { scope: "write" });
assert.equal(result.ok, true);
assert.match(result.stdout, /patch docs\/hello\.md/);
assert.match(result.stdout, /bytes/);
assert.match(result.stdout, /lines/);

result = await sandbox.run("cat docs/hello.md");
assert.equal(result.stdout, "# Hello\n\nSandbox");

result = await sandbox.run("diff docs/hello.md");
assert.equal(result.ok, true);
assert.match(result.stdout, /\+\+\+ current/);
assert.match(result.stdout, /Sandbox/);

result = await sandbox.run("changes --stat");
assert.equal(result.ok, true);
assert.match(result.stdout, /docs\/hello\.md/);
assert.match(result.stdout, /bytes/);

result = await sandbox.run(`write docs/sections.md <<'EOF'
# Guide

Intro.

## Status

Old status.

## Tools

- old tool

\`\`\`
## Not A Heading
\`\`\`

## Next Steps

- deployed thing
EOF`, { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("toc docs/sections.md");
assert.equal(result.ok, true);
assert.match(result.stdout, /L1: # Guide/);
assert.match(result.stdout, /L5: ## Status/);
assert.doesNotMatch(result.stdout, /Not A Heading/);

result = await sandbox.run('section docs/sections.md "## Tools"');
assert.equal(result.ok, true);
assert.match(result.stdout, /- old tool/);
assert.doesNotMatch(result.stdout, /## Next Steps/);

result = await sandbox.run(`replace_section docs/sections.md "## Tools" <<'EOF'
## Tools

- new tool
EOF`, { scope: "write" });
assert.equal(result.ok, true);
assert.match(result.stdout, /replace_section docs\/sections\.md/);
assert.match(result.stdout, /heading: L9 ## Tools/);

result = await sandbox.run('section docs/sections.md "## Tools"');
assert.equal(result.stdout, "## Tools\n\n- new tool");

result = await sandbox.run(`replace_section docs/sections.md "## Missing" <<'EOF'
## Missing

Nope.
EOF`, { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /section heading not found/);
assert.match(result.stderr ?? "", /Candidate headings/);

result = await sandbox.run(`patch_many docs/sections.md --dry-run <<'EOF'
[
  {"old_text":"Old status.","new_text":"New status."},
  {"old_text":"new tool","new_text":"better tool"}
]
EOF`, { scope: "write" });
assert.equal(result.ok, true);
assert.match(result.stdout, /patch_many dry-run/);
assert.match(result.stdout, /1: matches=1/);
assert.match(result.stdout, /2: matches=1/);

result = await sandbox.run("cat docs/sections.md");
assert.match(result.stdout, /Old status/);
assert.match(result.stdout, /new tool/);

result = await sandbox.run(`patch_many docs/sections.md <<'EOF'
[
  {"old_text":"Old status.","new_text":"New status."},
  {"old_text":"missing text","new_text":"will not apply"}
]
EOF`, { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /patch_many aborted/);

result = await sandbox.run("cat docs/sections.md");
assert.match(result.stdout, /Old status/);
assert.doesNotMatch(result.stdout, /New status/);

result = await sandbox.run(`patch_many docs/sections.md <<'EOF'
[
  {"old_text":"Old status.","new_text":"New status."},
  {"old_text":"new tool","new_text":"better tool"}
]
EOF`, { scope: "write" });
assert.equal(result.ok, true);
assert.match(result.stdout, /patch_many docs\/sections\.md/);

result = await sandbox.run("cat docs/sections.md");
assert.match(result.stdout, /New status/);
assert.match(result.stdout, /better tool/);

result = await sandbox.run("lint_stale_append docs/sections.md");
assert.equal(result.ok, true);
assert.match(result.stdout, /possible completed work still in next-step section/);

result = await sandbox.run(`mkdir docs/pkg
write docs/pkg/README.md <<'EOF'
---
summary: Package summary.
tags: [pkg, test]
---

# Package

This package tests inspection.
EOF

write docs/pkg/notes.md <<'EOF'
# Notes

Same document page.
EOF

mkdir docs/pkg/child
write docs/pkg/child/README.md <<'EOF'
---
title: Child Title
summary: Child summary.
tags: [child]
---

# Child

Child body.
EOF`, { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("inspect_doc docs/pkg");
assert.equal(result.ok, true);
assert.match(result.stdout, /kind: document-package/);
assert.match(result.stdout, /body: docs\/pkg\/README\.md/);
assert.match(result.stdout, /same-document pages \(2\)/);
assert.match(result.stdout, /\[page\] docs\/pkg\/notes\.md/);
assert.match(result.stdout, /child documents \(1\)/);
assert.match(result.stdout, /docs\/pkg\/child/);
assert.match(result.stdout, /recommended next commands/);

const fatPackageCommands = [
  "mkdir docs/fat",
  "write docs/fat/README.md <<'EOF'",
  "---",
  "summary: Fat package.",
  "tags: [fat]",
  "---",
  "",
  "# Fat",
  "EOF",
  ...Array.from({ length: 12 }, (_, index) => [
    "",
    `write docs/fat/page-${String(index + 1).padStart(2, "0")}.md <<'EOF'`,
    `# Page ${index + 1}`,
    "",
    "Content.",
    "EOF"
  ].join("\n"))
].join("\n");
result = await sandbox.run(fatPackageCommands, { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("inspect_doc docs/fat");
assert.equal(result.ok, true);
assert.match(result.stdout, /suggestions:/);
assert.match(result.stdout, /has 12 same-document pages/);

result = await sandbox.run("lint_doc docs/fat");
assert.equal(result.ok, true);
assert.match(result.stdout, /\[warn\] document-package: document package has 12 same-document pages/);

result = await sandbox.run("inspect_doc docs/pkg/notes.md");
assert.equal(result.ok, true);
assert.match(result.stdout, /kind: same-document-page/);
assert.match(result.stdout, /input is a same-document page/);

result = await sandbox.run("lint_doc docs/pkg/README.md");
assert.equal(result.ok, true);
assert.equal(result.stdout, "no document lint issues found");

result = await sandbox.run(`mkdir docs/bad
write docs/bad/README.md <<'EOF'
# Bad

See [Missing](missing.md).
EOF`, { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("lint_doc docs/bad/README.md");
assert.equal(result.ok, true);
assert.match(result.stdout, /no frontmatter summary/);
assert.match(result.stdout, /no frontmatter tags/);
assert.match(result.stdout, /broken internal link/);
assert.match(result.stdout, /\[info\] reader-card/);
assert.match(result.stdout, /\[error\] link/);

result = await sandbox.run(`write docs/session-residue.md <<'EOF'
# Session Residue

type: session
status: pending

## 10:30 Work

Temporary note.
EOF`, { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("lint_doc docs/session-residue.md");
assert.equal(result.ok, true);
assert.match(result.stdout, /looks like journal\/session residue/);
assert.match(result.stdout, /docs root contains same-document pages/);
assert.match(result.stdout, /\[warn\] placement/);

result = await sandbox.run(`write sources/compiled.md <<'EOF'
# Source?

## Decisions

- This is synthesis.
EOF`, { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("lint_doc sources/compiled.md");
assert.equal(result.ok, true);
assert.match(result.stdout, /looks like compiled wiki synthesis/);

result = await sandbox.run(`write self/maybe.md <<'EOF'
# Maybe

可能只是今天的临时想法。
EOF`, { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("lint_doc self/maybe.md");
assert.equal(result.ok, true);
assert.match(result.stdout, /uncertain or temporary language/);

result = await sandbox.run("workspace_health");
assert.equal(result.ok, true);
assert.match(result.stdout, /Workspace Entropy Snapshot/);
assert.match(result.stdout, /totals: error \d+, warn \d+, info \d+/);
assert.match(result.stdout, /document package has 12 same-document pages/);
assert.match(result.stdout, /broken internal link/);
assert.match(result.stdout, /recommended next commands/);

result = await sandbox.run("help inspect_doc");
assert.equal(result.ok, true);
assert.match(result.stdout, /folder-as-document model/);

result = await sandbox.run("help lint_doc");
assert.equal(result.ok, true);
assert.match(result.stdout, /wrong-layer writes/);

result = await sandbox.run("help workspace_health");
assert.equal(result.ok, true);
assert.match(result.stdout, /newly connected agents/);

result = await sandbox.run("write docs/tracked-delete.md <<EOF\nTracked\nEOF", { scope: "write" });
assert.equal(result.ok, true);
result = await sandbox.run("archive docs/tracked-delete.md", { scope: "write" });
assert.equal(result.ok, true);
result = await sandbox.run("changes --stat");
assert.equal(result.ok, true);
assert.match(result.stdout, /docs\/tracked-delete\.md: deleted\/missing/);
result = await sandbox.run("changes");
assert.equal(result.ok, true);
assert.match(result.stdout, /docs\/tracked-delete\.md: deleted\/missing/);

result = await sandbox.run("write docs/quoted.md <<EOF\n他说“你好”\nEOF", { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run('patch docs/quoted.md <<\'EOF\'\n{"old_text":"他说\\"你好\\"","new_text":"他说\\"再见\\""}\nEOF', { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /patch conflict: old_text not found/);
assert.match(result.stderr ?? "", /Closest candidate lines/);
assert.match(result.stderr ?? "", /他说“你好”/);

result = await sandbox.run('patch docs/quoted.md <<\'EOF\'\n{"old_text":"他说“你好”","new_text":"他说“再见”"}\nEOF', { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("cat docs/quoted.md");
assert.equal(result.stdout, "他说“再见”");

result = await sandbox.run("write docs/unified.md <<'EOF'\n# Unified\n\nold\nEOF", { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run(`patch <<'EOF'
--- a/docs/unified.md
+++ b/docs/unified.md
@@ -1,3 +1,3 @@
 # Unified
 
-old
+new
EOF`, { scope: "write" });
assert.equal(result.ok, true);
assert.match(result.stdout, /patch docs\/unified\.md/);

result = await sandbox.run("cat docs/unified.md");
assert.equal(result.stdout, "# Unified\n\nnew\n");

result = await sandbox.run(`patch docs/unified.md <<'EOF'
@@ -1,3 +1,3 @@
 # Unified
 
-new
+newer
EOF`, { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run(`patch <<'EOF'
--- /dev/null
+++ b/docs/unified-created.md
@@ -0,0 +1,2 @@
+# Created
+body
EOF`, { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("cat docs/unified-created.md");
assert.equal(result.stdout, "# Created\nbody\n");

result = await sandbox.run(`patch <<'EOF'
--- a/docs/unified.md
+++ b/docs/unified.md
@@ -1,3 +1,3 @@
 # Unified
 
-newer
+rolled back candidate
--- a/docs/missing-unified.md
+++ b/docs/missing-unified.md
@@ -1,1 +1,1 @@
-missing
+still missing
EOF`, { scope: "write" });
assert.equal(result.ok, false);

result = await sandbox.run("cat docs/unified.md");
assert.equal(result.stdout, "# Unified\n\nnewer\n");

result = await sandbox.run(`patch docs/quoted.md <<EOF
{"old_text":"他说
“再见”","new_text":"x"}
EOF`, { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /JSON strings cannot contain literal line breaks/);

result = await sandbox.run("cat ../etc/passwd");
assert.equal(result.ok, false);

result = await sandbox.run("write nope.md <<EOF\nx\nEOF", { scope: "read" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /Command requires write scope/);

result = await sandbox.run("bash -lc ls", { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /Unsupported command: bash/);

result = await sandbox.run("mkdir nested/archive-test", { scope: "write" });
assert.equal(result.ok, true);
result = await sandbox.run("write nested/archive-test/a.md <<EOF\nA\nEOF", { scope: "write" });
assert.equal(result.ok, true);
result = await sandbox.run("archive nested/archive-test/a.md", { scope: "write" });
assert.equal(result.ok, true);
result = await sandbox.run("write nested/archive-test/b.md <<EOF\nB\nEOF", { scope: "write" });
assert.equal(result.ok, true);
result = await sandbox.run("archive nested/archive-test", { scope: "write" });
assert.equal(result.ok, true);

result = await sandbox.run("archive docs", { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /protected root directory/);

result = await sandbox.run("mkdir journal", { scope: "write" });
assert.equal(result.ok, true);
result = await sandbox.run("archive journal", { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /protected root directory/);

result = await sandbox.run("archive archive", { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /protected root directory/);

result = await sandbox.run("write self/context.md <<EOF\nstable context\nEOF", { scope: "write" });
assert.equal(result.ok, true);
result = await sandbox.run("cat self/context.md");
assert.equal(result.stdout, "stable context");
result = await sandbox.run("archive self", { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /protected system path/);
result = await sandbox.run("mv self/context.md docs/context-old.md", { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /protected system path/);

result = await sandbox.run("mv docs docs-old", { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /protected root directory/);

result = await sandbox.run("mv topics docs-old", { scope: "write" });
assert.equal(result.ok, false);
assert.match(result.stderr ?? "", /protected root directory/);

result = await sandbox.run("write docs/movable.md <<EOF\nmove me\nEOF", { scope: "write" });
assert.equal(result.ok, true);
result = await sandbox.run("archive docs/movable.md", { scope: "write" });
assert.equal(result.ok, true);

assert.ok(audit.length >= 3);
await fs.rm(root, { recursive: true, force: true });
