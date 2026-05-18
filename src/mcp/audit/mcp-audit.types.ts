/** Who made the terminal decision on this tool call. */
export type McpAuditDecider = 'policy' | 'user' | 'system';

/**
 * Final disposition of an MCP tool-call attempt.
 * Extends McpToolCallOutcome with 'failed' for transport/execution errors.
 */
export type McpAuditOutcome = 'auto_allow' | 'blocked' | 'approved' | 'denied' | 'expired' | 'failed';

/** Closed set of error categories for failed outcomes. */
export type McpAuditErrorCategory = 'transport_error' | 'tool_error' | 'timeout' | 'unknown';

/** Input DTO for McpAuditService.record(). */
export interface RecordMcpAuditInput {
  taskId?: string;
  sessionId?: string;
  approvalRequestId?: string;
  serverId: string;
  serverDisplayName: string;
  toolName: string;
  permissionLevel?: string;
  toolRisk?: string;
  outcome: McpAuditOutcome;
  /** Permission decision reason code from McpPermissionService.assess(). */
  reasonCode?: string;
  /** Raw (pre-sanitization) args — hashed for forensic fidelity. */
  args: Record<string, unknown>;
  /** Raw result from transport, if execution occurred. */
  result?: unknown;
  startedAt: Date;
  finishedAt?: Date;
  errorCategory?: McpAuditErrorCategory;
}
