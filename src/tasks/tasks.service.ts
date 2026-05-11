import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { AgentLog, AgentSession, ApprovalRequest, GitChangeSummary, Task, TestRunSummary } from '@prisma/client';
import { AgentSessionsService, StopTaskResult } from '../agent-sessions/agent-sessions.service';
import { ProblemException } from '../common/errors/problem.exception';
import { AppConfigService } from '../config/app-config.service';
import { EventsGateway } from '../events/events.gateway';
import { GitDiffService } from '../git/git-diff.service';
import { GitWorktreeService, WorktreeResult } from '../git/git-worktree.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { PrismaService } from '../prisma/prisma.service';
import { TestRunnerService } from '../test-runs/test-runner.service';
import { PolicyLoaderService } from '../policy/policy-loader.service';
import { CreateTaskDto } from './dto/create-task.dto';

export interface CreateTaskResult {
  task: Task;
  session: AgentSession;
}

export interface TaskDetails {
  task: Task;
  session: AgentSession | null;
  logs: AgentLog[];
  approvals: ApprovalRequest[];
  changeSummaries: GitChangeSummary[];
  testRuns: TestRunSummary[];
}

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
    @Optional() private readonly events?: EventsGateway
  ) {}

  async createTask(input: CreateTaskDto): Promise<CreateTaskResult> {
    const draft = await this.prisma.task.create({
      data: {
        title: input.title,
        prompt: input.prompt,
        status: 'queued',
        selectedAgent: input.agent,
        repoPath: this.config.repoPath
      }
    });
    let worktree: WorktreeResult;
    try {
      worktree = await this.worktrees.createForTask({
        taskId: draft.id,
        title: input.title,
        prompt: input.prompt
      });
    } catch (error) {
      await this.prisma.task.update({
        where: { id: draft.id },
        data: { status: 'failed' }
      });
      throw error;
    }
    const created = await this.prisma.task.update({
      where: { id: draft.id },
      data: {
        repoPath: worktree.repoPath,
        worktreePath: worktree.worktreePath,
        branchName: worktree.branchName,
        baseRef: worktree.baseRef,
        baseCommit: worktree.baseCommit,
        approvalMode: 'cooperative-gated'
      }
    });
    const session = await this.agentSessions.createAndStart(created);
    const task = await this.prisma.task.findUnique({ where: { id: created.id } });
    if (!task) {
      throw new ProblemException(HttpStatus.INTERNAL_SERVER_ERROR, 'Task Refresh Failed', `Task "${created.id}" could not be refreshed after startup.`);
    }

    this.events?.emitToTask(task.id, 'task.started', { taskId: task.id, task, session });
    return { task, session };
  }

  async listTasks(): Promise<{ tasks: Task[] }> {
    const tasks = await this.prisma.task.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    return { tasks };
  }

  async getTask(id: string): Promise<TaskDetails> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${id}" does not exist.`);
    }

    const session = await this.prisma.agentSession.findFirst({
      where: { taskId: id },
      orderBy: { createdAt: 'desc' }
    });

    const [logs, approvalsResult, changeSummaries, testRuns] = await Promise.all([
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
      })
    ]);

    return {
      task,
      session,
      logs: logs.reverse(),
      approvals: approvalsResult.approvals,
      changeSummaries,
      testRuns
    };
  }

  async stopTask(id: string): Promise<StopTaskResult> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${id}" does not exist.`);
    }

    return this.agentSessions.stopTask(id);
  }

  async sendInput(id: string, text: string): Promise<void> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${id}" does not exist.`);
    }
    await this.agentSessions.sendInput(task.id, text);
  }

  async listApprovals(id: string) {
    await this.assertTaskExists(id);
    return this.approvals.listForTask(id);
  }

  async summarizeDiff(id: string) {
    await this.assertTaskExists(id);
    return this.diffs.summarizeTask(id);
  }

  async runTest(id: string, commandId: string) {
    await this.assertTaskExists(id);
    return this.tests.runTaskCommand(id, commandId);
  }

  async listTestCommands(id: string) {
    await this.assertTaskExists(id);
    return { testCommands: await this.policies.listTestCommands() };
  }

  private async assertTaskExists(id: string): Promise<Task> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${id}" does not exist.`);
    }
    return task;
  }
}
