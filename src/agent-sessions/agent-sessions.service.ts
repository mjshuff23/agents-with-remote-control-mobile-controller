import { HttpStatus, Injectable, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { AgentSession, ApprovalRequest, Task } from '@prisma/client';
import { AgentsService } from '../agents/agents.service';
import { AgentLogType, RunningAgentProcess } from '../agents/agent-adapter.interface';
import { ApprovalsService } from '../approvals/approvals.service';
import { CheckpointsService } from '../checkpoints/checkpoints.service';
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
    private readonly checkpoints: CheckpointsService,
    @Optional() private readonly events?: EventsGateway
  ) {}

  /** Recover sessions that were interrupted by a prior orchestrator crash. */
  async onApplicationBootstrap(): Promise<void> {
    await this.recoverInterruptedSessions();
  }

  /**
   * Restore a dormant session back to running: rehydrate state from the
   * checkpoint, relaunch the agent in the preserved worktree context,
   * wire callbacks, and flip the DB status.
   */
  async restoreSession(sessionId: string): Promise<{ session: AgentSession }> {
    // Atomically transition from dormant to restoring to prevent races
    const updateResult = await this.prisma.agentSession.updateMany({
      where: { id: sessionId, status: 'dormant' },
      data: { status: 'restoring' }
    });

    if (updateResult.count === 0) {
      const session = await this.prisma.agentSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        throw new ProblemException(HttpStatus.NOT_FOUND, 'Session Not Found', `Session "${sessionId}" does not exist.`);
      }
      if (session.status === 'restoring') {
        throw new ProblemException(HttpStatus.CONFLICT, 'Restore In Progress', 'A restore is already in progress for this session.');
      }
      throw new ProblemException(HttpStatus.CONFLICT, 'Not Dormant', `Session "${sessionId}" is ${session.status}, not dormant.`);
    }

    const session = await this.prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Session Not Found', `Session "${sessionId}" does not exist.`);
    }

    const checkpoint = await this.checkpoints.latestForSession(sessionId);
    if (!checkpoint) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'No Checkpoint', `No checkpoint found for dormant session "${sessionId}".`);
    }

    const task = await this.prisma.task.findUnique({ where: { id: checkpoint.taskId } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${checkpoint.taskId}" for checkpoint not found.`);
    }

    const adapter = this.agents.getAdapter(task.selectedAgent);

    const frontier = this.parseFrontier(checkpoint.frontierJson);
    const prompt = this.buildCooperativeRestorePrompt(task, frontier);
    const launch = this.parseLaunchMetadata(checkpoint.launchMetadataJson);

    try {
      let runningProcess: RunningAgentProcess;
      try {
        runningProcess = await adapter.startTask({
          taskId: task.id,
          sessionId: session.id,
          repoPath: launch.repoPath ?? task.repoPath,
          worktreePath: launch.worktreePath ?? task.worktreePath ?? undefined,
          branchName: launch.branchName ?? task.branchName ?? undefined,
          prompt,
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
      } catch (error) {
        // Revert status back to dormant on failure
        await this.prisma.agentSession.update({
          where: { id: sessionId },
          data: { status: 'dormant' }
        });
        const message = this.errorMessage(error);
        await this.appendLog(session.id, 'system', `Restore relaunch failed: ${message}`);
        throw new ProblemException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'Agent could not be restarted from checkpoint',
          message
        );
      }

      let result: import('../checkpoints/checkpoints.service').RestoreResult;
      try {
        result = await this.checkpoints.restore(sessionId);
      } catch (error) {
        this.runningProcesses.delete(session.id);
        this.sessionToTask.delete(session.id);
        await Promise.resolve(runningProcess.stop?.()).catch(() => undefined);
        throw error;
      }
      await this.appendLog(session.id, 'system', `Session restored from dormant (checkpoint ${checkpoint.id})`);

      return { session: result.session };
    } catch (error) {
      // Ensure status is reverted to dormant if checkpoint.restore fails
      await this.prisma.agentSession.update({
        where: { id: sessionId },
        data: { status: 'dormant' }
      }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Create an AgentSession row, launch the agent adapter process,
   * wire output/exit callbacks, and update the session/task status.
   */
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

      const updated = await this.prisma.agentSession.update({
        where: { id: session.id },
        data: {
          status: 'running',
          externalSessionId: runningProcess.externalSessionId,
          startedAt: new Date()
        }
      });

      void this.checkpoints.captureAtBoundary(session.id, task.id, 'session_start', {
        workerWasLive: this.hasLiveProcess(session.id)
      }).catch((err) => {
        this.appendLog(session.id, 'system', `Checkpoint capture failed (session_start): ${this.errorMessage(err)}`);
      });

      return updated;
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

  /** Whether a live (in-memory) process is registered for the given session. */
  hasLiveProcess(sessionId: string): boolean {
    return this.runningProcesses.has(sessionId);
  }

  /**
   * Derive a runtime state object (process state + status label) from
   * a session record, checking live process registry.
   */
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

  /**
   * Send stdin text to the running agent process for a task.
   */
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
    await this.updateUserActivity(session.id);

    void this.checkpoints.captureAtBoundary(session.id, session.taskId, 'user_turn', {
      lastUserMessage: text,
      workerWasLive: this.hasLiveProcess(session.id)
    }).catch((err) => this.appendLog(session.id, 'system', `Checkpoint capture failed (user_turn): ${this.errorMessage(err)}`));
  }

  /**
   * Resolve a pending approval by delegating to ApprovalsService,
   * writing the ARC_APPROVAL response back to the agent, and
   * resuming the session if no approvals remain pending.
   */
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

    if (approval.sessionId) {
      await this.updateUserActivity(approval.sessionId);

      void this.checkpoints.captureAtBoundary(approval.sessionId, approval.taskId, 'approval_event', {
        workerWasLive: this.hasLiveProcess(approval.sessionId)
      }).catch((err) =>
        this.appendLog(approval.sessionId!, 'system', `Checkpoint capture failed (approval_event): ${this.errorMessage(err)}`)
      );
    }

    return { approval };
  }

  /**
   * Stop a running task by killing its agent process.
   * Returns immediately with `accepted: true`; the actual kill is deferred.
   */
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
    await this.updateUserActivity(session.id);

    void this.checkpoints.captureAtBoundary(session.id, session.taskId, 'pre_stop', {
      workerWasLive: this.hasLiveProcess(session.id)
    }).catch((err) =>
      this.appendLog(session.id, 'system', `Checkpoint capture failed (pre_stop): ${this.errorMessage(err)}`)
    );

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

  /** Append a log entry, queued per-session to preserve sequence order. */
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
      await this.updateWorkerActivity(sessionId);
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

  /** Clear per-session in-memory state (sequences, queues, buffers). */
  private clearLogState(sessionId: string): void {
    this.nextLogSequences.delete(sessionId);
    this.logWriteQueues.delete(sessionId);
    this.sessionToTask.delete(sessionId);
    this.protocolBuffers.delete(sessionId);
  }

  /** Mark both session and task as failed with an error message. */
  private async markSessionFailed(taskId: string, sessionId: string, message: string): Promise<void> {
    void this.checkpoints.captureAtBoundary(sessionId, taskId, 'pre_terminal').catch((err) =>
      this.appendLog(sessionId, 'system', `Checkpoint capture failed (pre_terminal): ${this.errorMessage(err)}`)
    );
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

  /** Get the next monotonic log sequence number for a session. */
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

  /** Handle agent process exit: determine final status, persist it, emit event. */
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

    void this.checkpoints.captureAtBoundary(sessionId, taskId, 'pre_terminal').catch((err) =>
      this.appendLog(sessionId, 'system', `Checkpoint capture failed (pre_terminal): ${this.errorMessage(err)}`)
    );

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

  /** Mark a session as stopped when no live process is registered. */
  private async markStoppedWithoutProcess(taskId: string, sessionId: string): Promise<AgentSession> {
    await this.appendLog(sessionId, 'system', 'Stop requested, but no live local process was registered');

    void this.checkpoints.captureAtBoundary(sessionId, taskId, 'pre_stop').catch((err) =>
      this.appendLog(sessionId, 'system', `Checkpoint capture failed (pre_stop): ${this.errorMessage(err)}`)
    );

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

  /** Recover sessions interrupted by orchestrator crash. */
  private async recoverInterruptedSessions(): Promise<void> {
    const interrupted = await this.prisma.agentSession.findMany({
      where: {
        status: { in: ['starting', 'running', 'stopping', 'restoring'] }
      }
    });

    for (const session of interrupted) {
      if (session.status === 'stopping') {
        await this.appendLog(session.id, 'system', 'Session marked stopped after orchestrator startup');
        await this.prisma.agentSession.update({
          where: { id: session.id },
          data: { status: 'stopped', completedAt: new Date() }
        });
        await this.prisma.task.update({
          where: { id: session.taskId },
          data: { status: 'stopped' }
        });
      } else if (session.status === 'starting') {
        await this.appendLog(session.id, 'system', 'Session marked failed after orchestrator startup');
        await this.prisma.agentSession.update({
          where: { id: session.id },
          data: {
            status: 'failed',
            completedAt: new Date(),
            errorMessage: 'Orchestrator restarted before the session could start'
          }
        });
        await this.prisma.task.update({
          where: { id: session.taskId },
          data: { status: 'failed' }
        });
      } else if (session.status === 'restoring') {
        await this.appendLog(session.id, 'system', 'Session reverted to dormant (restore was interrupted by orchestrator restart)');
        await this.prisma.agentSession.update({
          where: { id: session.id },
          data: {
            status: 'dormant',
            dormantAt: new Date(),
            dormantReason: 'orchestrator_restart'
          }
        });
        await this.prisma.task.update({
          where: { id: session.taskId },
          data: { status: 'dormant' }
        });
      } else {
        // running → dormant: recoverable, not failed
        const existing = await this.checkpoints.latestForSession(session.id);
        if (!existing) {
          const captured = await this.checkpoints.captureAtBoundary(session.id, session.taskId, 'pre_transition');
          if (!captured) {
            await this.appendLog(session.id, 'system', 'Session marked failed after orchestrator startup (no checkpoint could be created for restore)');
            await this.prisma.agentSession.update({
              where: { id: session.id },
              data: {
                status: 'failed',
                completedAt: new Date(),
                errorMessage: 'Orchestrator restarted and no checkpoint was available for restore'
              }
            });
            await this.prisma.task.update({
              where: { id: session.taskId },
              data: { status: 'failed' }
            });
            this.clearLogState(session.id);
            continue;
          }
        }
        await this.appendLog(session.id, 'system', 'Session moved to dormant after orchestrator startup (live process was lost)');
        await this.prisma.agentSession.update({
          where: { id: session.id },
          data: {
            status: 'dormant',
            dormantAt: new Date(),
            dormantReason: 'orchestrator_restart'
          }
        });
        await this.prisma.task.update({
          where: { id: session.taskId },
          data: { status: 'dormant' }
        });
      }
      this.clearLogState(session.id);
    }
  }

  /** Safely extract an error message string. */
  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** Build the Phase 3 cooperative prompt that instructs the agent on the safety protocol. */
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

  /**
   * Build a restore prompt from checkpoint frontier data.
   * Reuses the cooperative prompt structure and appends continuation context.
   */
  private buildCooperativeRestorePrompt(task: Task, frontier: { prompt: string; currentInstructions?: string }): string {
    const base = this.buildCooperativePrompt({
      ...task,
      prompt: frontier.prompt || task.prompt
    });
    return [
      base,
      '',
      '--- SESSION RESTORED FROM CHECKPOINT ---',
      'Your previous session was checkpointed and has been restored. Continue working on the task above.',
      'All previous worktree state, branch, and approvals are preserved.',
      'If you were in the middle of a multi-step plan, review the current state and continue.'
    ].join('\n');
  }

  /**
   * Parse the frontier JSON from a checkpoint, providing safe defaults.
   */
  private parseFrontier(frontierJson: string): { prompt: string; currentInstructions?: string } {
    try {
      return JSON.parse(frontierJson) as { prompt: string; currentInstructions?: string };
    } catch {
      return { prompt: '' };
    }
  }

  /**
   * Build a restore prompt (side-effect-free; used by restoreSession for logging/validation).
   * This method is kept for the side effect of verification; the actual prompt
   * is built by buildCooperativeRestorePrompt.
   */
  private buildRestorePrompt(task: Task, checkpoint: import('@prisma/client').SessionCheckpoint): string {
    return `RESTORE: task ${task.id} session ${checkpoint.sessionId} checkpoint ${checkpoint.id}`;
  }

  /**
   * Parse the launch metadata JSON from a checkpoint, providing safe defaults.
   * Used by restoreSession to reconstruct the worktree/branch context from
   * the checkpoint rather than relying solely on current task fields.
   */
  private parseLaunchMetadata(launchMetadataJson: string): { repoPath?: string; worktreePath?: string; branchName?: string } {
    try {
      const parsed = JSON.parse(launchMetadataJson) as Record<string, string | undefined>;
      return {
        repoPath: parsed.repoPath ?? undefined,
        worktreePath: parsed.worktreePath ?? undefined,
        branchName: parsed.branchName ?? undefined
      };
    } catch {
      return {};
    }
  }

  /** Scan agent output for ARC_ACTION_REQUEST lines and process each one. */
  private async handleProtocolOutput(taskId: string, sessionId: string, content: string): Promise<void> {
    const lines = this.extractProtocolLines(sessionId, content);
    for (const line of lines) {
      if (!line.startsWith(ACTION_REQUEST_PREFIX)) {
        continue;
      }
      try {
        await this.updateWorkerActivity(sessionId);
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

  /** Extract complete protocol lines from a content chunk, buffering partial JSON across calls. */
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

  /** Set session and task status to waiting_approval. */
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

  /** Resume a waiting_approval session back to running if no pending approvals remain. */
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

  /** Write an ARC_APPROVAL response line to the agent's PTY stdin. */
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

  /** Schedule automatic expiry for an approval after the configured timeout. */
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

  /** Mark an approval as expired, write the response, and resume the session. */
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

  /** Cancel a scheduled approval expiry timeout. */
  private clearApprovalTimeout(approvalId: string): void {
    const timeout = this.approvalTimeouts.get(approvalId);
    if (timeout) {
      clearTimeout(timeout);
      this.approvalTimeouts.delete(approvalId);
      this.approvalTimeoutSessions.delete(approvalId);
    }
  }

  /** Cancel all approval timeouts for a given session. */
  private clearSessionApprovalTimeouts(sessionId: string): void {
    for (const [approvalId, timeoutSessionId] of this.approvalTimeoutSessions) {
      if (timeoutSessionId === sessionId) {
        this.clearApprovalTimeout(approvalId);
      }
    }
  }

  /** Resolve the effective approval timeout (policy config with env fallback). */
  private async approvalTimeoutMs(): Promise<number> {
    return this.policies.approvalTimeoutMs(this.config.approvalTimeoutMs);
  }

  /** Persist lastUserActivityAt to the session row. */
  private async updateUserActivity(sessionId: string): Promise<void> {
    try {
      await this.prisma.agentSession.update({
        where: { id: sessionId },
        data: { lastUserActivityAt: new Date() }
      });
    } catch {
      // best-effort; log updates should not fail the caller
    }
  }

  /** Persist lastWorkerActivityAt to the session row. */
  private async updateWorkerActivity(sessionId: string): Promise<void> {
    try {
      await this.prisma.agentSession.update({
        where: { id: sessionId },
        data: { lastWorkerActivityAt: new Date() }
      });
    } catch {
      // best-effort; log updates should not fail the caller
    }
  }
}

/**
 * Trim an oversized protocol buffer remainder so partial JSON across
 * chunks does not grow unbounded.
 */
function safeProtocolBufferRemainder(last: string): string {
  if (last.trim().startsWith(ACTION_REQUEST_PREFIX)) {
    return last.length <= PROTOCOL_BUFFER_LIMIT ? last : '';
  }
  return last.slice(-PROTOCOL_BUFFER_LIMIT);
}

/** Map a Prisma session status string to the RuntimeStatusLabel enum. */
function toRuntimeStatusLabel(status: string): RuntimeStatusLabel {
  if (status === 'waiting_approval') return 'waiting_approval';
  if (status === 'idle') return 'idle';
  if (status === 'dormant') return 'dormant';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'stopped') return 'stopped';
  return 'active';
}
