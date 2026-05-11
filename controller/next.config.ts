import type { NextConfig } from 'next';

// Derive allowed dev origins from the WS URL env var so any LAN/VPN IP works
// without hardcoding. Only needed in development (HMR websocket).
function devOriginsFromEnv(): string[] {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
  if (!wsUrl) return [];
  try {
    const { hostname } = new URL(wsUrl);
    return hostname !== 'localhost' && hostname !== '127.0.0.1' ? [hostname] : [];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  allowedDevOrigins: devOriginsFromEnv(),
  turbopack: {
    root: '..'
  }
};

export default nextConfig;
