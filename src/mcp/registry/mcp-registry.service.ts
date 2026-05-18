import { Injectable } from '@nestjs/common';
import { readFile, stat } from 'fs/promises';
import * as path from 'path';
import { AppConfigService } from '../../config/app-config.service';
import {
  MCP_DEFAULT_PERMISSION_LEVEL,
  MCP_PERMISSION_LEVELS,
  MCP_REGISTRY_DEFAULT_FILENAME,
  MCP_TOOL_RISKS,
  MCP_TRANSPORT_KINDS,
  PHASE5_BLOCKED_PERMISSION_LEVELS,
  PHASE5_BLOCKED_TOOL_RISKS
} from './mcp-registry.config';
import {
  McpPermissionLevel,
  McpRegistryConfig,
  McpServerRegistration,
  McpToolDeclaration,
  McpTransportDeclaration
} from './mcp-registry.schema';

/** Loads, caches, and validates the MCP registry config file (arc.mcp.json). */
@Injectable()
export class McpRegistryService {
  private cached?: { servers: McpServerRegistration[]; mtimeMs: number; resolvedPath: string };

  constructor(private readonly config: AppConfigService) {}

  /**
   * Return all registered MCP servers.
   * Returns an empty array if no registry path is configured or the file does not exist.
   * Throws on malformed config or Phase-5 policy violations.
   */
  async loadAll(): Promise<McpServerRegistration[]> {
    const resolvedPath = this.resolveRegistryPath();
    if (!resolvedPath) {
      return [];
    }

    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(resolvedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    if (
      this.cached &&
      this.cached.resolvedPath === resolvedPath &&
      this.cached.mtimeMs === fileStat.mtimeMs
    ) {
      return this.cloneServers(this.cached.servers);
    }

    const raw = await readFile(resolvedPath, 'utf8');
    let parsed: McpRegistryConfig;
    try {
      parsed = JSON.parse(raw) as McpRegistryConfig;
    } catch {
      throw new Error(`MCP registry config at ${resolvedPath} is not valid JSON`);
    }
    const servers = this.validateRegistry(parsed);
    this.cached = { servers, mtimeMs: fileStat.mtimeMs, resolvedPath };
    return this.cloneServers(servers);
  }

  /** Find a single registered server by its unique ID, or undefined if not found. */
  async findServer(id: string): Promise<McpServerRegistration | undefined> {
    const servers = await this.loadAll();
    return servers.find((s) => s.id === id);
  }

  /** Clear the in-memory cache so the next loadAll() re-reads from disk. */
  clearCache(): void {
    this.cached = undefined;
  }

  /** Resolve the absolute path to the registry file. */
  private resolveRegistryPath(): string | undefined {
    const configured = this.config.mcpRegistryPath;
    if (configured) {
      return path.isAbsolute(configured)
        ? configured
        : path.join(this.config.repoPath ?? '.', configured);
    }
    // Fall back to arc.mcp.json beside the repo root if repoPath is available.
    const repoPath = this.config.repoPath;
    if (!repoPath) {
      return undefined;
    }
    return path.join(repoPath, MCP_REGISTRY_DEFAULT_FILENAME);
  }

  /**
   * Validate the full registry config and return the normalized server list.
   * Throws descriptive Error instances on any policy or structural violation.
   * Error messages must not echo raw config values that could contain secrets.
   */
  private validateRegistry(config: McpRegistryConfig): McpServerRegistration[] {
    if (config.version !== 1) {
      throw new Error('MCP registry version must be 1');
    }
    if (!Array.isArray(config.servers)) {
      throw new Error('MCP registry servers must be an array');
    }

    const normalized: McpServerRegistration[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < config.servers.length; i++) {
      const server = this.validateServer(config.servers[i], i);
      if (seenIds.has(server.id)) {
        throw new Error(`MCP registry has duplicate server id at index ${i}`);
      }
      seenIds.add(server.id);
      normalized.push(server);
    }
    return normalized;
  }

  private validateServer(raw: unknown, index: number): McpServerRegistration {
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`MCP registry servers[${index}] must be an object`);
    }
    const entry = raw as Record<string, unknown>;

    // id — structural error: safe to name the field but not echo the raw value
    if (typeof entry.id !== 'string' || entry.id.trim().length === 0) {
      throw new Error(`MCP server at index ${index} must have a non-empty string id`);
    }
    const id = entry.id.trim();

    // displayName
    if (typeof entry.displayName !== 'string' || entry.displayName.trim().length === 0) {
      throw new Error(`MCP server at index ${index} must have a non-empty displayName`);
    }

    // transport
    if (!entry.transport || typeof entry.transport !== 'object') {
      throw new Error(`MCP server at index ${index} is missing required field: transport`);
    }
    const transport = this.validateTransport(entry.transport as Record<string, unknown>, index);

    // permissionLevel — missing defaults to read_only (fail-safe / least privilege).
    // Phase-5 policy violations use index only — never echo the raw id or field value.
    const rawLevel = entry.permissionLevel;
    let permissionLevel: McpPermissionLevel;
    if (rawLevel === undefined || rawLevel === null) {
      permissionLevel = MCP_DEFAULT_PERMISSION_LEVEL;
    } else if (typeof rawLevel !== 'string' || !MCP_PERMISSION_LEVELS.has(rawLevel as McpPermissionLevel)) {
      throw new Error(`MCP server at index ${index} has an invalid permissionLevel — must be read_only, append_only, or write`);
    } else if (PHASE5_BLOCKED_PERMISSION_LEVELS.has(rawLevel as McpPermissionLevel)) {
      throw new Error(`MCP server at index ${index} declared permissionLevel "admin" which is blocked in Phase 5`);
    } else {
      permissionLevel = rawLevel as McpPermissionLevel;
    }

    // canReadSecrets — must be false; true is a hard Phase 5 violation
    if (entry.canReadSecrets === true) {
      throw new Error(`MCP server at index ${index} has canReadSecrets: true which is not permitted in Phase 5`);
    }

    // tools — required field, must be an array
    if (!Array.isArray(entry.tools)) {
      throw new Error(`MCP server at index ${index} is missing required field: tools (must be an array)`);
    }
    const tools = this.validateTools(entry.tools as unknown[], index);

    return {
      id,
      displayName: (entry.displayName as string).trim(),
      enabled: entry.enabled !== false,
      transport,
      permissionLevel,
      tools,
      canReadSecrets: false,
      createdBy: entry.createdBy === 'runtime' ? 'runtime' : 'config'
    };
  }

  private validateTransport(raw: Record<string, unknown>, serverIndex: number): McpTransportDeclaration {
    const kind = raw.kind;
    if (typeof kind !== 'string' || !MCP_TRANSPORT_KINDS.has(kind as McpTransportDeclaration['kind'])) {
      throw new Error(
        `MCP server at index ${serverIndex} has an invalid transport.kind — must be stdio, streamable_http, or legacy_sse`
      );
    }

    if (kind === 'stdio') {
      if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
        throw new Error(`MCP server at index ${serverIndex} stdio transport is missing required field: command`);
      }
      return {
        kind: 'stdio',
        command: (raw.command as string).trim(),
        args: this.readOptionalStringArray(raw.args, 'args', serverIndex),
        cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        envAllowlist: this.readOptionalStringArray(raw.envAllowlist, 'envAllowlist', serverIndex)
      };
    }

    if (kind === 'streamable_http' || kind === 'legacy_sse') {
      if (typeof raw.url !== 'string' || raw.url.trim().length === 0) {
        throw new Error(`MCP server at index ${serverIndex} ${kind} transport is missing required field: url`);
      }
      return {
        kind,
        url: (raw.url as string).trim(),
        headersEnvAllowlist: this.readOptionalStringArray(raw.headersEnvAllowlist, 'headersEnvAllowlist', serverIndex)
      };
    }

    // TypeScript exhaustiveness guard — unreachable at runtime
    throw new Error(`MCP server at index ${serverIndex} has unhandled transport.kind`);
  }

  private readOptionalStringArray(value: unknown, fieldName: string, serverIndex: number): string[] | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (!Array.isArray(value) || value.some((el) => typeof el !== 'string')) {
      throw new Error(`MCP server at index ${serverIndex} field "${fieldName}" must be an array of strings`);
    }
    return value as string[];
  }

  private cloneServers(servers: McpServerRegistration[]): McpServerRegistration[] {
    return servers.map((server) => ({
      ...server,
      transport: this.cloneTransport(server.transport),
      tools: server.tools.map((tool) => ({
        ...tool,
        allowedArgumentPaths: tool.allowedArgumentPaths ? [...tool.allowedArgumentPaths] : undefined,
        blockedArgumentPaths: tool.blockedArgumentPaths ? [...tool.blockedArgumentPaths] : undefined
      }))
    }));
  }

  private cloneTransport(transport: McpTransportDeclaration): McpTransportDeclaration {
    if (transport.kind === 'stdio') {
      return {
        ...transport,
        args: transport.args ? [...transport.args] : undefined,
        envAllowlist: transport.envAllowlist ? [...transport.envAllowlist] : undefined
      };
    }
    return {
      ...transport,
      headersEnvAllowlist: transport.headersEnvAllowlist ? [...transport.headersEnvAllowlist] : undefined
    };
  }

  private validateTools(rawTools: unknown[], serverIndex: number): McpToolDeclaration[] {
    const seenNames = new Set<string>();
    const tools: McpToolDeclaration[] = [];

    for (let i = 0; i < rawTools.length; i++) {
      if (rawTools[i] === null || typeof rawTools[i] !== 'object') {
        throw new Error(`MCP server at index ${serverIndex} tool at index ${i} must be an object`);
      }
      const raw = rawTools[i] as Record<string, unknown>;

      if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
        throw new Error(`MCP server at index ${serverIndex} tool at index ${i} is missing a valid name`);
      }
      const name = raw.name.trim();

      if (seenNames.has(name)) {
        throw new Error(`MCP server at index ${serverIndex} has duplicate tool names`);
      }
      seenNames.add(name);

      const risk = raw.risk;
      if (typeof risk !== 'string' || !MCP_TOOL_RISKS.has(risk as McpToolDeclaration['risk'])) {
        throw new Error(
          `MCP server at index ${serverIndex} tool at index ${i} has an invalid risk level — must be read, append, or write`
        );
      }
      if (PHASE5_BLOCKED_TOOL_RISKS.has(risk as McpToolDeclaration['risk'])) {
        throw new Error(
          `MCP server at index ${serverIndex} tool at index ${i} declared a risk level blocked in Phase 5`
        );
      }

      tools.push({
        name,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        risk: risk as McpToolDeclaration['risk'],
        requiresApproval: raw.requiresApproval === true,
        allowedArgumentPaths: this.readOptionalStringArray(raw.allowedArgumentPaths, 'allowedArgumentPaths', serverIndex),
        blockedArgumentPaths: this.readOptionalStringArray(raw.blockedArgumentPaths, 'blockedArgumentPaths', serverIndex)
      });
    }

    return tools;
  }
}
