// Prevent the MCP SDK (ESM-only) from loading in Jest's CJS environment.
jest.mock('../transport/mcp-transport.factory', () => ({
  McpTransportFactory: jest.fn()
}));

import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AppConfigService } from '../../config/app-config.service';
import { McpRegistryService } from '../registry/mcp-registry.service';
import { McpPermissionService } from '../permissions/mcp-permission.service';
import { McpTransportFactory } from '../transport/mcp-transport.factory';
import { AuditLogService } from '../../features/audit/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsGateway } from '../../events/events.gateway';
import { McpToolCallService } from './mcp-tool-call.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeConfig(registryPath: string): AppConfigService {
  return { mcpRegistryPath: registryPath, repoPath: '/', approvalTimeoutMs: 60000 } as unknown as AppConfigService;
}

function makeAudit(): jest.Mocked<AuditLogService> {
  return { append: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditLogService>;
}

function makeEvents(): jest.Mocked<EventsGateway> {
  return { emitEnvelopeToTask: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<EventsGateway>;
}

function makePrismaWithApproval(finalStatus: 'approved' | 'denied' | 'expired' = 'approved'): jest.Mocked<PrismaService> {
  const approvalId = 'integration-approval-1';
  const approval = { id: approvalId, status: 'pending', decision: null, taskId: 'task-1', sessionId: 'session-1' };
  const resolved = { ...approval, status: finalStatus, decision: finalStatus };
  return {
    approvalRequest: {
      create: jest.fn().mockResolvedValue(approval),
      findUnique: jest.fn().mockResolvedValue(resolved),
      findFirst: jest.fn().mockResolvedValue(null)  // no prior denials
    }
  } as unknown as jest.Mocked<PrismaService>;
}

function makeTransport(callResult: unknown = { content: [{ type: 'text', text: 'done' }] }): jest.Mocked<McpTransportFactory> {
  const client = {
    connect: jest.fn().mockResolvedValue(undefined),
    callTool: jest.fn().mockResolvedValue(callResult),
    close: jest.fn().mockResolvedValue(undefined)
  };
  return { create: jest.fn().mockReturnValue(client) } as unknown as jest.Mocked<McpTransportFactory>;
}

async function writeRegistry(filePath: string, content: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(content));
}

const WRITE_SERVER = {
  id: 'git-server',
  displayName: 'Git',
  enabled: true,
  transport: { kind: 'stdio', command: 'mcp-git' },
  permissionLevel: 'write',
  tools: [{ name: 'commit_files', risk: 'write', requiresApproval: true }],
  canReadSecrets: false,
  createdBy: 'config'
};

const READ_SERVER = {
  id: 'docs-reader',
  displayName: 'Docs',
  enabled: true,
  transport: { kind: 'stdio', command: 'mcp-docs' },
  permissionLevel: 'read_only',
  tools: [{ name: 'read_file', risk: 'read', requiresApproval: false }],
  canReadSecrets: false,
  createdBy: 'config'
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('McpToolCallService (integration)', () => {
  let tmp: string;
  let registryPath: string;
  let audit: jest.Mocked<AuditLogService>;
  let events: jest.Mocked<EventsGateway>;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'arc-mcp-toolcall-int-'));
    registryPath = path.join(tmp, 'arc.mcp.json');
    audit = makeAudit();
    events = makeEvents();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  const makeService = (prisma: jest.Mocked<PrismaService>, transport: jest.Mocked<McpTransportFactory>): McpToolCallService => {
    const config = makeFakeConfig(registryPath);
    const registry = new McpRegistryService(config);
    const permission = new McpPermissionService(registry, audit, prisma);
    return new McpToolCallService(permission, registry, transport, prisma, audit, events, config);
  };

  // -------------------------------------------------------------------------
  // 1. Creates ApprovalRequest with correct fingerprints from real registry
  // -------------------------------------------------------------------------

  it('creates ApprovalRequest with MCP fingerprints loaded from disk registry', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [WRITE_SERVER] });
    const prisma = makePrismaWithApproval('approved');
    const transport = makeTransport();
    const service = makeService(prisma, transport);

    await service.execute({ taskId: 'task-1', sessionId: 'session-1', serverId: 'git-server', toolName: 'commit_files', args: { message: 'fix bug' } });

    expect(prisma.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: 'mcp.tool_call',
          title: 'Git: commit_files',
          status: 'pending'
        })
      })
    );
  });

  it('sets commandJson to canonicalized [serverId, toolName] fingerprint', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [WRITE_SERVER] });
    const prisma = makePrismaWithApproval('approved');
    const service = makeService(prisma, makeTransport());

    await service.execute({ taskId: 'task-1', sessionId: 'session-1', serverId: 'git-server', toolName: 'commit_files', args: { message: 'fix' } });

    const createCall = (prisma.approvalRequest.create as jest.Mock).mock.calls[0][0];
    expect(JSON.parse(createCall.data.commandJson)).toEqual(['git-server', 'commit_files']);
  });

  it('redacts secrets from filesJson fingerprint', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [WRITE_SERVER] });
    const prisma = makePrismaWithApproval('approved');
    const service = makeService(prisma, makeTransport());

    await service.execute({ taskId: 'task-1', sessionId: 'session-1', serverId: 'git-server', toolName: 'commit_files', args: { token: 'sk-secret-123', message: 'fix' } });

    const createCall = (prisma.approvalRequest.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data.filesJson).not.toContain('sk-secret-123');
    expect(createCall.data.filesJson).toContain('[REDACTED]');
    expect(createCall.data.filesJson).toContain('fix');
  });

  // -------------------------------------------------------------------------
  // 2. Denial prevents transport execution
  // -------------------------------------------------------------------------

  it('does not call transport when approval is denied', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [WRITE_SERVER] });
    const prisma = makePrismaWithApproval('denied');
    const transport = makeTransport();
    const service = makeService(prisma, transport);

    const result = await service.execute({ taskId: 'task-1', sessionId: 'session-1', serverId: 'git-server', toolName: 'commit_files', args: { message: 'fix' } });

    expect(result.outcome).toBe('denied');
    expect(transport.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Approval executes exactly once
  // -------------------------------------------------------------------------

  it('calls transport exactly once when approval is approved', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [WRITE_SERVER] });
    const prisma = makePrismaWithApproval('approved');
    const transport = makeTransport();
    const service = makeService(prisma, transport);

    const result = await service.execute({ taskId: 'task-1', sessionId: 'session-1', serverId: 'git-server', toolName: 'commit_files', args: { message: 'fix' } });

    expect(result.outcome).toBe('approved');
    const client = transport.create.mock.results[0].value;
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledWith('commit_files', { message: 'fix' });
  });

  // -------------------------------------------------------------------------
  // 4. Expired approval denies and does not auto-allow
  // -------------------------------------------------------------------------

  it('returns expired outcome and does not call transport when approval expires', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [WRITE_SERVER] });
    const prisma = makePrismaWithApproval('expired');
    const transport = makeTransport();
    const service = makeService(prisma, transport);

    const result = await service.execute({ taskId: 'task-1', sessionId: 'session-1', serverId: 'git-server', toolName: 'commit_files', args: { message: 'fix' } });

    expect(result.outcome).toBe('expired');
    expect(transport.create).not.toHaveBeenCalled();
  });

  it('audits the expired outcome', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [WRITE_SERVER] });
    const prisma = makePrismaWithApproval('expired');
    const service = makeService(prisma, makeTransport());

    await service.execute({ taskId: 'task-1', sessionId: 'session-1', serverId: 'git-server', toolName: 'commit_files', args: {} });

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mcp.approval_resolved', decision: 'expired' })
    );
  });

  // -------------------------------------------------------------------------
  // 5. Replay / idempotency: approval card emitted once per call attempt
  // -------------------------------------------------------------------------

  it('emits exactly one approval.requested event per execute() call', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [WRITE_SERVER] });
    const prisma = makePrismaWithApproval('approved');
    const service = makeService(prisma, makeTransport());

    await service.execute({ taskId: 'task-1', sessionId: 'session-1', serverId: 'git-server', toolName: 'commit_files', args: {} });

    const approvalEvents = (events.emitEnvelopeToTask as jest.Mock).mock.calls.filter(
      ([, name]) => name === 'approval.requested'
    );
    expect(approvalEvents).toHaveLength(1);
  });

  it('does not emit approval card for blocked decisions (no duplicate cards)', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [WRITE_SERVER] });
    // Simulate prior denial in Prisma so TSH-114 denied-replay fires
    const prisma = {
      approvalRequest: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue({ id: 'prior-1', status: 'denied' })
      }
    } as unknown as jest.Mocked<PrismaService>;
    const transport = makeTransport();
    const service = makeService(prisma, transport);

    const result = await service.execute({ taskId: 'task-1', sessionId: 'session-1', serverId: 'git-server', toolName: 'commit_files', args: {} });

    expect(result.outcome).toBe('blocked');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
    expect(events.emitEnvelopeToTask).not.toHaveBeenCalledWith(
      expect.anything(),
      'approval.requested',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  // -------------------------------------------------------------------------
  // 6. Read tools auto-allow without approval card
  // -------------------------------------------------------------------------

  it('auto-allows read tools without creating an ApprovalRequest', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [READ_SERVER] });
    const prisma = makePrismaWithApproval('approved');
    const transport = makeTransport();
    const service = makeService(prisma, transport);

    const result = await service.execute({ taskId: 'task-1', sessionId: 'session-1', serverId: 'docs-reader', toolName: 'read_file', args: { path: '/docs/readme.md' } });

    expect(result.outcome).toBe('auto_allow');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
    expect(transport.create).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. Fingerprint determinism across key-insertion orders
  // -------------------------------------------------------------------------

  it('produces identical filesJson fingerprints for semantically equivalent args', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [WRITE_SERVER] });
    const capturedFilesJson: string[] = [];
    const prisma = {
      approvalRequest: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          capturedFilesJson.push(data.filesJson as string);
          return { id: `approval-${capturedFilesJson.length}`, status: 'approved', decision: 'approved' };
        }),
        findUnique: jest.fn().mockResolvedValue({ status: 'approved', decision: 'approved' }),
        findFirst: jest.fn().mockResolvedValue(null)
      }
    } as unknown as jest.Mocked<PrismaService>;

    const service1 = makeService(prisma, makeTransport());
    const service2 = makeService(prisma, makeTransport());

    await service1.execute({ taskId: 'task-1', sessionId: 's1', serverId: 'git-server', toolName: 'commit_files', args: { a: 1, b: 2 } });
    await service2.execute({ taskId: 'task-1', sessionId: 's2', serverId: 'git-server', toolName: 'commit_files', args: { b: 2, a: 1 } });

    expect(capturedFilesJson).toHaveLength(2);
    expect(capturedFilesJson[0]).toBe(capturedFilesJson[1]);
  });

  // -------------------------------------------------------------------------
  // 8. expectedEffect carries MCP context for controller rendering
  // -------------------------------------------------------------------------

  it('includes complete MCP context in expectedEffect for controller card', async () => {
    await writeRegistry(registryPath, { version: 1, servers: [WRITE_SERVER] });
    const prisma = makePrismaWithApproval('approved');
    const service = makeService(prisma, makeTransport());

    await service.execute({ taskId: 'task-1', sessionId: 'session-1', serverId: 'git-server', toolName: 'commit_files', args: {} });

    const createCall = (prisma.approvalRequest.create as jest.Mock).mock.calls[0][0];
    const effect = JSON.parse(createCall.data.expectedEffect);
    expect(effect).toMatchObject({
      mcpServerId: 'git-server',
      mcpServerDisplayName: 'Git',
      mcpToolName: 'commit_files',
      permissionLevel: 'write',
      toolRisk: 'write'
    });
  });
});
