import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpTransportDeclaration } from '../registry/mcp-registry.schema';
import {
  McpTransportError,
  McpTransportRuntimeOptions,
  SdkBackedMcpTransport
} from './mcp-transport.types';

type StreamableHttpDeclaration = Extract<McpTransportDeclaration, { kind: 'streamable_http' }>;
type HttpDeclaration = Extract<McpTransportDeclaration, { kind: 'streamable_http' | 'legacy_sse' }>;
type HttpRuntimeOptions = McpTransportRuntimeOptions & { fetch?: FetchLike };

export function buildHttpRequestInit(
  declaration: HttpDeclaration,
  options: Pick<McpTransportRuntimeOptions, 'env'> = {}
): RequestInit {
  return {
    headers: selectAllowlistedHeaders(declaration.headersEnvAllowlist, options.env ?? process.env)
  };
}

export function selectAllowlistedHeaders(
  allowlist: string[] | undefined,
  env: Record<string, string | undefined>
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of allowlist ?? []) {
    assertSafeHeaderName(name);
    const value = env[name];
    if (typeof value === 'string') {
      selected[name] = value;
    }
  }
  return selected;
}

export function parseHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new McpTransportError('invalid_config');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpTransportError('invalid_config');
  }
  return parsed;
}

export class StreamableHttpMcpTransport extends SdkBackedMcpTransport {
  private readonly url: URL;

  constructor(
    private readonly httpDeclaration: StreamableHttpDeclaration,
    private readonly httpOptions: HttpRuntimeOptions = {}
  ) {
    const url = parseHttpUrl(httpDeclaration.url);
    super('streamable_http', httpDeclaration, httpOptions);
    this.url = url;
  }

  protected createSdkTransport(): Transport {
    return new StreamableHTTPClientTransport(this.url, {
      requestInit: buildHttpRequestInit(this.httpDeclaration, { env: this.env }),
      fetch: this.httpOptions.fetch
    });
  }
}

function assertSafeHeaderName(name: string): void {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new McpTransportError('invalid_config');
  }
}
