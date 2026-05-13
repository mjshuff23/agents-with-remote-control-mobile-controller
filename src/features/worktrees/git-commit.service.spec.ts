import { HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { SyncEventService } from '../sync/sync-event.service';
import { GitCommandService } from './git-command.service';
import { GitCommitService } from './git-commit.service';

const prisma = {
  task: { findUnique: jest.fn() },
} as unknown as PrismaService;

const git = { git: jest.fn() } as unknown as GitCommandService;

const approvals = {
  createFromAgentRequest: jest.fn(),
} as unknown as ApprovalsService;

const syncEvents = {
  createOrReuse: jest.fn(),
  markRunning: jest.fn(),
  markSucceeded: jest.fn(),
} as unknown as SyncEventService;

const service = new GitCommitService(prisma, git, approvals, syncEvents);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GitCommitService', () => {
  describe('buildCommitMessage', () => {
    it('includes summary and taskId', () => {
      const msg = service.buildCommitMessage({ taskId: 'task-1', summary: 'Fix bug' });
      expect(msg).toContain('Fix bug');
      expect(msg).toContain('Task: task-1');
    });

    it('includes linearKey when provided', () => {
      const msg = service.buildCommitMessage({ taskId: 'task-1', summary: 'Fix', linearKey: 'TSH-102' });
      expect(msg).toContain('Linear: TSH-102');
    });

    it('includes githubIssueKey when provided', () => {
      const msg = service.buildCommitMessage({ taskId: 'task-1', summary: 'Fix', githubIssueKey: '#42' });
      expect(msg).toContain('GitHub: #42');
    });

    it('omits optional keys when absent', () => {
      const msg = service.buildCommitMessage({ taskId: 'task-1', summary: 'Fix' });
      expect(msg).not.toContain('Linear:');
      expect(msg).not.toContain('GitHub:');
    });

    it('produces deterministic output', () => {
      const input = { taskId: 'task-1', summary: 'Fix', linearKey: 'TSH-1', githubIssueKey: '#1' };
      expect(service.buildCommitMessage(input)).toBe(service.buildCommitMessage(input));
    });
  });

  describe('isSigningConfigured', () => {
    it('returns true when commit.gpgsign is "true"', async () => {
      (git.git as jest.Mock)
        .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });
      expect(await service.isSigningConfigured('/wt')).toBe(true);
    });

    it('returns true when user.signingkey is set', async () => {
      (git.git as jest.Mock)
        .mockRejectedValueOnce(new Error('not found'))
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce({ stdout: 'ABCDEF01\n', stderr: '' });
      expect(await service.isSigningConfigured('/wt')).toBe(true);
    });

    it('returns false when no signing config is present', async () => {
      (git.git as jest.Mock)
        .mockRejectedValueOnce(new Error('not found'))
        .mockRejectedValueOnce(new Error('not found'))
        .mockRejectedValueOnce(new Error('not found'));
      expect(await service.isSigningConfigured('/wt')).toBe(false);
    });
  });

  describe('requestAndExecute', () => {
    const baseTask = { id: 'task-1', worktreePath: '/wt/task-1' };
    const baseInput = { taskId: 'task-1', summary: 'Add feature' };

    beforeEach(() => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue(baseTask);
      // signing not configured
      (git.git as jest.Mock).mockRejectedValue(new Error('not found'));
      (approvals.createFromAgentRequest as jest.Mock).mockResolvedValue({
        approval: { id: 'apr-1', decision: 'approved' },
        decision: 'approved',
      });
      (syncEvents.createOrReuse as jest.Mock).mockResolvedValue({ id: 'sync-1' });
      (syncEvents.markRunning as jest.Mock).mockResolvedValue(undefined);
      (syncEvents.markSucceeded as jest.Mock).mockResolvedValue(undefined);
    });

    it('throws 404 when task does not exist', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('throws 422 when task has no worktreePath', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({ id: 'task-1', worktreePath: null });
      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
    });

    it('throws 403 when approval is denied', async () => {
      (approvals.createFromAgentRequest as jest.Mock).mockResolvedValue({
        approval: { id: 'apr-1', decision: 'denied' },
        decision: 'denied',
      });
      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      });
    });

    it('throws 500 with signing error message when git commit fails with gpg message', async () => {
      // First 3 calls are signing checks (all reject), then add -A succeeds, then commit fails
      (git.git as jest.Mock)
        .mockRejectedValueOnce(new Error('not found'))
        .mockRejectedValueOnce(new Error('not found'))
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add -A
        .mockRejectedValueOnce(new Error('gpg: signing failed: secret key not available'));
      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Commit Signing Failed',
      });
    });

    it('returns sha, message, and signingWarning on success', async () => {
      (git.git as jest.Mock)
        .mockRejectedValueOnce(new Error('not found')) // gpgsign
        .mockRejectedValueOnce(new Error('not found')) // gpg.format
        .mockRejectedValueOnce(new Error('not found')) // signingkey
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add -A
        .mockResolvedValueOnce({ stdout: '[main abc1234] Add feature\n', stderr: '' }) // git commit
        .mockResolvedValueOnce({ stdout: 'abc1234def5678\n', stderr: '' }); // rev-parse HEAD

      const result = await service.requestAndExecute(baseInput);

      expect(result.sha).toBe('abc1234def5678');
      expect(result.message).toContain('Add feature');
      expect(result.signingWarning).toMatch(/not configured/);
      expect(syncEvents.createOrReuse).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'git', action: 'commit', targetId: 'task-1' }),
      );
      expect(syncEvents.markRunning).toHaveBeenCalledWith('sync-1');
      expect(syncEvents.markSucceeded).toHaveBeenCalledWith('sync-1', 'abc1234def5678', undefined);
    });

    it('passes linearKey and githubIssueKey into the commit message', async () => {
      (git.git as jest.Mock)
        .mockRejectedValueOnce(new Error('not found'))
        .mockRejectedValueOnce(new Error('not found'))
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: '[main abc] msg\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' });

      const result = await service.requestAndExecute({
        ...baseInput,
        linearKey: 'TSH-102',
        githubIssueKey: '#5',
      });

      expect(result.message).toContain('Linear: TSH-102');
      expect(result.message).toContain('GitHub: #5');
    });
  });
});
