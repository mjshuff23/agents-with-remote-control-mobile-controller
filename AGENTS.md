# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code, Gemini) working on this repository.

If you are an AI agent reading this: this file is your briefing. The human running you expects you to follow it.

---

## What this repo is

A local-first orchestration system that lets a human run CLI coding agents from their PC and control them from their phone. Yes, you may end up writing your own future supervisor. Take it seriously.

Read these in order:
1. [`README.md`](./README.md) — high-level intent and phased plan
2. [`PLAN.md`](./PLAN.md) — phase-by-phase runtime contracts and smoke tests
3. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — system design and module boundaries
4. [`docs/SAFETY.md`](./docs/SAFETY.md) — what you can and cannot do
5. [`docs/diagrams.md`](./docs/diagrams.md) — canonical diagrams

---

## Phase boundaries (canonical scope)

The current phase determines what is in-scope and what is out-of-scope. Linear is the source of truth.

| Phase | Linear | Status |
|---|---|---|
| 1 | [TSH-77](https://linear.app/michaelshuff/issue/TSH-77) | Complete — local REST orchestrator + Codex runner |
| 2 | [TSH-78](https://linear.app/michaelshuff/issue/TSH-78) | Complete — WebSocket gateway + controller UI |
| 3 | [TSH-79](https://linear.app/michaelshuff/issue/TSH-79) | Next active focus — worktree isolation + approval gates |
| 4 | [TSH-80](https://linear.app/michaelshuff/issue/TSH-80) | Deferred |
| 5 | [TSH-81](https://linear.app/michaelshuff/issue/TSH-81) | Deferred |
| 6 | [TSH-82](https://linear.app/michaelshuff/issue/TSH-82) | Deferred |

**Do not** implement work from a later phase while an earlier phase is open. If the work obviously belongs to a later phase, stop and ask.

For Phase 3, keep the scope tight: isolate each task in a Git worktree, classify requested actions, create approval records, push approval prompts over the existing WebSocket path, and summarize diffs/tests before the human approves risky next steps.

Phase 3 approval mode is `cooperative-gated` by default. Do not claim the orchestrator can perfectly intercept every CLI action unless a specific adapter hook proves that behavior in code.

---

## Safety constraints (read this carefully)

The orchestrator this repo is building enforces a three-tier safety model. **You are expected to behave consistently with that model right now**, while working on the repo itself.

### Always allowed (just do it)
- Read any file inside this repo
- Run lint, type-check, test commands declared in repo config
- Summarize, plan, propose patches
- Read documentation

### Always require explicit human approval
- Edit, create, delete files outside `worktrees/` or scratch dirs
- `git add` / `git commit` / `git push` / `git rebase` / `git merge`
- Create or delete branches
- Open or update pull requests
- Install / update packages
- Run database migrations
- Update GitHub, Linear, Notion, Figma, or any external service
- Modify CI / pipeline files
- Modify hooks (git, husky, anything that runs on commit/push)

### Refuse outright (do not even ask)
- Read `.env`, `*.pem`, `*.key`, `id_*`, anything in `~/.ssh/`, anything matching the secrets pattern
- Force push (`--force`, `--force-with-lease`) to any branch
- Disable git hooks or skip signing (`--no-verify`, `--no-gpg-sign`)
- Production deploys
- Modify auth credentials (`gh auth`, `gcloud auth`, `aws configure`)
- Run `curl ... | sh`, `wget ... | bash`, or any pipe-from-internet shell
- `rm -rf` outside the repo or worktree
- Modify global system config

If unsure, ask. The cost of a paused tool call is cheap. The cost of a misclassified destructive action is unbounded.

---

## Cooperative approval protocol

When native CLI approval hooks are unavailable, agents cooperate with the orchestrator using exactly one machine-readable stdout line:

```text
ARC_ACTION_REQUEST {"id":"<uuid>","actionType":"fs.write_patch | fs.delete | pkg.install | db.migrate | git.commit | git.push | test.run | shell.command | policy.violation","riskLevel":"SAFE | NEEDS_APPROVAL | BLOCKED","title":"Short title","rationale":"Why this is needed","command":["arg1","arg2"],"files":["path/a"],"expectedEffect":"One sentence"}
```

The orchestrator classifies the request with `arc.config.json`, creates an `ApprovalRequest` row when relevant, emits `approval.requested` or `policy.violation`, and replies over stdin:

```text
ARC_APPROVAL {"id":"<uuid>","decision":"approved | denied | expired | refused","message":"operator guidance","constraints":["..."]}
```

Agent rules:

- If denied, do not retry the same request by paraphrasing it.
- If expired, treat it as denied.
- If refused or `BLOCKED`, do not ask again.
- If approved, execute only the exact approved action inside the task worktree.
- After mutating actions, produce or allow a diff summary.

The controller exposes approvals on the task detail page. Diffs and configured test runs are summaries for local review, not permission to commit, push, PR, deploy, or sync external tools.

---

## Conventions

### Branches
- Feature: `agent/<linear-id>-<slug>` (e.g., `agent/tsh-79-worktree-approval-gates`)
- Docs: `docs/<slug>` (e.g., `docs/phase-3-handoff-cleanup`)
- Never commit directly to `main` unless the human explicitly asks for a direct docs-only update. Prefer a PR.

### Commits
- Imperative mood ("Add X", "Fix Y", not "Added").
- Reference Linear issue ID in body when relevant: `Refs: TSH-79`.
- Small, focused commits. Don't pile unrelated changes into one.

### Code
- TypeScript everywhere on the orchestrator and controller.
- NestJS modules map 1:1 to source folders.
- One adapter per agent. Adapters implement the runtime interface in `src/agents/agent-adapter.interface.ts` and keep the architecture docs in sync.

### Tests
- Tests live next to the code (`module.ts` + `module.spec.ts`) or in `test/` for e2e/integration coverage.
- Phase 1 and Phase 2 have automated tests for the REST service layer, WebSocket gateway, input endpoint, and Codex PTY behavior.
- Phase 3 should add deterministic tests around worktree creation, policy classification, approval lifecycle, blocked actions, and WebSocket approval prompts.
- Tests must be deterministic and isolated. A test that hits production endpoints is **NEEDS_APPROVAL**, not a real test.

### Docs
- Source-of-truth diagrams live in `docs/diagrams.md` as Mermaid. GitHub renders them natively.
- Architecture decisions go into `docs/ARCHITECTURE.md`, not into commit messages.
- Update `docs/` in the same PR as the code change. No "I'll update docs later" PRs.

---

## Working with Linear

Every meaningful task should be linked to a Linear issue. The Linear issue ID belongs in:
- The PR title (e.g., `[TSH-79] Add worktree isolation and approval gates`)
- The branch name (`agent/tsh-79-...`)
- The commit body (`Refs: TSH-79`)

Sub-tasks of a phase issue are tracked as Linear sub-issues with `parent` set to the phase issue.

---

## Working with GitHub

Use `gh` CLI for everything GitHub-related when working locally. Authentication is already configured.

- Create issues: `gh issue create ...`
- Open PRs: `gh pr create --draft ...` (always draft until tests + lint pass)
- Comment on issues / PRs: `gh issue comment ...`, `gh pr comment ...`

**Always pass labels.** PRs and issues without `phase-N` and area labels are hard to triage.

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

If `pnpm` is unavailable in the current shell, root checks can run through npm scripts:

```bash
npm test
npm run test:e2e
npm run typecheck
npm run build
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

---

## Stop conditions

Stop and ask the human if any of these are true:

- A change crosses phase boundaries.
- A test or lint command is failing and the fix isn't obvious.
- An action would touch the BLOCKED list above.
- A change would modify the safety model itself (this is sensitive — humans gate it).
- You discover an unexpected file, branch, or piece of state. **Investigate before deleting.**

---

## When in doubt

Behave like a senior engineer on day one of a new job: read first, ask before changing anything sensitive, document as you go, and don't try to look impressive by doing more than was asked.
