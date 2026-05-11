import { Injectable } from '@nestjs/common';
import { mkdir, stat } from 'fs/promises';
import * as path from 'path';
import { AppConfigService } from '../config/app-config.service';
import { EventsGateway } from '../events/events.gateway';
import { GitCommandService } from './git-command.service';

export interface WorktreeInput {
  taskId: string;
  title?: string | null;
  prompt: string;
}

export interface WorktreeResult {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  baseRef: string;
  baseCommit: string;
}

@Injectable()
export class GitWorktreeService {
  constructor(
    private readonly config: AppConfigService,
    private readonly gitCommands: GitCommandService,
    private readonly events: EventsGateway
  ) {}

  async createForTask(input: WorktreeInput): Promise<WorktreeResult> {
    const repoPath = this.config.repoPath;
    const slug = slugify(input.title || input.prompt || input.taskId);
    const branchName = `agent/${input.taskId}-${slug}`;
    const worktreeRoot = this.config.worktreeRoot
      ? path.resolve(this.config.worktreeRoot)
      : path.resolve(path.dirname(repoPath), 'worktrees');
    const worktreePath = path.join(worktreeRoot, `${input.taskId}-${slug}`);
    const baseRef = (await this.gitCommands.git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'HEAD';
    const baseCommit = (await this.gitCommands.git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    await mkdir(worktreeRoot, { recursive: true });

    if (await pathExists(path.join(worktreePath, '.git'))) {
      const existingBranch = (await this.gitCommands.git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
      if (existingBranch !== branchName) {
        throw new Error(`Existing worktree at ${worktreePath} is on "${existingBranch}", expected "${branchName}"`);
      }
      const existingCommit = (await this.gitCommands.git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim() || baseCommit;
      this.events.emitEnvelopeToTask(input.taskId, 'worktree.created', 'git', 'info', {
        worktreePath,
        branchName,
        baseRef,
        baseCommit: existingCommit,
        reused: true
      });
      return { repoPath, worktreePath, branchName, baseRef, baseCommit: existingCommit };
    }

    const branchExists = await this.branchExists(repoPath, branchName);
    if (branchExists) {
      await this.gitCommands.git(repoPath, ['worktree', 'add', worktreePath, branchName]);
    } else {
      await this.gitCommands.git(repoPath, ['worktree', 'add', '-b', branchName, worktreePath, baseRef]);
    }

    this.events.emitEnvelopeToTask(input.taskId, 'worktree.created', 'git', 'info', {
      worktreePath,
      branchName,
      baseRef,
      baseCommit,
      reused: false
    });

    return { repoPath, worktreePath, branchName, baseRef, baseCommit };
  }

  async requestCleanup(taskId: string, worktreePath: string): Promise<void> {
    this.events.emitEnvelopeToTask(taskId, 'worktree.cleanup_requested', 'git', 'info', { worktreePath });
  }

  async markCleanupCompleted(taskId: string, worktreePath: string): Promise<void> {
    this.events.emitEnvelopeToTask(taskId, 'worktree.cleanup_completed', 'git', 'info', { worktreePath });
  }

  private async branchExists(repoPath: string, branchName: string): Promise<boolean> {
    try {
      await this.gitCommands.git(repoPath, ['rev-parse', '--verify', branchName]);
      return true;
    } catch {
      return false;
    }
  }
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return slug || 'task';
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
