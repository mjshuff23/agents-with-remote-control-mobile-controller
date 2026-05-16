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

  it('uses the task worktree as the execution directory when present', async () => {
    const adapter = new CodexAdapter(createConfig() as any);

    await adapter.startTask({
      taskId: 'task-1',
      sessionId: 'session-1',
      repoPath: '/home/user/repo',
      worktreePath: '/home/user/worktrees/task-1',
      prompt: 'hello',
      onOutput: jest.fn(),
      onExit: jest.fn()
    });

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '--json', '--cd', '/home/user/worktrees/task-1', '-'],
      expect.objectContaining({ cwd: '/home/user/worktrees/task-1' })
    );
  });

  it('uses the task worktree for WSL launch and inner Codex cwd when present', async () => {
    const adapter = new CodexAdapter(createConfig({ runnerMode: 'wsl' }) as any);

    await adapter.startTask({
      taskId: 'task-1',
      sessionId: 'session-1',
      repoPath: '/home/user/repo',
      worktreePath: '/home/user/worktrees/task-1',
      prompt: 'hello',
      onOutput: jest.fn(),
      onExit: jest.fn()
    });

    expect(spawn).toHaveBeenCalledWith(
      'wsl.exe',
      ['--cd', '/home/user/worktrees/task-1', '--', 'codex', 'exec', '--json', '--cd', '/home/user/worktrees/task-1', '-'],
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

  it('suppresses the initial PTY prompt echo before forwarding Codex JSON events', async () => {
    const process = createPtyProcess();
    spawn.mockReturnValue(process);
    const onOutput = jest.fn();
    const adapter = new CodexAdapter(createConfig() as any);

    await adapter.startTask({
      taskId: 'task-1',
      sessionId: 'session-1',
      repoPath: '/home/user/repo',
      prompt: 'User task:\nWhat is the date?\nARC_ACTION_REQUEST {"id":"<uuid>"}',
      onOutput,
      onExit: jest.fn()
    });

    const onData = process.onData.mock.calls[0][0];
    onData('User task:\r\nWhat is the date?\r\nARC_ACTION_REQUEST {"id":"<uuid>"}\r\n{"type":"thread.started","thread_id":"not-a-session"}\r\n{"type":"thread.started","thread_id":"11111111-1111-1111-1111-111111111111"}\r\n');
    expect(onOutput).not.toHaveBeenCalled();

    onData('{"type":"thread.started","thread_id":"019e3238-a03b-7390-a99d-64bcf544d100"}\n');
    expect(onOutput).not.toHaveBeenCalled();

    onData('{"type":"turn.started"}\n');
    expect(onOutput).toHaveBeenCalledWith({
      type: 'stdout',
      content: '{"type":"thread.started","thread_id":"019e3238-a03b-7390-a99d-64bcf544d100"}\n{"type":"turn.started"}\n'
    });
  });

  it('resumes a previous Codex exec thread with JSON output enabled', async () => {
    const process = createPtyProcess();
    spawn.mockReturnValue(process);
    const adapter = new CodexAdapter(createConfig() as any);

    await adapter.resumeTask({
      taskId: 'task-1',
      sessionId: 'session-1',
      repoPath: '/home/user/repo',
      externalSessionId: 'thread-1',
      prompt: 'continue',
      onOutput: jest.fn(),
      onExit: jest.fn()
    });

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      ['exec', 'resume', '--json', 'thread-1', '-'],
      expect.objectContaining({ cwd: '/home/user/repo' })
    );
    expect(process.write).toHaveBeenNthCalledWith(1, 'continue\r');
    expect(process.write).toHaveBeenNthCalledWith(2, '\x04');
  });

  it('preserves custom resume-safe options when ARC_CODEX_ARGS_JSON omits exec', async () => {
    const process = createPtyProcess();
    spawn.mockReturnValue(process);
    const adapter = new CodexAdapter(createConfig({
      codexArgs: ['--json', '--skip-git-repo-check', '--cd', '{repoPath}', '-']
    }) as any);

    await adapter.resumeTask({
      taskId: 'task-1',
      sessionId: 'session-1',
      repoPath: '/home/user/repo',
      externalSessionId: 'thread-1',
      prompt: 'continue',
      onOutput: jest.fn(),
      onExit: jest.fn()
    });

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      ['exec', 'resume', '--json', '--skip-git-repo-check', 'thread-1', '-'],
      expect.objectContaining({ cwd: '/home/user/repo' })
    );
  });

  it('flushes startup diagnostics on exit if Codex JSONL never starts', async () => {
    const process = createPtyProcess();
    spawn.mockReturnValue(process);
    const onOutput = jest.fn();
    const onExit = jest.fn();
    const adapter = new CodexAdapter(createConfig() as any);

    await adapter.startTask({
      taskId: 'task-1',
      sessionId: 'session-1',
      repoPath: '/home/user/repo',
      prompt: 'hello',
      onOutput,
      onExit
    });

    const onData = process.onData.mock.calls[0][0];
    const onPtyExit = process.onExit.mock.calls[0][0];
    onData('codex failed before json output\n');
    expect(onOutput).not.toHaveBeenCalled();

    onPtyExit({ exitCode: 1, signal: undefined });
    await new Promise((resolve) => setImmediate(resolve));

    expect(onOutput).toHaveBeenCalledWith({
      type: 'system',
      content: 'codex failed before json output\n'
    });
    expect(onExit).toHaveBeenCalledWith({ exitCode: 1, signal: undefined });
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

  it('write() sends text followed by \\r to the PTY', async () => {
    const process = createPtyProcess();
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

    process.write.mockClear(); // clear calls from writePrompt
    expect(running.write).toBeDefined();
    running.write!('some input');
    expect(process.write).toHaveBeenCalledWith('some input\r');
  });
});
