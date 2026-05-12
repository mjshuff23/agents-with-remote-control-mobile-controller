import { HttpStatus, Injectable, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { AgentSession, ApprovalRequest, Task } from '@prisma/client';
import { AgentsService } from '../agents/agents.service';
import { AgentLogType, RunningAgentProcess } from '../agents/agent-adapter.interface';
import { ApprovalsService } from '../approvals/approvals.service';
import { ProblemException } from '../common/errors/problem.exception';
import { AppConfigService } from '../config/app-config.service';
import { EventsGateway } from '../events/events.gateway';
import { PolicyLoaderService } from '../policy/policy-loader.service';
import { ApprovalDecision, AgentActionRequest } from '../policy/policy.types';
import { PrismaService } from '../prisma/prisma.service';

const TERMINAL_SESSION_STATUSES = new Set(['completed', 'failed', 'stopped']);
const ACTION_REQUEST_PREFIX = 'ARC_ACTION_REQUEST';
const APPROVAL_RESPONSE_PREFIX = 'ARC_APPROVAL';
const PROTOCOL_BUFFER_LIMIT = 20_000;

export interface StopTaskResult {
  accepted: boolean;
  session: AgentSession;
}

export type RuntimeProcessState = 'live_process' | 'reconstructed' | 'terminal';
export type RuntimeStatusLabel = 'active' | 'waiting_approval' | 'idle' | 'dormant' | 'completed' | 'failed' | 'stopped';

export interface SessionRuntimeState {
  processState: RuntimeProcessState;
  statusLabel: RuntimeStatusLabel;
}

@Injectable()
export class AgentSessionsService implements OnApplicationBootstrap {
  private readonly runningProcesses = new Map<string, RunningAgentProcess>();
  private readonly nextLogSequences = new Map<string, number>();
  private readonly logWriteQueues = new Map<string, Promise<void>>();
  private readonly sessionToTask = new Map<string, string>();
  private readonly protocolBuffers = new Map<string, string>();
  private readonly approvalTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly approvalTimeoutSessions = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentsService,
    private readonly config: AppConfigService,
    private readonly approvals: ApprovalsService,
    private readonly policies: PolicyLoaderService,
    @Optional() private readonly events?: EventsGateway
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverInterruptedSessions();
  }

  async createAndStart(task: Task): Promise<AgentSession> {
    const session = await this.prisma.agentSession.create({
      data: {
        taskId: task.id,
        agentName: task.selectedAgent,
        status: 'starting'
      }
    });
    await this.appendLog(session.id, 'system', `Starting ${task.selectedAgent} for task ${task.id}`);

    try {
      const adapter = this.agents.getAdapter(task.selectedAgent);
      const runningProcess = await adapter.startTask({
        taskId: task.id,
        sessionId: session.id,
        repoPath: task.repoPath,
        worktreePath: task.worktreePath ?? undefined,
        branchName: task.branchName ?? undefined,
        prompt: this.buildCooperativePrompt(task),
        onOutput: async (event) => {
          await this.appendLog(session.id, event.type, event.content);
          if (event.type === 'stdout') {
            await this.handleProtocolOutput(task.id, session.id, event.content);
          }
        },
        onExit: async (event) => this.completeFromExit(task.id, session.id, event.exitCode, event.signal)
      });

      this.runningProcesses.set(session.id, runningProcess);
      this.sessionToTask.set(session.id, task.id);
      await this.prisma.task.update({
        where: { id: task.id },
        data: { status: 'running' }
      });

      return this.prisma.agentSession.update({
        where: { id: session.id },
        data: {
          status: 'running',
          externalSessionId: runningProcess.externalSessionId,
          startedAt: new Date()
        }
      });
    } catch (error) {
      const message = this.errorMessage(error);
      await this.appendLog(session.id, 'system', `Codex startup failed: ${message}`);
      await this.markSessionFailed(task.id, session.id, message);

      throw new ProblemException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'Codex agent could not be started',
        message
      );
    }
  }

  hasLiveProcess(sessionId: string): boolean {
    return this.runningProcesses.has(sessionId);
  }

  runtimeState(session: AgentSession | null): SessionRuntimeState {
    if (!session) {
      return { processState: 'reconstructed', statusLabel: 'idle' };
    }
    const statusLabel = toRuntimeStatusLabel(session.status);
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
      return { processState: 'terminal', statusLabel };
    }
    return {
      processState: this.hasLiveProcess(session.id) ? 'live_process' : 'reconstructed',
      statusLabel
    };
  }

  async sendInput(taskId: string, text: string): Promise<void> {
    const session = await this.prisma.agentSession.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' }
    });
    if (!session) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Session Not Found', `Task "${taskId}" has no agent session.`);
    }
    const running = this.runningProcesses.get(session.id);
    if (!running) {
      throw new ProblemException(HttpStatus.CONFLICT, 'Session Not Active', `Session "${session.id}" has no live process.`);
    }
    if (!running.write) {
      throw new ProblemException(HttpStatus.CONFLICT, 'Input Not Supported', 'The running agent does not accept live input.');
    }
    running.write(text);
    await this.appendLog(session.id, 'system', `Input sent (${text.length} chars)`);
  }

  async resolveApproval(
    approvalId: string,
    decision: Extract<ApprovalDecision, 'approved' | 'denied'>,
    message?: string
  ): Promise<{ approval: ApprovalRequest }> {
    const approval = await this.approvals.resolve(approvalId, decision, message);
    this.clearApprovalTimeout(approval.id);
    await this.writeApprovalResponse(approval.sessionId, {
      id: approval.actionRequestId,
      decision: approval.decision ?? decision,
      message: approval.decisionMessage ?? message ?? '',
      constraints: approval.decision === 'approved' ? ['Execute only the exact approved action in this task worktree.'] : []
    });

    if (approval.sessionId && ['approved', 'denied', 'expired'].includes(approval.status)) {
      await this.resumeIfWaiting(approval.taskId, approval.sessionId);
    }

    return { approval };
  }

  async stopTask(taskId: string): Promise<StopTaskResult> {
    const session = await this.prisma.agentSession.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' }
    });

    if (!session) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Session Not Found', `Task "${taskId}" has no agent session.`);
    }

    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
      return { accepted: false, session };
    }

    const runningProcess = this.runningProcesses.get(session.id);
    if (!runningProcess) {
      const stopped = await this.markStoppedWithoutProcess(taskId, session.id);
      return { accepted: false, session: stopped };
    }

    await this.appendLog(session.id, 'system', 'Stop requested by REST client');
    const updated = await this.prisma.agentSession.update({
      where: { id: session.id },
      data: { status: 'stopping' }
    });

    setImmediate(() => {
      void Promise.resolve(runningProcess.stop()).catch(async (error) => {
        await this.appendLog(session.id, 'system', `Stop request failed: ${this.errorMessage(error)}`);
      });
    });

    return { accepted: true, session: { ...updated } };
  }

  private async appendLog(sessionId: string, type: AgentLogType, content: string): Promise<void> {
    const previousWrite = this.logWriteQueues.get(sessionId) ?? Promise.resolve();
    const currentWrite = previousWrite.catch(() => undefined).then(async () => {
      const sequence = await this.nextSequence(sessionId);
      await this.prisma.agentLog.create({
        data: {
          sessionId,
          type,
          sequence,
          content
        }
      });
      const taskId = this.sessionToTask.get(sessionId);
      if (taskId) {
        await this.events?.emitCompatibilityEventToTask(
          taskId,
          'agent.log',
          'log',
          type === 'stderr' ? 'warn' : 'info',
          { taskId, sessionId, type, content, sequence },
          { sessionId }
        );
      }
    });

    this.logWriteQueues.set(sessionId, currentWrite);
    await currentWrite;
  }

  private clearLogState(sessionId: string): void {
    this.nextLogSequences.delete(sessionId);
    this.logWriteQueues.delete(sessionId);
    this.sessionToTask.delete(sessionId);
    this.protocolBuffers.delete(sessionId);
  }

  private async markSessionFailed(taskId: string, sessionId: string, message: string): Promise<void> {
    await this.prisma.agentSession.update({
      where: { id: sessionId },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errorMessage: message
      }
    });
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'failed' }
    });
    this.clearLogState(sessionId);
  }

  private async nextSequence(sessionId: string): Promise<number> {
    const current = this.nextLogSequences.get(sessionId);
    if (current !== undefined) {
      const next = current + 1;
      this.nextLogSequences.set(sessionId, next);
      return next;
    }

    const lastLog = await this.prisma.agentLog.findFirst({
      where: { sessionId },
      orderBy: { sequence: 'desc' }
    });
    const next = (lastLog?.sequence ?? 0) + 1;
    this.nextLogSequences.set(sessionId, next);
    return next;
  }

  private async completeFromExit(taskId: string, sessionId: string, exitCode: number, signal?: string): Promise<void> {
    this.runningProcesses.delete(sessionId);
    this.clearSessionApprovalTimeouts(sessionId);
    const current = await this.prisma.agentSession.findFirst({ where: { id: sessionId } });
    const wasStopping = current?.status === 'stopping';
    const finalSessionStatus = wasStopping ? 'stopped' : exitCode === 0 ? 'completed' : 'failed';
    const finalTaskStatus = finalSessionStatus;
    const message = signal
      ? `Agent process exited with code ${exitCode} and signal ${signal}`
      : `Agent process exited with code ${exitCode}`;

    await this.appendLog(sessionId, 'system', message);
    await this.prisma.agentSession.update({
      where: { id: sessionId },
      data: {
        status: finalSessionStatus,
        completedAt: new Date(),
        exitCode
      }
    });
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: finalTaskStatus }
    });
    await this.events?.emitCompatibilityEventToTask(taskId, 'task.completed', 'lifecycle', finalTaskStatus === 'failed' ? 'error' : 'info', {
      taskId,
      exitCode,
      status: finalTaskStatus,
      signal
    }, { sessionId });
    this.clearLogState(sessionId);
  }

  private async markStoppedWithoutProcess(taskId: string, sessionId: string): Promise<AgentSession> {
    await this.appendLog(sessionId, 'system', 'Stop requested, but no live local process was registered');
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'stopped' }
    });
    const stopped = await this.prisma.agentSession.update({
      where: { id: sessionId },
      data: {
        status: 'stopped',
        completedAt: new Date()
      }
    });
    this.clearLogState(sessionId);
    return stopped;
  }

  private async recoverInterruptedSessions(): Promise<void> {
    const interrupted = await this.prisma.agentSession.findMany({
      where: {
        status: { in: ['starting', 'running', 'stopping'] }
      }
    });

    for (const session of interrupted) {
      const status = session.status === 'stopping' ? 'stopped' : 'failed';
      await this.appendLog(session.id, 'system', `Session marked ${status} after orchestrator startup`);
      await this.prisma.agentSession.update({
        where: { id: session.id },
        data: {
          status,
          completedAt: new Date(),
          errorMessage: status === 'failed' ? 'Orchestrator restarted before the process exit was observed' : null
        }
      });
      await this.prisma.task.update({
        where: { id: session.taskId },
        data: { status }
      });
      this.clearLogState(session.id);
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private buildCooperativePrompt(task: Task): string {
    return [
      'You are running under Agents With Remote Control Mobile Controller Phase 3.',
      `Task id: ${task.id}`,
      `Worktree: ${task.worktreePath ?? task.repoPath}`,
      `Branch: ${task.branchName ?? 'unknown'}`,
      '',
      'Safety contract:',
      '- Work only inside the task worktree.',
      '- Do not read secrets such as .env, *.pem, *.key, id_*, or ~/.ssh files.',
      '- Do not commit, push, open PRs, deploy, modify global config, or run internet-piped shell scripts.',
      '- When an action may mutate files, install packages, run migrations, write git state, or execute an unknown shell command, print exactly one machine-readable line before doing it:',
      'ARC_ACTION_REQUEST {"id":"<uuid>","actionType":"fs.write_patch | fs.delete | pkg.install | db.migrate | git.commit | git.push | git.branch | test.run | shell.command","riskLevel":"SAFE | NEEDS_APPROVAL | BLOCKED","title":"short title","rationale":"why this is needed","command":["arg1","arg2"],"files":["path/a"],"expectedEffect":"one sentence"}',
      '- Wait for ARC_APPROVAL on stdin. If denied or expired, do not retry the same action by paraphrasing it. If refused or BLOCKED, do not ask again.',
      '- If approved, do only the exact approved action inside the stated constraints.',
      '- After mutating actions, allow the orchestrator to capture diff and test summaries.',
      '',
      'User task:',
      task.prompt
    ].join('\n');
  }

  private async handleProtocolOutput(taskId: string, sessionId: string, content: string): Promise<void> {
    const lines = this.extractProtocolLines(sessionId, content);
    for (const line of lines) {
      if (!line.startsWith(ACTION_REQUEST_PREFIX)) {
        continue;
      }
      try {
        const request = JSON.parse(line.slice(ACTION_REQUEST_PREFIX.length).trim()) as AgentActionRequest;
        const result = await this.approvals.createFromAgentRequest(taskId, sessionId, request);
        if (result.decision) {
          await this.writeApprovalResponse(sessionId, {
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
          void this.scheduleApprovalExpiry(result.approval.id, sessionId).catch(async (error) => {
            await this.appendLog(sessionId, 'system', `Approval expiry scheduling failed: ${this.errorMessage(error)}`);
          });
        }
      } catch (error) {
        await this.appendLog(sessionId, 'system', `Invalid ARC_ACTION_REQUEST ignored: ${this.errorMessage(error)}`);
      }
    }
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
        // Keep partial JSON buffered until more bytes arrive.
      }
    }

    this.protocolBuffers.set(sessionId, safeProtocolBufferRemainder(last));
    return complete;
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

  private async resumeIfWaiting(taskId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (session?.status !== 'waiting_approval') {
      return;
    }
    if (await this.approvals.hasPendingForSession(sessionId)) {
      return;
    }
    await this.prisma.agentSession.update({
      where: { id: sessionId },
      data: { status: 'running' }
    });
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'running' }
    });
  }

  private async writeApprovalResponse(sessionId: string | null, payload: { id: string; decision: string; message: string; constraints: string[] }): Promise<void> {
    if (!sessionId) {
      return;
    }
    const running = this.runningProcesses.get(sessionId);
    if (!running?.write) {
      await this.appendLog(sessionId, 'system', `Approval response could not be sent; session has no writable process`);
      return;
    }
    running.write(`${APPROVAL_RESPONSE_PREFIX} ${JSON.stringify(payload)}\n`);
    await this.appendLog(sessionId, 'system', `Approval ${payload.decision} sent for ${payload.id}`);
  }

  private async scheduleApprovalExpiry(approvalId: string, sessionId: string): Promise<void> {
    this.clearApprovalTimeout(approvalId);
    const timeoutMs = await this.approvalTimeoutMs();
    const timeout = setTimeout(() => {
      void this.expireApproval(approvalId, sessionId).catch(async (error) => {
        await this.appendLog(sessionId, 'system', `Approval expiry failed: ${this.errorMessage(error)}`);
      });
    }, timeoutMs).unref();
    this.approvalTimeouts.set(approvalId, timeout);
    this.approvalTimeoutSessions.set(approvalId, sessionId);
  }

  private async expireApproval(approvalId: string, sessionId: string): Promise<void> {
    this.clearApprovalTimeout(approvalId);
    let approval;
    try {
      approval = await this.approvals.resolve(approvalId, 'expired', 'Approval timed out; expired approvals are denied.');
    } catch (error) {
      if (error instanceof ProblemException && error.getStatus() === HttpStatus.CONFLICT) {
        await this.appendLog(sessionId, 'system', `Approval ${approvalId} was already resolved before expiry`);
        return;
      }
      throw error;
    }
    await this.writeApprovalResponse(sessionId, {
      id: approval.actionRequestId,
      decision: 'expired',
      message: 'Approval timed out; expired approvals are denied.',
      constraints: []
    });
    await this.resumeIfWaiting(approval.taskId, sessionId);
  }

  private clearApprovalTimeout(approvalId: string): void {
    const timeout = this.approvalTimeouts.get(approvalId);
    if (timeout) {
      clearTimeout(timeout);
      this.approvalTimeouts.delete(approvalId);
      this.approvalTimeoutSessions.delete(approvalId);
    }
  }

  private clearSessionApprovalTimeouts(sessionId: string): void {
    for (const [approvalId, timeoutSessionId] of this.approvalTimeoutSessions) {
      if (timeoutSessionId === sessionId) {
        this.clearApprovalTimeout(approvalId);
      }
    }
  }

  private async approvalTimeoutMs(): Promise<number> {
    return this.policies.approvalTimeoutMs(this.config.approvalTimeoutMs);
  }
}

function safeProtocolBufferRemainder(last: string): string {
  if (last.trim().startsWith(ACTION_REQUEST_PREFIX)) {
    // Discard oversized partial frames; a legitimate ARC_ACTION_REQUEST fits
    // well within PROTOCOL_BUFFER_LIMIT. An unbounded buffer here would allow
    // a crashed or misbehaving agent to grow it without bound.
    return last.length <= PROTOCOL_BUFFER_LIMIT ? last : '';
  }
  return last.slice(-PROTOCOL_BUFFER_LIMIT);
}

function toRuntimeStatusLabel(status: string): RuntimeStatusLabel {
  if (status === 'waiting_approval') return 'waiting_approval';
  if (status === 'idle') return 'idle';
  if (status === 'dormant') return 'dormant';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'stopped') return 'stopped';
  return 'active';
}
