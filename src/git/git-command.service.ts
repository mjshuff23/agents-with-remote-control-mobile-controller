import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 30_000;

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

@Injectable()
export class GitCommandService {
  async git(cwd: string, args: string[]): Promise<GitCommandResult> {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: GIT_COMMAND_TIMEOUT_MS
    });
    return { stdout, stderr };
  }
}
