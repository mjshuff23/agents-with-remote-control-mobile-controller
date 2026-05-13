import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProblemException } from '../../common/errors/problem.exception';
import { AppConfigService } from '../../config/app-config.service';
import { SyncEventService } from '../sync/sync-event.service';

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 30_000;

export type MergeState = 'open' | 'closed' | 'merged';

export interface MergeCheckResult {
  prNumber: number;
  state: MergeState;
  merged: boolean;
  mergeCommitSha?: string;
}

const LINEAR_API_URL = 'https://api.linear.app/graphql';

/**
 * MVP PR merge detection and Linear completion sync.
 *
 * Flow:
 * 1. Caller invokes `POST /tasks/:id/pr/check-merge` (manual refresh).
 * 2. Fetches PR status via `gh pr view --json state,mergeCommit,mergedAt`.
 * 3. If merged, updates the linked Linear issue to its "Done" workflow state.
 * 4. All actions recorded in SyncEvent for idempotency.
 *
 * Hardened webhook path (future):
 * - smee.io / ngrok local tunnel
 * - GitHub webhook with HMAC verification
 * - Event filtering (pull_request.closed only)
 * - Rate limiting and replay protection
 */
@Injectable()
export class MergeDetectionService {
  private readonly logger = new Logger(MergeDetectionService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly syncEvents: SyncEventService,
  ) {}

  /**
   * Check PR merge status via `gh pr view`. Returns the PR state
   * without modifying anything.
   */
  async checkMergeStatus(worktreePath: string, prNumber: number): Promise<MergeCheckResult> {
    try {
      const { stdout } = await execFileAsync('gh', [
        'pr', 'view', String(prNumber),
        '--json', 'state,mergeCommit,mergedAt',
      ], {
        cwd: worktreePath,
        timeout: GH_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });

      const data = JSON.parse(stdout) as {
        state: string;
        mergeCommit: { oid: string } | null;
        mergedAt: string | null;
      };

      const merged = data.state === 'MERGED';
      return {
        prNumber,
        state: merged ? 'merged' : data.state.toLowerCase() as 'open' | 'closed',
        merged,
        mergeCommitSha: data.mergeCommit?.oid ?? undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`gh pr view failed for #${prNumber}: ${msg}`);
      throw new ProblemException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Merge Check Failed',
        `Failed to check merge status for PR #${prNumber}.`,
      );
    }
  }

  /**
   * Fetch a Linear issue to determine its team, then find the
   * team's "completed" workflow state ID and update the issue to it.
   */
  private async updateLinearToDone(linearIssueId: string): Promise<void> {
    const token = this.config.linearToken;
    if (!token) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Linear Not Configured',
        'ARC_LINEAR_TOKEN is not set. Configure it to enable Linear completion sync.',
      );
    }

    // Step 1: Get the issue to find its team.
    const issueQuery = `query { issue(id: "${linearIssueId}") { id team { id } } }`;
    const issueRes = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: issueQuery }),
    });
    const issueJson = await issueRes.json() as {
      data?: { issue?: { id: string; team: { id: string } } };
      errors?: Array<{ message: string }>;
    };

    if (!issueRes.ok || issueJson.errors || !issueJson.data?.issue) {
      const errMsg = issueJson.errors?.[0]?.message ?? `HTTP ${issueRes.status}`;
      throw new Error(`Failed to fetch Linear issue: ${errMsg}`);
    }

    const teamId = issueJson.data.issue.team.id;

    // Step 2: Get workflow states for the team and find the "completed" one.
    const statesQuery = `query { workflowStates(filter: { team: { id: { eq: "${teamId}" } } }) { nodes { id name type } } }`;
    const statesRes = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: statesQuery }),
    });
    const statesJson = await statesRes.json() as {
      data?: { workflowStates?: { nodes: Array<{ id: string; name: string; type: string }> } };
      errors?: Array<{ message: string }>;
    };

    if (!statesRes.ok || statesJson.errors || !statesJson.data?.workflowStates) {
      const errMsg = statesJson.errors?.[0]?.message ?? `HTTP ${statesRes.status}`;
      throw new Error(`Failed to fetch Linear workflow states: ${errMsg}`);
    }

    const doneState = statesJson.data.workflowStates.nodes.find((s) => s.type === 'completed');
    if (!doneState) {
      throw new Error('No completed workflow state found for the Linear team.');
    }

    // Step 3: Update the issue to the done state.
    const updateMutation = `mutation { issueUpdate(id: "${linearIssueId}", input: { stateId: "${doneState.id}" }) { success } }`;
    const updateRes = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: updateMutation }),
    });
    const updateJson = await updateRes.json() as {
      data?: { issueUpdate?: { success: boolean } };
      errors?: Array<{ message: string }>;
    };

    if (!updateRes.ok || updateJson.errors || !updateJson.data?.issueUpdate?.success) {
      const errMsg = updateJson.errors?.[0]?.message ?? `HTTP ${updateRes.status}`;
      throw new Error(`Failed to update Linear issue to Done: ${errMsg}`);
    }
  }

  /**
   * Check PR merge status and, if merged, update the linked Linear issue
   * to its "Done" workflow state. Idempotent via SyncEvent.
   *
   * Caller should derive `linearIssueId` and `linearIssueKey` from the task's
   * `externalIssueRef`.
   *
   * @throws ProblemException if the Linear token is not configured.
   * @throws ProblemException if the PR check or Linear update fails.
   */
  async checkAndSync(input: {
    taskId: string;
    sessionId?: string;
    worktreePath: string;
    prNumber: number;
    prUrl: string;
    linearIssueId: string;
    linearIssueKey: string;
  }): Promise<{ merged: boolean; state: MergeState }> {
    const { taskId, sessionId, worktreePath, prNumber, prUrl, linearIssueId, linearIssueKey } = input;

    // Check merge status.
    const result = await this.checkMergeStatus(worktreePath, prNumber);

    if (!result.merged) {
      this.logger.debug(`PR #${prNumber} is ${result.state}; no completion sync needed`);
      return { merged: false, state: result.state };
    }

    // PR is merged — update Linear issue to Done. Idempotent via SyncEvent.
    const targetId = `done:${linearIssueId}:${prUrl}`;
    const existing = await this.syncEvents.getLastForAction(taskId, 'linear', 'update_status', targetId);
    if (existing?.status === 'succeeded') {
      this.logger.debug(`Linear status already updated for ${linearIssueKey} (task ${taskId})`);
      return { merged: true, state: 'merged' };
    }

    let record = await this.syncEvents.createOrReuse({
      taskId, sessionId, provider: 'linear', action: 'update_status', targetId,
    });
    if (record.status === 'succeeded') return { merged: true, state: 'merged' };
    if (record.status === 'failed') {
      record = await this.syncEvents.markRetryable(record.id);
    }
    if (record.status === 'pending' || record.status === 'retryable') {
      record = await this.syncEvents.markRunning(record.id);
    }

    try {
      await this.updateLinearToDone(linearIssueId);
      await this.syncEvents.markSucceeded(record.id, linearIssueId, prUrl);
      this.logger.log(`Linear issue ${linearIssueKey} marked as Done (PR #${prNumber} merged)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Linear completion sync failed for ${linearIssueKey}: ${msg}`);
      if (record.status === 'running' || record.status === 'pending' || record.status === 'retryable') {
        await this.syncEvents.markFailed(record.id, 'unknown_error', msg);
      }
      throw new ProblemException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Completion Sync Failed',
        `Failed to update Linear issue ${linearIssueKey} to Done.`,
      );
    }

    return { merged: true, state: 'merged' };
  }
}
