## Summary

- 

## Linked Linear issue

- 

## Architecture boundary affected

- [ ] Orchestrator backend
- [ ] Controller frontend
- [ ] MCP registry
- [ ] MCP transport
- [ ] MCP permission/approval layer
- [ ] MCP audit log
- [ ] Notion adapter
- [ ] Figma/FigJam adapter
- [ ] Docs only

## What changed

- 

## TDD proof

Describe the failing tests written before implementation, or explain why this PR is docs/config only.

- 

## Commands run

```bash
pnpm install
pnpm audit --audit-level=low
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm lint:md
pnpm --filter controller typecheck
pnpm --filter controller build
```

If any command was skipped, explain why and what replaced it.

## Dependency and vulnerability notes

- New packages:
- Exact versions:
- Audit result:

## Reproducibility steps

1. 
2. 
3. 

## Critical review areas

Call out the highest-risk files/logic for both AI and human reviewers.

- 

## Security review

- [ ] No raw provider tokens or controller secrets in logs, docs, DB rows, or browser payloads.
- [ ] No MCP secret-read behavior added.
- [ ] No MCP permission auto-elevation path added.
- [ ] Write-capable MCP/provider calls require explicit approval.
- [ ] Blocked/denied/expired paths are audited.
- [ ] Retry behavior is idempotent and does not duplicate external writes.

## Screenshots / logs

Attach screenshots for UI changes or relevant test output snippets.

## Concerns / deferred work

- 
