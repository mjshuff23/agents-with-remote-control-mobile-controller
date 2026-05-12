import { SyncEventService } from './sync-event.service';

const mockPrisma = {
  syncEvent: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
};

describe('SyncEventService', () => {
  let service: SyncEventService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SyncEventService(mockPrisma as any);
  });

  const fakeEvent = (overrides: Record<string, unknown> = {}) => ({
    id: 'evt-1',
    taskId: 'task-1',
    sessionId: null,
    provider: 'github',
    action: 'create_pr',
    targetId: '5',
    status: 'pending',
    externalId: null,
    url: null,
    errorCategory: null,
    errorMessage: null,
    metadataJson: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  function mockCurrent(status: string): void {
    mockPrisma.syncEvent.findUnique.mockResolvedValueOnce(fakeEvent({ status }));
  }

  describe('createOrReuse', () => {
    it('creates a new event and returns it', async () => {
      const created = fakeEvent();
      mockPrisma.syncEvent.create.mockResolvedValue(created);

      const result = await service.createOrReuse({
        taskId: 'task-1', provider: 'github', action: 'create_pr', targetId: '5',
      });

      expect(result).toBe(created);
      expect(mockPrisma.syncEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: 'task-1', provider: 'github', action: 'create_pr', targetId: '5', status: 'pending',
        }),
      });
    });

    it('recovers and returns existing event on unique constraint race', async () => {
      const existing = fakeEvent();
      mockPrisma.syncEvent.create.mockRejectedValue(new Error('Unique constraint failed'));
      mockPrisma.syncEvent.findUnique.mockResolvedValue(existing);

      const result = await service.createOrReuse({
        taskId: 'task-1', provider: 'github', action: 'create_pr', targetId: '5',
      });

      expect(result).toBe(existing);
    });

    it('re-throws if findUnique also fails after constraint error', async () => {
      mockPrisma.syncEvent.create.mockRejectedValue(new Error('Unique constraint failed'));
      mockPrisma.syncEvent.findUnique.mockResolvedValue(null);

      await expect(service.createOrReuse({
        taskId: 'task-1', provider: 'github', action: 'create_pr', targetId: '5',
      })).rejects.toThrow('Unique constraint failed');
    });
  });

  describe('state transitions', () => {
    it('markRunning transitions from pending to running', async () => {
      mockCurrent('pending');
      mockPrisma.syncEvent.updateMany.mockResolvedValue({ count: 1 });
      mockCurrent('running');

      const result = await service.markRunning('evt-1');
      expect(result.status).toBe('running');
      expect(mockPrisma.syncEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt-1', status: 'pending' },
        data: { status: 'running' },
      });
    });

    it('markSucceeded transitions from running to succeeded', async () => {
      mockCurrent('running');
      mockPrisma.syncEvent.updateMany.mockResolvedValue({ count: 1 });
      mockCurrent('succeeded');

      const result = await service.markSucceeded('evt-1', '42', 'https://pr.com/42');
      expect(result.status).toBe('succeeded');
      expect(mockPrisma.syncEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt-1', status: 'running' },
        data: { status: 'succeeded', externalId: '42', url: 'https://pr.com/42' },
      });
    });

    it('markFailed transitions from running to failed', async () => {
      mockCurrent('running');
      mockPrisma.syncEvent.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.syncEvent.findUnique.mockResolvedValueOnce(fakeEvent({ status: 'failed', errorCategory: 'auth_failed', errorMessage: 'Bad credentials' }));

      const result = await service.markFailed('evt-1', 'auth_failed', 'Bad credentials');
      expect(result.status).toBe('failed');
      expect(result.errorCategory).toBe('auth_failed');
    });

    it('markRetryable transitions from running to retryable', async () => {
      mockCurrent('running');
      mockPrisma.syncEvent.updateMany.mockResolvedValue({ count: 1 });
      mockCurrent('retryable');

      const result = await service.markRetryable('evt-1');
      expect(result.status).toBe('retryable');
    });

    it('markRetryable to running is valid (retry cycle)', async () => {
      mockCurrent('retryable');
      mockPrisma.syncEvent.updateMany.mockResolvedValue({ count: 1 });
      mockCurrent('running');

      const result = await service.markRunning('evt-1');
      expect(result.status).toBe('running');
    });

    it('markSkipped transitions from pending to skipped', async () => {
      mockCurrent('pending');
      mockPrisma.syncEvent.updateMany.mockResolvedValue({ count: 1 });
      mockCurrent('skipped');

      const result = await service.markSkipped('evt-1');
      expect(result.status).toBe('skipped');
    });

    it('rejects illegal transition from succeeded to running', async () => {
      mockCurrent('succeeded');

      await expect(service.markRunning('evt-1')).rejects.toThrow('Invalid SyncEvent transition');
    });

    it('rejects illegal transition from succeeded to failed', async () => {
      mockCurrent('succeeded');

      await expect(service.markFailed('evt-1', 'err', 'msg')).rejects.toThrow('Invalid SyncEvent transition');
    });

    it('rejects illegal transition from skipped to running', async () => {
      mockCurrent('skipped');

      await expect(service.markRunning('evt-1')).rejects.toThrow('Invalid SyncEvent transition');
    });

    it('rejects illegal transition from skipped to failed', async () => {
      mockCurrent('skipped');

      await expect(service.markFailed('evt-1', 'err', 'msg')).rejects.toThrow('Invalid SyncEvent transition');
    });

    it('rejects illegal transition from failed to succeeded', async () => {
      mockCurrent('failed');

      await expect(service.markSucceeded('evt-1')).rejects.toThrow('Invalid SyncEvent transition');
    });

    it('rejects illegal transition from failed to running', async () => {
      mockCurrent('failed');

      await expect(service.markRunning('evt-1')).rejects.toThrow('Invalid SyncEvent transition');
    });

    it('rejects illegal transition from failed to retryable', async () => {
      mockCurrent('failed');

      await expect(service.markRetryable('evt-1')).rejects.toThrow('Invalid SyncEvent transition');
    });

    it('throws when event not found', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(null);

      await expect(service.markRunning('nonexistent')).rejects.toThrow('SyncEvent nonexistent not found');
    });

    it('throws when event has unknown status', async () => {
      mockCurrent('bogus');

      await expect(service.markRunning('evt-1')).rejects.toThrow('has unknown status');
    });

    it('detects concurrent status change during transition', async () => {
      mockCurrent('pending');
      mockPrisma.syncEvent.updateMany.mockResolvedValue({ count: 0 });
      mockCurrent('running');

      await expect(service.markRunning('evt-1')).rejects.toThrow('concurrent transition');
    });
  });

  describe('listForTask', () => {
    it('returns ordered sync events with default limit', async () => {
      const events = [fakeEvent({ id: 'evt-1' }), fakeEvent({ id: 'evt-2' })];
      mockPrisma.syncEvent.findMany.mockResolvedValue(events);

      const result = await service.listForTask('task-1');
      expect(result).toHaveLength(2);
      expect(mockPrisma.syncEvent.findMany).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    });

    it('accepts custom limit', async () => {
      mockPrisma.syncEvent.findMany.mockResolvedValue([]);

      await service.listForTask('task-1', 10);
      expect(mockPrisma.syncEvent.findMany).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
    });

    it('caps limit at 200', async () => {
      mockPrisma.syncEvent.findMany.mockResolvedValue([]);

      await service.listForTask('task-1', 500);
      expect(mockPrisma.syncEvent.findMany).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
    });

    it('falls back to default limit for invalid values', async () => {
      mockPrisma.syncEvent.findMany.mockResolvedValue([]);

      await service.listForTask('task-1', -1);
      expect(mockPrisma.syncEvent.findMany).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    });
  });

  describe('getLastForAction', () => {
    it('returns matching event by unique key', async () => {
      const event = fakeEvent();
      mockPrisma.syncEvent.findUnique.mockResolvedValue(event);

      const result = await service.getLastForAction('task-1', 'github', 'create_pr', '5');
      expect(result).toBe(event);
      expect(mockPrisma.syncEvent.findUnique).toHaveBeenCalledWith({
        where: {
          taskId_provider_targetId_action: { taskId: 'task-1', provider: 'github', targetId: '5', action: 'create_pr' },
        },
      });
    });

    it('returns null when no matching event', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(null);

      const result = await service.getLastForAction('task-1', 'github', 'create_pr', '999');
      expect(result).toBeNull();
    });
  });

  describe('errorMessage sanitization', () => {
    function mockTransitionSuccess(): void {
      mockCurrent('running');
      mockPrisma.syncEvent.updateMany.mockResolvedValue({ count: 1 });
      mockCurrent('failed');
    }

    it('redacts GitHub tokens', async () => {
      mockTransitionSuccess();

      await service.markFailed('evt-1', 'auth_failed', 'token was ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

      expect(mockPrisma.syncEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            errorMessage: expect.not.stringContaining('ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
          }),
        }),
      );
    });

    it('redacts env var patterns', async () => {
      mockTransitionSuccess();

      await service.markFailed('evt-1', 'auth_failed', 'check ${ARC_LINEAR_API_KEY}');

      expect(mockPrisma.syncEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            errorMessage: expect.stringContaining('[REDACTED]'),
          }),
        }),
      );
    });

    it('preserves safe error messages', async () => {
      mockTransitionSuccess();

      await service.markFailed('evt-1', 'network_error', 'Connection refused: API endpoint unreachable');

      expect(mockPrisma.syncEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            errorMessage: 'Connection refused: API endpoint unreachable',
          }),
        }),
      );
    });
  });
});
