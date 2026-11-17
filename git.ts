// git.ts — git object model, packfiles, pkt-lines and protocol selection.
//
// Performance notes (this file is the hot path for the push/clone workloads):
// - objects are stored once as raw Buffers; commit parents/trees are parsed
//   once at store time and cached, never re-parsed per request.
// - pack entries are deflated at level 1 (fast, still valid); depth-1 packs
//   for a fixed tip are cached by the caller (see rest.ts / git handlers).
// - pack parsing inflates each entry with one `Inflate` stream, whose
//   `bytesWritten` reports the stream's exact end (a single stream per
//   object, ~5x faster than probing with repeated inflateSync calls).

import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';
import type { GitObj, ObjType, Repo, TreeEntry } from './store.ts';
import { TYPE_CODES, TYPE_NAMES, ZERO_OID } from './store.ts';

export { ZERO_OID };

/** Monotonic creation sequence for commits (topological order for listings). */
let commitSeqCounter = 0;

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function objectId(typeName: string, data: Buffer): string {
  const header = Buffer.from(`${typeName} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Parse `parent <oid>` lines out of a commit's header block. */
export function parseCommitParents(data: Buffer): string[] {
  const text = data.toString('ascii', 0, Math.min(data.length, 8192));
  const end = text.indexOf('\n\n');
  const head = end === -1 ? text : text.slice(0, end);
  const parents: string[] = [];
  let i = 0;
  while (i < head.length) {
    const nl = head.indexOf('\n', i);
    const line = nl === -1 ? head.slice(i) : head.slice(i, nl);
    if (line.startsWith('parent ') && line.length >= 47) parents.push(line.slice(7, 47));
    if (nl === -1) break;
    i = nl + 1;
  }
  return parents;
}

export function parseCommitTree(data: Buffer): string | null {
  const text = data.toString('ascii', 0, Math.min(data.length, 8192));
  if (!text.startsWith('tree ')) return null;
  return text.length >= 47 ? text.slice(5, 45) : null;
}

export function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('ascii', 0, Math.min(data.length, 8192));
  if (!text.startsWith('object ')) return null;
  return text.length >= 48 ? text.slice(7, 47) : null;
}

/** Store an object (idempotent); caches commit parents/tree on first store. */
export function storeObject(repo: Repo, typeName: string, data: Buffer): string {
  const oid = objectId(typeName, data);
  if (!repo.objects.has(oid)) {
    const t = TYPE_CODES[typeName] as ObjType;
    repo.objects.set(oid, { t, b: data });
    if (t === 1) {
      repo.commitParents.set(oid, parseCommitParents(data));
      const tree = parseCommitTree(data);
      if (tree !== null) repo.commitTree.set(oid, tree);
      repo.commitSeq.set(oid, ++commitSeqCounter);
    }
  }
  return oid;
}

export function parseTreeEntries(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const nul = data.indexOf(0, sp + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    entries.push({
      mode: data.toString('ascii', i, sp),
      name: data.toString('utf8', sp + 1, nul),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return entries;
}

export function getTreeEntries(repo: Repo, oid: string): TreeEntry[] {
  let e = repo.treeCache.get(oid);
  if (e === undefined) {
    const obj = repo.objects.get(oid);
    e = obj !== undefined && obj.t === 2 ? parseTreeEntries(obj.b) : [];
    repo.treeCache.set(oid, e);
  }
  return e;
}

/** Build a tree buffer; entries sort by name (plain string sort, git's rule here). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Buffer[] = new Array(sorted.length * 2);
  let k = 0;
  for (const e of sorted) {
    parts[k++] = Buffer.from(`${e.mode} ${e.name}\0`, 'utf8');
    parts[k++] = Buffer.from(e.oid, 'hex');
  }
  return Buffer.concat(parts);
}

export function buildCommit(
  tree: string,
  parents: string[],
  authorName: string,
  authorEmail: string,
  ts: number,
  message: string,
): Buffer {
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${authorName} <${authorEmail}> ${ts} +0000\n`;
  s += `committer ${authorName} <${authorEmail}> ${ts} +0000\n\n${message}`;
  return Buffer.from(s, 'utf8');
}

export function buildTag(
  object: string,
  type: string,
  tag: string,
  taggerName: string,
  taggerEmail: string,
  ts: number,
  message: string,
): Buffer {
  return Buffer.from(
    `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${taggerName} <${taggerEmail}> ${ts} +0000\n\n${message}`,
    'utf8',
  );
}

/** True when `anc` is `desc` or reachable from it through parent links. */
export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack: string[] = [desc];
  seen.add(desc);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const parents = repo.commitParents.get(cur);
    if (parents === undefined) continue;
    for (const p of parents) {
      if (p === anc) return true;
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return false;
}

/** The merge-base of two commits: the first common ancestor found by BFS. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const seenA = new Set<string>([a]);
  const stackA: string[] = [a];
  while (stackA.length > 0) {
    const cur = stackA.pop()!;
    for (const p of repo.commitParents.get(cur) ?? []) {
      if (!seenA.has(p)) {
        seenA.add(p);
        stackA.push(p);
      }
    }
  }
  const seenB = new Set<string>([b]);
  const stackB: string[] = [b];
  if (seenA.has(b)) return b;
  while (stackB.length > 0) {
    const cur = stackB.pop()!;
    for (const p of repo.commitParents.get(cur) ?? []) {
      if (seenA.has(p)) return p;
      if (!seenB.has(p)) {
        seenB.add(p);
        stackB.push(p);
      }
    }
  }
  return null;
}

/** Flat path -> {oid, mode} map of a tree, recursing into subtrees. */
export function flattenTree(repo: Repo, treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (treeOid === null) return out;
  const stack: Array<{ oid: string; prefix: string }> = [{ oid: treeOid, prefix: '' }];
  while (stack.length > 0) {
    const { oid, prefix } = stack.pop()!;
    for (const e of getTreeEntries(repo, oid)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') stack.push({ oid: e.oid, prefix: path });
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  }
  return out;
}

/**
 * Rebuild a tree with one file set (or removed). Returns the new root tree oid.
 * `baseTreeOid` may be null (empty tree). Intermediate directories are created.
 */
export function setFileInTree(
  repo: Repo,
  baseTreeOid: string | null,
  path: string,
  blobOid: string | null,
): string {
  const flat = flattenTree(repo, baseTreeOid);
  if (blobOid === null) flat.delete(path);
  else flat.set(path, { oid: blobOid, mode: '100644' });
  // Group by directory, bottom-up.
  const byDir = new Map<string, Map<string, { oid: string; mode: string }>>();
  const ensureDir = (dir: string): Map<string, { oid: string; mode: string }> => {
    let m = byDir.get(dir);
    if (m === undefined) {
      m = new Map();
      byDir.set(dir, m);
    }
    return m;
  };
  for (const [p, v] of flat) {
    const slash = p.lastIndexOf('/');
    const dir = slash === -1 ? '' : p.slice(0, slash);
    const name = slash === -1 ? p : p.slice(slash + 1);
    ensureDir(dir).set(name, v);
  }
  // Directories, deepest first.
  const dirs = [...byDir.keys()].sort((a, b) => b.split('/').length - a.split('/').length);
  const treeOidOf = new Map<string, string>();
  for (const dir of dirs) {
    const entries: TreeEntry[] = [];
    for (const [name, v] of ensureDir(dir)) entries.push({ mode: v.mode, name, oid: v.oid });
    // Add subdirectories of this dir as tree entries.
    for (const [sub, subOid] of treeOidOf) {
      const parent = sub.lastIndexOf('/') === -1 ? '' : sub.slice(0, sub.lastIndexOf('/'));
      if (parent === dir) {
        const name = sub.slice(sub.lastIndexOf('/') + 1);
        entries.push({ mode: '40000', name, oid: subOid });
      }
    }
    if (entries.length === 0 && dir !== '') continue; // empty dir: drop it
    const buf = buildTree(entries);
    const oid = storeObject(repo, 'tree', buf);
    treeOidOf.set(dir, oid);
  }
  const root = treeOidOf.get('') ?? storeObject(repo, 'tree', buildTree([]));
  return root;
}

// ---------------------------------------------------------------- packfiles

function packEntryHeader(type: number, size: number): Buffer {
  const h: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  size >>>= 4;
  if (size === 0) {
    h.push(first);
  } else {
    h.push(first | 0x80);
    while (size > 0) {
      let b = size & 0x7f;
      size >>>= 7;
      if (size > 0) b |= 0x80;
      h.push(b);
    }
  }
  return Buffer.from(h);
}

/** Build a PACK v2 with plain (non-delta) entries, deflate level 1. */
export function buildPack(entries: Array<{ oid: string; t: ObjType; b: Buffer }>): Buffer {
  const parts: Buffer[] = new Array(entries.length * 2 + 1);
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts[0] = header;
  let k = 1;
  for (const e of entries) {
    parts[k++] = packEntryHeader(e.t, e.b.length);
    parts[k++] = deflateSync(e.b, { level: 1 });
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate one zlib stream starting at `off`, returning its data and the exact
 * number of bytes the stream consumed. One `Inflate` stream decompresses
 * exactly one zlib stream and reports the input it consumed in `bytesWritten`,
 * so a single stream per object is both exact and ~5x faster than probing
 * with repeated inflateSync calls.
 */
function inflateAt(buf: Buffer, off: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inf = createInflate();
    const chunks: Buffer[] = [];
    inf.on('data', (c: Buffer) => chunks.push(c));
    inf.on('error', reject);
    inf.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: inf.bytesWritten }));
    inf.end(buf.subarray(off));
  });
}

/** Parse a PACK v2 (plain objects only); verifies the trailer SHA-1. */
export async function parsePack(buf: Buffer): Promise<Array<{ oid: string; t: ObjType; b: Buffer }>> {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack header');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack trailer checksum mismatch');
  const end = buf.length - 20;
  const out: Array<{ oid: string; t: ObjType; b: Buffer }> = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    if (off >= end) throw new Error('pack truncated');
    let b0 = buf[off++];
    const type = (b0 >> 4) & 0x07;
    let size = b0 & 0x0f;
    let shift = 4;
    while ((b0 & 0x80) !== 0) {
      if (off >= end) throw new Error('pack truncated');
      b0 = buf[off++];
      size |= (b0 & 0x7f) << shift;
      shift += 7;
    }
    if (type === 6 || type === 7) throw new Error('delta pack entries are not accepted');
    if (type < 1 || type > 4) throw new Error(`bad pack entry type ${type}`);
    const { data, consumed } = await inflateAt(buf, off);
    if (data.length !== size) throw new Error('pack entry size mismatch');
    off += consumed;
    const oid = objectId(TYPE_NAMES[type as ObjType], data);
    out.push({ oid, t: type as ObjType, b: data });
  }
  return out;
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Wrap data in sideband band-1 pkt-lines (each pkt-line <= 65520 bytes). */
export function sidebandWrap(data: Buffer): Buffer {
  const MAX = 65515;
  const parts: Buffer[] = [];
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([1])));
    return Buffer.concat(parts);
  }
  for (let off = 0; off < data.length; off += MAX) {
    const chunk = data.subarray(off, Math.min(off + MAX, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

/** Parse pkt-lines from `buf` starting at `start`; stops at the flush line. */
export function parsePktLines(buf: Buffer, start = 0): { lines: string[]; end: number } {
  const lines: string[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', i, i + 4), 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) {
      i += 4;
      break;
    }
    if (len === 1) {
      i += 4;
      continue;
    }
    if (i + len > buf.length) break;
    lines.push(buf.toString('utf8', i + 4, i + len));
    i += len;
  }
  return { lines, end: i };
}

// ---------------------------------------------------------------- fetch selection

export interface FetchSelection {
  objects: Array<{ oid: string; t: ObjType; b: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Select the objects a fetch must send.
 *
 * - `wants`: wanted commit oids (a tag want is peeled to its target commit).
 * - `haves`: commits the client already holds — never sent, never traversed,
 *   EXCEPT when the commit is also one of the request's shallow boundaries
 *   (a deepen: the client holds the boundary but wants its parents).
 * - `shallowReq`: the client's current shallow boundaries.
 * - `depth`: deepen N — generations 0..N-1 only (generation 0 = the wants).
 *   The deepest included commits with unsent parents become the new
 *   shallow boundaries; a boundary whose parents were sent becomes unshallow.
 */
export function collectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  shallowReq: Set<string>,
  depth: number | null,
): FetchSelection {
  const objMap = new Map<string, { oid: string; t: ObjType; b: Buffer }>();
  const genOf = new Map<string, number>();
  const visited = new Set<string>();
  const queue: Array<[string, number]> = [];
  let qhead = 0;
  for (const w of wants) queue.push([w, 0]);

  // Objects the client already holds: everything reachable from the haves
  // (commits, their ancestors, and every tree/blob under them). A shallow
  // boundary's parents are NOT held, so the walk stops there for boundaries.
  const held = new Set<string>();
  {
    const addTree = (treeOid: string | undefined): void => {
      if (treeOid === undefined) return;
      const stack: string[] = [treeOid];
      while (stack.length > 0) {
        const t = stack.pop()!;
        if (held.has(t)) continue;
        const obj = repo.objects.get(t);
        if (obj === undefined || obj.t !== 2) continue;
        held.add(t);
        for (const e of getTreeEntries(repo, t)) {
          if (held.has(e.oid)) continue;
          const child = repo.objects.get(e.oid);
          if (child === undefined) continue;
          if (child.t === 3) held.add(e.oid);
          else if (child.t === 2) stack.push(e.oid);
        }
      }
    };
    const stack: string[] = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (held.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      held.add(oid);
      if (obj.t === 1) {
        addTree(repo.commitTree.get(oid));
        if (!shallowReq.has(oid)) {
          for (const p of repo.commitParents.get(oid) ?? []) stack.push(p);
        }
      } else if (obj.t === 4) {
        const target = parseTagTarget(obj.b);
        if (target !== null) stack.push(target);
      } else if (obj.t === 2) {
        addTree(oid);
      }
    }
  }

  const includeCommitTree = (commitOid: string): void => {
    const treeOid = repo.commitTree.get(commitOid);
    if (treeOid === undefined) return;
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (objMap.has(t) || held.has(t)) continue;
      const obj = repo.objects.get(t);
      if (obj === undefined || obj.t !== 2) continue;
      objMap.set(t, { oid: t, t: 2, b: obj.b });
      for (const e of getTreeEntries(repo, t)) {
        if (objMap.has(e.oid) || held.has(e.oid)) continue;
        const child = repo.objects.get(e.oid);
        if (child === undefined) continue;
        if (child.t === 3) objMap.set(e.oid, { oid: e.oid, t: 3, b: child.b });
        else if (child.t === 2) stack.push(e.oid);
      }
    }
  };

  while (qhead < queue.length) {
    const [oid, gen] = queue[qhead++]!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.t === 4) {
      // Tag want: send the tag, then fetch its target at the same generation.
      if (!objMap.has(oid) && !held.has(oid)) objMap.set(oid, { oid, t: 4, b: obj.b });
      const target = parseTagTarget(obj.b);
      if (target !== null) queue.push([target, gen]);
      continue;
    }
    if (obj.t !== 1) continue;
    const isHave = haves.has(oid);
    const isBoundary = shallowReq.has(oid);
    if ((isHave || held.has(oid)) && !isBoundary) continue; // held: neither sent nor traversed
    if (depth !== null && gen >= depth) continue; // beyond the depth limit
    const parents = repo.commitParents.get(oid) ?? [];
    if (!isHave) {
      objMap.set(oid, { oid, t: 1, b: obj.b });
      genOf.set(oid, gen);
      includeCommitTree(oid);
    }
    for (const p of parents) {
      if (depth === null || gen + 1 < depth) queue.push([p, gen + 1]);
    }
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const [oid, gen] of genOf) {
      if (gen !== depth - 1) continue;
      const parents = repo.commitParents.get(oid) ?? [];
      if (parents.length > 0 && parents.some((p) => !haves.has(p))) shallow.push(oid);
    }
  }
  for (const b of shallowReq) {
    const parents = repo.commitParents.get(b) ?? [];
    if (parents.length > 0 && parents.some((p) => objMap.has(p))) unshallow.push(b);
  }
  return { objects: [...objMap.values()], shallow, unshallow };
}
