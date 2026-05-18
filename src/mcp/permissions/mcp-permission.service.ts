import { Injectable } from '@nestjs/common';
import { McpRegistryService } from '../registry/mcp-registry.service';
import { AuditLogService } from '../../features/audit/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { McpPermissionDecision, McpPermissionContext } from './mcp-permission.types';
import { computePermissionDecision, sanitizeToolArguments } from './mcp-permission.policy';

/**
 * Classifies MCP tool calls against the Phase 5 permission ladder.
 *
 * This service is a CLASSIFIER ONLY — it never creates approval records.
 * Callers receive the decision and are responsible for creating ApprovalRequest
 * records when the outcome is `needs_approval`.
 */
@Injectable()
export class McpPermissionService {
  constructor(
    private readonly registry: McpRegistryService,
    private readonly audit: AuditLogService,
    private readonly prisma: PrismaService
  ) {}

  /**
   * Assess whether a tool call is allowed, requires approval, or is blocked.
   *
   * Decision order (fail-safe):
   *   1. Unknown server/tool → blocked(undeclared_tool)
   *   2. admin permission level → blocked(admin_blocked)
   *   3. Blocked tool risk (destructive/secret_sensitive) → blocked(blocked_tool_risk)
   *   4. Permission ceiling exceeded → blocked(permission_ceiling_exceeded)
   *   5. Prior denial replay → blocked(denied_replay)
   *   6. Read tool → auto_allow
   *   7. Append/write tool → needs_approval
   */
  async assess(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    context?: McpPermissionContext
  ): Promise<McpPermissionDecision> {
    const sanitizedArgs = sanitizeToolArguments(args);

    const server = await this.registry.findServer(serverId);

    if (!server) {
      const decision: McpPermissionDecision = {
        decision: 'blocked',
        reasonCode: 'undeclared_tool',
        serverId,
        toolName,
        declaredPermission: 'read_only',
        toolRisk: null,
        ruleMatched: 'unknown_server'
      };
      await this.writeAudit(decision, sanitizedArgs, context);
      return decision;
    }

    const decision = computePermissionDecision(server, toolName);

    // Denied-replay check: only relevant when the base decision would proceed to approval.
    // Block early if the exact same call was previously denied/expired/refused.
    if (decision.decision === 'needs_approval') {
      const commandJson = JSON.stringify([serverId, toolName]);
      const filesJson = JSON.stringify(sanitizedArgs);

      const priorDenial = await this.prisma.approvalRequest.findFirst({
        where: {
          actionType: 'mcp.tool_call',
          status: { in: ['denied', 'expired', 'refused'] },
          commandJson,
          filesJson
        },
        orderBy: { requestedAt: 'desc' }
      });

      if (priorDenial) {
        const replayDecision: McpPermissionDecision = {
          ...decision,
          decision: 'blocked',
          reasonCode: 'denied_replay',
          ruleMatched: `denied_replay:${priorDenial.id}`
        };
        await this.writeAudit(replayDecision, sanitizedArgs, context);
        return replayDecision;
      }
    }

    await this.writeAudit(decision, sanitizedArgs, context);
    return decision;
  }

  private async writeAudit(
    decision: McpPermissionDecision,
    sanitizedArgs: Record<string, unknown>,
    context?: McpPermissionContext
  ): Promise<void> {
    await this.audit.append({
      taskId: context?.taskId,
      sessionId: context?.sessionId,
      kind: 'mcp.permission',
      actionType: 'mcp.tool_call',
      riskLevel: decision.toolRisk ?? undefined,
      ruleMatched: decision.ruleMatched,
      decision: decision.decision,
      message: `MCP permission assessment: ${decision.decision} [${decision.reasonCode}] server=${decision.serverId} tool=${decision.toolName}`,
      metadata: {
        serverId: decision.serverId,
        toolName: decision.toolName,
        declaredPermission: decision.declaredPermission,
        toolRisk: decision.toolRisk,
        reasonCode: decision.reasonCode,
        sanitizedArgs
      }
    });
  }
}
