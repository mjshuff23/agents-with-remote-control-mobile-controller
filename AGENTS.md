# AGENTS.md

Instructions for AI coding agents working on this repository.

If you are an AI agent reading this: this file is your briefing. The human running you expects you to follow it.

---

## What this repo is

A local-first orchestration system that lets a human run CLI coding agents from their PC and control them from their phone.

Read these in order:

1. [`README.md`](./README.md) — high-level intent and current phase map
2. [`PLAN.md`](./PLAN.md) — current Phase 4.5 remote-access baseline and smoke tests
3. [`docs/remote-access.md`](./docs/remote-access.md) — active Phase 4.5 handoff
4. [`docs/phase-4-implementation.md`](./docs/phase-4-implementation.md) — completed Phase 4 handoff
5. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — system design and module boundaries
6. [`docs/SAFETY.md`](./docs/SAFETY.md) — what you can and cannot do
7. [`docs/diagrams.md`](./docs/diagrams.md) — canonical diagrams

---

## Phase boundaries

Linear is the source of truth for phase scope.

| Phase | Linear | Status |
|---|---|---|
| 1 | [TSH-77](https://linear.app/michaelshuff/issue/TSH-77) | Complete — local REST orchestrator + Codex runner |
| 2 | [TSH-78](https://linear.app/michaelshuff/issue/TSH-78) | Complete — WebSocket gateway + controller UI |
| 3 | [TSH-79](https://linear.app/michaelshuff/issue/TSH-79) | Complete — worktree isolation + approval gates |
| 3.5 | [TSH-83](https://linear.app/michaelshuff/issue/TSH-83) | Complete — durable replay, checkpoints, reconnect, provider seams |
| 4 | [TSH-80](https://linear.app/michaelshuff/issue/TSH-80) | Complete — GitHub + Linear issue-to-PR sync |
| 4.5 | [TSH-111](https://linear.app/michaelshuff/issue/TSH-111) | Active frontier — Tailscale remote-access baseline |
| 5 | [TSH-81](https://linear.app/michaelshuff/issue/TSH-81) | Deferred — Notion, Figma, controlled MCP sync; depends on Phase 4.5 |
| 6 | [TSH-82](https://linear.app/michaelshuff/issue/TSH-82) | Deferred — multi-agent review workflows |

Do not implement work from a later phase while the active phase is open. If work belongs to a later phase, stop and ask.

---

## Active Phase 4.5 scope

Phase 4.5 establishes the private remote-access path that daily mobile approvals depend on:

```text
phone browser -> Tailscale private overlay -> Windows host -> WSL2 orchestrator/controller
```

Current Phase 4.5 ticket:

| Linear | Focus |
|---|---|
| TSH-111 | Tailscale remote access baseline and mobile smoke test |

Phase 5 remains blocked until the Tailscale baseline and phone smoke are documented.

Completed Phase 4 child tickets: `TSH-97`, `TSH-98`, `TSH-99`, `TSH-100`, `TSH-101`, `TSH-102`, `TSH-103`, `TSH-104`, `TSH-105`, `TSH-106`, `TSH-107`, `TSH-108`, `TSH-109`, `TSH-110`.

---

## Safety constraints

The repo builds and follows a three-tier safety model.

### Always allowed

- Read files inside this repo.
- Run lint, type-check, and test commands declared in repo config.
- Summarize, plan, propose patches.
- Read documentation.

### Always require explicit human approval

- Edit, create, or delete files outside `worktrees/` or scratch dirs.
- `git add`, `git commit`, `git push`, `git rebase`, `git merge`.
- Create or delete branches.
- Open or update pull requests.
- Install or update packages.
- Run database migrations.
- Update GitHub, Linear, Notion, Figma, or any external service.
- Modify CI/pipeline files.
- Modify hooks.

### Refuse outright

- Read `.env`, `*.pem`, `*.key`, `id_*`, anything in `~/.ssh/`, or anything matching secrets patterns.
- Force push to any branch.
- Disable hooks or skip signing.
- Production deploys.
- Modify auth credentials.
- Run pipe-from-internet shell commands.
- `rm -rf` outside the repo or worktree.
- Modify global system config.

If unsure, ask. The cost of a paused tool call is cheap. The cost of a misclassified destructive action is unbounded.

---

## Phase 4 implementation rules

- Provider SDK/API calls belong inside provider adapters, not controllers or React components.
- Orchestration services compose providers, approvals, audit logs, tasks, sessions, and SyncEvents.
- Provider writes must be idempotent.
- Duplicate PRs, duplicate Linear links, duplicate comments, and duplicate status updates are bugs.
- Store only recovery-safe provider metadata: IDs, URLs, timestamps, action category, failure category.
- Do not store raw provider responses by default.
- Do not log provider credentials or provider config.
- No auto-merge.
- No auto-deploy.
- No force-push.

## Phase 4.5 remote-access rules

- Tailscale is the default daily remote-access path.
- `ARC_HOST=0.0.0.0` requires `ARC_ALLOW_PUBLIC_BIND=true`.
- Public binding is acceptable only behind Tailscale or an equivalent trusted private overlay.
- Do not configure router port forwarding, public DNS, ngrok, Cloudflare Tunnel, Tailscale Funnel, or public internet exposure for TSH-111.
- Do not commit real controller secrets, Tailscale IPs, MagicDNS hostnames, tailnet names, auth keys, or personal device metadata.
- If direct Windows Tailscale IP access to WSL-bound ports fails, document the selected WSL mirrored networking/firewall or scoped `netsh interface portproxy` fix.
- If using a Windows port proxy, prefer binding the proxy to the Tailscale host IP rather than all interfaces.

---

## Cooperative approval protocol

When native CLI approval hooks are unavailable, agents cooperate with the orchestrator using exactly one machine-readable stdout line:

```text
ARC_ACTION_REQUEST {"id":"<uuid>","actionType":"fs.write_patch | fs.delete | pkg.install | db.migrate | git.commit | git.push | git.branch | test.run | shell.command | provider.github | provider.linear","riskLevel":"SAFE | NEEDS_APPROVAL | BLOCKED","title":"Short title","rationale":"Why this is needed","command":["arg1","arg2"],"files":["path/a"],"expectedEffect":"One sentence"}
```

The orchestrator classifies the request, creates an `ApprovalRequest` row when relevant, emits `approval.requested` or `policy.violation`, and replies over stdin:

```text
ARC_APPROVAL {"id":"<uuid>","decision":"approved | denied | expired | refused","message":"operator guidance","constraints":["..."]}
```

Agent rules:

- If denied, do not retry the same request by paraphrasing it.
- If expired, treat it as denied.
- If refused or `BLOCKED`, do not ask again.
- If approved, execute only the exact approved action inside the task worktree.
- After mutating actions, produce or allow a diff summary.

---

## Conventions

### Branches

- Feature: `agent/<linear-id>-<slug>` or Phase 4 issue-linked equivalent.
- Docs: `docs/<slug>`.
- Never commit directly to `main` unless the human explicitly asks for a direct docs-only update. Prefer a PR.

### Commits

- Imperative mood.
- Reference Linear issue ID in body when relevant: `Refs: TSH-80`.
- Small, focused commits.

### Code

- TypeScript everywhere on orchestrator and controller.
- NestJS modules map cleanly to source folders.
- Provider clients stay thin.
- Feature services own orchestration.
- React components call app APIs/hooks, not provider SDKs.

### Tests

- Tests live next to code or in `test/` for e2e/integration coverage.
- Phase 4 tests must not require real GitHub/Linear access by default.
- Real provider tests must auto-skip unless explicit provider config is present.
- Fixtures should cover issues, branches, PRs, Linear issues, workflow states, and provider failures.

### Docs

- Update `README.md`, `PLAN.md`, and relevant `docs/` files with the same PR as code changes.
- Current Phase 4 handoff lives at [`docs/phase-4-implementation.md`](./docs/phase-4-implementation.md).
- Mermaid diagrams in `docs/diagrams.md` remain canonical for GitHub-rendered diagrams.

---

## Working with Linear

Every meaningful task should be linked to a Linear issue. The Linear issue ID belongs in:

- branch names,
- PR titles,
- commit bodies,
- implementation notes.

Sub-tasks of a phase issue are tracked as Linear sub-issues with `parent` set to the phase issue.

---

## Working with GitHub

Use GitHub only through approved local tools and explicit human-approved actions.

Phase 4 will add GitHub issue search, branch, push, and draft PR workflows to the controller. Until that is implemented, keep GitHub changes focused and auditable.

Always keep PRs draft until tests and lint pass.

---

## Build / test commands

Root orchestrator:

```bash
pnpm install
pnpm prisma:generate
pnpm prisma:migrate
pnpm start:dev
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm build
```

Controller UI:

```bash
cd controller
pnpm install
pnpm dev
node_modules/.bin/tsc --noEmit
```

Useful local smoke path:

1. Start the orchestrator on `127.0.0.1:3000`.
2. Start the controller on `localhost:3001`.
3. Create a task from the controller.
4. Confirm live logs arrive over WebSocket.
5. Send input with Continue.
6. Stop the task and confirm terminal status updates.
7. For Phase 4 work, verify replay does not duplicate sync/approval UI.

---

## Stop conditions

Stop and ask the human if any of these are true:

- A change crosses phase boundaries.
- A test or lint command is failing and the fix is not obvious.
- An action would touch the BLOCKED list above.
- A change would modify the safety model itself.
- You discover unexpected file, branch, provider state, or local config.

---

## When in doubt

Read first, keep changes small, preserve the approval model, and do not turn a local-first controller into a provider-write cannon.
