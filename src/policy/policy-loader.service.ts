import { Injectable } from '@nestjs/common';
import { readFile, stat } from 'fs/promises';
import * as path from 'path';
import { AppConfigService } from '../config/app-config.service';
import { ArcConfig, PolicyRule, TestCommandConfig } from './policy.types';

@Injectable()
export class PolicyLoaderService {
  private cached?: { config: ArcConfig; mtimeMs: number; policyPath: string };

  constructor(private readonly config: AppConfigService) {}

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

  async getTestCommand(commandId: string): Promise<TestCommandConfig | undefined> {
    const policy = await this.load();
    return policy.testCommands.find((command) => command.id === commandId);
  }

  async listTestCommands(): Promise<TestCommandConfig[]> {
    const policy = await this.load();
    return policy.testCommands;
  }

  clearCache(): void {
    this.cached = undefined;
  }

  private resolvePolicyPath(): string {
    return path.isAbsolute(this.config.policyPath)
      ? this.config.policyPath
      : path.join(this.config.repoPath, this.config.policyPath);
  }

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
    for (const rule of [...config.policy.safe, ...config.policy.needsApproval, ...config.policy.blocked]) {
      this.validateRule(rule);
    }
    for (const testCommand of config.testCommands) {
      if (!testCommand.id || !Array.isArray(testCommand.command) || testCommand.command.length === 0) {
        throw new Error('Each test command must include id and a non-empty command array');
      }
      if (testCommand.command.some((part) => typeof part !== 'string' || part.length === 0)) {
        throw new Error(`Test command "${testCommand.id}" command entries must be non-empty strings`);
      }
      if (testCommand.timeoutMs !== undefined && (!Number.isInteger(testCommand.timeoutMs) || testCommand.timeoutMs <= 0)) {
        throw new Error(`Test command "${testCommand.id}" timeoutMs must be a positive integer`);
      }
    }
  }

  private validateRule(rule: PolicyRule): void {
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

function hasValues(values: string[] | undefined): boolean {
  return Array.isArray(values) && values.length > 0;
}
