# Adding New Agent Adapters

The orchestrator is agent-agnostic. Codex is the first adapter, but Claude Code CLI, Gemini CLI, opencode, and any other PTY-based CLI agent can be added by implementing the `AgentAdapter` interface.

---

## The adapter contract

Every adapter implements one interface defined in `src/agents/agent-adapter.interface.ts`:

```typescript
export interface AgentAdapter {
  name: SupportedAgentName;
  startTask(input: StartAgentTaskInput): Promise<RunningAgentProcess>;
}
```

**`startTask` receives:**

| Field | Type | Description |
|---|---|---|
| `taskId` | `string` | Unique task ID |
| `sessionId` | `string` | Unique session ID |
| `repoPath` | `string` | Canonical repo path |
| `worktreePath` | `string \| undefined` | Isolated Git worktree (use this as the working directory) |
| `branchName` | `string \| undefined` | Branch name for the worktree |
| `prompt` | `string` | User prompt |
| `onOutput` | `(event) => Promise<void>` | Call for every stdout/stderr chunk |
| `onExit` | `(event) => Promise<void>` | Call once when the process exits |

**`startTask` returns:**

```typescript
export interface RunningAgentProcess {
  externalSessionId: string;   // agent's own session/thread ID, or a generated UUID
  stop: () => Promise<void> | void;  // called when user stops the task
  write?(text: string): void;  // optional: called when user sends stdin input
}
```

If the agent does not support live stdin (e.g., it reads the prompt from a file or argument and runs to completion), omit `write`. The UI will disable the Continue/Input action automatically.

---

## Step-by-step: adding a new adapter

### 1. Register the name

In `src/agents/agent-adapter.interface.ts`, add the new name to the union:

```typescript
export type SupportedAgentName = 'codex' | 'claude-code' | 'gemini' | 'opencode';
```

### 2. Create the adapter file

Create `src/agents/<name>.adapter.ts`. Use `codex.adapter.ts` as a reference.

Minimal skeleton:

```typescript
import { Injectable } from '@nestjs/common';
import * as pty from 'node-pty';
import { AppConfigService } from '../config/app-config.service';
import { AgentAdapter, RunningAgentProcess, StartAgentTaskInput } from './agent-adapter.interface';

@Injectable()
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code' as const;

  constructor(private readonly config: AppConfigService) {}

  async startTask(input: StartAgentTaskInput): Promise<RunningAgentProcess> {
    const cwd = input.worktreePath ?? input.repoPath;

    const ptyProcess = pty.spawn('claude', ['--no-interactive', '--print', input.prompt], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd,
      env: { PATH: process.env.PATH ?? '', ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '' }
    });

    ptyProcess.onData((content) => { void input.onOutput({ type: 'stdout', content }); });
    ptyProcess.onExit(({ exitCode }) => { void input.onExit({ exitCode: exitCode ?? 0 }); });

    return {
      externalSessionId: crypto.randomUUID(),
      stop: () => ptyProcess.kill(),
      write: (text) => ptyProcess.write(text)
    };
  }
}
```

### 3. Register in AgentsModule

In `src/agents/agents.module.ts`, add the new adapter to the `AGENT_ADAPTERS` provider array:

```typescript
{
  provide: AGENT_ADAPTERS,
  useFactory: (codex: CodexAdapter, claude: ClaudeCodeAdapter) => [codex, claude],
  inject: [CodexAdapter, ClaudeCodeAdapter]
}
```

Also add `ClaudeCodeAdapter` to the `providers` array.

### 4. Add unit tests

Create `src/agents/<name>.adapter.spec.ts`. Test at minimum:
- `startTask` calls `onOutput` with chunks from the PTY
- `startTask` calls `onExit` when the process exits
- `stop` kills the process
- `write` forwards text to PTY stdin (if supported)

---

## Agent-specific notes

### Claude Code CLI (`claude`)

- Binary: `claude` (after `npm install -g @anthropic-ai/claude-code`)
- Non-interactive mode: `claude --print "<prompt>"` runs once and exits
- Interactive mode: `claude` with stdin attached supports multi-turn
- For the `ARC_ACTION_REQUEST` protocol, inject the safety contract via `--system-prompt` flag or prepend it to the prompt
- Requires `ANTHROPIC_API_KEY` in the child process environment — add `ANTHROPIC_API_KEY` to `ARC_CODEX_ENV_KEYS` (or create an equivalent `ARC_CLAUDE_ENV_KEYS`)

### Gemini CLI (`gemini`)

- Binary: `gemini` (after `npm install -g @google/gemini-cli`)
- Run: `gemini --prompt "<prompt>"` or with a YOLO flag for non-interactive
- Requires `GEMINI_API_KEY` or a Google Cloud auth setup
- Approval protocol must be injected via the system prompt, same as Claude Code

### opencode

- Binary: `opencode` (after install from https://opencode.ai)
- Supports multiple providers (Anthropic, OpenAI, local models) via config
- Check its CLI flags for non-interactive / headless mode
- May require a different PTY setup if it uses an alternate terminal protocol

### Custom / local agents

Any process that:
1. Accepts a prompt on stdin or as a CLI argument
2. Writes output to stdout
3. Exits when done

...can be wrapped with this adapter pattern. For agents that don't support the `ARC_ACTION_REQUEST` approval protocol, they will run in a "best-effort" mode where all actions are logged but not intercepted — suitable for read-only or exploration tasks.

---

## Selecting an agent from the UI

The `CreateTaskDto` has an `agent` field. The frontend `new-task` form currently hard-codes `codex`; to support multiple agents, it needs a dropdown populated from a `GET /agents` endpoint (not yet implemented).

Interim workaround: add `agent: 'claude-code'` to the POST body manually, or extend the new-task form with a hardcoded select while multi-agent support is built out.

---

## Environment variables per adapter

Each adapter may need different env keys passed to the child process. The current design uses `ARC_CODEX_ENV_KEYS` (comma-separated list of env var names to forward). A future improvement would generalize this to per-adapter env key lists, e.g.:

```bash
ARC_CLAUDE_ENV_KEYS=ANTHROPIC_API_KEY,CLAUDE_CONFIG_DIR
ARC_GEMINI_ENV_KEYS=GEMINI_API_KEY
ARC_OPENCODE_ENV_KEYS=OPENAI_API_KEY,ANTHROPIC_API_KEY
```
