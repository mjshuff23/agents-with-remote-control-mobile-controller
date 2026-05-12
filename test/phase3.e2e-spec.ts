import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { mkdtemp, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { io, Socket } from 'socket.io-client';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { applyAppGlobals } from '../src/app-globals';
import { AGENT_ADAPTERS } from '../src/agents/agent-adapter.token';
import { AppConfigService } from '../src/config/app-config.service';
import { GitCommandService } from '../src/features/worktrees/git-command.service';
import { GitWorktreeService } from '../src/features/worktrees/git-worktree.service';
import { PolicyLoaderService } from '../src/features/policy/policy-loader.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createInMemoryPrisma } from './utils/in-memory-prisma';

const TEST_SECRET = 'test-secret';
const authed = (requestTest: request.Test) => requestTest.set('X-Controller-Secret', TEST_SECRET);

describe('Phase 3 local safety loop', () => {
  let app: INestApplication;
  let socket: Socket;
  let worktreePath: string;
  let writeStub: jest.Mock;

  const adapter = { name: 'codex' as const, startTask: jest.fn() };
  const worktrees = { createForTask: jest.fn() };
  const gitCommands = { git: jest.fn() };
  const policy = {
    load: jest.fn(),
    getTestCommand: jest.fn(),
    listTestCommands: jest.fn(),
    approvalTimeoutMs: jest.fn()
  };

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    worktreePath = await mkdtemp(path.join(os.tmpdir(), 'arc-phase3-e2e-'));
    writeStub = jest.fn();
    worktrees.createForTask.mockResolvedValue({
      repoPath: '/repo',
      worktreePath,
      branchName: 'agent/task-demo',
      baseRef: 'main',
      baseCommit: 'abc123'
    });
    gitCommands.git.mockImplementation(async (_cwd: string, args: string[]) => {
      const key = args.join(' ');
      if (key.startsWith('status')) return { stdout: '# branch.oid abc\0', stderr: '' };
      if (key.includes('--stat')) return { stdout: ' src/a.ts | 2 +-\n', stderr: '' };
      if (key.includes('--numstat')) return { stdout: '2\t1\tsrc/a.ts\0', stderr: '' };
      if (key.includes('--name-status')) return { stdout: 'M\0src/a.ts\0', stderr: '' };
      throw new Error(`unexpected git args: ${key}`);
    });
    policy.load.mockResolvedValue({
      version: 1,
      policy: {
        safe: [{ id: 'test.allowed', actionTypes: ['test.run'], commandIds: ['unit'], rationale: 'allowed test' }],
        needsApproval: [{ id: 'fs.mutation', actionTypes: ['fs.write_patch'], rationale: 'file writes require approval' }],
        blocked: [{ id: 'secrets.paths', pathGlobs: ['.env'], rationale: 'secret path' }]
      },
      testCommands: []
    });
    policy.getTestCommand.mockResolvedValue({
      id: 'unit',
      label: 'Unit smoke',
      command: ['node', '-e', 'console.log("unit ok")']
    });
    policy.listTestCommands.mockResolvedValue([
      {
        id: 'unit',
        label: 'Unit smoke',
        command: ['node', '-e', 'console.log("unit ok")']
      }
    ]);
    policy.approvalTimeoutMs.mockResolvedValue(10000);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(createInMemoryPrisma())
      .overrideProvider(GitWorktreeService).useValue(worktrees)
      .overrideProvider(GitCommandService).useValue(gitCommands)
      .overrideProvider(PolicyLoaderService).useValue(policy)
      .overrideProvider(AGENT_ADAPTERS).useValue([adapter])
      .compile();

    const configSvc = moduleRef.get(AppConfigService);
    jest.spyOn(configSvc, 'controllerSecret', 'get').mockReturnValue(TEST_SECRET);
    jest.spyOn(configSvc, 'approvalTimeoutMs', 'get').mockReturnValue(10000);

    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    applyAppGlobals(app);
    await app.init();
    await app.listen(0);
  });

  afterEach(async () => {
    socket?.disconnect();
    await app.close();
    await rm(worktreePath, { recursive: true, force: true });
  });

  it('persists and resolves cooperative approval requests over REST and WebSocket', async () => {
    let output: ((event: { type: 'stdout'; content: string }) => Promise<void>) | undefined;
    adapter.startTask.mockImplementation(async (input) => {
      output = input.onOutput;
      return { externalSessionId: 'mock-session', stop: jest.fn(), write: writeStub };
    });

    const { port } = app.getHttpServer().address() as { port: number };
    socket = io(`http://localhost:${port}`, { auth: { token: TEST_SECRET }, transports: ['websocket'] });
    const created = await authed(request(app.getHttpServer()).post('/tasks')).send({ prompt: 'patch', agent: 'codex' }).expect(201);
    await socket.emitWithAck('subscribe', { taskId: created.body.task.id });

    const eventPromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('approval.requested timeout')), 3000);
      socket.on('approval.requested', (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });
    await output?.({
      type: 'stdout',
      content: 'ARC_ACTION_REQUEST {"id":"action-1","actionType":"fs.write_patch","title":"Patch file","files":["src/a.ts"]}\n'
    });
    const event = await eventPromise;
    expect(event.data.status).toBe('pending');

    const denied = await authed(
      request(app.getHttpServer()).post(`/approvals/${event.data.id}/deny`)
    )
      .send({ message: 'Not this way' })
      .expect(202);

    expect(denied.body.approval.status).toBe('denied');
    expect(writeStub).toHaveBeenCalledWith(expect.stringContaining('ARC_APPROVAL'));
    expect(writeStub).toHaveBeenCalledWith(expect.stringContaining('"decision":"denied"'));
  });

  it('refuses blocked secret-path requests without creating a pending approval', async () => {
    adapter.startTask.mockImplementation(async (input) => {
      await input.onOutput({
        type: 'stdout',
        content: 'ARC_ACTION_REQUEST {"id":"action-2","actionType":"fs.write_patch","title":"Read env","files":[".env"]}\n'
      });
      return { externalSessionId: 'mock-session', stop: jest.fn(), write: writeStub };
    });

    const created = await authed(request(app.getHttpServer()).post('/tasks')).send({ prompt: 'blocked', agent: 'codex' }).expect(201);
    const approvals = await authed(request(app.getHttpServer()).get(`/tasks/${created.body.task.id}/approvals`)).expect(200);

    expect(approvals.body.approvals).toEqual([
      expect.objectContaining({ status: 'refused', decision: 'refused', ruleMatched: 'secrets.paths' })
    ]);
  });

  it('persists diff summaries and streams allowed test runs', async () => {
    adapter.startTask.mockResolvedValue({ externalSessionId: 'mock-session', stop: jest.fn(), write: writeStub });

    const { port } = app.getHttpServer().address() as { port: number };
    socket = io(`http://localhost:${port}`, { auth: { token: TEST_SECRET }, transports: ['websocket'] });
    const created = await authed(request(app.getHttpServer()).post('/tasks')).send({ prompt: 'summarize', agent: 'codex' }).expect(201);
    await socket.emitWithAck('subscribe', { taskId: created.body.task.id });

    const diff = await authed(request(app.getHttpServer()).post(`/tasks/${created.body.task.id}/diff-summary`)).expect(202);
    expect(diff.body.filesChanged).toBe(1);

    const completed = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('test.completed timeout')), 3000);
      socket.on('test.completed', (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });
    await authed(request(app.getHttpServer()).post(`/tasks/${created.body.task.id}/test-runs`))
      .send({ commandId: 'unit' })
      .expect(202);

    const testEvent = await completed;
    expect(testEvent.data.status).toBe('passed');
    expect(testEvent.data.exitCode).toBe(0);
  });
});
