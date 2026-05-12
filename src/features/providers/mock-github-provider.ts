import { Injectable } from '@nestjs/common';
import type {
  IGitHubProvider,
  GitHubSearchIssue,
  GitHubSearchParams,
  GitHubCreateBranchParams,
  GitHubCreateOrUpdatePrParams,
  GitHubPrInfo,
} from './github-provider.interface';
import type { ProviderActionResult, NormalizedProviderError } from './provider.types';

@Injectable()
export class MockGitHubProvider implements IGitHubProvider {
  readonly name = 'github';

  private issues: GitHubSearchIssue[] = [];
  private branches: Map<string, boolean> = new Map();
  private prs: Map<number, GitHubPrInfo> = new Map();
  private prCounter = 0;

  reset(): void {
    this.issues = [];
    this.branches.clear();
    this.prs.clear();
    this.prCounter = 0;
  }

  setIssues(issues: GitHubSearchIssue[]): void {
    this.issues = issues;
  }

  getIssueCount(): number {
    return this.issues.length;
  }

  hasBranch(name: string): boolean {
    return this.branches.has(name);
  }

  getPrNumber(): number {
    return this.prCounter;
  }

  isConfigured(): boolean {
    return true;
  }

  async searchIssues(params: GitHubSearchParams): Promise<GitHubSearchIssue[]> {
    let results = [...this.issues];
    if (params.query) {
      const q = params.query.toLowerCase();
      results = results.filter(
        (i) => i.title.toLowerCase().includes(q) || i.body.toLowerCase().includes(q),
      );
    }
    if (params.state && params.state !== 'all') {
      results = results.filter((i) => i.state === params.state);
    }
    if (params.labels && params.labels.length > 0) {
      results = results.filter((i) => params.labels!.some((l) => i.labels.includes(l)));
    }
    if (params.limit && results.length > params.limit) {
      results = results.slice(0, params.limit);
    }
    return results;
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubSearchIssue> {
    const issue = this.issues.find((i) => i.number === issueNumber);
    if (!issue) {
      throw new Error(`GitHub issue ${owner}/${repo}#${issueNumber} not found in mock`);
    }
    return issue;
  }

  async createBranch(params: GitHubCreateBranchParams): Promise<ProviderActionResult> {
    this.branches.set(params.branchName, true);
    return {
      provider: 'github',
      status: 'succeeded',
    };
  }

  async createOrUpdatePR(
    params: GitHubCreateOrUpdatePrParams,
  ): Promise<ProviderActionResult & { prInfo?: GitHubPrInfo }> {
    if (params.existingPrNumber) {
      const existing = this.prs.get(params.existingPrNumber);
      if (existing) {
        const updated: GitHubPrInfo = {
          ...existing,
          title: params.title,
        };
        this.prs.set(params.existingPrNumber, updated);
        return {
          provider: 'github',
          externalId: String(params.existingPrNumber),
          url: `https://github.com/${params.owner}/${params.repo}/pulls/${params.existingPrNumber}`,
          status: 'succeeded',
          prInfo: updated,
        };
      }
    }

    this.prCounter += 1;
    const prInfo: GitHubPrInfo = {
      number: this.prCounter,
      url: `https://github.com/${params.owner}/${params.repo}/pulls/${this.prCounter}`,
      title: params.title,
      state: 'open',
      draft: params.draft ?? true,
    };
    this.prs.set(this.prCounter, prInfo);
    return {
      provider: 'github',
      externalId: String(this.prCounter),
      url: prInfo.url,
      status: 'succeeded',
      prInfo,
    };
  }

  async getPR(owner: string, repo: string, prNumber: number): Promise<GitHubPrInfo> {
    const pr = this.prs.get(prNumber);
    if (!pr) {
      throw new Error(`GitHub PR ${owner}/${repo}#${prNumber} not found in mock`);
    }
    return pr;
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    return Array.from(this.branches.keys());
  }

  normalizeError(error: unknown): NormalizedProviderError {
    return {
      category: 'unexpected',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}
