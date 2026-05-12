import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RunnerMode } from './env.validation';

/** Typed wrapper around NestJS ConfigService for application settings. */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  /** Server host to bind to (e.g. 127.0.0.1). */
  get host(): string {
    return this.config.getOrThrow<string>('ARC_HOST');
  }

  /** Server port (default 3000). */
  get port(): number {
    return this.config.getOrThrow<number>('ARC_PORT');
  }

  /** Absolute path to the repository the orchestrator manages. */
  get repoPath(): string {
    return this.config.getOrThrow<string>('ARC_REPO_PATH');
  }

  /** Agent runner mode: local or wsl. */
  get runnerMode(): RunnerMode {
    return this.config.getOrThrow<RunnerMode>('ARC_RUNNER_MODE');
  }

  /** Path to the Codex (or other agent) binary. */
  get codexCommand(): string {
    return this.config.getOrThrow<string>('ARC_CODEX_COMMAND');
  }

  /** CLI argument list to pass to the agent. */
  get codexArgs(): string[] {
    return this.config.getOrThrow<string[]>('ARC_CODEX_ARGS');
  }

  /** Environment variable keys forwarded from the host to the agent process. */
  get codexEnvKeys(): string[] {
    return this.config.getOrThrow<string[]>('ARC_CODEX_ENV_KEYS');
  }

  /** WSL launcher command (e.g. wsl.exe). */
  get wslCommand(): string {
    return this.config.getOrThrow<string>('ARC_WSL_COMMAND');
  }

  /** WSL distro name, if any. */
  get wslDistro(): string | undefined {
    return this.emptyToUndefined(this.config.get<string>('ARC_WSL_DISTRO'));
  }

  /** WSL user name, if any. */
  get wslUser(): string | undefined {
    return this.emptyToUndefined(this.config.get<string>('ARC_WSL_USER'));
  }

  /** Maximum number of log lines to tail per fetch. */
  get logTailLimit(): number {
    return this.config.getOrThrow<number>('ARC_LOG_TAIL_LIMIT');
  }

  /** Grace period (ms) before forceful shutdown. */
  get shutdownGraceMs(): number {
    return this.config.getOrThrow<number>('ARC_SHUTDOWN_GRACE_MS');
  }

  /** Root directory for git worktrees, if configured. */
  get worktreeRoot(): string | undefined {
    return this.emptyToUndefined(this.config.get<string>('ARC_WORKTREE_ROOT'));
  }

  /** Path to the arc.config.json policy file. */
  get policyPath(): string {
    return this.config.getOrThrow<string>('ARC_POLICY_PATH');
  }

  /** Default timeout (ms) before an approval request expires. */
  get approvalTimeoutMs(): number {
    return this.config.getOrThrow<number>('ARC_APPROVAL_TIMEOUT_MS');
  }

  /** Default timeout (ms) for test command execution. */
  get testCommandTimeoutMs(): number {
    return this.config.getOrThrow<number>('ARC_TEST_COMMAND_TIMEOUT_MS');
  }

  /** Idle timeout (ms) before a session transitions to dormant (default 30 min). */
  get dormantTimeoutMs(): number {
    return this.config.getOrThrow<number>('ARC_DORMANT_TIMEOUT_MS');
  }

  /** How often (ms) to scan for idle sessions eligible for dormancy (default 60s). */
  get dormantCheckIntervalMs(): number {
    return this.config.getOrThrow<number>('ARC_DORMANT_CHECK_INTERVAL_MS');
  }

  /** Shared secret for controller API authentication, or undefined. */
  get controllerSecret(): string | undefined {
    return this.emptyToUndefined(this.config.get<string>('CONTROLLER_SECRET'));
  }

  /** GitHub fine-grained PAT for API access. */
  get gitHubToken(): string | undefined {
    return this.emptyToUndefined(this.config.get<string>('ARC_GITHUB_TOKEN'));
  }

  /** Default GitHub owner/org for API requests. */
  get gitHubOwner(): string | undefined {
    return this.emptyToUndefined(this.config.get<string>('ARC_GITHUB_OWNER'));
  }

  /** Default GitHub repository name for API requests. */
  get gitHubRepo(): string | undefined {
    return this.emptyToUndefined(this.config.get<string>('ARC_GITHUB_REPO'));
  }

  /** Linear personal API key for issue sync. */
  get linearToken(): string | undefined {
    return this.emptyToUndefined(this.config.get<string>('ARC_LINEAR_TOKEN'));
  }

  /** Return undefined for empty or whitespace-only strings. */
  private emptyToUndefined(value: string | undefined): string | undefined {
    return value && value.trim().length > 0 ? value : undefined;
  }
}
