import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsGateway } from '../../events/events.gateway';
import { AppConfigService } from '../../config/app-config.service';
import { McpPermissionService } from '../permissions/mcp-permission.service';
import { McpRegistryService } from '../registry/mcp-registry.service';
import { McpTransportFactory } from '../transport/mcp-transport.factory';
import { McpTransportClient } from '../transport/mcp-transport.types';
import { sanitizeToolArguments } from '../permissions/mcp-permission.policy';
import { buildMcpApprovalData } from './mcp-approval.mapper';
import { McpAuditService } from '../audit/mcp-audit.service';
import type { McpAuditErrorCategory, McpAuditOutcome } from '../audit/mcp-audit.types';

export interface McpToolCallRequest {
  taskId: string;
  sessionId: string;
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export type McpToolCallOutcome = 'auto_allow' | 'blocked' | 'approved' | 'denied' | 'expired' | 'failed';

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
 *   2a. blocked        → return immediately, no ApprovalRequest created.
 *   2b. auto_allow     → execute transport directly (read tools only).
 *   2c. needs_approval → create ApprovalRequest, emit approval card, poll for decision.
 *        approved  → execute transport, return result.
 *        denied    → return denied, transport never called.
 *        expired   → return expired, transport never called.
 *
 * McpAuditService.record() is called at every terminal branch (TSH-116).
 * The two legacy audit.append() calls have been replaced by structured McpAuditLog
 * rows. AuditLogService is no longer injected here — McpAuditService owns the shadow.
 */
@Injectable()
export class McpToolCallService {
  constructor(
    private readonly permission: McpPermissionService,
    private readonly registry: McpRegistryService,
    private readonly transport: McpTransportFactory,
    private readonly prisma: PrismaService,
    private readonly mcpAudit: McpAuditService,
    private readonly events: EventsGateway,
    private readonly config: AppConfigService
  ) {}

  async execute(request: McpToolCallRequest): Promise<McpToolCallResult> {
    const { taskId, sessionId, serverId, toolName, args } = request;
    const sanitizedArgs = sanitizeToolArguments(args);
    const startedAt = new Date();

    const decision = await this.permission.assess(serverId, toolName, args, { taskId, sessionId });

    if (decision.decision === 'blocked') {
      await this.mcpAudit.record({
        taskId,
        sessionId,
        serverId,
        serverDisplayName: serverId, // display name requires registry lookup; use serverId as fallback for blocked path
        toolName,
        permissionLevel: decision.declaredPermission,
        toolRisk: decision.toolRisk ?? undefined,
        outcome: 'blocked',
        args,
        startedAt,
        finishedAt: new Date(),
        errorCategory: undefined
      });
      return { outcome: 'blocked', error: decision.reasonCode };
    }

    if (decision.decision === 'auto_allow') {
      const execResult = await this.callTransport(serverId, toolName, args);
      const outcome: McpAuditOutcome = execResult.error ? 'failed' : 'auto_allow';
      const errorCategory = execResult.errorCategory;
      await this.mcpAudit.record({
        taskId,
        sessionId,
        serverId,
        serverDisplayName: serverId,
        toolName,
        permissionLevel: decision.declaredPermission,
        toolRisk: decision.toolRisk ?? undefined,
        outcome,
        args,
        result: execResult.toolResult,
        startedAt,
        finishedAt: new Date(),
        errorCategory
      });
      return { outcome, ...{ toolResult: execResult.toolResult, error: execResult.error } };
    }

    // needs_approval: create the approval card and wait for a human decision.
    const server = await this.registry.findServer(serverId);
    if (!server) {
      await this.mcpAudit.record({
        taskId,
        sessionId,
        serverId,
        serverDisplayName: serverId,
        toolName,
        permissionLevel: decision.declaredPermission,
        toolRisk: decision.toolRisk ?? undefined,
        outcome: 'blocked',
        args,
        startedAt,
        finishedAt: new Date(),
        errorCategory: undefined
      });
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

    await this.events.emitEnvelopeToTask(taskId, 'approval.requested', 'approval', 'warn', approval, {
      sessionId,
      correlationId: approvalData.actionRequestId
    });

    const resolved = await this.pollForDecision(approval.id, expiresAt);
    const approvalOutcome = resolved.status === 'approved' ? 'approved' : resolved.status === 'expired' ? 'expired' : 'denied';

    if (approvalOutcome !== 'approved') {
      await this.mcpAudit.record({
        taskId,
        sessionId,
        approvalRequestId: approval.id,
        serverId,
        serverDisplayName: server.displayName,
        toolName,
        permissionLevel: decision.declaredPermission,
        toolRisk: decision.toolRisk ?? undefined,
        outcome: approvalOutcome,
        args,
        startedAt,
        finishedAt: new Date()
      });
      return { outcome: approvalOutcome, approvalId: approval.id };
    }

    const execResult = await this.callTransport(serverId, toolName, args);
    const finalOutcome: McpAuditOutcome = execResult.error ? 'failed' : 'approved';
    await this.mcpAudit.record({
      taskId,
      sessionId,
      approvalRequestId: approval.id,
      serverId,
      serverDisplayName: server.displayName,
      toolName,
      permissionLevel: decision.declaredPermission,
      toolRisk: decision.toolRisk ?? undefined,
      outcome: finalOutcome,
      args,
      result: execResult.toolResult,
      startedAt,
      finishedAt: new Date(),
      errorCategory: execResult.errorCategory
    });

    return { outcome: finalOutcome, approvalId: approval.id, ...{ toolResult: execResult.toolResult, error: execResult.error } };
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
  ): Promise<{ toolResult?: unknown; error?: string; errorCategory?: McpAuditErrorCategory }> {
    const server = await this.registry.findServer(serverId);
    if (!server) {
      return { error: 'server_not_found', errorCategory: 'unknown' };
    }
    let client: McpTransportClient | undefined;
    try {
      client = this.transport.create(server.transport);
      await client.connect();
      const toolResult = await client.callTool(toolName, args);
      return { toolResult };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCategory: McpAuditErrorCategory = /timeout/i.test(message) ? 'timeout' : 'transport_error';
      return { error: message, errorCategory };
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
}
