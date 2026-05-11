import { GitCommandService } from './git-command.service';
import { GitDiffService } from './git-diff.service';

describe('GitDiffService', () => {
  const task = {
    id: 'task-1',
    worktreePath: '/repo/worktrees/task-1',
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const row = {
    id: 'summary-1',
    taskId: task.id,
    sessionId: 'session-1',
    filesChanged: 2,
    insertions: 11,
    deletions: 3,
    addedCount: 1,
    modifiedCount: 1,
    deletedCount: 0,
    renamedCount: 0,
    createdAt: new Date()
  };
  const prisma = {
    gitChangeSummary: {
      create: jest.fn()
    }
  };
  const git = { git: jest.fn() } as unknown as GitCommandService;
  const events = { emitEnvelopeToTask: jest.fn() };
  const service = new GitDiffService(prisma as any, git, events as any);

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.gitChangeSummary.create as jest.Mock).mockResolvedValue(row);
    (git.git as jest.Mock)
      .mockResolvedValueOnce({ stdout: '# branch.oid abc\0', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' src/a.ts | 10 +++++\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '10\t0\tsrc/a.ts\0' + '1\t3\tpnpm-lock.yaml\0', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'M\0src/a.ts\0A\0pnpm-lock.yaml\0', stderr: '' });
  });

  it('persists parsed diff summaries and emits risk hints', async () => {
    const result = await service.summarize(task as any, { id: 'session-1' } as any);

    expect(prisma.gitChangeSummary.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        filesChanged: 2,
        insertions: 11,
        deletions: 3,
        addedCount: 1,
        modifiedCount: 1,
        riskFlagsJson: expect.stringContaining('lockfile_changed')
      })
    });
    expect(result.riskFlags).toContain('lockfile_changed');
    expect(events.emitEnvelopeToTask).toHaveBeenCalledWith(
      task.id,
      'diff.summary',
      'diff',
      'warn',
      expect.objectContaining({ filesChanged: 2 }),
      expect.objectContaining({ sessionId: 'session-1' })
    );
  });
});
