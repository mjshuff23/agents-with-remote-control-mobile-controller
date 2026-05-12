# Phase 4 Implementation Plan

## Summary

Phases 1, 2, 3, and 3.5 are complete. Phase 4 is the active GitHub + Linear synchronization phase for Linear `TSH-80` and GitHub issue #5.

Phase 4 connects the durable local controller loop to repo/project-management workflows:

```text
GitHub or Linear issue -> linked task -> worktree branch -> approved commit -> approved push -> draft PR -> Linear link/status sync
```

The Phase 4 safety model inherits Phase 3 containment and approval gates:

- Contain always: every task still runs in a per-task Git worktree.
- Approve risky operations: commit, push, draft PR creation, and provider status/link writes require explicit approval unless a prior approval clearly covers the exact action.
- Idempotency always: provider sync actions must not duplicate PRs, comments, links, or status updates on retry.
- No auto-merge or auto-deploy: Phase 4 stops at draft PR and project-tool sync.

Canonical handoff: [`docs/phase-4-implementation.md`](docs/phase-4-implementation.md).

## Current Runtime Contract

`POST /tasks` remains compatible:

```json
{
  "prompt": "Summarize this repo",
  "agent": "codex",
  "title": "Optional title"
}
```

Phase 4 should extend the task creation contract without breaking existing callers. New external refs should be optional and provider-neutral.

Suggested linked task shape:

```json
{
  "prompt": "Implement the linked issue",
  "agent": "codex",
  "title": "Optional title",
  "externalIssue": {
    "provider": "github",
    "externalId": "5",
    "key": "GH-5",
    "url": "https://github.com/owner/repo/issues/5",
    "title": "Issue title"
  }
}
```

## Phase 4 Child Tickets

| Linear | Purpose |
|---|---|
| `TSH-97` | GitHub access model for issue-to-PR workflow |
| `TSH-98` | Linear access model and status mapping |
| `TSH-99` | SyncEvent idempotency model |
| `TSH-100` | Issue picker and task-linking UX |
| `TSH-101` | Branch naming and worktree lifecycle rules |
| `TSH-102` | Approved commit flow and signing checks |
| `TSH-103` | Approved push flow with remote protection |
| `TSH-104` | Draft PR creation with generated summary |
| `TSH-105` | Linear-GitHub cross-reference sync |
| `TSH-106` | PR merge detection and Linear completion sync |
| `TSH-107` | Provider adapter seams for GitHub and Linear |
| `TSH-108` | Approvals, audit logs, and sync events integration |
| `TSH-109` | Mobile sync UI and provider error surfaces |
| `TSH-110` | Provider adapter test matrix and token-gated e2e |

Recommended build order:

1. `TSH-107` adapter seams.
2. `TSH-99` SyncEvent model.
3. `TSH-97` / `TSH-98` access models and setup docs.
4. `TSH-100` issue picker + linked task creation.
5. `TSH-101` branch/worktree lifecycle.
6. `TSH-108` approval/audit/sync matrix.
7. `TSH-102` commit flow.
8. `TSH-103` push flow.
9. `TSH-104` draft PR flow.
10. `TSH-105` cross-reference sync.
11. `TSH-106` merge detection and Linear completion sync.
12. `TSH-109` mobile polish.
13. `TSH-110` test matrix and provider e2e.

## Configuration

Existing environment stays valid:

```bash
ARC_WORKTREE_ROOT=""
ARC_POLICY_PATH="arc.config.json"
ARC_APPROVAL_TIMEOUT_MS="300000"
ARC_TEST_COMMAND_TIMEOUT_MS="600000"
```

Phase 4 should add provider config incrementally. Keep provider config documented in `.env.example`; do not store provider credentials in DB records, task event payloads, logs, or controller-visible error details.

Status mapping should be configurable. Linear workflow state names vary by team and workspace, so provider code should discover available workflow states and then map configured names when present.

## SyncEvent Contract

Phase 4 introduces durable provider-sync state. Every provider-facing action should be represented by a `SyncEvent` or equivalent service record.

Suggested state machine:

```text
pending -> running -> succeeded
pending -> running -> retryable -> running
pending -> skipped
running -> failed
```

Suggested uniqueness rule:

```text
(taskId, provider, targetId, action)
```

Provider metadata should be recovery-safe only:

- provider IDs,
- URLs,
- timestamps,
- action categories,
- failure categories.

Do not store raw provider responses by default.

## Approval + Audit Contract

Phase 4 actions that require explicit approval:

- branch creation when tied to external issue metadata,
- commit creation,
- push,
- draft PR creation,
- Linear status update,
- Linear link/comment/write actions.

`AuditLog` records decisions and meaningful outcomes. `SyncEvent` records provider action state and idempotency. Do not collapse the two concepts.

## WebSocket / Replay Contract

Phase 3.5 replay semantics remain canonical:

- `TaskEvent` is the durable task-scoped event ledger with monotonic `seq` per task.
- `AgentLog` remains the raw terminal log ledger with monotonic `sequence` per session.
- `GET /tasks/:id/replay?afterEventSeq=&afterLogSequence=&limit=` returns missed events/logs after the controller cursors.
- Socket.IO `subscribe` accepts cursors and includes missed history in the ack after joining `task:<id>`.
- Reconstructed DB view is not live PTY resume; expose whether worker state is `live_process`, `reconstructed`, or `terminal`.

Phase 4 UI events must not duplicate cards after reconnect/replay.

## Manual Smoke Test

With orchestrator and controller running:

1. Open `http://localhost:3001`.
2. Link a new task to a GitHub or Linear issue.
3. Confirm generated prompt is editable before launch.
4. Confirm the task creates/uses an isolated worktree and safe branch name.
5. Confirm linked issue metadata appears on task detail.
6. Trigger a commit request and confirm approval card appears.
7. Approve commit and confirm commit SHA is captured.
8. Trigger push request and confirm separate approval card appears.
9. Approve push and confirm pushed branch metadata is captured.
10. Trigger draft PR creation and confirm approval card appears.
11. Approve draft PR and confirm PR URL appears on task detail.
12. Confirm Linear link/status sync is idempotent.
13. Refresh mobile browser and confirm replay does not duplicate cards/events.

Adversarial checks:

- Duplicate PR create attempt reuses or updates existing PR.
- Duplicate Linear link attempt does not spam links/comments.
- Provider auth failure produces actionable error without leaking provider config.
- Closed-unmerged PR does not mark Linear issue Done.
- Force push remains blocked.
- Auto-merge remains unavailable.

## Verification

Preferred commands:

```bash
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm build
cd controller && node_modules/.bin/tsc --noEmit
```

Provider e2e tests should auto-skip unless explicit provider config is present. Default CI/local checks must not require real GitHub/Linear access.
