# Package-version false-positive indicators

## React / React DOM (controller)

Both `react` and `react-dom` at `19.2.6` may show a red X in editor
package-version extensions while already being the latest published
version. This is a known false positive caused by:

1. **Mixed lockfiles** — The controller previously had both
   `package-lock.json` (npm) and `pnpm-lock.yaml` (pnpm). Editor
   extensions reading the npm lockfile found stale metadata.
   **Fix:** TSH-91 removed `package-lock.json`. pnpm is now the
   single authoritative package manager.

2. **Editor extension cache** — After lockfile normalization, reload
   the VS Code window (`Developer: Reload Window`) and restart the
   TypeScript server (`TypeScript: Restart TS Server`) to clear
   stale indicators.

## General diagnostic steps

If you see a red X on a package you believe is current:

```bash
npm view <package> version          # latest on registry
pnpm ls <package>                   # installed version
pnpm why <package>                  # dependency chain
```

If installed version matches latest, the indicator is a false
positive — clear extension cache and reload.
