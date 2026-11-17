// graphql.ts — a small GraphQL parser + executor for the 18 fixed documents
// the suite sends (gh CLI shapes: viewer, repository, issues, pulls, node,
// __type introspection, and the five mutations). Stdlib only.
//
// The parser is a recursive-descent reader over a tiny lexer; the executor
// resolves fields through a per-type resolver table over wrapped values
// ({ __type, ... }). Unknown fields produce an HTTP 200 response with an
// `errors` array naming the field, per the suite's contract.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, decodeGlobalId, globalId, isoAt } from './store.ts';
import { buildCommit, flattenTree, mergeBase, storeObject } from './git.ts';
import { isRecord, jsonReply, messageReply, parseJsonBody, readBody } from './http-util.ts';
import { commentJson, refreshIssueJson, refreshPullJson, refreshRepoJson, threeWayMerge } from './rest.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'eof' };

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1]!;
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else out += e;
          j += 2;
        } else {
          out += src[j]!;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(src[j]!)) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(src[j]!)) j += 1;
      }
      const text = src.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser (AST)

export type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}
export interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
}
export interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}
export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface VariableDef {
  name: string;
  defaultValue: ValueNode | null;
}
export interface OperationNode {
  kind: 'Operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: VariableDef[];
  selections: SelectionNode[];
}
export interface FragmentNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}
export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${JSON.stringify(t)}`);
  }
  private acceptPunct(v: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === v) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ kind: 'Operation', operation: 'query', name: null, variables: [], selections: this.parseSelections() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const op = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value as string;
        const variables: VariableDef[] = [];
        if (this.acceptPunct('(')) {
          while (!this.acceptPunct(')')) {
            this.expectPunct('$');
            const vname = this.expectName();
            this.expectPunct(':');
            this.parseType();
            let def: ValueNode | null = null;
            if (this.acceptPunct('=')) def = this.parseValue();
            variables.push({ name: vname, defaultValue: def });
          }
        }
        operations.push({ kind: 'Operation', operation: op, name, variables, selections: this.parseSelections() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment');
        const typeCondition = this.expectName();
        fragments.set(name, { kind: 'Fragment', name, typeCondition, selections: this.parseSelections() });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(t)}`);
      }
    }
    return { operations, fragments };
  }

  /** Read a type expression (e.g. String!, [IssueState!]) and discard it. */
  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      out.push(this.parseSelection());
    }
    return out;
  }

  private parseSelection(): SelectionNode {
    if (this.acceptPunct('...')) {
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'InlineFragment', typeCondition, selections: this.parseSelections() };
      }
      if (t.kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'FragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'InlineFragment', typeCondition: null, selections: this.parseSelections() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelections();
    return { kind: 'Field', alias, name, args, selections };
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'Variable', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'String', value: t.value };
    if (t.kind === 'int') return { kind: 'Int', value: t.value };
    if (t.kind === 'float') return { kind: 'Float', value: t.value };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'List', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'Object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'Boolean', value: true };
      if (t.value === 'false') return { kind: 'Boolean', value: false };
      if (t.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: t.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

// ---------------------------------------------------------------- values

type Wrapped = { __type: string; [k: string]: unknown };

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'String':
    case 'Enum':
      return node.value;
    case 'Int':
    case 'Float':
      return node.value;
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'List':
      return node.values.map((v) => valueOf(v, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const a = field.args.find((x) => x.name === name);
  return a === undefined ? undefined : valueOf(a.value, variables);
}

// ---------------------------------------------------------------- schema (for __type)

const SCHEMA_TYPES: Record<string, { fields: string[]; enumValues: string[] | null }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body'], enumValues: null },
  PullRequest: {
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
    enumValues: null,
  },
  Repository: {
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
      'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    ],
    enumValues: null,
  },
  SearchType: {
    fields: [],
    enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'LABEL', 'TOPIC'],
  },
};

// ---------------------------------------------------------------- execution

class FieldError extends Error {}

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function wrapIssue(repo: Repo, issue: Issue): Wrapped {
  return { __type: 'Issue', repo, issue };
}
function wrapPull(repo: Repo, pull: Pull): Wrapped {
  return { __type: 'PullRequest', repo, pull };
}
function wrapRepo(repo: Repo): Wrapped {
  return { __type: 'Repository', repo };
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}
function cursorAfter(after: unknown): number {
  if (typeof after !== 'string') return 0;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return 0;
    const n = Number(text.slice(7));
    return Number.isInteger(n) ? n : 0;
  } catch {
    return 0;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(store: Store, repo: Repo, pull: Pull): string {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
  const mb = mergeBase(repo, headSha, baseSha);
  const merged = threeWayMerge(repo, baseSha, headSha, mb);
  return merged.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function pullFiles(repo: Repo, pull: Pull, first: number): Array<{ path: string }> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mb = mergeBase(repo, headSha, baseSha);
  const baseFlat = flattenTree(repo, mb === null ? null : (repo.commitTree.get(mb) ?? null));
  const headFlat = flattenTree(repo, repo.commitTree.get(headSha) ?? null);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const out: Array<{ path: string }> = [];
  for (const p of [...paths].sort()) {
    const b = baseFlat.get(p);
    const h = headFlat.get(p);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    out.push({ path: p });
    if (out.length >= first) break;
  }
  return out;
}

function resolveRepoByGlobalId(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const dec = decodeGlobalId(id);
  if (dec === null || dec.kind !== 'R' || dec.parts.length < 2) return null;
  const repo = store.getRepo(dec.parts[0]!, dec.parts[1]!);
  return repo ?? null;
}

function resolveIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const dec = decodeGlobalId(id);
  if (dec === null || dec.kind !== 'I' || dec.parts.length < 3) return null;
  const repo = store.getRepo(dec.parts[0]!, dec.parts[1]!);
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(dec.parts[2]));
  return issue === undefined ? null : { repo, issue };
}

function resolvePullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const dec = decodeGlobalId(id);
  if (dec === null || dec.kind !== 'PR' || dec.parts.length < 3) return null;
  const repo = store.getRepo(dec.parts[0]!, dec.parts[1]!);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number(dec.parts[2]));
  return pull === undefined ? null : { repo, pull };
}

/** Resolve one field; returns the raw value (wrapped object, scalar, or null). */
function resolveField(ctx: ExecCtx, parent: Wrapped, field: FieldNode): unknown {
  const type = parent.__type;
  const name = field.name;
  const store = ctx.store;

  if (name === '__typename') return type;

  if (type === 'Query') {
    if (name === 'viewer') return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
    if (name === 'repository') {
      const owner = argValue(field, 'owner', ctx.variables);
      const repoName = argValue(field, 'name', ctx.variables);
      if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
      const repo = store.getRepo(owner, repoName);
      return repo === undefined ? null : wrapRepo(repo);
    }
    if (name === 'node') {
      const id = argValue(field, 'id', ctx.variables);
      if (typeof id !== 'string') return null;
      const dec = decodeGlobalId(id);
      if (dec === null) return null;
      if (dec.kind === 'R') {
        const repo = resolveRepoByGlobalId(store, id);
        return repo === null ? null : { __type: 'Node', id, target: wrapRepo(repo) };
      }
      if (dec.kind === 'I') {
        const found = resolveIssueByGlobalId(store, id);
        return found === null ? null : { __type: 'Node', id, target: wrapIssue(found.repo, found.issue) };
      }
      if (dec.kind === 'PR') {
        const found = resolvePullByGlobalId(store, id);
        return found === null ? null : { __type: 'Node', id, target: wrapPull(found.repo, found.pull) };
      }
      return null;
    }
    if (name === '__type') {
      const typeName = argValue(field, 'name', ctx.variables);
      if (typeof typeName !== 'string') return null;
      const def = SCHEMA_TYPES[typeName];
      if (def === undefined) return null;
      return { __type: '__Type', name: typeName, fields: def.fields, enumValues: def.enumValues };
    }
    throw new FieldError(`Cannot query field "${name}" on type "Query".`);
  }

  if (type === 'Mutation') {
    if (name === 'createIssue') return mutateCreateIssue(ctx, field);
    if (name === 'closeIssue') return mutateCloseIssue(ctx, field);
    if (name === 'createPullRequest') return mutateCreatePullRequest(ctx, field);
    if (name === 'mergePullRequest') return mutateMergePullRequest(ctx, field);
    if (name === 'addComment') return mutateAddComment(ctx, field);
    throw new FieldError(`Cannot query field "${name}" on type "Mutation".`);
  }

  if (type === 'User') {
    if (name === 'login') return parent.login as string;
    if (name === 'id') return globalId('R', parent.login as string);
    throw new FieldError(`Cannot query field "${name}" on type "User".`);
  }

  if (type === 'Repository') {
    const repo = parent.repo as Repo;
    switch (name) {
      case 'id':
        return globalId('R', repo.owner, repo.name);
      case 'databaseId':
        return repo.dbId;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { __type: 'User', login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1002 };
      case 'defaultBranchRef':
        return { __type: 'BranchRef', name: repo.defaultBranch };
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const n = argValue(field, 'number', ctx.variables);
        if (typeof n !== 'number') return null;
        const issue = repo.issues.get(n);
        return issue === undefined ? null : wrapIssue(repo, issue);
      }
      case 'issues': {
        const first = argValue(field, 'first', ctx.variables);
        const states = argValue(field, 'states', ctx.variables);
        const orderBy = argValue(field, 'orderBy', ctx.variables);
        const after = argValue(field, 'after', ctx.variables);
        let list = [...repo.issues.values()];
        if (Array.isArray(states) && states.length > 0) {
          const want = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => want.has(i.state));
        }
        let desc = false;
        if (isRecord(orderBy)) {
          desc = String(orderBy.direction ?? '').toUpperCase() === 'DESC';
        }
        list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
        const afterN = cursorAfter(after);
        if (afterN > 0) list = list.filter((i) => (desc ? i.number < afterN : i.number > afterN));
        const limit = typeof first === 'number' && first >= 0 ? first : list.length;
        const page = list.slice(0, limit);
        const hasNextPage = list.length > page.length;
        return {
          __type: 'IssueConnection',
          repo,
          items: page,
          hasNextPage,
          endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
        };
      }
      case 'pullRequests': {
        const first = argValue(field, 'first', ctx.variables);
        let list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        const limit = typeof first === 'number' && first >= 0 ? first : list.length;
        list = list.slice(0, limit);
        return { __type: 'PullRequestConnection', repo, items: list };
      }
      case 'pullRequest': {
        const n = argValue(field, 'number', ctx.variables);
        if (typeof n !== 'number') return null;
        const pull = repo.pulls.get(n);
        return pull === undefined ? null : wrapPull(repo, pull);
      }
      default:
        throw new FieldError(`Cannot query field "${name}" on type "Repository".`);
    }
  }

  if (type === 'Issue') {
    const issue = parent.issue as Issue;
    switch (name) {
      case 'id':
        return globalId('I', (parent.repo as Repo).owner, (parent.repo as Repo).name, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueState(issue);
      case 'body':
        return issue.body;
      default:
        throw new FieldError(`Cannot query field "${name}" on type "Issue".`);
    }
  }

  if (type === 'PullRequest') {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    switch (name) {
      case 'id':
        return globalId('PR', repo.owner, repo.name, pull.number);
      case 'number':
        return pull.number;
      case 'state':
        return pullState(pull);
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return pullMergeable(ctx.store, repo, pull);
      case 'files': {
        const first = argValue(field, 'first', ctx.variables);
        const limit = typeof first === 'number' && first >= 0 ? first : 100;
        return { __type: 'FileConnection', items: pullFiles(repo, pull, limit) };
      }
      default:
        throw new FieldError(`Cannot query field "${name}" on type "PullRequest".`);
    }
  }

  if (type === 'IssueConnection') {
    if (name === 'nodes') return (parent.items as Issue[]).map((i) => wrapIssue(parent.repo as Repo, i));
    if (name === 'pageInfo') {
      return { __type: 'PageInfo', hasNextPage: parent.hasNextPage as boolean, endCursor: parent.endCursor as string | null };
    }
    if (name === 'totalCount') return (parent.items as Issue[]).length;
    throw new FieldError(`Cannot query field "${name}" on type "IssueConnection".`);
  }

  if (type === 'PullRequestConnection') {
    if (name === 'nodes') return (parent.items as Pull[]).map((p) => wrapPull(parent.repo as Repo, p));
    if (name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: false, endCursor: null };
    if (name === 'totalCount') return (parent.items as Pull[]).length;
    throw new FieldError(`Cannot query field "${name}" on type "PullRequestConnection".`);
  }

  if (type === 'FileConnection') {
    if (name === 'nodes') return (parent.items as Array<{ path: string }>).map((f) => ({ __type: 'File', path: f.path }));
    if (name === 'totalCount') return (parent.items as Array<{ path: string }>).length;
    throw new FieldError(`Cannot query field "${name}" on type "FileConnection".`);
  }

  if (type === 'File') {
    if (name === 'path') return parent.path as string;
    throw new FieldError(`Cannot query field "${name}" on type "File".`);
  }

  if (type === 'PageInfo') {
    if (name === 'hasNextPage') return parent.hasNextPage as boolean;
    if (name === 'endCursor') return parent.endCursor as string | null;
    throw new FieldError(`Cannot query field "${name}" on type "PageInfo".`);
  }

  if (type === 'BranchRef') {
    if (name === 'name') return parent.name as string;
    throw new FieldError(`Cannot query field "${name}" on type "BranchRef".`);
  }

  if (type === '__Type') {
    if (name === 'name') return parent.name as string;
    if (name === 'fields') {
      const fields = parent.fields as string[];
      return fields.map((f) => ({ __type: '__Field', name: f }));
    }
    if (name === 'enumValues') {
      const values = parent.enumValues as string[] | null;
      return values === null ? null : values.map((v) => ({ __type: '__EnumValue', name: v }));
    }
    throw new FieldError(`Cannot query field "${name}" on type "__Type".`);
  }

  if (type === '__Field' || type === '__EnumValue') {
    if (name === 'name') return parent.name as string;
    throw new FieldError(`Cannot query field "${name}" on type "${type}".`);
  }

  if (type === 'Node') {
    if (name === 'id') return parent.id as string;
    throw new FieldError(`Cannot query field "${name}" on type "Node".`);
  }

  if (type === 'Comment') {
    const comment = parent.comment as { dbId: number; body: string };
    if (name === 'id') {
      const issue = parent.issue as Issue;
      const repo = parent.repo as Repo;
      return globalId('C', repo.owner, repo.name, issue.number, comment.dbId);
    }
    if (name === 'body') return comment.body;
    throw new FieldError(`Cannot query field "${name}" on type "Comment".`);
  }

  if (type === 'CommentEdge') {
    if (name === 'node') return parent.node as Wrapped;
    throw new FieldError(`Cannot query field "${name}" on type "CommentEdge".`);
  }

  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (name === 'issue') return parent.issue as Wrapped;
    throw new FieldError(`Cannot query field "${name}" on type "${type}".`);
  }

  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return parent.pullRequest as Wrapped;
    throw new FieldError(`Cannot query field "${name}" on type "${type}".`);
  }

  if (type === 'AddCommentPayload') {
    if (name === 'commentEdge') return parent.commentEdge as Wrapped;
    throw new FieldError(`Cannot query field "${name}" on type "AddCommentPayload".`);
  }

  throw new FieldError(`Cannot query field "${name}" on type "${type}".`);
}

// ---------------------------------------------------------------- mutations

function mutateCreateIssue(ctx: ExecCtx, field: FieldNode): Wrapped | null {
  const input = argValue(field, 'input', ctx.variables);
  if (!isRecord(input)) return null;
  const repo = resolveRepoByGlobalId(ctx.store, input.repositoryId);
  if (repo === null) return null;
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') return null;
  const dbId = ++ctx.store.issueSeq;
  const number = ++repo.issueSeq;
  const now = isoAt(dbId);
  const issue: Issue = {
    dbId,
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
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
  return { __type: 'CreateIssuePayload', issue: wrapIssue(repo, issue) };
}

function mutateCloseIssue(ctx: ExecCtx, field: FieldNode): Wrapped | null {
  const input = argValue(field, 'input', ctx.variables);
  if (!isRecord(input)) return null;
  const found = resolveIssueByGlobalId(ctx.store, input.issueId);
  if (found === null) return null;
  found.issue.state = 'closed';
  found.issue.closedAt = isoAt(found.issue.dbId);
  found.issue.updatedAt = isoAt(found.issue.dbId);
  refreshIssueJson(found.repo, found.issue);
  refreshRepoJson(found.repo);
  return { __type: 'CloseIssuePayload', issue: wrapIssue(found.repo, found.issue) };
}

function mutateCreatePullRequest(ctx: ExecCtx, field: FieldNode): Wrapped | null {
  const input = argValue(field, 'input', ctx.variables);
  if (!isRecord(input)) return null;
  const repo = resolveRepoByGlobalId(ctx.store, input.repositoryId);
  if (repo === null) return null;
  const head = typeof input.headRefName === 'string' ? input.headRefName : '';
  const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const title = typeof input.title === 'string' ? input.title : '';
  if (head === '' || base === '' || title === '') return null;
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const dbId = ++ctx.store.pullSeq;
  const number = ++repo.pullSeq;
  const now = isoAt(dbId);
  const pull: Pull = {
    dbId,
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
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
  return { __type: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, pull) };
}

function mutateMergePullRequest(ctx: ExecCtx, field: FieldNode): Wrapped | null {
  const input = argValue(field, 'input', ctx.variables);
  if (!isRecord(input)) return null;
  const found = resolvePullByGlobalId(ctx.store, input.pullRequestId);
  if (found === null) return null;
  const { repo, pull } = found;
  if (pull.merged || pull.state === 'closed') return { __type: 'MergePullRequestPayload', pullRequest: wrapPull(repo, pull) };
  const method = String(input.mergeMethod ?? 'SQUASH').toUpperCase();
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mb = mergeBase(repo, headSha, baseSha);
  const merged = threeWayMerge(repo, baseSha, headSha, mb);
  if (merged.conflict) {
    ctx.errors.push({ message: 'Merge conflict' });
    return { __type: 'MergePullRequestPayload', pullRequest: wrapPull(repo, pull) };
  }
  const parents = method === 'MERGE' ? [baseSha, headSha] : [baseSha];
  const message = method === 'MERGE' ? `Merge pull request #${pull.number} from ${pull.headRef}` : pull.title;
  const commitBuf = buildCommit(merged.treeOid, parents, VIEWER_NAME, VIEWER_EMAIL, 1739175597 + ctx.store.commitCounter, message);
  const commitOid = storeObject(repo, 'commit', commitBuf);
  ctx.store.commitCounter += 1;
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
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
  return { __type: 'MergePullRequestPayload', pullRequest: wrapPull(repo, pull) };
}

function mutateAddComment(ctx: ExecCtx, field: FieldNode): Wrapped | null {
  const input = argValue(field, 'input', ctx.variables);
  if (!isRecord(input)) return null;
  const found = resolveIssueByGlobalId(ctx.store, input.subjectId);
  if (found === null) return null;
  const { repo, issue } = found;
  const dbId = ++ctx.store.commentSeq;
  const now = isoAt(dbId);
  const comment = {
    dbId,
    id: dbId,
    body: typeof input.body === 'string' ? input.body : '',
    userLogin: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    json: '',
  };
  comment.json = commentJson(repo, issue, comment);
  issue.comments.push(comment);
  refreshIssueJson(repo, issue);
  const node: Wrapped = { __type: 'Comment', repo, issue, comment };
  return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node } };
}

// ---------------------------------------------------------------- selection execution

function executeSelections(ctx: ExecCtx, parent: Wrapped, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      const key = sel.alias ?? sel.name;
      let value: unknown;
      try {
        value = resolveField(ctx, parent, sel);
      } catch (e) {
        if (e instanceof FieldError) {
          ctx.errors.push({ message: e.message });
          out[key] = null;
          continue;
        }
        throw e;
      }
      out[key] = executeValue(ctx, value, sel.selections);
    } else if (sel.kind === 'FragmentSpread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".` });
        continue;
      }
      if (frag.typeCondition !== parent.__type && !(parent.__type === 'Node' && frag.typeCondition === (parent.target as Wrapped)?.__type)) {
        continue;
      }
      const target = parent.__type === 'Node' ? (parent.target as Wrapped) : parent;
      Object.assign(out, executeSelections(ctx, target, frag.selections));
    } else {
      // Inline fragment.
      if (sel.typeCondition !== null) {
        const targetType = parent.__type === 'Node' ? ((parent.target as Wrapped)?.__type ?? '') : parent.__type;
        if (sel.typeCondition !== targetType) continue;
      }
      const target = parent.__type === 'Node' ? (parent.target as Wrapped) : parent;
      Object.assign(out, executeSelections(ctx, target, sel.selections));
    }
  }
  return out;
}

function executeValue(ctx: ExecCtx, value: unknown, selections: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (selections === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object' && '__type' in (item as Record<string, unknown>)) {
        return executeSelections(ctx, item as Wrapped, selections);
      }
      return item;
    });
  }
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    return executeSelections(ctx, value as Wrapped, selections);
  }
  return value;
}

function executeOperation(store: Store, doc: DocumentNode, operationName: string | undefined, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  let op: OperationNode | undefined;
  if (operationName !== undefined) {
    op = doc.operations.find((o) => o.name === operationName);
  } else {
    op = doc.operations[0];
  }
  if (op === undefined) return { data: null, errors: [{ message: 'Unknown operation.' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const v of op.variables) {
    if (!(v.name in vars) && v.defaultValue !== null) vars[v.name] = valueOf(v.defaultValue, vars);
  }
  const ctx: ExecCtx = { store, variables: vars, fragments: doc.fragments, errors: [] };
  const root: Wrapped = { __type: op.operation === 'mutation' ? 'Mutation' : 'Query' };
  let data: Record<string, unknown>;
  try {
    data = executeSelections(ctx, root, op.selections);
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// ---------------------------------------------------------------- HTTP handler

function executeOne(store: Store, body: unknown): unknown {
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { errors: [{ message: 'A query string is required.' }] };
  }
  let doc: DocumentNode;
  try {
    doc = new Parser(lex(body.query)).parseDocument();
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  return executeOperation(store, doc, operationName, variables);
}

export async function handleGraphql(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  reqId: string,
): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readBody(req, 10 * 1024 * 1024);
  } catch {
    messageReply(res, 413, 'Request Entity Too Large', reqId);
    return;
  }
  let body: unknown;
  try {
    body = parseJsonBody(raw);
  } catch {
    jsonReply(res, 400, JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] }), reqId);
    return;
  }
  const result = Array.isArray(body) ? body.map((item) => executeOne(store, item)) : executeOne(store, body);
  jsonReply(res, 200, JSON.stringify(result), reqId);
}
