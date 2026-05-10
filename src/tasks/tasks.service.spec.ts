import { Test, TestingModule } from '@nestjs/testing';
import { AgentSessionsService } from '../agent-sessions/agent-sessions.service';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
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
    createdAt: new Date('2026-05-10T12:00:00.000Z'),
    updatedAt: new Date('2026-05-10T12:00:00.000Z')
  };
  const runningTask = {
    ...task,
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
      findMany: jest.fn(),
      findUnique: jest.fn()
    },
    agentSession: {
      findFirst: jest.fn()
    },
    agentLog: {
      findMany: jest.fn()
    },
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => callback(prisma))
  };
  const agentSessions = {
    createAndStart: jest.fn()
  };
  const config = {
    repoPath: '/repo',
    logTailLimit: 200
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: prisma },
        { provide: AgentSessionsService, useValue: agentSessions },
        { provide: AppConfigService, useValue: config }
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
        repoPath: '/repo'
      }
    });
    expect(agentSessions.createAndStart).toHaveBeenCalledWith(task);
    expect(prisma.task.findUnique).toHaveBeenCalledWith({ where: { id: task.id } });
    expect(result).toEqual({ task: runningTask, session });
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
  });
});
