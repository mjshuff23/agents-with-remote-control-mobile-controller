import type { ProviderActionResult, NormalizedProviderError } from './provider.types';

export const IGitHubProvider = Symbol('IGitHubProvider');

export interface GitHubSearchIssue {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  url: string;
  labels: string[];
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubSearchParams {
  repo: string;
  query?: string;
  labels?: string[];
  state?: 'open' | 'closed' | 'all';
  limit?: number;
}

export interface GitHubCreateBranchParams {
  owner: string;
  repo: string;
  branchName: string;
  baseRef: string;
}

export interface GitHubCreateOrUpdatePrParams {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
  existingPrNumber?: number;
}

export interface GitHubPrInfo {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  mergedAt?: string;
  mergeCommitSha?: string;
  draft: boolean;
}

export interface IGitHubProvider {
  readonly name: 'github';
  isConfigured(): boolean;
  searchIssues(params: GitHubSearchParams): Promise<GitHubSearchIssue[]>;
  getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubSearchIssue>;
  createBranch(params: GitHubCreateBranchParams): Promise<ProviderActionResult>;
  createOrUpdatePR(params: GitHubCreateOrUpdatePrParams): Promise<ProviderActionResult & { prInfo?: GitHubPrInfo }>;
  getPR(owner: string, repo: string, prNumber: number): Promise<GitHubPrInfo>;
  listBranches(owner: string, repo: string): Promise<string[]>;
  normalizeError(error: unknown): NormalizedProviderError;
}
