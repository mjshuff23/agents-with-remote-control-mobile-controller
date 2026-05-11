import { Injectable } from '@nestjs/common';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { AppConfigService } from '../config/app-config.service';
import { ArcConfig, TestCommandConfig } from './policy.types';

@Injectable()
export class PolicyLoaderService {
  private cached?: ArcConfig;

  constructor(private readonly config: AppConfigService) {}

  async load(): Promise<ArcConfig> {
    if (this.cached) {
      return this.cached;
    }

    const policyPath = path.isAbsolute(this.config.policyPath)
      ? this.config.policyPath
      : path.join(this.config.repoPath, this.config.policyPath);
    const raw = await readFile(policyPath, 'utf8');
    const parsed = JSON.parse(raw) as ArcConfig;
    this.validate(parsed);
    this.cached = parsed;
    return parsed;
  }

  async getTestCommand(commandId: string): Promise<TestCommandConfig | undefined> {
    const policy = await this.load();
    return policy.testCommands.find((command) => command.id === commandId);
  }

  clearCache(): void {
    this.cached = undefined;
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
    for (const testCommand of config.testCommands) {
      if (!testCommand.id || !Array.isArray(testCommand.command) || testCommand.command.length === 0) {
        throw new Error('Each test command must include id and a non-empty command array');
      }
    }
  }
}
