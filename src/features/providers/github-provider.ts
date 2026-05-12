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
import { AppConfigService } from '../../config/app-config.service';

const GITHUB_API = 'https://api.github.com';

interface GitHubErrorBody {
  message?: string;
  errors?: Array<{ message?: string }>;
}

@Injectable()
export class GitHubProvider implements IGitHubProvider {
  readonly name = 'github';
  private readonly token: string;
  private readonly defaultOwner: string;
  private readonly defaultRepo: string;

  constructor(private readonly config: AppConfigService) {
    this.token = config.gitHubToken ?? '';
    this.defaultOwner = config.gitHubOwner ?? '';
    this.defaultRepo = config.gitHubRepo ?? '';
  }

  isConfigured(): boolean {
    return this.token.length > 0 && this.defaultOwner.length > 0 && this.defaultRepo.length > 0;
  }

  private repo(owner?: string, repo?: string): { owner: string; repo: string } {
    return {
      owner: owner || this.defaultOwner,
      repo: repo || this.defaultRepo,
    };
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'arc-orchestrator',
    };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${GITHUB_API}${path}`, { headers: this.headers() });
    if (!res.ok) {
      throw await this.buildError(res);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${GITHUB_API}${path}`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw await this.buildError(res);
    }
    return res.json() as Promise<T>;
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${GITHUB_API}${path}`, {
      method: 'PATCH',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw await this.buildError(res);
    }
    return res.json() as Promise<T>;
  }

  private async buildError(res: Response): Promise<Error> {
    let body: GitHubErrorBody = {};
    try {
      body = (await res.json()) as GitHubErrorBody;
    } catch {
      // ignore parse errors
    }
    const msg = body.message || `GitHub API responded with ${res.status}`;
    const error = new Error(msg);
    (error as any).status = res.status;
    return error;
  }

  async searchIssues(params: GitHubSearchParams): Promise<GitHubSearchIssue[]> {
    const { owner, repo } = this.repo();
    const qParts: string[] = [`repo:${owner}/${repo}`];
    if (params.query) qParts.push(params.query);
    if (params.labels && params.labels.length > 0) {
      qParts.push(params.labels.map((l) => `label:${l}`).join(' '));
    }
    if (params.state && params.state !== 'all') {
      qParts.push(`state:${params.state}`);
    }
    const perPage = params.limit && params.limit > 0 ? Math.min(params.limit, 100) : 30;
    const data = await this.get<{ items: Array<Record<string, unknown>> }>(
      `/search/issues?q=${encodeURIComponent(qParts.join(' '))}&per_page=${perPage}&sort=created&order=desc`,
    );
    return data.items.map(normalizeGitHubIssue);
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubSearchIssue> {
    const r = this.repo(owner, repo);
    const data = await this.get<Record<string, unknown>>(`/repos/${r.owner}/${r.repo}/issues/${issueNumber}`);
    return normalizeGitHubIssue(data);
  }

  async createBranch(params: GitHubCreateBranchParams): Promise<ProviderActionResult> {
    const r = this.repo(params.owner, params.repo);
    const ref = await this.get<{ object: { sha: string } }>(
      `/repos/${r.owner}/${r.repo}/git/ref/heads/${encodeURIComponent(params.baseRef)}`,
    );
    await this.post<Record<string, unknown>>(`/repos/${r.owner}/${r.repo}/git/refs`, {
      ref: `refs/heads/${params.branchName}`,
      sha: ref.object.sha,
    });
    return { provider: 'github', status: 'succeeded' };
  }

  async createOrUpdatePR(
    params: GitHubCreateOrUpdatePrParams,
  ): Promise<ProviderActionResult & { prInfo?: GitHubPrInfo }> {
    const r = this.repo(params.owner, params.repo);

    if (params.existingPrNumber) {
      const data = await this.patch<Record<string, unknown>>(
        `/repos/${r.owner}/${r.repo}/pulls/${params.existingPrNumber}`,
        { title: params.title, body: params.body },
      );
      return {
        provider: 'github',
        externalId: String(data.number),
        url: (data.html_url as string) || (data.url as string),
        status: 'succeeded',
        prInfo: normalizeGitHubPr(data),
      };
    }

    const data = await this.post<Record<string, unknown>>(`/repos/${r.owner}/${r.repo}/pulls`, {
      title: params.title,
      body: params.body,
      head: params.head,
      base: params.base,
      draft: params.draft ?? true,
    });
    return {
      provider: 'github',
      externalId: String(data.number),
      url: (data.html_url as string) || (data.url as string),
      status: 'succeeded',
      prInfo: normalizeGitHubPr(data),
    };
  }

  async getPR(owner: string, repo: string, prNumber: number): Promise<GitHubPrInfo> {
    const r = this.repo(owner, repo);
    const data = await this.get<Record<string, unknown>>(`/repos/${r.owner}/${r.repo}/pulls/${prNumber}`);
    return normalizeGitHubPr(data);
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const r = this.repo(owner, repo);
    const data = await this.get<Array<{ name: string }>>(`/repos/${r.owner}/${r.repo}/branches?per_page=100`);
    return data.map((b) => b.name);
  }

  normalizeError(error: unknown): NormalizedProviderError {
    const msg = error instanceof Error ? error.message : String(error);
    const status = error instanceof Error && 'status' in error ? (error as any).status : undefined;

    if (status === 401 || status === 403) {
      const isRateLimit = msg.toLowerCase().includes('rate limit');
      return {
        category: isRateLimit ? 'rate_limited' : 'auth_failed',
        message: isRateLimit ? 'GitHub API rate limit exceeded' : 'GitHub authentication failed. Check your token.',
        retryable: isRateLimit,
        statusCode: status,
      };
    }
    if (status === 404) {
      return { category: 'not_found', message: msg, retryable: false, statusCode: status };
    }
    if (status === 409) {
      return { category: 'conflict', message: msg, retryable: true, statusCode: status };
    }
    if (status === 422) {
      return { category: 'validation_error', message: msg, retryable: false, statusCode: status };
    }
    if (status && status >= 500) {
      return { category: 'network_error', message: 'GitHub API server error', retryable: true, statusCode: status };
    }
    return { category: 'unexpected', message: msg, retryable: false, statusCode: status };
  }
}

function normalizeGitHubIssue(data: Record<string, unknown>): GitHubSearchIssue {
  return {
    id: data.id as number,
    number: data.number as number,
    title: data.title as string,
    state: (data.state as string) as 'open' | 'closed',
    url: (data.html_url as string) || '',
    labels: ((data.labels as Array<Record<string, unknown>>) || []).map((l) => (l.name as string) || ''),
    body: (data.body as string) || '',
    createdAt: (data.created_at as string) || '',
    updatedAt: (data.updated_at as string) || '',
  };
}

function normalizeGitHubPr(data: Record<string, unknown>): GitHubPrInfo {
  const mergedAt = data.merged_at as string | null;
  const state = data.merged_at ? 'merged' : ((data.state as string) === 'closed' ? 'closed' : 'open');
  return {
    number: data.number as number,
    url: (data.html_url as string) || '',
    title: (data.title as string) || '',
    state: state as 'open' | 'closed' | 'merged',
    mergedAt: mergedAt || undefined,
    mergeCommitSha: (data.merge_commit_sha as string) || undefined,
    draft: (data.draft as boolean) || false,
  };
}
