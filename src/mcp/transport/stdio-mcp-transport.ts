import { StdioClientTransport, StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpTransportDeclaration } from '../registry/mcp-registry.schema';
import {
  McpTransportError,
  McpTransportRuntimeOptions,
  SdkBackedMcpTransport
} from './mcp-transport.types';

const SHELL_META_PATTERN = /[\n\r|;&<>`]|[$]\(/;

type StdioDeclaration = Extract<McpTransportDeclaration, { kind: 'stdio' }>;

export function buildStdioServerParameters(
  declaration: StdioDeclaration,
  options: Pick<McpTransportRuntimeOptions, 'env'> = {}
): StdioServerParameters {
  assertSafeExecutable(declaration.command);
  for (const arg of declaration.args ?? []) {
    assertSafeArg(arg);
  }

  return {
    command: declaration.command,
    args: declaration.args ? [...declaration.args] : undefined,
    cwd: declaration.cwd,
    env: selectAllowlistedEnv(declaration.envAllowlist, options.env ?? process.env),
    stderr: 'pipe'
  };
}

export function selectAllowlistedEnv(
  allowlist: string[] | undefined,
  env: Record<string, string | undefined>
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of allowlist ?? []) {
    assertSafeEnvName(name);
    const value = env[name];
    if (typeof value === 'string') {
      selected[name] = value;
    }
  }
  return selected;
}

export class StdioMcpTransport extends SdkBackedMcpTransport {
  constructor(
    private readonly stdioDeclaration: StdioDeclaration,
    options: McpTransportRuntimeOptions = {}
  ) {
    buildStdioServerParameters(stdioDeclaration, options);
    super('stdio', stdioDeclaration, options);
  }

  protected createSdkTransport(): Transport {
    return new StdioClientTransport(buildStdioServerParameters(this.stdioDeclaration, {
      env: this.env
    }));
  }
}

function assertSafeExecutable(command: string): void {
  if (!command.trim() || /\s/.test(command) || SHELL_META_PATTERN.test(command)) {
    throw new McpTransportError('invalid_config');
  }
}

function assertSafeArg(arg: string): void {
  if (SHELL_META_PATTERN.test(arg)) {
    throw new McpTransportError('invalid_config');
  }
}

function assertSafeEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new McpTransportError('invalid_config');
  }
}
