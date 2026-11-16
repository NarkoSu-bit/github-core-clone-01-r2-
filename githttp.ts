// githttp.ts — Git smart HTTP: info/refs advertisements, upload-pack v2, receive-pack v0.
// Written from the make.fun github-core-clone-01 kit's wire spec (no git binary).

import {
  ZERO_OID,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  FLUSH,
  pktLinesData,
  splitPktBody,
  readPack,
  writePack,
  isObjectId,
  type GitObject,
} from './gitobj.ts';
import { type Repo } from './store.ts';

const AGENT = 'makefun-git-forge/1.0';

function sidebandPacket(band: number, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([band]), data]);
  return pktLine(payload);
}

function sidebandPackets(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    chunks.push(sidebandPacket(1, data.subarray(offset, Math.min(offset + CHUNK, data.length))));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function mainOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** v2 capability advertisement. */
export function advertiseV2(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=git-${service}\n`));
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine(`agent=${AGENT}\n`));
  if (service === 'upload-pack') {
    parts.push(pktLine('ls-refs\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('object-format=sha1\n'));
  } else {
    parts.push(pktLine('report-status-v2\n'));
    parts.push(pktLine('side-band-64k\n'));
    parts.push(pktLine('delete-refs\n'));
    parts.push(pktLine('object-format=sha1\n'));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v0 advertisement: preamble, HEAD + refs, capabilities after NUL on the first line. */
export function advertiseV0(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const main = mainOid(repo);
  const capabilities =
    service === 'upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow agent=${AGENT} object-format=sha1`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`;
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=git-${service}\n`));
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    const headOid = main ?? refs[0].oid;
    parts.push(pktLine(`${headOid} HEAD\0${capabilities}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      // peeled line for annotated tags, directly after the tag line
      const object = repo.lookup(ref.oid);
      if (ref.name.startsWith('refs/tags/') && object?.type === 'tag') {
        const peeled = repo.peel(ref.oid);
        if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
}

function parseLsRefsArgs(lines: Buffer[]): LsRefsArgs {
  const args: LsRefsArgs = { prefixes: [], peel: false, symrefs: false, unborn: false };
  for (const line of lines) {
    const text = line.toString('utf8').trim();
    if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    else if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const main = mainOid(repo);
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const matchesPrefix = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  // HEAD first, only when no prefix filter hides it.
  if (main && args.prefixes.length === 0) {
    const suffix = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    parts.push(pktLine(`${main} HEAD${suffix}\n`));
  }
  for (const ref of refs) {
    if (!matchesPrefix(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const object = repo.lookup(ref.oid);
    if (args.peel && ref.name.startsWith('refs/tags/') && object?.type === 'tag') {
      const peeled = repo.peel(ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenNot?: string;
  deepenSince?: number;
}

function parseFetchRequest(lines: Buffer[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const line of lines) {
    const text = line.toString('utf8').trim();
    if (text.startsWith('want ')) request.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7), 10);
      if (Number.isInteger(n)) request.depth = n;
    } else if (text.startsWith('deepen-not ')) request.deepenNot = text.slice(11).trim();
    else if (text.startsWith('deepen-since ')) {
      const n = Number.parseInt(text.slice(13), 10);
      if (Number.isInteger(n)) request.deepenSince = n;
    }
  }
  return request;
}

/**
 * Compute the fetch result: which objects to send, which commits are new shallow
 * boundaries, and which old boundaries are now unshallowed.
 */
export function computeFetch(
  repo: Repo,
  request: FetchRequest,
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.lookup(oid);
  const shallowSet = new Set(request.shallow);
  const depth = request.depth;

  // Objects the client already holds: walk from its haves, stopping at shallow boundaries.
  const heldObjects = new Map<string, GitObject>();
  const heldCommits = new Set<string>();
  const heldStack: string[] = [...request.haves];
  const heldSeen = new Set<string>();
  while (heldStack.length > 0) {
    const oid = heldStack.pop()!;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    heldObjects.set(oid, object);
    if (object.type === 'commit') {
      heldCommits.add(oid);
      const { tree, parents } = parseCommit(object.data);
      heldStack.push(tree);
      if (shallowSet.has(oid)) continue; // boundary: tree held, parents not held
      heldStack.push(...parents);
    } else if (object.type === 'tag') {
      heldStack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) heldStack.push(entry.oid);
    }
  }

  // Walk from the wants, tracking commit distances.
  const includedCommits = new Set<string>();
  const cutoff = new Set<string>(); // commits at exactly the depth limit
  const queue: { oid: string; dist: number }[] = [];
  const queued = new Set<string>();
  const directObjects = new Map<string, GitObject>();
  for (const want of request.wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'commit') {
      if (!queued.has(want)) {
        queued.add(want);
        queue.push({ oid: want, dist: 1 });
      }
    } else if (object.type === 'tag') {
      directObjects.set(want, object);
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (targetObject?.type === 'commit') {
        if (!queued.has(target)) {
          queued.add(target);
          queue.push({ oid: target, dist: 1 });
        }
      } else if (targetObject) {
        directObjects.set(target, targetObject);
      }
    } else {
      directObjects.set(want, object);
    }
  }
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    if (depth !== undefined && dist > depth) continue;
    if (heldCommits.has(oid) && !shallowSet.has(oid)) continue; // already held, parents held too
    if (depth !== undefined && dist === depth) {
      includedCommits.add(oid);
      cutoff.add(oid);
      continue; // parents are beyond the depth limit
    }
    includedCommits.add(oid);
    for (const parent of parseCommit(object.data).parents) {
      if (!queued.has(parent)) {
        queued.add(parent);
        queue.push({ oid: parent, dist: dist + 1 });
      }
    }
  }

  // Objects to send: included commits + their tree closures + direct objects, minus held.
  // The closure is depth-aware: a commit contributes its tree, never its parents (the
  // included set already holds every commit the client is meant to receive).
  const toSend = new Map<string, GitObject>();
  const closureStack: string[] = [...includedCommits, ...directObjects.keys()];
  const closureSeen = new Set<string>();
  while (closureStack.length > 0) {
    const oid = closureStack.pop()!;
    if (closureSeen.has(oid)) continue;
    closureSeen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    if (!heldObjects.has(oid)) toSend.set(oid, object);
    if (object.type === 'commit') {
      closureStack.push(parseCommit(object.data).tree);
    } else if (object.type === 'tag') {
      closureStack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) closureStack.push(entry.oid);
    }
  }

  // New shallow boundaries: depth cutoffs, plus old boundaries whose parents are still missing.
  const shallow = new Set<string>(cutoff);
  if (depth === undefined) {
    for (const oid of shallowSet) {
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const allCovered = parents.every((p) => includedCommits.has(p) || heldCommits.has(p));
      if (!allCovered) shallow.add(oid);
    }
  } else {
    for (const oid of shallowSet) {
      if (includedCommits.has(oid) || heldCommits.has(oid)) {
        const object = lookup(oid);
        if (!object || object.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        const allCovered = parents.every((p) => includedCommits.has(p) || heldCommits.has(p));
        if (!allCovered) shallow.add(oid);
      }
    }
  }
  const unshallow = new Set<string>();
  for (const oid of shallowSet) {
    if (shallow.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const allCovered = parents.every((p) => includedCommits.has(p) || heldCommits.has(p));
    if (allCovered) unshallow.add(oid);
  }
  return { objects: toSend, shallow: [...shallow], unshallow: [...unshallow] };
}

async function fetchResponse(repo: Repo, request: FetchRequest): Promise<Buffer> {
  const { objects, shallow, unshallow } = computeFetch(repo, request);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  const acks = request.haves.filter((have) => repo.lookup(have) !== undefined);
  if (acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(pktLine('ready\n'));
  parts.push(FLUSH);
  // shallow-info
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  // packfile
  if (objects.size > 0) {
    parts.push(pktLine('packfile\n'));
    const pack = await writePack(objects.values());
    parts.push(sidebandPackets(pack));
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

export async function handleUploadPackV2(repo: Repo, body: Buffer): Promise<Buffer> {
  const { lines } = splitPktBody(body);
  const dataLines = lines.filter((l) => l.kind === 'data').map((l) => l.data);
  const firstLine = dataLines.length > 0 ? dataLines[0].toString('utf8').trim() : '';
  const commandMatch = /^command=(\S+)/.exec(firstLine);
  const command = commandMatch ? commandMatch[1] : firstLine.split(/\s+/)[0];
  if (command === 'ls-refs') {
    return lsRefsResponse(repo, parseLsRefsArgs(dataLines.slice(1)));
  }
  if (command === 'fetch') {
    return fetchResponse(repo, parseFetchRequest(dataLines.slice(1)));
  }
  throw new Error(`unknown upload-pack v2 command: ${command}`);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0 (fallback)
// ---------------------------------------------------------------------------------------------

function wantList(lines: Buffer[]): string[] {
  const wants: string[] = [];
  for (const line of lines) {
    const text = line.toString('utf8').trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0].trim());
  }
  return wants;
}

/** v0 fetch: two sections (want+shallow/deepen, then have+done), pack in side-band-64k. */
export async function handleUploadPackV0(repo: Repo, body: Buffer): Promise<Buffer> {
  const { lines } = splitPktBody(body);
  const dataLines = lines.filter((l) => l.kind === 'data').map((l) => l.data);
  const wants = wantList(dataLines);
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of dataLines) {
    const text = line.toString('utf8').trim();
    if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7), 10);
      if (Number.isInteger(n)) depth = n;
    }
  }
  const { objects } = computeFetch(repo, { wants, haves, shallow, depth });
  const parts: Buffer[] = [];
  if (objects.size > 0) {
    const pack = await writePack(objects.values());
    parts.push(sidebandPackets(pack));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(lines: Buffer[]): PushCommand[] {
  const commands: PushCommand[] = [];
  for (const line of lines) {
    const text = line.toString('utf8');
    const nul = text.indexOf('\0');
    const clean = (nul >= 0 ? text.slice(0, nul) : text).trim();
    const parts = clean.split(/\s+/);
    if (parts.length >= 3 && isObjectId(parts[0]) && isObjectId(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  return commands;
}

export async function handleReceivePack(repo: Repo, body: Buffer): Promise<Buffer> {
  const { lines, rest } = splitPktBody(body);
  const dataLines = lines.filter((l) => l.kind === 'data').map((l) => l.data);
  const commands = parsePushCommands(dataLines);
  let unpackError: string | undefined;
  if (rest.length > 0) {
    try {
      const objects = await readPack(rest);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  const report: string[] = [];
  if (unpackError) {
    report.push(`unpack ${unpackError}\n`);
    for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
  } else {
    report.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // delete
        if (current === undefined) {
          report.push(`ng ${command.ref} ref does not exist\n`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          report.push(`ng ${command.ref} stale info\n`);
        } else {
          repo.refs.delete(command.ref);
          report.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (!repo.lookup(command.newOid)) {
        report.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // create
        if (current !== undefined) {
          report.push(`ng ${command.ref} already exists\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          report.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      // update: fast-forward only
      if (current === undefined) {
        report.push(`ng ${command.ref} ref does not exist\n`);
      } else if (command.oldOid !== current) {
        report.push(`ng ${command.ref} stale info\n`);
      } else if (!repo.isAncestor(command.oldOid, command.newOid)) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}\n`);
      }
    }
  }
  const inner = Buffer.concat([
    ...report.map((line) => pktLine(line)),
    FLUSH,
  ]);
  const parts: Buffer[] = [];
  parts.push(sidebandPacket(1, inner));
  parts.push(sidebandPacket(2, Buffer.from(`unpacking objects: 100% (${commands.length}/${commands.length}), done.\n`, 'utf8')));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
