import { HttpStatus, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GitDiffService } from './git-diff.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { SyncEventService } from '../sync/sync-event.service';
import { PrGeneratorService } from './pr-generator.service';

jest.mock('child_process', () => {
  const mock = jest.fn();
  // Default promisify resolves with the second callback arg, so we pass
  // { stdout, stderr } to match Node's custom execFile promisification.
  mock.mockImplementation((_file: unknown, _args: unknown, _options: unknown, cb: (...args: unknown[]) => void) => {
    cb(null, { stdout: 'https://github.com/owner/repo/pull/42\n', stderr: '' });
  });
  return { execFile: mock };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const execFileMock: any = jest.requireMock('child_process').execFile;

const prisma = {
  task: { findUnique: jest.fn() },
  gitChangeSummary: { findMany: jest.fn() },
  testRunSummary: { findMany: jest.fn() },
  approvalRequest: { count: jest.fn() },
} as unknown as PrismaService;

const diffs = {} as unknown as GitDiffService;

const approvals = {
  createFromAgentRequest: jest.fn(),
} as unknown as ApprovalsService;

const syncEvents = {
  createOrReuse: jest.fn(),
  markRunning: jest.fn(),
  markSucceeded: jest.fn(),
  markFailed: jest.fn(),
  getLastForAction: jest.fn(),
} as unknown as SyncEventService;

const service = new PrGeneratorService(prisma, diffs, approvals, syncEvents);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});

const baseTask = {
  id: 'task-1',
  title: 'Test task',
  prompt: 'Implement the feature',
  status: 'running',
  worktreePath: '/wt/task-1',
  branchName: 'feat/test',
  baseRef: 'main',
  externalIssueRef: JSON.stringify({ provider: 'github', key: 'GH-5', url: 'https://github.com/owner/repo/issues/5' }),
  repoPath: '/repo',
  selectedAgent: 'codex',
  approvalMode: 'cooperative-gated',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('PrGeneratorService', () => {
  describe('generatePrBody', () => {
    it('returns a markdown body with all sections', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue(baseTask);
      (prisma.gitChangeSummary.findMany as jest.Mock).mockResolvedValue([
        {
          filesChanged: 3,
          insertions: 45,
          deletions: 12,
          addedCount: 2,
          modifiedCount: 1,
          deletedCount: 0,
          renamedCount: 0,
          riskFlagsJson: JSON.stringify(['lockfile_changed']),
          topFilesJson: JSON.stringify([
            { path: 'src/index.ts', insertions: 30, deletions: 5 },
            { path: 'src/lib.ts', insertions: 15, deletions: 7 },
          ]),
          statusText: '',
          id: 'diff-1',
          taskId: 'task-1',
          sessionId: null,
          createdAt: new Date(),
        },
      ]);
      (prisma.testRunSummary.findMany as jest.Mock).mockResolvedValue([
        { commandId: 'root:test', status: 'passed', exitCode: 0 },
      ]);
      (prisma.approvalRequest.count as jest.Mock).mockResolvedValue(3);

      const body = await service.generatePrBody('task-1');

      expect(body).toContain('## Summary');
      expect(body).toContain('Implement the feature');
      expect(body).toContain('## Linked Issues');
      expect(body).toContain('GH-5');
      expect(body).toContain('## Changes');
      expect(body).toContain('3 files changed, +45 / -12');
      expect(body).toContain('src/index.ts');
      expect(body).toContain('## Tests');
      expect(body).toContain('root:test');
      expect(body).toContain('## Approvals');
      expect(body).toContain('3 human-approved action(s)');
      expect(body).toContain('## Known Risks');
      expect(body).toContain('lockfile changed');
      expect(body).toContain('## Follow-ups');
    });

    it('handles missing diff, tests, and external issue gracefully', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({
        ...baseTask,
        externalIssueRef: null,
        prompt: null,
      });
      (prisma.gitChangeSummary.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.testRunSummary.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.approvalRequest.count as jest.Mock).mockResolvedValue(0);

      const body = await service.generatePrBody('task-1');

      expect(body).toContain('Test task');
      expect(body).toContain('None');
      expect(body).toContain('No diff summary available.');
      expect(body).toContain('No test runs recorded.');
      expect(body).toContain('0 human-approved action(s)');
      expect(body).toContain('None identified');
    });

    it('throws 404 when task is not found', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.generatePrBody('bad-id')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  describe('requestAndExecute', () => {
    const baseInput = { taskId: 'task-1', title: 'My PR' };

    beforeEach(() => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue(baseTask);
      (prisma.gitChangeSummary.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.testRunSummary.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.approvalRequest.count as jest.Mock).mockResolvedValue(0);
      (syncEvents.getLastForAction as jest.Mock).mockResolvedValue(null);
      (syncEvents.createOrReuse as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'pending' });
      (syncEvents.markRunning as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'running' });
      (syncEvents.markSucceeded as jest.Mock).mockResolvedValue(undefined);
      (syncEvents.markFailed as jest.Mock).mockResolvedValue(undefined);
      (approvals.createFromAgentRequest as jest.Mock).mockResolvedValue({
        approval: { id: 'apr-1', decision: 'approved' },
        decision: 'approved',
      });
    });

    it('throws 404 when task does not exist', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('throws 422 when task has no worktreePath', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({ ...baseTask, worktreePath: null });
      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
    });

    it('throws 422 when task has no branch name', async () => {
      (prisma.task.findUnique as jest.Mock).mockResolvedValue({ ...baseTask, branchName: null });
      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        message: 'Branch Not Found',
      });
    });

    it('reuses existing PR when SyncEvent has succeeded status', async () => {
      (syncEvents.getLastForAction as jest.Mock).mockResolvedValue({
        status: 'succeeded',
        externalId: '42',
        url: 'https://github.com/owner/repo/pull/42',
      });

      const result = await service.requestAndExecute(baseInput);

      expect(result.prNumber).toBe(42);
      expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
      expect(result.created).toBe(false);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('does not reuse when SyncEvent is in non-terminal state', async () => {
      (syncEvents.getLastForAction as jest.Mock).mockResolvedValue({
        status: 'failed',
        externalId: null,
        url: null,
      });

      await service.requestAndExecute(baseInput);

      expect(execFileMock).toHaveBeenCalled();
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

    it('returns prNumber, prUrl, and created=true on success', async () => {
      const result = await service.requestAndExecute(baseInput);

      expect(result.prNumber).toBe(42);
      expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
      expect(result.created).toBe(true);
      expect(execFileMock.mock.calls[0][0]).toBe('gh');
      expect(execFileMock.mock.calls[0][1]).toEqual(expect.arrayContaining(['pr', 'create', '--draft', '--title', 'My PR']));
      expect(execFileMock.mock.calls[0][2]).toEqual(expect.objectContaining({ cwd: '/wt/task-1' }));
      expect(syncEvents.markSucceeded).toHaveBeenCalledWith('sync-1', '42', 'https://github.com/owner/repo/pull/42');
    });

    it('uses provided head and base over task defaults', async () => {
      await service.requestAndExecute({ ...baseInput, head: 'custom-head', base: 'custom-base' });

      expect(execFileMock.mock.calls[0][1]).toEqual(expect.arrayContaining(['--base', 'custom-base', '--head', 'custom-head']));
    });

    it('records failure to SyncEvent and throws 500 when gh fails', async () => {
      execFileMock.mockImplementationOnce((_file: unknown, _args: unknown, _options: unknown, cb: (...args: unknown[]) => void) => {
        cb(new Error('git push --set-upstream origin feat/test'));
      });

      await expect(service.requestAndExecute(baseInput)).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });

      expect(syncEvents.markFailed).toHaveBeenCalledWith('sync-1', 'unknown_error', expect.any(String));
    });
  });
});
