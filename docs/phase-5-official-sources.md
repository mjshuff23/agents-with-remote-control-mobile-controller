# Phase 5 Official Source Snapshot

Retrieved: 2026-05-16

This file preserves the official-source research that Phase 5 implementation agents should use during context compaction. It is intentionally repo-local so an agent does not need to rediscover the same docs while implementing each ticket.

## MCP transports

Official source: Model Context Protocol specification, version `2025-06-18`, `Base Protocol > Transports`.

Repo decision:

- Support `stdio`.
- Support `streamable_http` as the preferred modern HTTP transport.
- Support `legacy_sse` only for backwards compatibility with older servers.
- Keep all transports behind the registry, permission service, approval mapper, and audit service.

Source facts to preserve:

- MCP uses JSON-RPC and currently defines two standard transport mechanisms: stdio and Streamable HTTP.
- In stdio, the client launches the MCP server as a subprocess; the server reads JSON-RPC messages from stdin and writes valid MCP messages to stdout.
- Streamable HTTP replaces the old HTTP+SSE transport from protocol version `2024-11-05`.
- Streamable HTTP uses a single MCP endpoint that supports POST and GET.
- For local Streamable HTTP servers, the MCP spec warns servers should validate `Origin`, bind locally where appropriate, and use proper authentication to avoid DNS rebinding exposure.
- Backwards-compatible clients may support old HTTP+SSE by attempting the new Streamable HTTP initialization first and falling back to the old SSE flow on 4xx responses.

Implementation constraints:

- Use executable plus args arrays for stdio, never shell strings.
- Do not pass `process.env` wholesale to stdio servers.
- Do not log environment-derived headers or transport auth material.
- Prefer Streamable HTTP for new HTTP servers.
- Treat legacy SSE as compatibility only.
- Apply timeouts to connect, list tools, and call tool operations.

## Notion append-only sync

Official source: Notion API reference, `Append block children`.

Repo decision:

- Use Notion append-only session summary sync in Phase 5.
- Do not replace whole Notion pages.
- Do not delete or move blocks.
- Preserve child pages and existing strategy-doc structure.

Source facts to preserve:

- The Notion append endpoint is `PATCH https://api.notion.com/v1/blocks/{block_id}/children`.
- It creates and appends new child blocks to the specified parent block.
- Existing blocks cannot be moved through this endpoint.
- Blocks are appended to the bottom of the parent unless the `after` parameter is used.
- A single request can append up to 100 child blocks.
- The endpoint requires insert-content capability; without that capability Notion returns 403.

Implementation constraints:

- Treat Notion appends as external writes requiring approval unless future scoped automation explicitly allows a bounded append.
- Enforce idempotency so one completed task summary is appended once.
- Store only placeholder-safe examples in docs and PRs.
- Do not log Notion tokens, raw page bodies, or full private workspace content.

## Figma/FigJam read-only metadata and links

Official source: Figma REST API, `Figma files > Endpoints`.

Repo decision:

- Phase 5 Figma/FigJam behavior is read-only metadata and link attachment.
- Figma writes are deferred.
- Prefer metadata endpoint when the task only needs title/link/status context.

Source facts to preserve:

- `GET /v1/files/:key` returns the document for a Figma file as JSON.
- The file key can be parsed from Figma URLs shaped like `https://www.figma.com/:file_type/:file_key/:file_name`.
- The `GET file` response includes metadata such as name, lastModified, thumbnailUrl, editorType, linkAccess, and version.
- `GET /v1/files/:key/meta` returns file metadata and requires `file_metadata:read` scope.
- Figma also has node/image endpoints, but Phase 5 should not dump broad file JSON into controller payloads.

Implementation constraints:

- Parse and validate Figma/FigJam URLs before storage.
- Fetch bounded metadata only.
- Do not expose Figma tokens to browser payloads, logs, database metadata, or audit previews.
- Deduplicate link attachments on retry.
- Do not implement Figma writes in Phase 5.

## Linear/GitHub repo source-of-truth notes

- Linear is the phase/ticket source of truth.
- GitHub repo docs are the implementation source of truth.
- Notion is the strategy/status document.
- Figma/FigJam is visual architecture/design context.

Phase 5 child ticket spine:

- `TSH-112`: MCP registry schema and config loader.
- `TSH-113`: MCP transport abstractions.
- `TSH-114`: MCP permission ladder and non-escalation.
- `TSH-115`: Mobile approval cards for write-capable MCP calls.
- `TSH-116`: MCP audit log with argument/result hashing.
- `TSH-117`: Notion adapter for project-doc reads and append-only summaries.
- `TSH-118`: Figma/FigJam adapter for read-only metadata and task link attachments.
- `TSH-119`: Controller surfaces for MCP/provider state.
- `TSH-120`: Phase 5 test matrix, docs bundle, and PR contract.

## Required implementation gates

Every Phase 5 implementation PR must document the exact commands run.

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

If a command is impossible for a scoped PR, the PR must explain why and identify the replacement verification.
