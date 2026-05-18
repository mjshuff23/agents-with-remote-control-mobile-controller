import { McpPermissionLevel, McpToolRisk } from '../registry/mcp-registry.schema';

/** All valid reason codes for a permission decision. */
export type McpPermissionReasonCode =
  | 'undeclared_tool'
  | 'admin_blocked'
  | 'blocked_tool_risk'
  | 'permission_ceiling_exceeded'
  | 'denied_replay'
  | 'auto_allow_read'
  | 'needs_approval_append'
  | 'needs_approval_write';

/** Terminal outcome of a permission assessment. */
export type McpPermissionOutcome = 'auto_allow' | 'needs_approval' | 'blocked';

/** Full result returned by McpPermissionService.assess(). */
export interface McpPermissionDecision {
  decision: McpPermissionOutcome;
  reasonCode: McpPermissionReasonCode;
  serverId: string;
  toolName: string;
  declaredPermission: McpPermissionLevel;
  toolRisk: McpToolRisk | null;
  ruleMatched: string;
}

/** Optional caller-supplied context forwarded to audit records. */
export interface McpPermissionContext {
  sessionId?: string;
  taskId?: string;
}

/**
 * Numeric rank for each permission level.
 * Higher rank = more permissive. admin (3) is blocked in Phase 5.
 */
export const PERMISSION_RANK: Record<McpPermissionLevel, number> = {
  read_only: 0,
  append_only: 1,
  write: 2,
  admin: 3
};

/**
 * Minimum permission level required to execute a tool of a given risk.
 * destructive and secret_sensitive have no valid ceiling — they are always blocked.
 */
export const RISK_REQUIRED_PERMISSION: Partial<Record<McpToolRisk, McpPermissionLevel>> = {
  read: 'read_only',
  append: 'append_only',
  write: 'write'
};
