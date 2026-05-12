import { SyncEventService } from './sync-event.service';

const mockPrisma = {
  syncEvent: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
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

  describe('createOrReuse', () => {
    it('returns existing event when unique key matches', async () => {
      const existing = fakeEvent();
      mockPrisma.syncEvent.findUnique.mockResolvedValue(existing);

      const result = await service.createOrReuse({
        taskId: 'task-1', provider: 'github', action: 'create_pr', targetId: '5',
      });

      expect(result).toBe(existing);
      expect(mockPrisma.syncEvent.create).not.toHaveBeenCalled();
    });

    it('creates a new event when no existing match', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(null);
      mockPrisma.syncEvent.create.mockResolvedValue(fakeEvent());

      const result = await service.createOrReuse({
        taskId: 'task-1', provider: 'github', action: 'create_pr', targetId: '5',
      });

      expect(mockPrisma.syncEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: 'task-1', provider: 'github', action: 'create_pr', targetId: '5', status: 'pending',
        }),
      });
      expect(result.status).toBe('pending');
    });
  });

  describe('state transitions', () => {
    it('markRunning transitions from pending to running', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(fakeEvent({ status: 'pending' }));
      mockPrisma.syncEvent.update.mockResolvedValue(fakeEvent({ status: 'running' }));

      const result = await service.markRunning('evt-1');
      expect(result.status).toBe('running');
    });

    it('markSucceeded transitions from running to succeeded', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(fakeEvent({ status: 'running' }));
      mockPrisma.syncEvent.update.mockResolvedValue(fakeEvent({ status: 'succeeded', externalId: '42', url: 'https://pr.com/42' }));

      const result = await service.markSucceeded('evt-1', '42', 'https://pr.com/42');
      expect(result.status).toBe('succeeded');
      expect(mockPrisma.syncEvent.update).toHaveBeenCalledWith({
        where: { id: 'evt-1' },
        data: { status: 'succeeded', externalId: '42', url: 'https://pr.com/42' },
      });
    });

    it('markFailed transitions from running to failed', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(fakeEvent({ status: 'running' }));
      mockPrisma.syncEvent.update.mockResolvedValue(fakeEvent({ status: 'failed', errorCategory: 'auth_failed', errorMessage: 'Bad credentials' }));

      const result = await service.markFailed('evt-1', 'auth_failed', 'Bad credentials');
      expect(result.status).toBe('failed');
      expect(result.errorCategory).toBe('auth_failed');
    });

    it('markRetryable transitions from running to retryable', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(fakeEvent({ status: 'running' }));
      mockPrisma.syncEvent.update.mockResolvedValue(fakeEvent({ status: 'retryable' }));

      const result = await service.markRetryable('evt-1');
      expect(result.status).toBe('retryable');
    });

    it('markRetryable to running is valid (retry cycle)', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(fakeEvent({ status: 'retryable' }));
      mockPrisma.syncEvent.update.mockResolvedValue(fakeEvent({ status: 'running' }));

      const result = await service.markRunning('evt-1');
      expect(result.status).toBe('running');
    });

    it('markSkipped transitions from pending to skipped', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(fakeEvent({ status: 'pending' }));
      mockPrisma.syncEvent.update.mockResolvedValue(fakeEvent({ status: 'skipped' }));

      const result = await service.markSkipped('evt-1');
      expect(result.status).toBe('skipped');
    });

    it('rejects illegal transition from succeeded to running', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(fakeEvent({ status: 'succeeded' }));

      await expect(service.markRunning('evt-1')).rejects.toThrow('Invalid SyncEvent transition');
    });

    it('rejects illegal transition from skipped to running', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(fakeEvent({ status: 'skipped' }));

      await expect(service.markRunning('evt-1')).rejects.toThrow('Invalid SyncEvent transition');
    });

    it('rejects illegal transition from failed to succeeded', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(fakeEvent({ status: 'failed' }));

      await expect(service.markSucceeded('evt-1')).rejects.toThrow('Invalid SyncEvent transition');
    });

    it('throws when event not found', async () => {
      mockPrisma.syncEvent.findUnique.mockResolvedValue(null);

      await expect(service.markRunning('nonexistent')).rejects.toThrow('SyncEvent nonexistent not found');
    });
  });

  describe('listForTask', () => {
    it('returns ordered sync events for a task', async () => {
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
});
