import { resolveLinearStateId } from './linear-status-mapper';
import type { LinearWorkflowState } from './linear-provider.interface';

const states: LinearWorkflowState[] = [
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 's-progress', name: 'In Progress', type: 'started', position: 1 },
  { id: 's-review', name: 'In Review', type: 'started', position: 2 },
  { id: 's-done', name: 'Done', type: 'completed', position: 3 },
  { id: 's-cancelled', name: 'Cancelled', type: 'canceled', position: 4 },
];

describe('resolveLinearStateId', () => {
  describe('configured preferred name', () => {
    it('matches preferred name exactly (case-insensitive)', () => {
      const id = resolveLinearStateId('in_progress', states, { inProgress: 'in progress' });
      expect(id).toBe('s-progress');
    });

    it('uses preferred name over default candidates', () => {
      const custom: LinearWorkflowState[] = [
        { id: 's-wip', name: 'WIP', type: 'started', position: 1 },
        { id: 's-progress', name: 'In Progress', type: 'started', position: 2 },
      ];
      const id = resolveLinearStateId('in_progress', custom, { inProgress: 'WIP' });
      expect(id).toBe('s-wip');
    });
  });

  describe('default candidate names', () => {
    it('resolves in_progress via default "In Progress"', () => {
      expect(resolveLinearStateId('in_progress', states)).toBe('s-progress');
    });

    it('resolves in_review via default "In Review"', () => {
      expect(resolveLinearStateId('in_review', states)).toBe('s-review');
    });

    it('resolves done via default "Done"', () => {
      expect(resolveLinearStateId('done', states)).toBe('s-done');
    });

    it('resolves cancelled via default "Cancelled"', () => {
      expect(resolveLinearStateId('cancelled', states)).toBe('s-cancelled');
    });

    it('matches alternate default name "Completed"', () => {
      const custom: LinearWorkflowState[] = [
        { id: 's-completed', name: 'Completed', type: 'completed', position: 1 },
      ];
      expect(resolveLinearStateId('done', custom)).toBe('s-completed');
    });

    it('matches alternate default name "Canceled" (single l)', () => {
      const custom: LinearWorkflowState[] = [
        { id: 's-canceled', name: 'Canceled', type: 'canceled', position: 1 },
      ];
      expect(resolveLinearStateId('cancelled', custom)).toBe('s-canceled');
    });
  });

  describe('type-based fallback', () => {
    it('falls back to first state with matching type when no name matches', () => {
      const custom: LinearWorkflowState[] = [
        { id: 's-custom-started', name: 'Doing', type: 'started', position: 1 },
      ];
      const id = resolveLinearStateId('in_progress', custom);
      expect(id).toBe('s-custom-started');
    });

    it('falls back to completed type for done stage', () => {
      const custom: LinearWorkflowState[] = [
        { id: 's-merged', name: 'Merged', type: 'completed', position: 1 },
      ];
      expect(resolveLinearStateId('done', custom)).toBe('s-merged');
    });

    it('falls back to canceled type for cancelled stage', () => {
      const custom: LinearWorkflowState[] = [
        { id: 's-wont-do', name: "Won't Do", type: 'canceled', position: 1 },
      ];
      expect(resolveLinearStateId('cancelled', custom)).toBe('s-wont-do');
    });
  });

  describe('missing-state fallback', () => {
    it('returns undefined when states array is empty', () => {
      expect(resolveLinearStateId('in_progress', [])).toBeUndefined();
    });

    it('returns undefined when no name or type match exists', () => {
      const custom: LinearWorkflowState[] = [
        { id: 's-unstarted', name: 'Backlog', type: 'unstarted', position: 0 },
      ];
      // done stage needs 'completed' type — not present
      expect(resolveLinearStateId('done', custom)).toBeUndefined();
    });
  });

  describe('no config provided', () => {
    it('resolves without config using defaults', () => {
      expect(resolveLinearStateId('in_progress', states, undefined)).toBe('s-progress');
    });
  });
});
