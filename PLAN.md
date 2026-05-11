# Phase 3 Implementation Plan

## Summary

Phases 1 and 2 are complete. Phase 3 is the active local-loop hardening phase for Linear `TSH-79`.

The Phase 3 safety model is containment-first:

- Contain always: every task runs in a per-task Git worktree.
- Intercept where real: native CLI approval hooks may be used only if they prove reliable pre-execution semantics.
- Cooperate where not: agents emit structured `ARC_ACTION_REQUEST` lines and receive `ARC_APPROVAL` decisions over stdin.
- Review always: diffs and configured tests are summarized before any future commit, push, PR, deploy, or external sync.

Phase 3 does not implement GitHub sync, Linear sync, Notion/Figma writes, auto-commit, auto-push, auto-PR, auto-merge, deploys, Claude/Gemini adapters, or multi-agent orchestration.

## Current Runtime Contract

`POST /tasks` accepts:

```json
{
  "prompt": "Summarize this repo",
  "agent": "codex",
  "title": "Optional title"
}
```

The server uses `ARC_REPO_PATH` as the source checkout and creates a worktree before agent launch. The client never supplies arbitrary repo paths.

Worktree defaults:

- Branch: `agent/<task-id>-<slug>`
- Path: `ARC_WORKTREE_ROOT/<task-id>-<slug>` when configured
- Fallback path: sibling `worktrees/<task-id>-<slug>` beside `ARC_REPO_PATH`

Task metadata now includes:

- `worktreePath`
- `branchName`
- `baseRef`
- `baseCommit`
- `approvalMode`, currently `cooperative-gated`

## Configuration

Environment:

```bash
ARC_WORKTREE_ROOT=""
ARC_POLICY_PATH="arc.config.json"
ARC_APPROVAL_TIMEOUT_MS="300000"
ARC_TEST_COMMAND_TIMEOUT_MS="600000"
```

Policy lives in [`arc.config.json`](arc.config.json):

- `policy.safe`
- `policy.needsApproval`
- `policy.blocked`
- `testCommands`, with optional per-command `timeoutMs`

Unknown mutating commands default to `NEEDS_APPROVAL`. Secret paths, force push, production deploy, global config changes, internet-piped shell scripts, and destructive deletes outside the worktree are `BLOCKED`.

## Cooperative Approval Protocol

Agents request actions with one machine-readable stdout line:

```text
ARC_ACTION_REQUEST {"id":"<uuid>","actionType":"fs.write_patch","riskLevel":"NEEDS_APPROVAL","title":"Patch file","rationale":"Needed for the task","command":["arg1"],"files":["src/file.ts"],"expectedEffect":"One sentence"}
```

The orchestrator replies over stdin:

```text
ARC_APPROVAL {"id":"<uuid>","decision":"approved","message":"Proceed","constraints":["Execute only the exact approved action in this task worktree."]}
```

Agent rules:

- If denied, do not retry the same action by paraphrasing it.
- If expired, treat it as denied.
- If refused or `BLOCKED`, do not ask again.
- If approved, execute only the exact approved action within the stated constraints.
- After mutating actions, produce or allow a diff summary.

## REST Additions

Existing endpoints remain compatible:

- `POST /tasks`
- `GET /tasks`
- `GET /tasks/:id`
- `POST /tasks/:id/stop`
- `POST /tasks/:id/input`

Phase 3 adds:

- `GET /tasks/:id/approvals`
- `POST /approvals/:id/approve`
- `POST /approvals/:id/deny`
- `POST /tasks/:id/diff-summary`
- `POST /tasks/:id/test-runs`

Test runs accept:

```json
{ "commandId": "root:test" }
```

Only command IDs declared in `arc.config.json` run without approval, and they run inside the task worktree with `shell: false`.

## WebSocket Events

Phase 2 compatibility events:

- `task.started`
- `agent.log`
- `task.completed`

Phase 3 envelope events:

- `approval.requested`
- `approval.resolved`
- `policy.violation`
- `diff.summary`
- `test.started`
- `test.log`
- `test.completed`
- `worktree.created`
- `worktree.cleanup_requested`
- `worktree.cleanup_completed`

Envelope shape:

```ts
type TaskEventEnvelope<TName extends string, TData> = {
  id: string;
  seq: number;
  taskId: string;
  sessionId?: string;
  name: TName;
  kind: 'lifecycle' | 'log' | 'approval' | 'git' | 'diff' | 'test' | 'security' | 'controller';
  severity: 'info' | 'warn' | 'error';
  correlationId?: string;
  at: string;
  data: TData;
};
```

The controller dedupes Phase 3 envelope events by `id`.

## Persistence Additions

SQLite remains the MVP database. Phase 3 adds:

- `ApprovalRequest`
- `AuditLog`
- `GitChangeSummary`
- `TestRunSummary`

Statuses are still stored as strings in SQLite and constrained through TypeScript/runtime code rather than Prisma enums. That keeps the current SQLite setup portable while preserving typed service boundaries.

## Manual Smoke Test

With the orchestrator and controller running:

1. Open `http://localhost:3001`.
2. Create a task from the controller.
3. Confirm the task has `worktreePath`, `branchName`, `baseRef`, and `baseCommit`.
4. Confirm `worktree.created` appears in the live stream.
5. Have the agent emit an `ARC_ACTION_REQUEST` for a file mutation.
6. Confirm the task moves to `waiting_approval` and the controller shows an approval card.
7. Deny the action and confirm an `ARC_APPROVAL` denial is written to the agent.
8. Retry the exact same denied action and confirm it becomes a `policy.violation`.
9. Run a diff summary and confirm `GitChangeSummary` persists and appears in the controller.
10. Run an allowed test command and confirm `test.started`, `test.log`, and `test.completed` stream.

Adversarial checks:

- `.env` path request is refused, not approvable.
- `git push --force` is refused.
- `curl ... | sh` or `wget ... | bash` is refused.
- `rm -rf` outside the worktree is refused.
- Unknown package install is `NEEDS_APPROVAL`.
- Database migration is `NEEDS_APPROVAL`.
- Denied action retry is logged as a security event.
- Approval expiry is a denial, never an allow.

## Verification

Preferred commands:

```bash
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm build
cd controller && node_modules/.bin/tsc --noEmit
```

If `pnpm` is not installed in the current shell, use equivalent npm scripts for the root project:

```bash
npm test
npm run test:e2e
npm run typecheck
npm run build
cd controller && node_modules/.bin/tsc --noEmit
```
