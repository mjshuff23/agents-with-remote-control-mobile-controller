import { StdioMcpTransport, buildStdioServerParameters } from './stdio-mcp-transport';

describe('StdioMcpTransport', () => {
  it.each(['node server.js', 'node;rm', 'node|cat', 'node&&cat', 'node`whoami`', 'node $(whoami)'])(
    'rejects shell-like command strings: %s',
    (command) => {
      expect(() => new StdioMcpTransport({ kind: 'stdio', command })).toThrow(/invalid_config/);
    }
  );

  it('rejects args that attempt shell interpolation or pipe execution', () => {
    expect(() => new StdioMcpTransport({
      kind: 'stdio',
      command: 'node',
      args: ['fixture.js', '&&', 'echo secret']
    })).toThrow(/invalid_config/);
  });

  it('passes only allowlisted environment variables to stdio child processes', () => {
    const params = buildStdioServerParameters({
      kind: 'stdio',
      command: 'node',
      args: ['fixture.js'],
      envAllowlist: ['ARC_ALLOWED', 'ARC_MISSING']
    }, {
      env: {
        ARC_ALLOWED: 'allowed-value',
        ARC_SECRET: 'must-not-pass'
      }
    });

    expect(params.env).toEqual({ ARC_ALLOWED: 'allowed-value' });
  });

  it('blocks direct tool execution until permission and approval layers exist', async () => {
    const transport = new StdioMcpTransport({ kind: 'stdio', command: 'node' });

    await expect(transport.callTool('anything', {})).rejects.toMatchObject({
      category: 'execution_blocked'
    });
  });
});
