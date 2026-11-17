// store.ts — in-memory data model + git object primitives (sha1 objects, trees,
// commits, packs). Everything lives in memory: no disk I/O on any hot path, which
// is what makes the read/clone workloads fast. The store is a module singleton —
// the entry runs as one process, so one store is the whole state.

// ---------------------------------------------------------------------------
// Git object primitives (written from the git object format itself).
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

/** sha1 hex of raw bytes. */
export function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a git object: sha1("<type> <size>\0" + data). */
export function hashObj(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1hex(Buffer.concat([head, data]));
}

/** One entry of a tree object. */
export interface TreeEntry {
  mode: string; // e.g. '100644', '40000'
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

/** Build a tree object. Entries must already be in git order (directories sort
 *  as if their name had a trailing '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Compare two names the way git sorts tree entries (dirs sort with '/'). */
export function treeNameCmp(a: string, aIsDir: boolean, b: string, bIsDir: boolean): number {
  const an = aIsDir ? a + '/' : a;
  const bn = bIsDir ? b + '/' : b;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export interface CommitMeta {
  tree: string;
  parents: string[];
  author: string; // full "Name <email> ts +0000" line
  committer: string;
  message: string;
}

/** Parse a commit object into its header fields. */
export function parseCommit(data: Buffer): CommitMeta {
  const text = data.toString('utf8');
  const head = text.split('\n\n', 1)[0];
  const message = text.slice(head.length + 2);
  const meta: CommitMeta = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) meta.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) meta.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) meta.author = line.slice(7);
    else if (line.startsWith('committer ')) meta.committer = line.slice(10);
  }
  return meta;
}

/** Build a commit object. `when` is a unix timestamp; the timezone is +0000. */
export function buildCommit(meta: CommitMeta, when: number): Buffer {
  const lines: string[] = [`tree ${meta.tree}`];
  for (const p of meta.parents) lines.push(`parent ${p}`);
  lines.push(`author ${meta.author} ${when} +0000`);
  lines.push(`committer ${meta.committer} ${when} +0000`);
  return Buffer.from(lines.join('\n') + '\n\n' + meta.message, 'utf8');
}

export interface TagMeta {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagMeta {
  const text = data.toString('utf8');
  const head = text.split('\n\n', 1)[0];
  const message = text.slice(head.length + 2);
  const meta: TagMeta = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) meta.object = line.slice(7).trim();
    else if (line.startsWith('type ')) meta.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) meta.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) meta.tagger = line.slice(7);
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Pack files (v2, plain objects — the client never sends deltas, and the
// server never needs to send them: the check only verifies the objects).
// ---------------------------------------------------------------------------

/** Adler-32 (the checksum a zlib stream ends with), over the inflated data. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Inflate the zlib stream starting at `off`. The pack header gives the expected
 *  inflated size. The stream's end is found by its trailing Adler-32 (the
 *  checksum of the inflated data): scan for those four bytes, verify by
 *  inflating the prefix. This costs two inflates and no throws, where a
 *  binary search paid for a thrown exception on every truncated probe. */
export function inflateAt(buf: Buffer, off: number, expectedSize: number): { data: Buffer; consumed: number } {
  const rest = buf.subarray(off);
  let data: Buffer;
  try {
    data = inflateSync(rest);
  } catch {
    throw new Error('corrupt zlib stream in pack');
  }
  if (data.length !== expectedSize) throw new Error('pack entry size mismatch');
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(data), 0);
  let searchFrom = 2; // skip the two-byte zlib header
  for (;;) {
    const idx = rest.indexOf(adler, searchFrom);
    if (idx === -1) break; // fall through to the binary search
    const end = idx + 4;
    try {
      const d = inflateSync(rest.subarray(0, end));
      if (d.length === expectedSize) return { data: d, consumed: end };
    } catch {
      // A false-positive Adler-32 inside the deflate data; keep scanning.
    }
    searchFrom = idx + 1;
  }
  // Fallback: binary search for the minimal prefix that inflates cleanly.
  let lo = 1;
  let hi = rest.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const d = inflateSync(rest.subarray(0, mid));
      if (d.length === expectedSize) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return { data, consumed: lo };
}

/** Read a pack buffer into objects. Verifies the trailer checksum. Throws on
 *  malformed input. Delta entries are rejected (the client is plain-only). */
export function readPack(buf: Buffer): Map<string, GitObj> {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (sha1hex(buf.subarray(0, buf.length - 20)) !== trailer) {
    throw new Error('pack checksum mismatch');
  }
  const objs = new Map<string, GitObj>();
  let off = 12;
  const typeByCode: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  for (let n = 0; n < count; n++) {
    let byte = buf[off++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = typeByCode[typeCode];
    if (!type) throw new Error(`unsupported pack entry type ${typeCode} (deltas not accepted)`);
    const { data, consumed } = inflateAt(buf, off, size);
    off += consumed;
    const oid = hashObj(type, data);
    objs.set(oid, { type, data });
  }
  return objs;
}

/** Write a pack (v2, plain objects, no deltas) from a list of objects. */
export function writePack(objs: GitObj[]): Buffer {
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objs.length, 8);
  chunks.push(head);
  const codeByType: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const o of objs) {
    const typeCode = codeByType[o.type];
    const data = o.data;
    // varint header: size in low bits, type in bits 4-6, continuation in bit 7.
    const header: number[] = [];
    let size = data.length;
    let first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    header.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      header.push(b);
    }
    chunks.push(Buffer.from(header));
    chunks.push(deflateSync(data, { level: 6 }));
  }
  const withoutTrailer = Buffer.concat(chunks);
  chunks.push(Buffer.from(sha1hex(withoutTrailer), 'hex'));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Data model. One process, one store. Everything is in memory and every
// expensive-to-compute value is cached and invalidated on mutation.
// ---------------------------------------------------------------------------

export const ZERO = '0'.repeat(40);
export const FIXED_TS = 1700000000; // fixed commit timestamp (deterministic)
export const FIXED_DATE = '2025-01-01T00:00:00Z'; // fixed REST/GraphQL timestamps

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};
export const TEAMMATE = { login: 'quinnkeller', id: 1001, name: 'quinn keller', email: 'quinnkeller@example.invalid' };
export const STRANGER = { login: 'olgabauer', id: 1002, name: 'olga bauer', email: 'olgabauer@example.invalid' };

/** All git objects, keyed by oid. */
export const objects = new Map<string, GitObj>();

/** Parsed commit metadata (author/committer/message/tree/parents) — filled for
 *  every commit we store, so REST/GraphQL reads never re-parse bytes. */
export const commitMeta = new Map<string, CommitMeta>();

/** Cached file map of a commit: path -> { oid, size }. Built lazily, cached. */
export const commitFiles = new Map<string, Map<string, { oid: string; size: number }>>();

/** Number of lines in a blob's text (cached) — used for PR file statistics. */
export const blobLines = new Map<string, number>();

export function storeObj(type: ObjType, data: Buffer): string {
  const oid = hashObj(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  if (type === 'commit') commitMeta.set(oid, parseCommit(data));
  return oid;
}

/** The file map of a commit (path -> blob oid + size), walking its tree. */
export function filesOfCommit(commitOid: string): Map<string, { oid: string; size: number }> {
  const cached = commitFiles.get(commitOid);
  if (cached) return cached;
  const out = new Map<string, { oid: string; size: number }>();
  const meta = commitMeta.get(commitOid) ?? parseCommit(objects.get(commitOid)?.data ?? Buffer.alloc(0));
  const walk = (treeOid: string, prefix: string) => {
    const tree = objects.get(treeOid);
    if (!tree) return;
    for (const e of parseTree(tree.data)) {
      if (e.mode === '40000') walk(e.oid, prefix + e.name + '/');
      else {
        const blob = objects.get(e.oid);
        out.set(prefix + e.name, { oid: e.oid, size: blob ? blob.data.length : 0 });
      }
    }
  };
  walk(meta.tree, '');
  commitFiles.set(commitOid, out);
  return out;
}

/** Number of lines in a blob (split on '\n', trailing newline does not add one). */
export function linesOfBlob(oid: string): number {
  const cached = blobLines.get(oid);
  if (cached !== undefined) return cached;
  const blob = objects.get(oid);
  let n = 0;
  if (blob) {
    const text = blob.data.toString('utf8');
    n = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }
  blobLines.set(oid, n);
  return n;
}

/** Build (and store) the tree objects for a file map. Returns the root tree oid. */
export function treeFromFiles(files: Map<string, { oid: string; size: number }>): string {
  // Group by directory, recursively. `paths` are relative to the current
  // directory; `prefix` is the full path of that directory, so lookups use
  // the file map's full-path keys.
  const build = (paths: string[], prefix: string): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, string[]>();
    for (const p of paths) {
      const slash = p.indexOf('/');
      if (slash === -1) entries.push({ mode: '100644', name: p, oid: files.get(prefix + p)!.oid });
      else {
        const dir = p.slice(0, slash);
        const rest = p.slice(slash + 1);
        const list = dirs.get(dir) ?? [];
        list.push(rest);
        dirs.set(dir, list);
      }
    }
    for (const [dir, sub] of dirs) {
      entries.push({ mode: '40000', name: dir, oid: build(sub, prefix + dir + '/') });
    }
    entries.sort((a, b) => treeNameCmp(a.name, a.mode === '40000', b.name, b.mode === '40000'));
    return storeObj('tree', buildTree(entries));
  };
  return build([...files.keys()], '');
}

/** Create and store a commit object. Returns its oid. */
export function makeCommit(treeOid: string, parents: string[], message: string, author = VIEWER): string {
  const person = `${author.name} <${author.email}>`;
  const meta: CommitMeta = { tree: treeOid, parents, author: person, committer: person, message };
  const data = buildCommit(meta, FIXED_TS);
  const oid = hashObj('commit', data);
  objects.set(oid, { type: 'commit', data });
  commitMeta.set(oid, meta);
  return oid;
}

/** The first ancestor of `from` (inclusive) that is in `targets`, walking
 *  parents breadth-first by generation. Used for merge-base. */
export function findMergeBase(from: string, targets: Set<string>): string | null {
  const seen = new Set<string>();
  const queue: string[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (targets.has(cur)) return cur;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const meta = commitMeta.get(cur);
    if (meta) queue.push(...meta.parents);
  }
  return null;
}

/** Is `ancestor` reachable from `from` (inclusive)? Fast-forward test. */
export function isAncestor(ancestor: string, from: string): boolean {
  if (ancestor === from) return true;
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (seen.size > 100000) return false; // safety cap
    const meta = commitMeta.get(cur);
    if (meta) stack.push(...meta.parents);
  }
  return false;
}

/** Peel a tag object to the commit it ultimately points at (or the oid itself
 *  if it is already a commit). Returns null if the target is missing. */
export function peelToCommit(oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 16; i++) {
    const obj = objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') cur = parseTag(obj.data).object;
    else return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repos, issues, pull requests.
// ---------------------------------------------------------------------------

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number; // global REST id
  number: number; // per-repo shared counter with PRs
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  json: string; // cached REST representation
  gqlId: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number; // global REST id
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBase: string;
  files: PullFile[];
  json: string | null; // cached REST representation (null until built)
  gqlId: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>; // refname -> oid
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number; // shared issue/PR counter
  nextCommentId: number;
  labels: Map<string, { name: string; color: string }>;
  // caches, cleared on any ref mutation
  repoJson: string | null;
  v0UploadAdv: Buffer | null;
  v0ReceiveAdv: Buffer | null;
  lsRefsCache: Map<string, Buffer>;
  packCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
}

export const repos = new Map<string, Repo>(); // key "owner/name"

export let nextRepoId = 5000;
let nextIssueId = 1;
let nextPullId = 1;

/** Allocate the next global REST id for an issue (imported bindings are
 *  read-only in ESM, so the counter is advanced here, in its home module). */
export function allocIssueId(): number {
  return nextIssueId++;
}

/** Allocate the next global REST id for a pull request. */
export function allocPullId(): number {
  return nextPullId++;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function newRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner,
    private: isPrivate,
    description,
    defaultBranch: 'main',
    refs: new Map(),
    issues: [],
    pulls: [],
    nextNumber: 1,
    nextCommentId: 1,
    labels: new Map(),
    repoJson: null,
    v0UploadAdv: null,
    v0ReceiveAdv: null,
    lsRefsCache: new Map(),
    packCache: new Map(),
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

/** Invalidate a repo's git caches after a ref change. */
export function invalidateRepoGit(repo: Repo): void {
  repo.v0UploadAdv = null;
  repo.v0ReceiveAdv = null;
  repo.lsRefsCache.clear();
  repo.packCache.clear();
}

/** The repo's ref advertisement entries: [oid, name] for HEAD, branches, tags. */
export function refList(repo: Repo): [string, string][] {
  const out: [string, string][] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (head) out.push([head, 'HEAD']);
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/') || name.startsWith('refs/tags/')) out.push([oid, name]);
  }
  return out;
}

/** Global id for a GraphQL node: base64url("<Kind>:<repoId>:<number>"). */
export function gqlId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment', repoId: number, n: number): string {
  return Buffer.from(`${kind}:${repoId}:${n}`, 'utf8').toString('base64url');
}

/** Decode a GraphQL global id back to its parts, or null. */
export function parseGqlId(id: string): { kind: string; repoId: number; n: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    return { kind: parts[0], repoId: Number(parts[1]), n: Number(parts[2]) };
  } catch {
    return null;
  }
}

/** Find a repo by its global id's repoId. */
export function repoById(id: number): Repo | null {
  for (const r of repos.values()) if (r.id === id) return r;
  return null;
}

/** The REST representation of a repo (cached). */
export function repoJson(repo: Repo): string {
  if (repo.repoJson) return repo.repoJson;
  const s = JSON.stringify({
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  });
  repo.repoJson = s;
  return s;
}

/** Build (and cache) an issue's REST representation. */
export function issueJson(repo: Repo, issue: Issue): string {
  if (issue.json) return issue.json;
  const s = JSON.stringify({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l })),
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    comments: issue.comments.length,
  });
  issue.json = s;
  return s;
}

/** Build (and cache) a pull request's REST representation. */
export function pullJson(repo: Repo, pull: Pull): string {
  if (pull.json) return pull.json;
  const s = JSON.stringify({
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  });
  pull.json = s;
  return s;
}

/** Diff two file maps (base -> head) into the PR file list. */
export function diffFiles(base: Map<string, { oid: string; size: number }>, head: Map<string, { oid: string; size: number }>): PullFile[] {
  const out: PullFile[] = [];
  const names = new Set([...base.keys(), ...head.keys()]);
  for (const name of names) {
    const b = base.get(name);
    const h = head.get(name);
    if (b && !h) {
      const del = linesOfBlob(b.oid);
      out.push({ filename: name, status: 'removed', additions: 0, deletions: del, changes: del });
    } else if (!b && h) {
      const add = linesOfBlob(h.oid);
      out.push({ filename: name, status: 'added', additions: add, deletions: 0, changes: add });
    } else if (b && h && b.oid !== h.oid) {
      const add = linesOfBlob(h.oid);
      const del = linesOfBlob(b.oid);
      out.push({ filename: name, status: 'modified', additions: add, deletions: del, changes: add + del });
    }
  }
  out.sort((x, y) => (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
  return out;
}

/** Does the base tip's version of any PR file differ from BOTH the merge-base
 *  and the head version (a real conflict)? */
export function hasConflict(
  mergeBaseFiles: Map<string, { oid: string; size: number }>,
  baseFiles: Map<string, { oid: string; size: number }>,
  headFiles: Map<string, { oid: string; size: number }>,
  files: PullFile[],
): boolean {
  for (const f of files) {
    const mb = mergeBaseFiles.get(f.filename);
    const bf = baseFiles.get(f.filename);
    const hf = headFiles.get(f.filename);
    const mbOid = mb ? mb.oid : null;
    const bfOid = bf ? bf.oid : null;
    const hfOid = hf ? hf.oid : null;
    if (bfOid !== mbOid && bfOid !== hfOid) return true;
  }
  return false;
}
