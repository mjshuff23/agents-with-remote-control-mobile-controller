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
});
