import { HttpStatus, Injectable } from '@nestjs/common';
import { AgentSession, Task } from '@prisma/client';
import { ProblemException } from '../common/errors/problem.exception';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { GitCommandService } from './git-command.service';

export interface DiffSummaryPayload {
  id: string;
  taskId: string;
  sessionId?: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  renamedCount: number;
  riskFlags: string[];
  topFiles: Array<{ path: string; insertions: number; deletions: number; status?: string }>;
  statusText: string;
  createdAt: Date;
}

@Injectable()
export class GitDiffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gitCommands: GitCommandService,
    private readonly events: EventsGateway
  ) {}

  async summarizeTask(taskId: string): Promise<DiffSummaryPayload> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${taskId}" does not exist.`);
    }
    if (!task.worktreePath) {
      throw new ProblemException(HttpStatus.CONFLICT, 'Worktree Missing', `Task "${taskId}" has no worktree path.`);
    }

    const session = await this.prisma.agentSession.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' }
    });

    return this.summarize(task, session);
  }

  async summarize(task: Task, session?: AgentSession | null): Promise<DiffSummaryPayload> {
    if (!task.worktreePath) {
      throw new Error(`Task "${task.id}" has no worktreePath`);
    }

    const [status, stat, numstat, nameStatus] = await Promise.all([
      this.gitCommands.git(task.worktreePath, ['status', '--porcelain=v2', '-z', '--branch']),
      this.gitCommands.git(task.worktreePath, ['diff', '--stat']),
      this.gitCommands.git(task.worktreePath, ['diff', '--numstat', '-z']),
      this.gitCommands.git(task.worktreePath, ['diff', '--name-status', '-z'])
    ]);

    const topFiles = parseNumstat(numstat.stdout);
    const counts = parseNameStatus(nameStatus.stdout);
    const riskFlags = computeRiskFlags(topFiles.map((file) => file.path), topFiles);

    const row = await this.prisma.gitChangeSummary.create({
      data: {
        taskId: task.id,
        sessionId: session?.id,
        statusText: status.stdout,
        filesChanged: topFiles.length,
        insertions: topFiles.reduce((sum, file) => sum + file.insertions, 0),
        deletions: topFiles.reduce((sum, file) => sum + file.deletions, 0),
        addedCount: counts.addedCount,
        modifiedCount: counts.modifiedCount,
        deletedCount: counts.deletedCount,
        renamedCount: counts.renamedCount,
        riskFlagsJson: JSON.stringify(riskFlags),
        topFilesJson: JSON.stringify(topFiles.slice(0, 20))
      }
    });

    const payload: DiffSummaryPayload = {
      id: row.id,
      taskId: row.taskId,
      sessionId: row.sessionId,
      filesChanged: row.filesChanged,
      insertions: row.insertions,
      deletions: row.deletions,
      addedCount: row.addedCount,
      modifiedCount: row.modifiedCount,
      deletedCount: row.deletedCount,
      renamedCount: row.renamedCount,
      riskFlags,
      topFiles: topFiles.slice(0, 20),
      statusText: stat.stdout || status.stdout,
      createdAt: row.createdAt
    };

    this.events.emitEnvelopeToTask(task.id, 'diff.summary', 'diff', riskFlags.length > 0 ? 'warn' : 'info', payload, {
      sessionId: session?.id
    });

    return payload;
  }
}

function parseNumstat(output: string): Array<{ path: string; insertions: number; deletions: number }> {
  return output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [insertionsRaw, deletionsRaw, filePath] = record.split('\t');
      return {
        path: filePath ?? record,
        insertions: parseCount(insertionsRaw),
        deletions: parseCount(deletionsRaw)
      };
    })
    .filter((file) => file.path.length > 0);
}

function parseCount(value: string | undefined): number {
  if (!value || value === '-') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNameStatus(output: string): { addedCount: number; modifiedCount: number; deletedCount: number; renamedCount: number } {
  const tokens = output.split('\0').filter(Boolean);
  let addedCount = 0;
  let modifiedCount = 0;
  let deletedCount = 0;
  let renamedCount = 0;

  for (let i = 0; i < tokens.length; i += 2) {
    const status = tokens[i] ?? '';
    if (status.startsWith('A')) addedCount += 1;
    else if (status.startsWith('D')) deletedCount += 1;
    else if (status.startsWith('R')) renamedCount += 1;
    else if (status.startsWith('M')) modifiedCount += 1;
  }

  return { addedCount, modifiedCount, deletedCount, renamedCount };
}

function computeRiskFlags(paths: string[], topFiles: Array<{ path: string; insertions: number; deletions: number }>): string[] {
  const flags = new Set<string>();
  for (const filePath of paths) {
    const lower = filePath.toLowerCase();
    if (lower.includes('lock') || lower.endsWith('pnpm-lock.yaml') || lower.endsWith('package-lock.json')) flags.add('lockfile_changed');
    if (lower.includes('migration') || lower.includes('prisma/migrations')) flags.add('migration_changed');
    if (lower.includes('.github/') || lower.includes('ci') || lower.includes('workflow')) flags.add('ci_or_config_changed');
    if (lower.includes('auth') || lower.includes('credential') || lower.includes('secret') || lower.includes('token') || lower.includes('password')) flags.add('secret_or_auth_shaped_path');
    if (lower.endsWith('.env') || lower.includes('.env.')) flags.add('blocked_secret_path_changed');
  }
  if (topFiles.some((file) => file.deletions > 0)) flags.add('deletions_present');
  if (topFiles.reduce((sum, file) => sum + file.insertions + file.deletions, 0) > 1000) flags.add('large_diff');
  return [...flags];
}
