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
  externalIssueRef: string | null;
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

export type RuntimeProcessState = 'live_process' | 'reconstructed' | 'terminal';
export type RuntimeStatusLabel = 'active' | 'waiting_approval' | 'idle' | 'dormant' | 'completed' | 'failed' | 'stopped';

export interface RuntimeState {
  processState: RuntimeProcessState;
  statusLabel: RuntimeStatusLabel;
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
  timeoutMs?: number;
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

export interface TaskDetailsResponse {
  task: Task;
  session: Session | null;
  logs: LogEntry[];
  events: TaskEventEnvelope[];
  eventCursor: number;
  runtime: RuntimeState;
  approvals: ApprovalRequest[];
  changeSummaries: GitChangeSummary[];
  testRuns: TestRunSummary[];
}

export interface TaskReplayResponse {
  task: Task;
  session: Session | null;
  logs: LogEntry[];
  events: TaskEventEnvelope[];
  eventCursor: number;
  runtime: RuntimeState;
}

/**
 * Internal fetch wrapper that prepends the API base path, checks response
 * status, and parses JSON.
 *
 * - 204 No Content → returns `undefined` (cast to T for ergonomic callers).
 * - Any non-204 response with an empty body → throws (likely a server error).
 * - Successful response → parses and returns the JSON body as T.
 *
 * @param path - API endpoint path (appended after `/api`).
 * @param init - Optional fetch init (method, headers, body, etc.).
 * @returns Parsed JSON body, or `undefined` for 204 No Content.
 * @throws If the server returns a non-OK status — the error message contains
 *         the HTTP method, path, status code, and response body.
 * @throws If a non-204 response has an empty body.
 */
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) {
    throw new Error(`API ${init?.method ?? 'GET'} ${path} → ${res.status}: empty body`);
  }
  return JSON.parse(text) as T;
}

/**
 * Fetch all tasks from the orchestrator.
 *
 * @returns Object containing a list of all tasks.
 */
export function listTasks(): Promise<{ tasks: Task[] }> {
  return apiFetch('/tasks');
}

/**
 * Fetch a single task with its session, logs, events, and runtime state.
 *
 * @param id - Task UUID.
 * @returns Detailed task response including logs, events, approvals, and diffs.
 */
export function getTask(id: string): Promise<TaskDetailsResponse> {
  return apiFetch(`/tasks/${id}`);
}

/**
 * Replay task events and logs after the given cursor positions.
 *
 * @param id      - Task UUID.
 * @param cursors - Sequence numbers to resume from for events and logs; an
 *                  optional `limit` caps the number of log entries returned.
 * @returns A replay response containing the task, session, events, and logs.
 */
export function replayTask(id: string, cursors: { afterEventSeq: number; afterLogSequence: number; limit?: number }): Promise<TaskReplayResponse> {
  const params = new URLSearchParams({
    afterEventSeq: String(cursors.afterEventSeq),
    afterLogSequence: String(cursors.afterLogSequence)
  });
  if (cursors.limit !== undefined) params.set('limit', String(cursors.limit));
  return apiFetch(`/tasks/${id}/replay?${params.toString()}`);
}

/**
 * Create a new task and start an agent session for it.
 *
 * @param payload - Prompt text, agent name, and optional title.
 * @returns The created task and its initial agent session.
 */
export function createTask(payload: { prompt: string; agent: string; title?: string; externalIssueRef?: ExternalIssueRef }): Promise<{ task: Task; session: Session }> {
  return apiFetch('/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

/**
 * Stop a running task and kill its agent process.
 *
 * @param id - Task UUID.
 * @returns The stop result (structure depends on server response).
 */
export function stopTask(id: string): Promise<unknown> {
  return apiFetch(`/tasks/${id}/stop`, { method: 'POST' });
}

/**
 * Send stdin text to a running task's agent process.
 *
 * @param id   - Task UUID.
 * @param text - Input text to send.
 * @returns The server response (structure depends on endpoint).
 */
export function sendInput(id: string, text: string): Promise<unknown> {
  return apiFetch(`/tasks/${id}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
}

/**
 * List all approval requests for a task.
 *
 * @param id - Task UUID.
 * @returns Object containing the list of approval requests.
 */
export function listApprovals(id: string): Promise<{ approvals: ApprovalRequest[] }> {
  return apiFetch(`/tasks/${id}/approvals`);
}

/**
 * List configured test commands available for a task.
 *
 * @param id - Task UUID.
 * @returns Object containing the list of test command configurations.
 */
export function listTestCommands(id: string): Promise<{ testCommands: TestCommandConfig[] }> {
  return apiFetch(`/tasks/${id}/test-commands`);
}

/**
 * POST an approval decision (approve/deny) to the given endpoint path.
 *
 * @param path    - API path for the decision endpoint.
 * @param message - Optional operator message included with the decision.
 * @returns The resolved approval request.
 */
function postApprovalDecision(path: string, message?: string): Promise<{ approval: ApprovalRequest }> {
  const init: RequestInit = { method: 'POST' };
  if (message !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify({ message });
  }
  return apiFetch(path, init);
}

/**
 * Approve a pending approval request.
 *
 * @param id      - Approval request UUID.
 * @param message - Optional operator message.
 * @returns The resolved approval request.
 */
export function approveAction(id: string, message?: string): Promise<{ approval: ApprovalRequest }> {
  return postApprovalDecision(`/approvals/${id}/approve`, message);
}

/**
 * Deny a pending approval request.
 *
 * @param id      - Approval request UUID.
 * @param message - Optional operator message.
 * @returns The denied approval request.
 */
export function denyAction(id: string, message?: string): Promise<{ approval: ApprovalRequest }> {
  return postApprovalDecision(`/approvals/${id}/deny`, message);
}

/**
 * Request a diff summary for a task.
 *
 * @param id - Task UUID.
 * @returns The diff summary response with file change stats, risk flags, etc.
 */
export function summarizeDiff(id: string): Promise<DiffSummaryResponse> {
  return apiFetch(`/tasks/${id}/diff-summary`, { method: 'POST' });
}

/**
 * Run a configured test command for a task.
 *
 * @param id        - Task UUID.
 * @param commandId - The test command configuration identifier.
 * @returns A test run summary with status, exit code, and highlights.
 */
export function runTest(id: string, commandId: string): Promise<TestRunSummary> {
  return apiFetch(`/tasks/${id}/test-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commandId })
  });
}

/** Restore a dormant task session back to running. */
export function restoreTask(id: string): Promise<{ restored: boolean; session: Session; runtime: RuntimeState }> {
  return apiFetch(`/tasks/${id}/restore`, { method: 'POST' });
}

// ── Issue search ──────────────────────────────────────────────────────────────

export type IssueProvider = 'github' | 'linear';

export interface NormalizedIssue {
  provider: IssueProvider;
  externalId: string;
  key: string;
  title: string;
  url: string;
  state: string;
  labels: string[];
  body?: string;
}

export interface ExternalIssueRef {
  provider: IssueProvider;
  externalId: string;
  key: string;
  url?: string;
  title?: string;
}

export interface IssueSearchParams {
  provider: IssueProvider;
  query?: string;
  /** GitHub: owner/repo slug. Linear: team ID. */
  scope?: string;
  stateId?: string;
  limit?: number;
}

export function searchIssues(params: IssueSearchParams): Promise<{ issues: NormalizedIssue[]; provider: IssueProvider }> {
  const p = new URLSearchParams({ provider: params.provider });
  if (params.query) p.set('query', params.query);
  if (params.scope) p.set('scope', params.scope);
  if (params.stateId) p.set('stateId', params.stateId);
  if (params.limit !== undefined) p.set('limit', String(params.limit));
  return apiFetch(`/issues/search?${p.toString()}`);
}
