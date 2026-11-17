// app.ts — the HTTP server and router. One process, one in-memory store. The
// router is prefix-based and allocation-light on the hot paths: git smart-HTTP
// under /{owner}/{repo}.git, REST under /api/v3, GraphQL at /api/graphql and
// MCP at /mcp.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { repos } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { advertisement, handleLsRefs, handleFetch, handleReceivePack, decodePktLines } from './git.ts';
import { sendJson, sendBuffer, nextRequestId, type Ctx } from './http-util.ts';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The first pkt-line payload of a git request body (e.g. 'command=fetch'). */
function firstCommand(body: Buffer): string {
  try {
    const { packets } = decodePktLines(body);
    for (const p of packets) {
      if (p.kind === 'data' && p.payload) return p.payload.toString('utf8').replace(/\n$/, '');
      if (p.kind !== 'data') continue;
    }
  } catch {
    return '';
  }
  return '';
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? '/';
  // Manual URL split (cheaper than `new URL` on this hot path): the path is
  // everything before '?', the query is everything after it.
  const q = rawUrl.indexOf('?');
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const queryString = q === -1 ? '' : rawUrl.slice(q + 1);
  const segments = path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      // Most segments carry no escapes; decode only when one is present.
      if (!s.includes('%')) return s;
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const body = await readBody(req);
  const ctx: Ctx = {
    req,
    res,
    method: req.method ?? 'GET',
    path,
    segments,
    query: new URLSearchParams(queryString),
    body,
    requestId: nextRequestId(),
  };

  // Health probe the local runner (and the trial harness) use to confirm the
  // server is up.
  if (path === '/healthz') {
    sendJson(ctx, 200, { status: 'ok' });
    return;
  }

  // Git smart-HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (gitMatch) {
    const owner = gitMatch[1];
    const repoName = gitMatch[2];
    const tail = gitMatch[3];
    const repo = repos.get(`${owner}/${repoName}`);
    if (!repo) {
      sendJson(ctx, 404, { message: 'Not Found' });
      return;
    }
    if (tail === 'info/refs') {
      const service = ctx.query.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(ctx, 400, { message: 'service parameter required' });
        return;
      }
      const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const adv = advertisement(repo, service, wantV2);
      const ct = service === 'git-upload-pack'
        ? 'application/x-git-upload-pack-advertisement'
        : 'application/x-git-receive-pack-advertisement';
      sendBuffer(ctx, 200, adv, ct);
      return;
    }
    if (tail === 'git-upload-pack' && ctx.method === 'POST') {
      const cmd = firstCommand(body);
      if (cmd === 'command=ls-refs') {
        sendBuffer(ctx, 200, handleLsRefs(repo, body), 'application/x-git-upload-pack-result');
        return;
      }
      if (cmd === 'command=fetch') {
        sendBuffer(ctx, 200, handleFetch(repo, body), 'application/x-git-upload-pack-result');
        return;
      }
      sendJson(ctx, 400, { message: 'unknown git command' });
      return;
    }
    if (tail === 'git-receive-pack' && ctx.method === 'POST') {
      sendBuffer(ctx, 200, handleReceivePack(repo, body), 'application/x-git-receive-pack-result');
      return;
    }
    sendJson(ctx, 404, { message: 'Not Found' });
    return;
  }

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    ctx.segments = segments.slice(2);
    handleRest(ctx);
    return;
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (ctx.method !== 'POST') {
      sendJson(ctx, 405, { errors: [{ message: 'Method Not Allowed' }] });
      return;
    }
    handleGraphQL(ctx);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    handleMcp(ctx);
    return;
  }

  sendJson(ctx, 404, { message: 'Not Found' });
}

export function createApp() {
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      try {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message }));
      } catch {
        // The socket is gone; nothing more to do.
      }
    });
  });
  return server;
}
