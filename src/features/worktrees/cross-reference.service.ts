import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ProblemException } from '../../common/errors/problem.exception';
import { AppConfigService } from '../../config/app-config.service';
import { SyncEventService } from '../sync/sync-event.service';

export interface CrossReferenceInput {
  taskId: string;
  sessionId?: string;
  /** The PR URL to attach. */
  prUrl: string;
  /** The PR number for reference. */
  prNumber: number;
  /** Linear issue internal ID (UUID), stored in task.externalIssueRef.externalId. */
  linearIssueId: string;
  /** Linear issue key (e.g. TSH-105) for display. */
  linearIssueKey: string;
}

const LINEAR_API_URL = 'https://api.linear.app/graphql';

/**
 * Bidirectional cross-reference sync between GitHub PRs and Linear issues.
 *
 * Two directions:
 * 1. PR body already includes Linear issue ref (handled by PrGeneratorService).
 * 2. Linear issue gets PR URL as a link attachment (implemented here).
 *
 * Both paths are idempotent via SyncEvent. The idempotency key includes
 * both the Linear issue ID and the PR URL so that attaching a different
 * PR URL to the same issue is treated as a new action.
 */
@Injectable()
export class CrossReferenceService {
  private readonly logger = new Logger(CrossReferenceService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly syncEvents: SyncEventService,
  ) {}

  /**
   * Build the SyncEvent targetId from the Linear issue ID and PR URL
   * so a different URL for the same issue is a distinct action.
   */
  private syncTargetId(linearIssueId: string, prUrl: string): string {
    return `${linearIssueId}:${prUrl}`;
  }

  /**
   * Attach the PR URL as a link on the Linear issue via the
   * `attachmentCreate` GraphQL mutation. Idempotent via SyncEvent.
   */
  async syncPrToLinear(input: CrossReferenceInput): Promise<void> {
    const { taskId, sessionId, prUrl, prNumber, linearIssueId, linearIssueKey } = input;
    const targetId = this.syncTargetId(linearIssueId, prUrl);

    // Idempotency: skip if this exact PR URL was already attached.
    const existing = await this.syncEvents.getLastForAction(taskId, 'linear', 'attach_pr_url', targetId);
    if (existing?.status === 'succeeded') {
      this.logger.debug(`Linear attachment already exists for ${linearIssueKey} (task ${taskId})`);
      return;
    }

    const token = this.config.linearToken;
    if (!token) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Linear Not Configured',
        'ARC_LINEAR_TOKEN is not set. Configure it to enable Linear cross-reference sync.',
      );
    }

    // Record SyncEvent as running.
    let record = await this.syncEvents.createOrReuse({
      taskId, sessionId, provider: 'linear', action: 'attach_pr_url', targetId,
    });

    // Handle all non-terminal states so the SyncEvent lifecycle can complete.
    if (record.status === 'succeeded') {
      // Race: another caller finished between getLastForAction and createOrReuse.
      return;
    }
    if (record.status === 'failed') {
      record = await this.syncEvents.markRetryable(record.id);
    }
    if (record.status === 'pending' || record.status === 'retryable') {
      record = await this.syncEvents.markRunning(record.id);
    }

    // Execute Linear GraphQL mutation.
    try {
      const response = await fetch(LINEAR_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: `
            mutation($issueId: String!, $url: String!, $title: String!) {
              attachmentCreate(input: {
                issueId: $issueId,
                url: $url,
                title: $title
              }) {
                success
                attachment { id }
              }
            }
          `,
          variables: {
            issueId: linearIssueId,
            url: prUrl,
            title: `PR #${prNumber} — ${linearIssueKey}`,
          },
        }),
      });

      const json = await response.json() as { data?: { attachmentCreate?: { success: boolean; attachment?: { id: string } } }; errors?: Array<{ message: string }> };

      if (!response.ok || json.errors) {
        const errMsg = json.errors?.[0]?.message ?? `HTTP ${response.status}`;
        throw new Error(errMsg);
      }

      if (!json.data?.attachmentCreate?.success) {
        throw new Error('Linear attachmentCreate returned success: false');
      }

      const attachmentId = json.data.attachmentCreate.attachment?.id;
      await this.syncEvents.markSucceeded(record.id, attachmentId, prUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Linear attachmentCreate failed for ${linearIssueKey}: ${msg}`);
      if (record.status === 'running' || record.status === 'pending' || record.status === 'retryable') {
        await this.syncEvents.markFailed(record.id, 'unknown_error', msg);
      }
      throw new ProblemException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Cross-Reference Sync Failed',
        `Failed to attach PR URL to Linear issue ${linearIssueKey}.`,
      );
    }
  }
}
