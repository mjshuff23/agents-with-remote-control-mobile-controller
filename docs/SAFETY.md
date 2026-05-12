# Safety Model

The phone is the approval surface. The orchestrator is the local broker. The agent is useful and capable, but not trusted with broad authority.

This document defines what the agent can do, what requires the human, and what is refused outright.

---

## Three tiers

Every action the orchestrator can reliably broker is classified before execution. In Phase 3, that means native-gated actions where a CLI exposes real hooks, cooperative `ARC_ACTION_REQUEST` actions emitted by the agent, and review-time diff/test summaries for everything else. The system does not claim universal interception of arbitrary CLI behavior.

### SAFE — auto-allow, log only

Read-only or scoped-to-this-task work that cannot damage anything outside the worktree.

Examples:

- Read repository files inside the worktree
- Inspect `git status`, `git log`, `git diff` (worktree-scoped)
- Run configured test commands
- Run configured lint / type-check commands
- Summarize code or produce a task plan
- Build dependency graphs / call graphs
- Read public documentation / specs declared in the repo

Behavior: execute, append to `AuditLog`, no controller prompt.

### NEEDS APPROVAL — pause, ping the phone, wait for human decision

Anything that mutates state — locally, in the repo, or externally.

Examples:

- Edit, create, or delete files in the worktree
- Install / update / remove packages (`npm`, `pnpm`, `pip`, `cargo`, etc.)
- Run database migrations
- Create, rename, or delete branches
- Commit changes
- Push to remote
- Open or update pull requests
- Update GitHub / Linear / Figma / Notion
- Call an MCP tool that declares write capability
- Run a shell command that is on the approval allowlist but produces side effects (e.g., `chmod`, `chown`, `ln -s`)

Behavior: emit `approval.requested` over WebSocket -> controller renders an approval card -> human decides -> orchestrator forwards `approved`, `denied`, or `expired` back to the agent through `ARC_APPROVAL`. All states are recorded in `ApprovalRequest` and `AuditLog`.

### BLOCKED BY DEFAULT — refuse, do not surface as approvable

Actions where the cost of a mistaken approval is too high to ever ask casually.

Examples:

- Read `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, or any file matching the secrets pattern
- `git push --force` to a protected branch
- `git push --force-with-lease` to `main` / `master` / `release/*`
- Production deploy commands (`vercel deploy --prod`, `wrangler deploy`, `aws cloudformation deploy`, etc.)
- Modify auth credentials (`gh auth`, `gcloud auth`, `aws configure`)
- Exfiltrate repository contents to an external service not on the integration allowlist
- Modify global system config (`/etc/`, `~/.bashrc`, `~/.zshrc`, system PATH)
- Execute unknown shell scripts (`curl ... | sh`, `wget ... | bash`, etc.)
- `rm -rf` outside the worktree
- Disable git hooks or bypass commit signing
- Touch any file matched by the **always-blocked path glob** in config

Behavior: refuse immediately, log the attempt with full context, **do not** present the action as approvable in the controller. If the agent insists or retries, escalate by surfacing a security-event card on the controller.

---

## Why a separate BLOCKED tier instead of "always-NEEDS-APPROVAL"?

Two reasons.

1. **Approval fatigue.** If every dangerous action is technically approvable, a tired user at 11pm taps "Approve" and a force-push to main happens. BLOCKED actions force the user to *change configuration* (or write code) to enable them — a deliberate act, not a reflex.

2. **Phone UX.** The phone is a small screen with limited context. The phone is exactly where you should not be making "permanently delete production database" decisions. BLOCKED actions exist to keep those decisions out of phone-tap range.

---

## Where the taxonomy lives

The SAFE / NEEDS_APPROVAL / BLOCKED classification is data first.

```text
arc.config.json
├── safe:                # patterns auto-allowed
├── needsApproval:       # patterns prompted to phone
└── blocked:             # patterns refused with no prompt
```

This means:

- Tuning the policy doesn't require redeploying the orchestrator.
- Per-repo overrides are possible by changing `ARC_POLICY_PATH`.
- Configured test runs are time-bounded by `ARC_TEST_COMMAND_TIMEOUT_MS`, with optional per-command `timeoutMs` overrides.
- The audit log includes which rule fired, which makes "why was this blocked?" debugging trivial.

The controller UI keeps REST approval/task actions behind a server-side Next.js proxy that forwards `CONTROLLER_SECRET` to the orchestrator. WebSocket auth remains a browser-present token because the browser opens the socket.io connection directly; this is local-loop controller auth, not a production secrecy boundary.

---

## Approval modes

### Native-gated

If a CLI or adapter exposes a reliable pre-execution approval/sandbox hook, the adapter may use it and route the decision through `ApprovalRequest`. This mode must be proven in code before docs or UI claim hard enforcement.

### Cooperative-gated

This is the default Phase 3 mode. The agent prints exactly one machine-readable line:

```text
ARC_ACTION_REQUEST {"id":"<uuid>","actionType":"fs.write_patch","title":"Patch file","files":["src/file.ts"]}
```

The orchestrator classifies the request, persists the result, emits an approval or policy event, and responds:

```text
ARC_APPROVAL {"id":"<uuid>","decision":"denied","message":"Not this way","constraints":[]}
```

Cooperative mode relies on agent compliance, so it is paired with worktree containment and mandatory diff/test review.

### Mixed

Future adapters can combine native hooks for commands the CLI truly exposes and cooperative requests for actions that need structured human context.

---

## Default-deny for unknowns

If the agent attempts a shell command that doesn't match any rule, it lands in **NEEDS APPROVAL**, not SAFE. Unknown ≠ safe.

This is deliberately conservative. It means new test runners or build tools will trigger one-time approvals until added to the SAFE allowlist. That's an acceptable cost.

---

## Audit log

Every classification decision and every approval outcome lands in `AuditLog` with:

- `taskId`
- `sessionId`
- `actionType` (e.g., `git.commit`, `npm.install`, `mcp.tool_call`)
- `description` (human-readable summary the agent provided)
- `riskLevel` (`SAFE` | `NEEDS_APPROVAL` | `BLOCKED`)
- `ruleMatched` (which policy rule fired)
- `decision` (`auto_allow` | `approved` | `denied` | `expired` | `refused`)
- `decisionMessage` (free-text from the human, if any)
- `decidedBy` (user identity)
- `requestedAt` / `decidedAt`

The audit log is **append-only**. Even superusers cannot edit existing rows; corrections are made by appending a `correction` row that references the original.

---

## Auth (evolving)

| Phase | Auth model |
|---|---|
| **Phase 2** | LAN-only bind + shared secret. Sufficient for "my phone on my home network." |
| **Phase 3** | Keep the shared secret, add approval/diff/test auditability, and do not expose production or public-network behavior. Per-device pairing remains future work. |
| **Phase 4+** | If the orchestrator becomes accessible outside the LAN, layer in per-device keys and then proper OAuth / WebAuthn. Tunneling (Tailscale, Cloudflare Tunnel) is preferred over public exposure. |

The orchestrator must **never** bind to `0.0.0.0` without explicit configuration. Default bind is `127.0.0.1` plus the LAN interface that has been allowlisted in config.

---

## What lives outside this document

- The risk taxonomy itself (per-action rules) — lives in `arc.config.json`, populated in Phase 3.
- The state machine for `ApprovalRequest` — see [`diagrams.md`](diagrams.md#3-approval-gate-state-machine).
- Specific MCP server permission ladders — Phase 5 work, captured in the registry schema.

---

## Failure modes worth naming

These have all bitten people. Calling them out so we don't replay them.

- **Approval timeouts that auto-allow.** Never. Expired approvals are denials.
- **"Fixing" a denied action by silently retrying the same command/files.** The orchestrator detects exact denied/expired/refused repeats and treats them as security events. Semantic paraphrase detection is future hardening.
- **Letting agents read denied files via indirect means** (`git show :file`, `git stash show`, `cat ../../.env` via a relative path). The denial is on the *file*, not the path string.
- **Trusting agent-provided action descriptions.** The agent might describe what it's doing politely; the classifier looks at the actual command, not the description.
- **Running test commands that have side effects.** Tests that hit production endpoints or modify external state are NEEDS_APPROVAL, not SAFE. The repo's test command must be declared deterministic and isolated to count as SAFE.
