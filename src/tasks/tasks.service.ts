import { HttpStatus, Injectable } from '@nestjs/common';
import { AgentLog, AgentSession, Task } from '@prisma/client';
import { AgentSessionsService, StopTaskResult } from '../agent-sessions/agent-sessions.service';
import { ProblemException } from '../common/errors/problem.exception';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';

export interface CreateTaskResult {
  task: Task;
  session: AgentSession;
}

export interface TaskDetails {
  task: Task;
  session: AgentSession | null;
  logs: AgentLog[];
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentSessions: AgentSessionsService,
    private readonly config: AppConfigService
  ) {}

  async createTask(input: CreateTaskDto): Promise<CreateTaskResult> {
    const created = await this.prisma.task.create({
      data: {
        title: input.title,
        prompt: input.prompt,
        status: 'queued',
        selectedAgent: input.agent,
        repoPath: this.config.repoPath
      }
    });
    const session = await this.agentSessions.createAndStart(created);
    const task = await this.prisma.task.findUnique({ where: { id: created.id } });
    if (!task) {
      throw new ProblemException(HttpStatus.INTERNAL_SERVER_ERROR, 'Task Refresh Failed', `Task "${created.id}" could not be refreshed after startup.`);
    }

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

    if (!session) {
      return { task, session: null, logs: [] };
    }

    const logs = await this.prisma.agentLog.findMany({
      where: { sessionId: session.id },
      orderBy: { sequence: 'desc' },
      take: this.config.logTailLimit
    });

    return {
      task,
      session,
      logs: logs.reverse()
    };
  }

  async stopTask(id: string): Promise<StopTaskResult> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${id}" does not exist.`);
    }

    return this.agentSessions.stopTask(id);
  }
}
