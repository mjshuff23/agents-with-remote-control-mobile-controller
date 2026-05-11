import { Injectable } from '@nestjs/common';
import { AgentActionRequest, ClassificationResult, PolicyRule } from './policy.types';
import { PolicyLoaderService } from './policy-loader.service';

@Injectable()
export class ActionClassifierService {
  constructor(private readonly policies: PolicyLoaderService) {}

  async classify(request: AgentActionRequest): Promise<ClassificationResult> {
    const config = await this.policies.load();

    const semanticBlocked = this.semanticBlockedRule(config.policy.blocked, request);
    if (semanticBlocked) {
      return {
        riskLevel: 'BLOCKED',
        ruleMatched: semanticBlocked.id,
        rationale: semanticBlocked.rationale
      };
    }

    const blocked = config.policy.blocked.find((rule) => this.matchesRule(rule, request));
    if (blocked) {
      return {
        riskLevel: 'BLOCKED',
        ruleMatched: blocked.id,
        rationale: blocked.rationale
      };
    }

    const safe = config.policy.safe.find((rule) => this.matchesRule(rule, request));
    if (safe) {
      return {
        riskLevel: 'SAFE',
        ruleMatched: safe.id,
        rationale: safe.rationale
      };
    }

    const needsApproval = config.policy.needsApproval.find((rule) => this.matchesRule(rule, request));
    if (needsApproval) {
      return {
        riskLevel: 'NEEDS_APPROVAL',
        ruleMatched: needsApproval.id,
        rationale: needsApproval.rationale
      };
    }

    return {
      riskLevel: 'NEEDS_APPROVAL',
      ruleMatched: 'default.unknown',
      rationale: 'Unknown actions default to human approval.'
    };
  }

  private matchesRule(rule: PolicyRule, request: AgentActionRequest): boolean {
    if (rule.actionTypes && !rule.actionTypes.includes(request.actionType)) {
      return false;
    }

    if (rule.commandIds && (!request.commandId || !rule.commandIds.includes(request.commandId))) {
      return false;
    }

    if (rule.commandIncludes) {
      if (!commandIncludesAll(request.command ?? [], rule.commandIncludes)) {
        return false;
      }
    }

    if (rule.pathGlobs) {
      const files = request.files ?? [];
      if (!files.some((file) => rule.pathGlobs?.some((glob) => globMatches(glob, file)))) {
        return false;
      }
    }

    return true;
  }

  private semanticBlockedRule(rules: PolicyRule[], request: AgentActionRequest): PolicyRule | undefined {
    const tokens = commandTokens(request.command ?? []);

    const forcePushRuleId = forcePushBlockedRuleId(tokens);
    if (forcePushRuleId) {
      return findRule(rules, forcePushRuleId);
    }
    if (isPipeFromInternetToInterpreter(tokens)) {
      return findRule(rules, 'internet.pipe_shell') ?? findRule(rules, 'internet.pipe_bash');
    }
    if (isProductionDeploy(tokens)) {
      return findRule(rules, 'production.deploy');
    }
    if (isGlobalConfigEdit(tokens)) {
      return findRule(rules, 'global.config');
    }
    if (isOutsideWorktreeDelete(request, tokens)) {
      return findRule(rules, 'outside.worktree.delete');
    }

    return undefined;
  }
}

function globMatches(glob: string, value: string): boolean {
  const globSegments = normalizePath(glob).split('/').filter(Boolean);
  const valueSegments = normalizePath(value).split('/').filter(Boolean);
  if (globSegments.length === 1) {
    return valueSegments.some((segment) => segmentMatches(globSegments[0], segment));
  }
  return matchSegments(globSegments, valueSegments, 0, 0, new Map<string, boolean>());
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.?\//, '');
}

function matchSegments(globSegments: string[], valueSegments: string[], gi: number, vi: number, memo: Map<string, boolean>): boolean {
  const key = `${gi}:${vi}`;
  const cached = memo.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const globSegment = globSegments[gi];
  let result: boolean;
  if (globSegment === undefined) {
    result = vi === valueSegments.length;
  } else if (globSegment === '**') {
    result =
      matchSegments(globSegments, valueSegments, gi + 1, vi, memo) ||
      (vi < valueSegments.length && matchSegments(globSegments, valueSegments, gi, vi + 1, memo));
  } else {
    result = vi < valueSegments.length && segmentMatches(globSegment, valueSegments[vi]) &&
      matchSegments(globSegments, valueSegments, gi + 1, vi + 1, memo);
  }
  memo.set(key, result);
  return result;
}

function segmentMatches(globSegment: string, valueSegment: string): boolean {
  return wildcardMatches(globSegment, valueSegment, 0, 0, new Map<string, boolean>());
}

function wildcardMatches(pattern: string, value: string, pi: number, vi: number, memo: Map<string, boolean>): boolean {
  const key = `${pi}:${vi}`;
  const cached = memo.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const char = pattern[pi];
  let result: boolean;
  if (char === undefined) {
    result = vi === value.length;
  } else if (char === '*') {
    result =
      wildcardMatches(pattern, value, pi + 1, vi, memo) ||
      (vi < value.length && wildcardMatches(pattern, value, pi, vi + 1, memo));
  } else {
    result = value[vi] === char && wildcardMatches(pattern, value, pi + 1, vi + 1, memo);
  }
  memo.set(key, result);
  return result;
}

function commandIncludesAll(command: string[], pieces: string[]): boolean {
  const tokens = commandTokens(command);
  return pieces.every((piece) => tokens.some((token) => commandPieceMatches(token, piece.toLowerCase())));
}

function commandTokens(command: string[]): string[] {
  const argv = command.map((part) => part.trim().toLowerCase()).filter(Boolean);
  const shellText = shellCommandText(argv);
  return shellText ? argv.concat(tokenizeShellCommandText(shellText)) : argv;
}

function shellCommandText(argv: string[]): string | undefined {
  const shellIndex = argv.findIndex((token) => {
    const executable = token.split(/[\\/]/).pop() ?? token;
    return ['sh', 'bash', 'zsh', 'dash'].includes(executable);
  });
  if (shellIndex === -1) {
    return undefined;
  }
  const commandFlagIndex = argv.findIndex((token, index) => index > shellIndex && isShellCommandFlag(token));
  return commandFlagIndex === -1 ? undefined : argv[commandFlagIndex + 1];
}

function isShellCommandFlag(token: string): boolean {
  return token === '--command' || /^-[a-z]*c[a-z]*$/.test(token);
}

function tokenizeShellCommandText(text: string): string[] {
  return text
    .replaceAll('|', ' | ')
    .replaceAll('&', ' & ')
    .replaceAll(';', ' ; ')
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function commandPieceMatches(token: string, piece: string): boolean {
  if (piece === '..') {
    return token === '..' || token.startsWith('../') || token.includes('/../');
  }
  if (piece.startsWith('--')) {
    return token === piece || token.startsWith(`${piece}=`);
  }
  return token === piece;
}

function findRule(rules: PolicyRule[], id: string): PolicyRule | undefined {
  return rules.find((rule) => rule.id === id);
}

function forcePushBlockedRuleId(tokens: string[]): 'git.force_push' | 'git.force_push_with_lease' | undefined {
  if (!tokens.includes('git') || !tokens.includes('push')) {
    return undefined;
  }
  if (tokens.some((token) => token === '--force-with-lease' || token.startsWith('--force-with-lease='))) {
    return 'git.force_push_with_lease';
  }
  if (tokens.some((token) => token === '--force' || token.startsWith('--force='))) {
    return 'git.force_push';
  }
  return undefined;
}

function isPipeFromInternetToInterpreter(tokens: string[]): boolean {
  const pipeIndex = tokens.indexOf('|');
  if (pipeIndex === -1 || !tokens.some(isInternetFetcher)) {
    return false;
  }
  return tokens.slice(pipeIndex + 1).some(isShellOrInterpreter);
}

function isInternetFetcher(token: string): boolean {
  return ['curl', 'wget', 'http', 'https'].includes(executableName(token));
}

function isShellOrInterpreter(token: string): boolean {
  return ['sh', 'bash', 'zsh', 'dash', 'python', 'python3', 'node', 'ruby', 'perl', 'pwsh', 'powershell'].includes(executableName(token));
}

function isProductionDeploy(tokens: string[]): boolean {
  return tokens.includes('deploy') && tokens.some((token) => ['--prod', '--production', 'prod', 'production'].includes(token));
}

function isGlobalConfigEdit(tokens: string[]): boolean {
  return tokens.includes('config') && tokens.some((token) => token === '--global' || token.startsWith('--global='));
}

function isOutsideWorktreeDelete(request: AgentActionRequest, tokens: string[]): boolean {
  if (request.actionType === 'fs.delete' && (request.files ?? []).some(isOutsideWorktreePath)) {
    return true;
  }
  if (tokens.includes('rm') && tokens.some(isRecursiveForceFlag)) {
    return tokens.some(isDangerousDeleteTarget);
  }
  if (tokens.includes('find') && tokens.includes('-delete')) {
    return tokens.some(isDangerousDeleteTarget);
  }
  return false;
}

function isRecursiveForceFlag(token: string): boolean {
  return token === '-rf' || token === '-fr' || /^-[a-z]*r[a-z]*f[a-z]*$/.test(token) || /^-[a-z]*f[a-z]*r[a-z]*$/.test(token);
}

function isDangerousDeleteTarget(token: string): boolean {
  if (!token || token.startsWith('-') || ['rm', 'find', '-delete'].includes(token)) {
    return false;
  }
  return isOutsideWorktreePath(token);
}

function isOutsideWorktreePath(value: string): boolean {
  const lower = value.toLowerCase();
  const normalized = normalizePath(value);
  return lower === '/' ||
    lower.startsWith('/') ||
    lower === '~' ||
    lower.startsWith('~/') ||
    lower === '$home' ||
    lower.startsWith('$home/') ||
    lower === '${home}' ||
    lower.startsWith('${home}/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../');
}

function executableName(token: string): string {
  return token.split(/[\\/]/).pop() ?? token;
}
