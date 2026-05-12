import { MockLinearProvider } from './mock-linear-provider';
import type { LinearIssue, LinearTeam, LinearWorkflowState } from './linear-provider.interface';

describe('MockLinearProvider', () => {
  let provider: MockLinearProvider;

  beforeEach(() => {
    provider = new MockLinearProvider();
  });

  describe('isConfigured', () => {
    it('returns true', () => {
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('searchIssues', () => {
    const issues: LinearIssue[] = [
      { id: 'issue-1', identifier: 'TSH-1', title: 'Bug: login fails', stateId: 'state-1', url: 'https://linear.app/team/issue/TSH-1', teamId: 'team-1', labels: ['bug'], description: 'Login fails on empty input' },
      { id: 'issue-2', identifier: 'TSH-2', title: 'Add dark mode', stateId: 'state-1', url: 'https://linear.app/team/issue/TSH-2', teamId: 'team-1', labels: ['enhancement'], description: 'Implement dark mode' },
      { id: 'issue-3', identifier: 'TSH-3', title: 'Done issue', stateId: 'state-3', url: 'https://linear.app/team/issue/TSH-3', teamId: 'team-2', labels: [], description: 'Already done' },
    ];

    beforeEach(() => {
      provider.setIssues(issues);
    });

    it('returns all issues when no filters', async () => {
      const results = await provider.searchIssues({});
      expect(results).toHaveLength(3);
    });

    it('filters by query (title match)', async () => {
      const results = await provider.searchIssues({ query: 'login' });
      expect(results).toHaveLength(1);
      expect(results[0].identifier).toBe('TSH-1');
    });

    it('filters by query (description match)', async () => {
      const results = await provider.searchIssues({ query: 'dark mode' });
      expect(results).toHaveLength(1);
      expect(results[0].identifier).toBe('TSH-2');
    });

    it('filters by teamId', async () => {
      const results = await provider.searchIssues({ teamId: 'team-2' });
      expect(results).toHaveLength(1);
      expect(results[0].identifier).toBe('TSH-3');
    });

    it('respects limit', async () => {
      const results = await provider.searchIssues({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('returns empty array for no match', async () => {
      const results = await provider.searchIssues({ query: 'nonexistent' });
      expect(results).toHaveLength(0);
    });

    it('respects limit of 0 returning empty array', async () => {
      const results = await provider.searchIssues({ limit: 0 });
      expect(results).toHaveLength(0);
    });
  });

  describe('getIssue', () => {
    it('returns issue by identifier', async () => {
      provider.setIssues([{ id: 'i-1', identifier: 'TSH-1', title: 'Test', url: '', teamId: 't-1', labels: [] }]);
      const issue = await provider.getIssue('TSH-1');
      expect(issue.title).toBe('Test');
    });

    it('returns issue by id', async () => {
      provider.setIssues([{ id: 'i-1', identifier: 'TSH-1', title: 'Test', url: '', teamId: 't-1', labels: [] }]);
      const issue = await provider.getIssue('i-1');
      expect(issue.title).toBe('Test');
    });

    it('throws when not found', async () => {
      await expect(provider.getIssue('NONEXISTENT')).rejects.toThrow('not found');
    });
  });

  describe('getTeams', () => {
    it('returns configured teams', async () => {
      const teams: LinearTeam[] = [{ id: 't-1', name: 'Team A', key: 'TSH' }];
      provider.setTeams(teams);
      const result = await provider.getTeams();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Team A');
    });

    it('returns empty array when no teams configured', async () => {
      const result = await provider.getTeams();
      expect(result).toHaveLength(0);
    });
  });

  describe('getWorkflowStates', () => {
    it('returns configured states for a team', async () => {
      const states: LinearWorkflowState[] = [
        { id: 's-1', name: 'Todo', type: 'unstarted', position: 1 },
        { id: 's-2', name: 'In Progress', type: 'started', position: 2 },
      ];
      provider.setWorkflowStates('team-1', states);
      const result = await provider.getWorkflowStates('team-1');
      expect(result).toHaveLength(2);
    });

    it('returns empty array for unknown team', async () => {
      const result = await provider.getWorkflowStates('unknown-team');
      expect(result).toHaveLength(0);
    });
  });

  describe('updateIssueStatus', () => {
    it('updates stateId on matching issue', async () => {
      provider.setIssues([{ id: 'i-1', identifier: 'TSH-1', title: 'Test', teamId: 't-1', labels: [], url: '' }]);
      const result = await provider.updateIssueStatus('i-1', 'state-done');
      expect(result.status).toBe('succeeded');
      const issue = await provider.getIssue('i-1');
      expect(issue.stateId).toBe('state-done');
    });

    it('returns failure for non-existent issue', async () => {
      const result = await provider.updateIssueStatus('nonexistent-id', 'state-done');
      expect(result.status).toBe('failed');
      expect(result.errorCategory).toBe('not_found');
    });
  });

  describe('attachLink', () => {
    it('records the link', async () => {
      const result = await provider.attachLink({ issueId: 'i-1', url: 'https://github.com/pr/1', label: 'PR #1' });
      expect(result.status).toBe('succeeded');
      expect(provider.hasLink('i-1', 'https://github.com/pr/1')).toBe(true);
    });
  });

  describe('normalizeError', () => {
    it('handles Error objects', () => {
      const result = provider.normalizeError(new Error('test error'));
      expect(result.category).toBe('unexpected');
      expect(result.message).toBe('test error');
      expect(result.retryable).toBe(false);
    });

    it('handles string errors', () => {
      const result = provider.normalizeError('crash');
      expect(result.message).toBe('crash');
    });

    it('extracts statusCode from error when present', () => {
      const error = new Error('Unauthorized');
      (error as any).status = 401;
      const result = provider.normalizeError(error);
      expect(result.statusCode).toBe(401);
    });
  });

  describe('reset', () => {
    it('clears all stored state', async () => {
      provider.setIssues([{ id: 'i-1', identifier: 'TSH-1', title: 'Test', teamId: 't-1', labels: [], url: '' }]);
      provider.setTeams([{ id: 't-1', name: 'Team', key: 'TSH' }]);
      await provider.attachLink({ issueId: 'i-1', url: 'https://pr.com/1', label: 'PR' });
      provider.reset();
      const issues = await provider.searchIssues({});
      expect(issues).toHaveLength(0);
      const teams = await provider.getTeams();
      expect(teams).toHaveLength(0);
      expect(provider.hasLink('i-1', 'https://pr.com/1')).toBe(false);
    });
  });
});
