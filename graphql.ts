// graphql.ts — A small GraphQL executor for the fixed documents the make.fun suite sends:
// viewer / repository / node / __type, issues + pullRequests connections, create/close issue,
// create/merge pull request. Unknown fields produce HTTP 200 with an errors array naming them.

import { type Store, type Repo, type Issue, type Pull } from './store.ts';
import { mergePullRequest as mergePullRequestImpl } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// lexer + parser (subset: operations, inline fragments, variables, literals, input objects)
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === ':' || ch === '!' || ch === '$' || ch === '=' || ch === '@' || ch === '[' || ch === ']') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === '"') value += '"';
          else if (esc === '\\') value += '\\';
          else if (esc === '/') value += '/';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
          continue;
        }
        value += source[j];
        j += 1;
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number.parseFloat(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

interface VarDef {
  name: string;
  defaultValue?: unknown;
}

interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selectionSet: Selection[] | null;
}

interface FragmentSel {
  kind: 'fragment';
  typeCondition: string | null;
  selectionSet: Selection[];
}

type Selection = FieldSel | FragmentSel;

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: VarDef[];
  selectionSet: Selection[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected name');
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    const token = this.peek();
    let type: Operation['type'] = 'query';
    let name: string | null = null;
    if (token.kind === 'punct' && token.value === '{') {
      return { type: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      type = token.value as Operation['type'];
      this.next();
      const next = this.peek();
      if (next.kind === 'name') name = this.next().value as string;
    }
    const variableDefinitions = this.parseVariableDefinitions();
    // skip directives if any
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    return { type, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): VarDef[] {
    const defs: VarDef[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: unknown;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        defs.push({ name, defaultValue });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseType(): void {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      this.parseType();
      this.expectPunct(']');
    } else if (token.kind !== 'name') {
      throw new Error('expected type');
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      let typeCondition: string | null = null;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      // fragment spread name (unsupported) or inline fragment without condition
      if (typeCondition === null && this.peek().kind === 'name') {
        throw new Error('named fragment spreads are not supported');
      }
      // skip directives
      while (this.peek().kind === 'punct' && this.peek().value === '@') {
        this.next();
        this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
      }
      return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    const nameOrAlias = this.expectName();
    let alias: string | null = null;
    let name = nameOrAlias;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = nameOrAlias;
      name = this.expectName();
    }
    let args: Record<string, unknown> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    // skip directives
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    let selectionSet: Selection[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { __var: this.expectName() };
    }
    if (token.kind === 'int' || token.kind === 'float' || token.kind === 'string') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) list.push(this.parseValue());
      this.expectPunct(']');
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error('unexpected value');
  }
}

function resolveVariables(value: unknown, variables: Record<string, unknown>, defaults: Map<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveVariables(v, variables, defaults));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('__var' in record && typeof record.__var === 'string') {
      const name = record.__var;
      if (name in variables) return variables[name];
      if (defaults.has(name)) return defaults.get(name);
      return undefined;
    }
    if ('__enum' in record && typeof record.__enum === 'string') return record.__enum;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(record)) out[key] = resolveVariables(v, variables, defaults);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// schema + resolvers
// ---------------------------------------------------------------------------------------------

interface GqlCtx {
  store: Store;
  errors: { message: string }[];
}

interface FieldDef {
  type: string;
  resolve: (parent: any, args: Record<string, unknown>, ctx: GqlCtx) => unknown;
}

interface TypeDef {
  fields: Record<string, FieldDef>;
}

function scalar(type: string, resolve: FieldDef['resolve']): FieldDef {
  return { type, resolve };
}

function prop(type: string, key: string): FieldDef {
  return { type, resolve: (parent) => parent?.[key] ?? null };
}

interface Connection<T> {
  nodes: T[];
  edges: { node: T; cursor: string }[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
}

function makeConnection<T>(items: T[], first: number, after: string | undefined): Connection<T> {
  let start = 0;
  if (after) {
    const match = /^cursor:(\d+)$/.exec(after);
    if (match) start = Number.parseInt(match[1], 10) + 1;
  }
  const page = items.slice(start, start + first);
  const edges = page.map((node, i) => ({ node, cursor: `cursor:${start + i}` }));
  return {
    nodes: page,
    edges,
    pageInfo: {
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    },
    totalCount: items.length,
  };
}

function sortedIssues(repo: Repo, orderBy: any, states: string[] | undefined): Issue[] {
  let issues = [...repo.issues];
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const field = orderBy?.field ?? 'CREATED_AT';
  const direction = orderBy?.direction ?? 'DESC';
  if (field === 'CREATED_AT') {
    issues.sort((a, b) => {
      const cmp = a.createdSeq - b.createdSeq;
      return direction === 'ASC' ? cmp : -cmp;
    });
    // ties by number DESC (numbers increase with creation, so DESC matches for CREATED_AT)
    if (direction === 'DESC') issues.sort((a, b) => b.number - a.number);
  }
  return issues;
}

function sortedPulls(repo: Repo, orderBy: any, states: string[] | undefined): Pull[] {
  let pulls = [...repo.pulls];
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    pulls = pulls.filter((p) => wanted.has(p.state));
  }
  const field = orderBy?.field ?? 'CREATED_AT';
  const direction = orderBy?.direction ?? 'DESC';
  if (field === 'CREATED_AT') {
    pulls.sort((a, b) => {
      const cmp = a.createdSeq - b.createdSeq;
      return direction === 'ASC' ? cmp : -cmp;
    });
    if (direction === 'DESC') pulls.sort((a, b) => b.number - a.number);
  }
  return pulls;
}

function fileDiff(repo: Repo, pull: Pull): { path: string; additions: number; deletions: number; changeType: string }[] {
  const baseTree = repo.treeOf(pull.baseSha);
  const headTree = repo.treeOf(pull.headSha);
  const diff = repo.diffTrees(baseTree, headTree);
  return diff.map((change) => {
    let additions = 0;
    let deletions = 0;
    const countLines = (text: string): number => (text === '' ? 0 : text.split('\n').length);
    if (change.status === 'added') {
      const blob = change.newOid ? repo.lookup(change.newOid) : undefined;
      additions = blob ? countLines(blob.data.toString('utf8')) : 0;
    } else if (change.status === 'removed') {
      const blob = change.oldOid ? repo.lookup(change.oldOid) : undefined;
      deletions = blob ? countLines(blob.data.toString('utf8')) : 0;
    } else {
      const oldBlob = change.oldOid ? repo.lookup(change.oldOid) : undefined;
      const newBlob = change.newOid ? repo.lookup(change.newOid) : undefined;
      const oldLines = oldBlob ? oldBlob.data.toString('utf8').split('\n') : [];
      const newLines = newBlob ? newBlob.data.toString('utf8').split('\n') : [];
      const oldSet = new Set(oldLines);
      const newSet = new Set(newLines);
      additions = newLines.filter((l) => !oldSet.has(l)).length;
      deletions = oldLines.filter((l) => !newSet.has(l)).length;
    }
    return {
      path: change.path,
      additions,
      deletions,
      changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
    };
  });
}

/** Decode an opaque id key of the form owner/name, owner/name:number, or owner/name:a:b. */
function parseKey(key: string): { owner: string; name: string; rest: string[] } | null {
  const colon = key.indexOf(':');
  const ownerName = colon < 0 ? key : key.slice(0, colon);
  const rest = colon < 0 ? [] : key.slice(colon + 1).split(':');
  const slash = ownerName.indexOf('/');
  if (slash < 0) return null;
  return { owner: ownerName.slice(0, slash), name: ownerName.slice(slash + 1), rest };
}

function repoByGraphId(store: Store, id: string): Repo | null {
  const decoded = store.decodeId(String(id));
  if (!decoded || decoded.kind !== 'R') return null;
  const parsed = parseKey(decoded.key);
  if (!parsed) return null;
  return store.getRepo(parsed.owner, parsed.name) ?? null;
}

function issueByGraphId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = store.decodeId(String(id));
  if (!decoded || decoded.kind !== 'I') return null;
  const parsed = parseKey(decoded.key);
  if (!parsed || parsed.rest.length < 1) return null;
  const repo = store.getRepo(parsed.owner, parsed.name);
  if (!repo) return null;
  const issue = repo.issues.find((i) => i.number === Number.parseInt(parsed.rest[0], 10));
  return issue ? { repo, issue } : null;
}

function pullByGraphId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = store.decodeId(String(id));
  if (!decoded || decoded.kind !== 'PR') return null;
  const parsed = parseKey(decoded.key);
  if (!parsed || parsed.rest.length < 1) return null;
  const repo = store.getRepo(parsed.owner, parsed.name);
  if (!repo) return null;
  const pull = repo.pulls.find((p) => p.number === Number.parseInt(parsed.rest[0], 10));
  return pull ? { repo, pull } : null;
}

function withTypename<T extends object>(value: T, typename: string): T {
  return Object.assign(value, { __typename: typename });
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    fields: {
      viewer: scalar('User', (_p, _a, ctx) => withTypename(ctx.store.viewer, 'User')),
      repository: scalar('Repository', (_p, args, ctx) => {
        const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? withTypename(repo, 'Repository') : null;
      }),
      node: scalar('Node', (_p, args, ctx) => {
        const decoded = ctx.store.decodeId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'R') {
          const [owner, name] = decoded.key.split('/');
          const repo = ctx.store.getRepo(owner, name);
          return repo ? withTypename(repo, 'Repository') : null;
        }
        if (decoded.kind === 'I') {
          const found = issueByGraphId(ctx.store, String(args.id));
          return found ? withTypename(found.issue, 'Issue') : null;
        }
        if (decoded.kind === 'PR') {
          const found = pullByGraphId(ctx.store, String(args.id));
          return found ? withTypename(found.pull, 'PullRequest') : null;
        }
        if (decoded.kind === 'U') {
          const user = ctx.store.users.get(decoded.key);
          return user ? withTypename(user, 'User') : null;
        }
        return null;
      }),
      __type: scalar('__Type', (_p, args, ctx) => {
        const name = String(args.name ?? '');
        const fields = introspectionFields(name);
        if (!fields) return null;
        return withTypename(
          {
            name,
            kind: name === 'SearchType' ? 'ENUM' : 'OBJECT',
            description: null,
            fields: fields.map((f) => ({ name: f, description: null })),
            enumValues:
              name === 'SearchType'
                ? ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE'].map((v) => ({ name: v, description: null }))
                : null,
          },
          '__Type',
        );
      }),
      createIssue: scalar('CreateIssuePayload', (_p, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGraphId(ctx.store, String(input.repositoryId ?? ''));
        if (!repo) throw new Error('repository not found');
        const now = ctx.store.nowIso();
        const issue: Issue = {
          id: ctx.store.nextIssueId,
          number: repo.nextIssue,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          comments: [],
          createdSeq: ctx.store.nextSeq(),
          createdAt: now,
          updatedAt: now,
        };
        ctx.store.nextIssueId += 1;
        repo.nextIssue += 1;
        repo.issues.push(issue);
        return withTypename({ issue: withTypename(issue, 'Issue'), clientMutationId: (input.clientMutationId as string) ?? null }, 'CreateIssuePayload');
      }),
      closeIssue: scalar('CloseIssuePayload', (_p, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGraphId(ctx.store, String(input.issueId ?? ''));
        if (!found) throw new Error('issue not found');
        found.issue.state = 'closed';
        found.issue.updatedAt = ctx.store.nowIso();
        found.issue.jsonCache = null;
        return withTypename({ issue: withTypename(found.issue, 'Issue'), clientMutationId: (input.clientMutationId as string) ?? null }, 'CloseIssuePayload');
      }),
      createPullRequest: scalar('CreatePullRequestPayload', (_p, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGraphId(ctx.store, String(input.repositoryId ?? ''));
        if (!repo) throw new Error('repository not found');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = repo.branchTip(head);
        const baseSha = repo.branchTip(base);
        if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
        const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (existing) {
          return withTypename({ pullRequest: withTypename(existing, 'PullRequest'), clientMutationId: (input.clientMutationId as string) ?? null }, 'CreatePullRequestPayload');
        }
        const now = ctx.store.nowIso();
        const pull: Pull = {
          id: ctx.store.nextPullId,
          number: repo.nextPull,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          headRef: head,
          headSha,
          baseRef: base,
          baseSha,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          createdSeq: ctx.store.nextSeq(),
          createdAt: now,
          updatedAt: now,
        };
        ctx.store.nextPullId += 1;
        repo.nextPull += 1;
        repo.pulls.push(pull);
        return withTypename({ pullRequest: withTypename(pull, 'PullRequest'), clientMutationId: (input.clientMutationId as string) ?? null }, 'CreatePullRequestPayload');
      }),
      mergePullRequest: scalar('MergePullRequestPayload', (_p, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullByGraphId(ctx.store, String(input.pullRequestId ?? ''));
        if (!found) throw new Error('pull request not found');
        const result = mergePullRequestImpl(ctx.store, found.repo, found.pull);
        if (!result.ok) throw new Error(result.message);
        return withTypename({ pullRequest: withTypename(found.pull, 'PullRequest'), clientMutationId: (input.clientMutationId as string) ?? null }, 'MergePullRequestPayload');
      }),
      addComment: scalar('AddCommentPayload', (_p, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const subjectId = String(input.subjectId ?? '');
        const found = issueByGraphId(ctx.store, subjectId);
        if (!found) throw new Error('subject not found');
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = { id: ctx.store.nextCommentId, body, createdAt: ctx.store.nowIso() };
        ctx.store.nextCommentId += 1;
        found.issue.comments.push(comment);
        found.issue.jsonCache = null;
        const node = withTypename(
          { id: ctx.store.commentGraphId(found.repo, found.issue, comment), body },
          'IssueComment',
        );
        return withTypename(
          {
            commentEdge: withTypename({ node, cursor: `cursor:${comment.id}` }, 'IssueCommentEdge'),
            clientMutationId: (input.clientMutationId as string) ?? null,
          },
          'AddCommentPayload',
        );
      }),
    },
  },
  User: {
    fields: {
      login: prop('String', 'login'),
      id: scalar('ID', (parent, _a, ctx) => ctx.store.userGraphId(parent)),
      name: prop('String', 'name'),
      email: prop('String', 'email'),
    },
  },
  Repository: {
    fields: {
      id: scalar('ID', (parent, _a, ctx) => ctx.store.repoGraphId(parent as Repo)),
      databaseId: scalar('Int', (parent) => (parent as Repo).id),
      name: prop('String', 'name'),
      nameWithOwner: scalar('String', (parent) => (parent as Repo).fullName),
      description: prop('String', 'description'),
      isPrivate: prop('Boolean', 'isPrivate'),
      owner: scalar('User', (parent, _a, ctx) => withTypename(ctx.store.users.get((parent as Repo).owner) ?? ctx.store.viewer, 'User')),
      defaultBranchRef: scalar('Ref', (parent) => ({ __typename: 'Ref', name: (parent as Repo).defaultBranch })),
      viewerPermission: scalar('String', () => 'ADMIN'),
      hasIssuesEnabled: scalar('Boolean', () => true),
      issue: scalar('Issue', (parent, args) => {
        const repo = parent as Repo;
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        return issue ? withTypename(issue, 'Issue') : null;
      }),
      issues: scalar('IssueConnection', (parent, args) => {
        const repo = parent as Repo;
        const items = sortedIssues(repo, args.orderBy, args.states as string[] | undefined);
        return withTypename(makeConnection(items.map((i) => withTypename(i, 'Issue')), Number(args.first ?? 100), args.after as string | undefined), 'IssueConnection');
      }),
      pullRequests: scalar('PullRequestConnection', (parent, args) => {
        const repo = parent as Repo;
        const items = sortedPulls(repo, args.orderBy, args.states as string[] | undefined);
        return withTypename(makeConnection(items.map((p) => withTypename(p, 'PullRequest')), Number(args.first ?? 100), args.after as string | undefined), 'PullRequestConnection');
      }),
      pullRequest: scalar('PullRequest', (parent, args) => {
        const repo = parent as Repo;
        const pull = repo.pulls.find((p) => p.number === Number(args.number));
        return pull ? withTypename(pull, 'PullRequest') : null;
      }),
    },
  },
  Issue: {
    fields: {
      id: scalar('ID', (parent, _a, ctx) => {
        const issue = parent as Issue;
        // find the owning repo by scanning (issues are stored per repo)
        for (const repo of ctx.store.repos.values()) {
          if (repo.issues.includes(issue)) return ctx.store.issueGraphId(repo, issue);
        }
        return ctx.store.encodeId('I', `?:${issue.number}`);
      }),
      number: prop('Int', 'number'),
      title: prop('String', 'title'),
      state: scalar('String', (parent) => (parent as Issue).state.toUpperCase()),
      body: prop('String', 'body'),
      labels: scalar('[Label]', (parent, _a, ctx) => {
        const issue = parent as Issue;
        for (const repo of ctx.store.repos.values()) {
          if (repo.issues.includes(issue)) {
            return issue.labels.map((name) => withTypename(repo.labels.get(name) ?? { name, color: '000000', description: '' }, 'Label'));
          }
        }
        return [];
      }),
      createdAt: prop('String', 'createdAt'),
      updatedAt: prop('String', 'updatedAt'),
      author: scalar('User', (_p, _a, ctx) => withTypename(ctx.store.viewer, 'User')),
    },
  },
  PullRequest: {
    fields: {
      id: scalar('ID', (parent, _a, ctx) => {
        const pull = parent as Pull;
        for (const repo of ctx.store.repos.values()) {
          if (repo.pulls.includes(pull)) return ctx.store.pullGraphId(repo, pull);
        }
        return ctx.store.encodeId('PR', `?:${pull.number}`);
      }),
      number: prop('Int', 'number'),
      title: prop('String', 'title'),
      state: scalar('String', (parent) => (parent as Pull).state.toUpperCase()),
      body: prop('String', 'body'),
      headRefName: prop('String', 'headRef'),
      baseRefName: prop('String', 'baseRef'),
      headRefOid: prop('String', 'headSha'),
      baseRefOid: prop('String', 'baseSha'),
      mergeable: scalar('String', () => 'MERGEABLE'),
      merged: prop('Boolean', 'merged'),
      mergedAt: prop('String', 'mergedAt'),
      mergeCommitSha: prop('String', 'mergeCommitSha'),
      createdAt: prop('String', 'createdAt'),
      updatedAt: prop('String', 'updatedAt'),
      author: scalar('User', (_p, _a, ctx) => withTypename(ctx.store.viewer, 'User')),
      files: scalar('PullRequestChangedFileConnection', (parent, args, ctx) => {
        const pull = parent as Pull;
        let repo: Repo | undefined;
        for (const r of ctx.store.repos.values()) if (r.pulls.includes(pull)) repo = r;
        if (!repo) return withTypename(makeConnection([], 100, undefined), 'PullRequestChangedFileConnection');
        const files = fileDiff(repo, pull).map((f) => withTypename(f, 'PullRequestChangedFile'));
        return withTypename(makeConnection(files, Number(args.first ?? 100), args.after as string | undefined), 'PullRequestChangedFileConnection');
      }),
    },
  },
  Ref: {
    fields: {
      name: prop('String', 'name'),
      prefix: scalar('String', () => 'refs/heads/'),
    },
  },
  Label: {
    fields: {
      name: prop('String', 'name'),
      color: prop('String', 'color'),
      description: prop('String', 'description'),
    },
  },
  IssueConnection: {
    fields: {
      nodes: scalar('[Issue]', (parent) => (parent as Connection<unknown>).nodes),
      edges: scalar('[IssueEdge]', (parent) => (parent as Connection<unknown>).edges),
      totalCount: prop('Int', 'totalCount'),
      pageInfo: scalar('PageInfo', (parent) => withTypename((parent as Connection<unknown>).pageInfo, 'PageInfo')),
    },
  },
  PullRequestConnection: {
    fields: {
      nodes: scalar('[PullRequest]', (parent) => (parent as Connection<unknown>).nodes),
      edges: scalar('[PullRequestEdge]', (parent) => (parent as Connection<unknown>).edges),
      totalCount: prop('Int', 'totalCount'),
      pageInfo: scalar('PageInfo', (parent) => withTypename((parent as Connection<unknown>).pageInfo, 'PageInfo')),
    },
  },
  PullRequestChangedFileConnection: {
    fields: {
      nodes: scalar('[PullRequestChangedFile]', (parent) => (parent as Connection<unknown>).nodes),
      edges: scalar('[PullRequestChangedFileEdge]', (parent) => (parent as Connection<unknown>).edges),
      totalCount: prop('Int', 'totalCount'),
      pageInfo: scalar('PageInfo', (parent) => withTypename((parent as Connection<unknown>).pageInfo, 'PageInfo')),
    },
  },
  IssueEdge: {
    fields: {
      node: scalar('Issue', (parent) => (parent as { node: unknown }).node),
      cursor: prop('String', 'cursor'),
    },
  },
  PullRequestEdge: {
    fields: {
      node: scalar('PullRequest', (parent) => (parent as { node: unknown }).node),
      cursor: prop('String', 'cursor'),
    },
  },
  PullRequestChangedFileEdge: {
    fields: {
      node: scalar('PullRequestChangedFile', (parent) => (parent as { node: unknown }).node),
      cursor: prop('String', 'cursor'),
    },
  },
  PullRequestChangedFile: {
    fields: {
      path: prop('String', 'path'),
      additions: prop('Int', 'additions'),
      deletions: prop('Int', 'deletions'),
      changeType: prop('String', 'changeType'),
    },
  },
  PageInfo: {
    fields: {
      hasNextPage: prop('Boolean', 'hasNextPage'),
      hasPreviousPage: prop('Boolean', 'hasPreviousPage'),
      startCursor: prop('String', 'startCursor'),
      endCursor: prop('String', 'endCursor'),
    },
  },
  __Type: {
    fields: {
      name: prop('String', 'name'),
      kind: prop('String', 'kind'),
      description: prop('String', 'description'),
      fields: scalar('[__Field]', (parent) => (parent as { fields: unknown }).fields ?? []),
      enumValues: scalar('[__EnumValue]', (parent) => (parent as { enumValues: unknown }).enumValues ?? []),
    },
  },
  __Field: {
    fields: {
      name: prop('String', 'name'),
      description: prop('String', 'description'),
    },
  },
  __EnumValue: {
    fields: {
      name: prop('String', 'name'),
      description: prop('String', 'description'),
    },
  },
  CreateIssuePayload: {
    fields: {
      issue: scalar('Issue', (parent) => (parent as { issue: unknown }).issue),
      clientMutationId: prop('String', 'clientMutationId'),
    },
  },
  CloseIssuePayload: {
    fields: {
      issue: scalar('Issue', (parent) => (parent as { issue: unknown }).issue),
      clientMutationId: prop('String', 'clientMutationId'),
    },
  },
  CreatePullRequestPayload: {
    fields: {
      pullRequest: scalar('PullRequest', (parent) => (parent as { pullRequest: unknown }).pullRequest),
      clientMutationId: prop('String', 'clientMutationId'),
    },
  },
  MergePullRequestPayload: {
    fields: {
      pullRequest: scalar('PullRequest', (parent) => (parent as { pullRequest: unknown }).pullRequest),
      clientMutationId: prop('String', 'clientMutationId'),
    },
  },
  AddCommentPayload: {
    fields: {
      commentEdge: scalar('IssueCommentEdge', (parent) => (parent as { commentEdge: unknown }).commentEdge),
      clientMutationId: prop('String', 'clientMutationId'),
    },
  },
  IssueCommentEdge: {
    fields: {
      node: scalar('IssueComment', (parent) => (parent as { node: unknown }).node),
      cursor: prop('String', 'cursor'),
    },
  },
  IssueComment: {
    fields: {
      id: prop('String', 'id'),
      body: prop('String', 'body'),
    },
  },
  Node: {
    fields: {
      id: scalar('ID', (parent, _a, ctx) => {
        const value = parent as any;
        if (value.__typename === 'Repository') return ctx.store.repoGraphId(value as Repo);
        if (value.__typename === 'Issue') {
          for (const repo of ctx.store.repos.values()) if (repo.issues.includes(value as Issue)) return ctx.store.issueGraphId(repo, value as Issue);
        }
        if (value.__typename === 'PullRequest') {
          for (const repo of ctx.store.repos.values()) if (repo.pulls.includes(value as Pull)) return ctx.store.pullGraphId(repo, value as Pull);
        }
        if (value.__typename === 'User') return ctx.store.userGraphId(value);
        return null;
      }),
    },
  },
};

function introspectionFields(name: string): string[] | null {
  switch (name) {
    case 'Issue':
      return ['id', 'number', 'title', 'state', 'body', 'labels', 'createdAt', 'updatedAt', 'author'];
    case 'PullRequest':
      return ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'mergeCommitSha', 'files', 'createdAt', 'updatedAt', 'author'];
    case 'Repository':
      return ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
    case 'SearchType':
      return [];
    case 'User':
      return ['login', 'id', 'name', 'email'];
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

function runtimeType(parent: any, declaredType: string): string {
  if (parent && typeof parent === 'object' && typeof parent.__typename === 'string') return parent.__typename;
  return declaredType;
}

function projectValue(value: unknown, type: string, selectionSet: Selection[] | null, ctx: GqlCtx): unknown {
  if (value === null || value === undefined) return null;
  if (type.startsWith('[') && type.endsWith(']')) {
    const inner = type.slice(1, -1);
    if (!Array.isArray(value)) return null;
    return value.map((item) => projectValue(item, inner, selectionSet, ctx));
  }
  if (type === 'String' || type === 'Int' || type === 'Boolean' || type === 'ID' || type === 'Float') return value;
  if (!selectionSet) return value;
  const actualType = runtimeType(value, type);
  return executeSelectionSet(selectionSet, actualType, value, ctx);
}

function executeSelectionSet(selections: Selection[], parentType: string, parentValue: any, ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      const actual = runtimeType(parentValue, parentType);
      if (sel.typeCondition && sel.typeCondition !== actual) continue;
      Object.assign(out, executeSelectionSet(sel.selectionSet, actual, parentValue, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = runtimeType(parentValue, parentType);
      continue;
    }
    const typeDef = SCHEMA[parentType];
    const fieldDef = typeDef?.fields[sel.name];
    if (!fieldDef) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = fieldDef.resolve(parentValue, sel.args, ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : 'field resolution failed' });
      out[key] = null;
      continue;
    }
    out[key] = projectValue(value, fieldDef.type, sel.selectionSet, ctx);
  }
  return out;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

export function executeGraphQL(store: Store, queryText: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
  let operations: Operation[];
  try {
    operations = new Parser(queryText).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'syntax error' }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'empty document' }] };
  let operation = operations[0];
  if (operationName) {
    const found = operations.find((op) => op.name === operationName);
    if (found) operation = found;
  }
  const defaults = new Map<string, unknown>();
  for (const def of operation.variableDefinitions) if (def.defaultValue !== undefined) defaults.set(def.name, def.defaultValue);
  // resolve variables in the selection set arguments
  const resolveSelectionArgs = (selections: Selection[]): void => {
    for (const sel of selections) {
      if (sel.kind === 'fragment') {
        resolveSelectionArgs(sel.selectionSet);
      } else {
        const resolved: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(sel.args)) resolved[key] = resolveVariables(value, variables, defaults);
        sel.args = resolved;
        if (sel.selectionSet) resolveSelectionArgs(sel.selectionSet);
      }
    }
  };
  resolveSelectionArgs(operation.selectionSet);
  const ctx: GqlCtx = { store, errors: [] };
  const data = executeSelectionSet(operation.selectionSet, 'Query', { __typename: 'Query' }, ctx);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
