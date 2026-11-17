// http-util.ts — small request/response helpers (stdlib only).

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Read the whole request body (capped); rejects when the cap is exceeded. */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > maxBytes) {
        done = true;
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

/** Parse a JSON body; returns null on empty body, throws a 400-flavoured error on bad JSON. */
export function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    const err = new Error('Problems parsing JSON') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function jsonReply(
  res: ServerResponse,
  status: number,
  body: string,
  reqId: string,
  extraHeaders?: Record<string, string>,
): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': reqId,
    ...(extraHeaders ?? {}),
  };
  res.writeHead(status, headers);
  res.end(body);
}

export function messageReply(res: ServerResponse, status: number, message: string, reqId: string): void {
  jsonReply(res, status, JSON.stringify({ message }), reqId);
}

/** Parse the query string of a raw URL into a Map (no `new URL()` per request). */
export function parseQuery(rawUrl: string): Map<string, string> {
  const out = new Map<string, string>();
  const q = rawUrl.indexOf('?');
  if (q === -1) return out;
  const qs = rawUrl.slice(q + 1);
  let start = 0;
  while (start <= qs.length) {
    let amp = qs.indexOf('&', start);
    if (amp === -1) amp = qs.length;
    const pair = qs.slice(start, amp);
    if (pair.length > 0) {
      const eq = pair.indexOf('=');
      const k = eq === -1 ? pair : pair.slice(0, eq);
      const v = eq === -1 ? '' : pair.slice(eq + 1);
      try {
        out.set(decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' ')));
      } catch {
        out.set(k, v);
      }
    }
    start = amp + 1;
  }
  return out;
}

/** Split a raw path into decoded segments (no `new URL()` per request). */
export function splitPath(rawUrl: string): string[] {
  let path = rawUrl;
  const q = path.indexOf('?');
  if (q !== -1) path = path.slice(0, q);
  const raw = path.split('/').filter((s) => s.length > 0);
  const out: string[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    try {
      out[i] = decodeURIComponent(raw[i]!);
    } catch {
      out[i] = raw[i]!;
    }
  }
  return out;
}
