export type SandboxScope = "read" | "write" | "admin";

export type SandboxCommandResult = {
  ok: boolean;
  stdout: string;
  stderr?: string;
  errorType?: string;
  cwd: string;
  truncated?: boolean;
};

export type WorkspaceFileEntry = {
  path: string;
  name: string;
  kind: "file" | "directory";
  size?: number;
  updatedAt?: string;
};

export type AuditEvent = {
  id: string;
  time: string;
  actorType: "web" | "mcp_token" | "system";
  actorId: string;
  operation: string;
  path?: string;
  beforeHash?: string;
  afterHash?: string;
  bytesWritten?: number;
  command?: string;
  documentPath?: string;
};
