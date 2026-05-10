import * as pty from 'node-pty';
import { CodexAdapter } from './codex.adapter';

jest.mock('node-pty', () => ({
  spawn: jest.fn()
}));

const createPtyProcess = () => ({
  pid: 123,
  onData: jest.fn(),
  onExit: jest.fn(),
  write: jest.fn(),
  kill: jest.fn()
});

const createConfig = (overrides: Record<string, unknown> = {}) => ({
  runnerMode: 'local',
  codexCommand: 'codex',
  codexArgs: ['exec', '--json', '--cd', '{repoPath}', '-'],
  codexEnvKeys: [],
  wslCommand: 'wsl.exe',
  wslDistro: undefined,
  wslUser: undefined,
  shutdownGraceMs: 10,
  ...overrides
});

describe('CodexAdapter', () => {
  const spawn = pty.spawn as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    spawn.mockReturnValue(createPtyProcess());
  });

  it('omits the host cwd in WSL runner mode and relies on wsl --cd', async () => {
    const adapter = new CodexAdapter(createConfig({ runnerMode: 'wsl' }) as any);

    await adapter.startTask({
      taskId: 'task-1',
      sessionId: 'session-1',
      repoPath: '/home/user/repo',
      prompt: 'hello',
      onOutput: jest.fn(),
      onExit: jest.fn()
    });

    expect(spawn).toHaveBeenCalledWith(
      'wsl.exe',
      ['--cd', '/home/user/repo', '--', 'codex', 'exec', '--json', '--cd', '/home/user/repo', '-'],
      expect.not.objectContaining({ cwd: expect.anything() })
    );
  });

  it('keeps stop idempotent if the PTY already exited', async () => {
    const process = createPtyProcess();
    process.kill.mockImplementationOnce(() => {
      throw new Error('already exited');
    });
    spawn.mockReturnValue(process);
    const adapter = new CodexAdapter(createConfig() as any);

    const running = await adapter.startTask({
      taskId: 'task-1',
      sessionId: 'session-1',
      repoPath: '/home/user/repo',
      prompt: 'hello',
      onOutput: jest.fn(),
      onExit: jest.fn()
    });

    expect(() => running.stop()).not.toThrow();
    expect(process.kill).toHaveBeenCalledTimes(1);
  });

  it('submits the prompt before sending PTY EOF', async () => {
    const process = createPtyProcess();
    spawn.mockReturnValue(process);
    const adapter = new CodexAdapter(createConfig() as any);

    await adapter.startTask({
      taskId: 'task-1',
      sessionId: 'session-1',
      repoPath: '/home/user/repo',
      prompt: 'line one\nline two',
      onOutput: jest.fn(),
      onExit: jest.fn()
    });

    expect(process.write).toHaveBeenNthCalledWith(1, 'line one\rline two\r');
    expect(process.write).toHaveBeenNthCalledWith(2, '\x04');
  });

  it('submits an empty prompt before sending PTY EOF', async () => {
    const process = createPtyProcess();
    spawn.mockReturnValue(process);
    const adapter = new CodexAdapter(createConfig() as any);

    await adapter.startTask({
      taskId: 'task-1',
      sessionId: 'session-1',
      repoPath: '/home/user/repo',
      prompt: '',
      onOutput: jest.fn(),
      onExit: jest.fn()
    });

    expect(process.write).toHaveBeenNthCalledWith(1, '\r');
    expect(process.write).toHaveBeenNthCalledWith(2, '\x04');
  });

  it('does not double-enter a prompt that already ends with a newline', async () => {
    const process = createPtyProcess();
    spawn.mockReturnValue(process);
    const adapter = new CodexAdapter(createConfig() as any);

    await adapter.startTask({
      taskId: 'task-1',
      sessionId: 'session-1',
      repoPath: '/home/user/repo',
      prompt: 'line one\n',
      onOutput: jest.fn(),
      onExit: jest.fn()
    });

    expect(process.write).toHaveBeenNthCalledWith(1, 'line one\r');
    expect(process.write).toHaveBeenNthCalledWith(2, '\x04');
  });

  it('passes only allowlisted environment variables to the child process', async () => {
    const oldEnv = process.env;
    process.env = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      DATABASE_URL: 'file:secret.sqlite',
      GH_TOKEN: 'secret',
      OPENAI_API_KEY: 'openai-secret',
      CODEX_HOME: '/home/user/.codex',
      EXTRA_SAFE_KEY: 'allowed'
    };
    const adapter = new CodexAdapter(createConfig({ codexEnvKeys: ['EXTRA_SAFE_KEY'] }) as any);

    try {
      await adapter.startTask({
        taskId: 'task-1',
        sessionId: 'session-1',
        repoPath: '/home/user/repo',
        prompt: 'hello',
        onOutput: jest.fn(),
        onExit: jest.fn()
      });
    } finally {
      process.env = oldEnv;
    }

    expect(spawn.mock.calls[0][2].env).toEqual(expect.objectContaining({
      PATH: '/usr/bin',
      HOME: '/home/user',
      OPENAI_API_KEY: 'openai-secret',
      CODEX_HOME: '/home/user/.codex',
      EXTRA_SAFE_KEY: 'allowed'
    }));
    expect(spawn.mock.calls[0][2].env).not.toHaveProperty('DATABASE_URL');
    expect(spawn.mock.calls[0][2].env).not.toHaveProperty('GH_TOKEN');
  });
});
