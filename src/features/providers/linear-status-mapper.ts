import type { LinearWorkflowState } from './linear-provider.interface';

/**
 * Maps ARC task lifecycle stages to preferred Linear workflow state names.
 * Names are preferences — the team's actual states are discovered at runtime.
 * All fields are optional; omitted stages fall back to the type-based default.
 */
export interface LinearStatusMapConfig {
  /** Preferred state name when a task is created and linked. */
  inProgress?: string;
  /** Preferred state name when a commit is approved and pushed. */
  inReview?: string;
  /** Preferred state name when a PR is merged. */
  done?: string;
  /** Preferred state name when a task is cancelled or denied. */
  cancelled?: string;
}

export type ArcTaskStage = 'in_progress' | 'in_review' | 'done' | 'cancelled';

const DEFAULT_NAMES: Record<ArcTaskStage, string[]> = {
  in_progress: ['In Progress', 'In Development', 'Started'],
  in_review: ['In Review', 'Code Review', 'Review'],
  done: ['Done', 'Completed', 'Merged'],
  cancelled: ['Cancelled', 'Canceled', 'Rejected'],
};

const STAGE_TYPE_FALLBACK: Record<ArcTaskStage, LinearWorkflowState['type']> = {
  in_progress: 'started',
  in_review: 'started',
  done: 'completed',
  cancelled: 'canceled',
};

/**
 * Resolve a Linear workflow state ID for a given ARC task stage.
 *
 * Resolution order:
 * 1. Exact match on the configured preferred name (case-insensitive).
 * 2. Exact match on any default candidate name for the stage (case-insensitive).
 * 3. First state whose `type` matches the stage's type fallback.
 * 4. `undefined` — caller should skip the status update and log a warning.
 */
export function resolveLinearStateId(
  stage: ArcTaskStage,
  states: LinearWorkflowState[],
  config?: LinearStatusMapConfig,
): string | undefined {
  if (states.length === 0) return undefined;

  const preferred = preferredName(stage, config);
  const candidates = [preferred, ...DEFAULT_NAMES[stage]].filter(Boolean) as string[];

  for (const name of candidates) {
    const match = states.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (match) return match.id;
  }

  // Type-based fallback
  const typeFallback = STAGE_TYPE_FALLBACK[stage];
  const byType = states.find((s) => s.type === typeFallback);
  return byType?.id;
}

function preferredName(stage: ArcTaskStage, config?: LinearStatusMapConfig): string | undefined {
  if (!config) return undefined;
  const map: Record<ArcTaskStage, string | undefined> = {
    in_progress: config.inProgress,
    in_review: config.inReview,
    done: config.done,
    cancelled: config.cancelled,
  };
  return map[stage];
}
