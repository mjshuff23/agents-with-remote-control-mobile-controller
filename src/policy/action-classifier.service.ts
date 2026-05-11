import { Injectable } from '@nestjs/common';
import { AgentActionRequest, ClassificationResult, PolicyRule } from './policy.types';
import { PolicyLoaderService } from './policy-loader.service';

@Injectable()
export class ActionClassifierService {
  constructor(private readonly policies: PolicyLoaderService) {}

  async classify(request: AgentActionRequest): Promise<ClassificationResult> {
    const config = await this.policies.load();

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
      const commandText = (request.command ?? []).join(' ').toLowerCase();
      if (!rule.commandIncludes.every((piece) => commandText.includes(piece.toLowerCase()))) {
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
}

function globMatches(glob: string, value: string): boolean {
  const normalized = value.replaceAll('\\', '/').replace(/^\.?\//, '');
  const escaped = glob
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*');
  return new RegExp(`(^|/)${escaped}$`).test(normalized);
}
