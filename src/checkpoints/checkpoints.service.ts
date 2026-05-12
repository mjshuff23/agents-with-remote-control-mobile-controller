import { access } from 'fs/promises';
import { HttpStatus, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { AgentSession, SessionCheckpoint } from '@prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { AppConfigService } from '../config/app-config.service';
import { ProblemException } from '../common/errors/problem.exception';
import { EventsGateway } from '../events/events.gateway';
import { TaskEventLedgerService } from '../events/task-event-ledger.service';
import { GitCommandService } from '../git/git-command.service';
import { PrismaService } from '../prisma/prisma.service';

export interface CaptureCheckpointInput {
  sessionId: string;
  taskId: string;
  reason: 'idle_timeout' | 'pre_transition' | 'user_turn' | 'approval_event' | 'pre_terminal' | 'pre_stop' | 'session_start';
  lastUserActivityAt: Date | null;
  lastWorkerActivityAt: Date | null;
  workerWasLive: boolean;
  launchMetadata: { agentName: string; repoPath: string; worktreePath?: string; branchName?: string };
  frontier: { prompt: string; currentInstructions?: string };
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
  recentTurns: Array<{ role: string; content: string }> | null;
  pendingApprovalIds: string[];
  pendingCriticalApproval: boolean;
  worktreeInfo: {
    worktreePath: string | null;
    branchName: string | null;
    baseCommitSha: string | null;
    currentHeadSha: string | null;
    repoRoot: string | null;
  };
  latestDiffSummaryId: string | null;
  latestTestSummaryId: string | null;
}

export interface CanTransitionToDormantResult {
  allowed: boolean;
  reason?: string;
}

export interface RestoreResult {
  checkpoint: SessionCheckpoint;
  session: AgentSession;
}

const DORMANCY_CHECKER_INTERVAL_MS = 30_000;

@Injectable()
export class CheckpointsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CheckpointsService.name);
  private dormancyChecker: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly ledger: TaskEventLedgerService,
    private readonly gitCommands: GitCommandService,
    @Optional() private readonly events?: EventsGateway,
    @Optional() private readonly audit?: AuditLogService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.startDormancyChecker();
  }

  startDormancyChecker(): void {
    if (this.dormancyChecker) return;
    const interval = Math.max(this.config.dormantCheckIntervalMs, DORMANCY_CHECKER_INTERVAL_MS);
    this.dormancyChecker = setInterval(() => {
      void this.checkIdleSessions().catch((error) => {
        this.logger.error(`Dormancy check failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, interval).unref();
  }

  stopDormancyChecker(): void {
    if (this.dormancyChecker) {
      clearInterval(this.dormancyChecker);
      this.dormancyChecker = null;
    }
  }

  async capture(input: CaptureCheckpointInput): Promise<SessionCheckpoint> {
    const eventSeq = await this.ledger.latestSeq(input.taskId);
    return this.prisma.sessionCheckpoint.create({
      data: {
        sessionId: input.sessionId,
        taskId: input.taskId,
        schemaVersion: 1,
        reason: input.reason,
        lifecycleState: 'running',
        durableEventCursor: eventSeq,
        lastUserActivityAt: input.lastUserActivityAt,
        lastWorkerActivityAt: input.lastWorkerActivityAt,
        workerWasLive: input.workerWasLive,
        launchMetadataJson: JSON.stringify(input.launchMetadata),
        frontierJson: JSON.stringify(input.frontier),
        lastUserMessage: input.lastUserMessage,
        lastAssistantMessage: input.lastAssistantMessage,
        recentTurnsJson: input.recentTurns ? JSON.stringify(input.recentTurns) : null,
        pendingApprovalIdsJson: input.pendingApprovalIds.length > 0 ? JSON.stringify(input.pendingApprovalIds) : null,
        pendingCriticalApproval: input.pendingCriticalApproval,
        worktreePath: input.worktreeInfo.worktreePath,
        branchName: input.worktreeInfo.branchName,
        baseCommitSha: input.worktreeInfo.baseCommitSha,
        currentHeadSha: input.worktreeInfo.currentHeadSha,
        repoRoot: input.worktreeInfo.repoRoot,
        latestDiffSummaryId: input.latestDiffSummaryId,
        latestTestSummaryId: input.latestTestSummaryId
      }
    });
  }

  latestForSession(sessionId: string): Promise<SessionCheckpoint | null> {
    return this.prisma.sessionCheckpoint.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' }
    });
  }

  async canTransitionToDormant(session: AgentSession): Promise<CanTransitionToDormantResult> {
    const terminal = new Set(['completed', 'failed', 'stopped', 'dormant']);
    if (terminal.has(session.status)) {
      return { allowed: false, reason: `Session is already ${session.status}` };
    }

    if (session.status === 'waiting_approval') {
      return { allowed: false, reason: 'Session has pending approvals requiring user attention' };
    }

    const now = Date.now();
    const timeoutMs = this.config.dormantTimeoutMs;
    const workerThreshold = session.lastWorkerActivityAt
      ? session.lastWorkerActivityAt.getTime() + timeoutMs
      : session.createdAt.getTime() + timeoutMs;
    const userThreshold = session.lastUserActivityAt
      ? session.lastUserActivityAt.getTime() + timeoutMs
      : session.createdAt.getTime() + timeoutMs;

    if (now < workerThreshold) {
      const remaining = Math.ceil((workerThreshold - now) / 1000);
      return { allowed: false, reason: `Worker activity too recent (${remaining}s remaining)` };
    }

    if (now < userThreshold) {
      const remaining = Math.ceil((userThreshold - now) / 1000);
      return { allowed: false, reason: `User activity too recent (${remaining}s remaining)` };
    }

    return { allowed: true };
  }

  async transitionToDormant(session: AgentSession, checkpoint: SessionCheckpoint): Promise<AgentSession> {
    const [updated] = await Promise.all([
      this.prisma.agentSession.update({
        where: { id: session.id },
        data: {
          status: 'dormant',
          dormantAt: new Date(),
          dormantReason: `dormant_${checkpoint.reason}`
        }
      }),
      this.prisma.task.update({
        where: { id: session.taskId },
        data: { status: 'dormant' }
      })
    ]);

    await this.events?.emitEnvelopeToTask(session.taskId, 'session.dormant', 'lifecycle', 'info', {
      sessionId: session.id,
      checkpointId: checkpoint.id,
      reason: checkpoint.reason,
      lastUserActivityAt: checkpoint.lastUserActivityAt,
      lastWorkerActivityAt: checkpoint.lastWorkerActivityAt
    }, { sessionId: session.id });

    await this.appendAudit(session, `Session transitioned to dormant (${checkpoint.reason})`);

    return updated;
  }

  async restore(sessionId: string): Promise<RestoreResult> {
    const session = await this.prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Session Not Found', `Session "${sessionId}" does not exist.`);
    }
    if (session.status !== 'dormant') {
      throw new ProblemException(HttpStatus.CONFLICT, 'Not Dormant', `Session is ${session.status}, not dormant.`);
    }

    const checkpoint = await this.latestForSession(sessionId);
    if (!checkpoint) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'No Checkpoint', 'No checkpoint found for dormant session.');
    }

    if (checkpoint.worktreePath) {
      const worktreeExists = await this.worktreePathExists(checkpoint.worktreePath);
      if (!worktreeExists) {
        throw new ProblemException(
          HttpStatus.GONE,
          'Worktree Missing',
          `Worktree path "${checkpoint.worktreePath}" no longer exists. Cannot restore.`
        );
      }
    }

    const [updated] = await Promise.all([
      this.prisma.agentSession.update({
        where: { id: sessionId },
        data: {
          status: 'running',
          dormantAt: null,
          dormantReason: null,
          lastUserActivityAt: new Date()
        }
      }),
      this.prisma.task.update({
        where: { id: session.taskId },
        data: { status: 'running' }
      })
    ]);

    await this.events?.emitEnvelopeToTask(session.taskId, 'session.restored', 'lifecycle', 'info', {
      sessionId: session.id,
      checkpointId: checkpoint.id,
      restoreMode: 'relaunch'
    }, { sessionId: session.id });

    await this.appendAudit(session, `Session restored from dormant (checkpoint ${checkpoint.id})`);

    return { checkpoint, session: updated };
  }

  async captureAtBoundary(
    sessionId: string,
    taskId: string,
    reason: CaptureCheckpointInput['reason'],
    metadata?: {
      lastUserMessage?: string | null;
      lastAssistantMessage?: string | null;
      workerWasLive?: boolean;
      frontierPrompt?: string;
      recentTurns?: Array<{ role: string; content: string }> | null;
    }
  ): Promise<SessionCheckpoint | null> {
    try {
      const [session, task] = await Promise.all([
        this.prisma.agentSession.findUnique({ where: { id: sessionId } }),
        this.prisma.task.findUnique({ where: { id: taskId } })
      ]);
      if (!session || !task) return null;

      const hasLiveProcess = metadata?.workerWasLive ?? false;
      const pendingApprovals = await this.prisma.approvalRequest.findMany({
        where: { taskId, status: 'pending' },
        orderBy: { requestedAt: 'desc' }
      });
      const pendingCriticalApproval = pendingApprovals.some(
        (a) => a.riskLevel === 'NEEDS_APPROVAL' || a.riskLevel === 'BLOCKED'
      );

      const [latestDiff, latestTest, currentHead] = await Promise.all([
        this.prisma.gitChangeSummary.findFirst({
          where: { taskId },
          orderBy: { createdAt: 'desc' }
        }),
        this.prisma.testRunSummary.findFirst({
          where: { taskId },
          orderBy: { createdAt: 'desc' }
        }),
        this.resolveCurrentHead(task.worktreePath ?? task.repoPath)
      ]);

      return this.capture({
        sessionId,
        taskId: task.id,
        reason,
        lastUserActivityAt: session.lastUserActivityAt,
        lastWorkerActivityAt: session.lastWorkerActivityAt,
        workerWasLive: hasLiveProcess,
        launchMetadata: {
          agentName: session.agentName,
          repoPath: task.repoPath,
          worktreePath: task.worktreePath ?? undefined,
          branchName: task.branchName ?? undefined
        },
        frontier: {
          prompt: metadata?.frontierPrompt ?? task.prompt,
          currentInstructions: undefined
        },
        lastUserMessage: metadata?.lastUserMessage ?? null,
        lastAssistantMessage: metadata?.lastAssistantMessage ?? null,
        recentTurns: metadata?.recentTurns ?? null,
        pendingApprovalIds: pendingApprovals.map((a) => a.id),
        pendingCriticalApproval,
        worktreeInfo: {
          worktreePath: task.worktreePath ?? null,
          branchName: task.branchName ?? null,
          baseCommitSha: task.baseCommit ?? null,
          currentHeadSha: currentHead,
          repoRoot: task.repoPath
        },
        latestDiffSummaryId: latestDiff?.id ?? null,
        latestTestSummaryId: latestTest?.id ?? null
      });
    } catch (error) {
      this.logger.warn(
        `Boundary checkpoint failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  private async resolveCurrentHead(repoPath: string): Promise<string | null> {
    try {
      const result = await this.gitCommands.git(repoPath, ['rev-parse', 'HEAD']);
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async worktreePathExists(worktreePath: string): Promise<boolean> {
    try {
      await access(worktreePath);
      return true;
    } catch {
      return false;
    }
  }

  private async collectCheckpointData(session: AgentSession): Promise<CaptureCheckpointInput | null> {
    try {
      const task = await this.prisma.task.findUnique({ where: { id: session.taskId } });
      if (!task) return null;

      const pendingApprovals = await this.prisma.approvalRequest.findMany({
        where: { taskId: task.id, status: 'pending' },
        orderBy: { requestedAt: 'desc' }
      });
      const pendingCriticalApproval = pendingApprovals.some(
        (a) => a.riskLevel === 'NEEDS_APPROVAL' || a.riskLevel === 'BLOCKED'
      );
      const currentHead = await this.resolveCurrentHead(task.worktreePath ?? task.repoPath);

      const [latestDiff, latestTest] = await Promise.all([
        this.prisma.gitChangeSummary.findFirst({
          where: { taskId: task.id },
          orderBy: { createdAt: 'desc' }
        }),
        this.prisma.testRunSummary.findFirst({
          where: { taskId: task.id },
          orderBy: { createdAt: 'desc' }
        })
      ]);

      return {
        sessionId: session.id,
        taskId: task.id,
        reason: 'idle_timeout',
        lastUserActivityAt: session.lastUserActivityAt,
        lastWorkerActivityAt: session.lastWorkerActivityAt,
        workerWasLive: false,
        launchMetadata: {
          agentName: session.agentName,
          repoPath: task.repoPath,
          worktreePath: task.worktreePath ?? undefined,
          branchName: task.branchName ?? undefined
        },
        frontier: { prompt: task.prompt },
        lastUserMessage: null,
        lastAssistantMessage: null,
        recentTurns: null,
        pendingApprovalIds: pendingApprovals.map((a) => a.id),
        pendingCriticalApproval,
        worktreeInfo: {
          worktreePath: task.worktreePath ?? null,
          branchName: task.branchName ?? null,
          baseCommitSha: task.baseCommit ?? null,
          currentHeadSha: currentHead,
          repoRoot: task.repoPath
        },
        latestDiffSummaryId: latestDiff?.id ?? null,
        latestTestSummaryId: latestTest?.id ?? null
      };
    } catch (error) {
      this.logger.warn(
        `Failed to collect checkpoint data for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  private async checkIdleSessions(): Promise<void> {
    const terminalOrDormant = new Set(['completed', 'failed', 'stopped', 'dormant']);
    const candidates = await this.prisma.agentSession.findMany({
      where: { status: { notIn: Array.from(terminalOrDormant) } }
    });

    for (const session of candidates) {
      try {
        const gate = await this.canTransitionToDormant(session);
        if (!gate.allowed) continue;

        const data = await this.collectCheckpointData(session);
        if (!data) continue;

        const checkpoint = await this.capture(data);

        const refreshed = await this.prisma.agentSession.findUnique({ where: { id: session.id } });
        if (refreshed) {
          const recheck = await this.canTransitionToDormant(refreshed);
          if (!recheck.allowed) {
            this.logger.debug(`Skipping dormancy for session ${session.id}: state changed (${recheck.reason})`);
            continue;
          }
        }

        await this.transitionToDormant(session, checkpoint);
      } catch (error) {
        this.logger.warn(
          `Dormancy check failed for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private async appendAudit(session: AgentSession, message: string): Promise<void> {
    await this.audit?.append({
      taskId: session.taskId,
      sessionId: session.id,
      kind: 'lifecycle.dormancy',
      message
    });
  }
}
