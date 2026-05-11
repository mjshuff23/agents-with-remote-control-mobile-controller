import { mkdtemp, rm } from 'fs/promises';
import { mkdir } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AppConfigService } from '../config/app-config.service';
import { EventsGateway } from '../events/events.gateway';
import { GitCommandService } from './git-command.service';
import { GitWorktreeService } from './git-worktree.service';

describe('GitWorktreeService', () => {
  let tmp: string;
  const git = { git: jest.fn() } as unknown as GitCommandService;
  const events = { emitEnvelopeToTask: jest.fn() } as unknown as EventsGateway;
  let service: GitWorktreeService;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'arc-worktree-test-'));
    jest.clearAllMocks();
    const config = {
      repoPath: '/repo/main',
      worktreeRoot: tmp
    } as AppConfigService;
    service = new GitWorktreeService(config, git, events);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('derives deterministic branch and worktree paths and creates a new branch worktree', async () => {
    (git.git as jest.Mock)
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })
      .mockRejectedValueOnce(new Error('missing branch'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await service.createForTask({
      taskId: 'task-123',
      title: 'Add Approval Cards!',
      prompt: 'ignored'
    });

    expect(result.branchName).toBe('agent/task-123-add-approval-cards');
    expect(result.worktreePath).toBe(path.join(tmp, 'task-123-add-approval-cards'));
    expect(git.git).toHaveBeenLastCalledWith('/repo/main', [
      'worktree',
      'add',
      '-b',
      'agent/task-123-add-approval-cards',
      path.join(tmp, 'task-123-add-approval-cards'),
      'main'
    ]);
  });

  it('uses an existing branch when branch verification succeeds', async () => {
    (git.git as jest.Mock)
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'refs/heads/branch\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await service.createForTask({
      taskId: 'task-123',
      title: 'Demo',
      prompt: 'ignored'
    });

    expect(git.git).toHaveBeenLastCalledWith('/repo/main', [
      'worktree',
      'add',
      path.join(tmp, 'task-123-demo'),
      'agent/task-123-demo'
    ]);
  });

  it('validates an existing worktree is on the expected branch before reuse', async () => {
    await mkdir(path.join(tmp, 'task-123-demo', '.git'), { recursive: true });
    (git.git as jest.Mock)
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'agent/task-123-demo\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'def456\n', stderr: '' });

    const result = await service.createForTask({
      taskId: 'task-123',
      title: 'Demo',
      prompt: 'ignored'
    });

    expect(result.baseCommit).toBe('def456');
    expect(git.git).toHaveBeenCalledWith(path.join(tmp, 'task-123-demo'), ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(git.git).not.toHaveBeenCalledWith('/repo/main', expect.arrayContaining(['worktree', 'add']));
  });

  it('rejects an existing worktree on an unexpected branch', async () => {
    await mkdir(path.join(tmp, 'task-123-demo', '.git'), { recursive: true });
    (git.git as jest.Mock)
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'other-branch\n', stderr: '' });

    await expect(service.createForTask({
      taskId: 'task-123',
      title: 'Demo',
      prompt: 'ignored'
    })).rejects.toThrow('expected "agent/task-123-demo"');
  });
});
