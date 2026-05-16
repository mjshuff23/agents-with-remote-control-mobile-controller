# Phase 4.5 Remote Access Baseline Plan

## Summary

Phases 1, 2, 3, 3.5, and 4 are complete. Phase 4.5 is the active operational prerequisite for Linear `TSH-111`: establish Tailscale as the default private remote-access path for daily mobile controller use before Phase 5 external synchronization expands to Notion, Figma, and MCP.

Phase 5 (`TSH-81`) remains deferred until this baseline is validated. Phase 4's GitHub + Linear runtime contract is retained below as the completed sync foundation that the remote-access smoke must exercise from the phone.

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

Default remote-access setup: [`docs/remote-access.md`](docs/remote-access.md).

## Phase 4.5 Runtime Contract

The daily remote path is:

```text
phone browser -> Tailscale private overlay -> Windows host -> WSL2 orchestrator/controller
```

Required local config:

```bash
# root .env
ARC_HOST=0.0.0.0
ARC_ALLOW_PUBLIC_BIND=true

# controller/.env.local
NEXT_PUBLIC_WS_URL=http://<tailscale-host>:3000
BACKEND_URL=http://127.0.0.1:3000
NEXT_PUBLIC_CONTROLLER_SECRET=<local-controller-secret>
CONTROLLER_SECRET=<local-controller-secret>
```

`<tailscale-host>` must be a placeholder-safe Tailscale `100.x.y.z` address or a MagicDNS name. Do not commit real Tailscale IPs, MagicDNS hostnames, tailnet names, auth keys, or controller secrets.

Public binding is acceptable only behind a trusted private overlay such as Tailscale. It is not a public deployment setting.

## Phase 4 Runtime Contract

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

## Completed Phase 4 Child Tickets

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

## Active Phase 4.5 Ticket

| Linear | Purpose |
|---|---|
| `TSH-111` | Tailscale remote access baseline and mobile smoke test |

Acceptance emphasis:

- Windows host and phone are on the same tailnet.
- Latest stable Tailscale versions available on implementation day are recorded.
- Controller loads from the phone over cellular or non-home WiFi.
- REST and WebSocket auth both require the controller secret.
- Task list, task detail, replay, approval cards, and a real approval decision work from the phone.
- Windows/WSL2 networking path is documented, including mirrored networking or scoped `netsh interface portproxy` if direct access fails.
- No cloud tunnel, public port forwarding, public IP exposure, public DNS, or Tailscale Funnel is required.

## Configuration

Existing environment stays valid for local-only development:

```bash
ARC_HOST="127.0.0.1"
ARC_ALLOW_PUBLIC_BIND="false"
ARC_WORKTREE_ROOT=""
ARC_POLICY_PATH="arc.config.json"
ARC_APPROVAL_TIMEOUT_MS="300000"
ARC_TEST_COMMAND_TIMEOUT_MS="600000"
```

Phase 4.5 deliberately overrides `ARC_HOST` only for Tailscale/private-overlay use. Keep provider config documented in `.env.example`; do not store provider credentials in DB records, task event payloads, logs, or controller-visible error details.

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

## Phase 4.5 Manual Smoke Test

With the orchestrator and controller running behind Tailscale:

1. Update Windows and phone Tailscale clients to the latest stable versions available on the smoke date.
2. Record both installed versions in PR notes or implementation notes.
3. Confirm both devices are connected to the same tailnet.
4. Verify the selected host address:
   - MagicDNS machine name if MagicDNS is enabled and tested; or
   - stable Tailscale `100.x.y.z` IP if MagicDNS is not used.
5. Open `http://<tailscale-host>:3001` from the phone on cellular or non-home WiFi.
6. Confirm WebSocket connection succeeds with matching controller secret config.
7. Confirm WebSocket connection fails with a missing or mismatched controller secret.
8. Confirm REST task actions fail without `CONTROLLER_SECRET`.
9. Confirm REST task actions succeed through the controller proxy with `CONTROLLER_SECRET`.
10. Confirm task list, task detail, replay, and approval cards render correctly from the phone.
11. Complete one real approval decision from the phone outside the home LAN.
12. Document the Windows/WSL2 networking path used. If direct WSL-bound ports over the Windows Tailscale IP fail, document the selected fix and keep any port proxy bound to the Tailscale IP where practical.

## Completed Phase 4 Manual Smoke Test

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

Phase 4.5 adds explicit local coverage for:

- REST task actions returning `401` without or with a wrong controller secret, then succeeding with the correct secret.
- WebSocket connections disconnecting without or with a wrong controller secret, then succeeding with the correct secret.

Provider e2e tests should auto-skip unless explicit provider config is present. Default CI/local checks must not require real GitHub/Linear access.
