import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AppConfigService } from '../../config/app-config.service';
import { McpRegistryService } from '../registry/mcp-registry.service';
import { McpPermissionService } from './mcp-permission.service';
import { AuditLogService } from '../../features/audit/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeConfig(registryPath: string): AppConfigService {
  return { mcpRegistryPath: registryPath, repoPath: '/' } as unknown as AppConfigService;
}

function makeAudit(): jest.Mocked<AuditLogService> {
  return { append: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditLogService>;
}

function makePrisma(deniedRecord: unknown = null): jest.Mocked<PrismaService> {
  return {
    approvalRequest: {
      findFirst: jest.fn().mockResolvedValue(deniedRecord)
    }
  } as unknown as jest.Mocked<PrismaService>;
}

async function writeRegistry(filePath: string, content: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(content));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('McpPermissionService (integration)', () => {
  let tmp: string;
  let registryPath: string;
  let audit: jest.Mocked<AuditLogService>;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'arc-mcp-perm-int-'));
    registryPath = path.join(tmp, 'arc.mcp.json');
    audit = makeAudit();
    prisma = makePrisma();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  function makeService(): McpPermissionService {
    const registry = new McpRegistryService(makeFakeConfig(registryPath));
    return new McpPermissionService(registry, audit, prisma);
  }

  // -------------------------------------------------------------------------
  // Full ladder coverage through real McpRegistryService
  // -------------------------------------------------------------------------

  it('auto-allows read tools on a read_only server loaded from disk', async () => {
    await writeRegistry(registryPath, {
      version: 1,
      servers: [{
        id: 'docs-reader',
        displayName: 'Docs',
        enabled: true,
        transport: { kind: 'stdio', command: 'mcp-server' },
        permissionLevel: 'read_only',
        tools: [{ name: 'read_file', risk: 'read', requiresApproval: false }],
        canReadSecrets: false,
        createdBy: 'config'
      }]
    });

    const service = makeService();
    const result = await service.assess('docs-reader', 'read_file', {});

    expect(result.decision).toBe('auto_allow');
    expect(result.reasonCode).toBe('auto_allow_read');
    expect(audit.append).toHaveBeenCalledTimes(1);
  });

  it('blocks write tool on read_only server with permission_ceiling_exceeded', async () => {
    await writeRegistry(registryPath, {
      version: 1,
      servers: [{
        id: 'docs-reader',
        displayName: 'Docs',
        enabled: true,
        transport: { kind: 'stdio', command: 'mcp-server' },
        permissionLevel: 'read_only',
        tools: [{ name: 'write_file', risk: 'write', requiresApproval: true }],
        canReadSecrets: false,
        createdBy: 'config'
      }]
    });

    const service = makeService();
    const result = await service.assess('docs-reader', 'write_file', {});

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('permission_ceiling_exceeded');
  });

  it('requires approval for append tool on append_only server', async () => {
    await writeRegistry(registryPath, {
      version: 1,
      servers: [{
        id: 'notion-append',
        displayName: 'Notion',
        enabled: true,
        transport: { kind: 'streamable_http', url: 'http://localhost/mcp' },
        permissionLevel: 'append_only',
        tools: [{ name: 'append_block', risk: 'append', requiresApproval: true }],
        canReadSecrets: false,
        createdBy: 'config'
      }]
    });

    const service = makeService();
    const result = await service.assess('notion-append', 'append_block', { pageId: 'abc' });

    expect(result.decision).toBe('needs_approval');
    expect(result.reasonCode).toBe('needs_approval_append');
  });

  it('requires approval for write tool on write-level server', async () => {
    await writeRegistry(registryPath, {
      version: 1,
      servers: [{
        id: 'git-server',
        displayName: 'Git',
        enabled: true,
        transport: { kind: 'stdio', command: 'mcp-git' },
        permissionLevel: 'write',
        tools: [{ name: 'commit_files', risk: 'write', requiresApproval: true }],
        canReadSecrets: false,
        createdBy: 'config'
      }]
    });

    const service = makeService();
    const result = await service.assess('git-server', 'commit_files', { message: 'fix bug' });

    expect(result.decision).toBe('needs_approval');
    expect(result.reasonCode).toBe('needs_approval_write');
  });

  // -------------------------------------------------------------------------
  // Denied-replay integration
  // -------------------------------------------------------------------------

  it('blocks a call when the Prisma layer returns a prior denial', async () => {
    prisma = makePrisma({ id: 'req-prev', status: 'denied' });
    await writeRegistry(registryPath, {
      version: 1,
      servers: [{
        id: 'git-server',
        displayName: 'Git',
        enabled: true,
        transport: { kind: 'stdio', command: 'mcp-git' },
        permissionLevel: 'write',
        tools: [{ name: 'commit_files', risk: 'write', requiresApproval: true }],
        canReadSecrets: false,
        createdBy: 'config'
      }]
    });

    const service = makeService();
    const result = await service.assess('git-server', 'commit_files', { message: 'fix bug' });

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('denied_replay');
  });

  it('passes denied-replay check using sanitized args as fingerprint', async () => {
    const capturedQuery: Record<string, unknown>[] = [];
    prisma = {
      approvalRequest: {
        findFirst: jest.fn((args: unknown) => {
          capturedQuery.push(args as Record<string, unknown>);
          return Promise.resolve(null);
        })
      }
    } as unknown as jest.Mocked<PrismaService>;

    await writeRegistry(registryPath, {
      version: 1,
      servers: [{
        id: 'git-server',
        displayName: 'Git',
        enabled: true,
        transport: { kind: 'stdio', command: 'mcp-git' },
        permissionLevel: 'write',
        tools: [{ name: 'commit_files', risk: 'write', requiresApproval: true }],
        canReadSecrets: false,
        createdBy: 'config'
      }]
    });

    const registry = new McpRegistryService(makeFakeConfig(registryPath));
    const service = new McpPermissionService(registry, audit, prisma);

    await service.assess('git-server', 'commit_files', { token: 'sk-secret-123', message: 'fix' });

    expect(capturedQuery).toHaveLength(1);
    const query = capturedQuery[0] as { where: { commandJson: string; filesJson: string } };

    // commandJson must encode [serverId, toolName] identity
    expect(query.where.commandJson).toContain('git-server');
    expect(query.where.commandJson).toContain('commit_files');

    // filesJson must redact secrets but preserve non-secret args
    expect(query.where.filesJson).not.toContain('sk-secret-123');
    expect(query.where.filesJson).toContain('[REDACTED]');
    expect(query.where.filesJson).toContain('fix');
  });

  it('produces identical fingerprints for semantically equivalent args with different key order', async () => {
    const capturedQueries: { where: { filesJson: string } }[] = [];
    prisma = {
      approvalRequest: {
        findFirst: jest.fn((args: unknown) => {
          capturedQueries.push(args as { where: { filesJson: string } });
          return Promise.resolve(null);
        })
      }
    } as unknown as jest.Mocked<PrismaService>;

    await writeRegistry(registryPath, {
      version: 1,
      servers: [{
        id: 'git-server',
        displayName: 'Git',
        enabled: true,
        transport: { kind: 'stdio', command: 'mcp-git' },
        permissionLevel: 'write',
        tools: [{ name: 'commit_files', risk: 'write', requiresApproval: true }],
        canReadSecrets: false,
        createdBy: 'config'
      }]
    });

    const registry1 = new McpRegistryService(makeFakeConfig(registryPath));
    const service1 = new McpPermissionService(registry1, audit, prisma);
    const registry2 = new McpRegistryService(makeFakeConfig(registryPath));
    const service2 = new McpPermissionService(registry2, audit, prisma);

    await service1.assess('git-server', 'commit_files', { a: 1, b: 2 });
    await service2.assess('git-server', 'commit_files', { b: 2, a: 1 });

    expect(capturedQueries).toHaveLength(2);
    expect(capturedQueries[0].where.filesJson).toBe(capturedQueries[1].where.filesJson);
  });

  // -------------------------------------------------------------------------
  // Unknown server/tool
  // -------------------------------------------------------------------------

  it('blocks and audits an unknown server id', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [] });

    const service = makeService();
    const result = await service.assess('ghost-server', 'any_tool', {});

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('undeclared_tool');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ decision: 'blocked' }));
  });

  it('blocks and audits an undeclared tool on a known server', async () => {
    await writeRegistry(registryPath, {
      version: 1,
      servers: [{
        id: 'docs-reader',
        displayName: 'Docs',
        enabled: true,
        transport: { kind: 'stdio', command: 'mcp-server' },
        permissionLevel: 'read_only',
        tools: [{ name: 'read_file', risk: 'read', requiresApproval: false }],
        canReadSecrets: false,
        createdBy: 'config'
      }]
    });

    const service = makeService();
    const result = await service.assess('docs-reader', 'ghost_tool', {});

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('undeclared_tool');
  });

  // -------------------------------------------------------------------------
  // Audit is always written
  // -------------------------------------------------------------------------

  it('always writes an audit record for every assessment', async () => {
    await writeRegistry(registryPath, {
      version: 1,
      servers: [{
        id: 'docs-reader',
        displayName: 'Docs',
        enabled: true,
        transport: { kind: 'stdio', command: 'mcp-server' },
        permissionLevel: 'read_only',
        tools: [{ name: 'read_file', risk: 'read', requiresApproval: false }],
        canReadSecrets: false,
        createdBy: 'config'
      }]
    });

    const service = makeService();

    await service.assess('docs-reader', 'read_file', {});
    expect(audit.append).toHaveBeenCalledTimes(1);

    await service.assess('docs-reader', 'ghost_tool', {});
    expect(audit.append).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Secret sanitization in audit metadata
  // -------------------------------------------------------------------------

  it('does not leak secret arg values into audit metadata', async () => {
    await writeRegistry(registryPath, {
      version: 1,
      servers: [{
        id: 'docs-reader',
        displayName: 'Docs',
        enabled: true,
        transport: { kind: 'stdio', command: 'mcp-server' },
        permissionLevel: 'read_only',
        tools: [{ name: 'read_file', risk: 'read', requiresApproval: false }],
        canReadSecrets: false,
        createdBy: 'config'
      }]
    });

    const service = makeService();
    const secretValue = 'sk-my-very-secret-api-key-99999';

    await service.assess('docs-reader', 'read_file', { apiKey: secretValue });

    const call = audit.append.mock.calls[0][0];
    const metadataStr = JSON.stringify(call.metadata ?? {});
    expect(metadataStr).not.toContain(secretValue);
  });
});
