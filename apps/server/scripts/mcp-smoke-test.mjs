#!/usr/bin/env node
import assert from "node:assert/strict";

const mcpUrl = new URL(process.env.MCP_SERVER_URL ?? process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp");
const publicBaseUrl = stripTrailingSlash(process.env.MCP_PUBLIC_BASE_URL ?? process.env.BASE_URL ?? derivePublicBaseUrl(mcpUrl));
const expectedResource = process.env.MCP_EXPECTED_RESOURCE ?? `${publicBaseUrl}/mcp`;
const token = process.env.MCP_TOKEN ?? process.env.MCP_BEARER_TOKEN ?? "local-dev-mcp-token";
const skipDiscovery = process.env.MCP_SMOKE_SKIP_OAUTH_DISCOVERY === "1";

const checks = [];
const smokeNamespace = `archive/smoke-tests/mcp-${Date.now()}`;
let sessionId = "";

await check("rejects missing bearer token", async () => {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });

  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp/);
});

if (!skipDiscovery) {
  await check("serves OAuth protected-resource metadata", async () => {
    const metadata = await getJson("/.well-known/oauth-protected-resource/mcp");
    assert.equal(metadata.resource, expectedResource);
    assert.ok(Array.isArray(metadata.authorization_servers));
    assert.ok(metadata.authorization_servers.includes(publicBaseUrl));
    assert.ok(metadata.scopes_supported.includes("workspace:read"));
    assert.ok(metadata.scopes_supported.includes("workspace:write"));
  });

  await check("serves OAuth authorization-server metadata", async () => {
    const metadata = await getJson("/.well-known/oauth-authorization-server");
    assert.equal(metadata.issuer, publicBaseUrl);
    assert.equal(metadata.authorization_endpoint, `${publicBaseUrl}/oauth/authorize`);
    assert.equal(metadata.token_endpoint, `${publicBaseUrl}/oauth/token`);
    assert.equal(metadata.registration_endpoint, `${publicBaseUrl}/oauth/register`);
    assert.ok(metadata.grant_types_supported.includes("authorization_code"));
    assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
  });
}

await check("initializes a stateful MCP session", async () => {
  const response = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "ai-meditations-smoke",
        version: "0.1.0"
      }
    }
  });

  sessionId = response.sessionId;
  assert.ok(sessionId);
  assert.equal(response.body.result.serverInfo.name, "ai-meditations");
  assert.equal(response.body.result.protocolVersion, "2025-06-18");
});

await check("accepts initialized notification", async () => {
  const response = await rpc(
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    },
    { sessionId, expectedStatus: 202 }
  );
  assert.equal(response.text, "");
});

await check("lists expected MCP tools", async () => {
  const response = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { sessionId });
  const names = response.body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("run_shell"));
  assert.ok(names.includes("write_file"));
  assert.ok(names.includes("patch_file"));
  assert.ok(names.includes("get_workspace_info"));
});

await check("lists expected MCP resources", async () => {
  const response = await rpc({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} }, { sessionId });
  const uris = response.body.result.resources.map((resource) => resource.uri);
  assert.ok(uris.includes("ai-meditations://llms.txt"));
  assert.ok(uris.includes("ai-meditations://workspace/info"));
  assert.ok(uris.includes("ai-meditations://skills/wiki-maintenance"));
  assert.ok(uris.includes("ai-meditations://skills/organize-workspace"));
});

await check("reads llms.txt resource", async () => {
  const response = await rpc(
    {
      jsonrpc: "2.0",
      id: 31,
      method: "resources/read",
      params: {
        uri: "ai-meditations://llms.txt"
      }
    },
    { sessionId }
  );
  const text = resourceText(response.body);
  assert.match(text, /AI Meditations/);
  assert.match(text, /Architecture/);
  assert.match(text, /Write Policy/);
});

await check("reads wiki maintenance skill", async () => {
  const response = await rpc(
    {
      jsonrpc: "2.0",
      id: 32,
      method: "resources/read",
      params: {
        uri: "ai-meditations://skills/wiki-maintenance"
      }
    },
    { sessionId }
  );
  const text = resourceText(response.body);
  assert.match(text, /Ingest Workflow/);
  assert.match(text, /Query Workflow/);
  assert.match(text, /Lint Workflow/);
});

await check("reads organize workspace skill", async () => {
  const response = await rpc(
    {
      jsonrpc: "2.0",
      id: 33,
      method: "resources/read",
      params: {
        uri: "ai-meditations://skills/organize-workspace"
      }
    },
    { sessionId }
  );
  const text = resourceText(response.body);
  assert.match(text, /Entropy Signals/);
  assert.match(text, /Cleanup Playbooks/);
  assert.match(text, /lint_doc/);
  assert.match(text, /inspect_doc/);
});

await check("calls get_workspace_info", async () => {
  const response = await rpc(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "get_workspace_info",
        arguments: {}
      }
    },
    { sessionId }
  );
  const text = toolText(response.body);
  assert.match(text, /AGENTS\.md/);
  assert.match(text, /llms\.txt/);
  assert.match(text, /sources\/README\.md/);
  assert.match(text, /run_shell/);
  assert.match(text, /Current Entropy Snapshot/);
  assert.match(text, /Workspace Entropy Snapshot/);
  assert.match(text, /workspace_health/);
});

await check("calls run_shell", async () => {
  const response = await rpc(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "run_shell",
        arguments: { command: "pwd" }
      }
    },
    { sessionId }
  );
  assert.equal(response.body.result.structuredContent.ok, true);
  assert.equal(response.body.result.structuredContent.cwd, ".");
});

await check("run_shell returns non-empty JSON responses repeatedly", async () => {
  for (let index = 0; index < 3; index += 1) {
    const response = await rpc(
      {
        jsonrpc: "2.0",
        id: 50 + index,
        method: "tools/call",
        params: {
          name: "run_shell",
          arguments: { command: "help" }
        }
      },
      { sessionId }
    );
    assert.ok(response.text.trim(), "Expected non-empty MCP response body");
    assert.equal(response.body.result.structuredContent.ok, true);
  }
});

await check("supports structured write_file and patch_file tools", async () => {
  const filePath = `${smokeNamespace}/structured.md`;
  const created = await callTool(sessionId, "write_file", {
    path: filePath,
    content_base64: Buffer.from("# Structured MCP Write\n\nhello from JSON\n", "utf8").toString("base64")
  });
  assert.equal(created.structuredContent.ok, true);
  assert.equal(created.structuredContent.path, filePath);

  const appended = await callTool(sessionId, "write_file", {
    path: filePath,
    mode: "append",
    content: "\nappended from structured tool"
  });
  assert.equal(appended.structuredContent.ok, true);

  const patched = await callTool(sessionId, "patch_file", {
    path: filePath,
    old_text: "hello from JSON\n\nappended from structured tool",
    new_text: "hello from structured JSON"
  });
  assert.equal(patched.structuredContent.ok, true);

  const read = await callRunShell(sessionId, `cat ${filePath}`);
  assert.equal(read.structuredContent.ok, true);
  assert.equal(read.structuredContent.stdout, "# Structured MCP Write\n\nhello from structured JSON");
});

await check("supports agent-friendly shell readers", async () => {
  const helpRg = await callRunShell(sessionId, "help rg");
  assert.equal(helpRg.structuredContent.ok, true);
  assert.match(helpRg.structuredContent.stdout, /--context/);

  const helpInspect = await callRunShell(sessionId, "help inspect_doc");
  assert.equal(helpInspect.structuredContent.ok, true);
  assert.match(helpInspect.structuredContent.stdout, /folder-as-document model/);

  const helpHealth = await callRunShell(sessionId, "help workspace_health");
  assert.equal(helpHealth.structuredContent.ok, true);
  assert.match(helpHealth.structuredContent.stdout, /newly connected agents/);

  const health = await callRunShell(sessionId, "workspace_health");
  assert.equal(health.structuredContent.ok, true);
  assert.match(health.structuredContent.stdout, /Workspace Entropy Snapshot/);
  assert.match(health.structuredContent.stdout, /totals: error/);

  const numbered = await callRunShell(sessionId, "nl AGENTS.md");
  assert.equal(numbered.structuredContent.ok, true);
  assert.match(numbered.structuredContent.stdout, /\s*1\t# AGENTS/);

  const search = await callRunShell(sessionId, "rg -C 1 MCP AGENTS.md");
  assert.equal(search.structuredContent.ok, true);
  assert.match(search.structuredContent.stdout, /MCP/);

  const diff = await callRunShell(sessionId, "diff AGENTS.md AGENTS.md");
  assert.equal(diff.structuredContent.ok, true);
  assert.equal(diff.structuredContent.stdout, "no changes");
});

await check("supports document inspection and lint", async () => {
  const docPath = `${smokeNamespace}/doc-ops`;
  try {
    const created = await callRunShell(
      sessionId,
      [
        `mkdir ${docPath}`,
        `write ${docPath}/README.md <<'EOF'`,
        "---",
        "summary: Smoke-test document package.",
        "tags: [smoke, mcp]",
        "---",
        "",
        "# Smoke Doc Ops",
        "",
        "This is a temporary smoke-test document.",
        "EOF",
        "",
        `write ${docPath}/page.md <<'EOF'`,
        "# Smoke Page",
        "",
        "Same-document page.",
        "EOF",
        "",
        `mkdir ${docPath}/sub_docs/child`,
        `write ${docPath}/sub_docs/child/README.md <<'EOF'`,
        "---",
        "summary: Smoke-test child document.",
        "tags: [smoke]",
        "---",
        "",
        "# Smoke Child",
        "",
        "Child body.",
        "EOF"
      ].join("\n")
    );
    assert.equal(created.structuredContent.ok, true);

    const inspect = await callRunShell(sessionId, `inspect_doc ${docPath}`);
    assert.equal(inspect.structuredContent.ok, true);
    assert.match(inspect.structuredContent.stdout, /same-document pages \(2\)/);
    assert.match(inspect.structuredContent.stdout, /child documents \(1\)/);

    const lint = await callRunShell(sessionId, `lint_doc ${docPath}`);
    assert.equal(lint.structuredContent.ok, true);
    assert.equal(lint.structuredContent.stdout, "no document lint issues found");

    const badDocPath = `${smokeNamespace}/bad-lint`;
    const badDoc = await callRunShell(
      sessionId,
      [
        `mkdir ${badDocPath}`,
        `write ${badDocPath}/README.md <<'EOF'`,
        "# Bad Lint",
        "",
        "See [missing](missing.md).",
        "EOF"
      ].join("\n")
    );
    assert.equal(badDoc.structuredContent.ok, true);

    const badLint = await callRunShell(sessionId, `lint_doc ${badDocPath}`);
    assert.equal(badLint.structuredContent.ok, true);
    assert.match(badLint.structuredContent.stdout, /\[error\] link/);
  } finally {
    await callRunShell(sessionId, `archive ${docPath}`).catch(() => undefined);
  }
});

await check("handles shell parser edge cases", async () => {
  const quotedRg = await callRunShell(sessionId, 'rg -n "Source Of Truth|MCP" AGENTS.md');
  assert.equal(quotedRg.structuredContent.ok, true);
  assert.match(quotedRg.structuredContent.stdout, /AGENTS\.md/);

  const head = await callRunShell(sessionId, "head AGENTS.md 3");
  assert.equal(head.structuredContent.ok, true);
  assert.equal(head.structuredContent.stdout.split(/\r?\n/).length, 3);

  const missingPath = await callRunShell(sessionId, 'rg "pattern" missing/path.md');
  assert.equal(missingPath.structuredContent.ok, false);
  assert.equal(missingPath.structuredContent.errorType, "path_error");

  const multi = await callRunShell(
    sessionId,
    `write ${smokeNamespace}/multi.md <<'EOF'\nhello\nEOF\n\nwrite ${smokeNamespace}/multi-2.md <<'EOF'\nworld\nEOF`
  );
  assert.equal(multi.structuredContent.ok, true);
  assert.match(multi.structuredContent.stdout, /\$ write archive\/smoke-tests\/mcp-\d+\/multi\.md/);
  assert.match(multi.structuredContent.stdout, /\$ write archive\/smoke-tests\/mcp-\d+\/multi-2\.md/);

  const firstBatchFile = await callRunShell(sessionId, `cat ${smokeNamespace}/multi.md`);
  assert.equal(firstBatchFile.structuredContent.ok, true);
  assert.equal(firstBatchFile.structuredContent.stdout, "hello");

  const unifiedPatch = await callRunShell(
    sessionId,
    [
      `patch <<'EOF'`,
      `--- a/${smokeNamespace}/multi.md`,
      `+++ b/${smokeNamespace}/multi.md`,
      "@@ -1,1 +1,1 @@",
      "-hello",
      "+hello from unified diff",
      "EOF"
    ].join("\n")
  );
  assert.equal(unifiedPatch.structuredContent.ok, true);
  assert.match(unifiedPatch.structuredContent.stdout, /patch archive\/smoke-tests\/mcp-\d+\/multi\.md/);

  const unifiedPatchedFile = await callRunShell(sessionId, `cat ${smokeNamespace}/multi.md`);
  assert.equal(unifiedPatchedFile.structuredContent.ok, true);
  assert.equal(unifiedPatchedFile.structuredContent.stdout, "hello from unified diff\n");

  const rollbackBase = await callRunShell(sessionId, `write ${smokeNamespace}/rollback.md <<'EOF'\nbefore\nEOF`);
  assert.equal(rollbackBase.structuredContent.ok, true);

  const rollbackFailure = await callRunShell(
    sessionId,
    `write ${smokeNamespace}/rollback.md <<'EOF'\nafter\nEOF\n\ncat missing/rollback.md`
  );
  assert.equal(rollbackFailure.structuredContent.ok, false);
  assert.match(rollbackFailure.structuredContent.stderr, /rolled back/);

  const rollbackRead = await callRunShell(sessionId, `cat ${smokeNamespace}/rollback.md`);
  assert.equal(rollbackRead.structuredContent.ok, true);
  assert.equal(rollbackRead.structuredContent.stdout, "before");

  const invalidMulti = await callRunShell(
    sessionId,
    "write docs/__smoke_bad_multi.md <<'EOF'\nhello\nEOF\n\nwrite docs/__smoke_bad_multi_2.md <<'EOF'\nworld"
  );
  assert.equal(invalidMulti.structuredContent.ok, false);
  assert.equal(invalidMulti.structuredContent.errorType, "parse_error");
  assert.match(invalidMulti.structuredContent.stderr, /missing heredoc terminator/);

  const failedWrite = await callRunShell(sessionId, "cat docs/__smoke_bad_multi.md");
  assert.equal(failedWrite.structuredContent.ok, false);
  assert.equal(failedWrite.structuredContent.errorType, "path_error");

  const delimiterCollision = await callRunShell(
    sessionId,
    `append ${smokeNamespace}/delimiter-collision.md <<EOF\n\`\`\`text\nwrite docs/example.md <<EOF\ncontent\nEOF\n\`\`\`\nEOF`
  );
  assert.equal(delimiterCollision.structuredContent.ok, false);
  assert.equal(delimiterCollision.structuredContent.errorType, "parse_error");
  assert.match(delimiterCollision.structuredContent.stderr, /use a delimiter that does not appear alone in the body/);

  const delimiterCollisionFile = await callRunShell(sessionId, `cat ${smokeNamespace}/delimiter-collision.md`);
  assert.equal(delimiterCollisionFile.structuredContent.ok, false);
  assert.equal(delimiterCollisionFile.structuredContent.errorType, "path_error");

  await callRunShell(sessionId, `archive ${smokeNamespace}/multi.md\narchive ${smokeNamespace}/multi-2.md\narchive ${smokeNamespace}/rollback.md`);
  await callRunShell(sessionId, `archive ${smokeNamespace}`).catch(() => undefined);
});

await closeSession(sessionId);

console.log(`\nMCP smoke test passed: ${checks.length} checks`);

async function check(name, fn) {
  try {
    await fn();
    checks.push(name);
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
    await closeSession(sessionId);
    process.exit();
  }
}

async function getJson(pathname) {
  const url = new URL(pathname, `${publicBaseUrl}/`);
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function rpc(payload, options = {}) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {})
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  const expectedStatus = options.expectedStatus ?? 200;
  assert.equal(response.status, expectedStatus, text);
  if (expectedStatus === 200) assert.ok(text.trim(), "Expected non-empty MCP response body");
  return {
    text,
    sessionId: response.headers.get("mcp-session-id") ?? options.sessionId ?? "",
    body: text ? parseMcpBody(text, response.headers.get("content-type") ?? "") : undefined
  };
}

function parseMcpBody(text, contentType) {
  if (contentType.includes("application/json")) return JSON.parse(text);

  const events = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line && line !== "[DONE]");

  assert.ok(events.length, `No JSON-RPC data event found in response: ${text.slice(0, 300)}`);
  return JSON.parse(events.at(-1));
}

function toolText(body) {
  const structured = body.result.structuredContent;
  if (typeof structured?.text === "string") return structured.text;
  return (body.result.content ?? []).map((item) => item.text ?? "").join("\n");
}

function resourceText(body) {
  return (body.result.contents ?? []).map((item) => item.text ?? "").join("\n");
}

async function callRunShell(sessionId, command) {
  return callTool(sessionId, "run_shell", { command });
}

async function callTool(sessionId, name, args) {
  const response = await rpc(
    {
      jsonrpc: "2.0",
      id: 500,
      method: "tools/call",
      params: {
        name,
        arguments: args
      }
    },
    { sessionId }
  );
  return response.body.result;
}

async function closeSession(id) {
  if (!id) return;
  await fetch(mcpUrl, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "mcp-session-id": id
    }
  }).catch(() => undefined);
}

function derivePublicBaseUrl(url) {
  const derived = new URL(url);
  if (derived.pathname.endsWith("/mcp")) {
    derived.pathname = derived.pathname.slice(0, -"/mcp".length) || "/";
  }
  derived.search = "";
  derived.hash = "";
  return stripTrailingSlash(derived.toString());
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
