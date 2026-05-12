import { GitHubProvider } from './github-provider';
import type { AppConfigService } from '../../config/app-config.service';

function mockConfig(overrides: Record<string, string | undefined> = {}) {
  const gitHubToken = 'token' in overrides ? overrides.token : 'ghp_test_valid_token_1234567890123456789012345678';
  const gitHubOwner = 'owner' in overrides ? overrides.owner : 'test-owner';
  const gitHubRepo = 'repo' in overrides ? overrides.repo : 'test-repo';
  return {
    gitHubToken,
    gitHubOwner,
    gitHubRepo,
  } as unknown as AppConfigService;
}

describe('GitHubProvider', () => {
  let provider: GitHubProvider;
  let fetchSpy: jest.SpyInstance;

  function mockFetch(status: number, body: unknown, ok?: boolean): void {
    fetchSpy.mockResolvedValueOnce({
      ok: ok ?? (status >= 200 && status < 300),
      status,
      json: () => Promise.resolve(body),
    });
  }

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation();
    provider = new GitHubProvider(mockConfig());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('isConfigured', () => {
    it('returns true when token, owner, and repo are set', () => {
      expect(provider.isConfigured()).toBe(true);
    });

    it('returns false when token is empty', () => {
      provider = new GitHubProvider(mockConfig({ token: '' }));
      expect(provider.isConfigured()).toBe(false);
    });

    it('returns false when owner is empty', () => {
      provider = new GitHubProvider(mockConfig({ owner: '' }));
      expect(provider.isConfigured()).toBe(false);
    });

    it('returns false when repo is empty', () => {
      provider = new GitHubProvider(mockConfig({ repo: '' }));
      expect(provider.isConfigured()).toBe(false);
    });
  });

  describe('searchIssues', () => {
    it('fetches from search/issues with correct query', async () => {
      mockFetch(200, {
        items: [
          { id: 1, number: 5, title: 'Bug', state: 'open', html_url: 'https://github.com/owner/repo/issues/5', labels: [{ name: 'bug' }], body: 'Body', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        ],
      });

      const results = await provider.searchIssues({ repo: 'owner/repo', query: 'bug', state: 'open' });

      expect(results).toHaveLength(1);
      expect(results[0].number).toBe(5);
      expect(results[0].title).toBe('Bug');
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/search/issues?q='),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer ghp_test_valid_token_1234567890123456789012345678' }) }),
      );
    });

    it('returns empty array on no results', async () => {
      mockFetch(200, { items: [] });

      const results = await provider.searchIssues({ repo: 'owner/repo', query: 'nonexistent' });
      expect(results).toHaveLength(0);
    });
  });

  describe('getIssue', () => {
    it('fetches a single issue by number', async () => {
      mockFetch(200, { id: 1, number: 42, title: 'The Answer', state: 'open', html_url: '', labels: [], body: '', created_at: '', updated_at: '' });

      const issue = await provider.getIssue('owner', 'repo', 42);
      expect(issue.title).toBe('The Answer');
      expect(issue.number).toBe(42);
    });
  });

  describe('createBranch', () => {
    it('fetches base ref SHA then creates new ref', async () => {
      mockFetch(200, { object: { sha: 'abc123' } });
      mockFetch(201, {});

      const result = await provider.createBranch({ owner: 'owner', repo: 'repo', branchName: 'feature/test', baseRef: 'main' });

      expect(result.status).toBe('succeeded');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('createOrUpdatePR', () => {
    it('creates a new draft PR', async () => {
      mockFetch(201, { number: 10, html_url: 'https://github.com/owner/repo/pull/10', title: 'Test PR', state: 'open', draft: true, merged_at: null, merge_commit_sha: null });

      const result = await provider.createOrUpdatePR({
        owner: 'owner', repo: 'repo', title: 'Test PR', body: 'Body', head: 'feature', base: 'main', draft: true,
      });

      expect(result.status).toBe('succeeded');
      expect(result.prInfo?.number).toBe(10);
      expect(result.prInfo?.draft).toBe(true);
    });

    it('updates existing PR when number is given', async () => {
      mockFetch(200, { number: 5, html_url: 'https://github.com/owner/repo/pull/5', title: 'Updated', state: 'open', draft: false, merged_at: null, merge_commit_sha: null });

      const result = await provider.createOrUpdatePR({
        owner: 'owner', repo: 'repo', title: 'Updated', body: 'New body', head: 'feature', base: 'main', existingPrNumber: 5,
      });

      expect(result.status).toBe('succeeded');
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/pulls/5'),
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  describe('getPR', () => {
    it('returns PR info', async () => {
      mockFetch(200, { number: 7, html_url: 'https://github.com/owner/repo/pull/7', title: 'PR 7', state: 'open', draft: false, merged_at: null, merge_commit_sha: null });

      const pr = await provider.getPR('owner', 'repo', 7);
      expect(pr.number).toBe(7);
      expect(pr.state).toBe('open');
    });

    it('detects merged state', async () => {
      mockFetch(200, { number: 8, html_url: '', title: '', state: 'closed', draft: false, merged_at: '2025-01-01T00:00:00Z', merge_commit_sha: 'def456' });

      const pr = await provider.getPR('owner', 'repo', 8);
      expect(pr.state).toBe('merged');
      expect(pr.mergeCommitSha).toBe('def456');
    });
  });

  describe('listBranches', () => {
    it('returns branch names', async () => {
      mockFetch(200, [{ name: 'main' }, { name: 'feature/test' }]);

      const branches = await provider.listBranches('owner', 'repo');
      expect(branches).toEqual(['main', 'feature/test']);
    });
  });

  describe('normalizeError', () => {
    it('maps 401 to auth_failed', () => {
      const error = new Error('Bad credentials');
      (error as any).status = 401;
      const result = provider.normalizeError(error);
      expect(result.category).toBe('auth_failed');
      expect(result.retryable).toBe(false);
    });

    it('maps 403 rate limit to rate_limited', () => {
      const error = new Error('API rate limit exceeded');
      (error as any).status = 403;
      const result = provider.normalizeError(error);
      expect(result.category).toBe('rate_limited');
      expect(result.retryable).toBe(true);
    });

    it('maps 404 to not_found', () => {
      const error = new Error('Not Found');
      (error as any).status = 404;
      const result = provider.normalizeError(error);
      expect(result.category).toBe('not_found');
    });

    it('maps 422 to validation_error', () => {
      const error = new Error('Validation Failed');
      (error as any).status = 422;
      const result = provider.normalizeError(error);
      expect(result.category).toBe('validation_error');
    });

    it('maps 500 to network_error retryable', () => {
      const error = new Error('Internal Server Error');
      (error as any).status = 500;
      const result = provider.normalizeError(error);
      expect(result.category).toBe('network_error');
      expect(result.retryable).toBe(true);
    });

    it('handles errors without status', () => {
      const result = provider.normalizeError(new Error('generic'));
      expect(result.category).toBe('unexpected');
    });
  });

  describe('API error handling', () => {
    it('throws on non-ok response with message from body', async () => {
      mockFetch(404, { message: 'Not Found' }, false);

      await expect(provider.getIssue('owner', 'repo', 999)).rejects.toThrow('Not Found');
    });

    it('throws on non-ok response with fallback message', async () => {
      mockFetch(500, 'not json', false);

      await expect(provider.getIssue('owner', 'repo', 1)).rejects.toThrow('GitHub API responded with 500');
    });
  });
});
