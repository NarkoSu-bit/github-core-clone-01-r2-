// mcp.ts — Model Context Protocol endpoint: JSON-RPC 2.0 over Streamable HTTP.
// Revision 2026-07-28 via server/discover, plus the legacy initialize handshake.

import { type Store, type Repo } from './store.ts';
import { mergePullRequest } from './rest.ts';

export interface McpContext {
  store: Store;
  baseUrl: string;
}

const SERVER_NAME = 'makefun-git-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  handler: (ctx: McpContext, args: Record<string, unknown>) => { text: string; isError: boolean };
}

function repoShape(ctx: McpContext, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${ctx.baseUrl}/${repo.fullName}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}`,
  };
}

function issueShape(ctx: McpContext, repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    html_url: `${ctx.baseUrl}/${repo.fullName}/issues/${issue.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullShape(ctx: McpContext, repo: Repo, pull: { id: number; number: number; title: string; body: string; state: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; headRef: string; headSha: string; baseRef: string; baseSha: string }): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    html_url: `${ctx.baseUrl}/${repo.fullName}/pull/${pull.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

function resultText(value: unknown): string {
  return JSON.stringify(value);
}

function ok(value: unknown): { text: string; isError: boolean } {
  return { text: resultText(value), isError: false };
}

function fail(message: string): { text: string; isError: boolean } {
  return { text: resultText({ error: message }), isError: true };
}

/** Map the suite's argument names onto the schema's nearest property names. */
function arg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (args[name] !== undefined) return args[name];
  return undefined;
}

function getRepo(ctx: McpContext, args: Record<string, unknown>): Repo | null {
  const owner = arg(args, 'owner') as string | undefined;
  const repoName = arg(args, 'repo', 'repository', 'name') as string | undefined;
  if (!owner || !repoName) return null;
  return ctx.store.getRepo(owner, repoName) ?? null;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        full_name: { type: 'string', description: 'owner/repo, filled by the caller.' },
      },
      required: ['name'],
    },
    handler: (ctx, args) => {
      const name = arg(args, 'name') as string | undefined;
      if (!name) return fail('Missing required argument: name');
      const description = (arg(args, 'description') as string | undefined) ?? '';
      const isPrivate = arg(args, 'private') === true;
      const repo = ctx.store.createRepo(ctx.store.viewer.login, name, description, isPrivate);
      if (!repo) return fail('Validation Failed: name already exists on this account');
      return ok(repoShape(ctx, repo));
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
        full_name: { type: 'string', description: 'owner/repo, filled by the caller.' },
      },
      required: ['owner', 'repo'],
    },
    handler: (ctx, args) => {
      const repo = getRepo(ctx, args);
      if (!repo) return fail('Not Found');
      return ok(repoShape(ctx, repo));
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
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        full_name: { type: 'string', description: 'owner/repo, filled by the caller.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    handler: (ctx, args) => {
      const repo = getRepo(ctx, args);
      if (!repo) return fail('Not Found');
      const title = arg(args, 'title') as string | undefined;
      if (!title) return fail('Missing required argument: title');
      const body = (arg(args, 'body') as string | undefined) ?? '';
      const now = ctx.store.nowIso();
      const issue = {
        id: ctx.store.nextIssueId,
        number: repo.nextIssue,
        title,
        body,
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as never[],
        createdSeq: ctx.store.nextSeq(),
        createdAt: now,
        updatedAt: now,
      };
      ctx.store.nextIssueId += 1;
      repo.nextIssue += 1;
      repo.issues.push(issue);
      return ok(issueShape(ctx, repo, issue));
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
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
        full_name: { type: 'string', description: 'owner/repo, filled by the caller.' },
      },
      required: ['owner', 'repo'],
    },
    handler: (ctx, args) => {
      const repo = getRepo(ctx, args);
      if (!repo) return fail('Not Found');
      const state = (arg(args, 'state') as string | undefined) ?? 'open';
      let issues = repo.issues;
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      return ok({ issues: issues.map((issue) => issueShape(ctx, repo, issue)) });
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
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        full_name: { type: 'string', description: 'owner/repo, filled by the caller.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    handler: (ctx, args) => {
      const repo = getRepo(ctx, args);
      if (!repo) return fail('Not Found');
      const title = arg(args, 'title') as string | undefined;
      const head = arg(args, 'head') as string | undefined;
      const base = arg(args, 'base') as string | undefined;
      if (!title) return fail('Missing required argument: title');
      if (!head) return fail('Missing required argument: head');
      if (!base) return fail('Missing required argument: base');
      const headSha = repo.branchTip(head);
      const baseSha = repo.branchTip(base);
      if (!headSha || !baseSha) return fail('Validation Failed: head or base branch does not exist');
      const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (existing) return ok(pullShape(ctx, repo, existing));
      const now = ctx.store.nowIso();
      const pull = {
        id: ctx.store.nextPullId,
        number: repo.nextPull,
        title,
        body: (arg(args, 'body') as string | undefined) ?? '',
        state: 'open' as const,
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        merged: false,
        mergedAt: null as string | null,
        mergeCommitSha: null as string | null,
        createdSeq: ctx.store.nextSeq(),
        createdAt: now,
        updatedAt: now,
      };
      ctx.store.nextPullId += 1;
      repo.nextPull += 1;
      repo.pulls.push(pull);
      return ok(pullShape(ctx, repo, pull));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
        full_name: { type: 'string', description: 'owner/repo, filled by the caller.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    handler: (ctx, args) => {
      const repo = getRepo(ctx, args);
      if (!repo) return fail('Not Found');
      const number = Number(arg(args, 'pull_number', 'pullNumber', 'number'));
      if (!Number.isInteger(number)) return fail('Missing required argument: pull_number');
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return fail('Not Found');
      const result = mergePullRequest(ctx.store, repo, pull);
      if (!result.ok) return fail(result.message);
      return ok({ merged: true, sha: result.sha, number, state: 'closed', message: result.message });
    },
  },
];

function toolsListResult(): { tools: { name: string; description: string; inputSchema: ToolDef['inputSchema'] }[] } {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function findTool(name: string): ToolDef | undefined {
  const normalized = name.replace(/^[^_]+__/, '').toLowerCase();
  return TOOLS.find((tool) => tool.name.toLowerCase() === normalized || tool.name.toLowerCase().endsWith(normalized));
}

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
}

function jsonRpcResponse(id: unknown, result: unknown): McpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), 'utf8'),
  };
}

function jsonRpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), 'utf8'),
  };
}

/**
 * Handle one POST /mcp body. `authenticated` is false when no Authorization header was sent.
 * Returns null when the request is a notification (no response body, HTTP 202).
 */
export function handleMcp(ctx: McpContext, bodyText: string, authenticated: boolean): McpResponse {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonRpcError(null, -32700, 'Parse error', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }
  const request = body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = request.id ?? null;
  const isNotification = request.id === undefined;
  const method = request.method ?? '';

  // server/discover (2026-07-28 revision probe) — no auth required for discovery.
  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return jsonRpcResponse(id, {
      supportedVersions: [PROTOCOL_VERSION, ...LEGACY_VERSIONS],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  // Legacy handshake.
  if (method === 'initialize') {
    const params = request.params ?? {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    const supported = [PROTOCOL_VERSION, ...LEGACY_VERSIONS];
    const chosen = supported.includes(requested) ? requested : PROTOCOL_VERSION;
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return jsonRpcResponse(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { status: 202, headers: {}, body: null };
  }
  if (method === 'ping') {
    return jsonRpcResponse(id, {});
  }

  // tools/list and tools/call require authentication.
  if (!authenticated) {
    return jsonRpcError(id, -32001, 'Unauthorized', 401);
  }

  if (method === 'tools/list') {
    return jsonRpcResponse(id, toolsListResult());
  }

  if (method === 'tools/call') {
    const params = request.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = findTool(name);
    if (!tool) return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    // missing required arguments -> isError:true
    const missing = (tool.inputSchema.required ?? []).filter((key) => args[key] === undefined);
    if (missing.length > 0) {
      return jsonRpcResponse(id, {
        content: [{ type: 'text', text: resultText({ error: `Missing required argument: ${missing.join(', ')}` }) }],
        structuredContent: { error: `Missing required argument: ${missing.join(', ')}` },
        isError: true,
      });
    }
    let outcome: { text: string; isError: boolean };
    try {
      outcome = tool.handler(ctx, args);
    } catch (error) {
      outcome = fail(error instanceof Error ? error.message : 'tool failed');
    }
    let structured: unknown;
    try {
      structured = JSON.parse(outcome.text);
    } catch {
      structured = { text: outcome.text };
    }
    return jsonRpcResponse(id, {
      content: [{ type: 'text', text: outcome.text }],
      structuredContent: structured,
      isError: outcome.isError,
    });
  }

  void isNotification;
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}
