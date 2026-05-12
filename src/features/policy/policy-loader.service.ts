import { Injectable } from '@nestjs/common';
import { readFile, stat } from 'fs/promises';
import * as path from 'path';
import { AppConfigService } from '../../config/app-config.service';
import { ArcConfig, PolicyRule, TestCommandConfig } from './policy.types';

/** Loads, caches, and validates the arc.config.json policy file. */
@Injectable()
export class PolicyLoaderService {
  private cached?: { config: ArcConfig; mtimeMs: number; policyPath: string };

  constructor(private readonly config: AppConfigService) {}

  /**
   * Load arc.config.json from disk, using mtime-based caching.
   * @returns The parsed and validated ArcConfig.
   */
  async load(): Promise<ArcConfig> {
    const policyPath = this.resolvePolicyPath();
    const policyStat = await stat(policyPath);
    if (this.cached && this.cached.policyPath === policyPath && this.cached.mtimeMs === policyStat.mtimeMs) {
      return this.cached.config;
    }

    const raw = await readFile(policyPath, 'utf8');
    const parsed = JSON.parse(raw) as ArcConfig;
    this.validate(parsed);
    this.cached = { config: parsed, mtimeMs: policyStat.mtimeMs, policyPath };
    return parsed;
  }

  /** Look up a single test command config by ID. */
  async getTestCommand(commandId: string): Promise<TestCommandConfig | undefined> {
    const policy = await this.load();
    return policy.testCommands.find((command) => command.id === commandId);
  }

  /** Return all configured test commands. */
  async listTestCommands(): Promise<TestCommandConfig[]> {
    const policy = await this.load();
    return policy.testCommands;
  }

  /**
   * Resolve the approval timeout, preferring the policy file value over
   * the env-based fallback. Falls back silently on read errors.
   */
  async approvalTimeoutMs(fallbackMs: number): Promise<number> {
    try {
      const policy = await this.load();
      return policy.approval?.timeoutMs ?? fallbackMs;
    } catch {
      // Keep the env fallback so pending approvals still expire even if the
      // policy file is temporarily unreadable during timeout setup.
      return fallbackMs;
    }
  }

  /** Clear the cached policy config so the next load re-reads from disk. */
  clearCache(): void {
    this.cached = undefined;
  }

  /** Resolve the absolute path to the policy file. */
  private resolvePolicyPath(): string {
    return path.isAbsolute(this.config.policyPath)
      ? this.config.policyPath
      : path.join(this.config.repoPath, this.config.policyPath);
  }

  /** Validate the full ArcConfig shape, including all rules and test commands. */
  private validate(config: ArcConfig): void {
    if (config.version !== 1) {
      throw new Error('arc.config.json version must be 1');
    }
    if (!config.policy || !Array.isArray(config.policy.safe) || !Array.isArray(config.policy.needsApproval) || !Array.isArray(config.policy.blocked)) {
      throw new Error('arc.config.json must define policy.safe, policy.needsApproval, and policy.blocked arrays');
    }
    if (!Array.isArray(config.testCommands)) {
      throw new Error('arc.config.json must define testCommands');
    }
    if (config.approval?.timeoutMs !== undefined && (!Number.isInteger(config.approval.timeoutMs) || config.approval.timeoutMs <= 0)) {
      throw new Error('arc.config.json approval.timeoutMs must be a positive integer');
    }
    for (const rule of [...config.policy.safe, ...config.policy.needsApproval, ...config.policy.blocked]) {
      this.validateRule(rule);
    }
    for (const testCommand of config.testCommands) {
      if (
        typeof testCommand.id !== 'string' ||
        testCommand.id.trim().length === 0 ||
        typeof testCommand.label !== 'string' ||
        testCommand.label.trim().length === 0 ||
        !Array.isArray(testCommand.command) ||
        testCommand.command.length === 0
      ) {
        throw new Error('Each test command must include id, label, and a non-empty command array');
      }
      if (testCommand.command.some((part) => typeof part !== 'string' || part.length === 0)) {
        throw new Error(`Test command "${testCommand.id}" command entries must be non-empty strings`);
      }
      if (testCommand.cwd) {
        const normalizedCwd = path.posix.normalize(testCommand.cwd.replaceAll('\\', '/'));
        if (path.isAbsolute(testCommand.cwd) || normalizedCwd === '..' || normalizedCwd.startsWith('../')) {
          throw new Error(`Test command "${testCommand.id}" cwd must stay within the task worktree`);
        }
      }
      if (testCommand.timeoutMs !== undefined && (!Number.isInteger(testCommand.timeoutMs) || testCommand.timeoutMs <= 0)) {
        throw new Error(`Test command "${testCommand.id}" timeoutMs must be a positive integer`);
      }
    }
  }

  /** Validate an individual policy rule has an id and at least one matcher. */
  private validateRule(rule: PolicyRule): void {
    if (typeof rule.id !== 'string' || rule.id.trim().length === 0) {
      throw new Error('Policy rule id must be a non-empty string');
    }
    const hasMatcher =
      hasValues(rule.actionTypes) ||
      hasValues(rule.commandIds) ||
      hasValues(rule.commandIncludes) ||
      hasValues(rule.pathGlobs);
    if (!hasMatcher) {
      throw new Error(`Policy rule "${rule.id}" must include at least one matcher`);
    }
  }
}

/** Whether an array is defined and non-empty. */
function hasValues(values: string[] | undefined): boolean {
  return Array.isArray(values) && values.length > 0;
}
