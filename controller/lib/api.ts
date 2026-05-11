const API_BASE = '/api';

export interface Task {
  id: string;
  title: string | null;
  prompt: string;
  status: string;
  selectedAgent: string;
  repoPath: string;
  worktreePath: string | null;
  branchName: string | null;
  baseRef: string | null;
  baseCommit: string | null;
  approvalMode: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  taskId: string;
  agentName: string;
  status: string;
  externalSessionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
}

export interface LogEntry {
  id: string;
  sessionId: string;
  type: string;
  sequence: number;
  content: string;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  sessionId: string | null;
  actionRequestId: string;
  actionType: string;
  riskLevel: string;
  title: string;
  rationale: string | null;
  commandJson: string | null;
  filesJson: string | null;
  expectedEffect: string | null;
  status: string;
  ruleMatched: string | null;
  decision: string | null;
  decisionMessage: string | null;
  requestedAt: string;
  resolvedAt: string | null;
  expiresAt: string;
}

export interface GitChangeSummary {
  id: string;
  taskId: string;
  sessionId: string | null;
  statusText: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  renamedCount: number;
  riskFlagsJson: string;
  topFilesJson: string;
  createdAt: string;
}

export interface DiffSummaryResponse {
  id: string;
  taskId: string;
  sessionId: string | null;
  statusText: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  renamedCount: number;
  riskFlags: string[];
  topFiles: Array<{ path: string; insertions: number; deletions: number; status?: string }>;
  createdAt: string;
}

export interface TestCommandConfig {
  id: string;
  label: string;
  cwd?: string;
  command: string[];
}

export interface TestRunSummary {
  id: string;
  taskId: string;
  sessionId: string | null;
  commandId: string;
  commandJson: string;
  status: string;
  exitCode: number | null;
  highlightsJson: string;
  startedAt: string;
  completedAt: string | null;
}

export interface TaskEventEnvelope<TName extends string = string, TData = unknown> {
  id: string;
  seq: number;
  taskId: string;
  sessionId?: string;
  name: TName;
  kind: string;
  severity: string;
  correlationId?: string;
  at: string;
  data: TData;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, withControllerSecret(init));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function withControllerSecret(init: RequestInit = {}): RequestInit {
  const secret = process.env.NEXT_PUBLIC_CONTROLLER_SECRET;
  if (!secret) {
    return init;
  }
  const headers = new Headers(init.headers);
  headers.set('X-Controller-Secret', secret);
  return { ...init, headers };
}

export function listTasks(): Promise<{ tasks: Task[] }> {
  return apiFetch('/tasks');
}

export function getTask(id: string): Promise<{ task: Task; session: Session | null; logs: LogEntry[]; approvals: ApprovalRequest[]; changeSummaries: GitChangeSummary[]; testRuns: TestRunSummary[] }> {
  return apiFetch(`/tasks/${id}`);
}

export function createTask(payload: { prompt: string; agent: string; title?: string }): Promise<{ task: Task; session: Session }> {
  return apiFetch('/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

export function stopTask(id: string): Promise<unknown> {
  return apiFetch(`/tasks/${id}/stop`, { method: 'POST' });
}

export function sendInput(id: string, text: string): Promise<unknown> {
  return apiFetch(`/tasks/${id}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
}

export function listApprovals(id: string): Promise<{ approvals: ApprovalRequest[] }> {
  return apiFetch(`/tasks/${id}/approvals`);
}

export function listTestCommands(id: string): Promise<{ testCommands: TestCommandConfig[] }> {
  return apiFetch(`/tasks/${id}/test-commands`);
}

export function approveAction(id: string, message?: string): Promise<{ approval: ApprovalRequest }> {
  return apiFetch(`/approvals/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
}

export function denyAction(id: string, message?: string): Promise<{ approval: ApprovalRequest }> {
  return apiFetch(`/approvals/${id}/deny`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
}

export function summarizeDiff(id: string): Promise<DiffSummaryResponse> {
  return apiFetch(`/tasks/${id}/diff-summary`, { method: 'POST' });
}

export function runTest(id: string, commandId: string): Promise<TestRunSummary> {
  return apiFetch(`/tasks/${id}/test-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commandId })
  });
}
