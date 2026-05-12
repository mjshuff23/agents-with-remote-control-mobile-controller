import { buildBranchName, withCollisionSuffix, slugify } from './branch-namer';
import type { ExternalIssueRef } from '../providers/provider.types';

const githubRef: ExternalIssueRef = { provider: 'github', externalId: '42', key: '#42', url: 'https://github.com/o/r/issues/42', title: 'Fix login bug' };
const linearRef: ExternalIssueRef = { provider: 'linear', externalId: 'uuid-1', key: 'TSH-98', title: 'Define Linear access model' };

describe('buildBranchName', () => {
  describe('issue-linked strategy', () => {
    it('produces agent/<provider>-<key>-<slug> for a GitHub issue', () => {
      const { branchName, strategy } = buildBranchName({
        taskId: 'task-1',
        title: 'Fix login bug',
        prompt: 'ignored',
        externalIssueRef: githubRef,
      });
      // key '#42' slugifies to '42' (# is non-alphanumeric)
      expect(branchName).toBe('agent/github-42-fix-login-bug');
      expect(strategy).toBe('issue-linked');
    });

    it('produces agent/<provider>-<key>-<slug> for a Linear issue', () => {
      const { branchName, strategy } = buildBranchName({
        taskId: 'task-1',
        title: 'Define Linear access model',
        prompt: 'ignored',
        externalIssueRef: linearRef,
      });
      expect(branchName).toBe('agent/linear-tsh-98-define-linear-access-model');
      expect(strategy).toBe('issue-linked');
    });

    it('uses prompt when title is absent', () => {
      const { branchName } = buildBranchName({
        taskId: 'task-1',
        prompt: 'Add dark mode support',
        externalIssueRef: linearRef,
      });
      expect(branchName).toContain('add-dark-mode-support');
    });

    it('falls back to taskId slug when title and prompt are empty', () => {
      const { branchName } = buildBranchName({
        taskId: 'task-abc',
        prompt: '',
        externalIssueRef: linearRef,
      });
      expect(branchName).toContain('task-abc');
    });
  });

  describe('task-id fallback strategy', () => {
    it('produces agent/<taskId>-<slug> when no issue ref', () => {
      const { branchName, strategy } = buildBranchName({
        taskId: 'task-123',
        title: 'Add Approval Cards',
        prompt: 'ignored',
      });
      expect(branchName).toBe('agent/task-123-add-approval-cards');
      expect(strategy).toBe('task-id');
    });

    it('produces agent/<taskId>-<slug> when externalIssueRef is null', () => {
      const { branchName } = buildBranchName({
        taskId: 'task-123',
        title: 'Demo',
        prompt: 'ignored',
        externalIssueRef: null,
      });
      expect(branchName).toBe('agent/task-123-demo');
    });
  });

  describe('length limits', () => {
    it('caps the branch suffix at 60 characters after agent/', () => {
      const longTitle = 'a'.repeat(200);
      const { branchName } = buildBranchName({ taskId: 'task-1', title: longTitle, prompt: '' });
      expect(branchName.length).toBeLessThanOrEqual('agent/'.length + 60);
    });

    it('caps issue-linked branch suffix at 60 characters', () => {
      const longTitle = 'b'.repeat(200);
      const { branchName } = buildBranchName({ taskId: 't', title: longTitle, prompt: '', externalIssueRef: linearRef });
      expect(branchName.length).toBeLessThanOrEqual('agent/'.length + 60);
    });

    it('does not end with a dash after truncation', () => {
      const { branchName } = buildBranchName({ taskId: 'task-1', title: 'a'.repeat(200), prompt: '' });
      expect(branchName).not.toMatch(/-$/);
    });
  });
});

describe('withCollisionSuffix', () => {
  it('appends -2 for the first collision', () => {
    expect(withCollisionSuffix('agent/github-tsh-1-fix-bug', 2)).toBe('agent/github-tsh-1-fix-bug-2');
  });

  it('appends -3 for the second collision', () => {
    expect(withCollisionSuffix('agent/github-tsh-1-fix-bug', 3)).toBe('agent/github-tsh-1-fix-bug-3');
  });

  it('clamps index to minimum 2', () => {
    expect(withCollisionSuffix('agent/foo', 0)).toBe('agent/foo-2');
    expect(withCollisionSuffix('agent/foo', 1)).toBe('agent/foo-2');
  });

  it('result stays within total branch length limit', () => {
    const long = 'agent/' + 'x'.repeat(60);
    const result = withCollisionSuffix(long, 99);
    expect(result.slice('agent/'.length).length).toBeLessThanOrEqual(60);
  });
});

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric with dashes', () => {
    // consecutive non-alphanumeric chars collapse to a single dash
    expect(slugify('Fix: Login Bug!')).toBe('fix-login-bug');
  });

  it('collapses consecutive separators', () => {
    // Multiple non-alphanumeric chars become a single dash
    expect(slugify('hello   world')).toBe('hello-world');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('caps at 40 characters', () => {
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(40);
  });

  it('returns "task" for empty or all-special input', () => {
    expect(slugify('')).toBe('task');
    expect(slugify('!!!---')).toBe('task');
  });
});
