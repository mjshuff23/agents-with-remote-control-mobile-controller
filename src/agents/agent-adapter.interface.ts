/** Agent CLI binary name currently supported. */
export type SupportedAgentName = 'codex';

/** Stream origin for agent log entries. */
export type AgentLogType = 'stdout' | 'stderr' | 'system';

/** A chunk of output emitted by an agent process. */
export interface AgentOutputEvent {
  type: AgentLogType;
  content: string;
}

/** Signals that an agent process has terminated. */
export interface AgentExitEvent {
  exitCode: number;
  signal?: string;
}

/**
 * Input required to launch an agent task.
 *
 * @param taskId      - Orchestrator task UUID.
 * @param sessionId   - Orchestrator session UUID.
 * @param repoPath    - Repository root the agent operates on.
 * @param worktreePath - Isolated worktree directory, if applicable.
 * @param branchName  - Git branch for this task, if applicable.
 * @param prompt      - Initial prompt text to send to the agent.
 * @param onOutput    - Async callback for each stdout/stderr/system chunk.
 * @param onExit      - Async callback when the agent process exits.
 */
export interface StartAgentTaskInput {
  taskId: string;
  sessionId: string;
  repoPath: string;
  worktreePath?: string;
  branchName?: string;
  prompt: string;
  onOutput: (event: AgentOutputEvent) => Promise<void>;
  onExit: (event: AgentExitEvent) => Promise<void>;
}

/** Input required to resume a persisted agent conversation. */
export interface ResumeAgentTaskInput extends StartAgentTaskInput {
  externalSessionId: string;
}

/** A running agent process handle. */
export interface RunningAgentProcess {
  externalSessionId: string;
  stop: () => Promise<void> | void;
  write?(text: string): void;
}

/** Pluggable adapter interface for launching and controlling agent CLIs. */
export interface AgentAdapter {
  name: SupportedAgentName;
  startTask(input: StartAgentTaskInput): Promise<RunningAgentProcess>;
  resumeTask?(input: ResumeAgentTaskInput): Promise<RunningAgentProcess>;
}
