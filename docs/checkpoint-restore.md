# Checkpoint / Restore (Dormant Sessions)

TSH-87 implements **application-level checkpoint/restore** for agent control
state. This is not OS-level or VM-level suspend/resume — the goal is to persist
the recoverable frontier so the task detail view can be rehydrated and the
worker can be safely relaunched in the preserved worktree context.

---

## What is restored

- Task/session control state
- Durable history (logs, events, approvals)
- Latest event cursor / frontier
- Last user/assistant context needed to continue
- Pending approvals and audit state
- Worktree path, branch, base commit metadata
- Latest diff summary and test summary

## What is NOT restored

- Exact PTY process memory or call stack
- In-flight shell execution not durably represented
- Transient OS handles or sockets
- Any worker-local state that was never persisted

---

## Session lifecycle states

| State | Meaning | Checkpoint |
|-------|---------|------------|
| `active` (starting/running) | Task is working or ready | Captured at boundaries |
| `waiting_approval` | Agent needs human decision | Idle → dormant blocked |
| `dormant` | Session checkpointed, recoverable | Captured on entry |
| `completed` / `failed` / `stopped` | Terminal | Captured before transition |

---

## Dormant transition policy

A session transitions to `dormant` only when **all** of these are true:

1. Session is not already terminal or dormant
2. No pending critical approval (`waiting_approval`)
3. Idle timeout (`ARC_DORMANT_TIMEOUT_MS`, default 30 min) has elapsed since
   both `lastUserActivityAt` and `lastWorkerActivityAt`
4. A valid checkpoint can be captured

The safety gate is implemented in `CheckpointsService.canTransitionToDormant()`.

On dormant transition:
1. A `SessionCheckpoint` is captured with real task/worktree/approval/diff data
2. Session and task status update to `dormant`
3. `session.dormant` WebSocket event is emitted
4. Audit log entry is appended

---

## Checkpoint content

Each `SessionCheckpoint` row stores:

- **Schema version** for forward compatibility
- **Durable event cursor** — last monotonic event seq, for reconnection
- **Activity timestamps** — lastUserActivityAt, lastWorkerActivityAt
- **Worker liveness** — whether the process was live at capture time
- **Launch metadata** — agent name, repo path, worktree path, branch
- **Frontier** — serialized task prompt/instructions
- **Conversation context** — last user message, last assistant message
- **Pending approval references** — which approvals are open
- **Worktree metadata** — path, branch, base commit, current HEAD, repo root
- **Latest diff/test summary IDs** — references to existing summary tables

Checkpoints are **not** a second authoritative event log. The durable ledger
(`TaskEvent`, `AgentLog`) remains the source of truth for history. Checkpoints
are compact frontier snapshots layered on top for safe continuation.

---

## Boundaries

Checkpoints are captured at these meaningful boundaries:

| Boundary | Reason | Trigger |
|----------|--------|---------|
| Session start | `session_start` | After `createAndStart` completes |
| User input | `user_turn` | After `sendInput` with user message |
| Approval event | `approval_event` | After `resolveApproval` |
| Pre-terminal | `pre_terminal` | Before completed/failed transition |
| Pre-stop | `pre_stop` | Before stop transition |
| Idle timeout | `idle_timeout` | Dormancy checker periodic scan |

---

## Restore flow

1. User clicks "Resume" on a dormant task in the controller UI
2. `POST /tasks/:id/restore` is called
3. `AgentSessionsService.restoreSession()` validates the session is dormant
4. Checkpoint is loaded and worktree path existence is verified
5. Agent adapter is started with the preserved worktree/branch context
6. Restored prompt includes cooperative safety instructions + continuation context
7. On success, `checkpoints.restore()` flips DB status to `running`
8. `session.restored` WebSocket event is emitted
9. On failure, session stays dormant and error is reported

---

## Controller UI

Dormant sessions are visible in:
- **Dashboard** — shows `dormant` badge (purple)
- **Task detail** — dormant banner with worktree info, checkpoint timestamp,
  latest diff/test summaries, and a Resume button

The `useTaskSocket` hook handles `session.dormant` and `session.restored`
events, updating runtime state and appending synthetic log entries.

---

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `ARC_DORMANT_TIMEOUT_MS` | 1800000 (30 min) | Idle timeout before dormancy |
| `ARC_DORMANT_CHECK_INTERVAL_MS` | 60000 (60 s) | How often to scan for idle sessions |

---

## Tests

- `checkpoints.service.spec.ts` — `canTransitionToDormant` gate, `capture`,
  `transitionToDormant`, `restore`, `captureAtBoundary`
- `agent-sessions.service.spec.ts` — `restoreSession` with agent relaunch,
  `createAndStart` with `captureAtBoundary('session_start')`
