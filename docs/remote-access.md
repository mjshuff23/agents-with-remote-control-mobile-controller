# Remote Access

Default daily setup for reaching the controller UI from a phone outside the
home LAN.

Phase 4.5 / Linear `TSH-111` standardizes on Tailscale before Phase 5 adds
Notion, Figma, and controlled MCP synchronization. This is an operational
security and reliability baseline, not a cloud deployment.

---

## Baseline Choice

Use Tailscale as the private overlay network between:

- the Windows host that runs WSL2, the orchestrator, and the controller;
- the phone that opens the controller UI.

Tailscale keeps the controller reachable from cellular or non-home WiFi without
router port forwarding, public DNS, ngrok, Cloudflare Tunnel, Tailscale Funnel,
or any public port exposure.

Public binding is acceptable only because access is constrained to the trusted
private overlay. Do not expose these ports directly to the public internet.

---

## Version Baseline

Implementation-day check for `TSH-111`:

| Item | Value |
| --- | --- |
| Verification date | 2026-05-16 |
| Latest stable target | Tailscale `v1.98.2` |
| Source | Tailscale changelog, May 15, 2026 |

Before marking the operational smoke complete, record the installed versions
from the Windows host and phone in the smoke record below. Do not commit a real
tailnet name, Tailscale IP, MagicDNS hostname, auth key, or controller secret.

| Device | Installed version | Notes |
| --- | --- | --- |
| Windows host | TODO: record during manual smoke | Use the Windows tray app, admin console Machines page, or `tailscale version` when available. |
| Phone | TODO: record during manual smoke | Use the iOS or Android app version after updating from the app store. |

---

## Install Or Update

1. Install or update Tailscale on Windows from
   <https://tailscale.com/download/windows>.
2. Install or update Tailscale on the phone from the iOS App Store or Google
   Play.
3. Sign in on both devices with the same Tailscale account.
4. Confirm both devices appear in the same tailnet.
5. Enable MagicDNS if you want to use the machine name. Otherwise use the
   stable `100.x.y.z` Tailscale IP.

Use only placeholder-safe examples in committed docs:

```text
http://100.x.y.z:3001
http://arc-windows-host.tailnet-example.ts.net:3001
```

---

## Orchestrator Config

Update the root `.env` on the host:

```bash
ARC_HOST=0.0.0.0
ARC_ALLOW_PUBLIC_BIND=true
```

`ARC_HOST=0.0.0.0` is a deliberate remote-access setting. Keep the default
`127.0.0.1` bind for normal local-only development.

`ARC_ALLOW_PUBLIC_BIND=true` must only be used behind Tailscale or another
trusted private overlay. It is not permission to expose the orchestrator on a
public interface.

---

## Controller Config

Update `controller/.env.local` on the host:

```bash
# Browser-visible WebSocket URL for the phone.
NEXT_PUBLIC_WS_URL=http://100.x.y.z:3000

# Server-side Next.js proxy target. Keep this on WSL loopback.
BACKEND_URL=http://127.0.0.1:3000

# Local controller bearer token. Use the same value in both variables.
NEXT_PUBLIC_CONTROLLER_SECRET=<local-controller-secret>
CONTROLLER_SECRET=<local-controller-secret>
```

Use the MagicDNS name instead of `100.x.y.z` only after verifying MagicDNS:

```bash
NEXT_PUBLIC_WS_URL=http://arc-windows-host.tailnet-example.ts.net:3000
```

The `NEXT_PUBLIC_CONTROLLER_SECRET` value is visible to the browser by design.
Treat it as a local controller bearer token, not as a provider credential. Do
not reuse GitHub, Linear, Notion, Figma, MCP, SSH, or Tailscale credentials.

---

## Windows And WSL2 Networking

Preferred path:

```text
phone browser -> Windows Tailscale IP or MagicDNS -> Windows host -> WSL2 ports
```

Start with direct access to the WSL-bound dev ports through the Windows
Tailscale address:

```text
http://100.x.y.z:3001
http://100.x.y.z:3000/health
```

Use these placeholder-safe probes to locate and verify the path:

```powershell
# Windows PowerShell: find the Windows Tailscale IPv4 address.
tailscale ip -4

# Windows PowerShell: confirm Windows can see the local services.
curl.exe http://127.0.0.1:3000/health
curl.exe http://127.0.0.1:3001

# Windows PowerShell: confirm the chosen Tailscale host address reaches them.
curl.exe http://100.x.y.z:3000/health
curl.exe http://100.x.y.z:3001
```

```bash
# WSL: find the WSL IPv4 address if a port proxy is needed.
hostname -I | awk '{print $1}'

# WSL: confirm the services are listening inside WSL.
curl -fsS http://127.0.0.1:3000/health
curl -I http://127.0.0.1:3001
```

If direct access fails, choose one fix and document it in the smoke record:

- enable WSL mirrored networking and allow the minimum Windows Firewall ports;
- add Windows `netsh interface portproxy` rules for ports `3000` and `3001`.

When a port proxy is needed, prefer binding the listen address to the Windows
Tailscale IP instead of all interfaces:

```powershell
netsh interface portproxy add v4tov4 listenaddress=100.x.y.z listenport=3001 connectaddress=<wsl-ip> connectport=3001
netsh interface portproxy add v4tov4 listenaddress=100.x.y.z listenport=3000 connectaddress=<wsl-ip> connectport=3000
netsh interface portproxy show v4tov4
```

After applying mirrored networking or portproxy, repeat the Windows PowerShell
`curl.exe http://100.x.y.z:3000/health` and `curl.exe http://100.x.y.z:3001`
checks. Then turn off phone WiFi, keep Tailscale connected on cellular, and
open `http://<tailscale-host>:3001` in the phone browser.

Do not commit the real Tailscale IP or WSL IP. Keep any firewall allowance to
the minimum ports needed for the controller path.

---

## Manual Smoke Test

Run the smoke from cellular or non-home WiFi.

1. Start the orchestrator with `ARC_HOST=0.0.0.0` and
   `ARC_ALLOW_PUBLIC_BIND=true`.
2. Start the controller on port `3001`.
3. Open `http://<tailscale-host>:3001` from the phone.
4. Confirm the controller UI loads.
5. Confirm `http://<tailscale-host>:3000/health` is reachable only from the
   private overlay path.
6. Confirm REST actions fail without `CONTROLLER_SECRET`.
7. Confirm REST actions succeed through the controller proxy with
   `CONTROLLER_SECRET`.
8. Confirm WebSocket connections fail without `NEXT_PUBLIC_CONTROLLER_SECRET`
   or with a mismatched secret.
9. Confirm WebSocket connections succeed with matching
   `NEXT_PUBLIC_CONTROLLER_SECRET` and `CONTROLLER_SECRET`.
10. Open the task list from the phone.
11. Open a task detail view from the phone.
12. Refresh the phone browser and confirm event replay does not duplicate logs
    or cards.
13. Trigger a real approval request and confirm the approval card renders on the
    phone.
14. Approve or deny the request from the phone outside the home LAN.
15. Confirm the task continues and the audit trail records the decision.

### Smoke Record Template

Use this template in PR notes or local implementation notes. Keep values
placeholder-safe if committed.

| Check | Result |
| --- | --- |
| Windows Tailscale version | TODO |
| Phone Tailscale version | TODO |
| Same tailnet verified | TODO |
| Host address used | `100.x.y.z` or `arc-windows-host.tailnet-example.ts.net` |
| MagicDNS used | TODO: yes/no |
| Windows/WSL2 path | TODO: direct / mirrored networking / portproxy |
| Cellular or non-home WiFi used | TODO |
| Controller UI loaded | TODO |
| REST auth failed without secret | TODO |
| REST auth succeeded with secret | TODO |
| WebSocket auth failed without or with wrong secret | TODO |
| WebSocket auth succeeded with matching secret | TODO |
| Task list verified | TODO |
| Task detail verified | TODO |
| Replay verified | TODO |
| Approval card verified | TODO |
| Real mobile approval flow passed | TODO |

---

## Non-Baseline Options

NetBird can serve the same private-overlay role if Tailscale is unavailable, but
`TSH-111` uses Tailscale as the daily default.

Cloudflare Tunnel, ngrok, router port forwarding, public DNS, public IP
exposure, and Tailscale Funnel are out of scope for this baseline.
