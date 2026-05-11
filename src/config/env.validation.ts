export type RunnerMode = 'local' | 'wsl';

export const DEFAULT_DATABASE_URL = 'file:./prisma/data/arc.sqlite';

type RawEnv = Record<string, unknown>;

const readString = (config: RawEnv, key: string, defaultValue?: string): string => {
  const value = config[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (defaultValue !== undefined) {
    return defaultValue;
  }
  throw new Error(`${key} is required`);
};

const readOptionalString = (config: RawEnv, key: string, defaultValue = ''): string => {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : defaultValue;
};

const readNumber = (config: RawEnv, key: string, defaultValue: number): number => {
  const value = config[key];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return parsed;
};

const readPositiveNumber = (config: RawEnv, key: string, defaultValue: number): number => {
  const parsed = readNumber(config, key, defaultValue);
  if (parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
};

const readBoolean = (config: RawEnv, key: string, defaultValue = false): boolean => {
  const value = config[key];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return String(value).toLowerCase() === 'true';
};

const readStringList = (config: RawEnv, key: string, defaultValue = ''): string[] => {
  const raw = readOptionalString(config, key, defaultValue);
  if (raw.length === 0) {
    return [];
  }
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
};

const readCodexArgs = (config: RawEnv): string[] => {
  const raw = readString(config, 'ARC_CODEX_ARGS_JSON', '["exec","--json","--cd","{repoPath}","-"]');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('ARC_CODEX_ARGS_JSON must be a JSON string array');
  }

  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('ARC_CODEX_ARGS_JSON must be a JSON string array');
  }

  const args = [...(parsed as string[])];
  if (
    readBoolean(config, 'ARC_CODEX_IGNORE_USER_CONFIG', true) &&
    args[0] === 'exec' &&
    !args.includes('--ignore-user-config')
  ) {
    args.splice(1, 0, '--ignore-user-config');
  }

  return args;
};

export function validateEnv(config: RawEnv): Record<string, unknown> {
  const host = readString(config, 'ARC_HOST', '127.0.0.1');
  const publicBindAllowed = readBoolean(config, 'ARC_ALLOW_PUBLIC_BIND', false);

  if ((host === '0.0.0.0' || host === '::') && !publicBindAllowed) {
    throw new Error('ARC_HOST must stay local-only unless ARC_ALLOW_PUBLIC_BIND=true is set');
  }

  const runnerMode = readString(config, 'ARC_RUNNER_MODE', 'local');
  if (runnerMode !== 'local' && runnerMode !== 'wsl') {
    throw new Error('ARC_RUNNER_MODE must be either local or wsl');
  }

  return {
    ...config,
    DATABASE_URL: readString(config, 'DATABASE_URL', DEFAULT_DATABASE_URL),
    ARC_HOST: host,
    ARC_PORT: readNumber(config, 'ARC_PORT', 3000),
    ARC_REPO_PATH: readString(config, 'ARC_REPO_PATH'),
    ARC_RUNNER_MODE: runnerMode,
    ARC_CODEX_IGNORE_USER_CONFIG: readBoolean(config, 'ARC_CODEX_IGNORE_USER_CONFIG', true),
    ARC_CODEX_COMMAND: readString(config, 'ARC_CODEX_COMMAND', 'codex'),
    ARC_CODEX_ARGS: readCodexArgs(config),
    ARC_CODEX_ENV_KEYS: readStringList(config, 'ARC_CODEX_ENV_KEYS'),
    ARC_WSL_COMMAND: readString(config, 'ARC_WSL_COMMAND', 'wsl.exe'),
    ARC_WSL_DISTRO: readOptionalString(config, 'ARC_WSL_DISTRO'),
    ARC_WSL_USER: readOptionalString(config, 'ARC_WSL_USER'),
    ARC_LOG_TAIL_LIMIT: readNumber(config, 'ARC_LOG_TAIL_LIMIT', 200),
    ARC_SHUTDOWN_GRACE_MS: readNumber(config, 'ARC_SHUTDOWN_GRACE_MS', 2000),
    ARC_WORKTREE_ROOT: readOptionalString(config, 'ARC_WORKTREE_ROOT'),
    ARC_POLICY_PATH: readString(config, 'ARC_POLICY_PATH', 'arc.config.json'),
    ARC_APPROVAL_TIMEOUT_MS: readPositiveNumber(config, 'ARC_APPROVAL_TIMEOUT_MS', 300000),
    ARC_TEST_COMMAND_TIMEOUT_MS: readPositiveNumber(config, 'ARC_TEST_COMMAND_TIMEOUT_MS', 600000),
    CONTROLLER_SECRET: readOptionalString(config, 'CONTROLLER_SECRET')
  };
}
