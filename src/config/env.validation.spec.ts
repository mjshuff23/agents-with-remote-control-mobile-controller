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
});
