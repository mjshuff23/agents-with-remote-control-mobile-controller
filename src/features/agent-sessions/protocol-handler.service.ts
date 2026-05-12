import { HttpStatus, Injectable } from '@nestjs/common';
import { ProblemException } from '../../common/errors/problem.exception';
import { AppConfigService } from '../../config/app-config.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { PolicyLoaderService } from '../policy/policy-loader.service';
import { ApprovalDecision, AgentActionRequest } from '../policy/policy.types';
import { PrismaService } from '../../prisma/prisma.service';

const ACTION_REQUEST_PREFIX = 'ARC_ACTION_REQUEST';
const APPROVAL_RESPONSE_PREFIX = 'ARC_APPROVAL';
const PROTOCOL_BUFFER_LIMIT = 20_000;

export interface ApprovalResponsePayload {
  id: string;
  decision: string;
  message: string;
  constraints: string[];
}

export type WriteToAgentFn = (text: string) => void;

export type AppendLogFn = (sessionId: string, message: string) => Promise<void>;

@Injectable()
export class ProtocolHandlerService {
  private readonly protocolBuffers = new Map<string, string>();
  private readonly approvalTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly approvalTimeoutSessions = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly config: AppConfigService,
    private readonly policies: PolicyLoaderService
  ) {}

  async handleProtocolOutput(
    taskId: string,
    sessionId: string,
    content: string,
    writeResponse: (response: ApprovalResponsePayload) => Promise<void>,
    appendLog: (sessionId: string, message: string) => Promise<void>,
    updateWorkerActivity: (sessionId: string) => Promise<void>
  ): Promise<void> {
    const lines = this.extractProtocolLines(sessionId, content);
    for (const line of lines) {
      if (!line.startsWith(ACTION_REQUEST_PREFIX)) continue;

      try {
        await updateWorkerActivity(sessionId);
        const request = JSON.parse(line.slice(ACTION_REQUEST_PREFIX.length).trim()) as AgentActionRequest;
        const result = await this.approvals.createFromAgentRequest(taskId, sessionId, request);
        if (result.decision) {
          await writeResponse({
            id: request.id,
            decision: result.decision === 'auto_allow' ? 'approved' : result.decision,
            message: result.responseMessage ?? '',
            constraints: result.decision === 'auto_allow' || result.decision === 'approved'
              ? ['Execute only the exact approved action in this task worktree.']
              : []
          });
        } else {
          await this.markWaitingForApproval(taskId, sessionId);
          await this.resumeIfWaiting(taskId, sessionId);
          void this.scheduleApprovalExpiry(result.approval.id, sessionId, appendLog).catch(async (error) => {
            await appendLog(sessionId, `Approval expiry scheduling failed: ${this.errorMessage(error)}`);
          });
        }
      } catch (error) {
        await appendLog(sessionId, `Invalid ARC_ACTION_REQUEST ignored: ${this.errorMessage(error)}`);
      }
    }
  }

  async writeApprovalResponse(
    writeToAgent: WriteToAgentFn | undefined,
    appendLog: (sessionId: string, message: string) => Promise<void>,
    sessionId: string | null,
    payload: ApprovalResponsePayload
  ): Promise<void> {
    if (!sessionId || !writeToAgent) {
      await appendLog(sessionId ?? 'unknown', 'Approval response could not be sent; session has no writable process');
      return;
    }
    writeToAgent(`${APPROVAL_RESPONSE_PREFIX} ${JSON.stringify(payload)}\n`);
    await appendLog(sessionId, `Approval ${payload.decision} sent for ${payload.id}`);
  }

  clearApprovalTimeout(approvalId: string): void {
    const timeout = this.approvalTimeouts.get(approvalId);
    if (timeout) {
      clearTimeout(timeout);
      this.approvalTimeouts.delete(approvalId);
      this.approvalTimeoutSessions.delete(approvalId);
    }
  }

  clearSessionApprovalTimeouts(sessionId: string): void {
    for (const [approvalId, timeoutSessionId] of this.approvalTimeoutSessions) {
      if (timeoutSessionId === sessionId) {
        this.clearApprovalTimeout(approvalId);
      }
    }
  }

  clearBuffersForSession(sessionId: string): void {
    this.protocolBuffers.delete(sessionId);
    this.clearSessionApprovalTimeouts(sessionId);
  }

  async resumeIfWaiting(taskId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (session?.status !== 'waiting_approval') return;
    if (await this.approvals.hasPendingForSession(sessionId)) return;
    await this.prisma.agentSession.update({
      where: { id: sessionId },
      data: { status: 'running' }
    });
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'running' }
    });
  }

  private async markWaitingForApproval(taskId: string, sessionId: string): Promise<void> {
    await this.prisma.agentSession.update({
      where: { id: sessionId },
      data: { status: 'waiting_approval' }
    });
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'waiting_approval' }
    });
  }

  private extractProtocolLines(sessionId: string, content: string): string[] {
    const buffered = (this.protocolBuffers.get(sessionId) ?? '') + content;
    const parts = buffered.split(/\r?\n/);
    const last = parts.pop() ?? '';
    const complete = parts.map((line) => line.trim()).filter(Boolean);

    if (last.trim().startsWith(ACTION_REQUEST_PREFIX)) {
      try {
        JSON.parse(last.trim().slice(ACTION_REQUEST_PREFIX.length).trim());
        complete.push(last.trim());
        this.protocolBuffers.set(sessionId, '');
        return complete;
      } catch {
        // Keep partial JSON buffered
      }
    }

    this.protocolBuffers.set(sessionId, safeProtocolBufferRemainder(last));
    return complete;
  }

  private async scheduleApprovalExpiry(approvalId: string, sessionId: string, appendLog?: AppendLogFn): Promise<void> {
    this.clearApprovalTimeout(approvalId);
    const timeoutMs = await this.approvalTimeoutMs();
    const timeout = setTimeout(() => {
      void this.expireApproval(approvalId, sessionId).catch(() => {});
    }, timeoutMs).unref();
    this.approvalTimeouts.set(approvalId, timeout);
    this.approvalTimeoutSessions.set(approvalId, sessionId);
  }

  private async expireApproval(approvalId: string, sessionId: string, appendLog?: AppendLogFn): Promise<void> {
    this.clearApprovalTimeout(approvalId);
    let approval;
    try {
      approval = await this.approvals.resolve(approvalId, 'expired', 'Approval timed out; expired approvals are denied.');
    } catch (error) {
      if (error instanceof ProblemException && error.getStatus() === HttpStatus.CONFLICT) return;
      throw error;
    }
    const logFn = appendLog ?? (() => Promise.resolve());
    await this.writeApprovalResponse(undefined, logFn, approval.sessionId, {
      id: approval.actionRequestId,
      decision: 'expired',
      message: 'Approval timed out; expired approvals are denied.',
      constraints: []
    });
    await this.resumeIfWaiting(approval.taskId, sessionId);
  }

  private async approvalTimeoutMs(): Promise<number> {
    return this.policies.approvalTimeoutMs(this.config.approvalTimeoutMs);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function safeProtocolBufferRemainder(last: string): string {
  if (last.trim().startsWith(ACTION_REQUEST_PREFIX)) {
    return last.length <= PROTOCOL_BUFFER_LIMIT ? last : '';
  }
  return last.slice(-PROTOCOL_BUFFER_LIMIT);
}
