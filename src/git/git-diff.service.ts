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
      this.gitCommands.git(task.worktreePath, ['diff', '--stat', 'HEAD']),
      this.gitCommands.git(task.worktreePath, ['diff', '--numstat', '-z', 'HEAD']),
      this.gitCommands.git(task.worktreePath, ['diff', '--name-status', '-z', 'HEAD'])
    ]);

    const statusCounts = parsePorcelainStatus(status.stdout);
    const topFiles = mergeUntracked(parseNumstat(numstat.stdout), statusCounts.untrackedPaths);
    const counts = mergeCounts(parseNameStatus(nameStatus.stdout), statusCounts);
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
  const tokens = output.split('\0').filter(Boolean);
  const files: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const [insertionsRaw, deletionsRaw, inlinePath] = tokens[i].split('\t');
    let filePath = inlinePath;
    if (!filePath && i + 1 < tokens.length) {
      const sourcePath = tokens[i + 1];
      const destinationPath = tokens[i + 2];
      filePath = destinationPath ?? sourcePath;
      i += destinationPath ? 2 : 1;
    }
    if (filePath) {
      files.push({
        path: filePath,
        insertions: parseCount(insertionsRaw),
        deletions: parseCount(deletionsRaw)
      });
    }
  }
  return files;
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

  for (let i = 0; i < tokens.length;) {
    const status = tokens[i] ?? '';
    i += 1;
    if (status.startsWith('A')) addedCount += 1;
    else if (status.startsWith('D')) deletedCount += 1;
    else if (status.startsWith('R')) renamedCount += 1;
    else if (status.startsWith('M')) modifiedCount += 1;
    i += status.startsWith('R') || status.startsWith('C') ? 2 : 1;
  }

  return { addedCount, modifiedCount, deletedCount, renamedCount };
}

function parsePorcelainStatus(output: string): { addedCount: number; modifiedCount: number; deletedCount: number; renamedCount: number; untrackedPaths: string[] } {
  const tokens = output.split('\0').filter(Boolean);
  const counts = { addedCount: 0, modifiedCount: 0, deletedCount: 0, renamedCount: 0, untrackedPaths: [] as string[] };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith('#')) {
      continue;
    }
    if (token.startsWith('? ')) {
      counts.addedCount += 1;
      counts.untrackedPaths.push(token.slice(2));
      continue;
    }
    if (token.startsWith('2 ')) {
      counts.renamedCount += 1;
      i += 1;
      continue;
    }
    if (!token.startsWith('1 ')) {
      continue;
    }
    const xy = token.split(' ')[1] ?? '';
    if (xy.includes('A')) counts.addedCount += 1;
    else if (xy.includes('D')) counts.deletedCount += 1;
    else if (xy.includes('M')) counts.modifiedCount += 1;
  }
  return counts;
}

function mergeCounts(
  diffCounts: { addedCount: number; modifiedCount: number; deletedCount: number; renamedCount: number },
  statusCounts: { addedCount: number; modifiedCount: number; deletedCount: number; renamedCount: number; untrackedPaths: string[] }
) {
  return {
    addedCount: Math.max(diffCounts.addedCount, statusCounts.addedCount),
    modifiedCount: Math.max(diffCounts.modifiedCount, statusCounts.modifiedCount),
    deletedCount: Math.max(diffCounts.deletedCount, statusCounts.deletedCount),
    renamedCount: Math.max(diffCounts.renamedCount, statusCounts.renamedCount)
  };
}

function mergeUntracked(
  files: Array<{ path: string; insertions: number; deletions: number }>,
  untrackedPaths: string[]
): Array<{ path: string; insertions: number; deletions: number }> {
  const seen = new Set(files.map((file) => file.path));
  for (const filePath of untrackedPaths) {
    if (!seen.has(filePath)) {
      files.push({ path: filePath, insertions: 0, deletions: 0 });
    }
  }
  return files;
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
