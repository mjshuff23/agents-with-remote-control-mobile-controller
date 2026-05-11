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
import { createInMemoryPrisma } from './utils/in-memory-prisma';

const TEST_SECRET = 'test-secret';

describe('WebSocket events', () => {
  let app: INestApplication;
  let socket: Socket;

  const adapter = { name: 'codex' as const, startTask: jest.fn() };

  beforeEach(async () => {
    jest.restoreAllMocks();

    // Delay the process exit so the client can subscribe before task.completed fires
    adapter.startTask.mockImplementation(async (input) => {
      await input.onOutput({ type: 'stdout', content: 'hello from agent' });
      setTimeout(() => { void input.onExit({ exitCode: 0 }); }, 200);
      return { externalSessionId: 'mock-session', stop: jest.fn(), write: jest.fn() };
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(createInMemoryPrisma())
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
