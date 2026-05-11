import { HttpStatus, Injectable } from '@nestjs/common';
import { ApprovalRequest } from '@prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { ProblemException } from '../common/errors/problem.exception';
import { AppConfigService } from '../config/app-config.service';
import { EventsGateway } from '../events/events.gateway';
import { ActionClassifierService } from '../policy/action-classifier.service';
import { PolicyLoaderService } from '../policy/policy-loader.service';
import { AgentActionRequest, ApprovalDecision } from '../policy/policy.types';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateApprovalResult {
  approval: ApprovalRequest;
  decision?: ApprovalDecision;
  responseMessage?: string;
}

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly classifier: ActionClassifierService,
    private readonly audit: AuditLogService,
    private readonly config: AppConfigService,
    private readonly policies: PolicyLoaderService,
    private readonly events: EventsGateway
  ) {}

  async listForTask(taskId: string): Promise<{ approvals: ApprovalRequest[] }> {
    const approvals = await this.prisma.approvalRequest.findMany({
      where: { taskId },
      orderBy: { requestedAt: 'desc' },
      take: 50
    });
    return { approvals };
  }

  async hasPendingForSession(sessionId: string): Promise<boolean> {
    const pending = await this.prisma.approvalRequest.findFirst({
      where: { sessionId, status: 'pending' }
    });
    return pending !== null;
  }

  async createFromAgentRequest(taskId: string, sessionId: string, request: AgentActionRequest): Promise<CreateApprovalResult> {
    this.validateRequest(request);
    const commandJson = JSON.stringify(request.command ?? []);
    const filesJson = JSON.stringify(request.files ?? []);
    const repeated = await this.findRepeatedDenied(taskId, request.actionType, commandJson, filesJson);
    const timeoutMs = await this.policies.approvalTimeoutMs(this.config.approvalTimeoutMs);
    const expiresAt = new Date(Date.now() + timeoutMs);

    if (repeated) {
      const approval = await this.prisma.approvalRequest.create({
        data: {
          taskId,
          sessionId,
          actionRequestId: request.id,
          actionType: request.actionType,
          riskLevel: 'BLOCKED',
          title: request.title,
          rationale: request.rationale,
          commandJson,
          filesJson,
          expectedEffect: request.expectedEffect,
          status: 'refused',
          decision: 'refused',
          decisionMessage: 'Repeated denied/refused action request was blocked.',
          ruleMatched: 'security.denied_retry',
          correlationId: request.id,
          expiresAt,
          resolvedAt: new Date()
        }
      });
      await this.audit.append({
        taskId,
        sessionId,
        approvalRequestId: approval.id,
        kind: 'security.denied_retry',
        actionType: request.actionType,
        riskLevel: 'BLOCKED',
        ruleMatched: 'security.denied_retry',
        decision: 'refused',
        message: 'Agent retried a denied/refused action with the same command/files.',
        metadata: { actionRequestId: request.id }
      });
      this.events.emitEnvelopeToTask(taskId, 'policy.violation', 'security', 'error', approval, {
        sessionId,
        correlationId: request.id
      });
      return { approval, decision: 'refused', responseMessage: 'Repeated denied/refused action request was blocked.' };
    }

    const classification = await this.classifier.classify(request);
    const terminalDecision =
      classification.riskLevel === 'BLOCKED' ? 'refused' :
        classification.riskLevel === 'SAFE' ? 'auto_allow' :
          undefined;
    const status =
      terminalDecision === 'refused' ? 'refused' :
        terminalDecision === 'auto_allow' ? 'approved' :
          'pending';
    const approval = await this.prisma.approvalRequest.create({
      data: {
        taskId,
        sessionId,
        actionRequestId: request.id,
        actionType: request.actionType,
        riskLevel: classification.riskLevel,
        title: request.title,
        rationale: request.rationale,
        commandJson,
        filesJson,
        expectedEffect: request.expectedEffect,
        status,
        decision: terminalDecision,
        decisionMessage: terminalDecision ? classification.rationale : undefined,
        ruleMatched: classification.ruleMatched,
        correlationId: request.id,
        expiresAt,
        resolvedAt: terminalDecision ? new Date() : undefined
      }
    });

    await this.audit.append({
      taskId,
      sessionId,
      approvalRequestId: approval.id,
      kind: terminalDecision ? 'approval.resolved' : 'approval.requested',
      actionType: request.actionType,
      riskLevel: classification.riskLevel,
      ruleMatched: classification.ruleMatched,
      decision: terminalDecision,
      message: classification.rationale,
      metadata: { actionRequestId: request.id }
    });

    if (classification.riskLevel === 'BLOCKED') {
      this.events.emitEnvelopeToTask(taskId, 'policy.violation', 'security', 'error', approval, {
        sessionId,
        correlationId: request.id
      });
    } else if (classification.riskLevel === 'NEEDS_APPROVAL') {
      this.events.emitEnvelopeToTask(taskId, 'approval.requested', 'approval', 'warn', approval, {
        sessionId,
        correlationId: request.id
      });
    } else {
      this.events.emitEnvelopeToTask(taskId, 'approval.resolved', 'approval', 'info', approval, {
        sessionId,
        correlationId: request.id
      });
    }

    return { approval, decision: terminalDecision, responseMessage: classification.rationale };
  }

  async resolve(approvalId: string, decision: Exclude<ApprovalDecision, 'auto_allow'>, message?: string): Promise<ApprovalRequest> {
    const approval = await this.prisma.approvalRequest.findUnique({ where: { id: approvalId } });
    if (!approval) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Approval Not Found', `Approval "${approvalId}" does not exist.`);
    }
    if (approval.status !== 'pending') {
      await this.audit.append({
        taskId: approval.taskId,
        sessionId: approval.sessionId ?? undefined,
        approvalRequestId: approval.id,
        kind: 'approval.resolve_conflict',
        actionType: approval.actionType,
        riskLevel: approval.riskLevel,
        ruleMatched: approval.ruleMatched ?? undefined,
        decision,
        message: `Approval "${approval.id}" is already ${approval.status}`,
        metadata: { attemptedDecision: decision }
      });
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'Approval Already Resolved',
        `Approval "${approval.id}" is already ${approval.status}.`
      );
    }

    const now = new Date();
    const finalDecision = now > approval.expiresAt && decision === 'approved' ? 'expired' : decision;
    const status = finalDecision === 'approved' ? 'approved' : finalDecision;
    const resolved = await this.prisma.approvalRequest.update({
      where: { id: approval.id },
      data: {
        status,
        decision: finalDecision,
        decisionMessage: message,
        resolvedAt: now
      }
    });

    await this.audit.append({
      taskId: resolved.taskId,
      sessionId: resolved.sessionId ?? undefined,
      approvalRequestId: resolved.id,
      kind: 'approval.resolved',
      actionType: resolved.actionType,
      riskLevel: resolved.riskLevel,
      ruleMatched: resolved.ruleMatched ?? undefined,
      decision: finalDecision,
      message: message || `Approval ${finalDecision}`,
      metadata: { actionRequestId: resolved.actionRequestId }
    });

    this.events.emitEnvelopeToTask(resolved.taskId, 'approval.resolved', 'approval', finalDecision === 'approved' ? 'info' : 'warn', resolved, {
      sessionId: resolved.sessionId ?? undefined,
      correlationId: resolved.correlationId ?? undefined
    });

    return resolved;
  }

  private async findRepeatedDenied(taskId: string, actionType: string, commandJson: string, filesJson: string): Promise<ApprovalRequest | null> {
    return this.prisma.approvalRequest.findFirst({
      where: {
        taskId,
        actionType,
        status: { in: ['denied', 'expired', 'refused'] },
        commandJson,
        filesJson
      },
      orderBy: { requestedAt: 'desc' }
    });
  }

  private validateRequest(request: AgentActionRequest): void {
    if (!request.id || !request.actionType || !request.title) {
      throw new ProblemException(HttpStatus.BAD_REQUEST, 'Invalid Action Request', 'ARC_ACTION_REQUEST must include id, actionType, and title');
    }
    if (request.command && !Array.isArray(request.command)) {
      throw new ProblemException(HttpStatus.BAD_REQUEST, 'Invalid Action Request', 'ARC_ACTION_REQUEST command must be an array');
    }
    if (request.files && !Array.isArray(request.files)) {
      throw new ProblemException(HttpStatus.BAD_REQUEST, 'Invalid Action Request', 'ARC_ACTION_REQUEST files must be an array');
    }
  }
}
