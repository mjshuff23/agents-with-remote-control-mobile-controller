/** Transport kind for an MCP server connection. */
export type McpTransportKind = 'stdio' | 'streamable_http' | 'legacy_sse';

/** Permission ceiling for an MCP server. admin is reserved and blocked in Phase 5. */
export type McpPermissionLevel = 'read_only' | 'append_only' | 'write' | 'admin';

/** Risk classification for a declared MCP tool. */
export type McpToolRisk = 'read' | 'append' | 'write' | 'destructive' | 'secret_sensitive';

/**
 * Transport configuration for an MCP server.
 * Discriminated on `kind` so callers narrow to the exact connection shape.
 */
export type McpTransportDeclaration =
  | {
      kind: 'stdio';
      /** Executable path — must not be a shell string. */
      command: string;
      args?: string[];
      cwd?: string;
      /** Env var names forwarded to the child process. Never pass wholesale. */
      envAllowlist?: string[];
    }
  | {
      kind: 'streamable_http';
      url: string;
      /** Header env var names allowed for this connection. Never log these. */
      headersEnvAllowlist?: string[];
    }
  | {
      kind: 'legacy_sse';
      url: string;
      /** Header env var names allowed for this connection. Never log these. */
      headersEnvAllowlist?: string[];
    };

/** A single tool declared by an MCP server in the registry. */
export interface McpToolDeclaration {
  name: string;
  description?: string;
  risk: McpToolRisk;
  requiresApproval: boolean;
  allowedArgumentPaths?: string[];
  blockedArgumentPaths?: string[];
}

/**
 * A single MCP server registration entry.
 * canReadSecrets is structurally `false` — Phase 5 blocks secret-read capability.
 */
export interface McpServerRegistration {
  id: string;
  displayName: string;
  enabled: boolean;
  transport: McpTransportDeclaration;
  permissionLevel: McpPermissionLevel;
  tools: McpToolDeclaration[];
  canReadSecrets: false;
  createdBy: 'config' | 'runtime';
}

/** Root shape of the MCP registry config file (arc.mcp.json). */
export interface McpRegistryConfig {
  version: 1;
  servers: McpServerRegistration[];
}
