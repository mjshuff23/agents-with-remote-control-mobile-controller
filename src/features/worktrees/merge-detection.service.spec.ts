import { HttpStatus, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { SyncEventService } from '../sync/sync-event.service';
import { MergeDetectionService } from './merge-detection.service';

jest.mock('child_process', () => {
  const mock = jest.fn();
  mock.mockImplementation((_file: unknown, _args: unknown, _options: unknown, cb: (...args: unknown[]) => void) => {
    cb(null, { stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'abc123' }, mergedAt: '2024-01-01T00:00:00Z' }), stderr: '' });
  });
  return { execFile: mock };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const execFileMock: any = jest.requireMock('child_process').execFile;

const config = {
  linearToken: 'lin_api_test_token',
  gitHubToken: 'ghp_test',
} as unknown as AppConfigService;

const syncEvents = {
  getLastForAction: jest.fn(),
  createOrReuse: jest.fn(),
  markRunning: jest.fn(),
  markSucceeded: jest.fn(),
  markFailed: jest.fn(),
  markRetryable: jest.fn(),
} as unknown as SyncEventService;

const service = new MergeDetectionService(config, syncEvents);

const baseInput = {
  taskId: 'task-1',
  worktreePath: '/wt/task-1',
  prNumber: 42,
  prUrl: 'https://github.com/owner/repo/pull/42',
  linearIssueId: 'lin-issue-uuid',
  linearIssueKey: 'TSH-106',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

  (syncEvents.getLastForAction as jest.Mock).mockResolvedValue(null);
  (syncEvents.createOrReuse as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'pending' });
  (syncEvents.markRunning as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'running' });
  (syncEvents.markRetryable as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'retryable' });
  (syncEvents.markSucceeded as jest.Mock).mockResolvedValue(undefined);
  (syncEvents.markFailed as jest.Mock).mockResolvedValue(undefined);
});

describe('MergeDetectionService', () => {
  describe('checkMergeStatus', () => {
    it('returns merged=true when PR state is MERGED', async () => {
      const result = await service.checkMergeStatus('/wt', 42);
      expect(result.merged).toBe(true);
      expect(result.state).toBe('merged');
      expect(result.mergeCommitSha).toBe('abc123');
    });

    it('returns merged=false when PR is open', async () => {
      execFileMock.mockImplementationOnce((_file: unknown, _args: unknown, _options: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, { stdout: JSON.stringify({ state: 'OPEN', mergeCommit: null, mergedAt: null }), stderr: '' });
      });
      const result = await service.checkMergeStatus('/wt', 42);
      expect(result.merged).toBe(false);
      expect(result.state).toBe('open');
    });

    it('returns merged=false when PR is closed (not merged)', async () => {
      execFileMock.mockImplementationOnce((_file: unknown, _args: unknown, _options: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, { stdout: JSON.stringify({ state: 'CLOSED', mergeCommit: null, mergedAt: null }), stderr: '' });
      });
      const result = await service.checkMergeStatus('/wt', 42);
      expect(result.merged).toBe(false);
      expect(result.state).toBe('closed');
    });

    it('treats unknown states as open', async () => {
      execFileMock.mockImplementationOnce((_file: unknown, _args: unknown, _options: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, { stdout: JSON.stringify({ state: 'DRAFT', mergeCommit: null, mergedAt: null }), stderr: '' });
      });
      const result = await service.checkMergeStatus('/wt', 42);
      expect(result.merged).toBe(false);
      expect(result.state).toBe('open');
    });

    it('throws 500 when gh call fails', async () => {
      execFileMock.mockImplementationOnce((_file: unknown, _args: unknown, _options: unknown, cb: (...args: unknown[]) => void) => {
        cb(new Error('gh not found'));
      });
      await expect(service.checkMergeStatus('/wt', 42)).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });
    });
  });

  describe('checkAndSync', () => {
    it('returns merged=false and skips Linear sync when PR is not merged', async () => {
      execFileMock.mockImplementationOnce((_file: unknown, _args: unknown, _options: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, { stdout: JSON.stringify({ state: 'OPEN', mergeCommit: null, mergedAt: null }), stderr: '' });
      });

      const result = await service.checkAndSync(baseInput);

      expect(result.merged).toBe(false);
      expect(result.state).toBe('open');
      expect(syncEvents.createOrReuse).not.toHaveBeenCalled();
    });

    it('returns merged=false for closed-unmerged PR and skips Linear sync', async () => {
      execFileMock.mockImplementationOnce((_file: unknown, _args: unknown, _options: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, { stdout: JSON.stringify({ state: 'CLOSED', mergeCommit: null, mergedAt: null }), stderr: '' });
      });

      const result = await service.checkAndSync(baseInput);

      expect(result.merged).toBe(false);
      expect(result.state).toBe('closed');
      expect(syncEvents.createOrReuse).not.toHaveBeenCalled();
    });

    it('throws 422 and skips SyncEvent when Linear token is missing', async () => {
      (config as any).linearToken = undefined;

      await expect(service.checkAndSync(baseInput)).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });

      expect(syncEvents.createOrReuse).not.toHaveBeenCalled();

      (config as any).linearToken = 'lin_api_test_token';
    });

    it('updates Linear issue to Done when PR is merged', async () => {
      (globalThis as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: { issue: { id: 'lin-issue-uuid', team: { id: 'team-1' } } } }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: { workflowStates: { nodes: [{ id: 'state-done', name: 'Done', type: 'completed' }, { id: 'state-todo', name: 'Todo', type: 'unstarted' }] } } }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: { issueUpdate: { success: true } } }) });

      const result = await service.checkAndSync(baseInput);

      expect(result.merged).toBe(true);
      expect(syncEvents.markSucceeded).toHaveBeenCalledWith('sync-1', 'lin-issue-uuid', baseInput.prUrl);
    });

    it('skips Linear update when SyncEvent already succeeded (idempotency)', async () => {
      (syncEvents.getLastForAction as jest.Mock).mockResolvedValue({
        status: 'succeeded',
        externalId: 'lin-issue-uuid',
        url: baseInput.prUrl,
      });

      const result = await service.checkAndSync(baseInput);

      expect(result.merged).toBe(true);
      expect(syncEvents.createOrReuse).not.toHaveBeenCalled();
    });

    it('recovers from a previously failed SyncEvent', async () => {
      (syncEvents.createOrReuse as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'failed' });
      (globalThis as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: { issue: { id: 'lin-issue-uuid', team: { id: 'team-1' } } } }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: { workflowStates: { nodes: [{ id: 'state-done', name: 'Done', type: 'completed' }] } } }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: { issueUpdate: { success: true } } }) });

      await service.checkAndSync(baseInput);

      expect(syncEvents.markRetryable).toHaveBeenCalledWith('sync-1');
      expect(syncEvents.markRunning).toHaveBeenCalledWith('sync-1');
      expect(syncEvents.markSucceeded).toHaveBeenCalledWith('sync-1', 'lin-issue-uuid', baseInput.prUrl);
    });

    it('throws 500 when Linear API call fails during sync', async () => {
      (globalThis as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ errors: [{ message: 'Unauthorized' }] }),
      });

      await expect(service.checkAndSync(baseInput)).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });

      expect(syncEvents.markFailed).toHaveBeenCalledWith('sync-1', 'unknown_error', expect.any(String));
    });

    it('short-circuits when createOrReuse returns already-succeeded record (race)', async () => {
      (syncEvents.createOrReuse as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'succeeded' });

      const result = await service.checkAndSync(baseInput);

      expect(result.merged).toBe(true);
      expect(syncEvents.markRunning).not.toHaveBeenCalled();
      expect(syncEvents.markSucceeded).not.toHaveBeenCalled();
    });
  });
});
