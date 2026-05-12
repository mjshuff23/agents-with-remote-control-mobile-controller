import { Injectable } from '@nestjs/common';
import { mkdir, stat } from 'fs/promises';
import * as path from 'path';

import { AppConfigService } from '../../config/app-config.service';
import { EventsGateway } from '../../events/events.gateway';
import type { ExternalIssueRef } from '../providers/provider.types';
import { buildBranchName, withCollisionSuffix } from './branch-namer';
import { GitCommandService } from './git-command.service';

export interface WorktreeInput {
  taskId: string;
  title?: string | null;
  prompt: string;
  /** When present, uses issue-linked branch naming: agent/<provider>-<key>-<slug>. */
  externalIssueRef?: ExternalIssueRef | null;
  /**
   * Explicit base branch to create the worktree from.
   * Falls back to the current HEAD branch of the main checkout.
   */
  baseRef?: string | null;
}

export interface WorktreeResult {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  baseRef: string;
  baseCommit: string;
}

/**
 * Cleanup policy for a worktree after a task ends.
 * - `remove`: remove the worktree directory and delete the branch.
 * - `keep`: leave the worktree in place (e.g. for post-merge inspection).
 */
export type WorktreeCleanupPolicy = 'remove' | 'keep';

/** Creates and manages isolated git worktrees per task with deterministic branch names. */
@Injectable()
export class GitWorktreeService {
  constructor(
    private readonly config: AppConfigService,
    private readonly gitCommands: GitCommandService,
    private readonly events: EventsGateway
  ) {}

  /**
   * Create a git worktree and branch for a task.
   *
   * Branch naming:
   * - Issue-linked: `agent/<provider>-<key>-<slug>` (when externalIssueRef is present)
   * - Fallback:     `agent/<taskId>-<slug>`
   *
   * Collision handling: if two tasks attempt to create the same branch name
   * simultaneously, the second will fail at the git level. The caller can retry
   * with a collision suffix (-2, -3, …) by using the resolveUniqueBranchName helper.
   *
   * Dirty-repo guard: refuses to create a new worktree if the main checkout has
   * uncommitted changes, to prevent accidental contamination.
   *
   * Reuse: if a worktree already exists at the target path and is on the expected
   * branch, it is reused without re-running `git worktree add`.
   *
   * @returns Paths, branch name, base ref, and base commit.
   */
  async createForTask(input: WorktreeInput): Promise<WorktreeResult> {
    const { repoPath } = this.config;

    // Resolve base ref: explicit > current HEAD branch
    const headBranch = (await this.gitCommands.git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    const baseRef = (input.baseRef?.trim()) || headBranch || 'HEAD';
    // Resolve baseCommit from the chosen baseRef, not always from HEAD
    const baseCommit = (await this.gitCommands.git(repoPath, ['rev-parse', baseRef])).stdout.trim();

    const worktreeRoot = this.config.worktreeRoot
      ? path.resolve(this.config.worktreeRoot)
      : path.resolve(path.dirname(repoPath), 'worktrees');

    // Derive branch name (issue-linked or task-id fallback)
    const { branchName: candidateName } = buildBranchName({
      taskId: input.taskId,
      title: input.title,
      prompt: input.prompt,
      externalIssueRef: input.externalIssueRef,
    });

    const worktreeDirName = candidateName.replace(/^agent\//, '');
    const worktreePath = path.join(worktreeRoot, worktreeDirName);

    // Guard against path traversal: the resolved worktree path must stay within worktreeRoot.
    const resolvedWorktreePath = path.resolve(worktreePath);
    const resolvedWorktreeRoot = path.resolve(worktreeRoot);
    if (!resolvedWorktreePath.startsWith(resolvedWorktreeRoot + path.sep) &&
        resolvedWorktreePath !== resolvedWorktreeRoot) {
      throw new Error(`Derived worktree path "${resolvedWorktreePath}" escapes worktree root "${resolvedWorktreeRoot}"`);
    }

    await mkdir(worktreeRoot, { recursive: true });

    // Reuse existing worktree if present
    if (await pathExists(path.join(worktreePath, '.git'))) {
      const existingBranch = (await this.gitCommands.git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
      if (existingBranch !== candidateName) {
        throw new Error(`Existing worktree at ${worktreePath} is on "${existingBranch}", expected "${candidateName}"`);
      }
      const existingCommit = (await this.gitCommands.git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim() || baseCommit;
      await this.events.emitEnvelopeToTask(input.taskId, 'worktree.created', 'git', 'info', {
        worktreePath,
        branchName: candidateName,
        baseRef,
        baseCommit: existingCommit,
        reused: true,
      });
      return { repoPath, worktreePath, branchName: candidateName, baseRef, baseCommit: existingCommit };
    }

    // Dirty-repo guard: refuse to create a new worktree from a dirty main checkout
    await this.assertCleanRepo(repoPath);

    // If the candidate branch already exists, add a worktree pointing to it (reuse).
    // If it doesn't exist, find a unique name and create a new branch.
    const branchExists = await this.branchExists(repoPath, candidateName);
    let branchName: string;
    if (branchExists) {
      // Branch already exists; use it directly.
      branchName = candidateName;
      await this.gitCommands.git(repoPath, ['worktree', 'add', worktreePath, branchName]);
    } else {
      // Branch doesn't exist yet. Use the candidate name directly.
      // If two tasks share the same issue key and both try to create the branch
      // simultaneously, the second will fail at git level; the caller can retry
      // with a collision suffix if needed.
      branchName = candidateName;
      await this.gitCommands.git(repoPath, ['worktree', 'add', '-b', branchName, worktreePath, baseRef]);
    }

    await this.events.emitEnvelopeToTask(input.taskId, 'worktree.created', 'git', 'info', {
      worktreePath,
      branchName,
      baseRef,
      baseCommit,
      reused: false,
    });

    return { repoPath, worktreePath, branchName, baseRef, baseCommit };
  }

  /**
   * Remove a worktree and optionally delete its branch.
   * Emits cleanup events regardless of whether the removal succeeds.
   *
   * Cleanup policy:
   * - After PR merge: `remove` (branch already merged, safe to delete).
   * - After task cancel / PR close without merge: `remove` (no merged work to preserve).
   * - Manual inspection: `keep`.
   */
  async removeWorktree(
    taskId: string,
    worktreePath: string,
    branchName: string,
    policy: WorktreeCleanupPolicy = 'remove',
  ): Promise<void> {
    await this.events.emitEnvelopeToTask(taskId, 'worktree.cleanup_requested', 'git', 'info', {
      worktreePath,
      branchName,
      policy,
    });

    if (policy === 'keep') {
      return;
    }

    const { repoPath } = this.config;
    try {
      await this.gitCommands.git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      // Worktree may already be gone; continue to branch deletion
    }

    try {
      await this.gitCommands.git(repoPath, ['branch', '-D', branchName]);
    } catch {
      // Branch may not exist or may already be deleted
    }

    await this.events.emitEnvelopeToTask(taskId, 'worktree.cleanup_completed', 'git', 'info', {
      worktreePath,
      branchName,
    });
  }

  /** Emit a worktree cleanup-requested event (legacy compat). */
  async requestCleanup(taskId: string, worktreePath: string): Promise<void> {
    await this.events.emitEnvelopeToTask(taskId, 'worktree.cleanup_requested', 'git', 'info', { worktreePath });
  }

  /** Emit a worktree cleanup-completed event (legacy compat). */
  async markCleanupCompleted(taskId: string, worktreePath: string): Promise<void> {
    await this.events.emitEnvelopeToTask(taskId, 'worktree.cleanup_completed', 'git', 'info', { worktreePath });
  }

  /**
   * Assert the main checkout has no uncommitted changes.
   * Throws if the working tree or index is dirty.
   */
  private async assertCleanRepo(repoPath: string): Promise<void> {
    const { stdout } = await this.gitCommands.git(repoPath, ['status', '--porcelain']);
    if (stdout.trim().length > 0) {
      throw new Error(
        `Main checkout at ${repoPath} has uncommitted changes. Commit or stash them before creating a new worktree.`,
      );
    }
  }

  /**
   * Find a unique branch name that does not exist in the repo.
   * Called only when the base candidate is already taken by a different branch.
   * Appends -2, -3, … up to 9 attempts before giving up.
   */
  private async resolveUniqueBranchName(repoPath: string, candidate: string): Promise<string> {
    for (let i = 2; i <= 10; i++) {
      const suffixed = withCollisionSuffix(candidate, i);
      if (!(await this.branchExists(repoPath, suffixed))) {
        return suffixed;
      }
    }
    throw new Error(`Could not find a unique branch name after 9 collision attempts for base "${candidate}"`);
  }

  /** Check whether a branch already exists in the repository. */
  private async branchExists(repoPath: string, branchName: string): Promise<boolean> {
    try {
      await this.gitCommands.git(repoPath, ['rev-parse', '--verify', branchName]);
      return true;
    } catch {
      return false;
    }
  }
}

/** Check whether a filesystem path exists. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
