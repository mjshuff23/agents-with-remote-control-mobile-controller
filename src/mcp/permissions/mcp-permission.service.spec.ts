import { McpRegistryService } from '../registry/mcp-registry.service';
import { AuditLogService } from '../../features/audit/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { McpPermissionService } from './mcp-permission.service';
import { McpServerRegistration } from '../registry/mcp-registry.schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(overrides: Partial<McpServerRegistration> = {}): McpServerRegistration {
  return {
    id: 'test-server',
    displayName: 'Test Server',
    enabled: true,
    transport: { kind: 'stdio', command: 'mcp-server' },
    permissionLevel: 'read_only',
    tools: [
      { name: 'read_doc', risk: 'read', requiresApproval: false },
      { name: 'append_note', risk: 'append', requiresApproval: true },
      { name: 'write_file', risk: 'write', requiresApproval: true }
    ],
    canReadSecrets: false,
    createdBy: 'config',
    ...overrides
  };
}

function makeRegistry(servers: McpServerRegistration[]): McpRegistryService {
  return {
    findServer: jest.fn(async (id: string) => servers.find((s) => s.id === id))
  } as unknown as McpRegistryService;
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('McpPermissionService', () => {
  let audit: jest.Mocked<AuditLogService>;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(() => {
    audit = makeAudit();
    prisma = makePrisma();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Read-only server auto-allows declared read tools
  // -------------------------------------------------------------------------

  it('auto-allows a declared read tool on a read_only server', async () => {
    const registry = makeRegistry([makeServer({ permissionLevel: 'read_only' })]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'read_doc', {});

    expect(result.decision).toBe('auto_allow');
    expect(result.reasonCode).toBe('auto_allow_read');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ decision: 'auto_allow' }));
  });

  // -------------------------------------------------------------------------
  // 2. Read-only server blocks append/write/destructive/secret_sensitive tools
  // -------------------------------------------------------------------------

  it('blocks an append tool on a read_only server (permission ceiling exceeded)', async () => {
    const registry = makeRegistry([makeServer({ permissionLevel: 'read_only' })]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'append_note', {});

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('permission_ceiling_exceeded');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ decision: 'blocked' }));
  });

  it('blocks a write tool on a read_only server (permission ceiling exceeded)', async () => {
    const registry = makeRegistry([makeServer({ permissionLevel: 'read_only' })]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'write_file', {});

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('permission_ceiling_exceeded');
  });

  // -------------------------------------------------------------------------
  // 3. Append-only server: read tools auto-allow, write tools blocked
  // -------------------------------------------------------------------------

  it('auto-allows a read tool on an append_only server', async () => {
    const registry = makeRegistry([makeServer({ permissionLevel: 'append_only' })]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'read_doc', {});

    expect(result.decision).toBe('auto_allow');
    expect(result.reasonCode).toBe('auto_allow_read');
  });

  it('needs_approval for an append tool on an append_only server', async () => {
    const registry = makeRegistry([makeServer({ permissionLevel: 'append_only' })]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'append_note', {});

    expect(result.decision).toBe('needs_approval');
    expect(result.reasonCode).toBe('needs_approval_append');
  });

  it('blocks a write tool on an append_only server (permission ceiling exceeded)', async () => {
    const registry = makeRegistry([makeServer({ permissionLevel: 'append_only' })]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'write_file', {});

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('permission_ceiling_exceeded');
  });

  // -------------------------------------------------------------------------
  // 4. Write-capable tools always require explicit approval
  // -------------------------------------------------------------------------

  it('requires approval for a write tool on a write-level server', async () => {
    const registry = makeRegistry([makeServer({ permissionLevel: 'write' })]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'write_file', {});

    expect(result.decision).toBe('needs_approval');
    expect(result.reasonCode).toBe('needs_approval_write');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ decision: 'needs_approval' }));
  });

  // -------------------------------------------------------------------------
  // 5. Admin permission level is rejected in Phase 5
  // -------------------------------------------------------------------------

  it('blocks a server with admin permissionLevel (Phase 5 blocked)', async () => {
    const registry = makeRegistry([
      makeServer({ permissionLevel: 'admin' as McpServerRegistration['permissionLevel'] })
    ]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'read_doc', {});

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('admin_blocked');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ decision: 'blocked' }));
  });

  // -------------------------------------------------------------------------
  // 6. Destructive and secret_sensitive tools are blocked regardless of server permission
  // -------------------------------------------------------------------------

  it('blocks a destructive tool even on a write-level server', async () => {
    const registry = makeRegistry([
      makeServer({
        permissionLevel: 'write',
        tools: [{ name: 'wipe_all', risk: 'destructive', requiresApproval: true }]
      })
    ]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'wipe_all', {});

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('blocked_tool_risk');
  });

  it('blocks a secret_sensitive tool even on a write-level server', async () => {
    const registry = makeRegistry([
      makeServer({
        permissionLevel: 'write',
        tools: [{ name: 'read_token', risk: 'secret_sensitive', requiresApproval: true }]
      })
    ]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'read_token', {});

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('blocked_tool_risk');
  });

  // -------------------------------------------------------------------------
  // 7. Unknown server/tool IDs are blocked and audited
  // -------------------------------------------------------------------------

  it('blocks and audits an unknown server id', async () => {
    const registry = makeRegistry([]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('no-such-server', 'read_doc', {});

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('undeclared_tool');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ decision: 'blocked' }));
  });

  it('blocks and audits an undeclared tool on a known server', async () => {
    const registry = makeRegistry([makeServer()]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'no-such-tool', {});

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('undeclared_tool');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ decision: 'blocked' }));
  });

  // -------------------------------------------------------------------------
  // 8. Denied-replay detection prevents silent re-run of previously denied calls
  // -------------------------------------------------------------------------

  it('blocks a write tool call that was previously denied', async () => {
    const deniedRecord = { id: 'req-1', status: 'denied' };
    prisma = makePrisma(deniedRecord);
    const registry = makeRegistry([makeServer({ permissionLevel: 'write' })]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'write_file', { path: '/tmp/out.txt' });

    expect(result.decision).toBe('blocked');
    expect(result.reasonCode).toBe('denied_replay');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ decision: 'blocked' }));
  });

  it('allows a write tool call when no prior denial record exists', async () => {
    const registry = makeRegistry([makeServer({ permissionLevel: 'write' })]);
    const service = new McpPermissionService(registry, audit, prisma);

    const result = await service.assess('test-server', 'write_file', { path: '/tmp/out.txt' });

    expect(result.decision).toBe('needs_approval');
  });

  // -------------------------------------------------------------------------
  // Audit is called on every decision branch
  // -------------------------------------------------------------------------

  it('always appends an audit record regardless of decision outcome', async () => {
    const scenarios: Array<[McpServerRegistration, string]> = [
      [makeServer({ permissionLevel: 'read_only' }), 'read_doc'],
      [makeServer({ permissionLevel: 'read_only' }), 'write_file'],
      [makeServer({ permissionLevel: 'write' }), 'write_file']
    ];

    for (const [server, toolName] of scenarios) {
      audit = makeAudit();
      const registry = makeRegistry([server]);
      const service = new McpPermissionService(registry, audit, prisma);

      await service.assess(server.id, toolName, {});

      expect(audit.append).toHaveBeenCalledTimes(1);
    }
  });

  // -------------------------------------------------------------------------
  // Secret argument sanitization does not leak values into audit
  // -------------------------------------------------------------------------

  it('sanitizes secret-like argument values before logging', async () => {
    const registry = makeRegistry([makeServer({ permissionLevel: 'read_only' })]);
    const service = new McpPermissionService(registry, audit, prisma);

    await service.assess('test-server', 'read_doc', { token: 'sk-super-secret-key-12345' });

    const auditCall = audit.append.mock.calls[0][0];
    const metadataStr = JSON.stringify(auditCall.metadata ?? {});
    expect(metadataStr).not.toContain('sk-super-secret-key-12345');
  });
});
