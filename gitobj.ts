// gitobj.ts — Git object model: SHA-1 ids, object parse/build, packfiles, pkt-lines.
// Written from the make.fun github-core-clone-01 kit's wire spec (no git binary).

import { createHash } from 'node:crypto';
import { inflateSync, deflate } from 'node:zlib';
import { promisify } from 'node:util';

const deflateAsync = promisify(deflate);

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Parse a commit object into its header fields plus message. */
export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
} {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export function parseTag(data: Buffer): {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
} {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(fields: {
  object: string;
  type: string;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}): Buffer {
  const lines = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger} ${fields.timestamp} +0000`,
    '',
  ];
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

/** Parse a tree object into its entries (sorted by git's raw order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = a.mode === '40000' ? `${a.name}/` : a.name;
    const right = b.mode === '40000' ? `${b.name}/` : b.name;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export type PktLine =
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' }
  | { kind: 'data'; data: Buffer };

/** Parse pkt-lines from a buffer. Returns the lines and the offset of the first byte after them. */
export function parsePktLines(buffer: Buffer): { lines: PktLine[]; offset: number } {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const sizeText = buffer.subarray(offset, offset + 4).toString('ascii');
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isInteger(size) || size < 0) break;
    if (size === 0) {
      lines.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (size === 1) {
      lines.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (size === 2) {
      lines.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (size < 4 || offset + size > buffer.length) break;
    lines.push({ kind: 'data', data: buffer.subarray(offset + 4, offset + size) });
    offset += size;
  }
  return { lines, offset };
}

/** Encode one pkt-line data payload. */
export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');

/** Decode the data payloads of a pkt-line stream into a list of byte strings. */
export function pktLinesData(buffer: Buffer): Buffer[] {
  const { lines } = parsePktLines(buffer);
  const out: Buffer[] = [];
  for (const line of lines) if (line.kind === 'data') out.push(line.data);
  return out;
}

/** Parse a text protocol request body: pkt-lines until the first flush; rest is raw pack bytes. */
export function splitPktBody(buffer: Buffer): { lines: PktLine[]; rest: Buffer } {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const sizeText = buffer.subarray(offset, offset + 4).toString('ascii');
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isInteger(size) || size < 0) break;
    if (size === 0) {
      lines.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (size === 1) {
      lines.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (size === 2) {
      lines.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (size < 4 || offset + size > buffer.length) break;
    lines.push({ kind: 'data', data: buffer.subarray(offset + 4, offset + size) });
    offset += size;
  }
  return { lines, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------------------------
// packfiles (whole objects; OFS and REF deltas resolved when present)
// ---------------------------------------------------------------------------------------------

const PACK_TYPE_COMMIT = 1;
const PACK_TYPE_TREE = 2;
const PACK_TYPE_BLOB = 3;
const PACK_TYPE_TAG = 4;
const PACK_TYPE_OFS_DELTA = 6;
const PACK_TYPE_REF_DELTA = 7;

function packTypeName(type: number): GitObjectType | null {
  if (type === PACK_TYPE_COMMIT) return 'commit';
  if (type === PACK_TYPE_TREE) return 'tree';
  if (type === PACK_TYPE_BLOB) return 'blob';
  if (type === PACK_TYPE_TAG) return 'tag';
  return null;
}

/** Read a packfile into a map of oid -> object. Throws on malformed input. */
export async function readPack(buffer: Buffer): Promise<Map<string, GitObject>> {
  if (buffer.length < 12) throw new Error('pack too small');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buffer.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const pendingDeltas: { baseOid?: string; baseOffset?: number; data: Buffer }[] = [];
  const offsetByOid = new Map<string, number>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const startOffset = offset;
    let byte = buffer[offset];
    offset += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (type === PACK_TYPE_OFS_DELTA) {
      byte = buffer[offset];
      offset += 1;
      let deltaOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buffer[offset];
        offset += 1;
        deltaOffset = ((deltaOffset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = startOffset - deltaOffset;
    } else if (type === PACK_TYPE_REF_DELTA) {
      baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data: inflated, consumed } = inflateOne(buffer, offset);
    offset += consumed;
    const data = inflated.subarray(0, size);
    if (type === PACK_TYPE_OFS_DELTA || type === PACK_TYPE_REF_DELTA) {
      pendingDeltas.push({ baseOid, baseOffset, data });
    } else {
      const objectType = packTypeName(type);
      if (!objectType) throw new Error(`unknown pack object type ${type}`);
      const oid = hashObject(objectType, data);
      objects.set(oid, { type: objectType, data });
      offsetByOid.set(oid, startOffset);
    }
  }
  for (const delta of pendingDeltas) {
    let base: GitObject | undefined;
    if (delta.baseOid) base = objects.get(delta.baseOid);
    else if (delta.baseOffset !== undefined) {
      // find the object whose pack offset is baseOffset by re-scanning is too costly;
      // deltas in this suite never reference pack offsets, but resolve via stored map.
      base = objectsByOffset(objects, offsetByOid, delta.baseOffset);
    }
    if (!base) throw new Error('delta base not found');
    const data = applyDelta(base.data, delta.data);
    const oid = hashObject(base.type, data);
    objects.set(oid, { type: base.type, data });
  }
  return objects;
}

function objectsByOffset(
  objects: Map<string, GitObject>,
  offsetByOid: Map<string, number>,
  offset: number,
): GitObject | undefined {
  for (const [oid, at] of offsetByOid) if (at === offset) return objects.get(oid);
  return undefined;
}

/**
 * Inflate exactly one zlib stream starting at `offset` and report how many input bytes it
 * consumed. inflateSync ignores trailing bytes (succeeds on an over-long slice) but throws
 * "unexpected end of file" on a truncated one, so the minimal successful length — found by
 * binary search — is exactly the stream's length.
 */
function inflateOne(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  const remaining = buffer.length - offset;
  let lo = 1;
  let hi = remaining;
  let ok = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buffer.subarray(offset, offset + mid));
      ok = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (ok === -1) throw new Error('invalid deflate stream');
  const data = inflateSync(buffer.subarray(offset, offset + ok));
  return { data, consumed: ok };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let length = 0;
  while (offset < delta.length) {
    const opcode = delta[offset];
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (opcode & 0x01) copyOffset = delta[offset++];
      if (opcode & 0x02) copyOffset |= delta[offset++] << 8;
      if (opcode & 0x04) copyOffset |= delta[offset++] << 16;
      if (opcode & 0x08) copyOffset |= delta[offset++] << 24;
      if (opcode & 0x10) copySize = delta[offset++];
      if (opcode & 0x20) copySize |= delta[offset++] << 8;
      if (opcode & 0x40) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      length += copySize;
    } else if (opcode !== 0) {
      parts.push(delta.subarray(offset, offset + opcode));
      offset += opcode;
      length += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (length !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(parts);
}

/** Write a packfile (version 2, whole objects, deterministic order). */
export async function writePack(objects: Iterable<GitObject>): Promise<Buffer> {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  const typeCode: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const object of list) {
    const deflated = await deflateAsync(object.data);
    const size = object.data.length;
    const type = typeCode[object.type];
    const first = Buffer.alloc(1);
    first[0] = (type << 4) | (size & 0x0f);
    let rest = size >> 4;
    const sizeBytes: number[] = [];
    while (rest > 0) {
      sizeBytes.push(rest & 0x7f);
      rest >>= 7;
    }
    const head = Buffer.alloc(1 + sizeBytes.length);
    head[0] = first[0] | (sizeBytes.length > 0 ? 0x80 : 0);
    for (let i = 0; i < sizeBytes.length; i += 1) {
      head[1 + i] = sizeBytes[i] | (i + 1 < sizeBytes.length ? 0x80 : 0);
    }
    parts.push(head, deflated);
  }
  const trailer = Buffer.from(sha1Hex(Buffer.concat(parts)), 'hex');
  parts.push(trailer);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/** All objects reachable from the given commit/tag tips (commit -> tree closure, tag -> target). */
export function collectReachable(
  tips: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  const found = new Map<string, GitObject>();
  const stack: string[] = [...tips];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    found.set(oid, object);
    if (object.type === 'commit') {
      const { tree, parents } = parseCommit(object.data);
      stack.push(tree, ...parents);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
  return found;
}

/** Commit generation distances from the given roots (distance 1 = the roots themselves). */
export function commitDistances(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: { oid: string; dist: number }[] = [];
  for (const root of roots) queue.push({ oid: root, dist: 1 });
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    if (distances.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    distances.set(oid, dist);
    for (const parent of parseCommit(object.data).parents) {
      if (!distances.has(parent)) queue.push({ oid: parent, dist: dist + 1 });
    }
  }
  return distances;
}
