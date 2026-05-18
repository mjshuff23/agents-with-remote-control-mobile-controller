import { buildHttpRequestInit } from './streamable-http-mcp-transport';
import { StreamableHttpMcpTransport } from './streamable-http-mcp-transport';
import { LegacySseMcpTransport, buildLegacySseTransportOptions } from './legacy-sse-mcp-transport';

describe('HTTP MCP transports', () => {
  it('passes only allowlisted env-derived headers', () => {
    const init = buildHttpRequestInit({
      kind: 'streamable_http',
      url: 'http://127.0.0.1:3000/mcp',
      headersEnvAllowlist: ['ARC_MCP_TOKEN', 'ARC_MISSING']
    }, {
      env: {
        ARC_MCP_TOKEN: 'secret-token',
        ARC_OTHER_SECRET: 'must-not-pass'
      }
    });

    expect(init.headers).toEqual({ ARC_MCP_TOKEN: 'secret-token' });
  });

  it('rejects invalid HTTP URLs', () => {
    expect(() => new StreamableHttpMcpTransport({
      kind: 'streamable_http',
      url: 'file:///tmp/socket'
    })).toThrow(/invalid_config/);

    expect(() => new LegacySseMcpTransport({
      kind: 'legacy_sse',
      url: 'not a url'
    })).toThrow(/invalid_config/);
  });

  it('blocks direct Streamable HTTP tool execution until permission and approval layers exist', async () => {
    const transport = new StreamableHttpMcpTransport({
      kind: 'streamable_http',
      url: 'http://127.0.0.1:3000/mcp'
    });

    await expect(transport.callTool('anything', {})).rejects.toMatchObject({
      category: 'execution_blocked'
    });
  });

  it('blocks direct legacy SSE tool execution until permission and approval layers exist', async () => {
    const transport = new LegacySseMcpTransport({
      kind: 'legacy_sse',
      url: 'http://127.0.0.1:3000/mcp'
    });

    await expect(transport.callTool('anything', {})).rejects.toMatchObject({
      category: 'execution_blocked'
    });
  });

  it('passes custom legacy SSE fetch at the top level so all requests use it', () => {
    const fetch = jest.fn();
    const options = buildLegacySseTransportOptions({
      kind: 'legacy_sse',
      url: 'http://127.0.0.1:3000/mcp',
      headersEnvAllowlist: ['ARC_MCP_TOKEN']
    }, {
      env: { ARC_MCP_TOKEN: 'secret-token' },
      fetch
    });

    expect(options.fetch).toBe(fetch);
    expect(options.requestInit).toEqual({ headers: { ARC_MCP_TOKEN: 'secret-token' } });
    expect(options.eventSourceInit).toBeUndefined();
  });
});
