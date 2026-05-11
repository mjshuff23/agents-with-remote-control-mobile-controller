import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AppConfigService } from '../config/app-config.service';
import { PolicyLoaderService } from './policy-loader.service';

describe('PolicyLoaderService', () => {
  let tmp: string;
  let service: PolicyLoaderService;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'arc-policy-test-'));
    const config = {
      repoPath: tmp,
      policyPath: 'arc.config.json'
    } as AppConfigService;
    service = new PolicyLoaderService(config);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reloads arc.config.json when the policy file changes', async () => {
    await writeConfig(tmp, 'safe.old');
    await expect(service.load()).resolves.toMatchObject({
      policy: { safe: [{ id: 'safe.old' }] }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeConfig(tmp, 'safe.new');

    await expect(service.load()).resolves.toMatchObject({
      policy: { safe: [{ id: 'safe.new' }] }
    });
  });

  it('rejects matcherless policy rules', async () => {
    await writeFile(path.join(tmp, 'arc.config.json'), JSON.stringify({
      version: 1,
      policy: {
        safe: [{ id: 'bad.rule', rationale: 'No matcher.' }],
        needsApproval: [],
        blocked: []
      },
      testCommands: [{ id: 'root:test', label: 'Test', command: ['pnpm', 'test'] }]
    }));

    await expect(service.load()).rejects.toThrow('bad.rule');
  });

  it('rejects policy rules without stable ids', async () => {
    await writeFile(path.join(tmp, 'arc.config.json'), JSON.stringify({
      version: 1,
      policy: {
        safe: [{ actionTypes: ['test.run'], rationale: 'Missing id.' }],
        needsApproval: [],
        blocked: []
      },
      testCommands: [{ id: 'root:test', label: 'Test', command: ['pnpm', 'test'] }]
    }));

    await expect(service.load()).rejects.toThrow('Policy rule id must be a non-empty string');
  });

  it('rejects test commands without string ids and labels', async () => {
    await writeFile(path.join(tmp, 'arc.config.json'), JSON.stringify({
      version: 1,
      policy: {
        safe: [{ id: 'safe.test', actionTypes: ['test.run'], rationale: 'Test.' }],
        needsApproval: [],
        blocked: []
      },
      testCommands: [{ id: 7, label: '', command: ['pnpm', 'test'] }]
    }));

    await expect(service.load()).rejects.toThrow('id, label');
  });


  it('rejects invalid test command timeout values', async () => {
    await writeFile(path.join(tmp, 'arc.config.json'), JSON.stringify({
      version: 1,
      policy: {
        safe: [{ id: 'safe.test', actionTypes: ['test.run'], rationale: 'Test.' }],
        needsApproval: [],
        blocked: []
      },
      testCommands: [{ id: 'root:test', label: 'Test', command: ['pnpm', 'test'], timeoutMs: 0 }]
    }));

    await expect(service.load()).rejects.toThrow('timeoutMs');
  });

  it('rejects invalid approval timeout values', async () => {
    await writeFile(path.join(tmp, 'arc.config.json'), JSON.stringify({
      version: 1,
      approval: { timeoutMs: 0 },
      policy: {
        safe: [{ id: 'safe.test', actionTypes: ['test.run'], rationale: 'Test.' }],
        needsApproval: [],
        blocked: []
      },
      testCommands: [{ id: 'root:test', label: 'Test', command: ['npm', 'test'] }]
    }));

    await expect(service.load()).rejects.toThrow('approval.timeoutMs');
  });

  it('rejects test command cwd values that escape the worktree', async () => {
    await writeFile(path.join(tmp, 'arc.config.json'), JSON.stringify({
      version: 1,
      policy: {
        safe: [{ id: 'safe.test', actionTypes: ['test.run'], rationale: 'Test.' }],
        needsApproval: [],
        blocked: []
      },
      testCommands: [{ id: 'root:test', label: 'Test', cwd: '../outside', command: ['npm', 'test'] }]
    }));

    await expect(service.load()).rejects.toThrow('cwd must stay within the task worktree');
  });
});

async function writeConfig(root: string, safeRuleId: string): Promise<void> {
  await writeFile(path.join(root, 'arc.config.json'), JSON.stringify({
    version: 1,
    policy: {
      safe: [{ id: safeRuleId, actionTypes: ['test.run'], rationale: 'Test.' }],
      needsApproval: [],
      blocked: []
    },
    testCommands: [{ id: 'root:test', label: 'Test', command: ['pnpm', 'test'] }]
  }));
}
