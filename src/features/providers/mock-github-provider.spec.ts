import { MockGitHubProvider } from './mock-github-provider';
import type { GitHubSearchIssue } from './github-provider.interface';

describe('MockGitHubProvider', () => {
  let provider: MockGitHubProvider;

  beforeEach(() => {
    provider = new MockGitHubProvider();
  });

  describe('isConfigured', () => {
    it('returns true', () => {
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('searchIssues', () => {
    const issues: GitHubSearchIssue[] = [
      { id: 1, number: 5, title: 'Bug: login fails', state: 'open', url: 'https://github.com/owner/repo/issues/5', labels: ['bug'], body: 'Login fails on empty input', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
      { id: 2, number: 6, title: 'Add dark mode', state: 'open', url: 'https://github.com/owner/repo/issues/6', labels: ['enhancement'], body: 'Implement dark mode', createdAt: '2025-01-02T00:00:00Z', updatedAt: '2025-01-02T00:00:00Z' },
      { id: 3, number: 7, title: 'Closed issue', state: 'closed', url: 'https://github.com/owner/repo/issues/7', labels: [], body: 'Already done', createdAt: '2025-01-03T00:00:00Z', updatedAt: '2025-01-03T00:00:00Z' },
    ];

    beforeEach(() => {
      provider.setIssues(issues);
    });

    it('returns all issues when no filters', async () => {
      const results = await provider.searchIssues({ repo: 'owner/repo' });
      expect(results).toHaveLength(3);
    });

    it('filters by query (title match)', async () => {
      const results = await provider.searchIssues({ repo: 'owner/repo', query: 'login' });
      expect(results).toHaveLength(1);
      expect(results[0].number).toBe(5);
    });

    it('filters by query (body match)', async () => {
      const results = await provider.searchIssues({ repo: 'owner/repo', query: 'dark mode' });
      expect(results).toHaveLength(1);
      expect(results[0].number).toBe(6);
    });

    it('filters by state', async () => {
      const results = await provider.searchIssues({ repo: 'owner/repo', state: 'closed' });
      expect(results).toHaveLength(1);
      expect(results[0].number).toBe(7);
    });

    it('filters by labels', async () => {
      const results = await provider.searchIssues({ repo: 'owner/repo', labels: ['bug'] });
      expect(results).toHaveLength(1);
      expect(results[0].number).toBe(5);
    });

    it('respects limit', async () => {
      const results = await provider.searchIssues({ repo: 'owner/repo', limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('returns empty array for no match', async () => {
      const results = await provider.searchIssues({ repo: 'owner/repo', query: 'nonexistent' });
      expect(results).toHaveLength(0);
    });
  });

  describe('getIssue', () => {
    it('returns issue by number', async () => {
      provider.setIssues([{ id: 1, number: 5, title: 'Test', state: 'open', url: '', labels: [], body: '', createdAt: '', updatedAt: '' }]);
      const issue = await provider.getIssue('owner', 'repo', 5);
      expect(issue.title).toBe('Test');
    });

    it('throws when not found', async () => {
      await expect(provider.getIssue('owner', 'repo', 999)).rejects.toThrow('not found');
    });
  });

  describe('createBranch', () => {
    it('records branch creation', async () => {
      const result = await provider.createBranch({ owner: 'owner', repo: 'repo', branchName: 'agent/TSH-107-test', baseRef: 'main' });
      expect(result.status).toBe('succeeded');
      expect(provider.hasBranch('agent/TSH-107-test')).toBe(true);
    });
  });

  describe('createOrUpdatePR', () => {
    it('creates a new draft PR', async () => {
      const result = await provider.createOrUpdatePR({
        owner: 'owner', repo: 'repo', title: 'Test PR', body: 'Body', head: 'branch', base: 'main', draft: true,
      });
      expect(result.status).toBe('succeeded');
      expect(result.prInfo).toBeDefined();
      expect(result.prInfo!.draft).toBe(true);
      expect(result.prInfo!.state).toBe('open');
    });

    it('updates an existing PR when existingPrNumber is given', async () => {
      const created = await provider.createOrUpdatePR({
        owner: 'owner', repo: 'repo', title: 'Original', body: 'Body', head: 'branch', base: 'main',
      });
      const updated = await provider.createOrUpdatePR({
        owner: 'owner', repo: 'repo', title: 'Updated Title', body: 'Updated body', head: 'branch', base: 'main',
        existingPrNumber: created.prInfo!.number,
      });
      expect(updated.status).toBe('succeeded');
      expect(updated.prInfo!.title).toBe('Updated Title');
    });
  });

  describe('getPR', () => {
    it('returns existing PR', async () => {
      await provider.createOrUpdatePR({ owner: 'owner', repo: 'repo', title: 'PR', body: '', head: 'b', base: 'main' });
      const pr = await provider.getPR('owner', 'repo', 1);
      expect(pr.title).toBe('PR');
    });

    it('throws when PR does not exist', async () => {
      await expect(provider.getPR('owner', 'repo', 999)).rejects.toThrow('not found');
    });
  });

  describe('listBranches', () => {
    it('returns created branches', async () => {
      await provider.createBranch({ owner: 'owner', repo: 'repo', branchName: 'b1', baseRef: 'main' });
      await provider.createBranch({ owner: 'owner', repo: 'repo', branchName: 'b2', baseRef: 'main' });
      const branches = await provider.listBranches('owner', 'repo');
      expect(branches).toEqual(expect.arrayContaining(['b1', 'b2']));
    });
  });

  describe('normalizeError', () => {
    it('handles Error objects', () => {
      const result = provider.normalizeError(new Error('test error'));
      expect(result.category).toBe('unexpected');
      expect(result.message).toBe('test error');
    });

    it('handles string errors', () => {
      const result = provider.normalizeError('crash');
      expect(result.message).toBe('crash');
    });
  });

  describe('reset', () => {
    it('clears all stored state', async () => {
      provider.setIssues([{ id: 1, number: 5, title: 'Test', state: 'open', url: '', labels: [], body: '', createdAt: '', updatedAt: '' }]);
      await provider.createBranch({ owner: 'owner', repo: 'repo', branchName: 'b1', baseRef: 'main' });
      provider.reset();
      expect(provider.getIssueCount()).toBe(0);
      expect(provider.hasBranch('b1')).toBe(false);
    });
  });
});
