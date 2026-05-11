# Agents With Remote Control Mobile Controller

> Local-first agent orchestration: control CLI coding agents (Codex, Claude Code, Gemini) from your phone, with approval gates and Git worktree isolation.

**Status:** Phase 2 complete. The local orchestrator runs with a socket.io WebSocket gateway and a Next.js mobile-first controller UI. You can start tasks, watch live agent output stream in real time, send input to the agent, and stop tasks — all from a phone browser. Phase 3 (worktree isolation + approval gates) is next.

---

## TL;DR

Run AI coding agents on your PC. Control them from your phone. The agent works in an isolated Git worktree. When it needs to commit, push, install something, or do anything risky, it asks you on your phone. You approve, deny, or steer with free-text. When it's done, it opens a draft PR.

## Current implementation scope

Phases 1 and 2 are complete. The code in this repo currently ships:

**Phase 1 — Local orchestrator**
- A root-level NestJS REST API.
- Prisma + SQLite persistence for `Task`, `AgentSession`, and `AgentLog`.
- A single `CodexAdapter` that launches `codex exec --json --cd <repoPath> -` through `node-pty`.
- REST endpoints: `POST /tasks`, `GET /tasks`, `GET /tasks/:id`, `POST /tasks/:id/stop`.
- Problem-details style JSON errors.

**Phase 2 — WebSocket gateway + controller UI**
- socket.io WebSocket gateway at the orchestrator root with `CONTROLLER_SECRET` bearer auth.
- Per-task rooms (`task:<id>`); the server emits `task.started`, `agent.log`, and `task.completed` as they happen.
- `POST /tasks/:id/input` REST endpoint that writes to the agent PTY stdin (requires the agent to support interactive input).
- Next.js 15 App Router controller UI in `controller/` (port 3001), proxied to the orchestrator via `next.config.ts` rewrites.
- Three pages: Dashboard (task list, 5s polling), New Task (prompt form), Task Detail (virtual log pane + live WebSocket updates, Continue/Stop actions).
- Sequence-based log deduplication so REST history and live WS stream don't produce duplicates.

Deferred until later phases:

- Git worktree creation, approval gates, diffs, and audit policy tables.
- GitHub, Linear, Notion, Figma, MCP sync, and draft PR automation.
- Claude Code, Gemini, and multi-agent workflows.

See [`PLAN.md`](PLAN.md) for phase handoff contracts and manual smoke tests.

---

## Why this exists

CLI coding agents (Codex, Claude Code, Gemini) are powerful but they live tethered to a terminal session and to your physical presence at the keyboard. The moment you walk away — gym, errands, dinner — the agent stalls on the next approval prompt and waits idle.

This project gives those agents a remote command surface so the human-in-the-loop part can happen from your phone, while keeping the safety model strict by default.

It is **not** a mobile IDE. It is **not** a VS Code chat extension. It is a thin orchestrator + mobile/web controller around your existing CLI agents.

---

## Desired UX

1. Start or monitor an AI coding task from your phone.
2. The local orchestrator runs a CLI agent in WSL2.
3. The agent works inside an isolated repo worktree.
4. When the agent needs input, approval, or review, it pings your phone.
5. Reply with free text, structured actions, or approve/deny tool use, request tests, inspect summaries.
6. Continue, stop, commit, open PRs, or sync project tools — all from the phone.
7. Later, sync work across GitHub, Linear, Figma, Notion, and MCP-backed tools.

---

## Architecture (high level)

```mermaid
flowchart LR
  subgraph Mobile["Phone / Web Controller"]
    UI["Controller UI"]
  end
  subgraph Host["Local Host (Windows + WSL2)"]
    Orch["Local Orchestrator (NestJS)"]
    WSL["WSL2 Runtime<br/>Codex · Claude · Gemini"]
    WT["Repo Worktrees"]
  end
  subgraph Ext["External Sync (Phase 4+)"]
    GH["GitHub"]
    LN["Linear"]
    NT["Notion"]
    FG["Figma"]
    MCP["MCP Servers"]
  end
  UI <-->|"WebSocket"| Orch
  UI -->|"REST"| Orch
  Orch --> WSL
  WSL --> WT
  Orch --> GH
  Orch --> LN
  Orch --> NT
  Orch --> FG
  Orch --> MCP
```

Full architecture, lifecycle, approval-gate state machine, ERD, and alternatives considered: [`docs/diagrams.md`](docs/diagrams.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). FigJam companion diagrams are mirrored in [`docs/figma-companion-diagrams.md`](docs/figma-companion-diagrams.md).

---

## Phased plan

| Phase | Focus | Linear |
|---|---|---|
| **1** | Local orchestrator + single-agent CLI runner | [TSH-77](https://linear.app/michaelshuff/issue/TSH-77) |
| **2** | Mobile/web controller + live session UI | [TSH-78](https://linear.app/michaelshuff/issue/TSH-78) |
| **3** | Worktree isolation + approval gates + diffs + tests | [TSH-79](https://linear.app/michaelshuff/issue/TSH-79) |
| **4** | GitHub + Linear sync (issue → branch → commit → PR) | [TSH-80](https://linear.app/michaelshuff/issue/TSH-80) |
| **5** | Notion + Figma + controlled MCP expansion | [TSH-81](https://linear.app/michaelshuff/issue/TSH-81) |
| **6** | Multi-agent review + advanced automation | [TSH-82](https://linear.app/michaelshuff/issue/TSH-82) |

**First milestone:**
> _I can send a prompt to my local orchestrator, it launches Codex CLI in WSL2, captures logs, stores the session, and returns a summary._

---

## Tech stack (current intent)

**Backend (orchestrator)**
- Node.js + TypeScript
- NestJS
- Prisma + SQLite (MVP) → Postgres later if needed
- REST endpoints for one-shot commands
- `node-pty` for wrapping the Codex CLI
- WebSocket gateway for live updates in Phase 2
- Git worktree operations in Phase 3

**Frontend (controller)**
- Next.js 15 (App Router), mobile-first, runs on port 3001
- Tailwind CSS for styling
- socket.io-client for live WS updates; `@tanstack/react-virtual` for virtualized log rendering
- PWA later
- Local LAN-only auth via `CONTROLLER_SECRET` header; harden later

**Runtime**
- Windows host
- WSL2 for agent execution
- Git worktrees for task isolation

**Agents (adapter pattern)**
- Codex CLI (first target)
- Claude Code CLI (second)
- Gemini CLI (third)

**Integrations (later phases)**
- GitHub → first
- Linear → second
- Figma + Notion → after core loop works
- MCP servers → controlled tool layer, not core architecture

---

## Safety model

Three-tier classification on every requested action:

| Tier | Examples | Behavior |
|---|---|---|
| **SAFE** | Read repo, inspect git, run tests, summarize, plan | Auto-allow, log only |
| **NEEDS APPROVAL** | Edit files, install, migrate, branch, commit, push, open PR, external sync, MCP write tools | Ping phone, wait for human |
| **BLOCKED BY DEFAULT** | Read `.env`/secrets, force push, prod deploy, modify auth, exfiltrate repo, modify global system config, run unknown shell scripts | Refuse outright, log event |

Every approval and denial is recorded in an audit log. Full taxonomy and rationale: [`docs/SAFETY.md`](docs/SAFETY.md).

---

## Communication transport

The orchestrator exposes both REST and WebSocket (socket.io) transports.

- **REST** — one-shot commands: create task, list tasks, inspect task, stop task, send input.
- **WebSocket** — live push for streaming log output and task lifecycle events (`task.started`, `agent.log`, `task.completed`). Clients authenticate by passing `CONTROLLER_SECRET` as the `auth.token` on the socket.io handshake. After connecting, clients join per-task rooms with `emit('subscribe', { taskId })`.

Long polling is intentionally avoided as a primary transport — it is client-initiated and not full-duplex.

---

## Non-goals (for now)

- Direct remote-control of VS Code chat panels (Copilot/Codex/Claude/Gemini extension UIs)
- A full mobile IDE
- Multi-agent orchestration before a single agent works end-to-end
- Auto-merge, auto-deploy, or unreviewed file deletion / force pushes / migrations / secret access

---

## Getting started

Prerequisites:

- Node.js 22+
- `pnpm`
- Local Codex CLI authentication already configured
- A Linux-side repo path for `ARC_REPO_PATH`

Install dependencies and generate Prisma:

```bash
pnpm install
pnpm prisma:generate
```

If `pnpm` is not available locally, this machine has been tested with:

```bash
npm exec --yes pnpm@10.18.3 -- install
npm exec --yes pnpm@10.18.3 -- prisma:generate
```

Create local config and initialize SQLite:

```bash
cp .env.example .env
pnpm prisma:migrate
```

Edit `.env` before running if `ARC_REPO_PATH` should point somewhere other than this checkout.

Run the orchestrator:

```bash
pnpm start:dev
```

In a separate terminal, run the controller UI:

```bash
cd controller
pnpm install
pnpm dev          # http://localhost:3001
```

The controller UI proxies API calls to the orchestrator at `http://127.0.0.1:3000`. Open `http://localhost:3001` in a browser (or on your phone via LAN IP) to start and monitor tasks.

You can also use the REST API directly:

```bash
# Start a task
curl -i -X POST http://127.0.0.1:3000/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Say hello from Codex and then stop.","agent":"codex","title":"Smoke test"}'

# Inspect it
curl http://127.0.0.1:3000/tasks/<task-id>
```

More detail:
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full system design
- [`docs/SAFETY.md`](docs/SAFETY.md) — safety model and approval gates
- [`docs/diagrams.md`](docs/diagrams.md) — all 7 system diagrams
- [`docs/figma-companion-diagrams.md`](docs/figma-companion-diagrams.md) — Mermaid mirrors of the FigJam companion boards
- [`PLAN.md`](PLAN.md) — Phase 1 runtime scope and manual smoke test
- [`AGENTS.md`](AGENTS.md) — instructions for AI agents working on this repo

---

## Project links

- **GitHub:** https://github.com/mjshuff23/agents-with-remote-control-mobile-controller
- **Linear project:** https://linear.app/michaelshuff/project/agents-with-remote-control-mobile-controller-181d4f51202c
- **Notion strategy doc:** https://www.notion.so/35bc2ea5f18f8186b134efa7759a19e6
- **Figma companion diagrams:** [`docs/figma-companion-diagrams.md`](docs/figma-companion-diagrams.md)

---

## License

[Apache 2.0](./LICENSE)
