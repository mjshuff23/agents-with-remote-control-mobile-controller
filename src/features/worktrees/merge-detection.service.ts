import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProblemException } from '../../common/errors/problem.exception';
import { AppConfigService } from '../../config/app-config.service';
import { SyncEventService } from '../sync/sync-event.service';

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 30_000;
const LINEAR_TIMEOUT_MS = 10_000;

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
      const env = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(this.config.gitHubToken ? { GITHUB_TOKEN: this.config.gitHubToken } : {}),
      };

      const { stdout } = await execFileAsync('gh', [
        'pr', 'view', String(prNumber),
        '--json', 'state,mergeCommit,mergedAt',
      ], {
        cwd: worktreePath,
        timeout: GH_TIMEOUT_MS,
        env,
      });

      const data = JSON.parse(stdout) as {
        state: string;
        mergeCommit: { oid: string } | null;
        mergedAt: string | null;
      };

      const rawState = (data.state ?? '').toUpperCase();
      let state: MergeState;
      if (rawState === 'MERGED') {
        state = 'merged';
      } else if (rawState === 'CLOSED') {
        state = 'closed';
      } else {
        state = 'open';
      }

      return {
        prNumber,
        state,
        merged: state === 'merged',
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

  /** Execute a single Linear GraphQL call with timeouts and variables support. */
  private async linearQuery<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const token = this.config.linearToken;
    if (!token) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Linear Not Configured',
        'ARC_LINEAR_TOKEN is not set. Configure it to enable Linear completion sync.',
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LINEAR_TIMEOUT_MS);

    try {
      const res = await fetch(LINEAR_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(variables ? { query, variables } : { query }),
        signal: controller.signal,
      });
      const json = await res.json() as T & { errors?: Array<{ message: string }> };
      if (json.errors) {
        throw new Error(json.errors[0]?.message ?? 'Unknown Linear API error');
      }
      return json;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Linear API timed out after ${LINEAR_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fetch a Linear issue to determine its team, then find the
   * team's "completed" workflow state ID and update the issue to it.
   */
  private async updateLinearToDone(linearIssueId: string): Promise<void> {
    // Step 1: Get the issue to find its team.
    const issueRes = await this.linearQuery<{
      data?: { issue?: { id: string; team: { id: string } } };
    }>(
      'query ($id: String!) { issue(id: $id) { id team { id } } }',
      { id: linearIssueId },
    );

    if (!issueRes.data?.issue) {
      throw new Error(`Failed to fetch Linear issue ${linearIssueId}`);
    }

    const teamId = issueRes.data.issue.team.id;

    // Step 2: Get workflow states for the team and find the "completed" one.
    const statesRes = await this.linearQuery<{
      data?: { workflowStates?: { nodes: Array<{ id: string; name: string; type: string }> } };
    }>(
      'query ($teamId: String!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } } }',
      { teamId },
    );

    const doneState = statesRes.data?.workflowStates?.nodes.find((s) => s.type === 'completed');
    if (!doneState) {
      throw new Error('No completed workflow state found for the Linear team.');
    }

    // Step 3: Update the issue to the done state.
    const updateRes = await this.linearQuery<{
      data?: { issueUpdate?: { success: boolean } };
    }>(
      'mutation ($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
      { id: linearIssueId, stateId: doneState.id },
    );

    if (!updateRes.data?.issueUpdate?.success) {
      throw new Error('Linear issueUpdate returned success: false');
    }
  }

  /**
   * Check PR merge status and, if merged, update the linked Linear issue
   * to its "Done" workflow state. Idempotent via SyncEvent.
   *
   * @throws ProblemException(422) if the Linear token is not configured.
   * @throws ProblemException(500) if the PR check or Linear update fails.
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

    // Fail fast on missing Linear config before creating any SyncEvent.
    if (!this.config.linearToken) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Linear Not Configured',
        'ARC_LINEAR_TOKEN is not set. Configure it to enable Linear completion sync.',
      );
    }

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
