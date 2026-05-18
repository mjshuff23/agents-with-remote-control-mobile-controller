import { createServer, Server as HttpServer, IncomingMessage, ServerResponse } from 'http';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import { once } from 'events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioMcpTransport } from './stdio-mcp-transport';
import { StreamableHttpMcpTransport } from './streamable-http-mcp-transport';
import { LegacySseMcpTransport } from './legacy-sse-mcp-transport';

function registerFixtureTool(server: McpServer, name: string): void {
  server.registerTool(name, {
    description: 'fixture tool used for listTools handshake tests'
  }, async () => ({
    content: [{ type: 'text', text: 'not called by TSH-113 transports' }]
  }));
}

async function listen(server: HttpServer): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected TCP test server address');
  }
  return `http://127.0.0.1:${address.port}`;
}

describe('MCP transport integrations', () => {
  let tmp: string;
  const servers: HttpServer[] = [];

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(process.cwd(), '.tmp-arc-mcp-transport-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('simulates a stdio server handshake with a controlled fixture and allowlisted env', async () => {
    const fixturePath = path.join(tmp, 'stdio-fixture.mjs');
    await writeFile(fixturePath, `
      import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
      import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

      const server = new McpServer({ name: 'stdio-fixture', version: '1.0.0' });
      const toolName = process.env.ARC_ALLOWED === 'allowed-value' && !process.env.ARC_SECRET
        ? 'stdio_env_ok'
        : 'stdio_env_bad';
      server.registerTool(toolName, { description: 'env probe' }, async () => ({
        content: [{ type: 'text', text: 'not called' }]
      }));
      await server.connect(new StdioServerTransport());
    `);

    const transport = new StdioMcpTransport({
      kind: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      envAllowlist: ['ARC_ALLOWED']
    }, {
      env: {
        ARC_ALLOWED: 'allowed-value',
        ARC_SECRET: 'must-not-pass'
      },
      connectTimeoutMs: 2000,
      requestTimeoutMs: 2000
    });

    await transport.connect();
    const tools = await transport.listTools();
    await transport.close();

    expect(tools.map((tool) => tool.name)).toContain('stdio_env_ok');
    expect(tools.map((tool) => tool.name)).not.toContain('stdio_env_bad');
  });

  it('simulates a Streamable HTTP request/response with a local test server', async () => {
    const server = createServer(async (req, res) => {
      const mcpServer = new McpServer({ name: 'streamable-fixture', version: '1.0.0' });
      registerFixtureTool(mcpServer, 'streamable_tool');
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      res.on('close', () => {
        transport.close();
        mcpServer.close();
      });
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const transport = new StreamableHttpMcpTransport({
      kind: 'streamable_http',
      url: `${baseUrl}/mcp`
    }, {
      connectTimeoutMs: 2000,
      requestTimeoutMs: 2000
    });

    await transport.connect();
    const tools = await transport.listTools();
    await transport.close();

    expect(tools.map((tool) => tool.name)).toContain('streamable_tool');
  });

  it('simulates a legacy SSE handshake with a local test server', async () => {
    const transports = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && requestUrl.pathname === '/mcp') {
        const mcpServer = new McpServer({ name: 'legacy-sse-fixture', version: '1.0.0' });
        registerFixtureTool(mcpServer, 'legacy_sse_tool');
        const transport = new SSEServerTransport('/messages', res);
        transports.set(transport.sessionId, { transport, server: mcpServer });
        transport.onclose = () => {
          transports.delete(transport.sessionId);
        };
        await mcpServer.connect(transport);
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/messages') {
        const sessionId = requestUrl.searchParams.get('sessionId');
        const entry = sessionId ? transports.get(sessionId) : undefined;
        if (!entry) {
          res.writeHead(404).end('missing session');
          return;
        }
        await entry.transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404).end('not found');
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const transport = new LegacySseMcpTransport({
      kind: 'legacy_sse',
      url: `${baseUrl}/mcp`
    }, {
      connectTimeoutMs: 2000,
      requestTimeoutMs: 2000
    });

    await transport.connect();
    const tools = await transport.listTools();
    await transport.close();

    expect(tools.map((tool) => tool.name)).toContain('legacy_sse_tool');
  });
});
