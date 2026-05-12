import { LinearProvider } from './linear-provider';
import type { AppConfigService } from '../../config/app-config.service';

function mockConfig(token = 'lin_api_test_token'): AppConfigService {
  return { linearToken: token } as unknown as AppConfigService;
}

describe('LinearProvider', () => {
  let provider: LinearProvider;
  let fetchSpy: jest.SpyInstance;

  function mockGql(body: unknown, ok = true, status = 200): void {
    fetchSpy.mockResolvedValueOnce({
      ok,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation();
    provider = new LinearProvider(mockConfig());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('isConfigured', () => {
    it('returns true when token is set', () => {
      expect(provider.isConfigured()).toBe(true);
    });

    it('returns false when token is empty', () => {
      expect(new LinearProvider(mockConfig('')).isConfigured()).toBe(false);
    });
  });

  describe('searchIssues', () => {
    it('uses searchIssues query when text query provided', async () => {
      mockGql({ data: { searchIssues: { nodes: [rawIssue()] } } });
      const results = await provider.searchIssues({ query: 'login bug' });
      expect(results).toHaveLength(1);
      expect(results[0].identifier).toBe('TSH-1');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.query).toContain('searchIssues');
    });

    it('uses issues query when no text query', async () => {
      mockGql({ data: { issues: { nodes: [rawIssue()] } } });
      const results = await provider.searchIssues({ teamId: 'team-1' });
      expect(results).toHaveLength(1);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.query).toContain('issues(');
    });

    it('filters by teamId client-side when using searchIssues', async () => {
      const issue1 = rawIssue({ teamId: 'team-1' });
      const issue2 = rawIssue({ id: 'i-2', identifier: 'TSH-2', teamId: 'team-2' });
      mockGql({ data: { searchIssues: { nodes: [issue1, issue2] } } });
      const results = await provider.searchIssues({ query: 'bug', teamId: 'team-1' });
      expect(results).toHaveLength(1);
      expect(results[0].teamId).toBe('team-1');
    });
  });

  describe('getIssue', () => {
    it('fetches issue by identifier', async () => {
      mockGql({ data: { issue: rawIssue() } });
      const issue = await provider.getIssue('TSH-1');
      expect(issue.identifier).toBe('TSH-1');
      expect(issue.title).toBe('Test Issue');
    });
  });

  describe('getTeams', () => {
    it('returns team list', async () => {
      mockGql({ data: { teams: { nodes: [{ id: 't-1', name: 'Team Side Hustle', key: 'TSH' }] } } });
      const teams = await provider.getTeams();
      expect(teams).toHaveLength(1);
      expect(teams[0].key).toBe('TSH');
    });
  });

  describe('getWorkflowStates', () => {
    it('returns workflow states for a team', async () => {
      mockGql({
        data: {
          workflowStates: {
            nodes: [
              { id: 's-1', name: 'Todo', type: 'unstarted', position: 0 },
              { id: 's-2', name: 'In Progress', type: 'started', position: 1 },
            ],
          },
        },
      });
      const states = await provider.getWorkflowStates('team-1');
      expect(states).toHaveLength(2);
      expect(states[1].type).toBe('started');
    });
  });

  describe('updateIssueStatus', () => {
    it('calls issueUpdate mutation and returns succeeded', async () => {
      mockGql({ data: { issueUpdate: { success: true } } });
      const result = await provider.updateIssueStatus('issue-id', 'state-id');
      expect(result.status).toBe('succeeded');
      expect(result.provider).toBe('linear');
    });
  });

  describe('attachLink', () => {
    it('calls attachmentLinkURL mutation and returns succeeded', async () => {
      mockGql({ data: { attachmentLinkURL: { success: true } } });
      const result = await provider.attachLink({ issueId: 'i-1', url: 'https://github.com/pr/1', label: 'PR #1' });
      expect(result.status).toBe('succeeded');
      expect(result.url).toBe('https://github.com/pr/1');
    });
  });

  describe('error handling', () => {
    it('throws on non-ok HTTP response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve('Unauthorized') });
      await expect(provider.getTeams()).rejects.toThrow('401');
    });

    it('throws on GraphQL errors in response body', async () => {
      mockGql({ errors: [{ message: 'Entity not found' }] });
      await expect(provider.getIssue('NONEXISTENT')).rejects.toThrow('Entity not found');
    });
  });

  describe('normalizeError', () => {
    it('maps 401 to auth_failed', () => {
      const err = Object.assign(new Error('Unauthorized'), { status: 401 });
      expect(provider.normalizeError(err)).toMatchObject({ category: 'auth_failed', retryable: false });
    });

    it('maps 429 to rate_limited retryable', () => {
      const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
      expect(provider.normalizeError(err)).toMatchObject({ category: 'rate_limited', retryable: true });
    });

    it('maps 404 to not_found', () => {
      const err = Object.assign(new Error('Not Found'), { status: 404 });
      expect(provider.normalizeError(err)).toMatchObject({ category: 'not_found', retryable: false });
    });

    it('maps 500 to network_error retryable', () => {
      const err = Object.assign(new Error('Server Error'), { status: 500 });
      expect(provider.normalizeError(err)).toMatchObject({ category: 'network_error', retryable: true });
    });

    it('maps GraphQL error message to validation_error', () => {
      const err = new Error('Linear GraphQL error: bad input');
      expect(provider.normalizeError(err)).toMatchObject({ category: 'validation_error', retryable: false });
    });

    it('maps network errors (no status) to network_error retryable', () => {
      expect(provider.normalizeError(new Error('fetch failed'))).toMatchObject({ category: 'network_error', retryable: true });
    });
  });
});

function rawIssue(overrides: Partial<{
  id: string; identifier: string; title: string; teamId: string;
}> = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? 'i-1',
    identifier: overrides.identifier ?? 'TSH-1',
    title: overrides.title ?? 'Test Issue',
    description: 'A test issue',
    url: 'https://linear.app/team/issue/TSH-1',
    teamId: overrides.teamId ?? 'team-1',
    state: { id: 'state-1' },
    labels: { nodes: [{ name: 'bug' }] },
  };
}
