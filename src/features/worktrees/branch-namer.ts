import type { ExternalIssueRef } from '../providers/provider.types';

/** Maximum total length of the branch name after the `agent/` prefix. */
const MAX_BRANCH_SUFFIX_LEN = 60;
/** Maximum slug length carved from title/prompt text. */
const MAX_SLUG_LEN = 40;

export interface BranchNameInput {
  taskId: string;
  title?: string | null;
  prompt: string;
  externalIssueRef?: ExternalIssueRef | null;
}

export interface BranchNameResult {
  branchName: string;
  /** Human-readable description of how the name was derived. */
  strategy: 'issue-linked' | 'task-id';
}

/**
 * Derive a deterministic branch name for a task.
 *
 * Issue-linked format:  `agent/<provider>-<key>-<slug>`
 * Fallback format:      `agent/<taskId>-<slug>`
 *
 * The combined suffix after `agent/` is capped at MAX_BRANCH_SUFFIX_LEN chars.
 * Callers that detect a collision should call `withCollisionSuffix`.
 */
export function buildBranchName(input: BranchNameInput): BranchNameResult {
  if (input.externalIssueRef) {
    const { provider, key } = input.externalIssueRef;
    const providerSlug = slugifySegment(provider);
    const keySlug = slugifySegment(key);
    const textSlug = slugify(input.title || input.prompt || input.taskId);
    const suffix = trimSuffix(`${providerSlug}-${keySlug}-${textSlug}`);
    return { branchName: `agent/${suffix}`, strategy: 'issue-linked' };
  }

  const textSlug = slugify(input.title || input.prompt || input.taskId);
  const suffix = trimSuffix(`${input.taskId}-${textSlug}`);
  return { branchName: `agent/${suffix}`, strategy: 'task-id' };
}

/**
 * Append a numeric collision suffix to a branch name.
 * e.g. `agent/github-tsh-1-fix-bug` → `agent/github-tsh-1-fix-bug-2`
 *
 * The suffix index starts at 2 (first collision = `-2`).
 */
export function withCollisionSuffix(branchName: string, index: number): string {
  const suffix = String(Math.max(2, index));
  // Trim the base to leave room for the suffix
  const maxBase = MAX_BRANCH_SUFFIX_LEN - suffix.length - 1; // -1 for the dash
  const base = branchName.slice(0, 'agent/'.length + maxBase);
  return `${base}-${suffix}`;
}

/**
 * Convert arbitrary text to a URL-safe lowercase slug.
 * Strips non-alphanumeric chars, collapses runs of dashes, trims leading/trailing dashes.
 * Result is capped at MAX_SLUG_LEN characters.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/, '');
  return slug || 'task';
}

/** Slugify a short segment (provider name, issue key) — same rules, shorter cap. */
function slugifySegment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/, '') || 'x';
}

/** Trim a combined suffix to MAX_BRANCH_SUFFIX_LEN, preserving trailing integrity. */
function trimSuffix(suffix: string): string {
  return suffix.slice(0, MAX_BRANCH_SUFFIX_LEN).replace(/-+$/, '') || 'task';
}
