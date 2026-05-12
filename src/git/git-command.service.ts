import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';


const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 30_000;

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

/** Low-level git CLI execution with timeout and sanitized environment. */
@Injectable()
export class GitCommandService {
  /**
   * Run a git command in the given directory.
   * @param cwd  - Working directory for the command.
   * @param args - Git arguments (e.g. `['diff', '--stat', 'HEAD']`).
   * @returns Combined stdout/stderr output.
   */
  async git(cwd: string, args: string[]): Promise<GitCommandResult> {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      env: buildGitEnv()
    });
    return { stdout, stderr };
  }
}

/** Build a sanitized git environment (disable prompts and pagers). */
function buildGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat'
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT' && key !== 'GIT_PAGER') {
      delete env[key];
    }
  }
  return env;
}
