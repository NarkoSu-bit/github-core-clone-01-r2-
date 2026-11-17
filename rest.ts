// rest.ts — the GitHub REST v3 surface the checks exercise: repos, contents,
// labels, issues, pulls, git refs, pagination. Every response is JSON with an
// X-GitHub-Request-Id; writes are validated and answered with the status the
// real API uses (201 create, 200 update, 204 delete, 404 missing, 409 stale
// sha, 422 validation).

import {
  objects, commitMeta, repos, repoKey, newRepo, repoJson, issueJson, pullJson,
  storeObj, makeCommit, filesOfCommit, treeFromFiles, diffFiles, hasConflict,
  invalidateRepoGit, findMergeBase, parseTree,
  allocIssueId, allocPullId,
  VIEWER, FIXED_DATE, ZERO,
  type Repo, type Issue, type Pull,
} from './store.ts';
import { sendJson, sendEmpty, parseJsonBody, isObject, type Ctx } from './http-util.ts';

const OAUTH = { 'x-oauth-scopes': 'repo' };

function j(ctx: Ctx, status: number, body: unknown, extra?: Record<string, string>): void {
  sendJson(ctx, status, body, { ...OAUTH, ...extra });
}

function notFound(ctx: Ctx): void {
  j(ctx, 404, { message: 'Not Found' });
}

function badBody(ctx: Ctx): unknown | null {
  const v = parseJsonBody(ctx);
  if (v === null || !isObject(v)) {
    j(ctx, 400, { message: 'Problems parsing JSON' });
    return null;
  }
  return v;
}

function getRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

/** The branch a contents operation targets: body.branch, ?ref=, or default. */
function targetBranch(repo: Repo, body: Record<string, unknown> | null, ctx: Ctx): string {
  if (body && typeof body.branch === 'string' && body.branch !== '') return body.branch;
  const ref = ctx.query.get('ref');
  if (ref) return ref;
  return repo.defaultBranch;
}

/** The tip commit of a branch, or null. */
function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function handleRest(ctx: Ctx): void {
  const auth = ctx.req.headers.authorization;
  if (!auth || auth.trim() === '') {
    j(ctx, 401, { message: 'Requires authentication' });
    return;
  }
  const { method, segments } = ctx;

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound(ctx);
    j(ctx, 200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
    });
    return;
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound(ctx);
    j(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }

  if (segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') {
      j(ctx, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
      return;
    }
    if (segments[1] === 'repos') {
      if (method === 'POST') return createRepo(ctx);
      if (method === 'GET') return listUserRepos(ctx);
      return notFound(ctx);
    }
    return notFound(ctx);
  }

  if (segments[0] === 'repos') {
    if (segments.length < 3) return notFound(ctx);
    const owner = segments[1];
    const name = segments[2];
    const repo = getRepo(ctx, owner, name);
    if (!repo) return notFound(ctx);
    const rest = segments.slice(3);
    if (rest.length === 0) return repoRoot(ctx, repo);
    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') return listBranches(ctx, repo);
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return listCommits(ctx, repo);
    if (rest[0] === 'contents') return contents(ctx, repo, rest.slice(1));
    if (rest[0] === 'labels') return labels(ctx, repo, rest.slice(1));
    if (rest[0] === 'issues') return issues(ctx, repo, rest.slice(1));
    if (rest[0] === 'pulls') return pulls(ctx, repo, rest.slice(1));
    if (rest[0] === 'git' && rest[1] === 'refs') return gitRefs(ctx, repo, rest.slice(2));
    return notFound(ctx);
  }

  return notFound(ctx);
}

// ---------------------------------------------------------------------------
// Repos.
// ---------------------------------------------------------------------------

function createRepo(ctx: Ctx): void {
  const body = badBody(ctx);
  if (body === null) return;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') {
    j(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing' }] });
    return;
  }
  if (repos.has(repoKey(VIEWER.login, name))) {
    j(ctx, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] });
    return;
  }
  const repo = newRepo(
    VIEWER.login,
    name,
    typeof body.description === 'string' ? body.description : '',
    body.private === true,
  );
  if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
  j(ctx, 201, repoJson(repo));
}

function listUserRepos(ctx: Ctx): void {
  const perPage = Math.max(1, Math.min(100, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const mine = [...repos.values()].filter((r) => r.owner === VIEWER.login);
  const total = mine.length;
  const start = (page - 1) * perPage;
  const slice = mine.slice(start, start + perPage);
  const body = `[${slice.map((r) => repoJson(r)).join(',')}]`;
  const host = ctx.req.headers.host ?? '127.0.0.1';
  const base = `http://${host}/api/v3/user/repos?per_page=${perPage}`;
  const links: string[] = [];
  if (start + perPage < total) links.push(`<${base}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${base}&page=${page - 1}>; rel="prev"`);
  links.push(`<${base}&page=1>; rel="first"`);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  links.push(`<${base}&page=${lastPage}>; rel="last"`);
  j(ctx, 200, body, { link: links.join(', ') });
}

function repoRoot(ctx: Ctx, repo: Repo): void {
  if (ctx.method === 'GET') {
    j(ctx, 200, repoJson(repo));
    return;
  }
  if (ctx.method === 'PATCH') {
    const body = badBody(ctx);
    if (body === null) return;
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
    if (typeof body.private === 'boolean') repo.private = body.private;
    repo.repoJson = null;
    j(ctx, 200, repoJson(repo));
    return;
  }
  if (ctx.method === 'DELETE') {
    repos.delete(repoKey(repo.owner, repo.name));
    sendEmpty(ctx, 204, OAUTH);
    return;
  }
  return notFound(ctx);
}

function listBranches(ctx: Ctx, repo: Repo): void {
  const out = [...repo.refs.entries()]
    .filter(([n]) => n.startsWith('refs/heads/'))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid } }));
  j(ctx, 200, out);
}

function listCommits(ctx: Ctx, repo: Repo): void {
  const branch = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (!tip) return notFound(ctx);
  const out: unknown[] = [];
  const seen = new Set<string>();
  let cur: string | null = tip;
  while (cur && !seen.has(cur) && out.length < 1000) {
    seen.add(cur);
    const meta = commitMeta.get(cur);
    if (!meta) break;
    out.push({
      sha: cur,
      commit: {
        message: meta.message,
        author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_DATE },
        committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_DATE },
        tree: { sha: meta.tree },
      },
      author: { login: VIEWER.login, id: VIEWER.id },
      committer: { login: VIEWER.login, id: VIEWER.id },
      parents: meta.parents.map((p) => ({ sha: p })),
    });
    cur = meta.parents[0] ?? null;
  }
  j(ctx, 200, out);
}

// ---------------------------------------------------------------------------
// Contents.
// ---------------------------------------------------------------------------

function contents(ctx: Ctx, repo: Repo, rest: string[]): void {
  const path = rest.join('/');
  if (ctx.method === 'GET') return getContents(ctx, repo, path);
  if (ctx.method === 'PUT') return putContents(ctx, repo, path);
  if (ctx.method === 'DELETE') return deleteContents(ctx, repo, path);
  return notFound(ctx);
}

function getContents(ctx: Ctx, repo: Repo, path: string): void {
  const branch = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (!tip) return notFound(ctx);
  const files = filesOfCommit(tip);
  const file = files.get(path);
  if (file) {
    const blob = objects.get(file.oid);
    const content = blob ? blob.data.toString('base64') : '';
    j(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: file.size,
      name: path.split('/').pop() ?? path,
      path,
      content,
      sha: file.oid,
    });
    return;
  }
  // Directory listing: the immediate children of `path` (or the root).
  const prefix = path === '' ? '' : path + '/';
  const children = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [p, f] of files) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) children.set(rest, { type: 'file', oid: f.oid, size: f.size });
    else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) children.set(dir, { type: 'dir', oid: '', size: 0 });
    }
  }
  if (children.size === 0) return notFound(ctx);
  const out = [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, c]) => ({
      type: c.type,
      name,
      path: prefix + name,
      sha: c.type === 'file' ? c.oid : treeOidOf(tip, prefix + name),
      size: c.size,
    }));
  j(ctx, 200, out);
}

/** The tree oid of a directory inside a commit's tree (or ''). */
function treeOidOf(commitOid: string, dirPath: string): string {
  const meta = commitMeta.get(commitOid);
  if (!meta) return '';
  let treeOid = meta.tree;
  for (const part of dirPath.split('/')) {
    if (part === '') continue;
    const tree = objects.get(treeOid);
    if (!tree) return '';
    const entry = parseTree(tree.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return '';
    treeOid = entry.oid;
  }
  return treeOid;
}

function putContents(ctx: Ctx, repo: Repo, path: string): void {
  const body = badBody(ctx);
  if (body === null) return;
  const branch = targetBranch(repo, body, ctx);
  const tip = branchTip(repo, branch);
  const message = typeof body.message === 'string' ? body.message : 'Update';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  const sha = typeof body.sha === 'string' ? body.sha : null;
  const data = Buffer.from(contentB64, 'base64');
  const files = tip ? filesOfCommit(tip) : new Map<string, { oid: string; size: number }>();
  const existing = files.get(path);
  if (existing) {
    if (sha === null || sha !== existing.oid) {
      j(ctx, 409, { message: 'sha does not match the current blob' });
      return;
    }
  } else if (sha !== null) {
    j(ctx, 409, { message: 'sha does not match the current blob' });
    return;
  }
  const blobOid = storeObj('blob', data);
  const next = new Map(files);
  next.set(path, { oid: blobOid, size: data.length });
  const treeOid = treeFromFiles(next);
  const parents = tip ? [tip] : [];
  const commitOid = makeCommit(treeOid, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  invalidateRepoGit(repo);
  j(ctx, existing ? 200 : 201, {
    content: { type: 'file', name: path.split('/').pop() ?? path, path, sha: blobOid, size: data.length, encoding: 'base64', content: contentB64 },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(ctx: Ctx, repo: Repo, path: string): void {
  const body = badBody(ctx);
  if (body === null) return;
  const branch = targetBranch(repo, body, ctx);
  const tip = branchTip(repo, branch);
  if (!tip) return notFound(ctx);
  const files = filesOfCommit(tip);
  const existing = files.get(path);
  if (!existing) return notFound(ctx);
  const sha = typeof body.sha === 'string' ? body.sha : null;
  if (sha === null || sha !== existing.oid) {
    j(ctx, 409, { message: 'sha does not match the current blob' });
    return;
  }
  const message = typeof body.message === 'string' ? body.message : 'Delete';
  const next = new Map(files);
  next.delete(path);
  const treeOid = treeFromFiles(next);
  const commitOid = makeCommit(treeOid, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  invalidateRepoGit(repo);
  j(ctx, 200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------------------
// Labels.
// ---------------------------------------------------------------------------

function labels(ctx: Ctx, repo: Repo, rest: string[]): void {
  if (ctx.method === 'GET' && rest.length === 0) {
    j(ctx, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
    return;
  }
  if (ctx.method === 'POST' && rest.length === 0) {
    const body = badBody(ctx);
    if (body === null) return;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') {
      j(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'missing' }] });
      return;
    }
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    if (repo.labels.has(name)) {
      j(ctx, 200, { name, color: repo.labels.get(name)!.color });
      return;
    }
    repo.labels.set(name, { name, color });
    j(ctx, 201, { name, color });
    return;
  }
  return notFound(ctx);
}

// ---------------------------------------------------------------------------
// Issues.
// ---------------------------------------------------------------------------

function issues(ctx: Ctx, repo: Repo, rest: string[]): void {
  if (rest.length === 0) {
    if (ctx.method === 'GET') return listIssues(ctx, repo);
    if (ctx.method === 'POST') return createIssue(ctx, repo);
    return notFound(ctx);
  }
  const n = Number(rest[0]);
  if (!Number.isInteger(n)) return notFound(ctx);
  const issue = repo.issues.find((i) => i.number === n);
  if (!issue) return notFound(ctx);
  if (rest.length === 1) {
    if (ctx.method === 'GET') { j(ctx, 200, issueJson(repo, issue)); return; }
    if (ctx.method === 'PATCH') return patchIssue(ctx, repo, issue);
    return notFound(ctx);
  }
  if (rest[1] === 'comments') {
    if (ctx.method === 'GET') {
      j(ctx, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: FIXED_DATE })));
      return;
    }
    if (ctx.method === 'POST') {
      const body = badBody(ctx);
      if (body === null) return;
      const text = typeof body.body === 'string' ? body.body : '';
      const comment = { id: repo.nextCommentId++, body: text };
      issue.comments.push(comment);
      issue.json = '';
      j(ctx, 201, { id: comment.id, body: text, user: { login: VIEWER.login, id: VIEWER.id }, created_at: FIXED_DATE });
      return;
    }
    return notFound(ctx);
  }
  return notFound(ctx);
}

function listIssues(ctx: Ctx, repo: Repo): void {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let list = repo.issues;
  if (state !== 'all') list = list.filter((i) => i.state === state);
  const sorted = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  j(ctx, 200, `[${sorted.map((i) => issueJson(repo, i)).join(',')}]`);
}

function createIssue(ctx: Ctx, repo: Repo): void {
  const body = badBody(ctx);
  if (body === null) return;
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') {
    j(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing' }] });
    return;
  }
  const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const l of labels) {
    if (!repo.labels.has(l)) {
      j(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'custom', message: `label ${l} does not exist` }] });
      return;
    }
  }
  const issue: Issue = {
    id: allocIssueId(),
    number: repo.nextNumber++,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels,
    comments: [],
    json: '',
    gqlId: '',
  };
  issue.gqlId = '';
  repo.issues.push(issue);
  j(ctx, 201, issueJson(repo, issue));
}

function patchIssue(ctx: Ctx, repo: Repo, issue: Issue): void {
  const body = badBody(ctx);
  if (body === null) return;
  if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (Array.isArray(body.labels)) {
    const labels = body.labels.filter((l): l is string => typeof l === 'string');
    for (const l of labels) {
      if (!repo.labels.has(l)) {
        j(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'custom', message: `label ${l} does not exist` }] });
        return;
      }
    }
    issue.labels = labels;
  }
  issue.json = '';
  j(ctx, 200, issueJson(repo, issue));
}

// ---------------------------------------------------------------------------
// Pull requests.
// ---------------------------------------------------------------------------

function pulls(ctx: Ctx, repo: Repo, rest: string[]): void {
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = repo.pulls;
      if (state !== 'all') list = list.filter((p) => p.state === state);
      j(ctx, 200, `[${list.map((p) => pullJson(repo, p)).join(',')}]`);
      return;
    }
    if (ctx.method === 'POST') return createPull(ctx, repo);
    return notFound(ctx);
  }
  const n = Number(rest[0]);
  if (!Number.isInteger(n)) return notFound(ctx);
  const pull = repo.pulls.find((p) => p.number === n);
  if (!pull) return notFound(ctx);
  if (rest.length === 1) {
    if (ctx.method === 'GET') { j(ctx, 200, pullJson(repo, pull)); return; }
    return notFound(ctx);
  }
  if (rest[1] === 'files' && rest.length === 2 && ctx.method === 'GET') {
    j(ctx, 200, pull.files);
    return;
  }
  if (rest[1] === 'merge' && rest.length === 2 && ctx.method === 'PUT') return mergePull(ctx, repo, pull);
  return notFound(ctx);
}

function createPull(ctx: Ctx, repo: Repo): void {
  const body = badBody(ctx);
  if (body === null) return;
  const title = typeof body.title === 'string' ? body.title : '';
  const headRaw = typeof body.head === 'string' ? body.head : '';
  const baseRaw = typeof body.base === 'string' ? body.base : '';
  const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
  const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
  if (title === '' || head === '' || base === '') {
    j(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'title, head and base are required' }] });
    return;
  }
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (!headSha || !baseSha) {
    j(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'head or base branch does not exist' }] });
    return;
  }
  const mergeBase = findMergeBase(headSha, new Set([baseSha])) ?? baseSha;
  const files = diffFiles(filesOfCommit(mergeBase), filesOfCommit(headSha));
  const pull: Pull = {
    id: allocPullId(),
    number: repo.nextNumber++,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    mergeBase,
    files,
    json: null,
    gqlId: '',
  };
  repo.pulls.push(pull);
  j(ctx, 201, pullJson(repo, pull));
}

function mergePull(ctx: Ctx, repo: Repo, pull: Pull): void {
  const body = badBody(ctx);
  if (body === null) return;
  if (pull.state === 'closed') {
    j(ctx, 405, { message: 'Pull request is already closed' });
    return;
  }
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (!baseTip || !headTip) {
    j(ctx, 405, { message: 'Head or base branch is missing' });
    return;
  }
  const mergeBaseFiles = filesOfCommit(pull.mergeBase);
  const baseFiles = filesOfCommit(baseTip);
  const headFiles = filesOfCommit(headTip);
  if (hasConflict(mergeBaseFiles, baseFiles, headFiles, pull.files)) {
    j(ctx, 405, { message: 'Merge conflict' });
    return;
  }
  // The merge tree: the base tip's files, overlaid with the head's version of
  // every file the PR touches.
  const merged = new Map(baseFiles);
  for (const f of pull.files) {
    const h = headFiles.get(f.filename);
    if (h) merged.set(f.filename, h);
    else merged.delete(f.filename);
  }
  const treeOid = treeFromFiles(merged);
  const message = typeof body.commit_message === 'string' && body.commit_message !== ''
    ? body.commit_message
    : `Merge pull request #${pull.number} from ${pull.headRef}`;
  const commitOid = makeCommit(treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_DATE;
  pull.mergeSha = commitOid;
  pull.json = null;
  invalidateRepoGit(repo);
  j(ctx, 200, { sha: commitOid, merged: true, message });
}

// ---------------------------------------------------------------------------
// Git refs.
// ---------------------------------------------------------------------------

function gitRefs(ctx: Ctx, repo: Repo, rest: string[]): void {
  if (ctx.method === 'POST' && rest.length === 0) {
    const body = badBody(ctx);
    if (body === null) return;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
      j(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', code: 'custom', message: 'ref and sha are required' }] });
      return;
    }
    if (!objects.has(sha)) {
      j(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', code: 'custom', message: 'object does not exist' }] });
      return;
    }
    if (repo.refs.has(ref)) {
      j(ctx, 422, { message: 'Reference already exists', errors: [{ resource: 'Reference', code: 'custom', message: 'reference already exists' }] });
      return;
    }
    repo.refs.set(ref, sha);
    invalidateRepoGit(repo);
    j(ctx, 201, { ref, object: { sha, type: objects.get(sha)?.type ?? 'commit' } });
    return;
  }
  if (ctx.method === 'GET' && rest.length > 0) {
    const ref = 'refs/' + rest.join('/');
    const sha = repo.refs.get(ref);
    if (!sha) return notFound(ctx);
    j(ctx, 200, { ref, object: { sha, type: objects.get(sha)?.type ?? 'commit' } });
    return;
  }
  return notFound(ctx);
}
