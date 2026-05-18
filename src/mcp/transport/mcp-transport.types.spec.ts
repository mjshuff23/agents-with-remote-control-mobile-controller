import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpTransportError, SdkBackedMcpTransport, withMcpTimeout } from './mcp-transport.types';

class HandshakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if ('id' in message && 'method' in message && message.method === 'initialize') {
      queueMicrotask(() => this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'test-server', version: '1.0.0' }
        }
      }));
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

class CountingTransport extends SdkBackedMcpTransport {
  created = 0;

  constructor() {
    super('streamable_http', { kind: 'streamable_http', url: 'http://127.0.0.1/mcp' });
  }

  protected createSdkTransport(): Transport {
    this.created += 1;
    return new HandshakeTransport();
  }
}

class ThrowingTransport extends SdkBackedMcpTransport {
  constructor() {
    super('streamable_http', { kind: 'streamable_http', url: 'http://127.0.0.1/mcp' });
  }

  protected createSdkTransport(): Transport {
    throw new Error('secret transport config detail');
  }
}

describe('MCP transport shared helpers', () => {
  it('normalizes timeout failures into safe categories', async () => {
    await expect(withMcpTimeout(new Promise(() => undefined), 5, 'request_timeout')).rejects.toMatchObject({
      category: 'request_timeout'
    });
  });

  it('does not expose raw cause messages through transport error messages', () => {
    const cause = new Error('secret-token-value');
    const error = McpTransportError.from('connection_failed', cause);

    expect(error.message).toBe('MCP transport failed: connection_failed');
    expect(error.message).not.toContain('secret-token-value');
    expect(error.cause).toBe(cause);
  });

  it('shares an in-flight SDK connection when connect is called concurrently', async () => {
    const transport = new CountingTransport();

    await Promise.all([transport.connect(), transport.connect()]);

    expect(transport.created).toBe(1);
  });

  it('normalizes synchronous SDK transport creation failures', async () => {
    await expect(new ThrowingTransport().connect()).rejects.toMatchObject({
      category: 'invalid_config',
      message: 'MCP transport failed: invalid_config'
    });
  });
});
