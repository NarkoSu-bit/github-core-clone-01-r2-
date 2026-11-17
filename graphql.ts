// graphql.ts — a small GraphQL executor for the subset the checks use: queries
// and mutations over repositories, issues, pull requests, nodes and the
// __type introspection, plus operation batching (a JSON array of documents in
// one body). Written from the GraphQL query language itself; no dependency.

import {
  repos, repoById, parseGqlId, gqlId, filesOfCommit, diffFiles,
  hasConflict, makeCommit, treeFromFiles, invalidateRepoGit, findMergeBase,
  commitMeta, allocIssueId, allocPullId,
  VIEWER, FIXED_DATE,
  type Repo, type Issue, type Pull,
} from './store.ts';
import { sendJson, type Ctx } from './http-util.ts';

// ---------------------------------------------------------------------------
// Lexer.
// ---------------------------------------------------------------------------

type TokKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
interface Token { kind: TokKind; value: string }

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === '[' || c === ']' || c === ':' || c === '!' || c === '$' || c === '=' || c === '@' || c === '|') {
      tokens.push({ kind: 'punct', value: c }); i++; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === '"') out += '"';
          else if (e === '\\') out += '\\';
          else if (e === '/') out += '/';
          else if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += e;
          j += 2;
        } else { out += src[j]; j++; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.') { isFloat = true; j++; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true; j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent over the token list).
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

type TypeNode =
  | { kind: 'named'; name: string }
  | { kind: 'list'; of: TypeNode }
  | { kind: 'nonnull'; of: TypeNode };

interface FieldNode { alias: string | null; name: string; args: Array<{ name: string; value: ValueNode }>; sel: SelectionSet | null }
interface FragmentNode { name: string | null; typeCondition: string | null; sel: SelectionSet }
type Selection = { kind: 'field'; field: FieldNode } | { kind: 'fragment'; frag: FragmentNode };
interface SelectionSet { sels: Selection[] }
interface VarDef { name: string; type: TypeNode; defaultVal: ValueNode | null }
interface Operation { type: 'query' | 'mutation'; name: string | null; vars: VarDef[]; sel: SelectionSet }
interface FragmentDef { name: string; typeCondition: string; sel: SelectionSet }

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private next(): Token { return this.tokens[this.pos++]; }
  private atPunct(v: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === v;
  }
  private eatPunct(v: string): boolean {
    if (this.atPunct(v)) { this.pos++; return true; }
    return false;
  }
  private expectPunct(v: string): void {
    if (!this.eatPunct(v)) throw new Error(`expected '${v}', got '${this.peek().value}'`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got '${t.value}'`);
    return t.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'name' && this.peek().value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        const sel = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, sel });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    let vars: VarDef[] = [];
    const t = this.peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      type = t.value as 'query' | 'mutation';
      this.next();
      if (this.peek().kind === 'name') name = this.expectName();
    }
    if (this.atPunct('(')) vars = this.parseVariableDefinitions();
    const sel = this.parseSelectionSet();
    return { type, name, vars, sel };
  }

  private parseVariableDefinitions(): VarDef[] {
    const out: VarDef[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultVal: ValueNode | null = null;
      if (this.eatPunct('=')) defaultVal = this.parseValue();
      out.push({ name, type, defaultVal });
    }
    this.expectPunct(')');
    return out;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.atPunct('[')) {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', of: inner };
    } else {
      type = { kind: 'named', name: this.expectName() };
    }
    if (this.eatPunct('!')) type = { kind: 'nonnull', of: type };
    return type;
  }

  private parseSelectionSet(): SelectionSet {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return { sels };
  }

  private parseSelection(): Selection {
    if (this.atPunct('...')) {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value !== 'on') {
        return { kind: 'fragment', frag: { name: this.expectName(), typeCondition: null, sel: { sels: [] } } };
      }
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const sel = this.parseSelectionSet();
      return { kind: 'fragment', frag: { name: null, typeCondition, sel } };
    }
    return { kind: 'field', field: this.parseField() };
  }

  private parseField(): FieldNode {
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.eatPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let sel: SelectionSet | null = null;
    if (this.atPunct('{')) sel = this.parseSelectionSet();
    return { alias, name, args, sel };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token '${t.value}'`);
  }
}

// ---------------------------------------------------------------------------
// Values: the objects the resolvers return. Every object carries __typename.
// ---------------------------------------------------------------------------

type GqlValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

function userObj(login: string, id: number, name?: string): GqlValue {
  return {
    __typename: 'User',
    login,
    id: Buffer.from(`User:${id}:0`, 'utf8').toString('base64url'),
    name: name ?? login,
    email: `${login}@example.invalid`,
  };
}

function viewerObj(): GqlValue {
  return userObj(VIEWER.login, VIEWER.id, VIEWER.name);
}

function repoObj(repo: Repo): GqlValue {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', repo, pull };
}

function commitObj(oid: string, message: string): GqlValue {
  return { __typename: 'Commit', oid, message };
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function indexOfCursor(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : -1;
  } catch {
    return -1;
  }
}

/** A connection (nodes + pageInfo) over a pre-sorted list. */
function connection(typeName: string, items: GqlValue[], args: Record<string, unknown>): GqlValue {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const after = indexOfCursor(typeof args.after === 'string' ? args.after : null);
  const start = after + 1;
  const page = items.slice(start, start + first);
  const endIndex = start + page.length - 1;
  return {
    __typename: typeName,
    nodes: page,
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorOf(start) : null,
      endCursor: page.length > 0 ? cursorOf(endIndex) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Introspection: the type table the checks query.
// ---------------------------------------------------------------------------

const TYPE_TABLE: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closed', 'author', 'labels', 'comments'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    enumValues: [],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'], enumValues: [] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount', 'pageInfo'], enumValues: [] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount', 'pageInfo'], enumValues: [] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'], enumValues: [] },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE', 'COMMIT', 'CODE', 'PACKAGE', 'PROJECT'],
  },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
};

function typeObj(name: string): GqlValue {
  const t = TYPE_TABLE[name];
  if (!t) return null;
  return {
    __typename: '__Type',
    name,
    kind: t.kind,
    fields: t.fields.map((f) => ({ __typename: '__Field', name: f })),
    enumValues: t.enumValues.map((v) => ({ __typename: '__EnumValue', name: v })),
  };
}

// ---------------------------------------------------------------------------
// Executor.
// ---------------------------------------------------------------------------

interface ExecState {
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDef>;
}

function evalValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var': return vars[node.name] ?? null;
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'bool': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.items.map((i) => evalValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, vars);
      return out;
    }
  }
}

function argsOf(field: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = evalValue(a.value, vars);
  return out;
}

function resolveField(typeName: string, value: GqlValue, field: FieldNode, st: ExecState): GqlValue {
  const args = argsOf(field, st.vars);
  const v = value as Record<string, unknown>;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return viewerObj();
      if (field.name === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = repos.get(`${owner}/${name}`);
        return repo ? repoObj(repo) : null;
      }
      if (field.name === 'node') {
        const id = typeof args.id === 'string' ? args.id : '';
        const parsed = parseGqlId(id);
        if (!parsed) return null;
        const repo = repoById(parsed.repoId);
        if (!repo) return null;
        if (parsed.kind === 'Repository') return repoObj(repo);
        if (parsed.kind === 'Issue') {
          const issue = repo.issues.find((i) => i.number === parsed.n);
          return issue ? issueObj(repo, issue) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const pull = repo.pulls.find((p) => p.number === parsed.n);
          return pull ? pullObj(repo, pull) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = typeof args.name === 'string' ? args.name : '';
        return typeObj(name);
      }
      if (field.name === '__schema') {
        return {
          __typename: '__Schema',
          queryType: { __typename: '__Type', name: 'Query' },
          mutationType: { __typename: '__Type', name: 'Mutation' },
          types: Object.keys(TYPE_TABLE).map((n) => ({ __typename: '__Type', name: n })),
        };
      }
      break;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') return createIssuePayload(args);
      if (field.name === 'closeIssue') return closeIssuePayload(args);
      if (field.name === 'createPullRequest') return createPullPayload(args);
      if (field.name === 'mergePullRequest') return mergePullPayload(args);
      if (field.name === 'addComment') return addCommentPayload(args);
      break;
    }
    case 'Repository': {
      const repo = v.repo as Repo;
      if (field.name === 'id') return gqlId('Repository', repo.id, 0);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return userObj(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 0);
      if (field.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        const meta = commitMeta.get(tip);
        return {
          __typename: 'Ref',
          name: repo.defaultBranch,
          target: commitObj(tip, meta ? meta.message : ''),
        };
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const n = typeof args.number === 'number' ? args.number : -1;
        const issue = repo.issues.find((i) => i.number === n);
        return issue ? issueObj(repo, issue) : null;
      }
      if (field.name === 'issues') {
        let list = [...repo.issues];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy?.field === 'CREATED_AT' && orderBy.direction === 'DESC') list.sort((a, b) => b.number - a.number);
        else list.sort((a, b) => a.number - b.number);
        return connection('IssueConnection', list.map((i) => issueObj(repo, i)), args);
      }
      if (field.name === 'pullRequest') {
        const n = typeof args.number === 'number' ? args.number : -1;
        const pull = repo.pulls.find((p) => p.number === n);
        return pull ? pullObj(repo, pull) : null;
      }
      if (field.name === 'pullRequests') {
        const list = [...repo.pulls].sort((a, b) => a.number - b.number);
        return connection('PullRequestConnection', list.map((p) => pullObj(repo, p)), args);
      }
      break;
    }
    case 'Issue': {
      const repo = v.repo as Repo;
      const issue = v.issue as Issue;
      if (field.name === 'id') return gqlId('Issue', repo.id, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return issue.body;
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field.name === 'createdAt' || field.name === 'updatedAt') return FIXED_DATE;
      if (field.name === 'closed') return issue.state === 'closed';
      if (field.name === 'author') return viewerObj();
      if (field.name === 'labels') {
        return {
          __typename: 'LabelConnection',
          nodes: issue.labels.map((l) => ({ __typename: 'Label', name: l, color: repo.labels.get(l)?.color ?? 'ededed' })),
          totalCount: issue.labels.length,
        };
      }
      if (field.name === 'comments') {
        return {
          __typename: 'IssueCommentConnection',
          nodes: issue.comments.map((c) => ({
            __typename: 'IssueComment',
            id: gqlId('IssueComment', repo.id, c.id),
            body: c.body,
            author: viewerObj(),
          })),
          totalCount: issue.comments.length,
        };
      }
      break;
    }
    case 'PullRequest': {
      const repo = v.repo as Repo;
      const pull = v.pull as Pull;
      if (field.name === 'id') return gqlId('PullRequest', repo.id, pull.number);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'state') return pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return pull.body;
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'mergeable') {
        if (pull.merged) return 'UNKNOWN';
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        if (!baseTip || !headTip) return 'UNKNOWN';
        return hasConflict(filesOfCommit(pull.mergeBase), filesOfCommit(baseTip), filesOfCommit(headTip), pull.files)
          ? 'CONFLICTING'
          : 'MERGEABLE';
      }
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'headRefOid') return pull.headSha;
      if (field.name === 'baseRefOid') return pull.baseSha;
      if (field.name === 'files') {
        return connection(
          'PullRequestChangedFileConnection',
          pull.files.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename })),
          args,
        );
      }
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection':
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return (v.nodes as GqlValue[]) ?? [];
      if (field.name === 'totalCount') return (v.totalCount as number) ?? 0;
      if (field.name === 'pageInfo') return (v.pageInfo as GqlValue) ?? null;
      break;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return v.hasNextPage as boolean;
      if (field.name === 'hasPreviousPage') return v.hasPreviousPage as boolean;
      if (field.name === 'startCursor') return (v.startCursor as string | null) ?? null;
      if (field.name === 'endCursor') return (v.endCursor as string | null) ?? null;
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return v.name as string;
      if (field.name === 'target') return (v.target as GqlValue) ?? null;
      break;
    }
    case 'Commit': {
      if (field.name === 'oid') return v.oid as string;
      if (field.name === 'message') return (v.message as string) ?? '';
      break;
    }
    case 'User': {
      if (field.name === 'login') return v.login as string;
      if (field.name === 'id') return v.id as string;
      if (field.name === 'name') return v.name as string;
      if (field.name === 'email') return v.email as string;
      break;
    }
    case 'Label': {
      if (field.name === 'name') return v.name as string;
      if (field.name === 'color') return v.color as string;
      break;
    }
    case 'IssueComment': {
      if (field.name === 'id') return v.id as string;
      if (field.name === 'body') return v.body as string;
      if (field.name === 'author') return (v.author as GqlValue) ?? viewerObj();
      break;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return v.path as string;
      break;
    }
    case '__Type': {
      if (field.name === 'name') return v.name as string;
      if (field.name === 'kind') return v.kind as string;
      if (field.name === 'fields') return (v.fields as GqlValue[]) ?? [];
      if (field.name === 'enumValues') return (v.enumValues as GqlValue[]) ?? [];
      break;
    }
    case '__Field': {
      if (field.name === 'name') return v.name as string;
      break;
    }
    case '__EnumValue': {
      if (field.name === 'name') return v.name as string;
      break;
    }
    case '__Schema': {
      if (field.name === 'queryType') return (v.queryType as GqlValue) ?? null;
      if (field.name === 'mutationType') return (v.mutationType as GqlValue) ?? null;
      if (field.name === 'types') return (v.types as GqlValue[]) ?? [];
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return (v.issue as GqlValue) ?? null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return (v.pullRequest as GqlValue) ?? null;
      break;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return (v.commentEdge as GqlValue) ?? null;
      break;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return (v.node as GqlValue) ?? null;
      break;
    }
  }
  st.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
  return null;
}

function resolveValueWithSelection(value: GqlValue, sel: SelectionSet, st: ExecState): GqlValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const typeName = (item as Record<string, unknown>).__typename as string;
      return resolveSelectionSet(typeName, item, sel, st);
    });
  }
  const typeName = (value as Record<string, unknown>).__typename as string;
  if (!typeName) return value;
  return resolveSelectionSet(typeName, value, sel, st);
}

function resolveSelectionSet(typeName: string, value: GqlValue, sel: SelectionSet, st: ExecState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sel.sels) {
    if (s.kind === 'field') {
      const f = s.field;
      const key = f.alias ?? f.name;
      if (f.name === '__typename') { out[key] = typeName; continue; }
      const fieldValue = resolveField(typeName, value, f, st);
      out[key] = f.sel ? resolveValueWithSelection(fieldValue, f.sel, st) : fieldValue;
    } else {
      const frag = s.frag;
      if (frag.name) {
        const def = st.fragments.get(frag.name);
        if (!def) continue;
        if (def.typeCondition !== typeName) continue;
        Object.assign(out, resolveSelectionSet(typeName, value, def.sel, st));
      } else {
        if (frag.typeCondition && frag.typeCondition !== typeName) continue;
        Object.assign(out, resolveSelectionSet(typeName, value, frag.sel, st));
      }
    }
  }
  return out;
}

function executeOperation(op: Operation, variables: Record<string, unknown>, fragments: Map<string, FragmentDef>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const vars: Record<string, unknown> = {};
  for (const def of op.vars) {
    if (variables[def.name] !== undefined) vars[def.name] = variables[def.name];
    else if (def.defaultVal) vars[def.name] = evalValue(def.defaultVal, {});
    else vars[def.name] = null;
  }
  const st: ExecState = { vars, errors: [], fragments };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlValue = { __typename: rootType };
  const data = resolveSelectionSet(rootType, root, op.sel, st);
  if (st.errors.length > 0) return { data, errors: st.errors };
  return { data };
}

// ---------------------------------------------------------------------------
// Mutations (shared with the REST semantics).
// ---------------------------------------------------------------------------

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function createIssuePayload(args: Record<string, unknown>): GqlValue {
  const input = inputOf(args);
  const parsed = typeof input.repositoryId === 'string' ? parseGqlId(input.repositoryId) : null;
  const repo = parsed ? repoById(parsed.repoId) : null;
  const title = typeof input.title === 'string' ? input.title : '';
  if (!repo || title === '') return { __typename: 'CreateIssuePayload', issue: null };
  const issue: Issue = {
    id: allocIssueId(),
    number: repo.nextNumber++,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    comments: [],
    json: '',
    gqlId: '',
  };
  repo.issues.push(issue);
  return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
}

function closeIssuePayload(args: Record<string, unknown>): GqlValue {
  const input = inputOf(args);
  const parsed = typeof input.issueId === 'string' ? parseGqlId(input.issueId) : null;
  const repo = parsed ? repoById(parsed.repoId) : null;
  const issue = repo ? repo.issues.find((i) => i.number === parsed!.n) : undefined;
  if (!issue || !repo) return { __typename: 'CloseIssuePayload', issue: null };
  issue.state = 'closed';
  issue.json = '';
  return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue) };
}

function createPullPayload(args: Record<string, unknown>): GqlValue {
  const input = inputOf(args);
  const parsed = typeof input.repositoryId === 'string' ? parseGqlId(input.repositoryId) : null;
  const repo = parsed ? repoById(parsed.repoId) : null;
  const head = typeof input.headRefName === 'string' ? input.headRefName : '';
  const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const title = typeof input.title === 'string' ? input.title : '';
  if (!repo || head === '' || base === '') return { __typename: 'CreatePullRequestPayload', pullRequest: null };
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
  const mergeBase = findMergeBase(headSha, new Set([baseSha])) ?? baseSha;
  const files = diffFiles(filesOfCommit(mergeBase), filesOfCommit(headSha));
  const pull: Pull = {
    id: allocPullId(),
    number: repo.nextNumber++,
    title,
    body: typeof input.body === 'string' ? input.body : '',
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
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
}

function mergePullPayload(args: Record<string, unknown>): GqlValue {
  const input = inputOf(args);
  const parsed = typeof input.pullRequestId === 'string' ? parseGqlId(input.pullRequestId) : null;
  const repo = parsed ? repoById(parsed.repoId) : null;
  const pull = repo ? repo.pulls.find((p) => p.number === parsed!.n) : undefined;
  if (!pull || !repo) return { __typename: 'MergePullRequestPayload', pullRequest: null };
  if (pull.state === 'closed') return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
  if (hasConflict(filesOfCommit(pull.mergeBase), filesOfCommit(baseTip), filesOfCommit(headTip), pull.files)) {
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
  }
  const merged = new Map(filesOfCommit(baseTip));
  for (const f of pull.files) {
    const h = filesOfCommit(headTip).get(f.filename);
    if (h) merged.set(f.filename, h);
    else merged.delete(f.filename);
  }
  const treeOid = treeFromFiles(merged);
  const commitOid = makeCommit(treeOid, [baseTip], `Merge pull request #${pull.number} from ${pull.headRef}`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_DATE;
  pull.mergeSha = commitOid;
  pull.json = null;
  invalidateRepoGit(repo);
  return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
}

function addCommentPayload(args: Record<string, unknown>): GqlValue {
  const input = inputOf(args);
  const parsed = typeof input.subjectId === 'string' ? parseGqlId(input.subjectId) : null;
  const repo = parsed ? repoById(parsed.repoId) : null;
  const body = typeof input.body === 'string' ? input.body : '';
  if (!repo || parsed?.kind !== 'Issue') return { __typename: 'AddCommentPayload', commentEdge: null };
  const issue = repo.issues.find((i) => i.number === parsed.n);
  if (!issue) return { __typename: 'AddCommentPayload', commentEdge: null };
  const comment = { id: repo.nextCommentId++, body };
  issue.comments.push(comment);
  issue.json = '';
  return {
    __typename: 'AddCommentPayload',
    commentEdge: {
      __typename: 'IssueCommentEdge',
      node: {
        __typename: 'IssueComment',
        id: gqlId('IssueComment', repo.id, comment.id),
        body,
        author: viewerObj(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP handler.
// ---------------------------------------------------------------------------

export function handleGraphQL(ctx: Ctx): void {
  const auth = ctx.req.headers.authorization;
  if (!auth || auth.trim() === '') {
    sendJson(ctx, 401, { errors: [{ message: 'Unauthorized' }] });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
    return;
  }
  const runOne = (doc: unknown): { data: Record<string, unknown>; errors?: Array<{ message: string }> } => {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { data: {}, errors: [{ message: 'Must provide query string.' }] };
    }
    const query = (doc as Record<string, unknown>).query;
    const variables = (doc as Record<string, unknown>).variables;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: {}, errors: [{ message: 'Must provide query string.' }] };
    }
    let parsed;
    try {
      parsed = new Parser(tokenize(query)).parseDocument();
    } catch (e) {
      return { data: {}, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
    const vars = variables && typeof variables === 'object' && !Array.isArray(variables)
      ? (variables as Record<string, unknown>)
      : {};
    const opName = typeof (doc as Record<string, unknown>).operationName === 'string'
      ? ((doc as Record<string, unknown>).operationName as string)
      : null;
    let op = parsed.operations[0];
    if (opName) {
      const named = parsed.operations.find((o) => o.name === opName);
      if (named) op = named;
    }
    if (!op) return { data: {}, errors: [{ message: 'Must provide an operation.' }] };
    return executeOperation(op, vars, parsed.fragments);
  };
  if (Array.isArray(body)) {
    sendJson(ctx, 200, body.map((doc) => runOne(doc)));
    return;
  }
  sendJson(ctx, 200, runOne(body));
}
