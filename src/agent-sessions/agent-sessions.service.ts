import { HttpStatus, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { AgentSession, Task } from '@prisma/client';
import { AgentsService } from '../agents/agents.service';
import { AgentLogType, RunningAgentProcess } from '../agents/agent-adapter.interface';
import { ProblemException } from '../common/errors/problem.exception';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

const TERMINAL_SESSION_STATUSES = new Set(['completed', 'failed', 'stopped']);

export interface StopTaskResult {
  accepted: boolean;
  session: AgentSession;
}

@Injectable()
export class AgentSessionsService implements OnApplicationBootstrap {
  private readonly runningProcesses = new Map<string, RunningAgentProcess>();
  private readonly nextLogSequences = new Map<string, number>();
  private readonly logWriteQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentsService,
    private readonly config: AppConfigService
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
      const adapter = this.agents.getAdapter(task.selectedAgent as 'codex');
      const runningProcess = await adapter.startTask({
        taskId: task.id,
        sessionId: session.id,
        repoPath: task.repoPath,
        prompt: task.prompt,
        onOutput: async (event) => this.appendLog(session.id, event.type, event.content),
        onExit: async (event) => this.completeFromExit(task.id, session.id, event.exitCode, event.signal)
      });

      this.runningProcesses.set(session.id, runningProcess);
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
    });

    this.logWriteQueues.set(sessionId, currentWrite);
    await currentWrite;
  }

  private clearLogState(sessionId: string): void {
    this.nextLogSequences.delete(sessionId);
    this.logWriteQueues.delete(sessionId);
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
}
