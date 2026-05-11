const API_BASE = '/api';

export interface Task {
  id: string;
  title: string | null;
  prompt: string;
  status: string;
  selectedAgent: string;
  repoPath: string;
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

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export function listTasks(): Promise<{ tasks: Task[] }> {
  return apiFetch('/tasks');
}

export function getTask(id: string): Promise<{ task: Task; session: Session | null; logs: LogEntry[] }> {
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
