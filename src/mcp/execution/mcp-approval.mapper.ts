import { randomUUID } from 'crypto';
import { McpPermissionDecision } from '../permissions/mcp-permission.types';
import { McpServerRegistration } from '../registry/mcp-registry.schema';
import { canonicalizeArgs } from '../permissions/mcp-permission.policy';

/** Data required to create an MCP ApprovalRequest row in Prisma. */
export interface McpApprovalData {
  actionRequestId: string;
  actionType: 'mcp.tool_call';
  riskLevel: string;
  title: string;
  rationale: string;
  commandJson: string;
  filesJson: string;
  expectedEffect: string;
}

/**
 * Map an MCP permission decision to the data needed to create an ApprovalRequest.
 *
 * commandJson uses canonicalizeArgs([serverId, toolName]) — identical to the
 * fingerprint written by McpPermissionService.assess() in its denied-replay check,
 * ensuring the two lookups compare the same string.
 *
 * filesJson uses canonicalizeArgs(sanitizedArgs) — deep-sorted so semantically
 * equivalent argument objects produce the same fingerprint regardless of key order.
 *
 * expectedEffect carries the MCP-specific card context as a JSON object so the
 * controller can render server name, tool name, permission level, and risk level
 * without parsing commandJson or filesJson.
 */
export function buildMcpApprovalData(
  decision: McpPermissionDecision,
  server: McpServerRegistration,
  sanitizedArgs: Record<string, unknown>
): McpApprovalData {
  const riskLevel = decision.toolRisk ?? 'append';
  return {
    actionRequestId: randomUUID(),
    actionType: 'mcp.tool_call',
    riskLevel,
    title: `${server.displayName}: ${decision.toolName}`,
    rationale: `Tool '${decision.toolName}' with risk '${riskLevel}' requires explicit approval on a '${decision.declaredPermission ?? 'unknown'}' server.`,
    commandJson: canonicalizeArgs([decision.serverId, decision.toolName]),
    filesJson: canonicalizeArgs(sanitizedArgs),
    expectedEffect: JSON.stringify({
      mcpServerId: decision.serverId,
      mcpServerDisplayName: server.displayName,
      mcpToolName: decision.toolName,
      permissionLevel: decision.declaredPermission,
      toolRisk: riskLevel
    })
  };
}
