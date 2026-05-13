import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ProblemException } from '../../common/errors/problem.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { SyncEventService } from '../sync/sync-event.service';
import { GitCommandService } from './git-command.service';

export interface PushInput {
  taskId: string;
  sessionId?: string;
  /** Remote name (defaults to 'origin'). */
  remote?: string;
  /** Branch to push (defaults to task.branchName or current HEAD). */
  branch?: string;
}

export interface PushResult {
  remote: string;
  branch: string;
  /** SHA of the pushed branch ref. */
  remoteSha: string;
}

export type PushErrorCategory = 'auth_failed' | 'network_error' | 'push_rejected' | 'unknown_error';

/**
 * Approval-gated git push service.
 *
 * Flow:
 * 1. Verify the task has a worktree.
 * 2. Verify the remote is configured.
 * 3. Verify the branch exists locally.
 * 4. Reject unsafe refspecs (force-push, wildcards, source:destination).
 * 5. Create an approval request (actionType: git.push, riskLevel: NEEDS_APPROVAL).
 * 6. If approved, run `git push <remote> <branch>` in the task worktree.
 * 7. Capture the resulting ref SHA and persist it to a SyncEvent.
 */
@Injectable()
export class GitPushService {
  private readonly logger = new Logger(GitPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gitCommands: GitCommandService,
    private readonly approvals: ApprovalsService,
    private readonly syncEvents: SyncEventService,
  ) {}

  /**
   * Verify a remote is configured in the worktree's repository.
   * @throws ProblemException(422) if the remote is not found.
   */
  private async verifyRemote(worktreePath: string, remote: string): Promise<void> {
    try {
      await this.gitCommands.git(worktreePath, ['remote', 'get-url', remote]);
    } catch {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Remote Not Found',
        `Remote "${remote}" is not configured in the worktree repository.`,
      );
    }
  }

  /**
   * Verify a branch exists locally in the worktree.
   * @throws ProblemException(422) if the branch is not found.
   */
  private async verifyLocalBranch(worktreePath: string, branch: string): Promise<void> {
    try {
      await this.gitCommands.git(worktreePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    } catch {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Branch Not Found',
        `Branch "${branch}" does not exist locally in the worktree.`,
      );
    }
  }

  /**
   * Detect the current branch from HEAD.
   * @throws ProblemException(422) if HEAD is detached.
   */
  private async detectCurrentBranch(worktreePath: string): Promise<string> {
    const { stdout } = await this.gitCommands.git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = stdout.trim();
    if (branch === 'HEAD') {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Detached HEAD',
        'The worktree is in a detached HEAD state. Check out a branch before pushing.',
      );
    }
    return branch;
  }

  /**
   * Validate that the branch/refspec is safe to push.
   * Refuses force-push prefixes, source:destination refspecs, and wildcards.
   * @throws ProblemException(422) if the refspec is unsafe.
   */
  private validateRefspecSafety(branch: string): void {
    if (branch.startsWith('+')) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Force Push Refused',
        'Force-push refspecs (leading "+") are not allowed.',
      );
    }
    if (branch.includes(':')) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Unsafe Refspec Refused',
        'Refspecs containing ":" are not allowed. Use a simple branch name.',
      );
    }
    if (branch === '' || branch === '*' || branch.includes('*')) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Unsafe Refspec Refused',
        'Wildcard refspecs are not allowed.',
      );
    }
  }

  /**
   * Categorize a git push error message into a stable failure category.
   */
  categorizePushError(msg: string): PushErrorCategory {
    const lower = msg.toLowerCase();
    if (
      lower.includes('authentication failed') ||
      lower.includes('permission denied') ||
      lower.includes('could not read from remote')
    ) {
      return 'auth_failed';
    }
    if (
      lower.includes('could not resolve host') ||
      lower.includes('connection refused') ||
      lower.includes('connection timed out') ||
      lower.includes('could not connect') ||
      lower.includes('network is unreachable')
    ) {
      return 'network_error';
    }
    if (
      lower.includes('! [rejected]') ||
      lower.includes('failed to push') ||
      lower.includes('protected branch') ||
      lower.includes('branch is protected') ||
      lower.includes('non-fast-forward')
    ) {
      return 'push_rejected';
    }
    return 'unknown_error';
  }

  /**
   * Persist push outcome to a SyncEvent with status-aware lifecycle handling.
   * Logs a warning when the SyncEvent is already in a terminal state.
   */
  private async recordSyncEvent(
    taskId: string,
    sessionId: string | undefined,
    status: 'succeeded' | 'failed',
    sha?: string,
    errorCategory?: PushErrorCategory,
    errorMessage?: string,
  ): Promise<void> {
    const record = await this.syncEvents.createOrReuse({
      taskId,
      sessionId,
      provider: 'git',
      action: 'push',
      targetId: taskId,
    });

    if (record.status === 'pending' || record.status === 'retryable') {
      await this.syncEvents.markRunning(record.id);
    }

    if (record.status === 'pending' || record.status === 'retryable' || record.status === 'running') {
      if (status === 'succeeded') {
        await this.syncEvents.markSucceeded(record.id, sha, undefined);
      } else {
        await this.syncEvents.markFailed(record.id, errorCategory ?? 'unknown_error', errorMessage ?? 'Unknown error');
      }
    } else {
      this.logger.warn(
        `SyncEvent ${record.id} already in terminal state "${record.status}" for task ${taskId}; skipping transition`,
      );
    }
  }

  /**
   * Request approval and, if granted, execute `git push <remote> <branch>`
   * in the task worktree.  Persists the outcome to a SyncEvent.
   *
   * @throws ProblemException(404) if the task or its worktree is missing.
   * @throws ProblemException(422) if the remote, branch, or refspec is invalid.
   * @throws ProblemException(403) if the approval is denied/expired/refused.
   * @throws ProblemException(500) if the push fails.
   */
  async requestAndExecute(input: PushInput): Promise<PushResult> {
    const { taskId, sessionId } = input;

    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${taskId}" does not exist.`);
    }
    if (!task.worktreePath) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Worktree Not Ready',
        `Task "${taskId}" does not have a worktree path set.`,
      );
    }

    const worktreePath = task.worktreePath;
    const remote = input.remote || 'origin';
    const branch = input.branch || task.branchName || (await this.detectCurrentBranch(worktreePath));

    // Pre-flight checks: fail fast on unsafe refspecs before any git calls.
    this.validateRefspecSafety(branch);
    await this.verifyRemote(worktreePath, remote);
    await this.verifyLocalBranch(worktreePath, branch);

    // Create approval request — always NEEDS_APPROVAL for git.push.
    const { approval, decision } = await this.approvals.createFromAgentRequest(taskId, sessionId ?? taskId, {
      id: randomUUID(),
      actionType: 'git.push',
      riskLevel: 'NEEDS_APPROVAL',
      title: `Push: ${branch} \u2192 ${remote}`,
      rationale: 'Push committed changes to the remote repository.',
      command: ['git', 'push', remote, branch],
      expectedEffect: `Pushes branch ${branch} to ${remote} from ${worktreePath}.`,
    });

    // Auto-allow is not expected for git.push, but handle it gracefully.
    const resolvedDecision = decision ?? approval.decision;
    if (resolvedDecision !== 'approved' && resolvedDecision !== 'auto_allow') {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        'Push Not Approved',
        `Push approval was ${resolvedDecision ?? 'pending'}. Push aborted.`,
      );
    }

    // Execute push.
    try {
      await this.gitCommands.git(worktreePath, ['push', remote, branch]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const category = this.categorizePushError(msg);

      this.logger.error(`Git push failed: ${msg}`);

      await this.recordSyncEvent(taskId, sessionId, 'failed', undefined, category, msg);

      throw new ProblemException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Push Failed',
        'Git push failed due to a server error. Please try again later or contact support.',
      );
    }

    // Capture the SHA of the pushed branch ref.
    const remoteSha = (await this.gitCommands.git(worktreePath, ['rev-parse', `refs/heads/${branch}`])).stdout.trim();

    // Persist result to a SyncEvent so it survives replay.
    await this.recordSyncEvent(taskId, sessionId, 'succeeded', remoteSha);

    return { remote, branch, remoteSha };
  }
}
