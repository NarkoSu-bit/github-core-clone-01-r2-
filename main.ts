// main.ts — entrypoint: bind port 0, register with the environment,
// serve, and exit when the environment reports done.
//
// Routing (hand-rolled, no `new URL()` on the hot path):
//   GET  /                                  root discovery (no auth)
//   POST /api/graphql                       GraphQL v4
//   POST /mcp                               MCP (JSON-RPC 2.0)
//   /api/v3/*                               REST v3
//   /{owner}/{repo}/info/refs              git smart-HTTP advertisement
//   /{owner}/{repo}/git-upload-pack         git fetch / ls-refs
//   /{owner}/{repo}/git-receive-pack        git push
// Everything except GET / requires `Authorization: Bearer <token>` where the
// token is the process's MAKEFUN_SHOP_TOKEN (any non-empty bearer is accepted
// when that variable is unset, for local runs).

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGraphql } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, handleRoot } from './rest.ts';
import { jsonReply, messageReply, parseQuery, splitPath } from './http-util.ts';

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

const store = new Store();

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reqId = store.nextReqId();
  try {
    const segments = splitPath(req.url ?? '/');
    const query = parseQuery(req.url ?? '/');
    const method = (req.method ?? 'GET').toUpperCase();
    const host = req.headers.host ?? '127.0.0.1';

    // GET / — root discovery, no auth.
    if (segments.length === 0) {
      if (method !== 'GET') {
        jsonReply(res, 405, JSON.stringify({ message: 'Method Not Allowed' }), reqId);
        return;
      }
      handleRoot(res, reqId);
      return;
    }

    // GET /healthz — the boot probe, no auth.
    if (segments.length === 1 && segments[0] === 'healthz') {
      if (method !== 'GET') {
        jsonReply(res, 405, JSON.stringify({ message: 'Method Not Allowed' }), reqId);
        return;
      }
      jsonReply(res, 200, JSON.stringify({ status: 'ok' }), reqId);
      return;
    }

    // Everything else needs a bearer token.
    if (!authed(req)) {
      messageReply(res, 401, 'Requires authentication', reqId);
      return;
    }

    const [first, second] = segments;
    if (first === 'api' && second === 'graphql' && segments.length === 2) {
      if (method !== 'POST') {
        jsonReply(res, 405, JSON.stringify({ message: 'Method Not Allowed' }), reqId);
        return;
      }
      await handleGraphql(store, req, res, reqId);
      return;
    }
    if (first === 'mcp' && segments.length === 1) {
      if (method !== 'POST') {
        jsonReply(res, 405, JSON.stringify({ message: 'Method Not Allowed' }), reqId);
        return;
      }
      await handleMcp(store, req, res, reqId);
      return;
    }
    if (first === 'api' && second === 'v3') {
      await handleRest(store, req, res, segments.slice(2), query, reqId, host);
      return;
    }
    // Git smart-HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack.
    // The client always appends `.git` to the repo name in these paths.
    const gitRepo =
      segments.length >= 2 && segments[1]!.endsWith('.git') ? segments[1]!.slice(0, -4) : (segments[1] ?? '');
    if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
      if (method !== 'GET') {
        jsonReply(res, 405, JSON.stringify({ message: 'Method Not Allowed' }), reqId);
        return;
      }
      handleInfoRefs(store, req, res, segments[0]!, gitRepo, query, reqId);
      return;
    }
    if (segments.length === 3 && segments[2] === 'git-upload-pack') {
      if (method !== 'POST') {
        jsonReply(res, 405, JSON.stringify({ message: 'Method Not Allowed' }), reqId);
        return;
      }
      await handleUploadPack(store, req, res, segments[0]!, gitRepo, reqId);
      return;
    }
    if (segments.length === 3 && segments[2] === 'git-receive-pack') {
      if (method !== 'POST') {
        jsonReply(res, 405, JSON.stringify({ message: 'Method Not Allowed' }), reqId);
        return;
      }
      await handleReceivePack(store, req, res, segments[0]!, gitRepo, reqId);
      return;
    }
    messageReply(res, 404, 'Not Found', reqId);
  } catch (err) {
    if (!res.headersSent) {
      messageReply(res, 500, 'Internal Server Error', reqId);
    } else {
      res.destroy();
    }
    console.error(err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const r = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) return true;
      console.error(`register attempt ${attempt + 1}: HTTP ${r.status}`);
    } catch (e) {
      console.error(`register attempt ${attempt + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(500);
  }
  return false;
}

async function waitDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const r = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const body = (await r.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // Transient: keep polling.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 60_000;
  const listenPort = process.env.PORT !== undefined ? Number(process.env.PORT) : 0;
  await new Promise<void>((resolve) => {
    server.listen(listenPort, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : listenPort;
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.log(`github-core-clone listening on http://127.0.0.1:${port}`);
    return;
  }
  const ok = await register(envUrl, port);
  if (!ok) {
    console.error('could not register with the environment; exiting');
    server.close();
    process.exit(1);
  }
  await waitDone(envUrl);
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

void main();
