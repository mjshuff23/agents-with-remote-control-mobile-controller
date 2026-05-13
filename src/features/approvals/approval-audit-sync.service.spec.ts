import { Test } from '@nestjs/testing';
import { ApprovalAuditSyncService } from './approval-audit-sync.service';
import { AuditLogService } from '../audit/audit-log.service';
import { SyncEventService } from '../sync/sync-event.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('ApprovalAuditSyncService', () => {
  let service: ApprovalAuditSyncService;
  let auditLog: jest.Mocked<AuditLogService>;
  let syncEvent: jest.Mocked<SyncEventService>;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ApprovalAuditSyncService,
        {
          provide: AuditLogService,
          useValue: { append: jest.fn() },
        },
        {
          provide: SyncEventService,
          useValue: { 
            createOrReuse: jest.fn(),
            markRunning: jest.fn(),
            markSucceeded: jest.fn(),
            markFailed: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            approvalRequest: { findMany: jest.fn() },
            auditLog: { findMany: jest.fn() },
            syncEvent: { findMany: jest.fn() },
          },
        },
      ],
    }).compile();

    service = module.get(ApprovalAuditSyncService);
    auditLog = module.get(AuditLogService) as jest.Mocked<AuditLogService>;
    syncEvent = module.get(SyncEventService) as jest.Mocked<SyncEventService>;
    prisma = module.get(PrismaService) as jest.Mocked<PrismaService>;
  });

  describe('recordApprovalDecision', () => {
    it('creates audit log entry for approval decision', async () => {
      await service.recordApprovalDecision({
        taskId: 'task-1',
        sessionId: 'session-1',
        actionType: 'git.commit',
        riskLevel: 'NEEDS_APPROVAL',
        decision: 'approved',
        decisionMessage: 'Looks good',
      });

      expect(auditLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          sessionId: 'session-1',
          kind: 'approval_decision',
          actionType: 'git.commit',
          decision: 'approved',
          message: 'Looks good',
        }),
      );
    });

    it('handles denied approval', async () => {
      await service.recordApprovalDecision({
        taskId: 'task-1',
        actionType: 'git.push',
        riskLevel: 'NEEDS_APPROVAL',
        decision: 'denied',
        decisionMessage: 'Not ready yet',
      });

      expect(auditLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'denied',
          message: 'Not ready yet',
        }),
      );
    });
  });

  describe('recordActionExecuted', () => {
    it('creates audit log entry for executed action', async () => {
      await service.recordActionExecuted({
        taskId: 'task-1',
        sessionId: 'session-1',
        actionType: 'git.commit',
        message: 'Commit SHA: abc123def456',
        metadata: { sha: 'abc123def456' },
      });

      expect(auditLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          sessionId: 'session-1',
          kind: 'action_executed',
          actionType: 'git.commit',
          message: 'Commit SHA: abc123def456',
        }),
      );
    });
  });

  describe('recordSyncEventCompleted', () => {
    it('creates sync event and audit log for successful provider action', async () => {
      const mockSyncEvent = { id: 'sync-1', status: 'pending' };
      (syncEvent.createOrReuse as jest.Mock).mockResolvedValue(mockSyncEvent);

      await service.recordSyncEventCompleted({
        taskId: 'task-1',
        sessionId: 'session-1',
        provider: 'github',
        action: 'create_pr',
        targetId: 'pr-target-1',
        externalId: 'PR#123',
        url: 'https://github.com/org/repo/pull/123',
      });

      expect(syncEvent.createOrReuse).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          sessionId: 'session-1',
          provider: 'github',
          action: 'create_pr',
          targetId: 'pr-target-1',
        }),
      );

      expect(syncEvent.markSucceeded).toHaveBeenCalledWith('sync-1', 'PR#123', 'https://github.com/org/repo/pull/123');

      expect(auditLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          kind: 'sync_event_completed',
          actionType: 'provider.github',
        }),
      );
    });

    it('handles Linear status update', async () => {
      const mockSyncEvent = { id: 'sync-2', status: 'pending' };
      (syncEvent.createOrReuse as jest.Mock).mockResolvedValue(mockSyncEvent);

      await service.recordSyncEventCompleted({
        taskId: 'task-1',
        provider: 'linear',
        action: 'update_status',
        targetId: 'issue-456',
        externalId: 'TSH-108',
      });

      expect(syncEvent.createOrReuse).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'linear',
          action: 'update_status',
        }),
      );

      expect(syncEvent.markSucceeded).toHaveBeenCalledWith('sync-2', 'TSH-108', undefined);
    });
  });

  describe('recordSyncEventFailed', () => {
    it('creates sync event and audit log for failed provider action', async () => {
      const mockSyncEvent = { id: 'sync-3', status: 'pending' };
      (syncEvent.createOrReuse as jest.Mock).mockResolvedValue(mockSyncEvent);

      await service.recordSyncEventFailed({
        taskId: 'task-1',
        sessionId: 'session-1',
        provider: 'github',
        action: 'create_pr',
        targetId: 'pr-target-1',
        errorCategory: 'auth_error',
        errorMessage: 'Invalid GitHub token',
      });

      expect(syncEvent.createOrReuse).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          provider: 'github',
          action: 'create_pr',
        }),
      );

      expect(syncEvent.markFailed).toHaveBeenCalledWith('sync-3', 'auth_error', 'Invalid GitHub token');

      expect(auditLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'sync_event_failed',
          actionType: 'provider.github',
        }),
      );
    });
  });

  describe('getTaskTimeline', () => {
    it('returns a single chronological list of approvals, audits, and sync events', async () => {
      const t1 = new Date('2024-01-01T00:00:00Z');
      const t2 = new Date('2024-01-01T00:01:00Z');
      const t3 = new Date('2024-01-01T00:02:00Z');

      (prisma.approvalRequest.findMany as jest.Mock).mockResolvedValue([
        { id: 'apr-1', actionType: 'git.commit', status: 'pending', decision: null, createdAt: t2 },
      ]);
      (prisma.auditLog.findMany as jest.Mock).mockResolvedValue([
        { id: 'aud-1', kind: 'approval_requested', actionType: 'git.commit', message: 'Approval requested', createdAt: t1 },
      ]);
      (prisma.syncEvent.findMany as jest.Mock).mockResolvedValue([
        { id: 'sync-1', provider: 'github', action: 'create_pr', status: 'completed', externalId: 'PR#123', createdAt: t3 },
      ]);

      const timeline = await service.getTaskTimeline('task-1');

      expect(timeline).toHaveLength(3);
      expect(timeline[0]).toMatchObject({ type: 'audit', id: 'aud-1' });
      expect(timeline[1]).toMatchObject({ type: 'approval', id: 'apr-1' });
      expect(timeline[2]).toMatchObject({ type: 'sync', id: 'sync-1' });
    });
  });
});
