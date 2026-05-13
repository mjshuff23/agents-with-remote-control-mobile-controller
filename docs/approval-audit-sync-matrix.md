# Approval, Audit, and Sync Event Integration Matrix

## Overview

This document defines the relationship between Phase 3 approvals/audit logs and Phase 4 provider sync events. All provider actions are approval-gated and audit-logged.

## Action Classification

### Approval-Required Actions

| Action | Type | Risk Level | Approval Gate | Audit Entry | SyncEvent |
|--------|------|-----------|---|---|---|
| Create branch | git.branch | NEEDS_APPROVAL | Yes | Yes | No |
| Create commit | git.commit | NEEDS_APPROVAL | Yes | Yes | No |
| Push to remote | git.push | NEEDS_APPROVAL | Yes | Yes | No |
| Create draft PR | provider.github | NEEDS_APPROVAL | Yes | Yes | Yes |
| Update Linear status | provider.linear | NEEDS_APPROVAL | Yes | Yes | Yes |
| Attach PR link to Linear | provider.linear | NEEDS_APPROVAL | Yes | Yes | Yes |

### Auto-Allowed Actions (Logged but not gated)

| Action | Type | Risk Level | Audit Entry | SyncEvent |
|--------|------|-----------|---|---|
| Fetch issue metadata | provider.github | SAFE | Yes | No |
| Fetch issue metadata | provider.linear | SAFE | Yes | No |
| Detect PR merge | provider.github | SAFE | Yes | No |

## Data Relationships

```text
Task
├── ApprovalRequest (one-to-many)
│   └── AuditLog (one-to-many, via approvalRequestId)
├── AuditLog (one-to-many, direct)
├── SyncEvent (one-to-many)
└── AgentSession (one-to-many)
    ├── ApprovalRequest (one-to-many, via sessionId)
    ├── AuditLog (one-to-many, via sessionId)
    └── SyncEvent (one-to-many, via sessionId)
```

## Approval → Audit → Sync Flow

### Example: Approved Commit

1. **Agent requests approval** (ARC_ACTION_REQUEST)
   - `ApprovalRequest` created with status="pending"
   - `AuditLog` entry: kind="approval_requested", actionType="git.commit"

2. **Human approves** (ARC_APPROVAL)
   - `ApprovalRequest` updated: status="approved", decision="approved"
   - `AuditLog` entry: kind="approval_decision", decision="approved"

3. **Commit executed**
   - `AuditLog` entry: kind="action_executed", actionType="git.commit", message="Commit SHA: abc123"

### Example: Approved Draft PR Creation

1. **Agent requests approval**
   - `ApprovalRequest` created with status="pending"
   - `AuditLog` entry: kind="approval_requested", actionType="provider.github"

2. **Human approves**
   - `ApprovalRequest` updated: status="approved"
   - `AuditLog` entry: kind="approval_decision", decision="approved"

3. **PR created**
   - `SyncEvent` created: provider="github", action="create_pr", status="completed", externalId="PR#123"
   - `AuditLog` entry: kind="sync_event_completed", actionType="provider.github", message="PR #123 created"

4. **Linear status updated** (if linked)
   - `SyncEvent` created: provider="linear", action="update_status", status="completed"
   - `AuditLog` entry: kind="sync_event_completed", actionType="provider.linear"

## Audit Log Entry Types

| Kind | When | Fields |
|------|------|--------|
| approval_requested | Agent requests approval | actionType, riskLevel, ruleMatched (if blocked) |
| approval_decision | Human approves/denies | decision, decisionMessage |
| action_executed | Action completes | actionType, message (e.g., commit SHA) |
| sync_event_created | SyncEvent starts | actionType, targetId |
| sync_event_completed | SyncEvent succeeds | actionType, externalId, url |
| sync_event_failed | SyncEvent fails | actionType, errorCategory, errorMessage |
| policy_violation | Action blocked by policy | ruleMatched, message |

## SyncEvent Idempotency

All SyncEvents use a unique constraint to prevent duplicates:

```sql
UNIQUE(taskId, provider, targetId, action)
```

Example:

- `(task-1, github, pr-123, create_pr)` — only one record per PR creation attempt
- `(task-1, linear, issue-456, update_status)` — only one record per status update

On retry, the existing SyncEvent is updated (status, externalId, errorMessage) rather than creating a new one.

## Controller Timeline Display

The controller displays a unified approval/sync timeline:

```bash
GET /tasks/:id/timeline
```

Returns events in chronological order:

- ApprovalRequest (pending, approved, denied, expired)
- AuditLog entries (approval_decision, action_executed, sync_event_completed)
- SyncEvent status changes

## Testing Strategy

1. **Unit tests**: Verify approval → audit → sync chain for each action type
2. **Integration tests**: Mock provider responses and verify SyncEvent creation/update
3. **E2E tests**: Real provider access (token-gated) for full flow validation

## Future Enhancements

- Approval delegation (e.g., "auto-approve commits after first approval")
- Audit log retention policies
- Sync event retry strategies with exponential backoff
- Webhook-based PR merge detection
