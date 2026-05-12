import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { io, Socket } from 'socket.io-client';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { applyAppGlobals } from '../src/app-globals';
import { PrismaService } from '../src/prisma/prisma.service';
import { AGENT_ADAPTERS } from '../src/agents/agent-adapter.token';
import { AppConfigService } from '../src/config/app-config.service';
import { GitWorktreeService } from '../src/git/git-worktree.service';
import { createInMemoryPrisma } from './utils/in-memory-prisma';

const TEST_SECRET = 'test-secret';

describe('WebSocket events', () => {
  let app: INestApplication;
  let socket: Socket;

  const adapter = { name: 'codex' as const, startTask: jest.fn() };
  const worktrees = { createForTask: jest.fn() };

  beforeEach(async () => {
    jest.restoreAllMocks();
    worktrees.createForTask.mockResolvedValue({
      repoPath: '/repo',
      worktreePath: '/repo/worktrees/task',
      branchName: 'agent/task-demo',
      baseRef: 'main',
      baseCommit: 'abc123'
    });

    // Delay the process exit so the client can subscribe before task.completed fires
    adapter.startTask.mockImplementation(async (input) => {
      await input.onOutput({ type: 'stdout', content: 'hello from agent' });
      setTimeout(() => { void input.onExit({ exitCode: 0 }); }, 200);
      return { externalSessionId: 'mock-session', stop: jest.fn(), write: jest.fn() };
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(createInMemoryPrisma())
      .overrideProvider(GitWorktreeService).useValue(worktrees)
      .overrideProvider(AGENT_ADAPTERS).useValue([adapter])
      .compile();

    // NestJS ConfigModule caches its validated config, so the controllerSecret getter
    // may return undefined even when CONTROLLER_SECRET is set in process.env at
    // beforeEach time. Spy on the real service instance and force the secret value.
    const configSvc = moduleRef.get(AppConfigService);
    jest.spyOn(configSvc, 'controllerSecret', 'get').mockReturnValue(TEST_SECRET);

    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    applyAppGlobals(app);
    await app.init();
    await app.listen(0); // bind to a random free port
  });

  afterEach(async () => {
    socket?.disconnect();
    await app.close();
  });

  it('receives task.completed after subscribing to the task room', async () => {
    const { port } = app.getHttpServer().address() as { port: number };

    const createRes = await request(app.getHttpServer())
      .post('/tasks')
      .set('X-Controller-Secret', TEST_SECRET)
      .send({ prompt: 'do something', agent: 'codex' })
      .expect(201);
    const taskId: string = createRes.body.task.id;

    socket = io(`http://localhost:${port}`, { auth: { token: TEST_SECRET } });

    // Wait for ack so we know the server has joined the room before the
    // 200ms timer fires task.completed — eliminates the subscribe/complete race.
    await socket.emitWithAck('subscribe', { taskId });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout: task.completed not received')), 5000);
      socket.on('task.completed', (event: { exitCode: number; status: string }) => {
        clearTimeout(timeout);
        expect(event.exitCode).toBe(0);
        expect(event.status).toBe('completed');
        resolve();
      });
    });
  });

  it('replays missed logs on reconnect and continues live events from the task room', async () => {
    const writeStub = jest.fn();
    adapter.startTask.mockImplementationOnce(async (input) => {
      await input.onOutput({ type: 'stdout', content: 'hello before disconnect' });
      setTimeout(() => { void input.onExit({ exitCode: 0 }); }, 800);
      return { externalSessionId: 'mock-session', stop: jest.fn(), write: writeStub };
    });
    const { port } = app.getHttpServer().address() as { port: number };

    const createRes = await request(app.getHttpServer())
      .post('/tasks')
      .set('X-Controller-Secret', TEST_SECRET)
      .send({ prompt: 'do something', agent: 'codex' })
      .expect(201);
    const taskId: string = createRes.body.task.id;

    socket = io(`http://localhost:${port}`, { auth: { token: TEST_SECRET }, transports: ['websocket'] });
    const firstAck = await socket.emitWithAck('subscribe', {
      taskId,
      afterEventSeq: 0,
      afterLogSequence: 0
    });
    const lastEventSeq = Math.max(...firstAck.replay.events.map((event: { seq: number }) => event.seq));
    const lastLogSequence = Math.max(...firstAck.replay.logs.map((log: { sequence: number }) => log.sequence));
    socket.disconnect();

    await request(app.getHttpServer())
      .post(`/tasks/${taskId}/input`)
      .set('X-Controller-Secret', TEST_SECRET)
      .send({ text: 'continue' })
      .expect(202);

    socket = io(`http://localhost:${port}`, { auth: { token: TEST_SECRET }, transports: ['websocket'] });
    const reconnectAck = await socket.emitWithAck('subscribe', {
      taskId,
      afterEventSeq: lastEventSeq,
      afterLogSequence: lastLogSequence
    });

    expect(reconnectAck.replay.logs).toEqual([
      expect.objectContaining({ sequence: lastLogSequence + 1, content: 'Input sent (8 chars)' })
    ]);
    expect(reconnectAck.replay.events).toEqual([
      expect.objectContaining({ seq: lastEventSeq + 1, name: 'agent.log' })
    ]);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout: task.completed not received after reconnect')), 5000);
      socket.on('task.completed', (event: { exitCode: number; status: string }) => {
        clearTimeout(timeout);
        expect(event.exitCode).toBe(0);
        expect(event.status).toBe('completed');
        resolve();
      });
    });
  });

  it('disconnects a client with a wrong token', async () => {
    const { port } = app.getHttpServer().address() as { port: number };

    await new Promise<void>((resolve) => {
      socket = io(`http://localhost:${port}`, {
        auth: { token: 'wrong' },
        reconnection: false,
      });
      socket.on('disconnect', () => resolve());
      socket.on('connect_error', () => resolve());
    });

    expect(socket.connected).toBe(false);
  });
});
