// mcp.ts — the MCP endpoint (POST /mcp, JSON-RPC 2.0 Streamable HTTP).
//
// The suite negotiates the modern 2026-07-28 era: `server/discover` returns
// identity, capabilities and supportedVersions in one request; every request
// declares its revision in `_meta`. The legacy `initialize` handshake is
// implemented as well, in case a client predates discover.
// The tools/list answer is precomputed once so two calls are byte-identical.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Store } from './store.ts';
import { VIEWER_LOGIN, isoAt } from './store.ts';
import { buildCommit, mergeBase, storeObject } from './git.ts';
import { isRecord, jsonReply, messageReply, readBody } from './http-util.ts';
import { refreshIssueJson, refreshPullJson, refreshRepoJson, threeWayMerge } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_REVISIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name (owner/repo).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name (owner/repo).' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name (owner/repo).' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name (owner/repo).' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name (owner/repo).' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        number: { type: 'integer', description: 'Alias for pull_number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The tools array, serialized once: two tools/list calls are byte-identical. */
const TOOLS_JSON = JSON.stringify(TOOLS);

function rpcResult(id: unknown, result: string): string {
  // `result` is already-serialized JSON, embedded verbatim.
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${result}}`;
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

// ---------------------------------------------------------------- tool implementations

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0]!;
      if (repo === '') repo = parts[1]!;
    }
  }
  return { owner, repo };
}

function toolError(text: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

function toolOk(value: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function createRepoTool(store: Store, args: Record<string, unknown>): unknown {
  const name = typeof args.name === 'string' ? args.name : '';
  if (name === '') return toolError('create_repo requires a name');
  const repo = store.createRepo(
    VIEWER_LOGIN,
    name,
    typeof args.description === 'string' ? args.description : '',
    args.private === true,
  );
  if (repo === null) return toolError(`repository ${name} already exists`);
  refreshRepoJson(repo);
  return toolOk(JSON.parse(repo.json) as unknown);
}

function getRepoTool(store: Store, args: Record<string, unknown>): unknown {
  const { owner, repo } = splitFullName(args);
  const found = owner === VIEWER_LOGIN ? store.getRepo(owner, repo) : undefined;
  if (found === undefined) return toolError(`repository ${owner}/${repo} not found`);
  return toolOk(JSON.parse(found.json) as unknown);
}

function createIssueTool(store: Store, args: Record<string, unknown>): unknown {
  const { owner, repo: repoName } = splitFullName(args);
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
  const title = typeof args.title === 'string' ? args.title : '';
  if (title === '') return toolError('create_issue requires a title');
  const labelNames: string[] = Array.isArray(args.labels)
    ? (args.labels as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const labels: Issue['labels'] = [];
  for (const ln of labelNames) {
    const l = repo.labels.get(ln);
    if (l === undefined) return toolError(`label does not exist: ${ln}`);
    labels.push(l);
  }
  const dbId = ++store.issueSeq;
  const number = ++repo.issueSeq;
  const now = isoAt(dbId);
  const issue: Issue = {
    dbId,
    number,
    title,
    body: typeof args.body === 'string' ? args.body : '',
    state: 'open',
    labels,
    userLogin: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
    json: '',
  };
  repo.issues.set(number, issue);
  refreshIssueJson(repo, issue);
  refreshRepoJson(repo);
  return toolOk(JSON.parse(issue.json) as unknown);
}

function listIssuesTool(store: Store, args: Record<string, unknown>): unknown {
  const { owner, repo: repoName } = splitFullName(args);
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
  const state = typeof args.state === 'string' ? args.state : 'open';
  let list = [...repo.issues.values()];
  if (state !== 'all') list = list.filter((i) => i.state === state);
  list.sort((a, b) => b.number - a.number);
  const items = list.map((i) => JSON.parse(i.json) as unknown);
  return toolOk(items);
}

function createPullRequestTool(store: Store, args: Record<string, unknown>): unknown {
  const { owner, repo: repoName } = splitFullName(args);
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
  const title = typeof args.title === 'string' ? args.title : '';
  const head = typeof args.head === 'string' ? args.head : '';
  const base = typeof args.base === 'string' ? args.base : '';
  if (title === '' || head === '' || base === '') return toolError('create_pull_request requires title, head and base');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return toolError('head or base branch does not exist');
  const dbId = ++store.pullSeq;
  const number = ++repo.pullSeq;
  const now = isoAt(dbId);
  const pull: Pull = {
    dbId,
    number,
    title,
    body: typeof args.body === 'string' ? args.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    headSha,
    baseRef: base,
    baseSha,
    userLogin: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    json: '',
  };
  repo.pulls.set(number, pull);
  refreshPullJson(repo, pull);
  return toolOk(JSON.parse(pull.json) as unknown);
}

function mergePullRequestTool(store: Store, args: Record<string, unknown>): unknown {
  const { owner, repo: repoName } = splitFullName(args);
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
  const n = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : NaN;
  if (!Number.isInteger(n) || n < 1) return toolError('merge_pull_request requires pull_number');
  const pull = repo.pulls.get(n);
  if (pull === undefined) return toolError(`pull request #${n} not found`);
  if (pull.merged || pull.state === 'closed') {
    return toolOk({ number: pull.number, merged: pull.merged, state: pull.merged ? 'MERGED' : 'CLOSED', sha: pull.mergeCommitSha });
  }
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mb = mergeBase(repo, headSha, baseSha);
  const merged = threeWayMerge(repo, baseSha, headSha, mb);
  if (merged.conflict) return toolError('Merge conflict');
  const commitBuf = buildCommit(merged.treeOid, [baseSha], 'ada iversen', 'adaiversen@example.invalid', 1739175597 + store.commitCounter, pull.title);
  const commitOid = storeObject(repo, 'commit', commitBuf);
  store.commitCounter += 1;
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  store.touchRefs(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoAt(pull.dbId);
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = isoAt(pull.dbId);
  pull.baseSha = commitOid;
  pull.headSha = headSha;
  refreshPullJson(repo, pull);
  refreshRepoJson(repo);
  return toolOk({ number: pull.number, merged: true, state: 'MERGED', sha: commitOid });
}

const TOOL_IMPL: Record<string, (store: Store, args: Record<string, unknown>) => unknown> = {
  create_repo: createRepoTool,
  get_repo: getRepoTool,
  create_issue: createIssueTool,
  list_issues: listIssuesTool,
  create_pull_request: createPullRequestTool,
  merge_pull_request: mergePullRequestTool,
};

// ---------------------------------------------------------------- JSON-RPC dispatch

function discoverResult(): string {
  return JSON.stringify({
    protocolVersion: MODERN_REVISION,
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
  });
}

function handleRpc(store: Store, body: unknown): { status: number; text: string } {
  if (!isRecord(body)) {
    return { status: 400, text: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = body.id;
  const method = body.method;
  // Notifications carry no id: acknowledge with 202 and no body.
  if (id === undefined) {
    return { status: 202, text: '' };
  }
  if (typeof method !== 'string') {
    return { status: 400, text: rpcError(id, -32600, 'Invalid Request') };
  }
  const params = isRecord(body.params) ? (body.params as Record<string, unknown>) : {};

  if (method === 'server/discover') {
    return { status: 200, text: rpcResult(id, discoverResult()) };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_REVISIONS.has(offered) ? offered : '2025-11-25';
    return {
      status: 200,
      text: rpcResult(
        id,
        JSON.stringify({
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      ),
    };
  }
  if (method === 'ping') {
    return { status: 200, text: rpcResult(id, '{}') };
  }
  if (method === 'tools/list') {
    return { status: 200, text: rpcResult(id, `{"tools":${TOOLS_JSON}}`) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const impl = TOOL_IMPL[name];
    if (impl === undefined) {
      return { status: 200, text: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const result = impl(store, args);
    return { status: 200, text: rpcResult(id, JSON.stringify(result)) };
  }
  return { status: 200, text: rpcError(id, -32601, `Method not found: ${method}`) };
}

export async function handleMcp(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  reqId: string,
): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readBody(req, 10 * 1024 * 1024);
  } catch {
    messageReply(res, 413, 'Request Entity Too Large', reqId);
    return;
  }
  const text = raw.toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // Malformed JSON: HTTP 400 with a JSON-RPC parse error (-32700).
    res.writeHead(400, { 'content-type': 'application/json', 'x-github-request-id': reqId });
    res.end(rpcError(null, -32700, 'Parse error'));
    return;
  }
  // A batch of requests is answered as a batch of responses.
  if (Array.isArray(body)) {
    const out = body.map((item) => {
      const r = handleRpc(store, item);
      return r.status === 202 ? null : JSON.parse(r.text) as unknown;
    });
    jsonReply(res, 200, JSON.stringify(out.filter((x) => x !== null)), reqId);
    return;
  }
  const r = handleRpc(store, body);
  if (r.status === 202) {
    res.writeHead(202, { 'x-github-request-id': reqId });
    res.end();
    return;
  }
  res.writeHead(r.status, { 'content-type': 'application/json', 'x-github-request-id': reqId });
  res.end(r.text);
}
