# Architecture

This document is the in-depth companion to [`README.md`](../README.md). It captures the system's working architecture, modules, data model, and the decisions behind them.

---

## Layered view

| Layer | Role | Tech |
|---|---|---|
| **Phone / Web Controller** | Remote command surface — start tasks, watch logs, approve actions, inspect diffs | Next.js (App Router) or React+Vite, mobile-first, PWA later |
| **Local Orchestrator** | Nervous system — owns task state, spawns agents, brokers approval, persists everything | NestJS + SQLite + WebSocket gateway |
| **Agent Adapter Layer** | Swappable interface for CLI agents | TypeScript interface, one adapter per agent |
| **CLI Agents** | Execution engines | Codex CLI → Claude Code → Gemini |
| **Repo Worktrees** | Per-task isolated working trees | `git worktree add` |
| **External Sync** | Project-management and design integration | GitHub, Linear, Notion, Figma, MCP servers |

---

## Modules in the orchestrator

These are the NestJS modules the orchestrator is built around. Names are intentional — they should map 1:1 to source folders.

### TaskModule
- Owns the `Task` entity and its lifecycle.
- Endpoints: create / get / list / cancel.
- Emits domain events (`task.created`, `task.cancelled`).

### AgentSessionModule
- Owns the live link between a `Task` and a running agent process.
- Tracks `AgentSession` state (`pending → running → blocked → completed | failed | stopped`).
- Streams logs into `AgentLog`.

### AgentAdapterModule
- Houses the `AgentAdapter` interface + concrete adapters.
- Phase 1: `CodexAdapter`.
- Phase 2 work touches this module (events emitted on input requests).
- Phase 6 grows it: `ClaudeAdapter`, `GeminiAdapter`.

### GitModule
- Worktree creation + lifecycle.
- Diff summarizing.
- Branch naming (`agent/<task-id>-<slug>`).

### ApprovalGateModule
- Risk classification engine.
- Three-tier action taxonomy (see [`SAFETY.md`](SAFETY.md)).
- `ApprovalRequest` lifecycle: `pending → approved | denied | expired`.

### NotificationModule
- Pushes approval requests + status changes to the controller.
- Phase 2: WebSocket events.
- Phase 6: Web Push for PWA + optional Telegram/Discord prototype.

### SyncModule
- Outbound integrations.
- Phase 4: GitHub + Linear.
- Phase 5: Notion + Figma + MCP.
- All sync events recorded in `SyncEvent`.

### AuditLogModule
- Append-only log of every approval, denial, and risk-classification decision.
- Source of truth for "what did the agent ask, and what did the human decide?"

---

## Agent adapter interface

```typescript
interface AgentAdapter {
  name: 'codex' | 'claude' | 'gemini';

  startTask(input: {
    repoPath: string;
    worktreePath: string;
    branchName: string;
    prompt: string;
  }): Promise<AgentSession>;

  continueTask(input: {
    sessionId: string;
    message: string;
  }): Promise<AgentSession>;

  stopTask(sessionId: string): Promise<void>;

  getStatus(sessionId: string): Promise<AgentSessionStatus>;
}
```

**Why this shape:**
- The orchestrator never talks directly to a specific agent — it goes through the adapter.
- Phase 1 ships exactly one adapter (`CodexAdapter`) to prove the contract.
- Adding Claude/Gemini in Phase 6 is "implement the interface, register the adapter," not a refactor.

---

## Data model (MVP)

SQLite first. Migration to Postgres only if/when concurrency or multi-host requirements demand it.

| Entity | Purpose |
|---|---|
| **Task** | The user-initiated unit of work — title, prompt, status, selected agent, repo/worktree paths, branch name |
| **AgentSession** | A single attempt at executing the task with an agent — status, start/end timestamps, external session id |
| **AgentLog** | Append-only log entries (`stdout`, `stderr`, `system`, `user`, `agent`) |
| **ApprovalRequest** | One approval ask with action type, description, risk level, decision |
| **GitChangeSummary** | Snapshot of files changed, +/- counts, narrative summary per session/step |
| **SyncEvent** | Outbound integration record — target (`GitHub` / `Linear` / `Figma` / `Notion`), action, status, external URL |

ERD: see [`diagrams.md`](diagrams.md#4-database-erd).

---

## Communication transport

| Direction | Mechanism | Why |
|---|---|---|
| Controller → Orchestrator (one-shot commands) | REST | Simple, cacheable, easy to debug |
| Orchestrator → Controller (events) | **WebSocket** | Server push is required for live logs, approval prompts, status changes |
| Bidirectional task chat | WebSocket | Full duplex |
| Future: phone push notifications | Web Push (PWA) | Wake the user when off-app |

Long polling is intentionally **not** the primary mechanism — it is client-initiated and not full duplex, which makes server-push patterns awkward. WebSockets win for this use case.

---

## Git worktree isolation

Every task runs in its own worktree:

```text
agents-with-remote-control-mobile-controller/   ← main checkout
../arc-task-001/                                  ← worktree for task 1
../arc-task-002/                                  ← worktree for task 2
```

Branch convention: `agent/<task-id>-<slug>` (e.g., `agent/task-001-bootstrap-orchestrator`).

**Benefits:**
- No cross-task contamination — concurrent tasks can't step on each other.
- Cheap — `git worktree add` shares the object DB; only the working tree consumes disk.
- Clean diffs per task.
- Easy PR creation (push the worktree's branch).
- Damage from a misbehaving agent is bounded to one worktree.

Cleanup: `git worktree remove` after the PR merges or the task is cancelled.

---

## Task lifecycle (high level)

1. **Create** — phone hits `POST /tasks` with `{ prompt, agent, repoUrl }`.
2. **Worktree** — orchestrator creates worktree + branch.
3. **Launch** — `AgentAdapter.startTask(...)` spawns the CLI agent.
4. **Stream** — stdout/stderr stream to controller via WebSocket; persisted to `AgentLog`.
5. **Gate** — agent requests approval for any non-SAFE action; controller renders the request.
6. **Decide** — human approves / denies / steers via free-text.
7. **Continue** — orchestrator forwards decision to agent; loop until done or stopped.
8. **Summarize** — `GitChangeSummary` captures diff + narrative.
9. **Sync** (Phase 4+) — commit, push, open draft PR, update Linear, post Notion summary.
10. **Cleanup** — remove worktree once PR merged or task closed.

Detailed flow: [`diagrams.md`](diagrams.md#2-task-lifecycle-flow).

---

## Decisions worth surfacing

### Why CLI agents and not VS Code chat extensions?
CLI agents have stable stdin/stdout contracts and a long history of being scriptable. VS Code chat panels are GUIs with private interaction protocols — automating them is fragile and ethically questionable. CLI is the right seam.

### Why NestJS over a hand-rolled Node server?
Modules, DI, lifecycle, validators, guards, and WebSocket support are all first-class. The structure of the orchestrator (TaskModule, AgentSessionModule, ApprovalGateModule, ...) maps cleanly to Nest modules. The cost of carrying NestJS for an MVP is small relative to the readability win.

### Why SQLite first?
Single host, single user, embedded, zero ops. The day this matters is the day Phase 6 actually has parallel agents writing concurrently — at which point migrating to Postgres is a known and small project.

### Why default-deny on the safety model?
Because the human is on a phone, with a smaller screen and less context than at the keyboard. The worst possible default is "let it through and trust the agent." The cost of a false denial is a single tap to override; the cost of a false allow is unbounded.

### Why no auto-merge?
Even after every approval, merging stays a deliberate human action. This is a guardrail against drift — a system that auto-merges with approvals quickly becomes "look at the green check and merge," which is identical in outcome to no approval at all.

---

## Alternatives considered

See [`diagrams.md`](diagrams.md#7-alternatives-considered) for a comparative diagram. Briefly:

| Alternative | Why rejected (for now) |
|---|---|
| Direct VS Code chat control | Fragile, GUI-coupled, no stable protocol |
| VS Code extension first | Locks the UX to one editor and one machine |
| Telegram/Discord bot prototype | Useful for fast prototyping, but locks notification + auth into a third-party platform; might revisit as a shortcut for Phase 2 |
| Full custom PWA from day 1 | Premature — REST + WS are enough for v1; PWA wraps come later |
| Long polling | Not full duplex; not the right tool for live agent interaction |
| SSE | One-way (server → client); we need bidirectional |

---

## Phase boundaries

The phased plan in the README is more than scheduling — it's a contract about what each phase ships and what it intentionally defers. See [`/.linear` issues](https://linear.app/michaelshuff/project/agents-with-remote-control-mobile-controller-181d4f51202c) for the canonical scope per phase.

The most important deferral: **no external integrations until the local loop is solid**. Phase 4 (GitHub + Linear sync) does not begin until Phases 1-3 have been used end-to-end.
