import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RunnerMode } from './env.validation';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  get host(): string {
    return this.config.getOrThrow<string>('ARC_HOST');
  }

  get port(): number {
    return this.config.getOrThrow<number>('ARC_PORT');
  }

  get repoPath(): string {
    return this.config.getOrThrow<string>('ARC_REPO_PATH');
  }

  get runnerMode(): RunnerMode {
    return this.config.getOrThrow<RunnerMode>('ARC_RUNNER_MODE');
  }

  get codexCommand(): string {
    return this.config.getOrThrow<string>('ARC_CODEX_COMMAND');
  }

  get codexArgs(): string[] {
    return this.config.getOrThrow<string[]>('ARC_CODEX_ARGS');
  }

  get codexEnvKeys(): string[] {
    return this.config.getOrThrow<string[]>('ARC_CODEX_ENV_KEYS');
  }

  get wslCommand(): string {
    return this.config.getOrThrow<string>('ARC_WSL_COMMAND');
  }

  get wslDistro(): string | undefined {
    return this.emptyToUndefined(this.config.get<string>('ARC_WSL_DISTRO'));
  }

  get wslUser(): string | undefined {
    return this.emptyToUndefined(this.config.get<string>('ARC_WSL_USER'));
  }

  get logTailLimit(): number {
    return this.config.getOrThrow<number>('ARC_LOG_TAIL_LIMIT');
  }

  get shutdownGraceMs(): number {
    return this.config.getOrThrow<number>('ARC_SHUTDOWN_GRACE_MS');
  }

  get worktreeRoot(): string | undefined {
    return this.emptyToUndefined(this.config.get<string>('ARC_WORKTREE_ROOT'));
  }

  get policyPath(): string {
    return this.config.getOrThrow<string>('ARC_POLICY_PATH');
  }

  get approvalTimeoutMs(): number {
    return this.config.getOrThrow<number>('ARC_APPROVAL_TIMEOUT_MS');
  }

  get controllerSecret(): string | undefined {
    return this.emptyToUndefined(this.config.get<string>('CONTROLLER_SECRET'));
  }

  private emptyToUndefined(value: string | undefined): string | undefined {
    return value && value.trim().length > 0 ? value : undefined;
  }
}
