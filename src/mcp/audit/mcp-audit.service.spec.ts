import { createHash } from 'crypto';
import { AuditLogService } from '../../features/audit/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { McpAuditService } from './mcp-audit.service';
import type { RecordMcpAuditInput } from './mcp-audit.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrisma(): jest.Mocked<PrismaService> {
  return {
    mcpAuditLog: {
      create: jest.fn().mockResolvedValue({ id: 'mcp-audit-1' })
    }
  } as unknown as jest.Mocked<PrismaService>;
}

function makeAudit(): jest.Mocked<AuditLogService> {
  return { append: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditLogService>;
}

function makeService(
  prisma = makePrisma(),
  audit = makeAudit()
): { service: McpAuditService; prisma: jest.Mocked<PrismaService>; audit: jest.Mocked<AuditLogService> } {
  const service = new McpAuditService(prisma, audit);
  return { service, prisma, audit };
}

function baseInput(overrides: Partial<RecordMcpAuditInput> = {}): RecordMcpAuditInput {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    serverId: 'srv-1',
    serverDisplayName: 'Test Server',
    toolName: 'read_doc',
    permissionLevel: 'read_only',
    toolRisk: 'read',
    outcome: 'auto_allow',
    args: { path: '/tmp/out.txt' },
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:00:01Z'),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// hashValue
// ---------------------------------------------------------------------------

describe('McpAuditService.hashValue', () => {
  it('returns a sha256: prefixed hex string', () => {
    const hash = McpAuditService.hashValue({ a: 1 });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces the same hash for key-order-swapped objects (canonical)', () => {
    const h1 = McpAuditService.hashValue({ a: 1, b: 2 });
    const h2 = McpAuditService.hashValue({ b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different values', () => {
    expect(McpAuditService.hashValue({ a: 1 })).not.toBe(McpAuditService.hashValue({ a: 2 }));
  });

  it('returns null for null input', () => {
    expect(McpAuditService.hashValue(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(McpAuditService.hashValue(undefined)).toBeNull();
  });

  it('hash covers raw value — secret strings produce a valid hash (not redacted)', () => {
    // hashValue hashes RAW args; sanitization is separate
    const hash = McpAuditService.hashValue({ token: 'sk-super-secret' });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The hash itself is just hex — does not contain the secret
    expect(hash).not.toContain('sk-super-secret');
  });

  it('hash value is deterministic across calls', () => {
    const input = { path: '/tmp/out.txt', content: 'hello' };
    expect(McpAuditService.hashValue(input)).toBe(McpAuditService.hashValue(input));
  });

  it('matches manual sha256 of canonicalized JSON', () => {
    const input = { b: 2, a: 1 };
    const canonical = JSON.stringify({ a: 1, b: 2 }); // sorted
    const expected = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
    expect(McpAuditService.hashValue(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// record() — McpAuditLog write
// ---------------------------------------------------------------------------

describe('McpAuditService.record', () => {
  it('writes one McpAuditLog row per call', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput());
    expect(prisma.mcpAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it('stores the correct outcome and decider for auto_allow', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ outcome: 'auto_allow' }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.outcome).toBe('auto_allow');
    expect(row.decider).toBe('policy');
  });

  it('stores the correct decider for blocked → policy', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ outcome: 'blocked' }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.decider).toBe('policy');
  });

  it('stores the correct decider for approved → user', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ outcome: 'approved' }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.decider).toBe('user');
  });

  it('stores the correct decider for denied → user', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ outcome: 'denied' }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.decider).toBe('user');
  });

  it('stores the correct decider for expired → system', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ outcome: 'expired' }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.decider).toBe('system');
  });

  it('stores the correct decider for failed → system', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ outcome: 'failed' }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.decider).toBe('system');
  });

  it('argumentHash is sha256: prefixed and covers raw args', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ args: { path: '/tmp/x' } }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.argumentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('argumentHash equals McpAuditService.hashValue of the raw args', async () => {
    const args = { path: '/tmp/x', count: 3 };
    const { service, prisma } = makeService();
    await service.record(baseInput({ args }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.argumentHash).toBe(McpAuditService.hashValue(args));
  });

  it('resultHash is null when no result provided', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ result: undefined }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.resultHash).toBeNull();
  });

  it('resultHash is sha256: prefixed when result is provided', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ outcome: 'auto_allow', result: { content: 'ok' } }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.resultHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('sanitizedArgumentPreview redacts secret keys', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ args: { token: 'sk-super-secret', path: '/tmp/x' } }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.sanitizedArgumentPreview).not.toContain('sk-super-secret');
    expect(row.sanitizedArgumentPreview).toContain('[REDACTED]');
    expect(row.sanitizedArgumentPreview).toContain('/tmp/x');
  });

  it('sanitizedArgumentPreview truncates at 4096 bytes', async () => {
    const { service, prisma } = makeService();
    const longValue = 'x'.repeat(5000);
    await service.record(baseInput({ args: { content: longValue } }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(Buffer.byteLength(row.sanitizedArgumentPreview)).toBeLessThanOrEqual(4096);
  });

  it('sanitizedResultPreview is null when no result provided', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ result: undefined }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.sanitizedResultPreview).toBeNull();
  });

  it('sanitizedResultPreview is non-null and sanitized when result is provided', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ result: { output: 'ok', token: 'sk-result-secret' } }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.sanitizedResultPreview).not.toBeNull();
    expect(row.sanitizedResultPreview).not.toContain('sk-result-secret');
    expect(row.sanitizedResultPreview).toContain('[REDACTED]');
    expect(row.sanitizedResultPreview).toContain('output');
  });

  it('sanitizedResultPreview sanitizes secrets inside array results', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ result: [{ token: 'sk-array-secret', name: 'item' }] }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.sanitizedResultPreview).not.toContain('sk-array-secret');
    expect(row.sanitizedResultPreview).toContain('[REDACTED]');
  });

  it('startedAt and finishedAt are written to the row', async () => {
    const startedAt = new Date('2026-01-01T00:00:00Z');
    const finishedAt = new Date('2026-01-01T00:00:05Z');
    const { service, prisma } = makeService();
    await service.record(baseInput({ startedAt, finishedAt }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.startedAt).toEqual(startedAt);
    expect(row.finishedAt).toEqual(finishedAt);
  });

  it('approvalRequestId is written when provided', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ approvalRequestId: 'approval-99', outcome: 'approved' }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.approvalRequestId).toBe('approval-99');
  });

  it('errorCategory is written when provided', async () => {
    const { service, prisma } = makeService();
    await service.record(baseInput({ outcome: 'failed', errorCategory: 'transport_error' }));
    const row = (prisma.mcpAuditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(row.errorCategory).toBe('transport_error');
  });

  it('does not throw when prisma.mcpAuditLog.create rejects', async () => {
    const prisma = makePrisma();
    (prisma.mcpAuditLog.create as jest.Mock).mockRejectedValue(new Error('db error'));
    const { service } = makeService(prisma);
    await expect(service.record(baseInput())).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// record() — AuditLog shadow write
// ---------------------------------------------------------------------------

describe('McpAuditService shadow write to AuditLog', () => {
  it('calls audit.append exactly once per record() call', async () => {
    const { service, audit } = makeService();
    await service.record(baseInput());
    expect(audit.append).toHaveBeenCalledTimes(1);
  });

  it('shadow kind is mcp.tool_call', async () => {
    const { service, audit } = makeService();
    await service.record(baseInput());
    const call = (audit.append as jest.Mock).mock.calls[0][0];
    expect(call.kind).toBe('mcp.tool_call');
  });

  it('shadow carries taskId and sessionId', async () => {
    const { service, audit } = makeService();
    await service.record(baseInput({ taskId: 'task-1', sessionId: 'session-1' }));
    const call = (audit.append as jest.Mock).mock.calls[0][0];
    expect(call.taskId).toBe('task-1');
    expect(call.sessionId).toBe('session-1');
  });

  it('shadow message includes server and tool name', async () => {
    const { service, audit } = makeService();
    await service.record(baseInput());
    const call = (audit.append as jest.Mock).mock.calls[0][0];
    expect(call.message).toContain('Test Server');
    expect(call.message).toContain('read_doc');
  });

  it('shadow does NOT include sanitizedArgumentPreview in metadata', async () => {
    const { service, audit } = makeService();
    await service.record(baseInput({ args: { token: 'sk-secret', path: '/tmp/x' } }));
    const call = (audit.append as jest.Mock).mock.calls[0][0];
    // metadataJson must not contain any preview data
    const metaStr = JSON.stringify(call.metadata ?? {});
    expect(metaStr).not.toContain('sanitizedArgumentPreview');
    expect(metaStr).not.toContain('sk-secret');
    expect(metaStr).not.toContain('/tmp/x');
  });

  it('shadow does NOT include hash values in metadata', async () => {
    const { service, audit } = makeService();
    await service.record(baseInput());
    const call = (audit.append as jest.Mock).mock.calls[0][0];
    const metaStr = JSON.stringify(call.metadata ?? {});
    expect(metaStr).not.toContain('argumentHash');
    expect(metaStr).not.toContain('resultHash');
  });

  it('shadow failure does not propagate — record() still resolves', async () => {
    const audit = makeAudit();
    (audit.append as jest.Mock).mockRejectedValue(new Error('shadow failed'));
    const { service } = makeService(makePrisma(), audit);
    await expect(service.record(baseInput())).resolves.toBeUndefined();
  });
});
