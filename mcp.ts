// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0). The
// server answers the 2026-07-28 `server/discover` probe and the legacy
// initialize handshake, lists the six tools, and executes them against the
// same in-memory store the REST and GraphQL handlers use.

import {
  repos, repoKey, newRepo, repoJson, issueJson, pullJson,
  filesOfCommit, diffFiles, hasConflict, makeCommit, treeFromFiles,
  invalidateRepoGit, findMergeBase, allocIssueId, allocPullId,
  VIEWER, FIXED_DATE,
  type Repo,
} from './store.ts';
import { sendJson, sendEmpty, type Ctx } from './http-util.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const SUPPORTED = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  run: (args: Record<string, unknown>) => unknown;
}

function repoOf(owner: string, name: string): Repo | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

function toolResult(result: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (name === '') throw new Error('Missing required argument: name');
      if (repos.has(repoKey(VIEWER.login, name))) throw new Error(`Repository ${VIEWER.login}/${name} already exists`);
      const repo = newRepo(
        VIEWER.login,
        name,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return JSON.parse(repoJson(repo));
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.repo === 'string' ? args.repo : '';
      const repo = repoOf(owner, name);
      if (!repo) throw new Error(`Repository ${owner}/${name} not found`);
      return JSON.parse(repoJson(repo));
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.repo === 'string' ? args.repo : '';
      const repo = repoOf(owner, name);
      if (!repo) throw new Error(`Repository ${owner}/${name} not found`);
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') throw new Error('Missing required argument: title');
      const issue = {
        id: allocIssueId(),
        number: repo.nextNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as Array<{ id: number; body: string }>,
        json: '',
        gqlId: '',
      };
      repo.issues.push(issue);
      return JSON.parse(issueJson(repo, issue));
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.repo === 'string' ? args.repo : '';
      const repo = repoOf(owner, name);
      if (!repo) throw new Error(`Repository ${owner}/${name} not found`);
      const state = typeof args.state === 'string' ? args.state : 'all';
      const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return list.map((i) => JSON.parse(issueJson(repo, i)));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from one branch to another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.repo === 'string' ? args.repo : '';
      const repo = repoOf(owner, name);
      if (!repo) throw new Error(`Repository ${owner}/${name} not found`);
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (title === '' || head === '' || base === '') throw new Error('Missing required argument: title, head or base');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
      const mergeBase = findMergeBase(headSha, new Set([baseSha])) ?? baseSha;
      const files = diffFiles(filesOfCommit(mergeBase), filesOfCommit(headSha));
      const pull = {
        id: allocPullId(),
        number: repo.nextNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        merged: false,
        mergedAt: null as string | null,
        mergeSha: null as string | null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeBase,
        files,
        json: null as string | null,
        gqlId: '',
      };
      repo.pulls.push(pull);
      return JSON.parse(pullJson(repo, pull));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.repo === 'string' ? args.repo : '';
      const repo = repoOf(owner, name);
      if (!repo) throw new Error(`Repository ${owner}/${name} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : -1;
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) throw new Error(`Pull request ${number} not found`);
      if (pull.state === 'closed') throw new Error('Pull request is already closed');
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      if (!baseTip || !headTip) throw new Error('head or base branch is missing');
      if (hasConflict(filesOfCommit(pull.mergeBase), filesOfCommit(baseTip), filesOfCommit(headTip), pull.files)) {
        throw new Error('Merge conflict');
      }
      const merged = new Map(filesOfCommit(baseTip));
      for (const f of pull.files) {
        const h = filesOfCommit(headTip).get(f.filename);
        if (h) merged.set(f.filename, h);
        else merged.delete(f.filename);
      }
      const treeOid = treeFromFiles(merged);
      const commitOid = makeCommit(treeOid, [baseTip], `Merge pull request #${pull.number} from ${pull.headRef}`);
      repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = FIXED_DATE;
      pull.mergeSha = commitOid;
      pull.json = null;
      invalidateRepoGit(repo);
      return { sha: commitOid, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}` };
    },
  },
];

const TOOLS_LIST = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

function rpcResult(ctx: Ctx, id: unknown, result: unknown): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id: id ?? null, result }, { 'mcp-session-id': 'forge-session-1' });
}

function rpcError(ctx: Ctx, status: number, id: unknown, code: number, message: string): void {
  sendJson(ctx, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { 'mcp-session-id': 'forge-session-1' });
}

export function handleMcp(ctx: Ctx): void {
  if (ctx.method === 'DELETE') {
    sendEmpty(ctx, 204);
    return;
  }
  if (ctx.method !== 'POST') {
    sendJson(ctx, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } });
    return;
  }
  const auth = ctx.req.headers.authorization;
  if (!auth || auth.trim() === '') {
    rpcError(ctx, 401, null, -32000, 'Unauthorized');
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    rpcError(ctx, 400, null, -32700, 'Parse error');
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    rpcError(ctx, 400, null, -32600, 'Invalid Request');
    return;
  }
  const req = body as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = req.params && typeof req.params === 'object' && !Array.isArray(req.params)
    ? (req.params as Record<string, unknown>)
    : {};

  // Notifications carry no id: acknowledge with 202 and no body.
  if (id === null && method.startsWith('notifications/')) {
    sendEmpty(ctx, 202, { 'mcp-session-id': 'forge-session-1' });
    return;
  }

  if (method === 'server/discover') {
    rpcResult(ctx, id, {
      protocolVersion: '2026-07-28',
      supportedVersions: SUPPORTED,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'A GitHub-core clone: repositories, issues and pull requests.',
    });
    return;
  }
  if (method === 'initialize') {
    const offered = Array.isArray((params as Record<string, unknown>).protocolVersion)
      ? ((params as Record<string, unknown>).protocolVersion as unknown[])
      : [(params as Record<string, unknown>).protocolVersion];
    let chosen = '2025-11-25';
    for (const v of offered) if (typeof v === 'string' && SUPPORTED.includes(v)) { chosen = v; break; }
    rpcResult(ctx, id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'ping') {
    rpcResult(ctx, id, {});
    return;
  }
  if (method === 'tools/list') {
    rpcResult(ctx, id, { tools: TOOLS_LIST });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const rawArgs = params.arguments;
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
    // The client maps arguments to the closest schema property name, so a
    // tool is matched by suffix (case-insensitive) as well as by exact name.
    const tool = TOOLS.find((t) => t.name === name)
      ?? TOOLS.find((t) => name.toLowerCase().endsWith(t.name));
    if (!tool) {
      rpcError(ctx, 200, id, -32602, `Unknown tool: ${name}`);
      return;
    }
    const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null);
    if (missing.length > 0) {
      rpcResult(ctx, id, toolError(`Missing required arguments: ${missing.join(', ')}`));
      return;
    }
    try {
      rpcResult(ctx, id, toolResult(tool.run(args)));
    } catch (e) {
      rpcResult(ctx, id, toolError(e instanceof Error ? e.message : String(e)));
    }
    return;
  }
  rpcError(ctx, 200, id, -32601, `Method not found: ${method}`);
}
