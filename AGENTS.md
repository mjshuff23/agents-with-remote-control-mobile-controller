# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code, Gemini) working on this repository.

If you are an AI agent reading this: this file is your briefing. The human running you expects you to follow it.

---

## What this repo is

A local-first orchestration system that lets a human run CLI coding agents (you, basically) from their PC and control them from their phone. Yes, you may end up writing your own future supervisor. Take it seriously.

Read these in order:
1. [`README.md`](./README.md) — high-level intent and phased plan
2. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — system design and module boundaries
3. [`docs/SAFETY.md`](./docs/SAFETY.md) — what you can and cannot do
4. [`docs/diagrams.md`](./docs/diagrams.md) — canonical diagrams

---

## Phase boundaries (canonical scope)

The current phase determines what is in-scope and what is out-of-scope. Linear is the source of truth.

| Phase | Linear | Status |
|---|---|---|
| 1 | [TSH-77](https://linear.app/michaelshuff/issue/TSH-77) | Active focus |
| 2 | [TSH-78](https://linear.app/michaelshuff/issue/TSH-78) | Deferred until Phase 1 ships |
| 3 | [TSH-79](https://linear.app/michaelshuff/issue/TSH-79) | Deferred |
| 4 | [TSH-80](https://linear.app/michaelshuff/issue/TSH-80) | Deferred |
| 5 | [TSH-81](https://linear.app/michaelshuff/issue/TSH-81) | Deferred |
| 6 | [TSH-82](https://linear.app/michaelshuff/issue/TSH-82) | Deferred |

**Do not** implement work from a later phase while an earlier phase is open. If the work obviously belongs to a later phase, stop and ask.

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

## Conventions

### Branches
- Feature: `agent/<linear-id>-<slug>` (e.g., `agent/tsh-77-bootstrap-orchestrator`)
- Docs: `docs/<slug>` (e.g., `docs/initial-system-design`)
- Never commit directly to `main` — always go through a PR.

### Commits
- Imperative mood ("Add X", "Fix Y", not "Added").
- Reference Linear issue ID in body when relevant: `Refs: TSH-77`.
- Small, focused commits. Don't pile unrelated changes into one.

### Code
- TypeScript everywhere on the orchestrator and controller.
- NestJS modules map 1:1 to source folders.
- One adapter per agent. Adapters implement the interface in `docs/ARCHITECTURE.md`.

### Tests
- Tests live next to the code (`module.ts` + `module.spec.ts`).
- Phase 1 ships happy-path tests; Phase 3 grows test coverage as the approval gate matures.
- Tests must be deterministic and isolated. A test that hits production endpoints is **NEEDS_APPROVAL**, not a real test.

### Docs
- Source-of-truth diagrams live in `docs/diagrams.md` as Mermaid. GitHub renders them natively.
- Architecture decisions go into `docs/ARCHITECTURE.md`, not into commit messages.
- Update `docs/` in the same PR as the code change. No "I'll update docs later" PRs.

---

## Working with Linear

Every meaningful task should be linked to a Linear issue. The Linear issue ID belongs in:
- The PR title (e.g., `[TSH-77] Bootstrap NestJS orchestrator`)
- The branch name (`agent/tsh-77-...`)
- The commit body (`Refs: TSH-77`)

Sub-tasks of a phase issue are tracked as Linear sub-issues with `parent` set to the phase issue.

---

## Working with GitHub

Use `gh` CLI for everything GitHub-related. Authentication is already configured.

- Create issues: `gh issue create ...`
- Open PRs: `gh pr create --draft ...` (always draft until tests + lint pass)
- Comment on issues / PRs: `gh issue comment ...`, `gh pr comment ...`

**Always pass labels.** PRs and issues without `phase-N` and area labels are hard to triage.

---

## Build / test commands

> Phase 1 has not landed yet. This section will document `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm lint` once the orchestrator scaffold exists.

For now: there is no build step. Edits are docs-only.

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
