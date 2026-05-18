import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpTransportDeclaration, McpTransportKind } from '../registry/mcp-registry.schema';

export type McpTransportErrorCategory =
  | 'invalid_config'
  | 'connect_timeout'
  | 'request_timeout'
  | 'connection_failed'
  | 'protocol_error'
  | 'execution_blocked'
  | 'closed'
  | 'unknown';

export type McpTransportTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export type McpTransportRuntimeOptions = {
  env?: Record<string, string | undefined>;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  callToolTimeoutMs?: number;
};

export interface McpTransportClient {
  readonly kind: McpTransportKind;
  connect(): Promise<void>;
  listTools(): Promise<McpTransportTool[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<never>;
  close(): Promise<void>;
}

export class McpTransportError extends Error {
  constructor(
    readonly category: McpTransportErrorCategory,
    cause?: unknown
  ) {
    super(`MCP transport failed: ${category}`, { cause });
    this.name = 'McpTransportError';
  }

  static from(category: McpTransportErrorCategory, cause?: unknown): McpTransportError {
    if (cause instanceof McpTransportError) {
      return cause;
    }
    return new McpTransportError(category, cause);
  }
}

export async function withMcpTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  category: 'connect_timeout' | 'request_timeout'
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new McpTransportError(category)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export abstract class SdkBackedMcpTransport implements McpTransportClient {
  protected client?: Client;
  protected sdkTransport?: Transport;
  private connectPromise?: Promise<void>;

  protected constructor(
    readonly kind: McpTransportKind,
    protected readonly declaration: McpTransportDeclaration,
    protected readonly options: McpTransportRuntimeOptions = {}
  ) {}

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const client = new Client({ name: 'arc-orchestrator', version: '0.1.0' }, { capabilities: {} });
    const transport = this.createSdkTransport();

    this.connectPromise = (async () => {
      try {
        await withMcpTimeout(
          client.connect(transport, { timeout: this.connectTimeoutMs }),
          this.connectTimeoutMs,
          'connect_timeout'
        );
        this.client = client;
        this.sdkTransport = transport;
      } catch (error) {
        await this.closeSdkClient(client, transport);
        if (error instanceof McpTransportError) {
          throw error;
        }
        throw McpTransportError.from('connection_failed', error);
      } finally {
        this.connectPromise = undefined;
      }
    })();

    return this.connectPromise;
  }

  async listTools(): Promise<McpTransportTool[]> {
    if (!this.client) {
      throw new McpTransportError('closed');
    }

    try {
      const result = await withMcpTimeout(
        this.client.listTools(undefined, { timeout: this.requestTimeoutMs }),
        this.requestTimeoutMs,
        'request_timeout'
      );
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema
      }));
    } catch (error) {
      if (error instanceof McpTransportError) {
        throw error;
      }
      throw McpTransportError.from('protocol_error', error);
    }
  }

  async callTool(_name: string, _args?: Record<string, unknown>): Promise<never> {
    throw new McpTransportError('execution_blocked');
  }

  async close(): Promise<void> {
    if (this.connectPromise) {
      await this.connectPromise.catch(() => undefined);
    }
    await this.closeSdkClient(this.client, this.sdkTransport);
    this.client = undefined;
    this.sdkTransport = undefined;
  }

  protected get connectTimeoutMs(): number {
    return this.options.connectTimeoutMs ?? 5_000;
  }

  protected get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? 10_000;
  }

  protected get env(): Record<string, string | undefined> {
    return this.options.env ?? process.env;
  }

  protected abstract createSdkTransport(): Transport;

  private async closeSdkClient(client?: Client, transport?: Transport): Promise<void> {
    await Promise.allSettled([
      client?.close(),
      transport?.close()
    ]);
  }
}
