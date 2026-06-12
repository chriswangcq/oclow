# Oclow

Oclow is a private Markdown workspace for humans and agents.

Humans get a lightweight document reader. Agents get an MCP-accessible, file-backed LLM Wiki with constrained read/write tools.

## What It Is

- A document workspace backed by plain files.
- A Remote MCP server for agent access.
- A human-facing web reader for docs, journal, search, safety, and agent connection.
- A multi-user server with isolated workspaces and per-user MCP tokens.

## Workspace Model

Oclow treats directories as document packages:

```text
docs/sub_docs/example/
  README.md          # only body of this document package
  _attachments/      # files owned by this document; not a child document
  sub_docs/
    child-document/
      README.md      # child document
```

The physical directory tree is the source of truth for parent/child relationships. Oclow does not require hidden JSON node indexes for normal document structure.

Durable document README files can provide lightweight card metadata:

```yaml
---
title: Example Document
summary: One sentence explaining what this document is for.
tags: [example, guide]
status: active
---
```

Supported status values are `active`, `draft`, `reference`, and `archived`.

The default workspace layout:

```text
AGENTS.md       # canonical rules for agents
docs/           # compiled wiki / durable documents
sources/        # raw source material
journal/        # timeline notes
self/           # user-visible durable agent context
archive/        # cooled-down material
```

## MCP Surface

The server exposes a Remote MCP endpoint at:

```text
/mcp
```

Supported agent tools include:

- `get_workspace_info`: compact workspace map and current health snapshot.
- `run_shell`: constrained document-workspace command interpreter.
- `write_file`: structured write/append for MCP clients that struggle with heredoc escaping.
- `patch_file`: structured exact text replacement with dry-run support.

The shell is intentionally not a real OS shell. It supports safe document operations such as `rg`, `cat`, `tree`, `inspect_doc`, `toc`, `section`, `patch`, `replace_section`, `lint_doc`, and `workspace_health`.

## Development

Requirements:

- Node.js 24+
- npm

Install dependencies:

```bash
npm ci
```

Run the dev server:

```bash
npm run dev
```

Run checks:

```bash
npm run typecheck
npm run test
```

Build:

```bash
npm run build
```

## Configuration

Common environment variables:

```text
PORT=8787
BASE_URL=http://localhost:8787
SYSTEM_ROOT=.meditations-data/system
WORKSPACES_ROOT=.meditations-data/workspaces
ADMIN_EMAIL=local@example.com
ADMIN_PASSWORD=local_dev_password
MCP_TOKEN=local-dev-mcp-token
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8787/auth/google/callback
GOOGLE_ALLOWED_EMAILS=
```

For production, set real secrets through the environment. Do not commit `.env` files.

## Admin CLI

After building:

```bash
npm run admin -w @ai-meditations/server -- show --email user@example.com
npm run admin -w @ai-meditations/server -- create --email user@example.com --password '<password>'
npm run admin -w @ai-meditations/server -- rotate-token --email user@example.com
```

## License

License not yet specified.
