import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { ProblemException } from '../../common/errors/problem.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { GitDiffService, DiffSummaryPayload } from './git-diff.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { SyncEventService } from '../sync/sync-event.service';

const execFileAsync = promisify(execFile);

export interface PrInput {
  taskId: string;
  sessionId?: string;
  title: string;
  /** Base branch (defaults to task.baseRef or 'main'). */
  base?: string;
  /** Head branch (defaults to task.branchName). */
  head?: string;
}

export interface PrResult {
  prNumber: number;
  prUrl: string;
  /** True if a new PR was created, false if an existing one was reused. */
  created: boolean;
}

const GH_TIMEOUT_MS = 30_000;

/**
 * Approval-gated draft PR creation service.
 *
 * Flow:
 * 1. Verify the task exists and has a worktree + branch.
 * 2. Check SyncEvent for an existing PR (idempotency).
 * 3. Generate PR body from task details, diff summary, test results, and approvals.
 * 4. Create an approval request (actionType: provider.github.create_pr).
 * 5. If approved, run `gh pr create --draft` to create or reuse the PR.
 * 6. Persist result to a SyncEvent.
 */
@Injectable()
export class PrGeneratorService {
  private readonly logger = new Logger(PrGeneratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly diffs: GitDiffService,
    private readonly approvals: ApprovalsService,
    private readonly syncEvents: SyncEventService,
  ) {}

  /**
   * Load the latest diff summary for the task.
   */
  private async loadLatestDiff(taskId: string): Promise<DiffSummaryPayload | null> {
    const rows = await this.prisma.gitChangeSummary.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    if (rows.length === 0) return null;
    return {
      id: rows[0].id,
      taskId: rows[0].taskId,
      sessionId: rows[0].sessionId,
      filesChanged: rows[0].filesChanged,
      insertions: rows[0].insertions,
      deletions: rows[0].deletions,
      addedCount: rows[0].addedCount,
      modifiedCount: rows[0].modifiedCount,
      deletedCount: rows[0].deletedCount,
      renamedCount: rows[0].renamedCount,
      riskFlags: JSON.parse(rows[0].riskFlagsJson ?? '[]') as string[],
      topFiles: JSON.parse(rows[0].topFilesJson ?? '[]') as DiffSummaryPayload['topFiles'],
      statusText: rows[0].statusText,
      createdAt: rows[0].createdAt,
    };
  }

  /**
   * Load the latest test run results for the task.
   */
  private async loadLatestTests(taskId: string): Promise<Array<{ commandId: string; status: string; exitCode: number | null }>> {
    return this.prisma.testRunSummary.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
  }

  /**
   * Count approved (non-refused) approval requests for the task.
   */
  private async countApprovals(taskId: string): Promise<number> {
    return this.prisma.approvalRequest.count({
      where: { taskId, decision: 'approved' },
    });
  }

  /**
   * Generate a PR body markdown string from task context.
   */
  async generatePrBody(taskId: string): Promise<string> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'Task Not Found', `Task "${taskId}" does not exist.`);
    }

    const [diff, testRuns, approvalCount] = await Promise.all([
      this.loadLatestDiff(taskId),
      this.loadLatestTests(taskId),
      this.countApprovals(taskId),
    ]);

    const sections: string[] = [];

    // Summary
    sections.push('## Summary\n');
    sections.push(task.prompt || task.title || 'No description provided.');
    sections.push('');

    // Linked Issues
    sections.push('## Linked Issues\n');
    if (task.externalIssueRef) {
      try {
        const ref = JSON.parse(task.externalIssueRef) as { provider?: string; key?: string; url?: string };
        if (ref.url) {
          sections.push(`- [${ref.key ?? ref.provider}](${ref.url})`);
        } else if (ref.key) {
          sections.push(`- ${ref.key}`);
        }
      } catch {
        sections.push('- External issue referenced');
      }
    } else {
      sections.push('- None');
    }
    sections.push(`- Task: ${taskId}`);
    sections.push('');

    // Changes
    sections.push('## Changes\n');
    if (diff) {
      sections.push(`- ${diff.filesChanged} files changed, +${diff.insertions} / -${diff.deletions}`);
      sections.push(`- Added: ${diff.addedCount}, Modified: ${diff.modifiedCount}, Deleted: ${diff.deletedCount}, Renamed: ${diff.renamedCount}`);
      if (diff.topFiles.length > 0) {
        sections.push('');
        sections.push('**Top files:**');
        for (const file of diff.topFiles.slice(0, 10)) {
          const status = file.status ? ` (${file.status})` : '';
          sections.push(`- \`${file.path}\` +${file.insertions}/-${file.deletions}${status}`);
        }
      }
    } else {
      sections.push('- No diff summary available.');
    }
    sections.push('');

    // Tests
    sections.push('## Tests\n');
    if (testRuns.length > 0) {
      for (const run of testRuns) {
        const icon = run.status === 'passed' ? '✓' : run.status === 'failed' ? '✗' : '○';
        sections.push(`- ${icon} \`${run.commandId}\`: ${run.status}${run.exitCode !== null ? ` (exit ${run.exitCode})` : ''}`);
      }
    } else {
      sections.push('- No test runs recorded.');
    }
    sections.push('');

    // Approvals
    sections.push('## Approvals\n');
    sections.push(`- ${approvalCount} human-approved action(s) during this task.`);
    sections.push('');

    // Known Risks
    sections.push('## Known Risks\n');
    if (diff && diff.riskFlags.length > 0) {
      for (const flag of diff.riskFlags) {
        sections.push(`- ${flag.replace(/_/g, ' ')}`);
      }
    } else {
      sections.push('- None identified');
    }
    sections.push('');

    // Follow-ups
    sections.push('## Follow-ups\n');
    sections.push('- Review and merge once CI passes.');

    return sections.join('\n');
  }

  /**
   * Request approval and, if granted, create a draft PR via `gh pr create`.
   * If a PR already exists for this task (checked via SyncEvent), reuses it.
   *
   * @throws ProblemException(404) if the task is missing.
   * @throws ProblemException(422) if worktree or branch is not ready.
   * @throws ProblemException(403) if approval is denied/expired/refused.
   * @throws ProblemException(500) if PR creation fails.
   */
  async requestAndExecute(input: PrInput): Promise<PrResult> {
    const { taskId, sessionId, title } = input;

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
    const head = input.head || task.branchName;
    if (!head) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Branch Not Found',
        `Task "${taskId}" does not have a branch name. Push a branch first.`,
      );
    }
    const base = input.base || task.baseRef || 'main';

    // Check SyncEvent for existing PR (idempotency).
    const existing = await this.syncEvents.getLastForAction(taskId, 'github', 'create_pr', taskId);
    if (existing?.status === 'succeeded' && existing.externalId) {
      const prNumber = Number(existing.externalId);
      if (Number.isFinite(prNumber) && existing.url) {
        return { prNumber, prUrl: existing.url, created: false };
      }
    }

    // Generate PR body.
    const body = await this.generatePrBody(taskId);

    // Create approval request.
    const { approval, decision } = await this.approvals.createFromAgentRequest(taskId, sessionId ?? taskId, {
      id: randomUUID(),
      actionType: 'provider.github.create_pr',
      riskLevel: 'NEEDS_APPROVAL',
      title: `PR: ${title}`,
      rationale: 'Create a draft pull request from the task branch.',
      command: ['gh', 'pr', 'create', '--draft', '--title', title, '--base', base, '--head', head],
      expectedEffect: `Creates a draft PR from ${head} to ${base} in the task repository.`,
    });

    const resolvedDecision = decision ?? approval.decision;
    if (resolvedDecision !== 'approved' && resolvedDecision !== 'auto_allow') {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        'PR Not Approved',
        `PR approval was ${resolvedDecision ?? 'pending'}. PR creation aborted.`,
      );
    }

    // Record SyncEvent as running.
    let record = await this.syncEvents.createOrReuse({
      taskId, sessionId, provider: 'github', action: 'create_pr', targetId: taskId,
    });
    if (record.status === 'pending' || record.status === 'retryable') {
      record = await this.syncEvents.markRunning(record.id);
    }

    // Execute `gh pr create`.
    let prUrl: string;
    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'create', '--draft', '--title', title, '--body', body, '--base', base, '--head', head], {
        cwd: worktreePath,
        timeout: GH_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      prUrl = stdout.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`gh pr create failed: ${msg}`);
      if (record.status === 'running' || record.status === 'pending' || record.status === 'retryable') {
        await this.syncEvents.markFailed(record.id, 'unknown_error', msg);
      }
      throw new ProblemException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'PR Creation Failed',
        'Failed to create pull request. Please try again later.',
      );
    }

    // Parse PR number from URL.
    const prNumber = parsePrNumber(prUrl);

    // Persist result to SyncEvent.
    await this.syncEvents.markSucceeded(record.id, String(prNumber), prUrl);

    return { prNumber, prUrl, created: true };
  }
}

/** Parse a PR number from a GitHub PR URL (e.g. https://github.com/owner/repo/pull/123). */
function parsePrNumber(url: string): number {
  const match = url.trim().match(/\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Could not parse PR number from URL: ${url}`);
  }
  return Number(match[1]);
}
