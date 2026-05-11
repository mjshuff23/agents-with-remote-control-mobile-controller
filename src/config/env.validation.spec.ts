import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const base = {
    ARC_REPO_PATH: '/repo',
    DATABASE_URL: 'file:./data/test.sqlite'
  };

  it('passes CONTROLLER_SECRET through when provided', () => {
    const result = validateEnv({ ...base, CONTROLLER_SECRET: 'my-secret' });
    expect(result['CONTROLLER_SECRET']).toBe('my-secret');
  });

  it('sets CONTROLLER_SECRET to undefined when absent (gateway enforces auth)', () => {
    const result = validateEnv({ ...base });
    // CONTROLLER_SECRET is optional at config level; the WS gateway rejects
    // all connections when the secret is falsy, so leaving it unset blocks WS entirely.
    expect(result['CONTROLLER_SECRET']).toBeFalsy();
  });

  it('adds --ignore-user-config to Codex exec args by default', () => {
    const result = validateEnv({ ...base });
    expect(result['ARC_CODEX_ARGS']).toEqual(['exec', '--ignore-user-config', '--json', '--cd', '{repoPath}', '-']);
  });

  it('preserves Codex user config when explicitly requested', () => {
    const result = validateEnv({ ...base, ARC_CODEX_IGNORE_USER_CONFIG: 'false' });
    expect(result['ARC_CODEX_ARGS']).toEqual(['exec', '--json', '--cd', '{repoPath}', '-']);
  });

  it('does not duplicate an explicit --ignore-user-config arg', () => {
    const result = validateEnv({
      ...base,
      ARC_CODEX_ARGS_JSON: '["exec","--ignore-user-config","--json","--cd","{repoPath}","-"]'
    });
    expect(result['ARC_CODEX_ARGS']).toEqual(['exec', '--ignore-user-config', '--json', '--cd', '{repoPath}', '-']);
  });
});
