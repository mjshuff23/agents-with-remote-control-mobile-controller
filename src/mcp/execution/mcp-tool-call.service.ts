import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../features/audit/audit-log.service';
import { EventsGateway } from '../../events/events.gateway';
import { AppConfigService } from '../../config/app-config.service';
import { McpPermissionService } from '../permissions/mcp-permission.service';
import { McpRegistryService } from '../registry/mcp-registry.service';
import { McpTransportFactory } from '../transport/mcp-transport.factory';
import { sanitizeToolArguments } from '../permissions/mcp-permission.policy';
import { buildMcpApprovalData } from './mcp-approval.mapper';

export interface McpToolCallRequest {
  taskId: string;
  sessionId: string;
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export type McpToolCallOutcome = 'auto_allow' | 'blocked' | 'approved' | 'denied' | 'expired';

export interface McpToolCallResult {
  outcome: McpToolCallOutcome;
  approvalId?: string;
  toolResult?: unknown;
  error?: string;
}

/**
 * Orchestrates the full MCP tool-call pipeline:
 *
 *   1. Assess permission via McpPermissionService (TSH-114).
 *   2a. blocked   → return immediately, no ApprovalRequest created.
 *   2b. auto_allow → execute transport directly (read tools only).
 *   2c. needs_approval → create ApprovalRequest, emit approval card, poll for decision.
 *        approved  → execute transport, return result.
 *        denied    → return denied, transport never called.
 *        expired   → return expired, transport never called.
 *
 * This service is the bridge between the classifier (McpPermissionService) and
 * the approval lifecycle. It uses PrismaService directly so that commandJson /
 * filesJson fingerprints match exactly the format written by McpPermissionService,
 * preserving the denied-replay guard introduced in TSH-114.
 */
@Injectable()
export class McpToolCallService {
  constructor(
    private readonly permission: McpPermissionService,
    private readonly registry: McpRegistryService,
    private readonly transport: McpTransportFactory,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: EventsGateway,
    private readonly config: AppConfigService
  ) {}

  async execute(request: McpToolCallRequest): Promise<McpToolCallResult> {
    const { taskId, sessionId, serverId, toolName, args } = request;
    const sanitizedArgs = sanitizeToolArguments(args);

    const decision = await this.permission.assess(serverId, toolName, args, { taskId, sessionId });

    if (decision.decision === 'blocked') {
      return { outcome: 'blocked', error: decision.reasonCode };
    }

    if (decision.decision === 'auto_allow') {
      const execResult = await this.callTransport(serverId, toolName, args);
      return { outcome: 'auto_allow', ...execResult };
    }

    // needs_approval: create the approval card and wait for a human decision.
    const server = await this.registry.findServer(serverId);
    if (!server) {
      return { outcome: 'blocked', error: 'server_not_found' };
    }

    const approvalData = buildMcpApprovalData(decision, server, sanitizedArgs);
    const expiresAt = new Date(Date.now() + this.config.approvalTimeoutMs);

    const approval = await this.prisma.approvalRequest.create({
      data: {
        taskId,
        sessionId,
        ...approvalData,
        status: 'pending',
        expiresAt,
        correlationId: approvalData.actionRequestId
      }
    });

    await this.audit.append({
      taskId,
      sessionId,
      approvalRequestId: approval.id,
      kind: 'mcp.approval_requested',
      actionType: 'mcp.tool_call',
      riskLevel: decision.toolRisk ?? undefined,
      ruleMatched: decision.ruleMatched,
      message: `MCP approval requested: ${server.displayName}:${toolName}`,
      metadata: { serverId, toolName, sanitizedArgs }
    });

    await this.events.emitEnvelopeToTask(taskId, 'approval.requested', 'approval', 'warn', approval, {
      sessionId,
      correlationId: approvalData.actionRequestId
    });

    const resolved = await this.pollForDecision(approval.id, expiresAt);
    const outcome = resolved.status === 'approved' ? 'approved' : resolved.status === 'expired' ? 'expired' : 'denied';

    await this.audit.append({
      taskId,
      sessionId,
      approvalRequestId: approval.id,
      kind: 'mcp.approval_resolved',
      actionType: 'mcp.tool_call',
      riskLevel: decision.toolRisk ?? undefined,
      ruleMatched: decision.ruleMatched,
      decision: outcome,
      message: `MCP approval ${outcome}: ${server.displayName}:${toolName}`
    });

    if (outcome !== 'approved') {
      return { outcome, approvalId: approval.id };
    }

    const execResult = await this.callTransport(serverId, toolName, args);
    return { outcome: 'approved', approvalId: approval.id, ...execResult };
  }

  /** Poll prisma until the approval reaches a terminal status or the deadline passes. */
  private async pollForDecision(
    approvalId: string,
    expiresAt: Date,
    pollIntervalMs = 500
  ): Promise<{ status: string }> {
    // Allow a small buffer beyond expiresAt so a human approval recorded at the
    // last moment isn't discarded before we see it.
    const deadline = expiresAt.getTime() + 5000;

    while (Date.now() < deadline) {
      const record = await this.prisma.approvalRequest.findUnique({ where: { id: approvalId } });
      if (!record || record.status !== 'pending') {
        return { status: record?.status ?? 'expired' };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Deadline passed with no human decision — mark the row expired so
    // denied-replay detection sees a terminal status rather than stale pending.
    await this.prisma.approvalRequest.update({
      where: { id: approvalId },
      data: { status: 'expired' }
    });
    return { status: 'expired' };
  }

  /** Connect to the MCP transport, execute the tool call, and disconnect. */
  private async callTransport(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ toolResult?: unknown; error?: string }> {
    const server = await this.registry.findServer(serverId);
    if (!server) {
      return { error: 'server_not_found' };
    }
    const client = this.transport.create(server.transport);
    try {
      await client.connect();
      const toolResult = await client.callTool(toolName, args);
      return { toolResult };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
