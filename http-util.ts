// http-util.ts — the request context every handler receives, plus the response
// helpers. Responses always carry a non-empty X-GitHub-Request-Id and an
// explicit Content-Length (no chunked encoding on the hot paths).

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string; // pathname, no query string
  segments: string[]; // decoded path segments
  query: URLSearchParams;
  body: Buffer;
  requestId: string;
}

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

function baseHeaders(ctx: Ctx, contentType: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-github-request-id': ctx.requestId,
  };
  if (extra) for (const [k, v] of Object.entries(extra)) headers[k] = v;
  return headers;
}

/** Send a JSON response. `body` may be a pre-serialized string or an object. */
export function sendJson(ctx: Ctx, status: number, body: unknown, extra?: Record<string, string>): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const buf = Buffer.from(text, 'utf8');
  const headers = baseHeaders(ctx, 'application/json', extra);
  headers['content-length'] = String(buf.length);
  ctx.res.writeHead(status, headers);
  ctx.res.end(buf);
}

/** Send a raw buffer with the given content type. */
export function sendBuffer(ctx: Ctx, status: number, body: Buffer, contentType: string, extra?: Record<string, string>): void {
  const headers = baseHeaders(ctx, contentType, extra);
  headers['content-length'] = String(body.length);
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

/** Send an empty response (e.g. 204). */
export function sendEmpty(ctx: Ctx, status: number, extra?: Record<string, string>): void {
  const headers = baseHeaders(ctx, 'application/json', extra);
  headers['content-length'] = '0';
  ctx.res.writeHead(status, headers);
  ctx.res.end();
}

/** Parse a request body as JSON. Returns null when the body is empty or
 *  malformed (the caller then answers 400). */
export function parseJsonBody(ctx: Ctx): unknown | null {
  if (ctx.body.length === 0) return {};
  try {
    return JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return null;
  }
}

/** Is the value a plain object (not an array, not null)? */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
