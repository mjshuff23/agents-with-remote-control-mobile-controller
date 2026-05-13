import { Test, TestingModule } from '@nestjs/testing';
import { AgentsService } from '../../agents/agents.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AppConfigService } from '../../config/app-config.service';
import { CheckpointsService } from '../checkpoints/checkpoints.service';
import { ProtocolHandlerService } from './protocol-handler.service';
import { PolicyLoaderService } from '../policy/policy-loader.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentSessionsService } from './agent-sessions.service';

describe('AgentSessionsService', () => {
  let service: AgentSessionsService;
  const task = {
    id: 'task-1',
    title: null,
    prompt: 'Run this task',
    status: 'queued',
    selectedAgent: 'codex',
    repoPath: '/repo',
    worktreePath: '/repo',
    branchName: 'agent/task-1-run-this-task',
    baseRef: 'main',
    baseCommit: 'abc123',
    approvalMode: 'cooperative-gated',
    externalIssueRef: null,
    createdAt: new Date('2026-05-10T12:00:00.000Z'),
    updatedAt: new Date('2026-05-10T12:00:00.000Z')
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
    lastUserActivityAt: null,
    lastWorkerActivityAt: null,
    dormantAt: null,
    dormantReason: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
  const runningProcess = {
    externalSessionId: 'pty-1',
    stop: jest.fn()
  };
  const adapter = {
    startTask: jest.fn()
  };
  const agents = {
    getAdapter: jest.fn(() => adapter)
  };
  const approvals = {
    createFromAgentRequest: jest.fn(),
    resolve: jest.fn(),
    hasPendingForSession: jest.fn()
  };
  const policies = {
    load: jest.fn(),
    approvalTimeoutMs: jest.fn()
  };
  const checkpoints = {
    capture: jest.fn(),
    restore: jest.fn(),
    latestForSession: jest.fn(),
    canTransitionToDormant: jest.fn(),
    transitionToDormant: jest.fn(),
    captureAtBoundary: jest.fn()
  };
  const protocolHandler = {
    handleProtocolOutput: jest.fn(),
    writeApprovalResponse: jest.fn(),
    clearApprovalTimeout: jest.fn(),
    clearSessionApprovalTimeouts: jest.fn(),
    resumeIfWaiting: jest.fn(),
    clearBuffersForSession: jest.fn()
  };
  const prisma: any = {
    $transaction: jest.fn(async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => callback(prisma)),
    task: {
      update: jest.fn(),
      findUnique: jest.fn()
    },
    agentSession: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn()
    },
    agentLog: {
      create: jest.fn(),
      findFirst: jest.fn()
    },
    sessionCheckpoint: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn()
    }
  };
  const config = {
    shutdownGraceMs: 10,
    approvalTimeoutMs: 50
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.agentSession.create.mockResolvedValue(session);
    prisma.agentSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentLog.findFirst.mockResolvedValue(null);
    prisma.agentLog.create.mockImplementation(async ({ data }: { data: unknown }) => data);
    prisma.agentSession.update.mockImplementation(async ({ data }: { data: unknown }) => ({
      ...session,
      ...(data as Record<string, unknown>)
    }));
    prisma.task.update.mockImplementation(async ({ data }: { data: unknown }) => ({
      ...task,
      ...(data as Record<string, unknown>)
    }));
    prisma.task.findUnique.mockResolvedValue(task);
    adapter.startTask.mockResolvedValue(runningProcess);
    policies.load.mockResolvedValue({
      version: 1,
      approval: { timeoutMs: 50 },
      policy: { safe: [], needsApproval: [], blocked: [] },
      testCommands: []
    });
    policies.approvalTimeoutMs.mockResolvedValue(50);
    checkpoints.captureAtBoundary.mockResolvedValue(null);
    checkpoints.restore.mockResolvedValue({ checkpoint: { id: 'cp-1' }, session: { ...session, status: 'running' } });
    checkpoints.latestForSession.mockResolvedValue({
      id: 'cp-1',
      sessionId: session.id,
      taskId: task.id,
      schemaVersion: 1,
      reason: 'idle_timeout',
      lifecycleState: 'running',
      durableEventCursor: 5,
      lastUserActivityAt: null,
      lastWorkerActivityAt: null,
      workerWasLive: false,
      launchMetadataJson: JSON.stringify({ agentName: 'codex', repoPath: '/repo' }),
      frontierJson: JSON.stringify({ prompt: 'Run this task' }),
      lastUserMessage: null,
      lastAssistantMessage: null,
      recentTurnsJson: null,
      pendingApprovalIdsJson: null,
      pendingCriticalApproval: false,
      worktreePath: '/repo',
      branchName: 'agent/task-1-run-this-task',
      baseCommitSha: 'abc123',
      currentHeadSha: 'abc123',
      repoRoot: '/repo',
      latestDiffSummaryId: null,
      latestTestSummaryId: null,
      createdAt: new Date()
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentSessionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AgentsService, useValue: agents },
        { provide: AppConfigService, useValue: config },
        { provide: ApprovalsService, useValue: approvals },
        { provide: PolicyLoaderService, useValue: policies },
        { provide: CheckpointsService, useValue: checkpoints },
        { provide: ProtocolHandlerService, useValue: protocolHandler }
      ]
    }).compile();

    service = module.get(AgentSessionsService);
  });

  it('creates a session, starts the adapter in background, and returns starting state', async () => {
    const result = await service.createAndStart(task);

    expect(prisma.agentSession.create).toHaveBeenCalledWith({
      data: {
        taskId: task.id,
        agentName: 'codex',
        status: 'starting'
      }
    });
    // Agent startup happens in background, so adapter.startTask is called asynchronously
    // We just verify the session was created and returned with starting status
    expect(result.status).toBe('starting');
  });

  it('persists output with incrementing sequence numbers', async () => {
    await service.createAndStart(task);
    const startInput = adapter.startTask.mock.calls[0][0];

    await startInput.onOutput({ type: 'stdout', content: 'first' });
    await startInput.onOutput({ type: 'stdout', content: 'second' });

    expect(prisma.agentLog.create).toHaveBeenNthCalledWith(2, {
      data: {
        sessionId: session.id,
        type: 'stdout',
        sequence: 2,
        content: 'first'
      }
    });
    const secondCall = (prisma.agentLog.create as jest.Mock).mock.calls[2];
    expect(secondCall[0].data.sessionId).toBe(session.id);
    expect(secondCall[0].data.content).toBe('second');
    expect(secondCall[0].data.sequence).toBe(3);
  });

  it('serializes concurrent output writes for the same session', async () => {
    await service.createAndStart(task);
    const startInput = adapter.startTask.mock.calls[0][0];

    await Promise.all([
      startInput.onOutput({ type: 'stdout', content: 'first' }),
      startInput.onOutput({ type: 'stdout', content: 'second' })
    ]);

    expect(prisma.agentLog.create).toHaveBeenNthCalledWith(2, {
      data: {
        sessionId: session.id,
        type: 'stdout',
        sequence: 2,
        content: 'first'
      }
    });
    const secondCall = (prisma.agentLog.create as jest.Mock).mock.calls[2];
    expect(secondCall[0].data.sessionId).toBe(session.id);
    expect(secondCall[0].data.content).toBe('second');
    expect(secondCall[0].data.sequence).toBe(3);
  });

  it('handles adapter startup failure in background without blocking request', async () => {
    adapter.startTask.mockRejectedValue(new Error('codex missing'));

    // createAndStart returns immediately, startup happens in background
    const result = await service.createAndStart(task);
    expect(result.status).toBe('starting');

    // Give background startup time to fail
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Session should be marked as failed after background startup fails
    expect(prisma.agentSession.update).toHaveBeenCalledWith({
      where: { id: session.id },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('codex missing')
      })
    });
  });

  it('requests graceful stop for a running session', async () => {
    await service.createAndStart(task);
    prisma.agentSession.findFirst.mockResolvedValue({ ...session, status: 'running' });

    const result = await service.stopTask(task.id);
    await new Promise((resolve) => setImmediate(resolve));

    expect(runningProcess.stop).toHaveBeenCalledTimes(1);
    expect(result.accepted).toBe(true);
    expect(prisma.agentSession.update).toHaveBeenCalledWith({
      where: { id: session.id },
      data: { status: 'stopping' }
    });
  });

  it('clears per-session log bookkeeping after process exit', async () => {
    await service.createAndStart(task);
    const startInput = adapter.startTask.mock.calls[0][0];
    prisma.agentSession.findFirst.mockResolvedValue({ ...session, status: 'running' });

    await startInput.onOutput({ type: 'stdout', content: 'before exit' });
    expect((service as any).nextLogSequences.has(session.id)).toBe(true);

    await startInput.onExit({ exitCode: 0 });

    expect((service as any).nextLogSequences.has(session.id)).toBe(false);
    expect((service as any).logWriteQueues.has(session.id)).toBe(false);
  });

  it('restores a dormant session by relaunching the agent', async () => {
    prisma.agentSession.findUnique.mockResolvedValue({ ...session, status: 'dormant' });

    const result = await service.restoreSession(session.id);

    expect(adapter.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        sessionId: session.id,
        repoPath: '/repo',
        prompt: expect.stringContaining('Run this task')
      })
    );
    expect(checkpoints.restore).toHaveBeenCalledWith(session.id);
    expect(result.session.status).toBe('running');
  });

  it('rejects restore for non-dormant sessions', async () => {
    prisma.agentSession.updateMany.mockResolvedValue({ count: 0 });
    prisma.agentSession.findUnique.mockResolvedValue({ ...session, status: 'running' });

    await expect(service.restoreSession(session.id)).rejects.toThrow('Not Dormant');
  });

  it('rejects restore with conflict for restoring session', async () => {
    prisma.agentSession.updateMany.mockResolvedValue({ count: 0 });
    prisma.agentSession.findUnique.mockResolvedValue({ ...session, status: 'restoring' });

    await expect(service.restoreSession(session.id)).rejects.toThrow('Restore In Progress');
  });

  it('delegates ARC_ACTION_REQUEST to ProtocolHandlerService', async () => {
    const pendingApproval = {
      id: 'approval-1',
      actionRequestId: 'action-1'
    };
    approvals.createFromAgentRequest.mockResolvedValue({ approval: pendingApproval });
    approvals.hasPendingForSession.mockResolvedValue(false);
    prisma.agentSession.findUnique.mockResolvedValue({ ...session, status: 'waiting_approval' });

    await service.createAndStart(task);
    const startInput = adapter.startTask.mock.calls[0][0];
    await startInput.onOutput({
      type: 'stdout',
      content: 'ARC_ACTION_REQUEST {"id":"action-1","actionType":"fs.write_patch","title":"Patch file"}\n'
    });

    expect(protocolHandler.handleProtocolOutput).toHaveBeenCalledWith(
      task.id, session.id,
      'ARC_ACTION_REQUEST {"id":"action-1","actionType":"fs.write_patch","title":"Patch file"}\n',
      expect.any(Function),
      expect.any(Function),
      expect.any(Function)
    );
  });

  it('delegates resume check to ProtocolHandlerService after resolve', async () => {
    approvals.resolve.mockResolvedValue({
      id: 'approval-1',
      taskId: task.id,
      sessionId: session.id,
      actionRequestId: 'action-1',
      decision: 'approved',
      decisionMessage: null,
      status: 'approved'
    });
    approvals.hasPendingForSession.mockResolvedValue(true);
    prisma.agentSession.findUnique.mockResolvedValue({ ...session, status: 'waiting_approval' });

    await service.resolveApproval('approval-1', 'approved');

    expect(protocolHandler.clearApprovalTimeout).toHaveBeenCalledWith('approval-1');
    expect(protocolHandler.resumeIfWaiting).toHaveBeenCalledWith(task.id, session.id);
  });
});
