// rest.ts — the REST v3 surface (/api/v3).
//
// Performance design:
// - Issue reads serve a precomputed JSON string (built once at creation,
//   rebuilt on PATCH/comment): the 2,000-read bench workload does zero
//   JSON.stringify and zero object allocation on its hot path.
// - Repo/pull JSON strings are likewise precomputed and refreshed on the
//   (rare) mutations that change them.
// - Routing is hand-rolled indexOf/slice on the split path; no `new URL()`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Comment, Issue, Label, Pull, Repo } from './store.ts';
import { Store, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, b64, globalId, isoAt } from './store.ts';
import {
  buildCommit,
  buildTree,
  flattenTree,
  getTreeEntries,
  isAncestor,
  mergeBase,
  parseCommitParents,
  storeObject,
} from './git.ts';
import { isRecord, jsonReply, messageReply, parseJsonBody, readBody } from './http-util.ts';

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_BODY = 10 * 1024 * 1024;

// ---------------------------------------------------------------- JSON builders

function userJson(login: string, id: number): string {
  return JSON.stringify({ login, id, node_id: globalId('R', login), type: 'User', site_admin: false });
}

function userObj(login: string, id: number): Record<string, unknown> {
  return { login, id, node_id: globalId('R', login), type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): string {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length;
  return JSON.stringify({
    id: repo.dbId,
    node_id: globalId('R', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObj(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1002),
    private: repo.priv,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.priv ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    archived: false,
    disabled: false,
  });
}

export function refreshRepoJson(repo: Repo): void {
  repo.json = repoJson(repo);
}

function labelJson(label: Label, repo: Repo): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('R', repo.owner, repo.name),
    name: label.name,
    color: label.color,
    description: label.description,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): string {
  return JSON.stringify({
    id: issue.dbId,
    node_id: globalId('I', repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userObj(issue.userLogin, issue.userLogin === VIEWER_LOGIN ? VIEWER_ID : 1001),
    labels: issue.labels.map((l) => labelJson(l, repo)),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    labels_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
  });
}

export function refreshIssueJson(repo: Repo, issue: Issue): void {
  issue.json = issueJson(repo, issue);
}

function refObj(repo: Repo, ref: string, sha: string): Record<string, unknown> {
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userObj(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1002),
    repo: { id: repo.dbId, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  };
}

export function pullJson(repo: Repo, pull: Pull): string {
  return JSON.stringify({
    id: pull.dbId,
    node_id: globalId('PR', repo.owner, repo.name, pull.number),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userObj(pull.userLogin, pull.userLogin === VIEWER_LOGIN ? VIEWER_ID : 1001),
    labels: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: true,
    mergeable_state: 'clean',
    merged_by: null,
    head: refObj(repo, pull.headRef, pull.headSha),
    base: refObj(repo, pull.baseRef, pull.baseSha),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  });
}

export function refreshPullJson(repo: Repo, pull: Pull): void {
  pull.json = pullJson(repo, pull);
}

export function commentJson(repo: Repo, issue: Issue, comment: Comment): string {
  return JSON.stringify({
    id: comment.dbId,
    node_id: globalId('C', repo.owner, repo.name, issue.number, comment.dbId),
    body: comment.body,
    user: userObj(comment.userLogin, comment.userLogin === VIEWER_LOGIN ? VIEWER_ID : 1001),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.dbId}`,
    issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${comment.dbId}`,
  });
}

/** Refresh every open pull whose head/base ref just moved. */
export function refreshPullsForRef(store: Store, repo: Repo, refName: string): void {
  const branch = refName.startsWith('refs/heads/') ? refName.slice('refs/heads/'.length) : null;
  if (branch === null) return;
  const sha = repo.refs.get(refName);
  if (sha === undefined) return;
  for (const pull of repo.pulls.values()) {
    if (pull.state !== 'open') continue;
    let changed = false;
    if (pull.headRef === branch) {
      pull.headSha = sha;
      changed = true;
    }
    if (pull.baseRef === branch) {
      pull.baseSha = sha;
      changed = true;
    }
    if (changed) refreshPullJson(repo, pull);
  }
}

// ---------------------------------------------------------------- git helpers for REST

function parseAuthor(data: Buffer): { name: string; email: string; date: string } {
  const text = data.toString('ascii', 0, Math.min(data.length, 8192));
  const m = /^author ([^<]+) <([^>]*)> (\d+) [+-]\d{4}/m.exec(text);
  if (m === null) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoAt(0) };
  return { name: m[1]!.trim(), email: m[2]!, date: new Date(Number(m[3]) * 1000).toISOString() };
}

function commitMessageOf(data: Buffer): string {
  const text = data.toString('utf8');
  const i = text.indexOf('\n\n');
  return i === -1 ? '' : text.slice(i + 2);
}

/** Build a tree from a flat path -> {oid, mode} map (bottom-up, dirs deepest first). */
export function buildTreeFromFlat(
  repo: Repo,
  flat: Map<string, { oid: string; mode: string }>,
): string {
  const byDir = new Map<string, Map<string, { oid: string; mode: string }>>();
  for (const [p, v] of flat) {
    const slash = p.lastIndexOf('/');
    const dir = slash === -1 ? '' : p.slice(0, slash);
    const name = slash === -1 ? p : p.slice(slash + 1);
    let m = byDir.get(dir);
    if (m === undefined) {
      m = new Map();
      byDir.set(dir, m);
    }
    m.set(name, v);
  }
  if (!byDir.has('')) byDir.set('', new Map());
  const dirs = [...byDir.keys()].sort((a, b) => b.split('/').length - a.split('/').length);
  const treeOidOf = new Map<string, string>();
  for (const dir of dirs) {
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const [name, v] of byDir.get(dir)!) entries.push({ mode: v.mode, name, oid: v.oid });
    for (const [sub, subOid] of treeOidOf) {
      const parent = sub.lastIndexOf('/') === -1 ? '' : sub.slice(0, sub.lastIndexOf('/'));
      if (parent === dir) entries.push({ mode: '40000', name: sub.slice(sub.lastIndexOf('/') + 1), oid: subOid });
    }
    if (entries.length === 0 && dir !== '') continue;
    treeOidOf.set(dir, storeObject(repo, 'tree', buildTree(entries)));
  }
  return treeOidOf.get('') ?? storeObject(repo, 'tree', buildTree([]));
}

/** Line diff counts via LCS (files here are small). */
function lineDiff(a: string, b: string): { additions: number; deletions: number } {
  const al = a === '' ? [] : a.split('\n');
  const bl = b === '' ? [] : b.split('\n');
  if (al.length > 0 && al[al.length - 1] === '') al.pop();
  if (bl.length > 0 && bl[bl.length - 1] === '') bl.pop();
  const n = al.length;
  const m = bl.length;
  // Two-row LCS length.
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      cur[j] = al[i - 1] === bl[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}

interface EntryEq {
  oid: string;
  mode: string;
}
function sameEntry(a: EntryEq | undefined, b: EntryEq | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.oid === b.oid && a.mode === b.mode;
}

/** Three-way merge of trees; returns the merged tree oid, or conflict=true. */
export function threeWayMerge(repo: Repo, baseOid: string, headOid: string, mbOid: string | null): { treeOid: string; conflict: boolean } {
  const baseFlat = flattenTree(repo, repo.commitTree.get(baseOid) ?? null);
  const headFlat = flattenTree(repo, repo.commitTree.get(headOid) ?? null);
  const mbFlat = flattenTree(repo, mbOid === null ? null : (repo.commitTree.get(mbOid) ?? null));
  const result = new Map<string, EntryEq>(baseFlat);
  const paths = new Set<string>([...mbFlat.keys(), ...headFlat.keys(), ...baseFlat.keys()]);
  for (const p of paths) {
    const mb = mbFlat.get(p);
    const h = headFlat.get(p);
    const b = baseFlat.get(p);
    if (sameEntry(mb, h)) continue; // head unchanged: keep base
    if (sameEntry(mb, b)) {
      // base unchanged: take head
      if (h === undefined) result.delete(p);
      else result.set(p, h);
      continue;
    }
    if (sameEntry(h, b)) continue; // same change both sides
    return { treeOid: '', conflict: true };
  }
  return { treeOid: buildTreeFromFlat(repo, result), conflict: false };
}

// ---------------------------------------------------------------- handler plumbing

interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  reqId: string;
  host: string;
}

async function readJson(ctx: Ctx): Promise<Record<string, unknown>> {
  const buf = await readBody(ctx.req, MAX_BODY);
  const v = parseJsonBody(buf);
  if (v === null) return {};
  if (!isRecord(v)) {
    const err = new Error('Problems parsing JSON') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return v;
}

function needRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function notFound(ctx: Ctx, message = 'Not Found'): void {
  messageReply(ctx.res, 404, message, ctx.reqId);
}

function unprocessable(ctx: Ctx, message: string): void {
  jsonReply(ctx.res, 422, JSON.stringify({ message, errors: [{ resource: 'Repository', code: 'custom', field: 'name', message }] }), ctx.reqId);
}

// ---------------------------------------------------------------- root / meta / user

function handleRoot(res: ServerResponse, reqId: string): void {
  jsonReply(
    res,
    200,
    JSON.stringify({
      current_user_url: 'https://api.github.com/user',
      authorizations_url: 'https://api.github.com/authorizations',
      repository_url: 'https://api.github.com/repos/{owner}/{repo}',
      user_url: 'https://api.github.com/users/{user}',
    }),
    reqId,
    { 'x-oauth-scopes': 'repo, user' },
  );
}

function handleMeta(ctx: Ctx): void {
  jsonReply(
    ctx.res,
    200,
    JSON.stringify({
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      hooks: [],
      git: [],
      pages: [],
    }),
    ctx.reqId,
  );
}

function handleUser(ctx: Ctx): void {
  jsonReply(
    ctx.res,
    200,
    JSON.stringify({
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: globalId('R', VIEWER_LOGIN),
      avatar_url: '',
      type: 'User',
      site_admin: false,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      html_url: `https://github.com/${VIEWER_LOGIN}`,
      url: `https://api.github.com/users/${VIEWER_LOGIN}`,
    }),
    ctx.reqId,
  );
}

// ---------------------------------------------------------------- repos

async function handleCreateRepo(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx);
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '' || /[/\s]/.test(name)) {
    unprocessable(ctx, 'name is invalid');
    return;
  }
  const repo = ctx.store.createRepo(
    VIEWER_LOGIN,
    name,
    typeof body.description === 'string' ? body.description : '',
    body.private === true,
  );
  if (repo === null) {
    unprocessable(ctx, 'name already exists on this account');
    return;
  }
  refreshRepoJson(repo);
  jsonReply(ctx.res, 201, repo.json, ctx.reqId);
}

function handleListUserRepos(ctx: Ctx, query: Map<string, string>): void {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const all = [...ctx.store.repos.values()]
    .filter((r) => r.owner === VIEWER_LOGIN)
    .sort((a, b) => a.dbId - b.dbId);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const body = `[${slice.map((r) => r.json).join(',')}]`;
  const links: string[] = [];
  const base = `http://${ctx.host}/api/v3/user/repos?per_page=${perPage}`;
  if (page < totalPages) {
    links.push(`<${base}&page=${page + 1}>; rel="next"`);
    links.push(`<${base}&page=${totalPages}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${base}&page=${page - 1}>; rel="prev"`);
    links.push(`<${base}&page=1>; rel="first"`);
  }
  jsonReply(ctx.res, 200, body, ctx.reqId, links.length > 0 ? { link: links.join(', ') } : undefined);
}

function handleGetRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  jsonReply(ctx.res, 200, repo.json, ctx.reqId);
}

async function handlePatchRepo(ctx: Ctx, owner: string, name: string): Promise<void> {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const body = await readJson(ctx);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.priv = body.private;
  if (typeof body.default_branch === 'string' && body.default_branch !== '') {
    repo.defaultBranch = body.default_branch;
  }
  repo.updatedAt = isoAt(repo.dbId);
  refreshRepoJson(repo);
  jsonReply(ctx.res, 200, repo.json, ctx.reqId);
}

function handleDeleteRepo(ctx: Ctx, owner: string, name: string): void {
  if (!ctx.store.deleteRepo(owner, name)) {
    notFound(ctx);
    return;
  }
  ctx.res.writeHead(204, { 'x-github-request-id': ctx.reqId });
  ctx.res.end();
}

// ---------------------------------------------------------------- git refs / branches / commits

async function handleCreateRef(ctx: Ctx, owner: string, name: string): Promise<void> {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const body = await readJson(ctx);
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || !SHA_RE.test(sha) || !repo.objects.has(sha)) {
    unprocessable(ctx, 'Invalid request');
    return;
  }
  if (repo.refs.has(ref)) {
    unprocessable(ctx, 'Reference already exists');
    return;
  }
  repo.refs.set(ref, sha);
  ctx.store.touchRefs(repo);
  refreshPullsForRef(ctx.store, repo, ref);
  jsonReply(ctx.res, 201, JSON.stringify({ ref, node_id: globalId('R', owner, name), object: { sha, type: 'commit', url: '' } }), ctx.reqId);
}

function handleGetRef(ctx: Ctx, owner: string, name: string, refName: string): void {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const sha = repo.refs.get(refName);
  if (sha === undefined) {
    notFound(ctx);
    return;
  }
  jsonReply(ctx.res, 200, JSON.stringify({ ref: refName, node_id: globalId('R', owner, name), object: { sha, type: 'commit', url: '' } }), ctx.reqId);
}

function handleListBranches(ctx: Ctx, owner: string, name: string): void {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const out: unknown[] = [];
  for (const [ref, sha] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false });
  }
  jsonReply(ctx.res, 200, JSON.stringify(out), ctx.reqId);
}

function handleGetBranch(ctx: Ctx, owner: string, name: string, branch: string): void {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    notFound(ctx);
    return;
  }
  jsonReply(ctx.res, 200, JSON.stringify({ name: branch, commit: { sha, url: '' }, protected: false }), ctx.reqId);
}

function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (SHA_RE.test(ref)) return repo.objects.has(ref) ? ref : null;
  return (
    repo.refs.get(`refs/heads/${ref}`) ??
    repo.refs.get(`refs/tags/${ref}`) ??
    repo.refs.get(ref) ??
    null
  );
}

function handleListCommits(ctx: Ctx, owner: string, name: string, query: Map<string, string>): void {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const tip = resolveRef(repo, query.get('sha') ?? undefined);
  if (tip === null) {
    notFound(ctx, 'No commit found for SHA');
    return;
  }
  const seen = new Set<string>([tip]);
  const stack: string[] = [tip];
  const commits: string[] = [];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    commits.push(cur);
    for (const p of repo.commitParents.get(cur) ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  // Newest first: a child always has a higher creation sequence than its parents.
  commits.sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
  const out = commits.map((oid) => {
    const obj = repo.objects.get(oid)!;
    const author = parseAuthor(obj.b);
    return {
      sha: oid,
      node_id: globalId('R', owner, name),
      commit: {
        message: commitMessageOf(obj.b),
        author,
        committer: author,
        tree: { sha: repo.commitTree.get(oid) ?? '' },
      },
      author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      parents: (repo.commitParents.get(oid) ?? []).map((p) => ({ sha: p })),
    };
  });
  jsonReply(ctx.res, 200, JSON.stringify(out), ctx.reqId);
}

// ---------------------------------------------------------------- contents

function handleGetContents(ctx: Ctx, owner: string, name: string, path: string, query: Map<string, string>): void {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const tip = resolveRef(repo, query.get('ref') ?? undefined);
  if (tip === null) {
    notFound(ctx);
    return;
  }
  const treeOid = repo.commitTree.get(tip);
  if (treeOid === undefined) {
    notFound(ctx);
    return;
  }
  if (path === '') {
    // Root directory listing.
    const out = getTreeEntries(repo, treeOid).map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: e.name,
      sha: e.oid,
      size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.b.length ?? 0),
    }));
    jsonReply(ctx.res, 200, JSON.stringify(out), ctx.reqId);
    return;
  }
  const flat = flattenTree(repo, treeOid);
  const file = flat.get(path);
  if (file !== undefined) {
    const obj = repo.objects.get(file.oid)!;
    const name = path.slice(path.lastIndexOf('/') + 1);
    jsonReply(
      ctx.res,
      200,
      JSON.stringify({
        type: 'file',
        encoding: 'base64',
        size: obj.b.length,
        name,
        path,
        content: obj.b.toString('base64'),
        sha: file.oid,
      }),
      ctx.reqId,
    );
    return;
  }
  // Directory?
  const prefix = `${path}/`;
  const out: unknown[] = [];
  const seenDirs = new Set<string>();
  for (const [p, v] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      out.push({ type: 'file', name: rest, path: p, sha: v.oid, size: repo.objects.get(v.oid)?.b.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        out.push({ type: 'dir', name: dir, path: `${path}/${dir}`, sha: '', size: 0 });
      }
    }
  }
  if (out.length === 0) {
    // Maybe it is a tree path (empty dir) — look the tree up directly.
    const parts = path.split('/');
    let cur = treeOid;
    let ok = true;
    for (const part of parts) {
      const e = getTreeEntries(repo, cur).find((x) => x.name === part && x.mode === '40000');
      if (e === undefined) {
        ok = false;
        break;
      }
      cur = e.oid;
    }
    if (!ok) {
      notFound(ctx);
      return;
    }
    const dirOut = getTreeEntries(repo, cur).map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: `${path}/${e.name}`,
      sha: e.oid,
      size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.b.length ?? 0),
    }));
    jsonReply(ctx.res, 200, JSON.stringify(dirOut), ctx.reqId);
    return;
  }
  jsonReply(ctx.res, 200, JSON.stringify(out), ctx.reqId);
}

async function handlePutContents(ctx: Ctx, owner: string, name: string, path: string): Promise<void> {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const body = await readJson(ctx);
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    unprocessable(ctx, 'content is not valid base64');
    return;
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const baseTip = repo.refs.get(refName) ?? null;
  const baseTree = baseTip === null ? null : (repo.commitTree.get(baseTip) ?? null);
  const flat = flattenTree(repo, baseTree);
  const existing = flat.get(path);
  if (body.sha !== undefined) {
    if (existing === undefined || existing.oid !== body.sha) {
      jsonReply(ctx.res, 409, JSON.stringify({ message: 'sha does not match' }), ctx.reqId);
      return;
    }
  }
  const blobOid = storeObject(repo, 'blob', content);
  const newTree = buildTreeFromFlat(repo, new Map([...flat, [path, { oid: blobOid, mode: '100644' }]]));
  const parents = baseTip === null ? [] : [baseTip];
  const commitBuf = buildCommit(newTree, parents, VIEWER_NAME, VIEWER_EMAIL, 1739175597 + ctx.store.commitCounter, message);
  const commitOid = storeObject(repo, 'commit', commitBuf);
  ctx.store.commitCounter += 1;
  repo.refs.set(refName, commitOid);
  ctx.store.touchRefs(repo);
  refreshPullsForRef(ctx.store, repo, refName);
  const status = existing === undefined ? 201 : 200;
  jsonReply(
    ctx.res,
    status,
    JSON.stringify({
      content: { name: path.slice(path.lastIndexOf('/') + 1), path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitOid, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
    }),
    ctx.reqId,
  );
}

async function handleDeleteContents(ctx: Ctx, owner: string, name: string, path: string): Promise<void> {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const body = await readJson(ctx);
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const baseTip = repo.refs.get(refName) ?? null;
  if (baseTip === null) {
    notFound(ctx);
    return;
  }
  const flat = flattenTree(repo, repo.commitTree.get(baseTip) ?? null);
  const existing = flat.get(path);
  if (existing === undefined) {
    notFound(ctx);
    return;
  }
  if (body.sha !== undefined && existing.oid !== body.sha) {
    jsonReply(ctx.res, 409, JSON.stringify({ message: 'sha does not match' }), ctx.reqId);
    return;
  }
  flat.delete(path);
  const newTree = buildTreeFromFlat(repo, flat);
  const commitBuf = buildCommit(newTree, [baseTip], VIEWER_NAME, VIEWER_EMAIL, 1739175597 + ctx.store.commitCounter, message);
  const commitOid = storeObject(repo, 'commit', commitBuf);
  ctx.store.commitCounter += 1;
  repo.refs.set(refName, commitOid);
  ctx.store.touchRefs(repo);
  refreshPullsForRef(ctx.store, repo, refName);
  jsonReply(ctx.res, 200, JSON.stringify({ content: null, commit: { sha: commitOid, message } }), ctx.reqId);
}

// ---------------------------------------------------------------- labels / issues / comments

async function handleCreateLabel(ctx: Ctx, owner: string, name: string): Promise<void> {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const body = await readJson(ctx);
  const labelName = typeof body.name === 'string' ? body.name : '';
  const color = typeof body.color === 'string' ? body.color : 'ededed';
  if (labelName === '') {
    unprocessable(ctx, 'name is required');
    return;
  }
  if (repo.labels.has(labelName)) {
    unprocessable(ctx, 'Label already exists');
    return;
  }
  const label: Label = { id: ++ctx.store.labelSeq, name: labelName, color, description: typeof body.description === 'string' ? body.description : '' };
  repo.labels.set(labelName, label);
  jsonReply(ctx.res, 201, JSON.stringify(labelJson(label, repo)), ctx.reqId);
}

async function handleCreateIssue(ctx: Ctx, owner: string, name: string): Promise<void> {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const body = await readJson(ctx);
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') {
    unprocessable(ctx, 'title is required');
    return;
  }
  const labelNames: string[] = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
  const labels: Label[] = [];
  for (const ln of labelNames) {
    const l = repo.labels.get(ln);
    if (l === undefined) {
      unprocessable(ctx, `Label does not exist: ${ln}`);
      return;
    }
    labels.push(l);
  }
  const dbId = ++ctx.store.issueSeq;
  const number = ++repo.issueSeq;
  const now = isoAt(dbId);
  const issue: Issue = {
    dbId,
    number,
    title,
    body: typeof body.body === 'string' ? body.body : '',
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
  jsonReply(ctx.res, 201, issue.json, ctx.reqId);
}

function handleListIssues(ctx: Ctx, owner: string, name: string, query: Map<string, string>): void {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  let list = [...repo.issues.values()];
  if (state !== 'all') list = list.filter((i) => i.state === state);
  list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  jsonReply(ctx.res, 200, `[${list.map((i) => i.json).join(',')}]`, ctx.reqId);
}

function handleGetIssue(ctx: Ctx, owner: string, name: string, n: number): void {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const issue = repo.issues.get(n);
  if (issue === undefined) {
    notFound(ctx);
    return;
  }
  // Hot path: serve the precomputed string, no serialization work.
  jsonReply(ctx.res, 200, issue.json, ctx.reqId);
}

async function handlePatchIssue(ctx: Ctx, owner: string, name: string, n: number): Promise<void> {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const issue = repo.issues.get(n);
  if (issue === undefined) {
    notFound(ctx);
    return;
  }
  const body = await readJson(ctx);
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? isoAt(issue.dbId) : null;
  }
  issue.updatedAt = isoAt(issue.dbId);
  refreshIssueJson(repo, issue);
  refreshRepoJson(repo);
  jsonReply(ctx.res, 200, issue.json, ctx.reqId);
}

async function handleCreateComment(ctx: Ctx, owner: string, name: string, n: number): Promise<void> {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const issue = repo.issues.get(n);
  if (issue === undefined) {
    notFound(ctx);
    return;
  }
  const body = await readJson(ctx);
  const text = typeof body.body === 'string' ? body.body : '';
  const dbId = ++ctx.store.commentSeq;
  const now = isoAt(dbId);
  const comment: Comment = { dbId, id: dbId, body: text, userLogin: VIEWER_LOGIN, createdAt: now, updatedAt: now, json: '' };
  comment.json = commentJson(repo, issue, comment);
  issue.comments.push(comment);
  refreshIssueJson(repo, issue);
  jsonReply(ctx.res, 201, comment.json, ctx.reqId);
}

function handleListComments(ctx: Ctx, owner: string, name: string, n: number): void {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const issue = repo.issues.get(n);
  if (issue === undefined) {
    notFound(ctx);
    return;
  }
  jsonReply(ctx.res, 200, `[${issue.comments.map((c) => c.json).join(',')}]`, ctx.reqId);
}

// ---------------------------------------------------------------- pulls

async function handleCreatePull(ctx: Ctx, owner: string, name: string): Promise<void> {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const body = await readJson(ctx);
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  if (title === '' || head === '' || base === '') {
    unprocessable(ctx, 'title, head and base are required');
    return;
  }
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) {
    unprocessable(ctx, 'head or base branch does not exist');
    return;
  }
  const dbId = ++ctx.store.pullSeq;
  const number = ++repo.pullSeq;
  const now = isoAt(dbId);
  const pull: Pull = {
    dbId,
    number,
    title,
    body: typeof body.body === 'string' ? body.body : '',
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
  jsonReply(ctx.res, 201, pull.json, ctx.reqId);
}

function handleGetPull(ctx: Ctx, owner: string, name: string, n: number): void {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const pull = repo.pulls.get(n);
  if (pull === undefined) {
    notFound(ctx);
    return;
  }
  jsonReply(ctx.res, 200, pull.json, ctx.reqId);
}

function handleListPulls(ctx: Ctx, owner: string, name: string, query: Map<string, string>): void {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const state = query.get('state') ?? 'open';
  let list = [...repo.pulls.values()];
  if (state !== 'all') list = list.filter((p) => p.state === state);
  list.sort((a, b) => b.number - a.number);
  jsonReply(ctx.res, 200, `[${list.map((p) => p.json).join(',')}]`, ctx.reqId);
}

function handleListPullFiles(ctx: Ctx, owner: string, name: string, n: number): void {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const pull = repo.pulls.get(n);
  if (pull === undefined) {
    notFound(ctx);
    return;
  }
  const mb = mergeBase(repo, pull.headSha, pull.baseSha);
  const baseFlat = flattenTree(repo, mb === null ? null : (repo.commitTree.get(mb) ?? null));
  const headFlat = flattenTree(repo, repo.commitTree.get(pull.headSha) ?? null);
  const out: Record<string, unknown>[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const p of [...paths].sort()) {
    const b = baseFlat.get(p);
    const h = headFlat.get(p);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    let status: string;
    let additions = 0;
    let deletions = 0;
    if (b === undefined && h !== undefined) {
      status = 'added';
      const text = repo.objects.get(h.oid)?.b.toString('utf8') ?? '';
      additions = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } else if (b !== undefined && h === undefined) {
      status = 'removed';
      const text = repo.objects.get(b.oid)?.b.toString('utf8') ?? '';
      deletions = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } else {
      status = 'modified';
      const oldText = repo.objects.get(b!.oid)?.b.toString('utf8') ?? '';
      const newText = repo.objects.get(h!.oid)?.b.toString('utf8') ?? '';
      const d = lineDiff(oldText, newText);
      additions = d.additions;
      deletions = d.deletions;
    }
    out.push({ filename: p, status, additions, deletions, changes: additions + deletions, sha: h?.oid ?? b?.oid ?? '' });
  }
  jsonReply(ctx.res, 200, JSON.stringify(out), ctx.reqId);
}

async function handleMergePull(ctx: Ctx, owner: string, name: string, n: number): Promise<void> {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const pull = repo.pulls.get(n);
  if (pull === undefined) {
    notFound(ctx);
    return;
  }
  if (pull.merged || pull.state === 'closed') {
    jsonReply(ctx.res, 405, JSON.stringify({ message: 'Pull request has already been merged' }), ctx.reqId);
    return;
  }
  const body = await readJson(ctx);
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  if (method !== 'squash' && method !== 'merge') {
    unprocessable(ctx, `unsupported merge_method: ${method}`);
    return;
  }
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mb = mergeBase(repo, headSha, baseSha);
  const merged = threeWayMerge(repo, baseSha, headSha, mb);
  if (merged.conflict) {
    jsonReply(ctx.res, 405, JSON.stringify({ message: 'Merge conflict' }), ctx.reqId);
    return;
  }
  const parents = method === 'squash' ? [baseSha] : [baseSha, headSha];
  const message = method === 'squash' ? pull.title : `Merge pull request #${pull.number} from ${pull.headRef}`;
  const commitBuf = buildCommit(merged.treeOid, parents, VIEWER_NAME, VIEWER_EMAIL, 1739175597 + ctx.store.commitCounter, message);
  const commitOid = storeObject(repo, 'commit', commitBuf);
  ctx.store.commitCounter += 1;
  const baseRefName = `refs/heads/${pull.baseRef}`;
  repo.refs.set(baseRefName, commitOid);
  ctx.store.touchRefs(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoAt(pull.dbId);
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = isoAt(pull.dbId);
  pull.baseSha = commitOid;
  pull.headSha = headSha;
  refreshPullJson(repo, pull);
  refreshRepoJson(repo);
  jsonReply(
    ctx.res,
    200,
    JSON.stringify({ sha: commitOid, merged: true, message: 'Pull request successfully merged' }),
    ctx.reqId,
  );
}

// ---------------------------------------------------------------- dispatch

const KNOWN_ROUTES = new Set([
  'meta', 'user', 'repos',
]);

export async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: Map<string, string>,
  reqId: string,
  host: string,
): Promise<void> {
  const ctx: Ctx = { store, req, res, reqId, host };
  const method = (req.method ?? 'GET').toUpperCase();
  try {
    // GET /api/v3/ — the API root: 200 JSON with X-OAuth-Scopes.
    if (segments.length === 0) {
      if (method !== 'GET') return methodNotAllowed(ctx);
      handleRoot(ctx.res, ctx.reqId);
      return;
    }
    const [first] = segments;
    if (first === 'meta') {
      if (method !== 'GET') return methodNotAllowed(ctx);
      handleMeta(ctx);
      return;
    }
    if (first === 'user' && segments.length === 1) {
      if (method !== 'GET') return methodNotAllowed(ctx);
      handleUser(ctx);
      return;
    }
    if (first === 'user' && segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        handleListUserRepos(ctx, query);
        return;
      }
      if (method === 'POST') {
        await handleCreateRepo(ctx);
        return;
      }
      return methodNotAllowed(ctx);
    }
    if (first === 'repos' && segments.length >= 3) {
      const owner = segments[1]!;
      const name = segments[2]!;
      const tail = segments.slice(3);
      if (tail.length === 0) {
        if (method === 'GET') {
          handleGetRepo(ctx, owner, name);
          return;
        }
        if (method === 'PATCH') {
          await handlePatchRepo(ctx, owner, name);
          return;
        }
        if (method === 'DELETE') {
          handleDeleteRepo(ctx, owner, name);
          return;
        }
        return methodNotAllowed(ctx);
      }
      if (tail[0] === 'git' && tail[1] === 'refs') {
        if (tail.length === 2) {
          if (method === 'POST') {
            await handleCreateRef(ctx, owner, name);
            return;
          }
          return methodNotAllowed(ctx);
        }
        if (method === 'GET') {
          handleGetRef(ctx, owner, name, tail.slice(2).join('/'));
          return;
        }
        return methodNotAllowed(ctx);
      }
      if (tail[0] === 'branches') {
        if (tail.length === 1) {
          if (method === 'GET') {
            handleListBranches(ctx, owner, name);
            return;
          }
          return methodNotAllowed(ctx);
        }
        if (method === 'GET') {
          handleGetBranch(ctx, owner, name, tail.slice(1).join('/'));
          return;
        }
        return methodNotAllowed(ctx);
      }
      if (tail[0] === 'commits' && tail.length === 1) {
        if (method === 'GET') {
          handleListCommits(ctx, owner, name, query);
          return;
        }
        return methodNotAllowed(ctx);
      }
      if (tail[0] === 'contents') {
        const path = tail.slice(1).join('/');
        if (method === 'GET') {
          handleGetContents(ctx, owner, name, path, query);
          return;
        }
        if (method === 'PUT') {
          await handlePutContents(ctx, owner, name, path);
          return;
        }
        if (method === 'DELETE') {
          await handleDeleteContents(ctx, owner, name, path);
          return;
        }
        return methodNotAllowed(ctx);
      }
      if (tail[0] === 'labels' && tail.length === 1) {
        if (method === 'POST') {
          await handleCreateLabel(ctx, owner, name);
          return;
        }
        return methodNotAllowed(ctx);
      }
      if (tail[0] === 'issues') {
        if (tail.length === 1) {
          if (method === 'GET') {
            handleListIssues(ctx, owner, name, query);
            return;
          }
          if (method === 'POST') {
            await handleCreateIssue(ctx, owner, name);
            return;
          }
          return methodNotAllowed(ctx);
        }
        const num = Number(tail[1]);
        if (!Number.isInteger(num) || num < 1) {
          notFound(ctx);
          return;
        }
        if (tail.length === 2) {
          if (method === 'GET') {
            handleGetIssue(ctx, owner, name, num);
            return;
          }
          if (method === 'PATCH') {
            await handlePatchIssue(ctx, owner, name, num);
            return;
          }
          return methodNotAllowed(ctx);
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          if (method === 'GET') {
            handleListComments(ctx, owner, name, num);
            return;
          }
          if (method === 'POST') {
            await handleCreateComment(ctx, owner, name, num);
            return;
          }
          return methodNotAllowed(ctx);
        }
        notFound(ctx);
        return;
      }
      if (tail[0] === 'pulls') {
        if (tail.length === 1) {
          if (method === 'GET') {
            handleListPulls(ctx, owner, name, query);
            return;
          }
          if (method === 'POST') {
            await handleCreatePull(ctx, owner, name);
            return;
          }
          return methodNotAllowed(ctx);
        }
        const num = Number(tail[1]);
        if (!Number.isInteger(num) || num < 1) {
          notFound(ctx);
          return;
        }
        if (tail.length === 2) {
          if (method === 'GET') {
            handleGetPull(ctx, owner, name, num);
            return;
          }
          return methodNotAllowed(ctx);
        }
        if (tail.length === 3 && tail[2] === 'files') {
          if (method === 'GET') {
            handleListPullFiles(ctx, owner, name, num);
            return;
          }
          return methodNotAllowed(ctx);
        }
        if (tail.length === 3 && tail[2] === 'merge') {
          if (method === 'PUT') {
            await handleMergePull(ctx, owner, name, num);
            return;
          }
          return methodNotAllowed(ctx);
        }
        notFound(ctx);
        return;
      }
      notFound(ctx);
      return;
    }
    if (!KNOWN_ROUTES.has(first!)) {
      notFound(ctx);
      return;
    }
    notFound(ctx);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 400) {
      messageReply(ctx.res, 400, e.message, ctx.reqId);
      return;
    }
    if (e.message === 'body too large') {
      messageReply(ctx.res, 413, 'Request Entity Too Large', ctx.reqId);
      return;
    }
    messageReply(ctx.res, 500, 'Internal Server Error', ctx.reqId);
  }
}

function methodNotAllowed(ctx: Ctx): void {
  jsonReply(ctx.res, 405, JSON.stringify({ message: 'Method Not Allowed' }), ctx.reqId);
}

export { handleRoot };
