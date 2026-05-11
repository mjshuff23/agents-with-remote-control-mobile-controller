import { mkdtemp, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TestRunnerService } from './test-runner.service';

describe('TestRunnerService', () => {
  let worktreePath: string;
  const prisma = {
    task: { findUnique: jest.fn() },
    agentSession: { findFirst: jest.fn() },
    testRunSummary: {
      create: jest.fn(),
      update: jest.fn()
    }
  };
  const policies = {
    getTestCommand: jest.fn()
  };
  const config = {
    testCommandTimeoutMs: 600000
  };
  const events = {
    emitEnvelopeToTask: jest.fn()
  };

  let service: TestRunnerService;

  beforeEach(async () => {
    worktreePath = await mkdtemp(path.join(os.tmpdir(), 'arc-test-runner-'));
    jest.clearAllMocks();
    service = new TestRunnerService(prisma as any, policies as any, config as any, events as any);
    prisma.task.findUnique.mockResolvedValue({
      id: 'task-1',
      worktreePath
    });
    prisma.agentSession.findFirst.mockResolvedValue({ id: 'session-1' });
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it('rejects unknown test command ids', async () => {
    policies.getTestCommand.mockResolvedValue(undefined);

    await expect(service.runTaskCommand('task-1', 'unknown')).rejects.toMatchObject({
      response: { status: 403 }
    });
    expect(prisma.testRunSummary.create).not.toHaveBeenCalled();
  });

  it('surfaces missing worktree directories as typed conflicts', async () => {
    prisma.task.findUnique.mockResolvedValue({
      id: 'task-1',
      worktreePath: path.join(worktreePath, 'missing')
    });
    policies.getTestCommand.mockResolvedValue({
      id: 'unit',
      label: 'Unit',
      command: ['node', '-e', 'console.log("ok")']
    });

    await expect(service.runTaskCommand('task-1', 'unit')).rejects.toMatchObject({
      response: { status: 409 }
    });
    expect(prisma.testRunSummary.create).not.toHaveBeenCalled();
  });

  it('rejects configured test commands that resolve outside the worktree', async () => {
    policies.getTestCommand.mockResolvedValue({
      id: 'escape',
      label: 'Escape cwd',
      cwd: '../outside',
      command: ['node', '-e', 'console.log("nope")']
    });

    await expect(service.runTaskCommand('task-1', 'escape')).rejects.toMatchObject({
      response: { status: 403 }
    });
    expect(prisma.testRunSummary.create).not.toHaveBeenCalled();
  });
});
