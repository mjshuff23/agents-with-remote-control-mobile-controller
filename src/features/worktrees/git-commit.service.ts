import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ProblemException } from '../../common/errors/problem.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { SyncEventService } from '../sync/sync-event.service';
import { GitCommandService } from './git-command.service';

export interface CommitInput {
  taskId: string;
  sessionId?: string;
  /** Short summary line for the commit message. */
  summary: string;
  /** Optional Linear issue key (e.g. TSH-102). */
  linearKey?: string | null;
  /** Optional GitHub/external issue key (e.g. #42). */
  githubIssueKey?: string | null;
}

export interface CommitResult {
  sha: string;
  message: string;
  signingWarning?: string;
}

/**
 * Approval-gated git commit service.
 *
 * Flow:
 * 1. Verify the task has a worktree.
 * 2. Check whether local signing is configured.
 * 3. Create an approval request (actionType: git.commit, riskLevel: NEEDS_APPROVAL).
 * 4. If approved, run `git add -A && git commit` in the task worktree.
 * 5. Capture the resulting SHA and persist it to a SyncEvent.
 */
@Injectable()
export class GitCommitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gitCommands: GitCommandService,
    private readonly approvals: ApprovalsService,
    private readonly syncEvents: SyncEventService,
  ) {}

  /**
   * Build a deterministic commit message.
   *
   * Format:
   * ```
   * <summary>
   *
   * Task: <taskId>
   * [Linear: <linearKey>]
   * [GitHub: <githubIssueKey>]
   * ```
   */
  buildCommitMessage(input: Pick<CommitInput, 'taskId' | 'summary' | 'linearKey' | 'githubIssueKey'>): string {
    const lines: string[] = [input.summary, '', `Task: ${input.taskId}`];
    if (input.linearKey) lines.push(`Linear: ${input.linearKey}`);
    if (input.githubIssueKey) lines.push(`GitHub: ${input.githubIssueKey}`);
    return lines.join('\n');
  }

  /**
   * Detect whether git commit signing appears to be configured in the
   * worktree's effective git config.
   *
   * Returns `true` when `commit.gpgsign` or `gpg.format` is set, or when
   * `user.signingkey` is non-empty.  This is a best-effort check; the actual
   * signing may still fail if the key is unavailable at commit time.
   */
  async isSigningConfigured(worktreePath: string): Promise<boolean> {
    const checks = await Promise.allSettled([
      this.gitCommands.git(worktreePath, ['config', '--get', 'commit.gpgsign']),
      this.gitCommands.git(worktreePath, ['config', '--get', 'gpg.format']),
      this.gitCommands.git(worktreePath, ['config', '--get', 'user.signingkey']),
    ]);

    const [gpgSign, gpgFormat, signingKey] = checks;

    if (gpgSign.status === 'fulfilled' && gpgSign.value.stdout.trim() === 'true') return true;
    if (gpgFormat.status === 'fulfilled' && gpgFormat.value.stdout.trim().length > 0) return true;
    if (signingKey.status === 'fulfilled' && signingKey.value.stdout.trim().length > 0) return true;

    return false;
  }

  /**
   * Request approval and, if granted, execute `git add -A && git commit` in
   * the task worktree.  Persists the resulting SHA to a SyncEvent.
   *
   * @throws ProblemException(404) if the task or its worktree is missing.
   * @throws ProblemException(403) if the approval is denied/expired/refused.
   * @throws ProblemException(500) if the commit fails (e.g. signing error).
   */
  async requestAndExecute(input: CommitInput): Promise<CommitResult> {
    const { taskId, sessionId, summary, linearKey, githubIssueKey } = input;

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
    const message = this.buildCommitMessage({ taskId, summary, linearKey, githubIssueKey });

    // Best-effort signing check — surface a warning but do not block.
    const signingConfigured = await this.isSigningConfigured(worktreePath);
    const signingWarning = signingConfigured
      ? undefined
      : 'Commit signing is not configured. The commit will be unsigned.';

    // Create approval request — always NEEDS_APPROVAL for git.commit.
    const { approval, decision } = await this.approvals.createFromAgentRequest(taskId, sessionId ?? taskId, {
      id: randomUUID(),
      actionType: 'git.commit',
      riskLevel: 'NEEDS_APPROVAL',
      title: `Commit: ${summary}`,
      rationale: 'Commit staged changes to the task worktree.',
      command: ['git', 'commit', '-m', message],
      expectedEffect: `Creates a git commit in ${worktreePath} with the provided message.`,
    });

    // Auto-allow is not expected for git.commit, but handle it gracefully.
    const resolvedDecision = decision ?? approval.decision;
    if (resolvedDecision !== 'approved' && resolvedDecision !== 'auto_allow') {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        'Commit Not Approved',
        `Commit approval was ${resolvedDecision ?? 'pending'}. Commit aborted.`,
      );
    }

    // Stage all changes and commit.
    await this.gitCommands.git(worktreePath, ['add', '-A']);

    let commitOutput: string;
    try {
      const result = await this.gitCommands.git(worktreePath, ['commit', '-m', message]);
      commitOutput = result.stdout + result.stderr;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isSigningError =
        msg.includes('gpg') ||
        msg.includes('signing') ||
        msg.includes('secret key');
      throw new ProblemException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        isSigningError ? 'Commit Signing Failed' : 'Commit Failed',
        isSigningError
          ? `Git commit failed due to a signing error: ${msg}`
          : `Git commit failed: ${msg}`,
      );
    }

    // Capture the resulting SHA.
    const sha = (await this.gitCommands.git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();

    // Persist SHA to a SyncEvent so it survives replay.
    const record = await this.syncEvents.createOrReuse({
      taskId,
      sessionId,
      provider: 'git',
      action: 'commit',
      targetId: taskId,
    });

    if (record.status === 'pending' || record.status === 'retryable') {
      await this.syncEvents.markRunning(record.id);
      await this.syncEvents.markSucceeded(record.id, sha, undefined);
    } else if (record.status === 'running') {
      // Previous transition crashed mid-flight — go straight to succeeded.
      await this.syncEvents.markSucceeded(record.id, sha, undefined);
    }
    // Already terminal (succeeded/failed/skipped) — skip; the commit
    // outcome was already recorded in a prior run.

    void commitOutput; // consumed for side-effect detection only

    return { sha, message, signingWarning };
  }
}
