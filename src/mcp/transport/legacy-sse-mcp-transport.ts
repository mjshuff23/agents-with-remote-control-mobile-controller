import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpTransportDeclaration } from '../registry/mcp-registry.schema';
import {
  McpTransportRuntimeOptions,
  SdkBackedMcpTransport
} from './mcp-transport.types';
import { buildHttpRequestInit, parseHttpUrl } from './streamable-http-mcp-transport';

type LegacySseDeclaration = Extract<McpTransportDeclaration, { kind: 'legacy_sse' }>;
type LegacySseRuntimeOptions = McpTransportRuntimeOptions & { fetch?: FetchLike };

export class LegacySseMcpTransport extends SdkBackedMcpTransport {
  private readonly url: URL;

  constructor(
    private readonly sseDeclaration: LegacySseDeclaration,
    private readonly sseOptions: LegacySseRuntimeOptions = {}
  ) {
    const url = parseHttpUrl(sseDeclaration.url);
    super('legacy_sse', sseDeclaration, sseOptions);
    this.url = url;
  }

  protected createSdkTransport(): Transport {
    const requestInit = buildHttpRequestInit(this.sseDeclaration, { env: this.env });
    return new SSEClientTransport(this.url, {
      requestInit,
      eventSourceInit: {
        fetch: this.sseOptions.fetch
          ? (url, init) => this.sseOptions.fetch!(url, { ...init, ...requestInit })
          : undefined
      }
    });
  }
}
