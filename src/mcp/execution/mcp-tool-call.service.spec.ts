// Prevent the MCP SDK (ESM-only) from loading in Jest's CJS environment.
// The real factory is replaced entirely; tests supply hand-crafted mock clients.
jest.mock('../transport/mcp-transport.factory', () => ({
  McpTransportFactory: jest.fn()
}));

import { randomUUID } from 'crypto';
import { McpRegistryService } from '../registry/mcp-registry.service';
import { McpPermissionService } from '../permissions/mcp-permission.service';
import type { McpTransportFactory } from '../transport/mcp-transport.factory';
import { AuditLogService } from '../../features/audit/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsGateway } from '../../events/events.gateway';
import { AppConfigService } from '../../config/app-config.service';
import { McpToolCallService } from './mcp-tool-call.service';
import { McpServerRegistration } from '../registry/mcp-registry.schema';
import { McpPermissionDecision } from '../permissions/mcp-permission.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(overrides: Partial<McpServerRegistration> = {}): McpServerRegistration {
  return {
    id: 'test-server',
    displayName: 'Test Server',
    enabled: true,
    transport: { kind: 'stdio', command: 'mcp-server' },
    permissionLevel: 'write',
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

function makeDecision(overrides: Partial<McpPermissionDecision> = {}): McpPermissionDecision {
  return {
    decision: 'needs_approval',
    reasonCode: 'needs_approval_write',
    serverId: 'test-server',
    toolName: 'write_file',
    declaredPermission: 'write',
    toolRisk: 'write',
    ruleMatched: 'write_requires_approval',
    ...overrides
  };
}

function makePermission(decision: McpPermissionDecision): jest.Mocked<McpPermissionService> {
  return {
    assess: jest.fn().mockResolvedValue(decision)
  } as unknown as jest.Mocked<McpPermissionService>;
}

function makeRegistry(server: McpServerRegistration | null = makeServer()): jest.Mocked<McpRegistryService> {
  return {
    findServer: jest.fn().mockResolvedValue(server)
  } as unknown as jest.Mocked<McpRegistryService>;
}

function makePrisma(approvalId = 'approval-1', finalStatus = 'approved'): jest.Mocked<PrismaService> {
  const approval = { id: approvalId, status: 'pending', decision: null, taskId: 'task-1', sessionId: 'session-1' };
  const resolved = { ...approval, status: finalStatus, decision: finalStatus === 'approved' ? 'approved' : finalStatus };
  return {
    approvalRequest: {
      create: jest.fn().mockResolvedValue(approval),
      findUnique: jest.fn().mockResolvedValue(resolved),
      update: jest.fn().mockResolvedValue({ ...approval, status: 'expired' })
    }
  } as unknown as jest.Mocked<PrismaService>;
}

function makeTransport(callResult: unknown = { content: [{ type: 'text', text: 'ok' }] }): jest.Mocked<McpTransportFactory> {
  const client = {
    connect: jest.fn().mockResolvedValue(undefined),
    callTool: jest.fn().mockResolvedValue(callResult),
    close: jest.fn().mockResolvedValue(undefined)
  };
  return {
    create: jest.fn().mockReturnValue(client)
  } as unknown as jest.Mocked<McpTransportFactory>;
}

function makeEvents(): jest.Mocked<EventsGateway> {
  return { emitEnvelopeToTask: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<EventsGateway>;
}

function makeAudit(): jest.Mocked<AuditLogService> {
  return { append: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditLogService>;
}

function makeConfig(timeoutMs = 60000): jest.Mocked<AppConfigService> {
  return { approvalTimeoutMs: timeoutMs } as unknown as jest.Mocked<AppConfigService>;
}

function makeService(overrides: {
  permission?: jest.Mocked<McpPermissionService>;
  registry?: jest.Mocked<McpRegistryService>;
  transport?: jest.Mocked<McpTransportFactory>;
  prisma?: jest.Mocked<PrismaService>;
  audit?: jest.Mocked<AuditLogService>;
  events?: jest.Mocked<EventsGateway>;
  config?: jest.Mocked<AppConfigService>;
} = {}): { service: McpToolCallService; mocks: Required<typeof overrides> } {
  const mocks = {
    permission: overrides.permission ?? makePermission(makeDecision()),
    registry: overrides.registry ?? makeRegistry(),
    transport: overrides.transport ?? makeTransport(),
    prisma: overrides.prisma ?? makePrisma(),
    audit: overrides.audit ?? makeAudit(),
    events: overrides.events ?? makeEvents(),
    config: overrides.config ?? makeConfig()
  };
  const service = new McpToolCallService(
    mocks.permission,
    mocks.registry,
    mocks.transport,
    mocks.prisma,
    mocks.audit,
    mocks.events,
    mocks.config
  );
  return { service, mocks };
}

const BASE_REQUEST = {
  taskId: 'task-1',
  sessionId: 'session-1',
  serverId: 'test-server',
  toolName: 'write_file',
  args: { path: '/tmp/out.txt', content: 'hello' }
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('McpToolCallService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Maps needs_approval decision to an ApprovalRequest
  // -------------------------------------------------------------------------

  it('creates an ApprovalRequest for needs_approval write decisions', async () => {
    const { service, mocks } = makeService();

    await service.execute(BASE_REQUEST);

    expect(mocks.prisma.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: 'task-1',
          sessionId: 'session-1',
          actionType: 'mcp.tool_call',
          riskLevel: 'write',
          title: 'Test Server: write_file',
          status: 'pending'
        })
      })
    );
  });

  it('creates an ApprovalRequest for needs_approval append decisions', async () => {
    const decision = makeDecision({ decision: 'needs_approval', reasonCode: 'needs_approval_append', toolName: 'append_note', toolRisk: 'append', ruleMatched: 'append_requires_approval' });
    const server = makeServer({ permissionLevel: 'append_only' });
    const { service, mocks } = makeService({
      permission: makePermission(decision),
      registry: makeRegistry(server)
    });

    await service.execute({ ...BASE_REQUEST, toolName: 'append_note' });

    expect(mocks.prisma.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: 'mcp.tool_call',
          riskLevel: 'append'
        })
      })
    );
  });

  // -------------------------------------------------------------------------
  // 2. Sanitizes secret-like argument values before controller payload
  // -------------------------------------------------------------------------

  it('does not put raw secret values into commandJson or filesJson', async () => {
    const { service, mocks } = makeService();

    await service.execute({ ...BASE_REQUEST, args: { token: 'sk-super-secret-key-12345', path: '/tmp/out.txt' } });

    const createCall = (mocks.prisma.approvalRequest.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data.filesJson).not.toContain('sk-super-secret-key-12345');
    expect(createCall.data.commandJson).not.toContain('sk-super-secret-key-12345');
  });

  it('includes sanitized argument representation in filesJson', async () => {
    const { service, mocks } = makeService();

    await service.execute({ ...BASE_REQUEST, args: { token: 'sk-secret', path: '/tmp/out.txt' } });

    const createCall = (mocks.prisma.approvalRequest.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data.filesJson).toContain('[REDACTED]');
    expect(createCall.data.filesJson).toContain('/tmp/out.txt');
  });

  // -------------------------------------------------------------------------
  // 3. Emits approval.requested event with the approval card
  // -------------------------------------------------------------------------

  it('emits approval.requested event when creating an MCP approval card', async () => {
    const { service, mocks } = makeService();

    await service.execute(BASE_REQUEST);

    expect(mocks.events.emitEnvelopeToTask).toHaveBeenCalledWith(
      'task-1',
      'approval.requested',
      'approval',
      'warn',
      expect.objectContaining({ id: 'approval-1' }),
      expect.objectContaining({ sessionId: 'session-1' })
    );
  });

  // -------------------------------------------------------------------------
  // 4. Returns blocked for blocked permission decisions
  // -------------------------------------------------------------------------

  it('returns blocked outcome without creating an approval for blocked decisions', async () => {
    const decision = makeDecision({ decision: 'blocked', reasonCode: 'permission_ceiling_exceeded' });
    const { service, mocks } = makeService({ permission: makePermission(decision) });

    const result = await service.execute(BASE_REQUEST);

    expect(result.outcome).toBe('blocked');
    expect(mocks.prisma.approvalRequest.create).not.toHaveBeenCalled();
    expect(mocks.events.emitEnvelopeToTask).not.toHaveBeenCalled();
  });

  it('returns blocked outcome for admin_blocked decisions', async () => {
    const decision = makeDecision({ decision: 'blocked', reasonCode: 'admin_blocked' });
    const { service, mocks } = makeService({ permission: makePermission(decision) });

    const result = await service.execute(BASE_REQUEST);

    expect(result.outcome).toBe('blocked');
    expect(result.error).toBe('admin_blocked');
  });

  it('returns blocked outcome for denied_replay decisions (no new approval card)', async () => {
    const decision = makeDecision({ decision: 'blocked', reasonCode: 'denied_replay' });
    const { service, mocks } = makeService({ permission: makePermission(decision) });

    const result = await service.execute(BASE_REQUEST);

    expect(result.outcome).toBe('blocked');
    expect(mocks.prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. Returns denied when approval is denied
  // -------------------------------------------------------------------------

  it('returns denied outcome and does not call transport when approval is denied', async () => {
    const prisma = makePrisma('approval-1', 'denied');
    const transport = makeTransport();
    const { service } = makeService({ prisma, transport });

    const result = await service.execute(BASE_REQUEST);

    expect(result.outcome).toBe('denied');
    expect(result.approvalId).toBe('approval-1');
    expect(transport.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Returns expired when approval expires
  // -------------------------------------------------------------------------

  it('returns expired outcome when approval expires without decision', async () => {
    const prisma = makePrisma('approval-1', 'expired');
    const transport = makeTransport();
    const { service } = makeService({ prisma, transport });

    const result = await service.execute(BASE_REQUEST);

    expect(result.outcome).toBe('expired');
    expect(transport.create).not.toHaveBeenCalled();
  });

  it('writes expired status to DB when deadline passes with approval still pending', async () => {
    // findUnique always returns pending so the loop exhausts the deadline.
    // Use fake timers + advanceTimersByTime to skip the poll sleeps instantly.
    jest.useFakeTimers();
    const pendingApproval = { id: 'approval-1', status: 'pending', decision: null, taskId: 'task-1', sessionId: 'session-1' };
    const prisma = {
      approvalRequest: {
        create: jest.fn().mockResolvedValue(pendingApproval),
        findUnique: jest.fn().mockResolvedValue(pendingApproval),
        update: jest.fn().mockResolvedValue({ ...pendingApproval, status: 'expired' })
      }
    } as unknown as jest.Mocked<PrismaService>;
    // approvalTimeoutMs: -10000 puts expiresAt in the past so deadline is already passed
    const config = { approvalTimeoutMs: -10000 } as unknown as jest.Mocked<AppConfigService>;
    const { service } = makeService({ prisma, config });

    const resultPromise = service.execute(BASE_REQUEST);
    // Advance timers so the setTimeout inside pollForDecision resolves
    jest.runAllTimersAsync().catch(() => undefined);
    const result = await resultPromise;

    expect(result.outcome).toBe('expired');
    expect(prisma.approvalRequest.update).toHaveBeenCalledWith({
      where: { id: 'approval-1' },
      data: { status: 'expired' }
    });
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 7. Calls transport exactly once when approved
  // -------------------------------------------------------------------------

  it('calls transport exactly once and returns toolResult when approval is approved', async () => {
    const callResult = { content: [{ type: 'text', text: 'written!' }] };
    const transport = makeTransport(callResult);
    const { service } = makeService({ transport });

    const result = await service.execute(BASE_REQUEST);

    expect(result.outcome).toBe('approved');
    expect(result.toolResult).toEqual(callResult);
    const client = transport.create.mock.results[0].value;
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledWith('write_file', BASE_REQUEST.args);
  });

  it('does not call transport a second time on retry after approval', async () => {
    const transport = makeTransport();
    const { service } = makeService({ transport });

    await service.execute(BASE_REQUEST);
    const client = transport.create.mock.results[0].value;
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 8. Auto-allow for read tools
  // -------------------------------------------------------------------------

  it('executes transport immediately for auto_allow decisions without creating an approval', async () => {
    const decision = makeDecision({ decision: 'auto_allow', reasonCode: 'auto_allow_read', toolName: 'read_doc', toolRisk: 'read', ruleMatched: 'read_tool_auto_allow' });
    const transport = makeTransport();
    const { service, mocks } = makeService({ permission: makePermission(decision), transport });

    const result = await service.execute({ ...BASE_REQUEST, toolName: 'read_doc' });

    expect(result.outcome).toBe('auto_allow');
    expect(mocks.prisma.approvalRequest.create).not.toHaveBeenCalled();
    expect(transport.create).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 9. commandJson fingerprint matches TSH-114 denied-replay format
  // -------------------------------------------------------------------------

  it('uses canonicalized [serverId, toolName] as commandJson fingerprint', async () => {
    const { service, mocks } = makeService();

    await service.execute(BASE_REQUEST);

    const createCall = (mocks.prisma.approvalRequest.create as jest.Mock).mock.calls[0][0];
    const commandJson = createCall.data.commandJson;
    const parsed = JSON.parse(commandJson);
    expect(parsed).toEqual(['test-server', 'write_file']);
  });

  it('produces order-independent filesJson fingerprints for same args with different key order', async () => {
    const captured: string[] = [];
    const prisma = {
      approvalRequest: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          captured.push(data.filesJson);
          return { id: randomUUID(), status: 'approved', decision: 'approved', taskId: 'task-1', sessionId: 'session-1' };
        }),
        findUnique: jest.fn().mockResolvedValue({ status: 'approved', decision: 'approved' })
      }
    } as unknown as jest.Mocked<PrismaService>;

    const { service: s1 } = makeService({ prisma });
    const { service: s2 } = makeService({ prisma });

    await s1.execute({ ...BASE_REQUEST, args: { a: 1, b: 2 } });
    await s2.execute({ ...BASE_REQUEST, args: { b: 2, a: 1 } });

    expect(captured).toHaveLength(2);
    expect(captured[0]).toBe(captured[1]);
  });

  // -------------------------------------------------------------------------
  // 10. expectedEffect carries MCP-specific card context
  // -------------------------------------------------------------------------

  it('encodes MCP server context in expectedEffect for controller card rendering', async () => {
    const { service, mocks } = makeService();

    await service.execute(BASE_REQUEST);

    const createCall = (mocks.prisma.approvalRequest.create as jest.Mock).mock.calls[0][0];
    const effect = JSON.parse(createCall.data.expectedEffect);
    expect(effect.mcpServerId).toBe('test-server');
    expect(effect.mcpServerDisplayName).toBe('Test Server');
    expect(effect.mcpToolName).toBe('write_file');
    expect(effect.permissionLevel).toBe('write');
    expect(effect.toolRisk).toBe('write');
  });

  // -------------------------------------------------------------------------
  // 11. Audit record written for approval creation and outcome
  // -------------------------------------------------------------------------

  it('writes an audit record when the approval card is created', async () => {
    const { service, mocks } = makeService();

    await service.execute(BASE_REQUEST);

    expect(mocks.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'mcp.approval_requested',
        actionType: 'mcp.tool_call',
        taskId: 'task-1'
      })
    );
  });

  it('writes an audit record for the approval decision outcome', async () => {
    const { service, mocks } = makeService();

    await service.execute(BASE_REQUEST);

    expect(mocks.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'mcp.approval_resolved',
        decision: 'approved'
      })
    );
  });

  it('writes a denied audit record when approval is denied', async () => {
    const prisma = makePrisma('approval-1', 'denied');
    const { service, mocks } = makeService({ prisma });

    await service.execute(BASE_REQUEST);

    expect(mocks.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'mcp.approval_resolved',
        decision: 'denied'
      })
    );
  });
});
