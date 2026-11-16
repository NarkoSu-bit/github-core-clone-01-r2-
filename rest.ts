// rest.ts — REST v3 API under /api/v3. Every reply is application/json with a non-empty
// X-GitHub-Request-Id; errors are JSON {message}; unknown routes 404 JSON; malformed JSON 400.

import { parseCommit, buildTree } from './gitobj.ts';
import { type Store, type Repo, type Issue, type Pull } from './store.ts';

export interface RestContext {
  store: Store;
  requestId: string;
  baseUrl: string;
  authenticated: boolean;
}

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
}

function json(ctx: RestContext, status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'x-github-request-id': ctx.requestId,
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      ...extraHeaders,
    },
    body,
  };
}

function error(ctx: RestContext, status: number, message: string): RestResponse {
  return json(ctx, status, { message });
}

function noContent(ctx: RestContext): RestResponse {
  return {
    status: 204,
    headers: { 'x-github-request-id': ctx.requestId },
    body: null,
  };
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userShape(store: Store, login: string): { login: string; id: number; type: string; avatar_url: string } {
  const user = store.users.get(login) ?? store.viewer;
  return {
    login: user.login,
    id: user.id,
    type: 'User',
    avatar_url: `https://avatars.githubusercontent.invalid/u/${user.id}`,
  };
}

function repoShape(ctx: RestContext, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userShape(ctx.store, repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${ctx.baseUrl}/${repo.fullName}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function labelShape(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

function issueShape(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelShape(repo.labels.get(name) ?? { name, color: '000000', description: '' })),
    comments: issue.comments.length,
    user: userShape(ctx.store, repo.owner),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `${ctx.baseUrl}/${repo.fullName}/issues/${issue.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

/** Serialized issue shape, cached on the issue (invalidated on mutation). */
function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Buffer {
  if (issue.jsonCache) return issue.jsonCache;
  const buffer = Buffer.from(JSON.stringify(issueShape(ctx, repo, issue)), 'utf8');
  issue.jsonCache = buffer;
  return buffer;
}

function jsonRaw(ctx: RestContext, status: number, body: Buffer, extraHeaders: Record<string, string> = {}): RestResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'x-github-request-id': ctx.requestId,
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      ...extraHeaders,
    },
    body,
  };
}

function commentShape(ctx: RestContext, repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userShape(ctx.store, repo.owner),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `${ctx.baseUrl}/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments/${comment.id}`,
  };
}

function pullShape(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      repo: repoShape(ctx, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      repo: repoShape(ctx, repo),
    },
    user: userShape(ctx.store, repo.owner),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `${ctx.baseUrl}/${repo.fullName}/pull/${pull.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

type Query = Record<string, string>;

function parseQuery(search: string): Query {
  const out: Query = {};
  if (!search) return out;
  const params = new URLSearchParams(search);
  for (const [key, value] of params) out[key] = value;
  return out;
}

function pageOf<T>(items: T[], query: Query): { page: T[]; total: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.per_page ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const total = items.length;
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  return { page: pageItems, total };
}

function linkHeader(ctx: RestContext, path: string, query: Query, total: number): string | undefined {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.per_page ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return undefined;
  const links: string[] = [];
  const build = (p: number, rel: string): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `<${ctx.baseUrl}${path}?${params.toString()}>; rel="${rel}"`;
  };
  if (page < totalPages) links.push(build(page + 1, 'next'));
  if (page > 1) links.push(build(page - 1, 'prev'));
  links.push(build(1, 'first'));
  links.push(build(totalPages, 'last'));
  return links.join(', ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  // LCS dynamic programming; files here are small.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: n - common, deletions: m - common };
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

export interface MergeResult {
  ok: boolean;
  sha?: string;
  message: string;
  status?: number;
}

/**
 * Squash-merge an open pull request onto its base branch. Shared by REST and GraphQL.
 * Conflict rule: a path the PR changes whose content at the current base tip differs from
 * its content at the merge base blocks the merge.
 */
export function mergePullRequest(store: Store, repo: Repo, pull: Pull): MergeResult {
  if (pull.state !== 'open') return { ok: false, message: 'Pull request is not open', status: 405 };
  const baseTip = repo.branchTip(pull.baseRef);
  if (!baseTip) return { ok: false, message: 'Not Found', status: 404 };
  const mergeBase = repo.mergeBase(pull.headSha, baseTip);
  const baseTree = repo.treeOf(mergeBase ?? pull.baseSha);
  const headTree = repo.treeOf(pull.headSha);
  const tipTree = repo.treeOf(baseTip);
  const diff = repo.diffTrees(baseTree, headTree);
  const tipFiles = tipTree ? repo.flattenTree(tipTree) : new Map<string, { oid: string; mode: string }>();
  const baseFiles = baseTree ? repo.flattenTree(baseTree) : new Map<string, { oid: string; mode: string }>();
  for (const change of diff) {
    const atTip = tipFiles.get(change.path)?.oid;
    const atBase = baseFiles.get(change.path)?.oid;
    if (atTip !== atBase) return { ok: false, message: 'Merge conflict', status: 405 };
  }
  let mergedTree = tipTree;
  for (const change of diff) {
    if (change.status === 'removed') mergedTree = repo.setPath(mergedTree, change.path, null);
    else if (change.newOid) mergedTree = repo.setPath(mergedTree, change.path, change.newOid);
  }
  const finalTree = mergedTree ?? repo.putObject('tree', buildTree([]));
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const mergeSha = store.makeCommit(repo, finalTree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.nowIso();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = store.nowIso();
  return { ok: true, sha: mergeSha, message };
}

// ---------------------------------------------------------------------------------------------
// contents: commit a file change on a branch
// ---------------------------------------------------------------------------------------------

function commitFileChange(
  ctx: RestContext,
  repo: Repo,
  branch: string,
  path: string,
  blobOid: string | null,
  message: string,
): { commitOid: string; createdBranch: boolean } {
  const tip = repo.branchTip(branch);
  let treeOid: string | undefined;
  let parents: string[] = [];
  let createdBranch = false;
  if (tip !== undefined) {
    const tree = repo.treeOf(tip);
    if (tree === undefined) throw new Error('branch tip is not a commit');
    treeOid = tree;
    parents = [tip];
  } else if (branch !== repo.defaultBranch && repo.refs.size > 0) {
    // Create the branch from the default branch tip, then commit on it.
    const defaultTip = repo.branchTip(repo.defaultBranch);
    if (defaultTip === undefined) throw new Error('default branch has no commits');
    const tree = repo.treeOf(defaultTip);
    if (tree === undefined) throw new Error('default branch tip is not a commit');
    treeOid = tree;
    parents = [defaultTip];
    createdBranch = true;
  }
  const newTree = repo.setPath(treeOid, path, blobOid);
  const commitOid = ctx.store.makeCommit(repo, newTree, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return { commitOid, createdBranch };
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

export function handleRest(
  ctx: RestContext,
  method: string,
  path: string,
  search: string,
  body: unknown,
  bodyMalformed: boolean,
): RestResponse {
  const store = ctx.store;
  const query = parseQuery(search);

  if (bodyMalformed) return error(ctx, 400, 'Problems parsing JSON');

  // GET /api/v3/ — root (public)
  if (method === 'GET' && path === '/api/v3/') {
    return json(ctx, 200, { current_user_url: `${ctx.baseUrl}/api/v3/user` }, { 'x-oauth-scopes': 'repo, user' });
  }
  // GET /api/v3/meta — public
  if (method === 'GET' && path === '/api/v3/meta') {
    return json(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  // Auth: everything below needs the bearer token (app.ts sets ctx.authenticated).
  if (!ctx.authenticated) return error(ctx, 401, 'Requires authentication');

  // GET /api/v3/user
  if (method === 'GET' && path === '/api/v3/user') {
    const viewer = store.viewer;
    return json(ctx, 200, {
      login: viewer.login,
      id: viewer.id,
      name: viewer.name,
      email: viewer.email,
      type: 'User',
    });
  }

  // GET /api/v3/user/repos
  if (method === 'GET' && path === '/api/v3/user/repos') {
    const repos = store.viewerRepos();
    const { page, total } = pageOf(repos, query);
    const headers: Record<string, string> = {};
    const link = linkHeader(ctx, '/api/v3/user/repos', query, total);
    if (link) headers.link = link;
    return json(ctx, 200, page.map((repo) => repoShape(ctx, repo)), headers);
  }

  // POST /api/v3/user/repos
  if (method === 'POST' && path === '/api/v3/user/repos') {
    if (!isRecord(body)) return error(ctx, 422, 'Validation Failed');
    const name = stringField(body, 'name');
    if (!name) return error(ctx, 422, 'Validation Failed: name is required');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return error(ctx, 422, 'Validation Failed: name is invalid');
    const description = stringField(body, 'description') ?? '';
    const isPrivate = body.private === true;
    const repo = store.createRepo(store.viewer.login, name, description, isPrivate);
    if (!repo) return error(ctx, 422, 'Validation Failed: name already exists on this account');
    return json(ctx, 201, repoShape(ctx, repo));
  }

  // /api/v3/repos/{owner}/{repo}...
  const repoMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (repoMatch) {
    const owner = decodeURIComponent(repoMatch[1]);
    const name = decodeURIComponent(repoMatch[2]);
    const rest = repoMatch[3] ?? '';
    const repo = ctx.store.getRepo(owner, name);
    if (!repo) return error(ctx, 404, 'Not Found');

    // GET /repos/{o}/{r}
    if (method === 'GET' && rest === '') return json(ctx, 200, repoShape(ctx, repo));

    // PATCH /repos/{o}/{r}
    if (method === 'PATCH' && rest === '') {
      if (!isRecord(body)) return error(ctx, 422, 'Validation Failed');
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      const newName = stringField(body, 'name');
      if (newName && newName !== repo.name) {
        if (store.getRepo(owner, newName)) return error(ctx, 422, 'Validation Failed: name already exists on this account');
        store.repos.delete(store.repoKey(owner, repo.name));
        repo.name = newName;
        store.repos.set(store.repoKey(owner, repo.name), repo);
      }
      return json(ctx, 200, repoShape(ctx, repo));
    }

    // DELETE /repos/{o}/{r}
    if (method === 'DELETE' && rest === '') {
      store.deleteRepo(owner, name);
      return noContent(ctx);
    }

    // GET /repos/{o}/{r}/branches
    if (method === 'GET' && rest === 'branches') {
      const branches: { name: string; commit: { sha: string } }[] = [];
      for (const [refName, oid] of repo.refs) {
        if (refName.startsWith('refs/heads/')) {
          branches.push({ name: refName.slice('refs/heads/'.length), commit: { sha: oid } });
        }
      }
      return json(ctx, 200, branches);
    }

    // GET /repos/{o}/{r}/branches/{branch}
    const branchMatch = rest.match(/^branches\/(.+)$/);
    if (method === 'GET' && branchMatch) {
      const branch = decodeURIComponent(branchMatch[1]);
      const tip = repo.branchTip(branch);
      if (!tip) return error(ctx, 404, 'Branch not found');
      return json(ctx, 200, { name: branch, commit: { sha: tip } });
    }

    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    const gitRefMatch = rest.match(/^git\/refs\/heads\/(.+)$/);
    if (method === 'GET' && gitRefMatch) {
      const branch = decodeURIComponent(gitRefMatch[1]);
      const tip = repo.branchTip(branch);
      if (!tip) return error(ctx, 404, 'Not Found');
      return json(ctx, 200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
    }

    // POST /repos/{o}/{r}/git/refs
    if (method === 'POST' && rest === 'git/refs') {
      if (!isRecord(body)) return error(ctx, 422, 'Validation Failed');
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (!ref || !ref.startsWith('refs/') || !sha) return error(ctx, 422, 'Validation Failed');
      if (!repo.lookup(sha)) return error(ctx, 422, 'Validation Failed: object does not exist');
      if (repo.refs.has(ref)) return error(ctx, 422, 'Validation Failed: reference already exists');
      repo.refs.set(ref, sha);
      return json(ctx, 201, { ref, object: { sha, type: 'commit' } });
    }

    // GET /repos/{o}/{r}/commits
    if (method === 'GET' && rest === 'commits') {
      const shaParam = query.sha;
      let tip: string | undefined;
      if (shaParam) tip = repo.resolveRef(shaParam);
      else tip = repo.branchTip(repo.defaultBranch);
      if (shaParam && !tip) return error(ctx, 404, 'Not Found');
      if (!tip) return json(ctx, 200, []);
      const history = repo.commitHistory(tip);
      const commits = history.map(({ oid, object }) => {
        const parsed = parseCommit(object.data);
        // GitHub's REST view returns the message without the trailing newline.
        const message = parsed.message.endsWith('\n') ? parsed.message.slice(0, -1) : parsed.message;
        return {
          sha: oid,
          commit: {
            message,
            author: { name: parsed.author, email: '', date: '' },
            committer: { name: parsed.committer, email: '', date: '' },
          },
          parents: parsed.parents.map((p) => ({ sha: p })),
        };
      });
      return json(ctx, 200, commits);
    }

    // PUT/GET/DELETE /repos/{o}/{r}/contents/{path}
    const contentsMatch = rest.match(/^contents\/(.+)$/);
    if (contentsMatch) {
      const rawPath = contentsMatch[1];
      const filePath = decodeURIComponent(rawPath);
      if (method === 'GET') {
        const refParam = query.ref;
        let tip: string | undefined;
        if (refParam) tip = repo.resolveRef(refParam);
        else tip = repo.branchTip(repo.defaultBranch);
        if (!tip) return error(ctx, 404, 'Not Found');
        const tree = repo.treeOf(tip);
        if (!tree) return error(ctx, 404, 'Not Found');
        const file = repo.readPath(tree, filePath);
        if (file) {
          return json(ctx, 200, {
            type: 'file',
            encoding: 'base64',
            size: file.data.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            content: file.data.toString('base64'),
            sha: file.oid,
          });
        }
        const dir = repo.listDir(tree, filePath);
        if (dir) {
          return json(ctx, 200, dir.map((entry) => ({
            type: entry.type,
            name: entry.name,
            path: entry.path,
            sha: entry.sha,
            size: 0,
          })));
        }
        return error(ctx, 404, 'Not Found');
      }
      if (method === 'PUT') {
        if (!isRecord(body)) return error(ctx, 422, 'Validation Failed');
        const message = stringField(body, 'message');
        const content = stringField(body, 'content');
        if (!message || content === undefined) return error(ctx, 422, 'Validation Failed');
        let contentBytes: Buffer;
        try {
          contentBytes = Buffer.from(content, 'base64');
        } catch {
          return error(ctx, 422, 'Validation Failed: content is not valid base64');
        }
        const branch = stringField(body, 'branch') ?? repo.defaultBranch;
        const givenSha = stringField(body, 'sha');
        const tip = repo.branchTip(branch);
        let isUpdate = false;
        if (tip !== undefined) {
          const tree = repo.treeOf(tip);
          if (tree) {
            const existing = repo.readPath(tree, filePath);
            if (existing) {
              isUpdate = true;
              if (!givenSha || givenSha !== existing.oid) {
                return error(ctx, 409, 'Conflict: sha does not match the current file');
              }
            }
          }
        } else if (branch !== repo.defaultBranch && repo.refs.size === 0) {
          return error(ctx, 404, 'Not Found');
        }
        const blobOid = repo.putObject('blob', contentBytes);
        const { commitOid } = commitFileChange(ctx, repo, branch, filePath, blobOid, message);
        const status = isUpdate ? 200 : 201;
        return json(ctx, status, {
          content: {
            type: 'file',
            encoding: 'base64',
            size: contentBytes.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            content: contentBytes.toString('base64'),
            sha: blobOid,
          },
          commit: { sha: commitOid, message },
        });
      }
      if (method === 'DELETE') {
        if (!isRecord(body)) return error(ctx, 422, 'Validation Failed');
        const message = stringField(body, 'message');
        const givenSha = stringField(body, 'sha');
        if (!message) return error(ctx, 422, 'Validation Failed');
        const branch = stringField(body, 'branch') ?? repo.defaultBranch;
        const tip = repo.branchTip(branch);
        if (!tip) return error(ctx, 404, 'Not Found');
        const tree = repo.treeOf(tip);
        if (!tree) return error(ctx, 404, 'Not Found');
        const existing = repo.readPath(tree, filePath);
        if (!existing) return error(ctx, 404, 'Not Found');
        if (givenSha && givenSha !== existing.oid) return error(ctx, 409, 'Conflict: sha does not match the current file');
        const { commitOid } = commitFileChange(ctx, repo, branch, filePath, null, message);
        return json(ctx, 200, { commit: { sha: commitOid, message } });
      }
    }

    // POST /repos/{o}/{r}/labels
    if (method === 'POST' && rest === 'labels') {
      if (!isRecord(body)) return error(ctx, 422, 'Validation Failed');
      const name = stringField(body, 'name');
      const color = stringField(body, 'color') ?? '000000';
      if (!name) return error(ctx, 422, 'Validation Failed: name is required');
      const label = { name, color, description: stringField(body, 'description') ?? '' };
      repo.labels.set(name, label);
      return json(ctx, 201, labelShape(label));
    }

    // POST /repos/{o}/{r}/issues  |  GET /repos/{o}/{r}/issues
    if (rest === 'issues') {
      if (method === 'POST') {
        if (!isRecord(body)) return error(ctx, 422, 'Validation Failed');
        const title = stringField(body, 'title');
        if (!title) return error(ctx, 422, 'Validation Failed: title is required');
        const bodyText = stringField(body, 'body') ?? '';
        const labelNames: string[] = [];
        if (Array.isArray(body.labels)) {
          for (const label of body.labels) {
            if (typeof label !== 'string') return error(ctx, 422, 'Validation Failed: labels must be strings');
            if (!repo.labels.has(label)) return error(ctx, 422, `Validation Failed: label "${label}" does not exist`);
            labelNames.push(label);
          }
        }
        const now = store.nowIso();
        const issue: Issue = {
          id: store.nextIssueId,
          number: repo.nextIssue,
          title,
          body: bodyText,
          state: 'open',
          labels: labelNames,
          comments: [],
          createdSeq: store.nextSeq(),
          createdAt: now,
          updatedAt: now,
        };
        store.nextIssueId += 1;
        repo.nextIssue += 1;
        repo.issues.push(issue);
        return json(ctx, 201, issueShape(ctx, repo, issue));
      }
      if (method === 'GET') {
        const state = query.state ?? 'open';
        let issues = repo.issues;
        if (state === 'open') issues = issues.filter((i) => i.state === 'open');
        else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
        const sort = query.sort ?? 'created';
        const direction = query.direction ?? 'desc';
        const sorted = [...issues];
        if (sort === 'created') {
          sorted.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const { page, total } = pageOf(sorted, query);
        const headers: Record<string, string> = {};
        const link = linkHeader(ctx, `/api/v3/repos/${repo.fullName}/issues`, query, total);
        if (link) headers.link = link;
        return json(ctx, 200, page.map((issue) => issueShape(ctx, repo, issue)), headers);
      }
    }

    // /repos/{o}/{r}/issues/{n}...
    const issueMatch = rest.match(/^issues\/(\d+)(?:\/(.*))?$/);
    if (issueMatch) {
      const number = Number.parseInt(issueMatch[1], 10);
      const sub = issueMatch[2] ?? '';
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return error(ctx, 404, 'Not Found');
      if (method === 'GET' && sub === '') return jsonRaw(ctx, 200, issueJson(ctx, repo, issue));
      if (method === 'PATCH' && sub === '') {
        if (!isRecord(body)) return error(ctx, 422, 'Validation Failed');
        const state = stringField(body, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = stringField(body, 'title');
        if (title) issue.title = title;
        const bodyText = stringField(body, 'body');
        if (bodyText !== undefined) issue.body = bodyText;
        issue.updatedAt = store.nowIso();
        issue.jsonCache = null;
        return json(ctx, 200, issueShape(ctx, repo, issue));
      }
      if (sub === 'comments') {
        if (method === 'POST') {
          if (!isRecord(body)) return error(ctx, 422, 'Validation Failed');
          const bodyText = stringField(body, 'body');
          if (!bodyText) return error(ctx, 422, 'Validation Failed: body is required');
          const comment = { id: store.nextCommentId, body: bodyText, createdAt: store.nowIso() };
          store.nextCommentId += 1;
          issue.comments.push(comment);
          issue.jsonCache = null;
          return json(ctx, 201, commentShape(ctx, repo, issue, comment));
        }
        if (method === 'GET') {
          return json(ctx, 200, issue.comments.map((c) => commentShape(ctx, repo, issue, c)));
        }
      }
    }

    // POST /repos/{o}/{r}/pulls  |  GET /repos/{o}/{r}/pulls
    if (rest === 'pulls') {
      if (method === 'POST') {
        if (!isRecord(body)) return error(ctx, 422, 'Validation Failed');
        const title = stringField(body, 'title');
        const head = stringField(body, 'head');
        const base = stringField(body, 'base');
        if (!title || !head || !base) return error(ctx, 422, 'Validation Failed');
        const headSha = repo.branchTip(head);
        const baseSha = repo.branchTip(base);
        if (!headSha || !baseSha) return error(ctx, 422, 'Validation Failed: head or base branch does not exist');
        const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (duplicate) return error(ctx, 422, 'Validation Failed: a pull request already exists for this branch');
        const now = store.nowIso();
        const pull: Pull = {
          id: store.nextPullId,
          number: repo.nextPull,
          title,
          body: stringField(body, 'body') ?? '',
          state: 'open',
          headRef: head,
          headSha,
          baseRef: base,
          baseSha,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          createdSeq: store.nextSeq(),
          createdAt: now,
          updatedAt: now,
        };
        store.nextPullId += 1;
        repo.nextPull += 1;
        repo.pulls.push(pull);
        return json(ctx, 201, pullShape(ctx, repo, pull));
      }
      if (method === 'GET') {
        const state = query.state ?? 'open';
        let pulls = repo.pulls;
        if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
        const sorted = [...pulls].sort((a, b) => b.createdSeq - a.createdSeq);
        const { page, total } = pageOf(sorted, query);
        const headers: Record<string, string> = {};
        const link = linkHeader(ctx, `/api/v3/repos/${repo.fullName}/pulls`, query, total);
        if (link) headers.link = link;
        return json(ctx, 200, page.map((pull) => pullShape(ctx, repo, pull)), headers);
      }
    }

    // /repos/{o}/{r}/pulls/{n}...
    const pullMatch = rest.match(/^pulls\/(\d+)(?:\/(.*))?$/);
    if (pullMatch) {
      const number = Number.parseInt(pullMatch[1], 10);
      const sub = pullMatch[2] ?? '';
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return error(ctx, 404, 'Not Found');
      if (method === 'GET' && sub === '') return json(ctx, 200, pullShape(ctx, repo, pull));
      if (method === 'GET' && sub === 'files') {
        const baseTree = repo.treeOf(pull.baseSha);
        const headTree = repo.treeOf(pull.headSha);
        const diff = repo.diffTrees(baseTree, headTree);
        const files = diff.map((change) => {
          let additions = 0;
          let deletions = 0;
          if (change.status === 'added') {
            const blob = change.newOid ? repo.lookup(change.newOid) : undefined;
            additions = blob ? countLines(blob.data.toString('utf8')) : 0;
          } else if (change.status === 'removed') {
            const blob = change.oldOid ? repo.lookup(change.oldOid) : undefined;
            deletions = blob ? countLines(blob.data.toString('utf8')) : 0;
          } else {
            const oldBlob = change.oldOid ? repo.lookup(change.oldOid) : undefined;
            const newBlob = change.newOid ? repo.lookup(change.newOid) : undefined;
            const counts = diffLines(
              oldBlob ? oldBlob.data.toString('utf8') : '',
              newBlob ? newBlob.data.toString('utf8') : '',
            );
            additions = counts.additions;
            deletions = counts.deletions;
          }
          return {
            sha: change.newOid ?? change.oldOid ?? '',
            filename: change.path,
            status: change.status,
            additions,
            deletions,
            changes: additions + deletions,
          };
        });
        return json(ctx, 200, files);
      }
      if (method === 'PUT' && sub === 'merge') {
        const result = mergePullRequest(store, repo, pull);
        if (!result.ok) return error(ctx, result.status ?? 405, result.message);
        return json(ctx, 200, { sha: result.sha, merged: true, message: result.message });
      }
    }
  }

  return error(ctx, 404, 'Not Found');
}
