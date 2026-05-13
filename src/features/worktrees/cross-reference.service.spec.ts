import { HttpStatus, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { SyncEventService } from '../sync/sync-event.service';
import { CrossReferenceService } from './cross-reference.service';

const config = {
  linearToken: 'lin_api_test_token_12345678901234567890',
} as unknown as AppConfigService;

const syncEvents = {
  getLastForAction: jest.fn(),
  createOrReuse: jest.fn(),
  markRunning: jest.fn(),
  markSucceeded: jest.fn(),
  markFailed: jest.fn(),
  markRetryable: jest.fn(),
} as unknown as SyncEventService;

const service = new CrossReferenceService(config, syncEvents);

const baseInput = {
  taskId: 'task-1',
  prUrl: 'https://github.com/owner/repo/pull/42',
  prNumber: 42,
  linearIssueId: 'lin-issue-uuid-123',
  linearIssueKey: 'TSH-105',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

  (syncEvents.getLastForAction as jest.Mock).mockResolvedValue(null);
  (syncEvents.createOrReuse as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'pending' });
  (syncEvents.markRunning as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'running' });
  (syncEvents.markRetryable as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'retryable' });
  (syncEvents.markSucceeded as jest.Mock).mockResolvedValue(undefined);
  (syncEvents.markFailed as jest.Mock).mockResolvedValue(undefined);
});

describe('CrossReferenceService', () => {
  describe('syncPrToLinear', () => {
    it('skips when SyncEvent already has succeeded status with matching URL (idempotency)', async () => {
      (syncEvents.getLastForAction as jest.Mock).mockResolvedValue({
        status: 'succeeded',
        externalId: 'att-1',
        url: 'https://github.com/owner/repo/pull/42',
      });

      await service.syncPrToLinear(baseInput);

      expect(syncEvents.createOrReuse).not.toHaveBeenCalled();
    });

    it('recovers from a previously failed SyncEvent via markRetryable', async () => {
      (syncEvents.createOrReuse as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'failed' });

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            attachmentCreate: {
              success: true,
              attachment: { id: 'att-789' },
            },
          },
        }),
      });
      (globalThis as any).fetch = mockFetch;

      await service.syncPrToLinear(baseInput);

      expect(syncEvents.markRetryable).toHaveBeenCalledWith('sync-1');
      expect(syncEvents.markRunning).toHaveBeenCalledWith('sync-1');
      expect(syncEvents.markSucceeded).toHaveBeenCalledWith('sync-1', 'att-789', baseInput.prUrl);
    });

    it('short-circuits when createOrReuse returns already-succeeded record (race)', async () => {
      (syncEvents.createOrReuse as jest.Mock).mockResolvedValue({ id: 'sync-1', status: 'succeeded' });

      await service.syncPrToLinear(baseInput);

      expect(syncEvents.markRunning).not.toHaveBeenCalled();
      expect(syncEvents.markSucceeded).not.toHaveBeenCalled();
    });

    it('throws 422 when Linear token is not configured', async () => {
      (config as any).linearToken = undefined;

      await expect(service.syncPrToLinear(baseInput)).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });

      (config as any).linearToken = 'lin_api_test_token_12345678901234567890';
    });

    it('calls Linear GraphQL API and marks SyncEvent as succeeded', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            attachmentCreate: {
              success: true,
              attachment: { id: 'att-789' },
            },
          },
        }),
      });
      (globalThis as any).fetch = mockFetch;

      await service.syncPrToLinear(baseInput);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.linear.app/graphql',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer lin_api_test_token_12345678901234567890',
          }),
        }),
      );
      expect(syncEvents.markSucceeded).toHaveBeenCalledWith('sync-1', 'att-789', baseInput.prUrl);
    });

    it('records failure to SyncEvent and throws when Linear API returns errors', async () => {
      (globalThis as any).fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          errors: [{ message: 'Authentication required' }],
        }),
      });

      await expect(service.syncPrToLinear(baseInput)).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });

      expect(syncEvents.markFailed).toHaveBeenCalledWith('sync-1', 'unknown_error', expect.any(String));
    });

    it('records failure to SyncEvent and throws when API returns success: false', async () => {
      (globalThis as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            attachmentCreate: {
              success: false,
            },
          },
        }),
      });

      await expect(service.syncPrToLinear(baseInput)).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });

      expect(syncEvents.markFailed).toHaveBeenCalledWith('sync-1', 'unknown_error', expect.any(String));
    });

    it('records failure to SyncEvent and throws when fetch throws', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      await expect(service.syncPrToLinear(baseInput)).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });

      expect(syncEvents.markFailed).toHaveBeenCalledWith('sync-1', 'unknown_error', expect.any(String));
    });
  });
});
