import { createMcpTransport } from './mcp-transport.factory';
import { LegacySseMcpTransport } from './legacy-sse-mcp-transport';
import { StdioMcpTransport } from './stdio-mcp-transport';
import { StreamableHttpMcpTransport } from './streamable-http-mcp-transport';

describe('createMcpTransport', () => {
  it('selects stdio transport by registry discriminant', () => {
    const transport = createMcpTransport({
      kind: 'stdio',
      command: 'node',
      args: ['server.js']
    });

    expect(transport).toBeInstanceOf(StdioMcpTransport);
    expect(transport.kind).toBe('stdio');
  });

  it('selects Streamable HTTP transport by registry discriminant', () => {
    const transport = createMcpTransport({
      kind: 'streamable_http',
      url: 'http://127.0.0.1:3000/mcp'
    });

    expect(transport).toBeInstanceOf(StreamableHttpMcpTransport);
    expect(transport.kind).toBe('streamable_http');
  });

  it('selects legacy SSE transport by registry discriminant', () => {
    const transport = createMcpTransport({
      kind: 'legacy_sse',
      url: 'http://127.0.0.1:3000/mcp'
    });

    expect(transport).toBeInstanceOf(LegacySseMcpTransport);
    expect(transport.kind).toBe('legacy_sse');
  });

  it('rejects unknown transport kinds', () => {
    expect(() => createMcpTransport({
      kind: 'websocket',
      url: 'ws://127.0.0.1:3000/mcp'
    } as never)).toThrow(/invalid_config/);
  });
});
