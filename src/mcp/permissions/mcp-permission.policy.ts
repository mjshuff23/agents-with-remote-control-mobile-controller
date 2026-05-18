import { McpServerRegistration, McpToolDeclaration } from '../registry/mcp-registry.schema';
import { PHASE5_BLOCKED_PERMISSION_LEVELS, PHASE5_BLOCKED_TOOL_RISKS } from '../registry/mcp-registry.config';
import {
  McpPermissionDecision,
  McpPermissionReasonCode,
  PERMISSION_RANK,
  RISK_REQUIRED_PERMISSION
} from './mcp-permission.types';

/**
 * Secret-like value patterns. Deliberately specific to avoid over-redacting benign
 * long strings (UUIDs, file paths, etc.). Covers common API key prefixes and
 * high-entropy encodings, but not arbitrary 32+ char alphanumerics.
 */
const SECRET_VALUE_PATTERNS = [
  /sk-[a-zA-Z0-9\-_]{8,}/,                  // OpenAI-style: sk-...
  /^(ghp|gho|github_pat)_[a-zA-Z0-9]{36,}/, // GitHub personal/OAuth tokens
  /^xox[baprs]-[a-zA-Z0-9\-]+/,             // Slack tokens
  /^AKIA[A-Z0-9]{16}$/,                      // AWS access key IDs
  /^[a-f0-9]{40,}$/i,                        // SHA-1/SHA-256 hex hashes
  /^[A-Z_]{4,}KEY$/i,                        // ENV-style keys e.g. MY_SECRET_KEY
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /api.?key/i,
  /auth.?token/i,
  /bearer/i
];

/** Regex patterns for secret-like argument key names. */
const SECRET_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /api.?key/i,
  /auth/i,
  /bearer/i,
  /private.?key/i
];

function isSecretLikeKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

function isSecretLikeValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

/** Sanitize a single value of unknown type, recursing into objects and arrays. */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return isSecretLikeValue(value) ? '[REDACTED]' : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (typeof value === 'object' && value !== null) {
    return sanitizeToolArguments(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Returns a sanitized copy of tool arguments with secret-like keys/values redacted.
 * Recurses into nested objects and arrays.
 * Pure function — never mutates input.
 */
export function sanitizeToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (isSecretLikeKey(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitizeValue(value);
    }
  }
  return result;
}

/**
 * Canonicalizes an object to a deterministic JSON string by deep-sorting keys.
 * Used for denied-replay fingerprinting so that semantically identical argument
 * objects with different insertion orders produce the same fingerprint.
 */
export function canonicalizeArgs(value: unknown): string {
  return JSON.stringify(deepSortKeys(value));
}

function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => deepSortKeys(item));
  }
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = deepSortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function blocked(
  serverId: string,
  toolName: string,
  declaredPermission: McpServerRegistration['permissionLevel'],
  tool: McpToolDeclaration | null,
  reasonCode: McpPermissionReasonCode,
  ruleMatched: string
): McpPermissionDecision {
  return {
    decision: 'blocked',
    reasonCode,
    serverId,
    toolName,
    declaredPermission,
    toolRisk: tool?.risk ?? null,
    ruleMatched
  };
}

/**
 * Pure classification function — no I/O, no side effects.
 * Returns the permission decision based solely on server registration and tool metadata.
 * Denied-replay detection is handled by the service layer (requires Prisma).
 */
export function computePermissionDecision(
  server: McpServerRegistration,
  toolName: string
): McpPermissionDecision {
  // Phase 5: admin permission level is unconditionally blocked.
  if (PHASE5_BLOCKED_PERMISSION_LEVELS.has(server.permissionLevel)) {
    return blocked(server.id, toolName, server.permissionLevel, null, 'admin_blocked', 'phase5_admin_blocked');
  }

  // Tool must be declared in the server's registry entry.
  const tool = server.tools.find((t) => t.name === toolName) ?? null;
  if (!tool) {
    return blocked(server.id, toolName, server.permissionLevel, null, 'undeclared_tool', 'undeclared_tool');
  }

  // Phase 5: destructive and secret_sensitive risks are unconditionally blocked.
  if (PHASE5_BLOCKED_TOOL_RISKS.has(tool.risk)) {
    return blocked(server.id, toolName, server.permissionLevel, tool, 'blocked_tool_risk', 'phase5_blocked_tool_risk');
  }

  // Determine minimum permission required for this tool's risk.
  const requiredPermission = RISK_REQUIRED_PERMISSION[tool.risk];
  if (!requiredPermission) {
    // Unknown risk level — should not happen given Phase 5 blocking above, but fail safe.
    return blocked(server.id, toolName, server.permissionLevel, tool, 'blocked_tool_risk', 'unknown_risk_level');
  }

  // Permission ceiling check: server rank must be >= required rank.
  const serverRank = PERMISSION_RANK[server.permissionLevel];
  const requiredRank = PERMISSION_RANK[requiredPermission];
  if (serverRank < requiredRank) {
    return {
      decision: 'blocked',
      reasonCode: 'permission_ceiling_exceeded',
      serverId: server.id,
      toolName,
      declaredPermission: server.permissionLevel,
      toolRisk: tool.risk,
      ruleMatched: `server_rank(${serverRank})<required_rank(${requiredRank})`
    };
  }

  // Auto-allow read tools — they carry no side effects.
  if (tool.risk === 'read') {
    return {
      decision: 'auto_allow',
      reasonCode: 'auto_allow_read',
      serverId: server.id,
      toolName,
      declaredPermission: server.permissionLevel,
      toolRisk: tool.risk,
      ruleMatched: 'read_tool_auto_allow'
    };
  }

  // Append and write tools always require explicit approval.
  const reasonCode: McpPermissionReasonCode =
    tool.risk === 'append' ? 'needs_approval_append' : 'needs_approval_write';

  return {
    decision: 'needs_approval',
    reasonCode,
    serverId: server.id,
    toolName,
    declaredPermission: server.permissionLevel,
    toolRisk: tool.risk,
    ruleMatched: `${tool.risk}_requires_approval`
  };
}
