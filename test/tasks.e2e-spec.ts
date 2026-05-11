import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../src/app.module';
import { AGENT_ADAPTERS } from '../src/agents/agent-adapter.token';
import { applyAppGlobals } from '../src/app-globals';
import { PrismaService } from '../src/prisma/prisma.service';
import { createInMemoryPrisma } from './utils/in-memory-prisma';

describe('Tasks API', () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof createInMemoryPrisma>;
  const adapter = {
    name: 'codex' as const,
    startTask: jest.fn()
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.DATABASE_URL = 'file:./data/test.sqlite';
    process.env.ARC_REPO_PATH = '/repo';
    process.env.ARC_HOST = '127.0.0.1';

    prisma = createInMemoryPrisma();
    adapter.startTask.mockImplementation(async (input) => {
      await input.onOutput({ type: 'stdout', content: 'started' });
      return {
        externalSessionId: 'mock-session',
        stop: jest.fn(async () => {
          await input.onExit({ exitCode: 143, signal: 'SIGTERM' });
        })
      };
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AGENT_ADAPTERS)
      .useValue([adapter])
      .compile();

    app = moduleRef.createNestApplication();
    applyAppGlobals(app);
    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('creates a codex task and returns 201 with a Location header', async () => {
    const response = await request(app.getHttpServer())
      .post('/tasks')
      .send({ prompt: 'Say hello', agent: 'codex', title: 'Greeting' })
      .expect(201);

    expect(response.headers.location).toBe(`/tasks/${response.body.task.id}`);
    expect(response.body.task).toEqual(expect.objectContaining({
      title: 'Greeting',
      prompt: 'Say hello',
      status: 'running',
      selectedAgent: 'codex',
      repoPath: '/repo'
    }));
    expect(response.body.session).toEqual(expect.objectContaining({
      agentName: 'codex',
      status: 'running',
      externalSessionId: 'mock-session'
    }));
  });

  it('returns task details with latest session and log tail', async () => {
    const created = await request(app.getHttpServer())
      .post('/tasks')
      .send({ prompt: 'Say hello', agent: 'codex' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/tasks/${created.body.task.id}`)
      .expect(200);

    expect(response.body.task.id).toBe(created.body.task.id);
    expect(response.body.session.status).toBe('running');
    expect(response.body.logs).toEqual([
      expect.objectContaining({ type: 'system', content: expect.stringContaining('Starting codex') }),
      expect.objectContaining({ type: 'stdout', content: 'started' })
    ]);
  });

  it('lists recent tasks newest first', async () => {
    await request(app.getHttpServer())
      .post('/tasks')
      .send({ prompt: 'First', agent: 'codex' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/tasks')
      .send({ prompt: 'Second', agent: 'codex' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get('/tasks')
      .expect(200);

    expect(response.body.tasks.map((task: { prompt: string }) => task.prompt)).toEqual(['Second', 'First']);
  });

  it('returns 202 when stopping a running task', async () => {
    const created = await request(app.getHttpServer())
      .post('/tasks')
      .send({ prompt: 'Stop me', agent: 'codex' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post(`/tasks/${created.body.task.id}/stop`)
      .expect(202);

    expect(response.body.session.status).toBe('stopping');
  });

  it('returns problem details for invalid task input', async () => {
    const response = await request(app.getHttpServer())
      .post('/tasks')
      .send({ prompt: '', agent: 'gemini' })
      .expect(400);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toEqual(expect.objectContaining({
      title: 'Bad Request',
      status: 400,
      detail: expect.stringContaining('prompt')
    }));
  });

  it('returns 202 when sending input to a running task', async () => {
    const writeStub = jest.fn();
    adapter.startTask.mockImplementation(async (input) => {
      await input.onOutput({ type: 'stdout', content: 'waiting' });
      return {
        externalSessionId: 'mock-session',
        stop: jest.fn(),
        write: writeStub
      };
    });

    const created = await request(app.getHttpServer())
      .post('/tasks')
      .send({ prompt: 'Run something', agent: 'codex' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post(`/tasks/${created.body.task.id}/input`)
      .send({ text: 'yes, continue' })
      .expect(202);

    expect(response.body.accepted).toBe(true);
    expect(writeStub).toHaveBeenCalledWith('yes, continue');
    expect(writeStub).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when input text is empty', async () => {
    const created = await request(app.getHttpServer())
      .post('/tasks')
      .send({ prompt: 'Run something', agent: 'codex' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/tasks/${created.body.task.id}/input`)
      .send({ text: '' })
      .expect(400);

    expect(res.body.detail).toMatch(/text/);
  });

  it('returns 404 when sending input to a non-existent task', async () => {
    await request(app.getHttpServer())
      .post('/tasks/00000000-0000-0000-0000-000000000000/input')
      .send({ text: 'hello' })
      .expect(404);
  });

  it('returns 409 when sending input to a task whose adapter has no write method', async () => {
    adapter.startTask.mockImplementationOnce(async (input) => {
      await input.onOutput({ type: 'stdout', content: 'waiting' });
      return { externalSessionId: 'mock-session-no-write', stop: jest.fn() };
    });

    const created = await request(app.getHttpServer())
      .post('/tasks')
      .send({ prompt: 'Run something', agent: 'codex' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/tasks/${created.body.task.id}/input`)
      .send({ text: 'hello' })
      .expect(409);
  });

  it('returns 409 when sending input to a task whose session is no longer active', async () => {
    adapter.startTask.mockImplementationOnce(async (input) => {
      await input.onOutput({ type: 'stdout', content: 'waiting' });
      return {
        externalSessionId: 'mock-session-exited',
        stop: jest.fn(async () => { await input.onExit({ exitCode: 0 }); }),
        write: jest.fn()
      };
    });

    const created = await request(app.getHttpServer())
      .post('/tasks')
      .send({ prompt: 'Wait then exit', agent: 'codex' })
      .expect(201);

    // Stop the task; the mock stop() fires onExit() which removes the process
    // from runningProcesses via completeFromExit (deferred through setImmediate).
    await request(app.getHttpServer())
      .post(`/tasks/${created.body.task.id}/stop`)
      .expect(202);

    // Allow the setImmediate → stop() → onExit → completeFromExit chain to finish.
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    const res = await request(app.getHttpServer())
      .post(`/tasks/${created.body.task.id}/input`)
      .send({ text: 'hello' })
      .expect(409);

    expect(res.body.detail).toMatch(/no live process/i);
  });
});
