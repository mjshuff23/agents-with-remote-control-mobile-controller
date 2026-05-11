import { ActionClassifierService } from './action-classifier.service';
import { PolicyLoaderService } from './policy-loader.service';

describe('ActionClassifierService', () => {
  const policy = {
    version: 1,
    policy: {
      safe: [{ id: 'test.allowed', actionTypes: ['test.run'], commandIds: ['root:test'], rationale: 'allowed test' }],
      needsApproval: [{ id: 'fs.mutation', actionTypes: ['fs.write_patch'], rationale: 'file write' }],
      blocked: [
        { id: 'secrets.paths', pathGlobs: ['.env', '*.pem'], rationale: 'secret path' },
        { id: 'git.force_push', commandIncludes: ['push', '--force'], rationale: 'force push' }
      ]
    },
    testCommands: []
  };
  const loader = { load: jest.fn(async () => policy) } as unknown as PolicyLoaderService;
  const service = new ActionClassifierService(loader);

  it('classifies declared safe test commands as SAFE', async () => {
    await expect(service.classify({ id: 'a1', actionType: 'test.run', commandId: 'root:test', title: 'Run tests' }))
      .resolves.toEqual(expect.objectContaining({ riskLevel: 'SAFE', ruleMatched: 'test.allowed' }));
  });

  it('classifies file writes as NEEDS_APPROVAL', async () => {
    await expect(service.classify({ id: 'a1', actionType: 'fs.write_patch', title: 'Patch file' }))
      .resolves.toEqual(expect.objectContaining({ riskLevel: 'NEEDS_APPROVAL', ruleMatched: 'fs.mutation' }));
  });

  it('blocks secret-shaped paths before approval rules', async () => {
    await expect(service.classify({ id: 'a1', actionType: 'fs.write_patch', title: 'Read env', files: ['.env'] }))
      .resolves.toEqual(expect.objectContaining({ riskLevel: 'BLOCKED', ruleMatched: 'secrets.paths' }));
  });

  it('blocks force push commands', async () => {
    await expect(service.classify({ id: 'a1', actionType: 'shell.command', title: 'Force push', command: ['git', 'push', '--force'] }))
      .resolves.toEqual(expect.objectContaining({ riskLevel: 'BLOCKED', ruleMatched: 'git.force_push' }));
  });

  it('defaults unknown actions to NEEDS_APPROVAL', async () => {
    await expect(service.classify({ id: 'a1', actionType: 'shell.command', title: 'Unknown command', command: ['echo', 'hi'] }))
      .resolves.toEqual(expect.objectContaining({ riskLevel: 'NEEDS_APPROVAL', ruleMatched: 'default.unknown' }));
  });
});
