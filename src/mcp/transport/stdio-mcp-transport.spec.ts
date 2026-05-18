import { StdioMcpTransport, buildStdioServerParameters } from './stdio-mcp-transport';

describe('StdioMcpTransport', () => {
  it.each(['node server.js', 'node;rm', 'node|cat', 'node&&cat', 'node`whoami`', 'node $(whoami)'])(
    'rejects shell-like command strings: %s',
    (command) => {
      expect(() => new StdioMcpTransport({ kind: 'stdio', command })).toThrow(/invalid_config/);
    }
  );

  it.each([
    { command: 'bash', args: ['-c', 'echo secret'] },
    { command: '/bin/sh', args: ['-c', 'echo secret'] },
    { command: 'cmd.exe', args: ['/c', 'echo secret'] },
    { command: 'powershell.exe', args: ['-Command', 'Write-Host secret'] }
  ])('rejects shell interpreters with command execution flags: $command', ({ command, args }) => {
    expect(() => new StdioMcpTransport({ kind: 'stdio', command, args })).toThrow(/invalid_config/);
  });

  it('rejects args that attempt shell interpolation or pipe execution', () => {
    expect(() => new StdioMcpTransport({
      kind: 'stdio',
      command: 'node',
      args: ['fixture.js', '&&', 'echo secret']
    })).toThrow(/invalid_config/);
  });

  it('allows executable paths with spaces when they are still a single path', () => {
    const params = buildStdioServerParameters({
      kind: 'stdio',
      command: '/opt/Model Context/server',
      args: ['fixture.js']
    });

    expect(params.command).toBe('/opt/Model Context/server');
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
