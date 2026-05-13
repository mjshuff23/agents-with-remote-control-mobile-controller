import { Test, TestingModule } from '@nestjs/testing';
import { AgentSessionsService } from '../agent-sessions/agent-sessions.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AppConfigService } from '../../config/app-config.service';
import { GitDiffService } from '../worktrees/git-diff.service';
import { GitWorktreeService } from '../worktrees/git-worktree.service';
import { GitCommitService } from '../worktrees/git-commit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PolicyLoaderService } from '../policy/policy-loader.service';
import { TaskEventLedgerService } from '../../events/task-event-ledger.service';
import { TestRunnerService } from '../test-runs/test-runner.service';
import { TasksService } from './tasks.service';

describe('TasksService', () => {
  let service: TasksService;
  const task = {
    id: 'task-1',
    title: 'Demo',
    prompt: 'Say hello',
    status: 'queued',
    selectedAgent: 'codex',
    repoPath: '/repo',
    worktreePath: null,
    branchName: null,
    baseRef: null,
    baseCommit: null,
    approvalMode: 'cooperative-gated',
    externalIssueRef: null,
    createdAt: new Date('2026-05-10T12:00:00.000Z'),
    updatedAt: new Date('2026-05-10T12:00:00.000Z')
  };
  const worktreeTask = {
    ...task,
    repoPath: '/repo',
    worktreePath: '/repo/worktrees/task-1-demo',
    branchName: 'agent/task-1-demo',
    baseRef: 'main',
    baseCommit: 'abc123'
  };
  const runningTask = {
    ...worktreeTask,
    status: 'running',
    updatedAt: new Date('2026-05-10T12:00:01.000Z')
  };
  const session = {
    id: 'session-1',
    taskId: task.id,
    agentName: 'codex',
    status: 'starting',
    externalSessionId: null,
    startedAt: null,
    completedAt: null,
    exitCode: null,
    errorMessage: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
  const prisma: any = {
    task: {
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn()
    },
    agentSession: {
      findFirst: jest.fn()
    },
    agentLog: {
      findMany: jest.fn()
    },
    gitChangeSummary: {
      findMany: jest.fn()
    },
    testRunSummary: {
      findMany: jest.fn()
    },
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => callback(prisma))
  };
  const agentSessions = {
    createAndStart: jest.fn(),
    runtimeState: jest.fn()
  };
  const worktrees = {
    createForTask: jest.fn()
  };
  const approvals = {
    listForTask: jest.fn()
  };
  const diffs = {
    summarizeTask: jest.fn()
  };
  const tests = {
    runTaskCommand: jest.fn()
  };
  const policies = {
    listTestCommands: jest.fn()
  };
  const ledger = {
    latestSeq: jest.fn(),
    replay: jest.fn()
  };
  const config = {
    repoPath: '/repo',
    logTailLimit: 200
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    worktrees.createForTask.mockResolvedValue({
      repoPath: '/repo',
      worktreePath: '/repo/worktrees/task-1-demo',
      branchName: 'agent/task-1-demo',
      baseRef: 'main',
      baseCommit: 'abc123'
    });
    prisma.task.update.mockResolvedValue(worktreeTask);
    approvals.listForTask.mockResolvedValue({ approvals: [] });
    prisma.gitChangeSummary.findMany.mockResolvedValue([]);
    prisma.testRunSummary.findMany.mockResolvedValue([]);
    ledger.latestSeq.mockResolvedValue(0);
    ledger.replay.mockResolvedValue({ events: [], logs: [] });
    agentSessions.runtimeState.mockReturnValue({ processState: 'live_process', statusLabel: 'active' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: prisma },
        { provide: AgentSessionsService, useValue: agentSessions },
        { provide: AppConfigService, useValue: config },
        { provide: GitWorktreeService, useValue: worktrees },
        { provide: ApprovalsService, useValue: approvals },
        { provide: GitDiffService, useValue: diffs },
        { provide: TestRunnerService, useValue: tests },
        { provide: PolicyLoaderService, useValue: policies },
        { provide: TaskEventLedgerService, useValue: ledger },
        { provide: GitCommitService, useValue: { requestAndExecute: jest.fn() } }
      ]
    }).compile();

    service = module.get(TasksService);
  });

  it('creates a codex task against the configured repo path and returns the refreshed task status', async () => {
    prisma.task.create.mockResolvedValue(task);
    prisma.task.findUnique.mockResolvedValue(runningTask);
    agentSessions.createAndStart.mockResolvedValue(session);

    const result = await service.createTask({ prompt: 'Say hello', agent: 'codex', title: 'Demo' });

    expect(prisma.task.create).toHaveBeenCalledWith({
      data: {
        title: 'Demo',
        prompt: 'Say hello',
        status: 'queued',
        selectedAgent: 'codex',
        repoPath: '/repo',
        externalIssueRef: null,
      }
    });
    // Worktree setup happens in background, so these are called asynchronously
    // Task is returned immediately with null worktree fields
    expect(result.task.worktreePath).toBeNull();
    expect(result.task.branchName).toBeNull();
    expect(result.task.baseRef).toBeNull();
    expect(result.task.baseCommit).toBeNull();
    expect(result.session).toBeDefined();
  });

  it('returns task details with the latest session and a bounded log tail', async () => {
    prisma.task.findUnique.mockResolvedValue(task);
    prisma.agentSession.findFirst.mockResolvedValue(session);
    prisma.agentLog.findMany.mockResolvedValue([
      {
        id: 'log-1',
        sessionId: session.id,
        type: 'stdout',
        sequence: 1,
        content: 'hello',
        createdAt: task.createdAt
      }
    ]);

    const result = await service.getTask(task.id);

    expect(prisma.agentLog.findMany).toHaveBeenCalledWith({
      where: { sessionId: session.id },
      orderBy: { sequence: 'desc' },
      take: 200
    });
    expect(result.logs).toEqual([
      expect.objectContaining({ sequence: 1, content: 'hello' })
    ]);
    expect(result.runtime).toEqual({ processState: 'live_process', statusLabel: 'active' });
    expect(result.eventCursor).toBe(0);
  });
});
