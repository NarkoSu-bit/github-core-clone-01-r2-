// store.ts — in-memory state for the GitHub-compatible git forge.
//
// Deterministic by design: no wall clock, no Math.random in stored state.
// Every timestamp derives from a fixed epoch plus a monotonic counter, so
// two runs against the same sequence of requests leave identical state.

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const TEAMMATE_LOGIN = 'quinnkeller';
export const STRANGER_LOGIN = 'olgabauer';

/** 2025-02-10T08:19:57Z — the deterministic epoch base for all timestamps. */
export const BASE_TS = 1739175597;

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Git object types as packfile type codes. */
export type ObjType = 1 | 2 | 3 | 4; // commit, tree, blob, tag
export const TYPE_NAMES: Record<ObjType, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const TYPE_CODES: Record<string, ObjType> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface GitObj {
  t: ObjType;
  b: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  dbId: number;
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  /** Precomputed REST JSON string (zero stringify on read). */
  json: string;
}

export interface Issue {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  /** Precomputed REST JSON string (zero stringify on read). */
  json: string;
}

export interface Pull {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  /** Precomputed REST JSON string (zero stringify on read). */
  json: string;
}

export interface Repo {
  dbId: number;
  name: string;
  owner: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** oid -> raw object. */
  objects: Map<string, GitObj>;
  /** refname -> oid. */
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  issueSeq: number;
  pulls: Map<number, Pull>;
  pullSeq: number;
  labels: Map<string, Label>;
  labelSeq: number;
  commentSeq: number;
  /** oid -> parsed tree entries (parsed once, reused by every fetch). */
  treeCache: Map<string, TreeEntry[]>;
  /** commit oid -> parent oids (parsed once at store time). */
  commitParents: Map<string, string[]>;
  /** commit oid -> tree oid (parsed once at store time). */
  commitTree: Map<string, string>;
  /** commit oid -> creation sequence (topological order for commit listing). */
  commitSeq: Map<string, number>;
  /** Cached v0 upload-pack advertisement; invalidated when refs change. */
  advCache: string | null;
  advVersion: number;
  refsVersion: number;
  /** (tipOid + '|' + depth) -> built depth-1 pack Buffer (clone fast path). */
  packCache: Map<string, Buffer>;
  /** Precomputed REST repo JSON string (zero stringify on read). */
  json: string;
}

/** Deterministic ISO timestamp: base epoch + `seq` seconds. */
export function isoAt(seq: number): string {
  return new Date((BASE_TS + seq) * 1000).toISOString();
}

export function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/** Opaque global id: base64 of a type-prefixed string (never the plain database id). */
export function globalId(kind: 'R' | 'I' | 'PR' | 'C', ...parts: (string | number)[]): string {
  return b64(`${kind}:${parts.join('/')}`);
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const i = text.indexOf(':');
    if (i < 1) return null;
    return { kind: text.slice(0, i), parts: text.slice(i + 1).split('/') };
  } catch {
    return null;
  }
}

/** The six default labels, with GitHub's canonical colors. */
export const DEFAULT_LABELS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'enhancement', color: 'a2eeef' },
  { name: 'documentation', color: '0075ca' },
  { name: 'question', color: 'd876e3' },
  { name: 'good first issue', color: '7057ff' },
  { name: 'help wanted', color: '008672' },
];

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export class Store {
  repos = new Map<string, Repo>();
  repoById = new Map<number, Repo>();
  repoSeq = 0;
  issueSeq = 0;
  pullSeq = 0;
  commentSeq = 0;
  labelSeq = 0;
  /** Monotonic counter for X-GitHub-Request-Id. */
  reqSeq = 0;
  /** Monotonic counter for commit creation order. */
  commitCounter = 0;

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, priv: boolean): Repo | null {
    if (this.repos.has(repoKey(owner, name))) return null;
    const dbId = ++this.repoSeq;
    const now = isoAt(0);
    const repo: Repo = {
      dbId,
      name,
      owner,
      description,
      priv,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      issueSeq: 0,
      pulls: new Map(),
      pullSeq: 0,
      labels: new Map(),
      labelSeq: 0,
      commentSeq: 0,
      treeCache: new Map(),
      commitParents: new Map(),
      commitTree: new Map(),
      commitSeq: new Map(),
      advCache: null,
      advVersion: 0,
      refsVersion: 0,
      packCache: new Map(),
      json: '',
    };
    this.repos.set(repoKey(owner, name), repo);
    this.repoById.set(dbId, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(repoKey(owner, name));
    if (!repo) return false;
    this.repos.delete(repoKey(owner, name));
    this.repoById.delete(repo.dbId);
    return true;
  }

  /** Bump after any ref change: invalidates the cached advertisement and packs. */
  touchRefs(repo: Repo): void {
    repo.refsVersion += 1;
    repo.advCache = null;
    repo.packCache.clear();
  }

  nextReqId(): string {
    return String(++this.reqSeq);
  }
}
