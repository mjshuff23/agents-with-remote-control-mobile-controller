/** Action risk classification levels for the policy engine. */
export type RiskLevel = 'SAFE' | 'NEEDS_APPROVAL' | 'BLOCKED';
/** Possible outcomes for an approval request. */
export type ApprovalDecision = 'approved' | 'denied' | 'expired' | 'refused' | 'auto_allow';
/** Lifecycle states of an approval request record. */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'refused';

/** A single policy rule that matches actions by type, command, or path. */
export interface PolicyRule {
  id: string;
  actionTypes?: string[];
  commandIds?: string[];
  commandIncludes?: string[];
  pathGlobs?: string[];
  rationale: string;
}

/** A test command declared in arc.config.json. */
export interface TestCommandConfig {
  id: string;
  label: string;
  cwd?: string;
  command: string[];
  timeoutMs?: number;
}

/** Root shape of the arc.config.json policy file. */
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

/** A machine-readable action request emitted by the agent (ARC_ACTION_REQUEST format). */
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

/** Outcome of classifying a single action request against policy rules. */
export interface ClassificationResult {
  riskLevel: RiskLevel;
  ruleMatched: string;
  rationale: string;
}
