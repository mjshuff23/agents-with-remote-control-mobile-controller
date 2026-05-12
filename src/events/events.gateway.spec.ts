import { EventsGateway } from './events.gateway';

const makeConfig = (secret?: string) =>
  ({ controllerSecret: secret }) as any;

const makeServer = () => {
  const room = { emit: jest.fn() };
  return { to: jest.fn(() => room), _room: room };
};

const makeLedger = () => ({
  append: jest.fn(async (input) => ({
    id: 'event-1',
    seq: 1,
    taskId: input.taskId,
    sessionId: input.options?.sessionId,
    name: input.name,
    kind: input.kind,
    severity: input.severity,
    correlationId: input.options?.correlationId,
    at: '2026-05-11T12:00:00.000Z',
    data: input.data
  })),
  replay: jest.fn(async () => ({
    events: [
      {
        id: 'event-2',
        seq: 2,
        taskId: 'task-abc',
        name: 'approval.requested',
        kind: 'approval',
        severity: 'warn',
        at: '2026-05-11T12:00:01.000Z',
        data: { id: 'approval-1' }
      }
    ],
    logs: [
      {
        id: 'log-2',
        sessionId: 'session-1',
        type: 'stdout',
        sequence: 2,
        content: 'missed output',
        createdAt: new Date('2026-05-11T12:00:02.000Z')
      }
    ]
  }))
});

describe('EventsGateway', () => {
  describe('handleConnection', () => {
    it('disconnects client when secret is set and token is wrong', () => {
      const gw = new EventsGateway(makeConfig('s3cret'));
      const client = { handshake: { auth: { token: 'wrong' } }, disconnect: jest.fn() } as any;
      gw.handleConnection(client);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('allows connection when token matches secret', () => {
      const gw = new EventsGateway(makeConfig('s3cret'));
      const client = { handshake: { auth: { token: 's3cret' } }, disconnect: jest.fn() } as any;
      gw.handleConnection(client);
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects all connections when no secret is configured', () => {
      // Absent secret → deny-all: prevents open WS access if env var is forgotten
      const gw = new EventsGateway(makeConfig(undefined));
      const client = { handshake: { auth: { token: 'anything' } }, disconnect: jest.fn() } as any;
      gw.handleConnection(client);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('subscribe', () => {
    it('joins client to task room', () => {
      const gw = new EventsGateway(makeConfig());
      const client = { join: jest.fn() } as any;
      gw.subscribe(client, { taskId: 'task-abc' });
      expect(client.join).toHaveBeenCalledWith('task:task-abc');
    });

    it('returns missed durable events and logs after requested cursors', async () => {
      const ledger = makeLedger();
      const gw = new EventsGateway(makeConfig(), ledger as any);
      const client = { join: jest.fn() } as any;

      const result = await gw.subscribe(client, {
        taskId: 'task-abc',
        afterEventSeq: 1,
        afterLogSequence: 1
      });

      expect(client.join).toHaveBeenCalledWith('task:task-abc');
      expect(ledger.replay).toHaveBeenCalledWith({
        taskId: 'task-abc',
        afterEventSeq: 1,
        afterLogSequence: 1,
        limit: undefined
      });
      expect(result).toEqual({
        ok: true,
        replay: expect.objectContaining({
          events: [expect.objectContaining({ seq: 2, name: 'approval.requested' })],
          logs: [expect.objectContaining({ sequence: 2, content: 'missed output' })]
        })
      });
    });

    it('leaves task room on unsubscribe', () => {
      const gw = new EventsGateway(makeConfig());
      const client = { leave: jest.fn() } as any;
      gw.unsubscribe(client, { taskId: 'task-abc' });
      expect(client.leave).toHaveBeenCalledWith('task:task-abc');
    });
  });

  describe('emitToTask', () => {
    it('emits event to the task room', () => {
      const gw = new EventsGateway(makeConfig());
      const server = makeServer();
      (gw as any).server = server;
      gw.emitToTask('task-1', 'agent.log', { content: 'hello' });
      expect(server.to).toHaveBeenCalledWith('task:task-1');
      expect(server._room.emit).toHaveBeenCalledWith('agent.log', { content: 'hello' });
    });

    it('is a no-op when server is not yet initialised', () => {
      const gw = new EventsGateway(makeConfig());
      // server is undefined before afterInit fires
      expect(() => gw.emitToTask('task-1', 'agent.log', {})).not.toThrow();
    });
  });

  describe('emitEnvelopeToTask', () => {
    it('persists the envelope and emits the persisted cursor to the task room', async () => {
      const ledger = makeLedger();
      const gw = new EventsGateway(makeConfig(), ledger as any);
      const server = makeServer();
      (gw as any).server = server;

      const envelope = await gw.emitEnvelopeToTask(
        'task-1',
        'approval.requested',
        'approval',
        'warn',
        { id: 'approval-1' },
        { sessionId: 'session-1', correlationId: 'request-1' }
      );

      expect(ledger.append).toHaveBeenCalledWith({
        taskId: 'task-1',
        name: 'approval.requested',
        kind: 'approval',
        severity: 'warn',
        data: { id: 'approval-1' },
        options: { sessionId: 'session-1', correlationId: 'request-1' }
      });
      expect(server._room.emit).toHaveBeenCalledWith('approval.requested', envelope);
      expect(envelope?.seq).toBe(1);
    });
  });
});
