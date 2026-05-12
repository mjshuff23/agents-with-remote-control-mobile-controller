import { Test, TestingModule } from '@nestjs/testing';
import { AuditLogService } from '../audit/audit-log.service';
import { AppConfigService } from '../config/app-config.service';
import { EventsGateway } from '../events/events.gateway';
import { TaskEventLedgerService } from '../events/task-event-ledger.service';
import { GitCommandService } from '../git/git-command.service';
import { PrismaService } from '../prisma/prisma.service';
import { CheckpointsService } from './checkpoints.service';

jest.mock('fs/promises', () => ({
  access: jest.fn().mockResolvedValue(undefined)
}));

describe('CheckpointsService', () => {
  let service: CheckpointsService;
  const now = new Date('2026-05-12T12:00:00.000Z');
  const recent = new Date(Date.now() - 60_000);
  const stale = new Date(Date.now() - 3_600_000);

  const runningSession = {
    id: 'session-1',
    taskId: 'task-1',
    agentName: 'codex',
    status: 'running',
    externalSessionId: null,
    startedAt: now,
    completedAt: null,
    exitCode: null,
    errorMessage: null,
    lastUserActivityAt: stale,
    lastWorkerActivityAt: stale,
    dormantAt: null,
    dormantReason: null,
    createdAt: now,
    updatedAt: now
  };

  const activeSession = {
    ...runningSession,
    lastUserActivityAt: recent,
    lastWorkerActivityAt: recent
  };

  const waitingApprovalSession = {
    ...runningSession,
    status: 'waiting_approval'
  };

  const dormantSession = {
    ...runningSession,
    status: 'dormant',
    dormantAt: now,
    dormantReason: 'idle_timeout'
  };

  const completedSession = {
    ...runningSession,
    status: 'completed',
    completedAt: now
  };

  const task = {
    id: 'task-1',
    title: 'Test task',
    prompt: 'Do something',
    status: 'running',
    selectedAgent: 'codex',
    repoPath: '/repo',
    worktreePath: '/repo/worktrees/task-1-test',
    branchName: 'agent/task-1-test',
    baseRef: 'main',
    baseCommit: 'abc123def456',
    approvalMode: 'cooperative-gated',
    createdAt: now,
    updatedAt: now
  };

  const checkpoint = {
    id: 'cp-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    schemaVersion: 1,
    reason: 'idle_timeout',
    lifecycleState: 'running',
    durableEventCursor: 5,
    lastUserActivityAt: stale,
    lastWorkerActivityAt: stale,
    workerWasLive: false,
    launchMetadataJson: '{}',
    frontierJson: '{"prompt":"Do something"}',
    lastUserMessage: null,
    lastAssistantMessage: null,
    recentTurnsJson: null,
    pendingApprovalIdsJson: null,
    pendingCriticalApproval: false,
    worktreePath: '/repo/worktrees/task-1-test',
    branchName: 'agent/task-1-test',
    baseCommitSha: 'abc123def456',
    currentHeadSha: 'abc123def456',
    repoRoot: '/repo',
    latestDiffSummaryId: null,
    latestTestSummaryId: null,
    createdAt: now
  };

  const audit = {
    append: jest.fn()
  };

  const events = {
    emitEnvelopeToTask: jest.fn()
  };

  const ledger = {
    latestSeq: jest.fn()
  };

  const gitCommands = {
    git: jest.fn()
  };

  const config = {
    dormantTimeoutMs: 1_800_000,
    dormantCheckIntervalMs: 60_000
  };

  const prisma: {
    $transaction: jest.Mock;
    sessionCheckpoint: Record<string, jest.Mock>;
    agentSession: Record<string, jest.Mock>;
    task: Record<string, jest.Mock>;
    approvalRequest: Record<string, jest.Mock>;
    gitChangeSummary: Record<string, jest.Mock>;
    testRunSummary: Record<string, jest.Mock>;
  } = {
    $transaction: jest.fn(),
    sessionCheckpoint: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn()
    },
    agentSession: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn()
    },
    task: {
      findUnique: jest.fn(),
      update: jest.fn()
    },
    approvalRequest: {
      findMany: jest.fn()
    },
    gitChangeSummary: {
      findFirst: jest.fn()
    },
    testRunSummary: {
      findFirst: jest.fn()
    }
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    ledger.latestSeq.mockResolvedValue(5);
    gitCommands.git.mockResolvedValue({ stdout: 'abc123def456\n', stderr: '' });
    prisma.sessionCheckpoint.create.mockResolvedValue(checkpoint);
    prisma.sessionCheckpoint.findFirst.mockResolvedValue(checkpoint);
    prisma.agentSession.findMany.mockResolvedValue([]);
    prisma.agentSession.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...runningSession,
      ...data
    }));
    prisma.task.findUnique.mockResolvedValue(task);
    prisma.task.update.mockResolvedValue(task);
    prisma.approvalRequest.findMany.mockResolvedValue([]);
    prisma.gitChangeSummary.findFirst.mockResolvedValue(null);
    prisma.testRunSummary.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckpointsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AppConfigService, useValue: config },
        { provide: TaskEventLedgerService, useValue: ledger },
        { provide: GitCommandService, useValue: gitCommands },
        { provide: EventsGateway, useValue: events },
        { provide: AuditLogService, useValue: audit }
      ]
    }).compile();

    service = module.get(CheckpointsService);
    service.stopDormancyChecker();
  });

  describe('canTransitionToDormant', () => {
    it('rejects if session is already terminal', async () => {
      const result = await service.canTransitionToDormant(completedSession as any);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('already');
    });

    it('rejects if session is already dormant', async () => {
      const result = await service.canTransitionToDormant(dormantSession as any);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('already');
    });

    it('rejects if session has pending approvals', async () => {
      const result = await service.canTransitionToDormant(waitingApprovalSession as any);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('pending approvals');
    });

    it('rejects if worker activity is too recent', async () => {
      const result = await service.canTransitionToDormant(activeSession as any);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Worker activity too recent');
    });

    it('allows when both activity timestamps are stale', async () => {
      const result = await service.canTransitionToDormant(runningSession as any);
      expect(result.allowed).toBe(true);
    });
  });

  describe('capture', () => {
    it('creates checkpoint with correct data', async () => {
      prisma.sessionCheckpoint.create.mockResolvedValue(checkpoint);

      const result = await service.capture({
        sessionId: 'session-1',
        taskId: 'task-1',
        reason: 'idle_timeout',
        lastUserActivityAt: stale,
        lastWorkerActivityAt: stale,
        workerWasLive: false,
        launchMetadata: { agentName: 'codex', repoPath: '/repo' },
        frontier: { prompt: 'Do something' },
        lastUserMessage: null,
        lastAssistantMessage: null,
        recentTurns: null,
        pendingApprovalIds: [],
        pendingCriticalApproval: false,
        worktreeInfo: {
          worktreePath: '/repo/worktrees/task-1-test',
          branchName: 'agent/task-1-test',
          baseCommitSha: 'abc123def456',
          currentHeadSha: 'abc123def456',
          repoRoot: '/repo'
        },
        latestDiffSummaryId: null,
        latestTestSummaryId: null
      });

      expect(prisma.sessionCheckpoint.create).toHaveBeenCalled();
      expect(result.id).toBe('cp-1');
    });
  });

  describe('transitionToDormant', () => {
    it('updates session and task to dormant', async () => {
      await service.transitionToDormant(runningSession as any, checkpoint as any);

      expect(prisma.agentSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: expect.objectContaining({ status: 'dormant', dormantReason: 'dormant_idle_timeout' })
      });
      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: { status: 'dormant' }
      });
      expect(events.emitEnvelopeToTask).toHaveBeenCalledWith(
        'task-1', 'session.dormant', 'lifecycle', 'info',
        expect.objectContaining({ sessionId: 'session-1', checkpointId: 'cp-1' }),
        { sessionId: 'session-1' }
      );
      expect(audit.append).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'lifecycle.dormancy', message: expect.stringContaining('dormant') })
      );
    });
  });

  describe('restore', () => {
    it('restores a dormant session to running', async () => {
      prisma.agentSession.findUnique.mockResolvedValue(dormantSession);

      const result = await service.restore('session-1');

      expect(prisma.agentSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: expect.objectContaining({ status: 'running', dormantAt: null })
      });
      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: { status: 'running' }
      });
      expect(events.emitEnvelopeToTask).toHaveBeenCalledWith(
        'task-1', 'session.restored', 'lifecycle', 'info',
        expect.objectContaining({ sessionId: 'session-1', restoreMode: 'relaunch' }),
        { sessionId: 'session-1' }
      );
      expect(result.session.status).toBe('running');
    });

    it('rejects non-dormant sessions', async () => {
      prisma.agentSession.findUnique.mockResolvedValue(runningSession);

      await expect(service.restore('session-1')).rejects.toThrow('Not Dormant');
    });

    it('rejects sessions with no checkpoint', async () => {
      prisma.agentSession.findUnique.mockResolvedValue(dormantSession);
      prisma.sessionCheckpoint.findFirst.mockResolvedValue(null);

      await expect(service.restore('session-1')).rejects.toThrow('No Checkpoint');
    });
  });

  describe('captureAtBoundary', () => {
    it('captures checkpoint at session_start boundary', async () => {
      prisma.agentSession.findUnique.mockResolvedValue(runningSession);
      prisma.sessionCheckpoint.create.mockResolvedValue(checkpoint);

      const result = await service.captureAtBoundary('session-1', 'task-1', 'session_start');

      expect(prisma.sessionCheckpoint.create).toHaveBeenCalled();
      expect(result).not.toBeNull();
    });

    it('returns null if session not found', async () => {
      prisma.agentSession.findUnique.mockResolvedValue(null);

      const result = await service.captureAtBoundary('nonexistent', 'task-1', 'session_start');
      expect(result).toBeNull();
    });
  });
});
