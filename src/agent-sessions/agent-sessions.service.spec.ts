import { Test, TestingModule } from '@nestjs/testing';
import { AgentsService } from '../agents/agents.service';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
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
  const prisma = {
    task: {
      update: jest.fn()
    },
    agentSession: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn()
    },
    agentLog: {
      create: jest.fn(),
      findFirst: jest.fn()
    }
  };
  const config = {
    shutdownGraceMs: 10
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.agentSession.create.mockResolvedValue(session);
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
    adapter.startTask.mockResolvedValue(runningProcess);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentSessionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AgentsService, useValue: agents },
        { provide: AppConfigService, useValue: config }
      ]
    }).compile();

    service = module.get(AgentSessionsService);
  });

  it('creates a session, starts the adapter, and records running state', async () => {
    const result = await service.createAndStart(task);

    expect(prisma.agentSession.create).toHaveBeenCalledWith({
      data: {
        taskId: task.id,
        agentName: 'codex',
        status: 'starting'
      }
    });
    expect(adapter.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        sessionId: session.id,
        repoPath: '/repo',
        prompt: 'Run this task'
      })
    );
    expect(prisma.agentSession.update).toHaveBeenCalledWith({
      where: { id: session.id },
      data: expect.objectContaining({
        status: 'running',
        externalSessionId: 'pty-1'
      })
    });
    expect(result.status).toBe('running');
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
    expect(prisma.agentLog.create).toHaveBeenNthCalledWith(3, {
      data: {
        sessionId: session.id,
        type: 'stdout',
        sequence: 3,
        content: 'second'
      }
    });
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
    expect(prisma.agentLog.create).toHaveBeenNthCalledWith(3, {
      data: {
        sessionId: session.id,
        type: 'stdout',
        sequence: 3,
        content: 'second'
      }
    });
  });

  it('marks the session and task failed when adapter startup fails', async () => {
    adapter.startTask.mockRejectedValue(new Error('codex missing'));

    await expect(service.createAndStart(task)).rejects.toThrow('Codex agent could not be started');

    expect(prisma.agentSession.update).toHaveBeenCalledWith({
      where: { id: session.id },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: 'codex missing'
      })
    });
    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: task.id },
      data: { status: 'failed' }
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
});
