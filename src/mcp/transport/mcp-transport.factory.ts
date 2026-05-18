import { Injectable } from '@nestjs/common';
import { McpTransportDeclaration } from '../registry/mcp-registry.schema';
import { LegacySseMcpTransport } from './legacy-sse-mcp-transport';
import { McpTransportClient, McpTransportError, McpTransportRuntimeOptions } from './mcp-transport.types';
import { StdioMcpTransport } from './stdio-mcp-transport';
import { StreamableHttpMcpTransport } from './streamable-http-mcp-transport';

export function createMcpTransport(
  declaration: McpTransportDeclaration,
  options: McpTransportRuntimeOptions = {}
): McpTransportClient {
  switch (declaration.kind) {
    case 'stdio':
      return new StdioMcpTransport(declaration, options);
    case 'streamable_http':
      return new StreamableHttpMcpTransport(declaration, options);
    case 'legacy_sse':
      return new LegacySseMcpTransport(declaration, options);
    default:
      throw new McpTransportError('invalid_config');
  }
}

@Injectable()
export class McpTransportFactory {
  create(
    declaration: McpTransportDeclaration,
    options: McpTransportRuntimeOptions = {}
  ): McpTransportClient {
    return createMcpTransport(declaration, options);
  }
}
