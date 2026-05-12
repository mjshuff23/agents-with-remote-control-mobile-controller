import { Injectable } from '@nestjs/common';
import type {
  ILinearProvider,
  LinearTeam,
  LinearWorkflowState,
  LinearIssue,
  LinearSearchParams,
  LinearCreateLinkParams,
} from './linear-provider.interface';
import type { ProviderActionResult, NormalizedProviderError } from './provider.types';

@Injectable()
export class MockLinearProvider implements ILinearProvider {
  readonly name = 'linear';

  private issues: LinearIssue[] = [];
  private teams: LinearTeam[] = [];
  private workflowStates: Map<string, LinearWorkflowState[]> = new Map();
  private links: Array<{ issueId: string; url: string }> = [];

  reset(): void {
    this.issues = [];
    this.teams = [];
    this.workflowStates.clear();
    this.links = [];
  }

  setIssues(issues: LinearIssue[]): void {
    this.issues = issues;
  }

  setTeams(teams: LinearTeam[]): void {
    this.teams = teams;
  }

  setWorkflowStates(teamId: string, states: LinearWorkflowState[]): void {
    this.workflowStates.set(teamId, states);
  }

  hasLink(issueId: string, url: string): boolean {
    return this.links.some((l) => l.issueId === issueId && l.url === url);
  }

  isConfigured(): boolean {
    return true;
  }

  async searchIssues(params: LinearSearchParams): Promise<LinearIssue[]> {
    let results = [...this.issues];
    if (params.query) {
      const q = params.query.toLowerCase();
      results = results.filter(
        (i) => i.title.toLowerCase().includes(q) || (i.description && i.description.toLowerCase().includes(q)),
      );
    }
    if (params.teamId) {
      results = results.filter((i) => i.teamId === params.teamId);
    }
    if (params.limit && results.length > params.limit) {
      results = results.slice(0, params.limit);
    }
    return results;
  }

  async getIssue(identifier: string): Promise<LinearIssue> {
    const issue = this.issues.find(
      (i) => i.identifier === identifier || i.id === identifier,
    );
    if (!issue) {
      throw new Error(`Linear issue ${identifier} not found in mock`);
    }
    return issue;
  }

  async getTeams(): Promise<LinearTeam[]> {
    return this.teams;
  }

  async getWorkflowStates(teamId: string): Promise<LinearWorkflowState[]> {
    return this.workflowStates.get(teamId) ?? [];
  }

  async updateIssueStatus(issueId: string, workflowStateId: string): Promise<ProviderActionResult> {
    const issue = this.issues.find((i) => i.id === issueId);
    if (issue) {
      issue.stateId = workflowStateId;
    }
    return {
      provider: 'linear',
      externalId: issueId,
      status: 'succeeded',
    };
  }

  async attachLink(params: LinearCreateLinkParams): Promise<ProviderActionResult> {
    this.links.push({ issueId: params.issueId, url: params.url });
    return {
      provider: 'linear',
      externalId: params.issueId,
      url: params.url,
      status: 'succeeded',
    };
  }

  normalizeError(error: unknown): NormalizedProviderError {
    return {
      category: 'unexpected',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}
