# Security Audit — TSH-85 (Phase 3.5)

**Date:** 2026-05-11
**Scope:** Root (NestJS backend) and `controller/` (Next.js frontend)
**Tool:** `pnpm audit` (CVSS-backed npm advisory database)

---

## Summary

| Package             | CVE            | CVSS | Severity | Fix                                                 |
|---------------------|----------------|------|----------|-----------------------------------------------------|
| `@hono/node-server` | CVE-2026-39406 | 5.3  | Moderate | `@prisma/dev>@hono/node-server: 1.19.13` -> 1.19.14 |
| `postcss`           | CVE-2026-41305 | 6.1  | Moderate | `next>postcss: 8.5.10` -> 8.5.14                    |

No critical or high vulnerabilities found in either workspace.
Post-patch: `pnpm audit` reports **0 vulnerabilities** in both root and controller.

---

## Dependency Posture

### Socket.IO (root backend)

| Package | Version | Notes |
|---------|---------|-------|
| `socket.io` | 4.8.3 | Current stable. Major known CVEs were in 2.x/3.x era. |
| `engine.io` | 6.6.7 | DoS via oversized payload (CVE-2022-41940) was patched in 6.2.2. Clean. |

### Next.js / controller

| Package | Version | Notes |
|---------|---------|-------|
| `next` | 16.2.6 | Current. Host-header SSRF (CVE-2024-46982) and redirect bypass issues were in 14.x/15.x. |
| `socket.io-client` | 4.8.3 | Matches backend socket.io. No known CVEs. |
| `postcss` | 8.5.14 | Post-override. XSS escape issue (CVE-2026-41305) is in ≤8.5.9. |

---

## Vulnerability Detail

### CVE-2026-39406 — `@hono/node-server` middleware bypass

- **Advisory:** GHSA-92pp-h63x-v22m
- **Affected:** `@hono/node-server` < 1.19.13
- **Path:** `prisma` (devDep) → `@prisma/dev` → `@hono/node-server`
- **Description:** `serveStatic` does not normalise repeated slashes (`//`) in request paths, allowing middleware registered on `/admin/*` to be bypassed by requesting `//admin/secret.txt`.
- **Exploitability here:** None. `@hono/node-server` is a transitive dependency of the Prisma CLI's internal `@prisma/dev` tooling package — it is not loaded at runtime by the NestJS app and `serveStatic` is never called.
- **Fix:** Path-specific override `"@prisma/dev>@hono/node-server": "1.19.13"` in root `package.json`. Pinned to the exact minimum fixed version so the override never silently advances. Scoped to `@prisma/dev` so a future direct dep on `@hono/node-server` would not inherit the pin. Revisit when `prisma` upgrades past this version internally.

### CVE-2026-41305 — `postcss` XSS via unescaped `</style>`

- **Advisory:** GHSA-qx2v-qp2m-jg93
- **Affected:** `postcss` < 8.5.10
- **Path:** `next` → `postcss@8.4.31`
- **Description:** PostCSS does not escape `</style>` sequences when stringifying CSS ASTs. If user-submitted CSS is parsed and re-stringified for embedding in HTML `<style>` tags, the sequence breaks out of the style context, enabling XSS.
- **Exploitability here:** None. PostCSS is used as a **build-time** tool by Next.js (Tailwind compilation, autoprefixer). We do not accept user-submitted CSS strings and embed them in HTML at runtime via PostCSS.
- **Fix:** Path-specific override `"next>postcss": "8.5.10"` in root `package.json` (centralized with the other security override). Pinned to the exact minimum fixed version. Resolved to 8.5.14 (deduplicates `next`'s older copy without affecting any future direct `postcss` dep). Revisit when `next` upgrades past this version internally.

---

## Safe Target Versions (as of 2026-05-11)

| Package | Minimum safe | Installed |
|---------|-------------|-----------|
| `socket.io` | 4.6.2+ (no known active CVEs in 4.x) | 4.8.3 ✅ |
| `engine.io` | 6.2.2+ | 6.6.7 ✅ |
| `next` | 15.2.3+ (host-header SSRF fix); 16.x clean | 16.2.6 ✅ |
| `socket.io-client` | 4.6.2+ | 4.8.3 ✅ |
| `postcss` | 8.5.10+ | 8.5.14 ✅ |
| `@hono/node-server` | 1.19.13+ | 1.19.14 ✅ |

---

## Active pnpm.overrides

All CVE-driven overrides are centralized in root `package.json` under `pnpm.overrides`. JSON does not support comments, so this table is the authoritative reference. Remove an entry only after confirming the upstream package has upgraded past the pinned version.

| Override key                    | Pinned version | Closes         | Revisit when                        |
|---------------------------------|----------------|----------------|-------------------------------------|
| `@prisma/dev>@hono/node-server` | `1.19.13`      | CVE-2026-39406 | `prisma` upgrades `@prisma/dev` dep |
| `next>postcss`                  | `8.5.10`       | CVE-2026-41305 | `next` upgrades its `postcss` dep   |

---

## Notes

This controller may be reachable over VPN/LAN. The most relevant attack surfaces to watch:

1. **Authentication** — all API routes are guarded by `CONTROLLER_SECRET` (checked in `ControllerSecretGuard`). WebSocket connections require the secret on `subscribe`. No unauthenticated routes except `/health`.
2. **Socket.IO** — engine.io 6.6.7 has no known active CVEs. Watch for future DoS advisories when upgrading NestJS or socket.io.
3. **Next.js** — 16.x is the current major. Monitor the [Next.js security page](https://nextjs.org/blog/security-advisories) before upgrading.
4. **Prisma CLI deps** — `@prisma/dev` pulls auxiliary packages (`@hono/node-server`, etc.) as build tooling. These are not in the production runtime but will continue to surface in `pnpm audit`. The override approach is appropriate; revisit when Prisma upgrades its own dep range.
