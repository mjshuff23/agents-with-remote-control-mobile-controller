import { Injectable } from '@nestjs/common';
import * as pty from 'node-pty';
import { AppConfigService } from '../config/app-config.service';
import {
  AgentAdapter,
  RunningAgentProcess,
  StartAgentTaskInput
} from './agent-adapter.interface';

@Injectable()
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex' as const;

  constructor(private readonly config: AppConfigService) {}

  async startTask(input: StartAgentTaskInput): Promise<RunningAgentProcess> {
    const launch = this.buildLaunchCommand(input.repoPath);
    let process: pty.IPty;

    try {
      process = pty.spawn(launch.command, launch.args, {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: input.repoPath,
        env: processEnv()
      });
    } catch (error) {
      throw new Error(`Unable to spawn Codex CLI: ${this.errorMessage(error)}`);
    }

    process.onData((content) => {
      void input.onOutput({ type: 'stdout', content });
    });
    process.onExit((event) => {
      void input.onExit({
        exitCode: event.exitCode,
        signal: event.signal === undefined ? undefined : String(event.signal)
      });
    });

    this.writePrompt(process, input.prompt);

    return {
      externalSessionId: `pty:${process.pid}`,
      stop: () => {
        process.kill('SIGTERM');
        setTimeout(() => {
          try {
            process.kill('SIGKILL');
          } catch {
            // Process already exited.
          }
        }, this.config.shutdownGraceMs).unref();
      }
    };
  }

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

  private writePrompt(process: pty.IPty, prompt: string): void {
    process.write(prompt.replace(/\r?\n/g, '\r'));
    process.write('\x04');
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}
