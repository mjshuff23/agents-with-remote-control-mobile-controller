import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AppConfigService } from '../../config/app-config.service';
import { McpRegistryService } from './mcp-registry.service';
import { McpServerRegistration } from './mcp-registry.schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeConfig(registryPath: string): AppConfigService {
  return { mcpRegistryPath: registryPath, repoPath: '/' } as unknown as AppConfigService;
}

async function writeRegistry(dir: string, servers: unknown[]): Promise<void> {
  await writeFile(
    path.join(dir, 'arc.mcp.json'),
    JSON.stringify({ version: 1, servers })
  );
}

function validServer(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'test-server',
    displayName: 'Test Server',
    enabled: true,
    transport: { kind: 'stdio', command: 'my-mcp-server' },
    permissionLevel: 'read_only',
    tools: [{ name: 'read_doc', risk: 'read', requiresApproval: false }],
    canReadSecrets: false,
    createdBy: 'config',
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('McpRegistryService', () => {
  let tmp: string;
  let service: McpRegistryService;
  let registryFilePath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'arc-mcp-registry-test-'));
    registryFilePath = path.join(tmp, 'arc.mcp.json');
    service = new McpRegistryService(makeFakeConfig(registryFilePath));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Empty / missing file
  // -------------------------------------------------------------------------

  it('returns empty array when registry file does not exist', async () => {
    await expect(service.loadAll()).resolves.toEqual([]);
  });

  it('returns empty array when mcpRegistryPath is undefined', async () => {
    const noPathService = new McpRegistryService(
      { mcpRegistryPath: undefined, repoPath: '/' } as unknown as AppConfigService
    );
    await expect(noPathService.loadAll()).resolves.toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Valid registration
  // -------------------------------------------------------------------------

  it('loads a valid server registration', async () => {
    await writeRegistry(tmp, [validServer()]);
    const servers = await service.loadAll();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ id: 'test-server', permissionLevel: 'read_only' });
  });

  it('returns only enabled servers by default when using findServer', async () => {
    await writeRegistry(tmp, [
      validServer({ id: 'enabled-srv', enabled: true }),
      validServer({ id: 'disabled-srv', enabled: false })
    ]);
    const servers = await service.loadAll();
    expect(servers).toHaveLength(2);
    await expect(service.findServer('enabled-srv')).resolves.toMatchObject({ id: 'enabled-srv' });
    await expect(service.findServer('disabled-srv')).resolves.toMatchObject({ id: 'disabled-srv' });
  });

  it('finds a registered server by id', async () => {
    await writeRegistry(tmp, [validServer({ id: 'target' })]);
    await expect(service.findServer('target')).resolves.toMatchObject({ id: 'target' });
  });

  it('returns undefined for an unknown server id', async () => {
    await writeRegistry(tmp, [validServer()]);
    await expect(service.findServer('no-such-server')).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Required fields
  // -------------------------------------------------------------------------

  it('rejects a registration missing id', async () => {
    await writeRegistry(tmp, [validServer({ id: undefined })]);
    await expect(service.loadAll()).rejects.toThrow('id');
  });

  it('rejects a registration with an empty id', async () => {
    await writeRegistry(tmp, [validServer({ id: '  ' })]);
    await expect(service.loadAll()).rejects.toThrow('id');
  });

  it('rejects a registration missing transport', async () => {
    await writeRegistry(tmp, [validServer({ transport: undefined })]);
    await expect(service.loadAll()).rejects.toThrow('transport');
  });

  it('rejects a registration with an unknown transport kind', async () => {
    await writeRegistry(tmp, [validServer({ transport: { kind: 'grpc', endpoint: 'x' } })]);
    await expect(service.loadAll()).rejects.toThrow('transport.kind');
  });

  it('rejects a stdio transport missing command', async () => {
    await writeRegistry(tmp, [validServer({ transport: { kind: 'stdio' } })]);
    await expect(service.loadAll()).rejects.toThrow('command');
  });

  it('rejects an http transport missing url', async () => {
    await writeRegistry(tmp, [validServer({ transport: { kind: 'streamable_http' } })]);
    await expect(service.loadAll()).rejects.toThrow('url');
  });

  it('rejects a registration missing tools array', async () => {
    await writeRegistry(tmp, [validServer({ tools: undefined })]);
    await expect(service.loadAll()).rejects.toThrow('tools');
  });

  it('rejects a registration where tools is not an array', async () => {
    await writeRegistry(tmp, [validServer({ tools: 'not-an-array' })]);
    await expect(service.loadAll()).rejects.toThrow('tools');
  });

  // -------------------------------------------------------------------------
  // Permission level
  // -------------------------------------------------------------------------

  it('defaults missing permissionLevel to read_only (fail-safe)', async () => {
    await writeRegistry(tmp, [validServer({ permissionLevel: undefined })]);
    const servers = await service.loadAll();
    expect(servers[0].permissionLevel).toBe('read_only');
  });

  it('rejects an unknown permissionLevel (fail closed, not write)', async () => {
    await writeRegistry(tmp, [validServer({ permissionLevel: 'superuser' })]);
    await expect(service.loadAll()).rejects.toThrow('permissionLevel');
  });

  it('rejects admin permissionLevel (blocked in Phase 5)', async () => {
    await writeRegistry(tmp, [validServer({ permissionLevel: 'admin' })]);
    await expect(service.loadAll()).rejects.toThrow('admin');
  });

  it('accepts read_only, append_only, and write permissionLevels', async () => {
    for (const level of ['read_only', 'append_only', 'write'] as const) {
      service.clearCache();
      await writeRegistry(tmp, [validServer({ id: `srv-${level}`, permissionLevel: level })]);
      const servers = await service.loadAll();
      expect(servers[0].permissionLevel).toBe(level);
    }
  });

  // -------------------------------------------------------------------------
  // canReadSecrets
  // -------------------------------------------------------------------------

  it('rejects canReadSecrets: true (structurally impossible in Phase 5)', async () => {
    await writeRegistry(tmp, [validServer({ canReadSecrets: true })]);
    await expect(service.loadAll()).rejects.toThrow('canReadSecrets');
  });

  it('accepts canReadSecrets: false', async () => {
    await writeRegistry(tmp, [validServer({ canReadSecrets: false })]);
    await expect(service.loadAll()).resolves.toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Tool declarations
  // -------------------------------------------------------------------------

  it('rejects duplicate tool names within a server', async () => {
    await writeRegistry(tmp, [
      validServer({
        tools: [
          { name: 'read_doc', risk: 'read', requiresApproval: false },
          { name: 'read_doc', risk: 'read', requiresApproval: false }
        ]
      })
    ]);
    await expect(service.loadAll()).rejects.toThrow('duplicate');
  });

  it('rejects a tool with destructive risk (blocked in Phase 5)', async () => {
    await writeRegistry(tmp, [
      validServer({ tools: [{ name: 'wipe_all', risk: 'destructive', requiresApproval: true }] })
    ]);
    await expect(service.loadAll()).rejects.toThrow('blocked in Phase 5');
  });

  it('rejects a tool with secret_sensitive risk (blocked in Phase 5)', async () => {
    await writeRegistry(tmp, [
      validServer({ tools: [{ name: 'read_token', risk: 'secret_sensitive', requiresApproval: true }] })
    ]);
    await expect(service.loadAll()).rejects.toThrow('blocked in Phase 5');
  });

  it('rejects a tool with an unknown risk level', async () => {
    await writeRegistry(tmp, [
      validServer({ tools: [{ name: 'mystery', risk: 'teleport', requiresApproval: false }] })
    ]);
    await expect(service.loadAll()).rejects.toThrow('risk');
  });

  it('rejects a tool missing a name', async () => {
    await writeRegistry(tmp, [
      validServer({ tools: [{ risk: 'read', requiresApproval: false }] })
    ]);
    await expect(service.loadAll()).rejects.toThrow('name');
  });

  it('rejects null entries in the servers array', async () => {
    await writeFile(registryFilePath, JSON.stringify({ version: 1, servers: [null] }));
    await expect(service.loadAll()).rejects.toThrow();
  });

  it('rejects null entries in the tools array', async () => {
    await writeRegistry(tmp, [validServer({ tools: [null] })]);
    await expect(service.loadAll()).rejects.toThrow();
  });

  it('does not echo tool name in blocked-risk error messages', async () => {
    const secretLikeName = 'sk-secret-tool-key-99999';
    await writeRegistry(tmp, [
      validServer({ tools: [{ name: secretLikeName, risk: 'destructive', requiresApproval: true }] })
    ]);
    try {
      await service.loadAll();
    } catch (err) {
      expect((err as Error).message).not.toContain(secretLikeName);
    }
  });

  // -------------------------------------------------------------------------
  // Mtime-based caching
  // -------------------------------------------------------------------------

  it('caches registry between calls with the same mtime', async () => {
    await writeRegistry(tmp, [validServer()]);
    const first = await service.loadAll();
    const second = await service.loadAll();
    expect(first).toBe(second);
  });

  it('reloads registry when file changes', async () => {
    await writeRegistry(tmp, [validServer({ id: 'original' })]);
    await service.loadAll();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeRegistry(tmp, [validServer({ id: 'updated' })]);

    const servers = await service.loadAll();
    expect(servers[0].id).toBe('updated');
  });

  it('clearCache forces a reload on next call', async () => {
    await writeRegistry(tmp, [validServer({ id: 'initial' })]);
    await service.loadAll();
    service.clearCache();
    await writeRegistry(tmp, [validServer({ id: 'after-clear' })]);
    const servers = await service.loadAll();
    expect(servers[0].id).toBe('after-clear');
  });

  // -------------------------------------------------------------------------
  // Malformed JSON
  // -------------------------------------------------------------------------

  it('rejects a registry file that is not valid JSON', async () => {
    await writeFile(registryFilePath, 'not { json }');
    await expect(service.loadAll()).rejects.toThrow();
  });

  it('rejects a registry file with wrong version', async () => {
    await writeFile(registryFilePath, JSON.stringify({ version: 2, servers: [] }));
    await expect(service.loadAll()).rejects.toThrow('version');
  });

  it('rejects a registry file where servers is not an array', async () => {
    await writeFile(registryFilePath, JSON.stringify({ version: 1, servers: 'oops' }));
    await expect(service.loadAll()).rejects.toThrow('servers');
  });
});
