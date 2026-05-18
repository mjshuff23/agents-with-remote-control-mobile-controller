# Controlled MCP Synchronization

## Principle

MCP is a controlled tool layer, not the system architecture. The local orchestrator remains the broker, the phone remains the approval surface, and the registry/permission layer determines what an MCP server is allowed to do.

Phase 5 does not introduce god-mode tooling. It introduces explicit capability declarations, permission ceilings, approval gates, and audit trails.

## Threat model

Phase 5 must defend against:

- Capability drift: a server exposes a new tool and the orchestrator treats it as trusted.
- Permission creep: a read-only server starts writing because runtime discovery says it can.
- Secret exfiltration: arguments, headers, env vars, logs, or result previews expose private credentials.
- Approval fatigue: dangerous operations become casually tappable.
- Retry duplication: failed provider writes append duplicate Notion blocks, links, or comments.
- Transport leakage: stdio or HTTP transports receive broader environment/header access than needed.
- UI leakage: browser payloads show raw provider responses or private workspace content.

## Choke points

All MCP work must pass through these layers in order:

```text
Registry -> Transport Factory -> Permission Service -> Approval Mapper -> Tool Execution -> Audit Service
```

No provider adapter, controller route, or transport class may bypass the permission service.

## Registry

The registry is the authority ceiling. It is implemented in `src/mcp/registry/`.

It declares:

- server ID;
- display name;
- enabled/disabled state;
- transport kind and connection config;
- permission level;
- declared tools;
- tool risk classifications;
- blocked argument paths;
- explicit `canReadSecrets: false`.

Runtime discovery can confirm or narrow capabilities, but it cannot expand them. Unknown servers and unknown tools are blocked.

### Config file

The registry reads `arc.mcp.json` from the repo root by default. Override with `ARC_MCP_REGISTRY_PATH`. If the resolved file is absent, the server starts with an empty registry (MCP disabled, no startup failure). A malformed file or a Phase-5 policy violation (admin permission, blocked tool risk, `canReadSecrets: true`) throws at load time.

See `arc.mcp.example.json` for a placeholder-safe example with stdio and Streamable HTTP servers.

## Transports

The Phase 5 transport boundary is implemented in `src/mcp/transport/` with `@modelcontextprotocol/sdk@1.29.0`. It supports SDK-backed connection, `listTools`, and `callTool` for registry-declared MCP servers. `callTool` is gated by the permission ladder and approval flow (TSH-114/TSH-115); transport execution is only reached after `McpPermissionService.assess()` returns `auto_allow` or after an `approved` human decision via `McpToolCallService`.

All transport implementations normalize failures into safe categories and must avoid logging raw request headers, child-process env, or environment-derived values.

### Stdio

Use stdio for local MCP servers that run as child processes.

Rules:

- Use executable + args arrays, never a single shell string.
- Do not allow `|`, `&&`, `;`, backticks, `$()`, or other shell interpolation paths.
- Pass only allowlisted environment variables.
- Never pass `process.env` wholesale.
- Apply startup and request timeouts.
- Do not log child-process env.
- Fixture coverage verifies stdio handshakes can list tools without forwarding non-allowlisted env.
- Prefer absolute executable paths in registry entries. If a bare command must rely on `PATH`, allowlist `PATH` only when the operator understands the additional executable-discovery surface.

### Streamable HTTP

Use Streamable HTTP as the preferred HTTP transport for modern MCP servers.

Rules:

- Use explicit URL validation.
- Use explicit header env allowlists.
- Do not log auth headers.
- Apply connect/request timeouts.
- Normalize errors into safe categories.
- Fixture coverage verifies local request/response handshakes without internet access.

### Legacy SSE

Legacy SSE exists only for compatibility with older servers.

Rules:

- Keep it behind the same permission service.
- Prefer Streamable HTTP for new integrations.
- Do not let legacy compatibility weaken approval or audit requirements.
- Fixture coverage uses a local SSE server only; no internet dependency is required.

## Permission ladder

The Phase 5 permission ladder is implemented in `src/mcp/permissions/` as `McpPermissionService.assess()`. It is the policy choke point that every MCP tool call must pass through before approval creation or execution.

Decision order (fail-safe):

1. Unknown server or undeclared tool → `blocked(undeclared_tool)`
2. `admin` permission level → `blocked(admin_blocked)`
3. `destructive` or `secret_sensitive` tool risk → `blocked(blocked_tool_risk)`
4. Tool risk rank exceeds server permission ceiling → `blocked(permission_ceiling_exceeded)`
5. Prior denial replay (same server+tool+sanitized-args fingerprint was denied/expired/refused) → `blocked(denied_replay)`
6. `read` tool within ceiling → `auto_allow`
7. `append` or `write` tool within ceiling → `needs_approval`

Every assessment writes a structured audit record regardless of outcome.

| Level | Meaning | Phase 5 behavior |
| --- | --- | --- |
| `read_only` | Read bounded, non-secret metadata. | Auto-allow declared read tools; audit all calls. |
| `append_only` | Append bounded content to approved destinations. | Read auto-allow; append requires approval. |
| `write` | Create/update allowed external resources. | Write requires explicit per-call approval. |
| `admin` | Destructive/admin authority. | Reserved and blocked in Phase 5. |

Tool risk classification:

| Risk | Behavior |
| --- | --- |
| `read` | Auto-allowed when within server permission ceiling; audited. |
| `append` | Requires approval when within ceiling; blocked if above ceiling. |
| `write` | Requires approval per call; blocked if above ceiling. |
| `destructive` | Blocked in Phase 5 regardless of server permission. |
| `secret_sensitive` | Blocked in Phase 5 regardless of server permission. |

## Approval payload

The mobile card should receive only sanitized, bounded decision context:

- server display name;
- registry server ID;
- tool name;
- permission level;
- tool risk;
- reason approval is required;
- destination/resource summary;
- redacted argument preview;
- expiry behavior;
- audit correlation ID.

The controller must not receive:

- raw tokens;
- raw headers;
- raw env values;
- `.env` file content;
- unbounded Notion/Figma responses;
- full raw MCP arguments when secret-like keys are present.

## Audit model

Every MCP attempt is auditable, including blocked attempts that never reach a transport.

Required audit semantics:

- Hash normalized raw arguments.
- Hash normalized raw results when execution occurs.
- Store only sanitized previews.
- Correlate to task, session, approval request, server, tool, decision, decider, and reason code.
- Treat rows as append-only.
- Use correction rows rather than mutating history.

## Notion strategy

Notion is append-only in Phase 5.

Allowed:

- read configured project doc metadata;
- append a bounded session summary;
- include task IDs, Linear/GitHub references, PR links, tests, approvals, and concerns.

Blocked:

- replacing entire pages;
- deleting blocks;
- moving child pages;
- dumping raw private page content into controller logs;
- duplicate appends on retry.

## Figma/FigJam strategy

Figma/FigJam is read-only in Phase 5.

Allowed:

- parse Figma/FigJam URLs;
- fetch safe file/board metadata;
- attach relevant links to tasks/issues;
- dedupe link attachments.

Blocked:

- Figma file writes;
- unbounded file JSON in browser payloads;
- Figma token exposure;
- duplicate link spam.

## Controller surfaces

The controller may show:

- registered MCP servers and permission levels;
- pending MCP approvals;
- recent audit decisions;
- redacted argument/result previews;
- Notion/Figma sync status;
- safe deep-links.

The controller may not become a free-form MCP console in Phase 5.

## Failure modes to test

- Unknown server ID -> blocked and audited.
- Unknown tool name -> blocked and audited.
- Runtime tool above registry permission -> blocked.
- Read-only server attempts append/write -> blocked.
- Write tool without approval -> waits, then denies on timeout.
- Denied tool retry -> security event or repeated denial, never silent execution.
- Expired approval -> denial, not auto-allow.
- Refresh/replay -> no duplicate approval cards.
- Notion retry -> no duplicate session summary.
- Figma retry -> no duplicate attachment.
- Redaction test -> no secret-like values in controller JSON.

## Related docs

- [`phase-5-implementation.md`](phase-5-implementation.md)
- [`phase-5-official-sources.md`](phase-5-official-sources.md)
- [`SAFETY.md`](SAFETY.md)
- [`remote-access.md`](remote-access.md)
