import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodexAdapter } from '../src/agents/codex.adapter';
import { AgentExitEvent, AgentOutputEvent } from '../src/agents/agent-adapter.interface';

// Real API calls: skip the suite if no key is set so CI without credentials
// stays green, but always run locally when the key is present.
const describeIfKey = process.env.OPENAI_API_KEY ? describe : describe.skip;

// Enough time for a real LLM round-trip, including codex startup overhead.
const TIMEOUT_MS = 120_000;

// Strip ANSI escape codes so assertions are readable.
function stripAnsi(raw: string): string {
  return raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function makeStubConfig(repoPath: string, codexBin: string) {
  return {
    runnerMode: 'local',
    codexCommand: codexBin,
    codexArgs: ['exec', '--json', '--cd', '{repoPath}', '-'],
    codexEnvKeys: [],
    wslCommand: 'wsl.exe',
    wslDistro: undefined,
    wslUser: undefined,
    shutdownGraceMs: 5_000
  };
}

describeIfKey('CodexAdapter — PTY integration', () => {
  let repoFixture: string | undefined;

  beforeAll(() => {
    repoFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-it-'));
    // execFileSync avoids shell injection; all args are hardcoded constants.
    child_process.execFileSync('git', ['init'], { cwd: repoFixture, stdio: 'pipe' });
    child_process.execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: repoFixture, stdio: 'pipe' });
    child_process.execFileSync('git', ['config', 'user.name', 'tester'], { cwd: repoFixture, stdio: 'pipe' });
  });

  afterAll(() => {
    // Guard against beforeAll failing before repoFixture was assigned —
    // calling rmSync on undefined would throw and obscure the real error.
    if (repoFixture) {
      fs.rmSync(repoFixture, { recursive: true, force: true });
    }
  });

  it(
    'spawns codex, receives stdout, and the process exits',
    async () => {
      // Resolve the codex binary. Priority order:
      //   1. CODEX_BIN env var — explicit CI/local override
      //   2. $NVM_BIN/codex  — set by nvm when a version is active
      //   3. ~/.npm-global/bin/codex — common global prefix
      //   4. "codex" on $PATH — last resort
      // The hard-coded nvm path is intentionally omitted: it embeds a Node
      // version string that will break when the version changes.
      const candidates = [
        process.env.CODEX_BIN,
        process.env.NVM_BIN ? path.join(process.env.NVM_BIN, 'codex') : undefined,
        path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
        'codex'
      ].filter((c): c is string => Boolean(c));

      const codexBin = candidates.find((c) => {
        try {
          fs.accessSync(c, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }) ?? 'codex';

      const config = makeStubConfig(repoFixture!, codexBin);
      const adapter = new CodexAdapter(config as any);

      const outputChunks: string[] = [];
      let exitEvent: AgentExitEvent | undefined;
      // Captured after startTask resolves so watchdog and error paths can stop it.
      let runningProcess: { stop: () => void | Promise<void> } | undefined;

      const settled = new Promise<void>((resolve, reject) => {
        const watchdog = setTimeout(() => {
          // Stop the process before rejecting so it is never orphaned.
          void Promise.resolve(runningProcess?.stop()).finally(() => {
            reject(new Error(`codex did not exit within ${TIMEOUT_MS - 5_000}ms`));
          });
        }, TIMEOUT_MS - 5_000);
        watchdog.unref();

        adapter
          .startTask({
            taskId: 'it-1',
            sessionId: 'it-session-1',
            repoPath: repoFixture!,
            prompt: 'say hi in one word',
            onOutput: async (event: AgentOutputEvent) => {
              outputChunks.push(event.content);
            },
            onExit: async (event: AgentExitEvent) => {
              exitEvent = event;
              clearTimeout(watchdog);
              resolve();
            }
          })
          .then((handle) => {
            runningProcess = handle;
          })
          .catch((err: Error) => {
            clearTimeout(watchdog);
            reject(new Error(`startTask rejected: ${err.message}`));
          });
      });

      await settled;

      const combined = stripAnsi(outputChunks.join(''));

      // At minimum the adapter must have received some bytes from codex.
      expect(combined.length).toBeGreaterThan(0);

      // Codex emits JSONL when --json is passed. The very first event is always
      // thread.started. Even on usage-limit errors we get at least an error
      // event — so any JSONL type field confirms the pipe is working end-to-end.
      expect(combined).toMatch(/"type"\s*:/);

      // The process must have exited (not just timed out via the watchdog).
      expect(exitEvent).toBeDefined();
    },
    TIMEOUT_MS
  );
});
