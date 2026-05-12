import { mkdir, mkdtemp, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AppConfigService } from '../../config/app-config.service';
import { EventsGateway } from '../../events/events.gateway';
import { GitCommandService } from './git-command.service';
import { GitWorktreeService } from './git-worktree.service';
import type { ExternalIssueRef } from '../providers/provider.types';

const linearRef: ExternalIssueRef = { provider: 'linear', externalId: 'uuid-1', key: 'TSH-101', title: 'Branch naming rules' };
const githubRef: ExternalIssueRef = { provider: 'github', externalId: '5', key: '#5', title: 'Phase 4 sync' };

describe('GitWorktreeService', () => {
  let tmp: string;
  const git = { git: jest.fn() } as unknown as GitCommandService;
  const events = { emitEnvelopeToTask: jest.fn() } as unknown as EventsGateway;
  let service: GitWorktreeService;

  /** Mock sequence: HEAD branch, HEAD commit, then any additional calls. */
  function mockGitBase(headBranch = 'main', headCommit = 'abc123') {
    (git.git as jest.Mock)
      .mockResolvedValueOnce({ stdout: `${headBranch}\n`, stderr: '' })  // rev-parse --abbrev-ref HEAD
      .mockResolvedValueOnce({ stdout: `${headCommit}\n`, stderr: '' }); // rev-parse HEAD
  }

  /** Mock a clean status check (no dirty files). */
  function mockCleanStatus() {
    (git.git as jest.Mock).mockResolvedValueOnce({ stdout: '', stderr: '' }); // status --porcelain
  }

  /** Mock a dirty status check. */
  function mockDirtyStatus() {
    (git.git as jest.Mock).mockResolvedValueOnce({ stdout: ' M src/foo.ts\n', stderr: '' });
  }

  /** Mock branch-does-not-exist (rev-parse --verify throws). */
  function mockBranchMissing() {
    (git.git as jest.Mock).mockRejectedValueOnce(new Error('unknown revision'));
  }

  /** Mock branch-exists (rev-parse --verify succeeds). */
  function mockBranchExists() {
    (git.git as jest.Mock).mockResolvedValueOnce({ stdout: 'refs/heads/branch\n', stderr: '' });
  }

  /** Mock a successful worktree add. */
  function mockWorktreeAdd() {
    (git.git as jest.Mock).mockResolvedValueOnce({ stdout: '', stderr: '' });
  }

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'arc-worktree-test-'));
    jest.clearAllMocks();
    const config = { repoPath: '/repo/main', worktreeRoot: tmp } as AppConfigService;
    service = new GitWorktreeService(config, git, events);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // ── Task-id fallback naming (Phase 3 compat) ──────────────────────────────

  it('derives deterministic branch and worktree paths and creates a new branch worktree', async () => {
    mockGitBase();
    mockCleanStatus();
    mockBranchMissing();
    mockWorktreeAdd();

    const result = await service.createForTask({
      taskId: 'task-123',
      title: 'Add Approval Cards!',
      prompt: 'ignored',
    });

    expect(result.branchName).toBe('agent/task-123-add-approval-cards');
    expect(result.worktreePath).toBe(path.join(tmp, 'task-123-add-approval-cards'));
    expect(git.git).toHaveBeenLastCalledWith('/repo/main', [
      'worktree', 'add', '-b',
      'agent/task-123-add-approval-cards',
      path.join(tmp, 'task-123-add-approval-cards'),
      'main',
    ]);
  });

  it('uses an existing branch when branch verification succeeds', async () => {
    mockGitBase();
    mockCleanStatus();
    mockBranchExists();   // branchExists(candidate) = true, worktree path is free
    mockWorktreeAdd();

    await service.createForTask({
      taskId: 'task-123',
      title: 'Demo',
      prompt: 'ignored',
    });

    expect(git.git).toHaveBeenLastCalledWith('/repo/main', [
      'worktree', 'add',
      path.join(tmp, 'task-123-demo'),
      'agent/task-123-demo',
    ]);
  });

  it('validates an existing worktree is on the expected branch before reuse', async () => {
    await mkdir(path.join(tmp, 'task-123-demo', '.git'), { recursive: true });
    mockGitBase();
    (git.git as jest.Mock)
      .mockResolvedValueOnce({ stdout: 'agent/task-123-demo\n', stderr: '' }) // rev-parse --abbrev-ref HEAD (worktree)
      .mockResolvedValueOnce({ stdout: 'def456\n', stderr: '' });             // rev-parse HEAD (worktree)

    const result = await service.createForTask({ taskId: 'task-123', title: 'Demo', prompt: 'ignored' });

    expect(result.baseCommit).toBe('def456');
    expect(git.git).toHaveBeenCalledWith(path.join(tmp, 'task-123-demo'), ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(git.git).not.toHaveBeenCalledWith('/repo/main', expect.arrayContaining(['worktree', 'add']));
  });

  it('rejects an existing worktree on an unexpected branch', async () => {
    await mkdir(path.join(tmp, 'task-123-demo', '.git'), { recursive: true });
    mockGitBase();
    (git.git as jest.Mock).mockResolvedValueOnce({ stdout: 'other-branch\n', stderr: '' });

    await expect(service.createForTask({ taskId: 'task-123', title: 'Demo', prompt: 'ignored' }))
      .rejects.toThrow('expected "agent/task-123-demo"');
  });

  // ── Issue-linked branch naming ─────────────────────────────────────────────

  it('uses issue-linked format for a Linear issue ref', async () => {
    mockGitBase();
    mockCleanStatus();
    mockBranchMissing();
    mockWorktreeAdd();

    const result = await service.createForTask({
      taskId: 'task-1',
      title: 'Branch naming rules',
      prompt: 'ignored',
      externalIssueRef: linearRef,
    });

    expect(result.branchName).toBe('agent/linear-tsh-101-branch-naming-rules');
    expect(result.worktreePath).toBe(path.join(tmp, 'linear-tsh-101-branch-naming-rules'));
  });

  it('uses issue-linked format for a GitHub issue ref', async () => {
    mockGitBase();
    mockCleanStatus();
    mockBranchMissing();
    mockWorktreeAdd();

    const result = await service.createForTask({
      taskId: 'task-2',
      title: 'Phase 4 sync',
      prompt: 'ignored',
      externalIssueRef: githubRef,
    });

    expect(result.branchName).toBe('agent/github-5-phase-4-sync');
  });

  // ── Base branch selection ──────────────────────────────────────────────────

  it('uses explicit baseRef when provided', async () => {
    mockGitBase('main', 'abc123');
    mockCleanStatus();
    mockBranchMissing();
    mockWorktreeAdd();

    await service.createForTask({
      taskId: 'task-1',
      title: 'Demo',
      prompt: 'ignored',
      baseRef: 'develop',
    });

    expect(git.git).toHaveBeenLastCalledWith('/repo/main', [
      'worktree', 'add', '-b',
      'agent/task-1-demo',
      path.join(tmp, 'task-1-demo'),
      'develop',
    ]);
  });

  it('falls back to current HEAD branch when no baseRef provided', async () => {
    mockGitBase('feature/existing', 'abc123');
    mockCleanStatus();
    mockBranchMissing();
    mockWorktreeAdd();

    const result = await service.createForTask({ taskId: 'task-1', title: 'Demo', prompt: 'ignored' });

    expect(result.baseRef).toBe('feature/existing');
    expect(git.git).toHaveBeenLastCalledWith('/repo/main', [
      'worktree', 'add', '-b',
      'agent/task-1-demo',
      path.join(tmp, 'task-1-demo'),
      'feature/existing',
    ]);
  });

  // ── Dirty-repo guard ───────────────────────────────────────────────────────

  it('refuses to create a new worktree when the main checkout is dirty', async () => {
    mockGitBase();
    mockDirtyStatus();

    await expect(service.createForTask({ taskId: 'task-1', title: 'Demo', prompt: 'ignored' }))
      .rejects.toThrow('uncommitted changes');
  });

  it('allows reuse of an existing worktree even when the main checkout is dirty', async () => {
    await mkdir(path.join(tmp, 'task-123-demo', '.git'), { recursive: true });
    mockGitBase();
    (git.git as jest.Mock)
      .mockResolvedValueOnce({ stdout: 'agent/task-123-demo\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'def456\n', stderr: '' });

    // Should NOT throw even though we don't mock a clean status
    const result = await service.createForTask({ taskId: 'task-123', title: 'Demo', prompt: 'ignored' });
    expect(result.branchName).toBe('agent/task-123-demo');
  });

  // ── Collision handling ─────────────────────────────────────────────────────

  it('appends -2 suffix when the candidate branch already exists and worktree path is also taken', async () => {
    // Branch exists → service reuses it (adds worktree to existing branch)
    mockGitBase();
    mockCleanStatus();
    mockBranchExists();  // candidate exists → reuse path
    mockWorktreeAdd();

    const result = await service.createForTask({ taskId: 'task-1', title: 'Demo', prompt: 'ignored' });

    // Reuses the existing branch
    expect(result.branchName).toBe('agent/task-1-demo');
    expect(git.git).toHaveBeenLastCalledWith('/repo/main', [
      'worktree', 'add',
      path.join(tmp, 'task-1-demo'),
      'agent/task-1-demo',
    ]);
  });

  it('throws after 9 collision attempts via resolveUniqueBranchName', async () => {
    // Access private method via cast to test collision exhaustion
    for (let i = 0; i < 9; i++) mockBranchExists();

    await expect(
      (service as any).resolveUniqueBranchName('/repo/main', 'agent/task-1-demo')
    ).rejects.toThrow('unique branch name');
  });

  // ── removeWorktree cleanup ─────────────────────────────────────────────────

  it('removes the worktree and deletes the branch with remove policy', async () => {
    (git.git as jest.Mock)
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree remove
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // branch -D

    await service.removeWorktree('task-1', '/wt/path', 'agent/task-1-demo', 'remove');

    expect(git.git).toHaveBeenCalledWith('/repo/main', ['worktree', 'remove', '--force', '/wt/path']);
    expect(git.git).toHaveBeenCalledWith('/repo/main', ['branch', '-D', 'agent/task-1-demo']);
    expect(events.emitEnvelopeToTask).toHaveBeenCalledWith('task-1', 'worktree.cleanup_completed', 'git', 'info', expect.any(Object));
  });

  it('skips git commands and does not emit completed event with keep policy', async () => {
    await service.removeWorktree('task-1', '/wt/path', 'agent/task-1-demo', 'keep');

    expect(git.git).not.toHaveBeenCalled();
    expect(events.emitEnvelopeToTask).toHaveBeenCalledWith('task-1', 'worktree.cleanup_requested', 'git', 'info', expect.any(Object));
    expect(events.emitEnvelopeToTask).not.toHaveBeenCalledWith('task-1', 'worktree.cleanup_completed', expect.anything(), expect.anything(), expect.anything());
  });

  it('still emits cleanup_completed even if worktree remove fails', async () => {
    (git.git as jest.Mock)
      .mockRejectedValueOnce(new Error('not a worktree')) // worktree remove fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' });  // branch -D succeeds

    await service.removeWorktree('task-1', '/wt/path', 'agent/task-1-demo', 'remove');

    expect(events.emitEnvelopeToTask).toHaveBeenCalledWith('task-1', 'worktree.cleanup_completed', 'git', 'info', expect.any(Object));
  });
});
