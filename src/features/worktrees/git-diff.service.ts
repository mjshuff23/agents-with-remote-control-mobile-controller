import { HttpStatus, Injectable } from '@nestjs/common';
import { AgentSession, Task } from '@prisma/client';

import { ProblemException } from '../../common/errors/problem.exception';
import { EventsGateway } from '../../events/events.gateway';
import { PrismaService } from '../../prisma/prisma.service';
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

/** Runs git diff commands against a task worktree and produces structured change summaries with risk flags. */
@Injectable()
export class GitDiffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gitCommands: GitCommandService,
    private readonly events: EventsGateway
  ) {}

  /** Summarize diff changes for a task by loading the task and delegating to summarize(). */
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

  /**
   * Run git status/diff commands, parse numstat and porcelain output,
   * compute risk flags, persist a GitChangeSummary, and emit a `diff.summary` event.
   */
  async summarize(task: Task, session?: AgentSession | null): Promise<DiffSummaryPayload> {
    if (!task.worktreePath) {
      throw new ProblemException(HttpStatus.CONFLICT, 'Worktree Missing', `Task "${task.id}" has no worktree path.`);
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

    await this.events.emitEnvelopeToTask(task.id, 'diff.summary', 'diff', riskFlags.length > 0 ? 'warn' : 'info', payload, {
      sessionId: session?.id
    });

    return payload;
  }
}

/** Parse `git diff --numstat -z` output into per-file change counts. */
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

/** Parse a git diff count string, returning 0 for missing or non-numeric values. */
function parseCount(value: string | undefined): number {
  if (!value || value === '-') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Parse `git diff --name-status -z` output into status counts. */
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

/** Parse `git status --porcelain=v2 -z --branch` into counts and untracked paths. */
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

/** Merge diff --name-status counts with porcelain status counts, taking the max per category. */
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

/** Append untracked file paths (with zero changes) to the file list. */
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

/** Compute risk flags (lockfile, migration, CI, secret paths, large diff, deletions) from changed file paths. */
function computeRiskFlags(paths: string[], topFiles: Array<{ path: string; insertions: number; deletions: number }>): string[] {
  const flags = new Set<string>();
  for (const filePath of paths) {
    const lower = filePath.toLowerCase();
    
    // Lockfile: match specific lockfile names or paths ending with lock-related extensions
    if (/^.*\/(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|composer\.lock)$/.test(lower) ||
        /^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|composer\.lock)$/.test(lower)) {
      flags.add('lockfile_changed');
    }
    
    // Migration: match prisma/migrations or migration-related paths
    if (/prisma\/migrations/.test(lower) || /\/migrations\//.test(lower)) {
      flags.add('migration_changed');
    }
    
    // CI/workflow: match repo-level CI config files and directories
    if (/^\.github\//.test(lower) || /^\.gitlab-ci\.yml$/.test(lower) || 
        /^\.circleci\//.test(lower) || /^jenkinsfile$/i.test(lower) ||
        /^\.github\/workflows\//.test(lower)) {
      flags.add('ci_or_config_changed');
    }
    
    // Secret/auth: match paths with auth/credential/secret/token/password keywords
    if (/auth|credential|secret|token|password/.test(lower)) {
      flags.add('secret_or_auth_shaped_path');
    }
    
    // Blocked secret path: match .env files (including nested)
    if (/\.env$/.test(lower) || /\.env\./.test(lower)) {
      flags.add('blocked_secret_path_changed');
    }
  }
  
  if (topFiles.some((file) => file.deletions > 0)) flags.add('deletions_present');
  if (topFiles.reduce((sum, file) => sum + file.insertions + file.deletions, 0) > 1000) flags.add('large_diff');
  return [...flags];
}
