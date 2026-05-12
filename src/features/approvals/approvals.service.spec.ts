import { ActionClassifierService } from '../policy/action-classifier.service';
import { PolicyLoaderService } from '../policy/policy-loader.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalsService } from './approvals.service';

describe('ApprovalsService', () => {
  const now = new Date('2026-05-11T12:00:00.000Z');
  const prisma = {
    approvalRequest: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn()
    }
  } as unknown as PrismaService;
  const classifier = { classify: jest.fn() } as unknown as ActionClassifierService;
  const audit = { append: jest.fn() };
  const config = { approvalTimeoutMs: 300000 };
  const policies = { approvalTimeoutMs: jest.fn(async (fallback: number) => fallback) } as unknown as PolicyLoaderService;
  const events = { emitEnvelopeToTask: jest.fn() };
  const service = new ApprovalsService(prisma, classifier, audit as any, config as any, policies, events as any);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    (prisma.approvalRequest.findFirst as jest.Mock).mockResolvedValue(null);
    (policies.approvalTimeoutMs as jest.Mock).mockResolvedValue(config.approvalTimeoutMs);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates pending approvals for NEEDS_APPROVAL requests and emits approval.requested', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue({
      riskLevel: 'NEEDS_APPROVAL',
      ruleMatched: 'fs.mutation',
      rationale: 'file writes require approval'
    });
    (prisma.approvalRequest.create as jest.Mock).mockImplementation(async ({ data }) => ({ id: 'approval-1', ...data }));

    const result = await service.createFromAgentRequest('task-1', 'session-1', {
      id: 'action-1',
      actionType: 'fs.write_patch',
      title: 'Patch file',
      files: ['src/a.ts']
    });

    expect(result.decision).toBeUndefined();
    expect(prisma.approvalRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'pending',
        riskLevel: 'NEEDS_APPROVAL',
        ruleMatched: 'fs.mutation',
        expiresAt: new Date('2026-05-11T12:05:00.000Z')
      })
    });
    expect(events.emitEnvelopeToTask).toHaveBeenCalledWith(
      'task-1',
      'approval.requested',
      'approval',
      'warn',
      expect.objectContaining({ id: 'approval-1' }),
      expect.objectContaining({ sessionId: 'session-1', correlationId: 'action-1' })
    );
  });

  it('uses the policy-driven approval timeout for persisted expiry', async () => {
    (policies.approvalTimeoutMs as jest.Mock).mockResolvedValue(1000);
    (classifier.classify as jest.Mock).mockResolvedValue({
      riskLevel: 'NEEDS_APPROVAL',
      ruleMatched: 'fs.mutation',
      rationale: 'file writes require approval'
    });
    (prisma.approvalRequest.create as jest.Mock).mockImplementation(async ({ data }) => ({ id: 'approval-1', ...data }));

    await service.createFromAgentRequest('task-1', 'session-1', {
      id: 'action-1',
      actionType: 'fs.write_patch',
      title: 'Patch file'
    });

    expect(prisma.approvalRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        expiresAt: new Date('2026-05-11T12:00:01.000Z')
      })
    });
  });

  it('refuses blocked requests without surfacing an approvable card', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue({
      riskLevel: 'BLOCKED',
      ruleMatched: 'secrets.paths',
      rationale: 'secret path'
    });
    (prisma.approvalRequest.create as jest.Mock).mockImplementation(async ({ data }) => ({ id: 'approval-1', ...data }));

    const result = await service.createFromAgentRequest('task-1', 'session-1', {
      id: 'action-1',
      actionType: 'fs.write_patch',
      title: 'Read env',
      files: ['.env']
    });

    expect(result.decision).toBe('refused');
    expect(events.emitEnvelopeToTask).toHaveBeenCalledWith(
      'task-1',
      'policy.violation',
      'security',
      'error',
      expect.objectContaining({ decision: 'refused' }),
      expect.any(Object)
    );
  });

  it('turns repeated denied actions into security violations', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue({
      riskLevel: 'NEEDS_APPROVAL',
      ruleMatched: 'fs.mutation',
      rationale: 'file writes require approval'
    });
    (prisma.approvalRequest.findFirst as jest.Mock).mockResolvedValue(
      {
        id: 'old-approval',
        taskId: 'task-1',
        actionType: 'fs.write_patch',
        commandJson: '["apply_patch"]',
        filesJson: '["src/a.ts"]',
        status: 'denied'
      }
    );
    (prisma.approvalRequest.create as jest.Mock).mockImplementation(async ({ data }) => ({ id: 'approval-2', ...data }));

    const result = await service.createFromAgentRequest('task-1', 'session-1', {
      id: 'action-2',
      actionType: 'fs.write_patch',
      title: 'Patch same file',
      command: ['apply_patch'],
      files: ['src/a.ts']
    });

    expect(result.decision).toBe('refused');
    expect(result.approval.ruleMatched).toBe('security.denied_retry');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'security.denied_retry',
      decision: 'refused'
    }));
    expect(events.emitEnvelopeToTask).toHaveBeenCalledWith(
      'task-1',
      'policy.violation',
      'security',
      'error',
      expect.objectContaining({ ruleMatched: 'security.denied_retry' }),
      expect.any(Object)
    );
  });

  it('expires pending approvals instead of approving after timeout', async () => {
    const expiredApproval = {
      id: 'approval-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      actionRequestId: 'action-1',
      actionType: 'fs.write_patch',
      riskLevel: 'NEEDS_APPROVAL',
      status: 'pending',
      ruleMatched: 'fs.mutation',
      correlationId: 'action-1',
      expiresAt: new Date('2026-05-11T11:59:59.000Z')
    };
    (prisma.approvalRequest.findUnique as jest.Mock).mockResolvedValue(expiredApproval);
    (prisma.approvalRequest.update as jest.Mock).mockImplementation(async ({ data }) => ({
      ...expiredApproval,
      ...data
    }));

    const resolved = await service.resolve('approval-1', 'approved', 'Too late');

    expect(resolved.status).toBe('expired');
    expect(resolved.decision).toBe('expired');
    expect(prisma.approvalRequest.update).toHaveBeenCalledWith({
      where: { id: 'approval-1' },
      data: expect.objectContaining({
        status: 'expired',
        decision: 'expired'
      })
    });
  });

  it('conflicts when resolving an already resolved approval', async () => {
    const resolvedApproval = {
      id: 'approval-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      actionRequestId: 'action-1',
      actionType: 'fs.write_patch',
      riskLevel: 'NEEDS_APPROVAL',
      status: 'denied',
      ruleMatched: 'fs.mutation',
      expiresAt: new Date('2026-05-11T12:10:00.000Z')
    };
    (prisma.approvalRequest.findUnique as jest.Mock).mockResolvedValue(resolvedApproval);

    await expect(service.resolve('approval-1', 'approved')).rejects.toMatchObject({
      response: { status: 409 }
    });
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'approval.resolve_conflict',
      decision: 'approved'
    }));
  });
});
