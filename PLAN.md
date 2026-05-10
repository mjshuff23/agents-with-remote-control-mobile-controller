# Phase 1 Implementation Plan

## Summary

Phase 1 builds the local orchestrator only: a root-level NestJS backend that starts one Codex CLI task, persists task/session/log state in SQLite through Prisma, and exposes REST endpoints for create/list/inspect/stop.

Canonical scope is Linear `TSH-77` and GitHub issue `#2`. If later architecture docs mention WebSockets, worktrees, approval gates, external sync, a controller UI, or additional agent adapters, those remain deferred.

## Current Phase 1 Scope

In scope:

- Single NestJS app at the repository root.
- Prisma + SQLite schema with only `Task`, `AgentSession`, and `AgentLog`.
- One adapter interface and one concrete `CodexAdapter`.
- `node-pty` process launch using argument arrays, not shell-string composition.
- REST-only API: `POST /tasks`, `GET /tasks`, `GET /tasks/:id`, `POST /tasks/:id/stop`.
- Structured `application/problem+json` error responses.
- Automated tests using a mocked adapter; real Codex/WSL validation stays manual.

Deferred:

- WebSockets and live controller UI.
- Git worktree creation and diff/test approval flows.
- `ApprovalRequest`, `GitChangeSummary`, `SyncEvent`, and audit-gate tables.
- GitHub, Linear, Notion, Figma, or MCP sync.
- Claude Code, Gemini, or multi-agent workflows.
- `POST /tasks/:id/continue` until real Codex resume behavior is validated.

## Runtime Contract

`POST /tasks` accepts:

```json
{
  "prompt": "Summarize this repo",
  "agent": "codex",
  "title": "Optional title"
}
```

The server uses `ARC_REPO_PATH` from configuration and does not accept arbitrary repo paths from clients in Phase 1. A successful create returns `201 Created` with `Location: /tasks/:id` and a task/session summary.

Status values:

- `Task.status`: `queued`, `running`, `completed`, `failed`, `stopped`
- `AgentSession.status`: `starting`, `running`, `completed`, `failed`, `stopping`, `stopped`
- `AgentLog.type`: `stdout`, `stderr`, `system`

Logs are persisted with an incrementing `sequence` per session. If the orchestrator restarts while a session is marked live, startup recovery marks that session terminal so it remains inspectable instead of pretending the process is still attached.

## Local Setup

Create local environment config:

```bash
cp .env.example .env
```

Edit `.env` so `ARC_REPO_PATH` points to the Linux-side checkout the agent should work in. Keep `ARC_HOST=127.0.0.1` unless you are deliberately testing a LAN exposure path.

Install dependencies and prepare Prisma:

```bash
pnpm install
pnpm prisma:generate
pnpm prisma:migrate
```

If `pnpm` is not installed on this machine, use the project-compatible fallback:

```bash
npm exec --yes pnpm@10.18.3 -- install
npm exec --yes pnpm@10.18.3 -- prisma:generate
npm exec --yes pnpm@10.18.3 -- prisma:migrate
```

Run the app:

```bash
pnpm start:dev
```

## Manual Smoke Test

With the app running on `127.0.0.1:3000` and local Codex auth already configured:

```bash
curl -i -X POST http://127.0.0.1:3000/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Say hello from Codex and then stop.","agent":"codex","title":"Smoke test"}'
```

Use the returned task id:

```bash
curl http://127.0.0.1:3000/tasks/<task-id>
curl http://127.0.0.1:3000/tasks
curl -i -X POST http://127.0.0.1:3000/tasks/<task-id>/stop
```

Expected result: the task/session is persisted, log rows appear in the `logs` tail, and the session remains inspectable after the agent exits.

## Verification

Automated checks:

```bash
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm build
```

The e2e suite mocks the adapter so CI and local verification do not require WSL or a real Codex login. The real process path is intentionally covered by the manual smoke test above.
