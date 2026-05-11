import { EventsGateway } from './events.gateway';

const makeConfig = (secret?: string) =>
  ({ controllerSecret: secret }) as any;

const makeServer = () => {
  const room = { emit: jest.fn() };
  return { to: jest.fn(() => room), _room: room };
};

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
});
