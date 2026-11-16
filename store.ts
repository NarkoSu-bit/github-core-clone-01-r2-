// store.ts — In-memory forge state: users, repositories, git objects, refs, issues, PRs.
// A repository is created only through REST; a push can never invent one.

import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTree,
  parseTag,
  buildCommit,
  buildTree,
  collectReachable,
  commitDistances,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  /** Cached serialized REST shape (baseUrl-stable); cleared on any mutation. */
  jsonCache?: Buffer | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  createdSeq: number;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  nextIssue = 1;
  nextPull = 1;
  nextComment = 1;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, createdSeq: number) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdSeq = createdSeq;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  lookup(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  refTarget(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  /** Resolve a ref name, a short branch name, or a raw oid to an oid. */
  resolveRef(ref: string): string | undefined {
    if (this.refs.has(ref)) return this.refs.get(ref);
    const heads = `refs/heads/${ref}`;
    if (this.refs.has(heads)) return this.refs.get(heads);
    const tags = `refs/tags/${ref}`;
    if (this.refs.has(tags)) return this.refs.get(tags);
    if (/^[0-9a-f]{40}$/.test(ref) && this.objects.has(ref)) return ref;
    return undefined;
  }

  /** The commit oid a branch points at (undefined when the branch does not exist). */
  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') stack.push(...parseCommit(object.data).parents);
      else if (object.type === 'tag') stack.push(parseTag(object.data).object);
    }
    return false;
  }

  /** Commits reachable from a tip, newest first (DFS following parents in order). */
  commitHistory(tip: string): { oid: string; object: GitObject }[] {
    const out: { oid: string; object: GitObject }[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push({ oid, object });
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
    }
    return out;
  }

  /** Peel a ref (tag -> commit) for ls-refs / advertisements. */
  peel(oid: string): string | undefined {
    let current = oid;
    for (let depth = 0; depth < 8; depth += 1) {
      const object = this.objects.get(current);
      if (!object) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /** The tree oid at a commit. */
  treeOf(commitOid: string): string | undefined {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data).tree;
  }

  /** Read a file (blob) at a path within a tree; returns the blob oid and data. */
  readPath(treeOid: string, path: string): { oid: string; data: Buffer; mode: string } | undefined {
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return undefined;
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tree') return undefined;
      const entry = parseTree(object.data).find((e) => e.name === segments[i]);
      if (!entry) return undefined;
      if (i === segments.length - 1) {
        const blob = this.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return undefined;
        return { oid: entry.oid, data: blob.data, mode: entry.mode };
      }
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /** List the immediate children of a directory tree. */
  listDir(treeOid: string, path: string): { name: string; path: string; sha: string; type: 'file' | 'dir' }[] | undefined {
    const segments = path.split('/').filter((s) => s.length > 0);
    let current = treeOid;
    for (const segment of segments) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tree') return undefined;
      const entry = parseTree(object.data).find((e) => e.name === segment);
      if (!entry || entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    const object = this.objects.get(current);
    if (!object || object.type !== 'tree') return undefined;
    const prefix = segments.length > 0 ? `${segments.join('/')}/` : '';
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: `${prefix}${entry.name}`,
      sha: entry.oid,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
    }));
  }

  /**
   * Build a new tree from an existing tree with one path set to a blob (or removed when
   * blobOid is null). Returns the new tree oid. Intermediate trees are created as needed.
   */
  setPath(treeOid: string | undefined, path: string, blobOid: string | null, mode = '100644'): string {
    const segments = path.split('/').filter((s) => s.length > 0);
    const build = (current: string | undefined, depth: number): string => {
      const entries: TreeEntry[] = current ? parseTree(this.objects.get(current)!.data) : [];
      const name = segments[depth];
      const rest: TreeEntry[] = [];
      let existing: TreeEntry | undefined;
      for (const entry of entries) {
        if (entry.name === name) existing = entry;
        else rest.push(entry);
      }
      if (depth === segments.length - 1) {
        if (blobOid !== null) rest.push({ mode, name, oid: blobOid });
      } else {
        const child = this.setPath(existing?.mode === '40000' ? existing.oid : undefined, segments.slice(depth + 1).join('/'), blobOid, mode);
        // setPath on the sub-path returns the child tree; only keep it when non-empty.
        const childObject = this.objects.get(child);
        const childEntries = childObject ? parseTree(childObject.data) : [];
        if (childEntries.length > 0) rest.push({ mode: '40000', name, oid: child });
      }
      return this.putObject('tree', buildTree(rest));
    };
    // The recursion above re-splits the path at each level; guard against the degenerate
    // case by handling the single-segment path directly.
    if (segments.length === 1) {
      const entries: TreeEntry[] = treeOid ? parseTree(this.objects.get(treeOid)!.data) : [];
      const kept = entries.filter((e) => e.name !== segments[0]);
      if (blobOid !== null) kept.push({ mode, name: segments[0], oid: blobOid });
      return this.putObject('tree', buildTree(kept));
    }
    return build(treeOid, 0);
  }

  /** The merge base (best common ancestor) of two commits, or undefined. */
  mergeBase(a: string, b: string): string | undefined {
    const distA = commitDistances([a], (oid) => this.objects.get(oid));
    const distB = commitDistances([b], (oid) => this.objects.get(oid));
    let best: string | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [oid, da] of distA) {
      const db = distB.get(oid);
      if (db === undefined) continue;
      const score = da + db;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    return best;
  }

  /** Flat map of path -> blob oid for a tree (recursive). */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (current: string, prefix: string): void => {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Diff two trees: path -> {status, oldOid?, newOid?}. */
  diffTrees(baseTree: string | undefined, headTree: string | undefined): {
    path: string;
    status: 'added' | 'modified' | 'removed';
    oldOid?: string;
    newOid?: string;
  }[] {
    const base = baseTree ? this.flattenTree(baseTree) : new Map<string, { oid: string; mode: string }>();
    const head = headTree ? this.flattenTree(headTree) : new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: { path: string; status: 'added' | 'modified' | 'removed'; oldOid?: string; newOid?: string }[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid });
      else if (!b && h) out.push({ path, status: 'added', newOid: h.oid });
      else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
    return out;
  }

  reachable(tips: Iterable<string>): Map<string, GitObject> {
    return collectReachable(tips, (oid) => this.objects.get(oid));
  }
}

export class Store {
  viewer: User;
  users = new Map<string, User>();
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  seq = 0;

  constructor(viewer: User) {
    this.viewer = viewer;
    this.users.set(viewer.login, viewer);
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const repo = new Repo(this.nextRepoId, owner, name, description, isPrivate, this.nextSeq());
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === this.viewer.login) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  /** The identity used for server-authored commits (REST contents / merges). */
  authorIdentity(): string {
    return `${this.viewer.name} <${this.viewer.email}>`;
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** Create a commit object in a repo and return its oid. */
  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const data = buildCommit({
      tree,
      parents,
      message,
      author: this.authorIdentity(),
      committer: this.authorIdentity(),
      timestamp: this.nowSec(),
    });
    return repo.putObject('commit', data);
  }

  /** Opaque GraphQL ids: base64url of a typed key. Never the numeric database id. */
  encodeId(kind: string, key: string): string {
    return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
  }

  decodeId(id: string): { kind: string; key: string } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      const colon = text.indexOf(':');
      if (colon <= 0) return null;
      return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
    } catch {
      return null;
    }
  }

  repoGraphId(repo: Repo): string {
    return this.encodeId('R', repo.fullName);
  }

  issueGraphId(repo: Repo, issue: Issue): string {
    return this.encodeId('I', `${repo.fullName}:${issue.number}`);
  }

  pullGraphId(repo: Repo, pull: Pull): string {
    return this.encodeId('PR', `${repo.fullName}:${pull.number}`);
  }

  commentGraphId(repo: Repo, issue: Issue, comment: Comment): string {
    return this.encodeId('C', `${repo.fullName}:${issue.number}:${comment.id}`);
  }

  userGraphId(user: User): string {
    return this.encodeId('U', user.login);
  }
}

export { ZERO_OID };
