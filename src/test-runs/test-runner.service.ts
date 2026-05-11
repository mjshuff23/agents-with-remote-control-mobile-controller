import { HttpStatus, Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import * as path from 'path';
import { ProblemException } from '../common/errors/problem.exception';
import { AppConfigService } from '../config/app-config.service';
import { EventsGateway } from '../events/events.gateway';
import { PolicyLoaderService } from '../policy/policy-loader.service';
import { PrismaService } from '../prisma/prisma.service';

const TEST_KILL_GRACE_MS = 2000;

@Injectable()
export class TestRunnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PolicyLoaderService,
    private readonly config: AppConfigService,
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
    const worktreePath = realpathSync(path.resolve(task.worktreePath));
    const candidateCwd = command.cwd ? path.resolve(worktreePath, command.cwd) : worktreePath;
    const cwd = existsSync(candidateCwd) ? realpathSync(candidateCwd) : candidateCwd;
    if (!isInside(worktreePath, cwd)) {
      throw new ProblemException(HttpStatus.FORBIDDEN, 'Test Command Outside Worktree', `Test command "${commandId}" resolves outside the task worktree.`);
    }
    if (command.command.length === 0) {
      throw new ProblemException(HttpStatus.BAD_REQUEST, 'Invalid Test Command', `Test command "${commandId}" has no executable.`);
    }
    assertSafeConfiguredCommand(command.command, commandId);
    const timeoutMs = command.timeoutMs ?? this.config.testCommandTimeoutMs;
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
      command: command.command,
      timeoutMs
    }, { sessionId: session?.id, correlationId: row.id });

    void this.runProcess(taskId, session?.id, row.id, cwd, command.command, timeoutMs);
    return row;
  }

  private async runProcess(taskId: string, sessionId: string | undefined, testRunId: string, cwd: string, command: string[], timeoutMs: number): Promise<void> {
    const [bin, ...args] = command;
    let child;
    try {
      child = spawn(bin, args, { cwd, shell: false, env: safeTestEnv() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.complete(taskId, sessionId, testRunId, 1, 'failed', [`Failed to start: ${message}`]);
      return;
    }
    const highlights: string[] = [];
    let finished = false;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (killHandle) {
        clearTimeout(killHandle);
        killHandle = undefined;
      }
    };

    const completeOnce = async (exitCode: number, status: 'passed' | 'failed', nextHighlights: string[]) => {
      if (finished) return;
      finished = true;
      clearTimers();
      await this.complete(taskId, sessionId, testRunId, exitCode, status, nextHighlights);
    };

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      const timeoutHighlight = `Timed out after ${timeoutMs}ms`;
      highlights.unshift(timeoutHighlight);
      try {
        child.kill('SIGTERM');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        highlights.unshift(`Failed to terminate timed-out test: ${message}`);
      }
      killHandle = setTimeout(() => {
        if (finished) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // The process may already have exited between timers.
        }
        void completeOnce(1, 'failed', highlights);
      }, TEST_KILL_GRACE_MS);
    }, timeoutMs);

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
      await completeOnce(1, 'failed', [`Failed to start: ${error.message}`]);
    });
    child.on('close', async (exitCode) => {
      await completeOnce(exitCode ?? 1, timedOut ? 'failed' : exitCode === 0 ? 'passed' : 'failed', highlights);
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
  const allowedKeys = ['PATH', 'USER', 'USERNAME', 'SHELL', 'TERM', 'TZ', 'CI'];
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function assertSafeConfiguredCommand(command: string[], commandId: string): void {
  const [bin, ...args] = command;
  if (!bin || bin.includes('\0') || /[|&;<>()`$]/.test(bin)) {
    throw new ProblemException(HttpStatus.BAD_REQUEST, 'Invalid Test Command', `Test command "${commandId}" has an unsafe executable.`);
  }
  if ((path.isAbsolute(bin) || bin.includes('..')) && !bin.startsWith('node_modules/.bin/')) {
    throw new ProblemException(HttpStatus.BAD_REQUEST, 'Invalid Test Command', `Test command "${commandId}" executable must be a bare command or a repo-local node_modules binary.`);
  }
  if (args.some((arg) => arg.includes('\0'))) {
    throw new ProblemException(HttpStatus.BAD_REQUEST, 'Invalid Test Command', `Test command "${commandId}" contains an invalid argument.`);
  }
}
