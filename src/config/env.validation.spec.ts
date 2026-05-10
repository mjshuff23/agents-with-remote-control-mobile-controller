import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const base = {
    ARC_REPO_PATH: '/repo',
    DATABASE_URL: 'file:./data/test.sqlite'
  };

  it('accepts an optional CONTROLLER_SECRET', () => {
    const result = validateEnv({ ...base, CONTROLLER_SECRET: 'my-secret' });
    expect(result['CONTROLLER_SECRET']).toBe('my-secret');
  });

  it('sets CONTROLLER_SECRET to empty string when absent', () => {
    const result = validateEnv({ ...base });
    expect(result['CONTROLLER_SECRET']).toBe('');
  });
});
