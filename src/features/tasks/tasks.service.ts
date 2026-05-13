import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { AgentLog, AgentSession, ApprovalRequest, GitChangeSummary, Task, TestRunSummary } from '@prisma/client';
import { AgentSessionsService, StopTaskResult } from '../agent-sessions/agent-sessions.service';
import { ProblemException } from '../../common/errors/problem.exception';
import { AppConfigService } from '../../config/app-config.service';
import { EventsGateway, type TaskEventEnvelope } from '../../events/events.gateway';
import { TaskEventLedgerService } from '../../events/task-event-ledger.service';
import { GitDiffService } from '../worktrees/git-diff.service';
import { GitWorktreeService, WorktreeResult } from '../worktrees/git-worktree.service';
import { GitCommitService, CommitResult } from '../worktrees/git-commit.service';
import { GitPushService, PushResult } from '../worktrees/git-push.service';
import { PrGeneratorService, PrResult } from '../worktrees/pr-generator.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TestRunnerService } from '../test-runs/test-runner.service';
import { PolicyLoaderService } from '../policy/policy-loader.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { CommitTaskDto } from './dto/commit-task.dto';
import { PushTaskDto } from './dto/push-task.dto';
import { CreatePrDto } from './dto/create-pr.dto';
import type { ExternalIssueRef } from '../providers/provider.types';

/** Task row with `externalIssueRef` parsed to a typed object instead of a raw JSON string. */
export type TaskWithParsedRef = Omit<Task, 'externalIssueRef'> & {
  externalIssueRef: ExternalIssueRef | null;
};

export interface CreateTaskResult {
  task: TaskWithParsedRef;
  session: AgentSession;
}

export interface TaskDetails {
  task: TaskWithParsedRef;
  session: AgentSession | null;
  logs: AgentLog[];
  events: TaskEventEnvelope[];
  eventCursor: number;
  runtime: ReturnType<AgentSessionsService['runtimeState']>;
  approvals: ApprovalRequest[];
  changeSummaries: GitChangeSummary[];
  testRuns: TestRunSummary[];
}

export interface TaskReplay {
  task: TaskWithParsedRef;
  session: AgentSession | null;
  logs: AgentLog[];
  events: TaskEventEnvelope[];
  eventCursor: number;
  runtime: ReturnType<AgentSessionsService['runtimeState']>;
}

/** Core task orchestration service: CRUD, session lifecycle, diffs, test runs, approvals. */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentSessions: AgentSessionsService,
    private readonly config: AppConfigService,
    private readonly worktrees: GitWorktreeService,
    private readonly approvals: ApprovalsService,
    private readonly diffs: GitDiffService,
    private readonly tests: TestRunnerService,
    private readonly policies: PolicyLoaderService,
    private readonly ledger: TaskEventLedgerService,
    private readonly gitCommit: GitCommitService,
    private readonly gitPush: GitPushService,
    private readonly prGenerator: PrGeneratorService,
    @Optional() private readonly events?: EventsGateway
  ) {}

  /**
   * Create a task and return immediately. Worktree setup and agent startup
   * happen in the background.
   */
  async createTask(input: CreateTaskDto): Promise<CreateTaskResult> {
    const draft = await this.prisma.task.create({
      data: {
        title: input.title,
        prompt: input.prompt,
        status: 'queued',
        selectedAgent: input.agent,
        repoPath: this.config.repoPath,
        externalIssueRef: input.externalIssueRef ? JSON.stringify(input.externalIssueRef) : null,
      }
    });

    const session = await this.agentSessions.createAndStart(draft);

    // Fire off worktree setup in background
    void this.setupTaskInBackground(draft.id, input);

    return { task: parseTask(draft), session };
  }

  /** Set up worktree in the background. */
  private async setupTaskInBackground(taskId: string, input: CreateTaskDto): Promise<void> {
    try {
      const worktree = await this.worktrees.createForTask({
        taskId,
        title: input.title,
        prompt: input.prompt,
        externalIssueRef: input.externalIssueRef ?? null,
        baseRef: input.baseRef ?? null,
      });

      await this.prisma.task.update({
        where: { id: taskId },
        data: {
          repoPath: worktree.repoPath,
          worktreePath: worktree.worktreePath,
          branchName: worktree.branchName,
          baseRef: worktree.baseRef,
          baseCommit: worktree.baseCommit,
          approvalMode: 'cooperative-gated'
        }
      });
    } catch (error) {
      await this.prisma.task.update({
        where: { id: taskId },
        data: { status: 'failed' }
      });
    }
  }

  /** List the 50 most recent tasks. */
  async listTasks(): Promise<{ tasks: TaskWithParsedRef[] }> {
    const tasks = await this.prisma.task.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    return { tasks: tasks.map(parseTask) };
  }

  /**
   * Fetch full task details including session, logs, events, approvals,
   * change summaries, test runs, and runtime state.
   * @throws ProblemException(404) if the task does not exist.
   */
  async getTask(id: string): Promise<TaskDetails> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${id}" does not exist.`);
    }

    const session = await this.prisma.agentSession.findFirst({
      where: { taskId: id },
      orderBy: { createdAt: 'desc' }
    });

    const [logs, approvalsResult, changeSummaries, testRuns, eventCursor] = await Promise.all([
      session
        ? this.prisma.agentLog.findMany({
          where: { sessionId: session.id },
          orderBy: { sequence: 'desc' },
          take: this.config.logTailLimit
        })
        : Promise.resolve([]),
      this.approvals.listForTask(id),
      this.prisma.gitChangeSummary.findMany({
        where: { taskId: id },
        orderBy: { createdAt: 'desc' },
        take: 10
      }),
      this.prisma.testRunSummary.findMany({
        where: { taskId: id },
        orderBy: { createdAt: 'desc' },
        take: 10
      }),
      this.ledger.latestSeq(id)
    ]);

    return {
      task: parseTask(task),
      session,
      logs: logs.reverse(),
      events: [],
      eventCursor,
      runtime: this.agentSessions.runtimeState(session),
      approvals: approvalsResult.approvals,
      changeSummaries,
      testRuns
    };
  }

  /**
   * Replay events and logs after cursor positions for durable reconnect.
   * @param options.afterEventSeq    - Minimum event sequence to include.
   * @param options.afterLogSequence - Minimum log sequence to include.
   * @param options.limit            - Max results per category.
   */
  async replayTask(id: string, options: { afterEventSeq?: number; afterLogSequence?: number; limit?: number }): Promise<TaskReplay> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${id}" does not exist.`);
    }
    const session = await this.prisma.agentSession.findFirst({
      where: { taskId: id },
      orderBy: { createdAt: 'desc' }
    });
    const replay = await this.ledger.replay({
      taskId: id,
      afterEventSeq: options.afterEventSeq,
      afterLogSequence: options.afterLogSequence,
      limit: options.limit
    });
    const eventCursor = replay.events.reduce((max, event) => Math.max(max, event.seq), options.afterEventSeq ?? 0);

    return {
      task: parseTask(task),
      session,
      logs: replay.logs,
      events: replay.events,
      eventCursor,
      runtime: this.agentSessions.runtimeState(session)
    };
  }

  /** Stop a task by delegating to the agent session lifecycle. */
  async stopTask(id: string): Promise<StopTaskResult> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${id}" does not exist.`);
    }

    return this.agentSessions.stopTask(id);
  }

  /** Send stdin text to the running agent session for a task. */
  async sendInput(id: string, text: string): Promise<void> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${id}" does not exist.`);
    }
    await this.agentSessions.sendInput(task.id, text);
  }

  /** Restore a dormant session back to running. */
  async restoreTask(id: string): Promise<{ restored: boolean; session: AgentSession; runtime: ReturnType<AgentSessionsService['runtimeState']> }> {
    const task = await this.assertTaskExists(id);
    const session = await this.prisma.agentSession.findFirst({
      where: { taskId: id },
      orderBy: { createdAt: 'desc' }
    });
    if (!session || session.status !== 'dormant') {
      throw new ProblemException(HttpStatus.CONFLICT, 'Not Dormant', `Task "${id}" is not dormant.`);
    }

    const result = await this.agentSessions.restoreSession(session.id);
    return {
      restored: true,
      session: result.session,
      runtime: this.agentSessions.runtimeState(result.session)
    };
  }

  /** List approval requests for a task. */
  async listApprovals(id: string) {
    await this.assertTaskExists(id);
    return this.approvals.listForTask(id);
  }

  /** Request a diff summary for a task. */
  async summarizeDiff(id: string) {
    await this.assertTaskExists(id);
    return this.diffs.summarizeTask(id);
  }

  /** Run a configured test command for a task. */
  async runTest(id: string, commandId: string) {
    await this.assertTaskExists(id);
    return this.tests.runTaskCommand(id, commandId);
  }

  /** List configured test commands from the policy file. */
  async listTestCommands(id: string) {
    await this.assertTaskExists(id);
    return { testCommands: await this.policies.listTestCommands() };
  }

  /** Request an approval-gated push for a task. */
  async pushTask(id: string, dto: PushTaskDto): Promise<PushResult> {
    return this.gitPush.requestAndExecute({
      taskId: id,
      sessionId: dto.sessionId,
      remote: dto.remote,
      branch: dto.branch,
    });
  }

  /** Request an approval-gated draft PR creation for a task. */
  async createPr(id: string, dto: CreatePrDto): Promise<PrResult> {
    return this.prGenerator.requestAndExecute({
      taskId: id,
      sessionId: dto.sessionId,
      title: dto.title,
      base: dto.base,
      head: dto.head,
    });
  }

  /** Request an approval-gated commit for a task. */
  async commitTask(id: string, dto: CommitTaskDto): Promise<CommitResult> {
    return this.gitCommit.requestAndExecute({
      taskId: id,
      sessionId: dto.sessionId,
      summary: dto.summary,
      linearKey: dto.linearKey,
      githubIssueKey: dto.githubIssueKey,
    });
  }

  /** Guard: throw 404 if the task does not exist. */
  private async assertTaskExists(id: string): Promise<Task> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${id}" does not exist.`);
    }
    return task;
  }
}

/** Parse the raw Prisma Task into a TaskWithParsedRef, deserializing the JSON externalIssueRef column. */
function parseTask(task: Task): TaskWithParsedRef {
  let externalIssueRef: ExternalIssueRef | null = null;
  if (task.externalIssueRef) {
    try {
      externalIssueRef = JSON.parse(task.externalIssueRef) as ExternalIssueRef;
    } catch {
      // malformed JSON — treat as absent
    }
  }
  return { ...task, externalIssueRef };
}
