// git-http.ts — the git smart-HTTP surface.
//
// Protocol notes (from the suite's git-client contract):
// - upload-pack speaks v2 when the request carries `Git-Protocol: version=2`,
//   else v0. receive-pack is v0 only.
// - v2 fetch answers sections in order: acknowledgments, shallow-info,
//   packfile (sideband band 1), each closed by a delim, then a flush.
// - v2 ls-refs answers `<oid> <name>[ symref-target:X][ peeled:Y]` or
//   `unborn <name>[ symref-target:X]`; the HEAD line only when no ref-prefix.
// - receive-pack never advertises report-status-v2 (plain report-status).
// - A depth-1 fetch of a single tip with no haves is the clone workload's
//   hot path: the built pack is cached per (repo, tip) and served as-is.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import { VIEWER_LOGIN, ZERO_OID } from './store.ts';
import {
  buildPack,
  collectFetchObjects,
  isAncestor,
  parsePack,
  parsePktLines,
  pktDelim,
  pktFlush,
  pktLine,
  sidebandWrap,
  storeObject,
} from './git.ts';
import { messageReply, readBody } from './http-util.ts';
import { refreshPullsForRef } from './rest.ts';

const MAX_GIT_BODY = 64 * 1024 * 1024;
const UPLOAD_PACK_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_PACK_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_PACK_RESULT = 'application/x-git-receive-pack-result';

function needRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The default branch tip, or null for an unborn repo. */
function headTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** The commit an annotated tag ref points at (for peeled lines). */
function peeledTarget(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.t !== 4) return null;
  const text = obj.b.toString('ascii', 0, Math.min(obj.b.length, 8192));
  if (!text.startsWith('object ')) return null;
  return text.slice(7, 47);
}

// ---------------------------------------------------------------- info/refs

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

function v0Advertisement(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps =
    service === 'upload-pack'
      ? 'symref=HEAD:refs/heads/main side-band-64k ofs-delta multi_ack thin-pack shallow'
      : 'report-status side-band-64k delete-refs ofs-delta';
  const preamble = service === 'upload-pack' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const parts: Buffer[] = [pktLine(preamble), pktFlush()];
  const tip = headTip(repo);
  const refs = sortedRefs(repo);
  if (tip === null && refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (tip !== null) {
      parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [name, oid] of refs) {
      let line = `${oid} ${name}`;
      if (first) line += `\0${caps}`;
      first = false;
      parts.push(pktLine(`${line}\n`));
      const peeled = peeledTarget(repo, oid);
      if (peeled !== null && name.startsWith('refs/tags/')) {
        parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  query: Map<string, string>,
  reqId: string,
): void {
  const service = query.get('service') ?? '';
  const repo = needRepo(store, owner, name);
  if (repo === null) {
    messageReply(res, 404, 'Not Found', reqId);
    return;
  }
  if (service === 'git-upload-pack') {
    if ((req.headers['git-protocol'] ?? '') === 'version=2') {
      res.writeHead(200, { 'content-type': UPLOAD_PACK_AD, 'x-github-request-id': reqId });
      res.end(v2Advertisement());
      return;
    }
    // v0 advertisement: cached per repo, invalidated on ref changes.
    if (repo.advCache === null) {
      repo.advCache = v0Advertisement(repo, 'upload-pack').toString('latin1');
      repo.advVersion = repo.refsVersion;
    }
    res.writeHead(200, { 'content-type': UPLOAD_PACK_AD, 'x-github-request-id': reqId });
    res.end(Buffer.from(repo.advCache, 'latin1'));
    return;
  }
  if (service === 'git-receive-pack') {
    res.writeHead(200, { 'content-type': RECEIVE_PACK_AD, 'x-github-request-id': reqId });
    res.end(v0Advertisement(repo, 'receive-pack'));
    return;
  }
  messageReply(res, 400, 'unknown service', reqId);
}

// ---------------------------------------------------------------- upload-pack

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const out: Buffer[] = [];
  const tip = headTip(repo);
  const refs = sortedRefs(repo);
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (prefixes.length === 0) {
    if (tip !== null) {
      out.push(pktLine(symrefs ? `${tip} HEAD symref-target:refs/heads/main\n` : `${tip} HEAD\n`));
    } else {
      out.push(pktLine(symrefs ? 'unborn HEAD symref-target:refs/heads/main\n' : 'unborn HEAD\n'));
    }
  }
  for (const [name, oid] of refs) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledTarget(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

function fetchResponse(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  shallowReq: Set<string>,
  depth: number | null,
): Buffer {
  const sel = collectFetchObjects(repo, wants, haves, shallowReq, depth);
  let pack: Buffer;
  // Clone fast path: a depth-1 fetch of one tip with no haves is cacheable.
  if (depth === 1 && wants.length === 1 && haves.size === 0 && shallowReq.size === 0) {
    const key = `${wants[0]}|1`;
    const cached = repo.packCache.get(key);
    if (cached !== undefined) {
      pack = cached;
    } else {
      pack = buildPack(sel.objects);
      repo.packCache.set(key, pack);
    }
  } else {
    pack = buildPack(sel.objects);
  }
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (haves.size === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const h of haves) {
      if (repo.objects.has(h)) parts.push(pktLine(`ACK ${h}\n`));
    }
    parts.push(pktLine('ready\n'));
  }
  parts.push(pktDelim());
  parts.push(pktLine('shallow-info\n'));
  for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(pktDelim());
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(pack));
  parts.push(pktDelim());
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

async function handleUploadPackV2(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  reqId: string,
): Promise<void> {
  const repo = needRepo(store, owner, name);
  if (repo === null) {
    messageReply(res, 404, 'Not Found', reqId);
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req, MAX_GIT_BODY);
  } catch {
    messageReply(res, 413, 'Request Entity Too Large', reqId);
    return;
  }
  const { lines } = parsePktLines(body, 0);
  const first = (lines[0] ?? '').trim();
  if (first === 'command=ls-refs') {
    res.writeHead(200, { 'content-type': UPLOAD_PACK_RESULT, 'x-github-request-id': reqId });
    res.end(handleLsRefs(repo, lines.slice(1)));
    return;
  }
  if (first === 'command=fetch') {
    const wants: string[] = [];
    const haves = new Set<string>();
    const shallowReq = new Set<string>();
    let depth: number | null = null;
    for (const raw of lines.slice(1)) {
      const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
      if (line.startsWith('want ')) wants.push(line.slice(5, 45));
      else if (line.startsWith('have ')) haves.add(line.slice(5, 45));
      else if (line.startsWith('shallow ')) shallowReq.add(line.slice(8, 48));
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7));
        if (Number.isInteger(n) && n > 0) depth = n;
      }
    }
    res.writeHead(200, { 'content-type': UPLOAD_PACK_RESULT, 'x-github-request-id': reqId });
    res.end(fetchResponse(repo, wants, haves, shallowReq, depth));
    return;
  }
  messageReply(res, 400, 'unknown command', reqId);
}

async function handleUploadPackV0(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  reqId: string,
): Promise<void> {
  const repo = needRepo(store, owner, name);
  if (repo === null) {
    messageReply(res, 404, 'Not Found', reqId);
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req, MAX_GIT_BODY);
  } catch {
    messageReply(res, 413, 'Request Entity Too Large', reqId);
    return;
  }
  const first = parsePktLines(body, 0);
  const second = parsePktLines(body, first.end);
  const wants: string[] = [];
  const haves = new Set<string>();
  const shallowReq = new Set<string>();
  let depth: number | null = null;
  for (const raw of first.lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallowReq.add(line.slice(8, 48));
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7));
      if (Number.isInteger(n) && n > 0) depth = n;
    }
  }
  for (const raw of second.lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line.startsWith('have ')) haves.add(line.slice(5, 45));
  }
  const sel = collectFetchObjects(repo, wants, haves, shallowReq, depth);
  const pack = buildPack(sel.objects);
  const parts: Buffer[] = [];
  if (haves.size === 0) parts.push(pktLine('NAK\n'));
  else {
    for (const h of haves) {
      if (repo.objects.has(h)) parts.push(pktLine(`ACK ${h}\n`));
    }
  }
  for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(sidebandWrap(pack));
  parts.push(pktFlush());
  res.writeHead(200, { 'content-type': UPLOAD_PACK_RESULT, 'x-github-request-id': reqId });
  res.end(Buffer.concat(parts));
}

export async function handleUploadPack(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  reqId: string,
): Promise<void> {
  if ((req.headers['git-protocol'] ?? '') === 'version=2') {
    await handleUploadPackV2(store, req, res, owner, name, reqId);
  } else {
    await handleUploadPackV0(store, req, res, owner, name, reqId);
  }
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function handleReceivePack(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  reqId: string,
): Promise<void> {
  const repo = needRepo(store, owner, name);
  if (repo === null) {
    messageReply(res, 404, 'Not Found', reqId);
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req, MAX_GIT_BODY);
  } catch {
    messageReply(res, 413, 'Request Entity Too Large', reqId);
    return;
  }
  const { lines, end } = parsePktLines(body, 0);
  const commands: PushCommand[] = [];
  for (const raw of lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    const nul = line.indexOf('\0');
    const cmd = nul === -1 ? line : line.slice(0, nul);
    const parts = cmd.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
  }
  const packBytes = body.subarray(end);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = await parsePack(packBytes);
      for (const o of objects) storeObject(repo, o.t === 1 ? 'commit' : o.t === 2 ? 'tree' : o.t === 3 ? 'blob' : 'tag', o.b);
    } catch (e) {
      unpackOk = false;
      unpackDetail = e instanceof Error ? e.message : 'unpack error';
    }
  }
  const report: string[] = [];
  if (!unpackOk) {
    report.push(`unpack ${unpackDetail}\n`);
    for (const c of commands) report.push(`ng ${c.ref} unpack error\n`);
  } else {
    report.push('unpack ok\n');
    const changedRefs: string[] = [];
    for (const c of commands) {
      const current = repo.refs.get(c.ref);
      if (c.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          report.push(`ng ${c.ref} reference does not exist\n`);
        } else if (current !== c.oldOid) {
          report.push(`ng ${c.ref} old value does not match\n`);
        } else {
          repo.refs.delete(c.ref);
          changedRefs.push(c.ref);
          report.push(`ok ${c.ref}\n`);
        }
        continue;
      }
      if (!repo.objects.has(c.newOid)) {
        report.push(`ng ${c.ref} object not found\n`);
        continue;
      }
      if (c.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          report.push(`ng ${c.ref} reference already exists\n`);
        } else {
          repo.refs.set(c.ref, c.newOid);
          changedRefs.push(c.ref);
          report.push(`ok ${c.ref}\n`);
        }
        continue;
      }
      // Update: old must match, new must fast-forward from old.
      if (current === undefined) {
        report.push(`ng ${c.ref} reference does not exist\n`);
      } else if (current !== c.oldOid) {
        report.push(`ng ${c.ref} old value does not match\n`);
      } else if (!isAncestor(repo, c.oldOid, c.newOid)) {
        report.push(`ng ${c.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(c.ref, c.newOid);
        changedRefs.push(c.ref);
        report.push(`ok ${c.ref}\n`);
      }
    }
    if (changedRefs.length > 0) {
      store.touchRefs(repo);
      for (const r of changedRefs) refreshPullsForRef(store, repo, r);
    }
  }
  const reportBuf = Buffer.concat(report.map((l) => pktLine(l)));
  res.writeHead(200, { 'content-type': RECEIVE_PACK_RESULT, 'x-github-request-id': reqId });
  res.end(Buffer.concat([sidebandWrap(reportBuf), pktFlush()]));
}
