export type SupportedAgentName = 'codex';
export type AgentLogType = 'stdout' | 'stderr' | 'system';

export interface AgentOutputEvent {
  type: AgentLogType;
  content: string;
}

export interface AgentExitEvent {
  exitCode: number;
  signal?: string;
}

export interface StartAgentTaskInput {
  taskId: string;
  sessionId: string;
  repoPath: string;
  prompt: string;
  onOutput: (event: AgentOutputEvent) => Promise<void>;
  onExit: (event: AgentExitEvent) => Promise<void>;
}

export interface RunningAgentProcess {
  externalSessionId: string;
  stop: () => Promise<void> | void;
}

export interface AgentAdapter {
  name: SupportedAgentName;
  startTask(input: StartAgentTaskInput): Promise<RunningAgentProcess>;
}
