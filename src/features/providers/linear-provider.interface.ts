import type { ProviderActionResult, NormalizedProviderError } from './provider.types';

export const ILinearProvider = Symbol('ILinearProvider');

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: 'started' | 'unstarted' | 'completed' | 'canceled';
  position: number;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  stateId?: string;
  url: string;
  teamId: string;
  labels: string[];
}

export interface LinearSearchParams {
  query?: string;
  teamId?: string;
  stateId?: string;
  limit?: number;
}

export interface LinearCreateLinkParams {
  issueId: string;
  url: string;
  label: string;
}

export interface ILinearProvider {
  readonly name: 'linear';
  isConfigured(): boolean;
  searchIssues(params: LinearSearchParams): Promise<LinearIssue[]>;
  getIssue(id: string): Promise<LinearIssue>;
  getTeams(): Promise<LinearTeam[]>;
  getWorkflowStates(teamId: string): Promise<LinearWorkflowState[]>;
  updateIssueStatus(issueId: string, workflowStateId: string): Promise<ProviderActionResult>;
  attachLink(params: LinearCreateLinkParams): Promise<ProviderActionResult>;
  normalizeError(error: unknown): NormalizedProviderError;
}
