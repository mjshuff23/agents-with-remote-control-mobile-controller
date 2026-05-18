import { McpPermissionLevel, McpToolRisk, McpTransportKind } from './mcp-registry.schema';

/** Default registry file name, resolved relative to ARC_REPO_PATH. */
export const MCP_REGISTRY_DEFAULT_FILENAME = 'arc.mcp.json';

/** All valid transport kinds. */
export const MCP_TRANSPORT_KINDS: ReadonlySet<McpTransportKind> = new Set([
  'stdio',
  'streamable_http',
  'legacy_sse'
]);

/** All valid permission levels. */
export const MCP_PERMISSION_LEVELS: ReadonlySet<McpPermissionLevel> = new Set([
  'read_only',
  'append_only',
  'write',
  'admin'
]);

/** All valid tool risk levels. */
export const MCP_TOOL_RISKS: ReadonlySet<McpToolRisk> = new Set([
  'read',
  'append',
  'write',
  'destructive',
  'secret_sensitive'
]);

/**
 * Permission levels that are explicitly blocked in Phase 5.
 * A registration declaring any of these fails validation at load time.
 */
export const PHASE5_BLOCKED_PERMISSION_LEVELS: ReadonlySet<McpPermissionLevel> = new Set([
  'admin'
]);

/**
 * Tool risk levels that are blocked in Phase 5.
 * Declaring a tool with any of these risks fails validation at load time.
 */
export const PHASE5_BLOCKED_TOOL_RISKS: ReadonlySet<McpToolRisk> = new Set([
  'destructive',
  'secret_sensitive'
]);

/**
 * Default permission level applied when a server registration omits the field.
 * Fail-safe: least-privilege read_only rather than any write capability.
 */
export const MCP_DEFAULT_PERMISSION_LEVEL: McpPermissionLevel = 'read_only';
