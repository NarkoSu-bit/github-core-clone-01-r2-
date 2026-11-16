// app.ts — HTTP server: routes git smart HTTP, REST v3, GraphQL and MCP onto one store.
// Auth: Bearer MAKEFUN_SHOP_TOKEN on every route except the REST root/meta and the MCP
// discovery/handshake methods; a missing or wrong token is 401, a missing repo is 404.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store, type User } from './store.ts';
import { handleRest, nextRequestId, type RestContext } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertiseV2,
  advertiseV0,
  handleUploadPackV2,
  handleUploadPackV0,
  handleReceivePack,
} from './githttp.ts';

export interface AppOptions {
  port: number;
  host?: string;
}

export interface App {
  store: Store;
  server: ReturnType<typeof createServer>;
  port: number;
  setPort: (port: number) => void;
}

const VIEWER: User = {
  id: 1000,
  login: 'adaiversen',
  name: 'Ada Iversen',
  email: 'adaiversen@example.invalid',
};

export function tokenFromEnv(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1] : undefined;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, headers: Record<string, string>, body: Buffer | null): void {
  response.writeHead(status, headers);
  if (body && body.length > 0) response.end(body);
  else response.end();
}

function jsonError(response: ServerResponse, requestId: string, status: number, message: string): void {
  const body = Buffer.from(JSON.stringify({ message }), 'utf8');
  send(response, status, { 'content-type': 'application/json', 'x-github-request-id': requestId }, body);
}

export function createApp(options: AppOptions): App {
  const store = new Store(VIEWER);
  const expectedToken = tokenFromEnv();
  const state = { port: options.port };
  const server = createServer(async (request, response) => {
    const requestId = nextRequestId();
    try {
      const rawUrl = request.url ?? '/';
      const queryIndex = rawUrl.indexOf('?');
      const path = queryIndex < 0 ? rawUrl : rawUrl.slice(0, queryIndex);
      const search = queryIndex < 0 ? '' : rawUrl.slice(queryIndex);
      const method = request.method ?? 'GET';
      const baseUrl = `http://127.0.0.1:${state.port}`;
      const token = bearerToken(request);
      const authenticated = expectedToken === '' ? token !== undefined && token !== '' : token === expectedToken;

      // --- git smart HTTP -----------------------------------------------------
      const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const servicePath = gitMatch[3];
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          jsonError(response, requestId, 404, 'Not Found');
          return;
        }
        if (servicePath === 'info/refs' && method === 'GET') {
          const service = new URLSearchParams(search).get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            jsonError(response, requestId, 400, 'unknown service');
            return;
          }
          const wantsV2 = request.headers['git-protocol'] === 'version=2';
          const body = service === 'git-upload-pack'
            ? wantsV2
              ? advertiseV2(repo, 'upload-pack')
              : advertiseV0(repo, 'upload-pack')
            : advertiseV0(repo, 'receive-pack');
          const contentType =
            service === 'git-upload-pack'
              ? 'application/x-git-upload-pack-advertisement'
              : 'application/x-git-receive-pack-advertisement';
          send(response, 200, { 'content-type': contentType, 'x-github-request-id': requestId }, body);
          return;
        }
        if (servicePath === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(request);
          const wantsV2 = request.headers['git-protocol'] === 'version=2';
          const result = wantsV2
            ? await handleUploadPackV2(repo, body)
            : await handleUploadPackV0(repo, body);
          send(response, 200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': requestId }, result);
          return;
        }
        if (servicePath === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(request);
          const result = await handleReceivePack(repo, body);
          send(response, 200, { 'content-type': 'application/x-git-receive-pack-result', 'x-github-request-id': requestId }, result);
          return;
        }
        jsonError(response, requestId, 404, 'Not Found');
        return;
      }

      // --- GraphQL ------------------------------------------------------------
      if (path === '/api/graphql' && method === 'POST') {
        if (!authenticated) {
          jsonError(response, requestId, 401, 'Requires authentication');
          return;
        }
        const raw = await readBody(request);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          send(response, 400, { 'content-type': 'application/json', 'x-github-request-id': requestId }, Buffer.from(JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] }), 'utf8'));
          return;
        }
        const documents = Array.isArray(parsed) ? parsed : [parsed];
        const results = documents.map((doc) => {
          if (!doc || typeof doc !== 'object') return { data: null, errors: [{ message: 'invalid document' }] };
          const { query, variables, operationName } = doc as { query?: unknown; variables?: unknown; operationName?: unknown };
          if (typeof query !== 'string') return { data: null, errors: [{ message: 'query must be a string' }] };
          const vars = variables && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
          return executeGraphQL(store, query, vars, typeof operationName === 'string' ? operationName : undefined);
        });
        const body = Buffer.from(JSON.stringify(Array.isArray(parsed) ? results : results[0]), 'utf8');
        send(response, 200, { 'content-type': 'application/json', 'x-github-request-id': requestId }, body);
        return;
      }

      // --- MCP ----------------------------------------------------------------
      if (path === '/mcp' && method === 'POST') {
        const raw = await readBody(request);
        const result = handleMcp({ store, baseUrl }, raw.toString('utf8'), authenticated);
        send(response, result.status, result.headers, result.body);
        return;
      }
      if (path === '/mcp' && method === 'DELETE') {
        send(response, 200, { 'content-type': 'application/json' }, Buffer.from('{}', 'utf8'));
        return;
      }

      // --- REST v3 ------------------------------------------------------------
      if (path.startsWith('/api/v3')) {
        // GET/HEAD never carry a body in this suite; skip the stream read.
        const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(request);
        let body: unknown;
        let bodyMalformed = false;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            bodyMalformed = true;
          }
        }
        const ctx: RestContext = { store, requestId, baseUrl, authenticated };
        const result = handleRest(ctx, method, path, search, body, bodyMalformed);
        send(response, result.status, result.headers, result.body);
        return;
      }

      // --- health -------------------------------------------------------------
      if (path === '/healthz' && method === 'GET') {
        send(response, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ ok: true }), 'utf8'));
        return;
      }

      jsonError(response, requestId, 404, 'Not Found');
    } catch (error) {
      console.error('request failed', error);
      jsonError(response, requestId, 500, error instanceof Error ? error.message : 'Internal Server Error');
    }
  });

  return {
    store,
    server,
    port: options.port,
    setPort: (port: number) => {
      state.port = port;
    },
  };
}

export function listen(app: App, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, () => {
      const address = app.server.address();
      const actual = address && typeof address === 'object' ? address.port : port;
      app.setPort(actual);
      app.port = actual;
      resolve(actual);
    });
  });
}
