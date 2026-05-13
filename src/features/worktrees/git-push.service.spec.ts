import { HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { SyncEventService } from '../sync/sync-event.service';
import { GitCommandService } from './git-command.service';
import { GitPushService } from './git-push.service';

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
  markFailed: jest.fn(),
} as unknown as SyncEventService;

const service = new GitPushService(prisma, git, approvals, syncEvents);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GitPushService', () => {
  describe('requestAndExecute', () => {
    const baseTask = { id: 'task-1', worktreePath: '/wt/task-1', branchName: 'feat/test' };
    const baseInput = { taskId: 'task-1' };

    beforeEach(() => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue(baseTask);
      (git.git as jest.Mock).mockResolvedValue({ stdout: '', stderr: '' });
      (approvals.createFromAgentRequest as jest.Mock).mockResolvedValue({
        approval: { id: 'apr-1', decision: 'approved' },
        decision: 'approved',
      });
      (syncEvents.createOrReuse as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'pending' });
      (syncEvents.markRunning as jest.Mock).mockResolvedValue(undefined);
      (syncEvents.markSucceeded as jest.Mock).mockResolvedValue(undefined);
      (syncEvents.markFailed as jest.Mock).mockResolvedValue(undefined);
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

    it('throws 422 when remote is not configured', async () => {
      (git.git as jest.Mock)
        .mockRejectedValueOnce(new Error('remote not found')); // verifyRemote
      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        message: 'Remote Not Found',
      });
    });

    it('throws 422 when branch does not exist locally', async () => {
      (git.git as jest.Mock)
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo.git\n', stderr: '' }) // verifyRemote
        .mockRejectedValueOnce(new Error('branch not found')); // verifyLocalBranch
      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        message: 'Branch Not Found',
      });
    });

    it('throws 422 for force-push refspec (leading +)', async () => {
      await expect(service.requestAndExecute({ ...baseInput, branch: '+main' })).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        message: 'Force Push Refused',
      });
    });

    it('throws 422 for refspec with colon', async () => {
      await expect(service.requestAndExecute({ ...baseInput, branch: 'source:destination' })).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        message: 'Unsafe Refspec Refused',
      });
    });

    it('throws 422 for wildcard refspec', async () => {
      await expect(service.requestAndExecute({ ...baseInput, branch: '*' })).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        message: 'Unsafe Refspec Refused',
      });
    });

    it('throws 403 when approval is denied', async () => {
      (git.git as jest.Mock)
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo.git\n', stderr: '' }) // verifyRemote
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // verifyLocalBranch
      (approvals.createFromAgentRequest as jest.Mock).mockResolvedValue({
        approval: { id: 'apr-1', decision: 'denied' },
        decision: 'denied',
      });
      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      });
    });

    it('throws 500 with categorized error when git push fails with auth error', async () => {
      (git.git as jest.Mock)
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo.git\n', stderr: '' }) // verifyRemote
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // verifyLocalBranch
        .mockRejectedValueOnce(new Error('Authentication failed: Bad credentials')); // git push

      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });

      expect(syncEvents.markFailed).toHaveBeenCalledWith('sync-1', 'auth_failed', expect.any(String));
    });

    it('throws 500 with categorized error when push is rejected by remote', async () => {
      (git.git as jest.Mock)
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo.git\n', stderr: '' }) // verifyRemote
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // verifyLocalBranch
        .mockRejectedValueOnce(new Error('! [rejected] main -> main (non-fast-forward)')); // git push

      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });

      expect(syncEvents.markFailed).toHaveBeenCalledWith('sync-1', 'push_rejected', expect.any(String));
    });

    it('returns remote, branch, and remoteSha on success', async () => {
      (git.git as jest.Mock)
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo.git\n', stderr: '' }) // verifyRemote
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // verifyLocalBranch
        .mockResolvedValueOnce({ stdout: 'To github.com:owner/repo.git\n   abc..def  main -> main\n', stderr: '' }) // git push
        .mockResolvedValueOnce({ stdout: 'def5678abcd1234\n', stderr: '' }); // rev-parse HEAD

      const result = await service.requestAndExecute(baseInput);

      expect(result.remote).toBe('origin');
      expect(result.branch).toBe('feat/test');
      expect(result.remoteSha).toBe('def5678abcd1234');
      expect(syncEvents.createOrReuse).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'git', action: 'push', targetId: 'task-1' }),
      );
      expect(syncEvents.markRunning).toHaveBeenCalledWith('sync-1');
      expect(syncEvents.markSucceeded).toHaveBeenCalledWith('sync-1', 'def5678abcd1234', undefined);
    });

    it('uses provided remote and branch over defaults', async () => {
      (git.git as jest.Mock)
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo.git\n', stderr: '' }) // verifyRemote
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // verifyLocalBranch
        .mockResolvedValueOnce({ stdout: 'To github.com:owner/repo.git\n   abc..def  upstream-branch -> upstream-branch\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });

      const result = await service.requestAndExecute({
        taskId: 'task-1',
        remote: 'upstream',
        branch: 'upstream-branch',
      });

      expect(result.remote).toBe('upstream');
      expect(result.branch).toBe('upstream-branch');
    });

    it('detects current branch when task.branchName is not set', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({
        id: 'task-1',
        worktreePath: '/wt/task-1',
        branchName: null,
      });
      (git.git as jest.Mock)
        .mockResolvedValueOnce({ stdout: 'feature/foo\n', stderr: '' }) // detectCurrentBranch
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo.git\n', stderr: '' }) // verifyRemote
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // verifyLocalBranch
        .mockResolvedValueOnce({ stdout: 'To github.com:owner/repo.git\n   abc..def  feature/foo -> feature/foo\n', stderr: '' }) // git push
        .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' }); // rev-parse HEAD

      const result = await service.requestAndExecute({ taskId: 'task-1' });

      expect(result.branch).toBe('feature/foo');
    });

    it('throws 422 when HEAD is detached', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({
        id: 'task-1',
        worktreePath: '/wt/task-1',
        branchName: null,
      });
      (git.git as jest.Mock)
        .mockResolvedValueOnce({ stdout: 'HEAD\n', stderr: '' }); // detectCurrentBranch

      await expect(service.requestAndExecute({ taskId: 'task-1' })).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        message: 'Detached HEAD',
      });
    });
  });

  describe('categorizePushError', () => {
    it('returns auth_failed for authentication errors', () => {
      expect(service.categorizePushError('Authentication failed: Bad credentials')).toBe('auth_failed');
      expect(service.categorizePushError('Permission denied (publickey)')).toBe('auth_failed');
      expect(service.categorizePushError('fatal: could not read from remote repository')).toBe('auth_failed');
    });

    it('returns network_error for connection errors', () => {
      expect(service.categorizePushError('Could not resolve host: github.com')).toBe('network_error');
      expect(service.categorizePushError('Connection refused')).toBe('network_error');
      expect(service.categorizePushError('Connection timed out')).toBe('network_error');
      expect(service.categorizePushError('fatal: Network is unreachable')).toBe('network_error');
    });

    it('returns push_rejected for rejected push errors', () => {
      expect(service.categorizePushError('! [rejected] main -> main (non-fast-forward)')).toBe('push_rejected');
      expect(service.categorizePushError('failed to push some refs')).toBe('push_rejected');
      expect(service.categorizePushError('protected branch hook declined')).toBe('push_rejected');
    });

    it('returns unknown_error for unrecognized errors', () => {
      expect(service.categorizePushError('Something went wrong')).toBe('unknown_error');
      expect(service.categorizePushError('')).toBe('unknown_error');
    });
  });
});
