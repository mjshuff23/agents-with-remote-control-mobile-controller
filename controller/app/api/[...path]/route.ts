import { NextRequest, NextResponse } from 'next/server';

/** Route context with dynamic path segments from Next.js. */
type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  // Always strip any client-supplied secret before proxying — the server-side
  // value is injected below. Without this, a spoofed header passes through
  // when CONTROLLER_SECRET is unset in the server environment.
  'x-controller-secret'
]);
const PROXY_TIMEOUT_MS = 30_000;

/** Proxy GET requests to the backend orchestrator. */
export async function GET(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

/** Proxy POST requests to the backend orchestrator. */
export async function POST(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

/** Proxy PUT requests to the backend orchestrator. */
export async function PUT(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

/** Proxy PATCH requests to the backend orchestrator. */
export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

/** Proxy DELETE requests to the backend orchestrator. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

/** Proxy HEAD requests to the backend orchestrator. */
export async function HEAD(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

/** Proxy OPTIONS requests to the backend orchestrator. */
export async function OPTIONS(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

/**
 * Proxy the incoming request to the backend orchestrator.
 * Injects CONTROLLER_SECRET and strips hop-by-hop / spoofed headers.
 */
async function proxyToBackend(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:3000';
  const { path = [] } = await context.params;
  const requestUrl = new URL(request.url);
  const target = new URL(`/${path.map(encodeURIComponent).join('/')}`, backendUrl);
  target.search = requestUrl.search;

  const headers = filteredHeaders(request.headers);
  const controllerSecret = process.env.CONTROLLER_SECRET;
  if (controllerSecret) {
    headers.set('X-Controller-Secret', controllerSecret);
  }

  const method = request.method.toUpperCase();
  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS)
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const status = name === 'TimeoutError' || name === 'AbortError' ? 504 : 502;
    return NextResponse.json({ error: 'Upstream request failed' }, { status });
  }

  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: filteredHeaders(response.headers)
  });
}

/** Strip hop-by-hop headers and the client-supplied x-controller-secret. */
function filteredHeaders(input: Headers): Headers {
  const headers = new Headers();
  input.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return headers;
}
