// git.ts — the git smart-HTTP protocol: ref advertisement (v0 + v2), ls-refs,
// fetch (with depth / shallow / deepen) and receive-pack (push). Written from
// the wire format: pkt-lines, sideband, pack v2. No git binary is used.

import {
  objects, commitMeta, readPack, writePack, parseTree, parseTag, parseCommit,
  peelToCommit, isAncestor, invalidateRepoGit, filesOfCommit, type GitObj, type Repo, ZERO,
} from './store.ts';

// ---------------------------------------------------------------------------
// Pkt-lines.
// ---------------------------------------------------------------------------

export type GitPacket = { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload?: Buffer };

export const FLUSH = Buffer.from('0000');
export const DELIM = Buffer.from('0001');

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([head, body]);
}

/** Decode pkt-lines from a buffer. Stops at the first flush packet and returns
 *  the packets plus the byte offset just past it, so the caller can read any
 *  trailing bytes (the pack after a receive-pack command list). */
export function decodePktLines(buf: Buffer): { packets: GitPacket[]; consumed: number } {
  const packets: GitPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') { packets.push({ kind: 'flush' }); off += 4; break; }
    if (head === '0001') { packets.push({ kind: 'delim' }); off += 4; continue; }
    if (head === '0002') { packets.push({ kind: 'response-end' }); off += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      throw new Error(`malformed pkt-line header ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, consumed: off };
}

/** A sideband packet: band 1 = data, 2 = progress, 3 = error. A pkt-line holds
 *  at most 65520 bytes total, so a large payload is split into 65515-byte
 *  data chunks (4 header + 1 band + 65515 data), each its own pkt-line. */
export function sideband(band: 1 | 2 | 3, payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const MAX_DATA = 65515;
  const parts: Buffer[] = [];
  for (let off = 0; off < body.length; off += MAX_DATA) {
    const chunk = body.subarray(off, Math.min(off + MAX_DATA, body.length));
    parts.push(pkt(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Advertisement.
// ---------------------------------------------------------------------------

const AGENT = 'forge/1.0';
const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** The v2 advertisement is constant (it carries no refs, only capabilities). */
const V2_UPLOAD_ADV = Buffer.concat([
  pkt('# service=git-upload-pack\n'),
  pkt('version 2\n'),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow wait-for-done\n'),
  pkt('object-format=sha1\n'),
  pkt(`agent=${AGENT}\n`),
  FLUSH,
]);

/** Build a v0 advertisement for a repo (cached on the repo). */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const cache = service === 'git-upload-pack' ? repo.v0UploadAdv : repo.v0ReceiveAdv;
  if (cache) return cache;
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const serviceName = service === 'git-upload-pack' ? 'git-upload-pack' : 'git-receive-pack';
  const parts: Buffer[] = [pkt(`# service=${serviceName}\n`), FLUSH];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const branches = [...repo.refs.entries()]
    .filter(([n]) => n.startsWith('refs/heads/'))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const tags = [...repo.refs.entries()]
    .filter(([n]) => n.startsWith('refs/tags/'))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (branches.length === 0 && tags.length === 0) {
    parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = head ?? ZERO;
    parts.push(pkt(`${headOid} HEAD\0${caps}\n`));
    for (const [name, oid] of branches) {
      parts.push(pkt(`${oid} ${name}\n`));
    }
    for (const [name, oid] of tags) {
      parts.push(pkt(`${oid} ${name}\n`));
      const obj = objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(oid);
        if (peeled) parts.push(pkt(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  if (service === 'git-upload-pack') repo.v0UploadAdv = out;
  else repo.v0ReceiveAdv = out;
  return out;
}

/** The info/refs body: v2 when the client asks for it (upload-pack only),
 *  otherwise v0. */
export function advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', wantV2: boolean): Buffer {
  if (wantV2 && service === 'git-upload-pack') return V2_UPLOAD_ADV;
  return v0Advertisement(repo, service);
}

// ---------------------------------------------------------------------------
// ls-refs (v2).
// ---------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const args: string[] = [];
  for (const p of packets) if (p.kind === 'data' && p.payload) args.push(p.payload.toString('utf8').replace(/\n$/, ''));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  const lines: string[] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (matches('HEAD')) {
    if (head) {
      lines.push(wantSymrefs ? `${head} HEAD symref-target:refs/heads/${repo.defaultBranch}` : `${head} HEAD`);
    } else if (wantUnborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    }
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of refs) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (wantPeel) {
      const obj = objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  const parts = lines.map((l) => pkt(l + '\n'));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch (v2). Depth / shallow / deepen, with a per-repo pack cache.
// ---------------------------------------------------------------------------

/** Add a tree and everything under it to a set of oids. */
function addTreeClosure(treeOid: string, set: Set<string>): void {
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  set.add(treeOid);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') addTreeClosure(e.oid, set);
    else set.add(e.oid);
  }
}

/** Add a commit and its whole tree closure to a set. */
function addCommitClosure(commitOid: string, set: Set<string>): void {
  if (set.has(commitOid)) return;
  set.add(commitOid);
  const meta = commitMeta.get(commitOid);
  if (meta) addTreeClosure(meta.tree, set);
}

interface FetchPlan {
  oids: Set<string>; // objects to send
  shallow: string[]; // the client's new shallow boundary
  unshallow: string[]; // incoming shallow commits that are no longer boundary
}

function planFetch(wants: string[], haves: string[], depth: number | null, incomingShallow: string[]): FetchPlan {
  const shallowSet = new Set(incomingShallow);
  // Held: everything reachable from the haves, stopping at shallow boundaries
  // (a shallow commit's parents are not held by the client).
  const held = new Set<string>();
  const heldSeen = new Set<string>();
  const heldQueue = [...haves];
  while (heldQueue.length > 0) {
    const oid = heldQueue.shift()!;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      held.add(oid);
      heldQueue.push(parseTag(obj.data).object);
      continue;
    }
    if (obj.type !== 'commit') { held.add(oid); continue; }
    addCommitClosure(oid, held);
    if (!shallowSet.has(oid)) {
      const meta = commitMeta.get(oid);
      if (meta) heldQueue.push(...meta.parents);
    }
  }
  // Wanted: the depth-limited closure from the wants (generation 1 = the want).
  const wanted = new Set<string>();
  const seenCommit = new Set<string>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 1] as [string, number]);
  while (queue.length > 0) {
    const [oid, gen] = queue.shift()!;
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      wanted.add(oid);
      queue.push([parseTag(obj.data).object, gen]);
      continue;
    }
    if (obj.type !== 'commit') { wanted.add(oid); continue; }
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    addCommitClosure(oid, wanted);
    if (depth === null || gen < depth) {
      const meta = commitMeta.get(oid);
      if (meta) for (const p of meta.parents) queue.push([p, gen + 1]);
    }
  }
  const oids = new Set<string>();
  for (const o of wanted) if (!held.has(o)) oids.add(o);
  // The client's commits after the fetch are wanted ∪ held; a commit is a
  // shallow boundary when one of its parents is not in that set.
  const allCommits = new Set<string>();
  for (const o of wanted) if (objects.get(o)?.type === 'commit') allCommits.add(o);
  for (const o of held) if (objects.get(o)?.type === 'commit') allCommits.add(o);
  const shallow: string[] = [];
  for (const c of allCommits) {
    const meta = commitMeta.get(c);
    if (meta && meta.parents.some((p) => !allCommits.has(p))) shallow.push(c);
  }
  shallow.sort();
  const shallowNow = new Set(shallow);
  const unshallow = incomingShallow.filter((s) => !shallowNow.has(s)).sort();
  return { oids, shallow, unshallow };
}

export function handleFetch(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const args: string[] = [];
  for (const p of packets) if (p.kind === 'data' && p.payload) args.push(p.payload.toString('utf8').replace(/\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallows.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7).trim(), 10) || null;
  }
  const cacheKey = `${wants.join(',')}|${haves.join(',')}|${depth ?? ''}|${shallows.join(',')}`;
  let plan = repo.packCache.get(cacheKey);
  let pack: Buffer;
  if (plan) {
    pack = plan.pack;
  } else {
    const p = planFetch(wants, haves, depth, shallows);
    const objs: GitObj[] = [];
    const sorted = [...p.oids].sort();
    for (const oid of sorted) {
      const obj = objects.get(oid);
      if (obj) objs.push(obj);
    }
    pack = writePack(objs);
    plan = { pack, shallow: p.shallow, unshallow: p.unshallow };
    repo.packCache.set(cacheKey, plan);
  }
  const parts: Buffer[] = [];
  // acknowledgments — every fetch answer opens with this section.
  const ackLines: string[] = [];
  if (haves.length === 0) {
    ackLines.push('NAK');
  } else {
    let allHeld = true;
    for (const h of haves) {
      if (objects.has(h)) ackLines.push(`ACK ${h}`);
      else allHeld = false;
    }
    if (allHeld && haves.length > 0) ackLines.push('ready');
  }
  parts.push(pkt('acknowledgments\n'));
  parts.push(Buffer.concat(ackLines.map((l) => pkt(l + '\n'))));
  parts.push(FLUSH);
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: string[] = [];
    for (const s of plan.shallow) lines.push(`shallow ${s}`);
    for (const s of plan.unshallow) lines.push(`unshallow ${s}`);
    parts.push(pkt('shallow-info\n'));
    parts.push(Buffer.concat(lines.map((l) => pkt(l + '\n'))));
    parts.push(FLUSH);
  }
  // wanted-refs
  const wantSet = new Set(wants);
  const refLines: string[] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (head && wantSet.has(head)) refLines.push(`${head} HEAD`);
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of refs) if (wantSet.has(oid)) refLines.push(`${oid} ${name}`);
  if (refLines.length > 0) {
    parts.push(pkt('wanted-refs\n'));
    parts.push(Buffer.concat(refLines.map((l) => pkt(l + '\n'))));
    parts.push(FLUSH);
  }
  // packfile — omitted entirely when the client already has everything.
  // An empty pack is exactly 32 bytes (12 header + 20 trailer); a pack with
  // objects is longer.
  if (plan.pack.length > 32) {
    parts.push(pkt('packfile\n'));
    parts.push(sideband(1, plan.pack));
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Receive-pack (push).
// ---------------------------------------------------------------------------

export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, consumed } = decodePktLines(body);
  const commands: Array<{ old: string; new: string; ref: string }> = [];
  let packBuf = Buffer.alloc(0);
  let seenFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') { seenFlush = true; break; }
    if (p.kind === 'data' && p.payload) {
      let line = p.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul); // capabilities on the first line
      const parts = line.split(' ');
      if (parts.length === 3) commands.push({ old: parts[0], new: parts[1], ref: parts[2] });
    }
  }
  if (seenFlush && consumed < body.length) packBuf = body.subarray(consumed);
  // Store the pack's objects (only after it parses cleanly).
  let unpackError: string | null = null;
  if (packBuf.length > 0) {
    try {
      const objs = readPack(packBuf);
      for (const [oid, obj] of objs) {
        if (!objects.has(oid)) objects.set(oid, obj);
        if (obj.type === 'commit') commitMeta.set(oid, parseCommit(obj.data));
      }
    } catch (e) {
      unpackError = e instanceof Error ? e.message : String(e);
    }
  }
  const report: string[] = [];
  if (unpackError) {
    report.push(`unpack ${unpackError}`);
    for (const c of commands) report.push(`ng ${c.ref} unpacker error`);
  } else {
    report.push('unpack ok');
    let changed = false;
    for (const c of commands) {
      const current = repo.refs.get(c.ref);
      if (c.new === ZERO) {
        // delete
        if (c.old !== ZERO && current !== c.old) {
          report.push(`ng ${c.ref} old value mismatch`);
          continue;
        }
        if (current !== undefined) { repo.refs.delete(c.ref); changed = true; }
        report.push(`ok ${c.ref}`);
        continue;
      }
      const obj = objects.get(c.new);
      if (!obj) { report.push(`ng ${c.ref} object not found`); continue; }
      if (c.old === ZERO) {
        if (current !== undefined) { report.push(`ng ${c.ref} already exists`); continue; }
        repo.refs.set(c.ref, c.new);
        changed = true;
        report.push(`ok ${c.ref}`);
        continue;
      }
      if (current !== c.old) { report.push(`ng ${c.ref} old value mismatch`); continue; }
      if (c.new === c.old) { report.push(`ok ${c.ref}`); continue; }
      if (c.ref.startsWith('refs/heads/') && obj.type !== 'commit') {
        report.push(`ng ${c.ref} not a commit`);
        continue;
      }
      if (c.ref.startsWith('refs/heads/') && !isAncestor(c.old, c.new)) {
        report.push(`ng ${c.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(c.ref, c.new);
      changed = true;
      report.push(`ok ${c.ref}`);
    }
    if (changed) invalidateRepoGit(repo);
  }
  const reportStream = Buffer.concat([...report.map((l) => pkt(l + '\n')), FLUSH]);
  return Buffer.concat([sideband(1, reportStream), FLUSH]);
}
