import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { SyncEventService } from '../sync/sync-event.service';

export interface ApprovalAuditSyncInput {
  taskId: string;
  sessionId?: string;
  actionType: string;
  riskLevel: string;
  decision: 'approved' | 'denied' | 'expired' | 'refused';
  decisionMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface ActionExecutedInput {
  taskId: string;
  sessionId?: string;
  actionType: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface SyncEventCompletedInput {
  taskId: string;
  sessionId?: string;
  provider: string;
  action: string;
  targetId: string;
  externalId?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface SyncEventFailedInput {
  taskId: string;
  sessionId?: string;
  provider: string;
  action: string;
  targetId: string;
  errorCategory: string;
  errorMessage: string;
  metadata?: Record<string, unknown>;
}

/**
 * Orchestrates the relationship between approvals, audit logs, and sync events.
 * Ensures all provider actions are approval-gated and audit-logged.
 */
@Injectable()
export class ApprovalAuditSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly syncEvent: SyncEventService,
  ) {}

  /**
   * Record an approval decision and create corresponding audit entry.
   */
  async recordApprovalDecision(input: ApprovalAuditSyncInput): Promise<void> {
    const { taskId, sessionId, actionType, decision, decisionMessage, metadata } = input;

    // Create audit log entry for the decision
    await this.auditLog.append({
      taskId,
      sessionId,
      kind: 'approval_decision',
      actionType,
      decision,
      message: decisionMessage || `Approval ${decision}`,
      metadata,
    });
  }

  /**
   * Record an action execution and create corresponding audit entry.
   */
  async recordActionExecuted(input: ActionExecutedInput): Promise<void> {
    const { taskId, sessionId, actionType, message, metadata } = input;

    await this.auditLog.append({
      taskId,
      sessionId,
      kind: 'action_executed',
      actionType,
      message,
      metadata,
    });
  }

  /**
   * Record a successful sync event and create corresponding audit entry.
   */
  async recordSyncEventCompleted(input: SyncEventCompletedInput): Promise<void> {
    const { taskId, sessionId, provider, action, targetId, externalId, url, metadata } = input;

    // Create or reuse SyncEvent
    const syncEventRecord = await this.syncEvent.createOrReuse({
      taskId,
      sessionId,
      provider,
      action,
      targetId,
    });

    // Mark as succeeded with external ID and URL
    await this.syncEvent.markSucceeded(syncEventRecord.id, externalId, url);

    // Create audit log entry
    await this.auditLog.append({
      taskId,
      sessionId,
      kind: 'sync_event_completed',
      actionType: `provider.${provider}`,
      message: `${provider} ${action} completed: ${externalId || targetId}`,
      metadata: { ...(metadata ?? {}), externalId, url },
    });
  }

  /**
   * Record a failed sync event and create corresponding audit entry.
   */
  async recordSyncEventFailed(input: SyncEventFailedInput): Promise<void> {
    const { taskId, sessionId, provider, action, targetId, errorCategory, errorMessage, metadata } = input;

    // Create or reuse SyncEvent
    const syncEventRecord = await this.syncEvent.createOrReuse({
      taskId,
      sessionId,
      provider,
      action,
      targetId,
    });

    // Mark as failed with error details
    await this.syncEvent.markFailed(syncEventRecord.id, errorCategory, errorMessage);

    // Create audit log entry
    await this.auditLog.append({
      taskId,
      sessionId,
      kind: 'sync_event_failed',
      actionType: `provider.${provider}`,
      message: `${provider} ${action} failed: ${errorMessage}`,
      metadata: { ...(metadata ?? {}), errorCategory, errorMessage },
    });
  }

  /**
   * Get the approval/sync timeline for a task.
   * Returns all approval requests, audit logs, and sync events merged into a
   * single list ordered by createdAt ascending.
   */
  async getTaskTimeline(taskId: string): Promise<
    Array<
      | { type: 'approval'; id: string; actionType: string; status: string; decision?: string | null; createdAt: Date }
      | { type: 'audit'; id: string; kind: string; actionType?: string | null; message: string; createdAt: Date }
      | { type: 'sync'; id: string; provider: string; action: string; status: string; externalId?: string | null; createdAt: Date }
    >
  > {
    const [approvals, auditLogs, syncEvents] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where: { taskId },
        select: { id: true, actionType: true, status: true, decision: true, createdAt: true },
      }),
      this.prisma.auditLog.findMany({
        where: { taskId },
        select: { id: true, kind: true, actionType: true, message: true, createdAt: true },
      }),
      this.prisma.syncEvent.findMany({
        where: { taskId },
        select: { id: true, provider: true, action: true, status: true, externalId: true, createdAt: true },
      }),
    ]);

    return [
      ...approvals.map((a) => ({ type: 'approval' as const, ...a })),
      ...auditLogs.map((a) => ({ type: 'audit' as const, ...a })),
      ...syncEvents.map((s) => ({ type: 'sync' as const, ...s })),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
}
