import { Injectable } from '@nestjs/common';
import * as pty from 'node-pty';

import { AppConfigService } from '../config/app-config.service';
import {
  AgentAdapter,
  ResumeAgentTaskInput,
  RunningAgentProcess,
  StartAgentTaskInput
} from './agent-adapter.interface';

const BASE_CHILD_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'TZ'
];
// PTY_ENTER (\r) submits the current line to the terminal's line discipline.
// PTY_EOF (\x04, Ctrl-D) signals end-of-input to the reading process.
// They must arrive in this order: Enter first so the line is consumed, then
// EOF to close the stream cleanly.
const PTY_EOF = '\x04';
const PTY_ENTER = '\r';

/** Codex CLI adapter that launches agent processes via node-pty. */
@Injectable()
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex' as const;

  constructor(private readonly config: AppConfigService) {}

  /**
   * Start a Codex agent process in a PTY, wire output/exit callbacks,
   * and inject the initial prompt.
   *
   * @param input - Task launch parameters including repo path, prompt,
   *                and output/exit callbacks.
   * @returns A handle to the running process with stop() and write().
   */
  async startTask(input: StartAgentTaskInput): Promise<RunningAgentProcess> {
    const executionPath = input.worktreePath ?? input.repoPath;
    const launch = this.buildLaunchCommand(executionPath);
    return this.startPty(input, launch, `pty`);
  }

  /** Resume a persisted Codex exec thread for a follow-up turn. */
  async resumeTask(input: ResumeAgentTaskInput): Promise<RunningAgentProcess> {
    const executionPath = input.worktreePath ?? input.repoPath;
    const launch = this.buildResumeCommand(executionPath, input.externalSessionId);
    return this.startPty(input, launch, input.externalSessionId);
  }

  /** Spawn Codex in a PTY, filter prompt echo, and inject the prompt. */
  private async startPty(
    input: StartAgentTaskInput,
    launch: { command: string; args: string[]; cwd: string },
    externalSessionId: string
  ): Promise<RunningAgentProcess> {
    let ptyProcess: pty.IPty;

    try {
      const spawnOptions: pty.IPtyForkOptions = {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        env: buildChildEnv(this.config.codexEnvKeys)
      };
      if (this.config.runnerMode === 'local') {
        spawnOptions.cwd = launch.cwd;
      }

      ptyProcess = pty.spawn(launch.command, launch.args, {
        ...spawnOptions
      });
    } catch (error) {
      throw new Error(`Unable to spawn Codex CLI: ${this.errorMessage(error)}`);
    }

    const filterInitialEcho = createInitialCodexJsonFilter();
    ptyProcess.onData((content) => {
      const filtered = filterInitialEcho.filter(content);
      if (filtered) {
        void Promise.resolve(input.onOutput({ type: 'stdout', content: filtered })).catch(() => undefined);
      }
    });
    ptyProcess.onExit((event) => {
      void (async () => {
        const prelude = filterInitialEcho.flushPrelude();
        if (prelude) {
          await Promise.resolve(input.onOutput({ type: 'system', content: prelude })).catch(() => undefined);
        }
        await Promise.resolve(input.onExit({
          exitCode: event.exitCode,
          signal: event.signal === undefined ? undefined : String(event.signal)
        }));
      })().catch(() => undefined);
    });

    this.writePrompt(ptyProcess, input.prompt);

    return {
      externalSessionId: externalSessionId === 'pty' ? `pty:${ptyProcess.pid}` : externalSessionId,
      stop: () => {
        try {
          ptyProcess.kill('SIGTERM');
        } catch {
          // Process already exited.
          return;
        }

        setTimeout(() => {
          try {
            ptyProcess.kill('SIGKILL');
          } catch {
            // Process already exited.
          }
        }, this.config.shutdownGraceMs).unref();
      },
      write: (text: string) => {
        ptyProcess.write(text + '\r');
      }
    };
  }

  /**
   * Build the PTY command and args, handling WSL vs local mode.
   * Replaces `{repoPath}` placeholders in configured Codex args.
   */
  private buildLaunchCommand(repoPath: string): { command: string; args: string[]; cwd: string } {
    const codexArgs = this.config.codexArgs.map((arg) => arg.replaceAll('{repoPath}', repoPath));

    if (this.config.runnerMode === 'local') {
      return {
        command: this.config.codexCommand,
        args: codexArgs,
        cwd: repoPath
      };
    }

    const args: string[] = [];
    if (this.config.wslDistro) {
      args.push('-d', this.config.wslDistro);
    }
    if (this.config.wslUser) {
      args.push('-u', this.config.wslUser);
    }
    args.push('--cd', repoPath, '--', this.config.codexCommand, ...codexArgs);

    return {
      command: this.config.wslCommand,
      args,
      cwd: repoPath
    };
  }

  /** Build a Codex exec resume command from the configured exec flags. */
  private buildResumeCommand(repoPath: string, externalSessionId: string): { command: string; args: string[]; cwd: string } {
    const args = ['exec', 'resume', ...this.codexResumeOptions(repoPath), externalSessionId, '-'];

    if (this.config.runnerMode === 'local') {
      return {
        command: this.config.codexCommand,
        args,
        cwd: repoPath
      };
    }

    const wslArgs: string[] = [];
    if (this.config.wslDistro) {
      wslArgs.push('-d', this.config.wslDistro);
    }
    if (this.config.wslUser) {
      wslArgs.push('-u', this.config.wslUser);
    }
    wslArgs.push('--cd', repoPath, '--', this.config.codexCommand, ...args);

    return {
      command: this.config.wslCommand,
      args: wslArgs,
      cwd: repoPath
    };
  }

  /** Preserve exec flags that also apply to `codex exec resume`, dropping cwd and prompt placeholders. */
  private codexResumeOptions(repoPath: string): string[] {
    const options: string[] = [];
    const args = this.config.codexArgs;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i].replaceAll('{repoPath}', repoPath);
      if (i === 0 && arg === 'exec') {
        continue;
      }
      if (arg === '-' || arg === repoPath) {
        continue;
      }
      if (arg === '--cd' || arg === '-C') {
        i += 1;
        continue;
      }
      options.push(arg);
    }
    return options;
  }

  /** Write the prompt to the PTY, normalizing newlines and appending EOF. */
  private writePrompt(ptyProcess: pty.IPty, prompt: string): void {
    const normalized = prompt.replace(/\r?\n/g, PTY_ENTER).replace(/\r$/, '');
    ptyProcess.write(`${normalized}${PTY_ENTER}`);
    ptyProcess.write(PTY_EOF);
  }

  /** Safely extract an error message from an unknown error value. */
  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Build a filtered environment for child processes, allowing only base keys,
 * configured extra keys, and OPENAI_ / CODEX_ prefixed variables.
 */
function buildChildEnv(extraKeys: string[]): Record<string, string> {
  const allowedKeys = new Set(BASE_CHILD_ENV_KEYS.concat(extraKeys));
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (allowedKeys.has(key) || key.startsWith('OPENAI_') || key.startsWith('CODEX_')) {
      env[key] = value;
    }
  }

  return env;
}

/** Drop PTY prompt echo until Codex JSONL begins, but keep startup diagnostics if JSON never arrives. */
function createInitialCodexJsonFilter(): { filter(content: string): string; flushPrelude(): string } {
  let sawCodexJson = false;
  let preludeBuffer = '';
  let searchTail = '';
  return {
    filter(content: string): string {
      if (sawCodexJson) {
        return content;
      }

      preludeBuffer += content;
      const searchable = searchTail + content;
      const jsonStart = findCodexJsonStart(searchable);
      if (jsonStart === -1) {
        searchTail = searchable.slice(-4096);
        return '';
      }

      sawCodexJson = true;
      preludeBuffer = '';
      searchTail = '';
      const startInContent = jsonStart - (searchable.length - content.length);
      if (startInContent >= 0) {
        return content.slice(startInContent);
      }
      return searchable.slice(jsonStart);
    },
    flushPrelude(): string {
      if (sawCodexJson) {
        return '';
      }
      const prelude = preludeBuffer;
      preludeBuffer = '';
      searchTail = '';
      return prelude;
    }
  };
}

function findCodexJsonStart(content: string): number {
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const index = content.indexOf('{"type"', searchFrom);
    if (index === -1) {
      return -1;
    }
    const lineEnd = content.indexOf('\n', index);
    if (lineEnd === -1) {
      return -1;
    }
    const line = content.slice(index, lineEnd).trim();
    const nextLine = nextCompleteNonEmptyLine(content, lineEnd + 1);
    if (isCodexThreadStartedLine(line) && nextLine && isCodexFollowupLine(nextLine)) {
      return index;
    }
    searchFrom = index + 1;
  }
  return -1;
}

function nextCompleteNonEmptyLine(content: string, start: number): string | null {
  let lineStart = start;
  while (lineStart < content.length) {
    const lineEnd = content.indexOf('\n', lineStart);
    if (lineEnd === -1) {
      return null;
    }
    const line = content.slice(lineStart, lineEnd).trim();
    if (line) {
      return line;
    }
    lineStart = lineEnd + 1;
  }
  return null;
}

function isCodexThreadStartedLine(line: string): boolean {
  try {
    const event = JSON.parse(line) as { type?: string; thread_id?: unknown };
    return event.type === 'thread.started' && typeof event.thread_id === 'string' && isCodexThreadId(event.thread_id);
  } catch {
    return false;
  }
}

function isCodexFollowupLine(line: string): boolean {
  try {
    const event = JSON.parse(line) as { type?: string };
    return event.type === 'turn.started' || event.type === 'error';
  } catch {
    return false;
  }
}

function isCodexThreadId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
