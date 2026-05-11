export type RiskLevel = 'SAFE' | 'NEEDS_APPROVAL' | 'BLOCKED';
export type ApprovalDecision = 'approved' | 'denied' | 'expired' | 'refused' | 'auto_allow';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'refused';

export interface PolicyRule {
  id: string;
  actionTypes?: string[];
  commandIds?: string[];
  commandIncludes?: string[];
  pathGlobs?: string[];
  rationale: string;
}

export interface TestCommandConfig {
  id: string;
  label: string;
  cwd?: string;
  command: string[];
}

export interface ArcConfig {
  version: number;
  approval?: {
    timeoutMs?: number;
  };
  policy: {
    safe: PolicyRule[];
    needsApproval: PolicyRule[];
    blocked: PolicyRule[];
  };
  testCommands: TestCommandConfig[];
}

export interface AgentActionRequest {
  id: string;
  actionType: string;
  riskLevel?: RiskLevel;
  title: string;
  rationale?: string;
  command?: string[];
  commandId?: string;
  files?: string[];
  expectedEffect?: string;
}

export interface ClassificationResult {
  riskLevel: RiskLevel;
  ruleMatched: string;
  rationale: string;
}
