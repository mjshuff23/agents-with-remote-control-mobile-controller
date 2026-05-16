import { HttpStatus, Injectable, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { AgentSession, ApprovalRequest, Task } from '@prisma/client';
import { AgentsService } from '../../agents/agents.service';
import { AgentLogType, RunningAgentProcess } from '../../agents/agent-adapter.interface';
import { ApprovalsService } from '../approvals/approvals.service';
import { CheckpointsService } from '../checkpoints/checkpoints.service';
import { ProblemException } from '../../common/errors/problem.exception';
import { AppConfigService } from '../../config/app-config.service';
import { EventsGateway } from '../../events/events.gateway';
import { PolicyLoaderService } from '../policy/policy-loader.service';
import { ApprovalDecision } from '../policy/policy.types';
import { PrismaService } from '../../prisma/prisma.service';
import { ProtocolHandlerService } from './protocol-handler.service';

const TERMINAL_SESSION_STATUSES = new Set(['completed', 'failed', 'stopped']);

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentsService,
    private readonly config: AppConfigService,
    private readonly approvals: ApprovalsService,
    private readonly policies: PolicyLoaderService,
    private readonly checkpoints: CheckpointsService,
    private readonly protocolHandler: ProtocolHandlerService,
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

    // Fire off agent startup in background, don't block the request
    void this.startAgentInBackground(task, session).catch((err) => {
      this.appendLog(session.id, 'system', `Background startup error: ${this.errorMessage(err)}`);
    });

    return session;
  }

  /** Start the agent in the background without blocking the request. */
  private async startAgentInBackground(task: Task, session: AgentSession): Promise<void> {
    try {
      const adapter = this.agents.getAdapter(task.selectedAgent);
      const runningProcess = await adapter.startTask({
        taskId: task.id,
        sessionId: session.id,
        repoPath: task.repoPath,
        worktreePath: task.worktreePath ?? undefined,
        branchName: task.branchName ?? undefined,
        prompt: this.buildCooperativePrompt(task),
        onOutput: (event) => this.handleAgentOutput(task.id, session.id, event.type, event.content),
        onExit: async (event) => this.completeFromExit(task.id, session.id, event.exitCode, event.signal)
      });

      this.runningProcesses.set(session.id, runningProcess);
      this.sessionToTask.set(session.id, task.id);
      await this.prisma.task.update({
        where: { id: task.id },
        data: { status: 'running' }
      });

      await this.prisma.agentSession.update({
        where: { id: session.id },
        data: {
          status: 'running',
          startedAt: new Date()
        }
      });

      void this.checkpoints.captureAtBoundary(session.id, task.id, 'session_start', {
        workerWasLive: this.hasLiveProcess(session.id)
      }).catch((err) => {
        this.appendLog(session.id, 'system', `Checkpoint capture failed (session_start): ${this.errorMessage(err)}`);
      });
    } catch (error) {
      const message = this.errorMessage(error);
      await this.appendLog(session.id, 'system', `Codex startup failed: ${message}`);
      await this.markSessionFailed(task.id, session.id, message);
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
      if (session.status === 'idle' && session.externalSessionId) {
        const task = await this.prisma.task.findUnique({ where: { id: taskId } });
        if (!task) {
          throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${taskId}" does not exist.`);
        }
        await this.resumeIdleSession(task, session, text);
        return;
      }
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
    await this.execApprovalResponse(approval.sessionId, {
      id: approval.actionRequestId,
      decision: approval.decision ?? decision,
      message: approval.decisionMessage ?? message ?? '',
      constraints: approval.decision === 'approved' ? ['Execute only the exact approved action in this task worktree.'] : []
    });

    if (approval.sessionId && ['approved', 'denied', 'expired'].includes(approval.status)) {
      await this.protocolHandler.resumeIfWaiting(approval.taskId, approval.sessionId);
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

  /** Persist output, inspect structured Codex events, and route cooperative protocol lines. */
  private async handleAgentOutput(taskId: string, sessionId: string, type: AgentLogType, content: string): Promise<void> {
    await this.appendLog(sessionId, type, content);
    if (type !== 'stdout') {
      return;
    }

    await this.captureCodexThreadId(sessionId, content);
    await this.handleProtocolOutput(taskId, sessionId, content);
  }

  /** Store Codex's persisted thread id so later user input can resume the conversation. */
  private async captureCodexThreadId(sessionId: string, content: string): Promise<void> {
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed) as { type?: string; thread_id?: unknown };
        if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id.length > 0) {
          await this.prisma.agentSession.update({
            where: { id: sessionId },
            data: { externalSessionId: event.thread_id }
          });
        }
      } catch {
        continue;
      }
    }
  }

  /** Clear per-session in-memory state (sequences, queues, buffers, protocol timeouts). */
  private clearLogState(sessionId: string): void {
    this.nextLogSequences.delete(sessionId);
    this.logWriteQueues.delete(sessionId);
    this.sessionToTask.delete(sessionId);
    this.protocolHandler.clearBuffersForSession(sessionId);
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
    const finalSessionStatus = wasStopping ? 'stopped' : exitCode === 0 ? 'idle' : 'failed';
    const finalTaskStatus = finalSessionStatus;
    const message = signal
      ? `Agent process exited with code ${exitCode} and signal ${signal}`
      : `Agent process exited with code ${exitCode}`;

    await this.appendLog(sessionId, 'system', message);

    const checkpointReason = finalSessionStatus === 'idle' ? 'pre_transition' : 'pre_terminal';
    void this.checkpoints.captureAtBoundary(sessionId, taskId, checkpointReason).catch((err) =>
      this.appendLog(sessionId, 'system', `Checkpoint capture failed (${checkpointReason}): ${this.errorMessage(err)}`)
    );

    await this.prisma.agentSession.update({
      where: { id: sessionId },
      data: {
        status: finalSessionStatus,
        completedAt: finalSessionStatus === 'idle' ? null : new Date(),
        exitCode
      }
    });
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: finalTaskStatus }
    });
    await this.events?.emitCompatibilityEventToTask(taskId, finalSessionStatus === 'idle' ? 'task.idle' : 'task.completed', 'lifecycle', finalTaskStatus === 'failed' ? 'error' : 'info', {
      taskId,
      exitCode,
      status: finalTaskStatus,
      signal
    }, { sessionId });
    this.clearLogState(sessionId);
  }

  /** Resume an idle persisted Codex thread for a new user turn. */
  private async resumeIdleSession(task: Task, session: AgentSession, text: string): Promise<void> {
    const adapter = this.agents.getAdapter(task.selectedAgent);
    if (!adapter.resumeTask) {
      throw new ProblemException(HttpStatus.CONFLICT, 'Resume Not Supported', `Agent "${task.selectedAgent}" does not support persisted follow-up input.`);
    }

    this.sessionToTask.set(session.id, task.id);
    await this.appendLog(session.id, 'system', `Input sent (${text.length} chars)`);
    await this.updateUserActivity(session.id);
    await this.prisma.task.update({
      where: { id: task.id },
      data: { status: 'running' }
    });
    await this.prisma.agentSession.update({
      where: { id: session.id },
      data: { status: 'running', completedAt: null }
    });

    let runningProcess: RunningAgentProcess;
    try {
      runningProcess = await adapter.resumeTask({
        taskId: task.id,
        sessionId: session.id,
        repoPath: task.repoPath,
        worktreePath: task.worktreePath ?? undefined,
        branchName: task.branchName ?? undefined,
        externalSessionId: session.externalSessionId!,
        prompt: text,
        onOutput: (event) => this.handleAgentOutput(task.id, session.id, event.type, event.content),
        onExit: async (event) => this.completeFromExit(task.id, session.id, event.exitCode, event.signal)
      });
    } catch (error) {
      const message = this.errorMessage(error);
      await this.prisma.task.update({
        where: { id: task.id },
        data: { status: 'idle' }
      });
      await this.prisma.agentSession.update({
        where: { id: session.id },
        data: { status: 'idle', completedAt: null, errorMessage: message }
      });
      await this.appendLog(session.id, 'system', `Resume failed: ${message}`);
      this.clearLogState(session.id);
      throw new ProblemException(HttpStatus.CONFLICT, 'Resume Failed', message);
    }

    this.runningProcesses.set(session.id, runningProcess);
    await this.prisma.agentSession.update({
      where: { id: session.id },
      data: {
        status: 'running',
        externalSessionId: runningProcess.externalSessionId,
        startedAt: session.startedAt ?? new Date(),
        completedAt: null
      }
    });

    void this.checkpoints.captureAtBoundary(session.id, task.id, 'user_turn', {
      lastUserMessage: text,
      workerWasLive: true
    }).catch((err) => this.appendLog(session.id, 'system', `Checkpoint capture failed (user_turn): ${this.errorMessage(err)}`));
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

  /** Handle ARC_ACTION_REQUEST protocol output via ProtocolHandlerService. */
  private handleProtocolOutput(taskId: string, sessionId: string, content: string): Promise<void> {
    return this.protocolHandler.handleProtocolOutput(
      taskId, sessionId, content,
      (payload) => this.execApprovalResponse(sessionId, payload),
      (sid, msg) => this.appendLog(sid, 'system', msg),
      (sid) => this.updateWorkerActivity(sid)
    );
  }

  /** Execute an ARC_APPROVAL write to the agent PTY. Delegates to ProtocolHandlerService. */
  private execApprovalResponse(sessionId: string | null, payload: import('./protocol-handler.service').ApprovalResponsePayload): Promise<void> {
    const writeToAgent = this.runningProcesses.get(sessionId ?? '')?.write;
    return this.protocolHandler.writeApprovalResponse(writeToAgent, (s, m) => this.appendLog(s, 'system', m), sessionId, payload);
  }

  /** Cancel a scheduled approval expiry timeout (delegate to ProtocolHandlerService). */
  private clearApprovalTimeout(approvalId: string): void {
    this.protocolHandler.clearApprovalTimeout(approvalId);
  }

  /** Cancel all approval timeouts for a session (delegate to ProtocolHandlerService). */
  private clearSessionApprovalTimeouts(sessionId: string): void {
    this.protocolHandler.clearSessionApprovalTimeouts(sessionId);
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
