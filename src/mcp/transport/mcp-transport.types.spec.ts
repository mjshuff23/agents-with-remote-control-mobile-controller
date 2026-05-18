import { McpTransportError, withMcpTimeout } from './mcp-transport.types';

describe('MCP transport shared helpers', () => {
  it('normalizes timeout failures into safe categories', async () => {
    await expect(withMcpTimeout(new Promise(() => undefined), 5, 'request_timeout')).rejects.toMatchObject({
      category: 'request_timeout'
    });
  });

  it('does not expose raw cause messages through transport error messages', () => {
    const error = McpTransportError.from('connection_failed', new Error('secret-token-value'));

    expect(error.message).toBe('MCP transport failed: connection_failed');
    expect(error.message).not.toContain('secret-token-value');
  });
});
