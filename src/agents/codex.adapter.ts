import { Injectable } from '@nestjs/common';
import * as pty from 'node-pty';

import { AppConfigService } from '../config/app-config.service';
import {
  AgentAdapter,
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
    let ptyProcess: pty.IPty;

    try {
      const spawnOptions: pty.IPtyForkOptions = {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        env: buildChildEnv(this.config.codexEnvKeys)
      };
      if (this.config.runnerMode === 'local') {
        spawnOptions.cwd = executionPath;
      }

      ptyProcess = pty.spawn(launch.command, launch.args, {
        ...spawnOptions
      });
    } catch (error) {
      throw new Error(`Unable to spawn Codex CLI: ${this.errorMessage(error)}`);
    }

    ptyProcess.onData((content) => {
      void input.onOutput({ type: 'stdout', content });
    });
    ptyProcess.onExit((event) => {
      void input.onExit({
        exitCode: event.exitCode,
        signal: event.signal === undefined ? undefined : String(event.signal)
      });
    });

    this.writePrompt(ptyProcess, input.prompt);

    return {
      externalSessionId: `pty:${ptyProcess.pid}`,
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
  private buildLaunchCommand(repoPath: string): { command: string; args: string[] } {
    const codexArgs = this.config.codexArgs.map((arg) => arg.replaceAll('{repoPath}', repoPath));

    if (this.config.runnerMode === 'local') {
      return {
        command: this.config.codexCommand,
        args: codexArgs
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
      args
    };
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
