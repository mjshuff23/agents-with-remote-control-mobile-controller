# Remote Access

Options for reaching the controller UI from outside your home network — gym, coffee shop, travel.

---

## Option 1 — Tailscale (recommended)

Tailscale creates an encrypted mesh VPN between your devices. Install it on your Windows PC and your phone; both devices appear on the same virtual network regardless of where they are physically.

**Setup (once):**

1. Install Tailscale on Windows: https://tailscale.com/download/windows
2. Install Tailscale on your phone (iOS/Android)
3. Sign in with the same account on both devices
4. Find your PC's Tailscale IP in the Tailscale admin console or taskbar icon — looks like `100.x.x.x`

**Run the services:**

Update `.env`:

```bash
ARC_HOST=0.0.0.0
ARC_ALLOW_PUBLIC_BIND=true
```

Update `controller/.env.local`:

```bash
# NEXT_PUBLIC_WS_URL — used by the phone's browser to open the WebSocket.
# Must be the external IP/hostname, since the browser connects from outside WSL2.
NEXT_PUBLIC_WS_URL=http://100.x.x.x:3000

# BACKEND_URL — used by the Next.js server to proxy REST calls to NestJS.
# Next.js and NestJS both run inside WSL2, so always use 127.0.0.1 here.
# Do NOT set this to the Windows LAN or Tailscale IP — that routes traffic
# out of WSL2 and back in, which breaks under most WSL2 network configs.
BACKEND_URL=http://127.0.0.1:3000

NEXT_PUBLIC_CONTROLLER_SECRET=<your secret>
CONTROLLER_SECRET=<your secret>
```

Restart both services. Open `http://100.x.x.x:3001` on your phone.

**Why Tailscale:** No port forwarding, no firewall rules, no public exposure. The connection is direct device-to-device (or relayed through Tailscale's DERP servers if direct is unavailable). Free for personal use (up to 100 devices).

---

## Option 2 — NetBird

Open-source alternative to Tailscale. Self-hostable management plane if you want zero dependency on third-party infrastructure.

**Setup:**

1. Create a free account at https://netbird.io or self-host the management server
2. Install the NetBird client on Windows and your phone
3. Peer your devices; get the peer IP from the NetBird dashboard
4. Same `.env` and `controller/.env.local` changes as Tailscale above, using your NetBird peer IP

**Why NetBird over Tailscale:** Full open-source stack (Apache 2.0), self-hostable, no vendor lock-in. Slightly more setup.

---

## Option 3 — Cloudflare Tunnel (zero open ports)

Cloudflare Tunnel creates an outbound-only tunnel from your PC to Cloudflare's edge. No inbound ports, no firewall changes, no VPN.

```bash
# Install cloudflared
winget install Cloudflare.cloudflared     # or download from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

# Authenticate (one-time)
cloudflared tunnel login

# Create a named tunnel
cloudflared tunnel create arc-controller

# Run it (tunnels both services)
cloudflared tunnel --url http://localhost:3001
```

Cloudflare gives you a public HTTPS URL like `https://random-words.trycloudflare.com`. Open that on your phone. You can also configure a custom domain via `cloudflared tunnel route dns`.

**Limitation:** The WS URL in `controller/.env.local` needs to point at the backend. You'd need a second tunnel or a subdomain for port 3000, or proxy the WS through the Next.js API route (a future improvement).

**Why Cloudflare Tunnel:** Truly zero open ports, HTTPS out of the box, works behind CGNAT. Free for personal use.

---

## Option 4 — ngrok (quickest for one-off testing)

```bash
npm install -g ngrok
ngrok http 3001
```

Gives you a temporary public HTTPS URL in seconds. The free tier changes the URL on every restart; a paid plan gives a stable subdomain.

Same WS limitation as Cloudflare Tunnel — you'd need a second tunnel for the socket connection, or use the `--region` flag and configure accordingly.

**Why ngrok:** Zero setup, useful for quick demos or one-off testing. Not suitable for daily use unless on a paid plan.

---

## Option 5 — Local LAN (same network only)

If you're on the same WiFi as your PC (home, trusted office), see the LAN setup in the main README. No external service needed, but limited to that network.

---

## Recommended setup for daily use

**Tailscale** is the best balance of simplicity, security, and reliability for the gym/travel use case:

- Install once, runs in the background
- No firewall changes or port forwarding
- Works from any network (cellular, public WiFi, gym WiFi)
- End-to-end encrypted
- `CONTROLLER_SECRET` still required for every request, so accidental exposure on the Tailscale network is still gated

---

## Security notes

Regardless of which option you choose:

- `CONTROLLER_SECRET` authenticates every REST request and every WebSocket connection. Do not share it.
- For Cloudflare Tunnel and ngrok, consider adding Cloudflare Access or ngrok's OAuth layer on top so the URL requires a login before the controller is even reachable.
- Never set `ARC_ALLOW_PUBLIC_BIND=true` on a machine with a public IP without one of the above layers in front.
