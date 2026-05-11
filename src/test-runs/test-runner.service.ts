import { HttpStatus, Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import * as path from 'path';
import { ProblemException } from '../common/errors/problem.exception';
import { EventsGateway } from '../events/events.gateway';
import { PolicyLoaderService } from '../policy/policy-loader.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TestRunnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PolicyLoaderService,
    private readonly events: EventsGateway
  ) {}

  async runTaskCommand(taskId: string, commandId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${taskId}" does not exist.`);
    }
    if (!task.worktreePath) {
      throw new ProblemException(HttpStatus.CONFLICT, 'Worktree Missing', `Task "${taskId}" has no worktree path.`);
    }

    const command = await this.policies.getTestCommand(commandId);
    if (!command) {
      throw new ProblemException(HttpStatus.FORBIDDEN, 'Test Command Not Allowed', `Test command "${commandId}" is not declared in arc.config.json.`);
    }

    const session = await this.prisma.agentSession.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' }
    });
    const worktreePath = path.resolve(task.worktreePath);
    const cwd = command.cwd ? path.resolve(worktreePath, command.cwd) : worktreePath;
    if (!isInside(worktreePath, cwd)) {
      throw new ProblemException(HttpStatus.FORBIDDEN, 'Test Command Outside Worktree', `Test command "${commandId}" resolves outside the task worktree.`);
    }
    if (command.command.length === 0) {
      throw new ProblemException(HttpStatus.BAD_REQUEST, 'Invalid Test Command', `Test command "${commandId}" has no executable.`);
    }
    const row = await this.prisma.testRunSummary.create({
      data: {
        taskId,
        sessionId: session?.id,
        commandId: command.id,
        commandJson: JSON.stringify(command.command),
        status: 'running'
      }
    });

    this.events.emitEnvelopeToTask(taskId, 'test.started', 'test', 'info', {
      id: row.id,
      commandId: command.id,
      label: command.label,
      command: command.command
    }, { sessionId: session?.id, correlationId: row.id });

    void this.runProcess(taskId, session?.id, row.id, cwd, command.command);
    return row;
  }

  private async runProcess(taskId: string, sessionId: string | undefined, testRunId: string, cwd: string, command: string[]): Promise<void> {
    const [bin, ...args] = command;
    const child = spawn(bin, args, { cwd, shell: false, env: safeTestEnv() });
    const highlights: string[] = [];

    const handleData = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const content = chunk.toString('utf8');
      if (highlights.length < 20) {
        highlights.push(...content.split(/\r?\n/).filter(Boolean).slice(0, 20 - highlights.length));
      }
      this.events.emitEnvelopeToTask(taskId, 'test.log', 'test', stream === 'stderr' ? 'warn' : 'info', {
        testRunId,
        stream,
        content
      }, { sessionId, correlationId: testRunId });
    };

    child.stdout.on('data', (chunk: Buffer) => handleData(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => handleData(chunk, 'stderr'));
    child.on('error', async (error) => {
      await this.complete(taskId, sessionId, testRunId, 1, 'failed', [`Failed to start: ${error.message}`]);
    });
    child.on('close', async (exitCode) => {
      await this.complete(taskId, sessionId, testRunId, exitCode ?? 1, exitCode === 0 ? 'passed' : 'failed', highlights);
    });
  }

  private async complete(taskId: string, sessionId: string | undefined, testRunId: string, exitCode: number, status: 'passed' | 'failed', highlights: string[]): Promise<void> {
    const updated = await this.prisma.testRunSummary.update({
      where: { id: testRunId },
      data: {
        exitCode,
        status,
        completedAt: new Date(),
        highlightsJson: JSON.stringify(highlights.slice(0, 20))
      }
    });
    this.events.emitEnvelopeToTask(taskId, 'test.completed', 'test', status === 'passed' ? 'info' : 'error', updated, {
      sessionId,
      correlationId: testRunId
    });
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeTestEnv(): NodeJS.ProcessEnv {
  const allowedKeys = ['PATH', 'HOME', 'USER', 'USERNAME', 'SHELL', 'TERM', 'TZ', 'CI'];
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
