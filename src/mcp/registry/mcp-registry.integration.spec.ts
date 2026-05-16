import { mkdtemp, rm, copyFile, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AppConfigService } from '../../config/app-config.service';
import { McpRegistryService } from './mcp-registry.service';

const EXAMPLE_CONFIG_PATH = path.resolve(
  __dirname,
  '../../../arc.mcp.example.json'
);

function makeFakeConfig(registryPath: string): AppConfigService {
  return { mcpRegistryPath: registryPath, repoPath: '/' } as unknown as AppConfigService;
}

describe('McpRegistryService (integration)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'arc-mcp-integration-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('loads the example config and registers servers deterministically', async () => {
    const dest = path.join(tmp, 'arc.mcp.json');
    await copyFile(EXAMPLE_CONFIG_PATH, dest);

    const service = new McpRegistryService(makeFakeConfig(dest));
    const servers = await service.loadAll();

    expect(servers.length).toBeGreaterThan(0);

    // Determinism: loading twice returns the same result
    const again = await service.loadAll();
    expect(again.map((s) => s.id)).toEqual(servers.map((s) => s.id));

    // Every server satisfies structural invariants
    for (const server of servers) {
      expect(typeof server.id).toBe('string');
      expect(server.id.trim().length).toBeGreaterThan(0);
      expect(server.canReadSecrets).toBe(false);
      expect(['read_only', 'append_only', 'write']).toContain(server.permissionLevel);
      expect(Array.isArray(server.tools)).toBe(true);
    }
  });

  it('fails startup with a clear, non-secret error on malformed config', async () => {
    const dest = path.join(tmp, 'arc.mcp.json');
    await writeFile(dest, '{ "version": 1, "servers": "not-an-array" }');

    const service = new McpRegistryService(makeFakeConfig(dest));
    await expect(service.loadAll()).rejects.toThrow('servers');
  });

  it('fails with a clear error when a server has a Phase-5-blocked field', async () => {
    const dest = path.join(tmp, 'arc.mcp.json');
    await writeFile(dest, JSON.stringify({
      version: 1,
      servers: [{
        id: 'bad-server',
        displayName: 'Bad',
        enabled: true,
        transport: { kind: 'stdio', command: 'mcp-server' },
        permissionLevel: 'admin',
        tools: [],
        canReadSecrets: false,
        createdBy: 'config'
      }]
    }));

    const service = new McpRegistryService(makeFakeConfig(dest));
    await expect(service.loadAll()).rejects.toThrow('admin');
  });

  it('does not expose secret-like values in validation error messages', async () => {
    const dest = path.join(tmp, 'arc.mcp.json');
    const secretLikeValue = 'sk-very-secret-key-12345';
    await writeFile(dest, JSON.stringify({
      version: 1,
      servers: [{
        id: secretLikeValue,
        displayName: 'Oops',
        enabled: true,
        transport: { kind: 'stdio', command: 'mcp-server' },
        permissionLevel: 'admin',
        tools: [],
        canReadSecrets: false,
        createdBy: 'config'
      }]
    }));

    const service = new McpRegistryService(makeFakeConfig(dest));
    await expect(service.loadAll()).rejects.toThrow('admin');
    // The error must never echo the raw id or secret-like content
    try {
      await service.loadAll();
    } catch (err) {
      expect((err as Error).message).not.toContain(secretLikeValue);
    }
  });
});
