import { NextRequest, NextResponse } from 'next/server';

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
  'upgrade'
]);

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

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
  const response = await fetch(target, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer(),
    redirect: 'manual'
  });

  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: filteredHeaders(response.headers)
  });
}

function filteredHeaders(input: Headers): Headers {
  const headers = new Headers();
  input.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return headers;
}
