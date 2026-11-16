// graphql.ts: a small GraphQL executor for the documents gh and github-mcp-server
// send — viewer, repository reads, __type introspection, issue/pull connections
// with cursor pagination, node(id:), and the create/close/merge/comment mutations.
// Unknown fields answer HTTP 200 with an errors array naming the field; an unknown
// repository is data.repository = null with no errors; a JSON array body is a batch.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { BAD_JSON, isRecord, parseJsonBody, readBody, sendJson } from './http.ts';
import { Forge, type IssueRec, type PullRec, type Repo } from './store.ts';

// ------------------------------------------------------------------ global ids

function globalId(kind: string, parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0]!, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', [repo.databaseId]);
}

function issueGlobalId(repo: Repo, issue: IssueRec): string {
  return globalId('Issue', [repo.databaseId, issue.number]);
}

function pullGlobalId(repo: Repo, pull: PullRec): string {
  return globalId('PullRequest', [repo.databaseId, pull.number]);
}

function commentGlobalId(repo: Repo, issue: IssueRec, commentId: number): string {
  return globalId('Comment', [repo.databaseId, issue.number, commentId]);
}

// ------------------------------------------------------------------ schema surface

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'url', 'repository', 'baseRef', 'headRef', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'name', 'url'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  CommentEdge: ['node', 'cursor'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type', 'args'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

// ------------------------------------------------------------------ tokenizer / parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'spread' });
      index += 3;
      continue;
    }
    if ('{}()[]:$@=!'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') {
          const escaped = source[index + 1];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped ?? '';
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let text = '';
      while (index < source.length && /[0-9.]/.test(source[index]!)) {
        text += source[index];
        index += 1;
      }
      tokens.push({ kind: 'int', value: Number(text) });
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      let text = '';
      while (index < source.length && /[_0-9A-Za-z]/.test(source[index]!)) {
        text += source[index];
        index += 1;
      }
      tokens.push({ kind: 'name', value: text });
      continue;
    }
    index += 1;
  }
  return tokens;
}

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'enum'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, Value>;
  selection: FieldNode[] | null;
  fragmentType: string | null; // inline fragment marker rides on a pseudo-field
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  /** Parse the whole document: the operations' selection sets, in order. */
  parseDocument(): { operation: string; selection: FieldNode[] }[] {
    const operations: { operation: string; selection: FieldNode[] }[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = token.value;
        this.next();
        const nameToken = this.peek();
        if (nameToken !== undefined && nameToken.kind === 'name') this.next(); // operation name
        if (this.atPunct('(')) this.skipVariableDefinitions();
        operations.push({ operation, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are not sent by the suite; skip the definition.
        this.next();
        this.next();
        const onToken = this.next();
        if (onToken.kind === 'name' && onToken.value === 'on') this.next();
        this.parseSelectionSet();
        continue;
      }
      this.next();
    }
    return operations;
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.atPunct('}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        const onToken = this.next();
        if (onToken.kind === 'name' && onToken.value === 'on') {
          const typeToken = this.next();
          const typeName = typeToken.kind === 'name' ? typeToken.value : '';
          const inner = this.parseSelectionSet();
          fields.push({ name: '__inlineFragment', alias: null, args: new Map(), selection: inner, fragmentType: typeName });
        } else {
          // A named fragment spread: the suite does not send resolvable ones; keep its name as a marker.
          fields.push({ name: '__fragmentSpread', alias: null, args: new Map(), selection: null, fragmentType: onToken.kind === 'name' ? onToken.value : '' });
        }
        continue;
      }
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): FieldNode {
    const first = this.next();
    if (first.kind !== 'name') throw new Error('expected a field name');
    let name = first.value;
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      const second = this.next();
      if (second.kind !== 'name') throw new Error('expected a field name after the alias');
      name = second.value;
    }
    const args = new Map<string, Value>();
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.next();
        if (argName.kind !== 'name') throw new Error('expected an argument name');
        this.expectPunct(':');
        args.set(argName.value, this.parseValue());
      }
      this.expectPunct(')');
    }
    // Directives are not used by the suite's documents; skip any that appear.
    while (this.atPunct('@')) {
      this.next();
      this.next();
      if (this.atPunct('(')) this.skipVariableDefinitions();
    }
    const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { name, alias, args, selection, fragmentType: null };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected a variable name');
      return { kind: 'var', name: name.value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.atPunct('}')) {
        const key = this.next();
        if (key.kind !== 'name') throw new Error('expected an input field name');
        this.expectPunct(':');
        fields.set(key.value, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

/** Resolve a parsed Value against the operation's variables into plain JS data. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of value.fields) out[key] = resolveValue(field, variables);
      return out;
    }
  }
}

function argOf(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const value = field.args.get(name);
  return value === undefined ? undefined : resolveValue(value, variables);
}

// ------------------------------------------------------------------ execution

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

/** A resolved node in the result tree: a type name plus a bag of raw values. */
interface Node {
  type: string;
  values: Record<string, unknown>;
}

function executeSelection(ctx: Ctx, type: string, node: Node | null, selection: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    const key = field.alias ?? field.name;
    if (field.name === '__inlineFragment') {
      if (field.fragmentType === type || field.fragmentType === '' || field.fragmentType === null) {
        Object.assign(out, executeSelection(ctx, type, node, field.selection ?? []));
      }
      continue;
    }
    if (field.name === '__fragmentSpread') continue;
    const known = TYPE_FIELDS[type];
    if (known !== undefined && !known.includes(field.name) && type !== 'Query' && type !== 'Mutation') {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'` });
      continue;
    }
    out[key] = resolveField(ctx, type, node, field);
  }
  return out;
}

function child(ctx: Ctx, node: Node | null, field: FieldNode): unknown {
  if (node === null) return null;
  if (field.selection === null) return node.values[field.name] ?? null;
  const value = node.values[field.name];
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value;
  return value;
}

function resolveField(ctx: Ctx, type: string, node: Node | null, field: FieldNode): unknown {
  const { forge } = ctx;
  // Introspection works on every type context.
  if (field.name === '__type') {
    const name = String(argOf(field, 'name', ctx.variables) ?? '');
    return typeNode(ctx, name, field);
  }

  if (type === 'Query') {
    switch (field.name) {
      case 'viewer':
        return executeSelection(ctx, 'User', { type: 'User', values: { login: forge.viewerLogin(), id: globalId('User', [1]) } }, field.selection ?? []);
      case 'repository': {
        const owner = String(argOf(field, 'owner', ctx.variables) ?? '');
        const name = String(argOf(field, 'name', ctx.variables) ?? '');
        if (!forge.ownerMatches(owner)) return null;
        const repo = forge.getRepo(name);
        if (repo === undefined) return null;
        return executeSelection(ctx, 'Repository', repoNode(forge, repo), field.selection ?? []);
      }
      case 'node': {
        const id = String(argOf(field, 'id', ctx.variables) ?? '');
        const parsed = parseGlobalId(id);
        if (parsed?.kind === 'Repository') {
          const repo = forge.repoList().find((candidate) => candidate.databaseId === Number(parsed.parts[0]));
          if (repo === undefined) return null;
          return executeSelection(ctx, 'Repository', repoNode(forge, repo), field.selection ?? []);
        }
        return null;
      }
      default:
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Query'` });
        return null;
    }
  }

  if (type === 'Mutation') {
    return resolveMutation(ctx, field);
  }

  // Object fields: values were materialized by the node builders below; nested
  // nodes arrive as closures in `values` under a Node, handled by `expand`.
  return expand(ctx, node, field);
}

/** Expand one field of a materialized node: scalars pass through, Nodes recurse. */
function expand(ctx: Ctx, node: Node | null, field: FieldNode): unknown {
  if (node === null) return null;
  const value = node.values[field.name];
  if (value === undefined || value === null) return null;
  if (field.selection === null) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => (isNode(entry) ? executeSelection(ctx, entry.type, entry, field.selection ?? []) : entry));
  }
  if (isNode(value)) return executeSelection(ctx, value.type, value, field.selection ?? []);
  return value;
}

function isNode(value: unknown): value is Node {
  return isRecord(value) && typeof value.type === 'string' && isRecord(value.values);
}

function typeNode(ctx: Ctx, name: string, field: FieldNode): unknown {
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  const node: Node = {
    type: '__Type',
    values: {
      name,
      kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
      fields: (fields ?? []).map((fieldName) => ({ type: '__Field', values: { name: fieldName } }) as Node),
      enumValues: (enumValues ?? []).map((valueName) => ({ type: '__EnumValue', values: { name: valueName } }) as Node),
    },
  };
  return executeSelection(ctx, '__Type', node, field.selection ?? []);
}

// ------------------------------------------------------------------ node builders

function repoNode(forge: Forge, repo: Repo): Node {
  const owner = forge.viewerLogin();
  const defaultTip = forge.branchTip(repo, repo.defaultBranch);
  const values: Record<string, unknown> = {
    id: repoGlobalId(repo),
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${owner}/${repo.name}`,
    owner: { type: 'User', values: { login: owner, id: globalId('User', [1]) } } as Node,
    defaultBranchRef: defaultTip === null ? null : ({ type: 'Ref', values: { name: repo.defaultBranch, target: defaultTip } } as Node),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.isPrivate,
  };
  return { type: 'Repository', values: withRepoResolvers(forge, repo, values) };
}

/** Repository fields that need arguments (issue/issues/pullRequests/pullRequest) ride as thunks. */
function withRepoResolvers(forge: Forge, repo: Repo, values: Record<string, unknown>): Record<string, unknown> {
  // The executor resolves these in resolveRepoField; stash the repo for it.
  values.__repo = repo.name;
  return values;
}

function issueNode(forge: Forge, repo: Repo, issue: IssueRec): Node {
  return {
    type: 'Issue',
    values: {
      id: issueGlobalId(repo, issue),
      number: issue.number,
      title: issue.title,
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
      body: issue.body,
    },
  };
}

function pullNode(forge: Forge, repo: Repo, pull: PullRec): Node {
  return {
    type: 'PullRequest',
    values: {
      id: pullGlobalId(repo, pull),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
      merged: pull.merged,
      headRefName: pull.head,
      baseRefName: pull.base,
      mergeable: forge.pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
      __repo: repo.name,
      __pull: pull.number,
    },
  };
}

// ------------------------------------------------------------------ repository argument fields

function resolveRepoField(ctx: Ctx, repo: Repo, field: FieldNode): unknown {
  const { forge } = ctx;
  switch (field.name) {
    case 'issue': {
      const number = Number(argOf(field, 'number', ctx.variables));
      const item = repo.items.get(number);
      if (item === undefined || item.kind !== 'issue') return null;
      return executeSelection(ctx, 'Issue', issueNode(forge, repo, item), field.selection ?? []);
    }
    case 'issues': {
      return issuesConnection(ctx, repo, field);
    }
    case 'pullRequest': {
      const number = Number(argOf(field, 'number', ctx.variables));
      const item = repo.items.get(number);
      if (item === undefined || item.kind !== 'pull') return null;
      return executeSelectionWithRepo(ctx, 'PullRequest', pullNode(forge, repo, item), field.selection ?? []);
    }
    case 'pullRequests': {
      const first = Number(argOf(field, 'first', ctx.variables) ?? 100);
      const pulls = [...repo.items.values()]
        .filter((item): item is PullRec => item.kind === 'pull')
        .sort((a, b) => b.number - a.number)
        .slice(0, Number.isFinite(first) && first > 0 ? Math.trunc(first) : 100);
      const node: Node = {
        type: 'PullRequestConnection',
        values: { nodes: pulls.map((pull) => pullNode(forge, repo, pull)), totalCount: pulls.length },
      };
      return executeSelectionWithRepo(ctx, 'PullRequestConnection', node, field.selection ?? []);
    }
    default:
      return undefined;
  }
}

function issuesConnection(ctx: Ctx, repo: Repo, field: FieldNode): unknown {
  const { forge } = ctx;
  const firstRaw = Number(argOf(field, 'first', ctx.variables) ?? 100);
  const first = Number.isFinite(firstRaw) && firstRaw > 0 ? Math.trunc(firstRaw) : 100;
  const states = argOf(field, 'states', ctx.variables);
  const orderBy = argOf(field, 'orderBy', ctx.variables);
  const after = argOf(field, 'after', ctx.variables);
  let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
  if (Array.isArray(states) && states.length > 0) {
    const wanted = states.map((state) => String(state).toLowerCase());
    issues = issues.filter((issue) => wanted.includes(issue.state));
  }
  let direction = 'DESC';
  if (isRecord(orderBy) && typeof orderBy.direction === 'string') direction = orderBy.direction;
  issues.sort((a, b) => a.number - b.number);
  if (direction !== 'ASC') issues.reverse();
  let startIndex = 0;
  if (typeof after === 'string' && after !== '') {
    const parsed = parseGlobalId(after);
    if (parsed?.kind === 'Cursor') {
      const afterNumber = Number(parsed.parts[0]);
      const position = issues.findIndex((issue) => issue.number === afterNumber);
      if (position >= 0) startIndex = position + 1;
    }
  }
  const page = issues.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + first < issues.length;
  const last = page[page.length - 1];
  const node: Node = {
    type: 'IssueConnection',
    values: {
      nodes: page.map((issue) => issueNode(forge, repo, issue)),
      pageInfo: {
        type: 'PageInfo',
        values: {
          hasNextPage,
          hasPreviousPage: startIndex > 0,
          startCursor: page.length > 0 ? globalId('Cursor', [page[0]!.number]) : null,
          endCursor: last !== undefined ? globalId('Cursor', [last.number]) : null,
        },
      } as Node,
      totalCount: issues.length,
    },
  };
  return executeSelection(ctx, 'IssueConnection', node, field.selection ?? []);
}

// ------------------------------------------------------------------ mutations

function findRepoByGlobalId(forge: Forge, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed?.kind !== 'Repository') return null;
  return forge.repoList().find((repo) => repo.databaseId === Number(parsed.parts[0])) ?? null;
}

function resolveMutation(ctx: Ctx, field: FieldNode): unknown {
  const { forge } = ctx;
  const input = argOf(field, 'input', ctx.variables);
  const data: Record<string, unknown> = isRecord(input) ? input : {};
  switch (field.name) {
    case 'createIssue': {
      const repo = findRepoByGlobalId(forge, String(data.repositoryId ?? ''));
      if (repo === null) {
        ctx.errors.push({ message: 'createIssue: repository not found' });
        return null;
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        kind: 'issue',
        number,
        title: typeof data.title === 'string' ? data.title : '',
        body: typeof data.body === 'string' ? data.body : '',
        state: 'open',
        labels: [],
        comments: [],
        nextCommentId: 1,
      };
      repo.items.set(number, issue);
      forge.itemId(repo, number);
      const payload: Node = { type: 'CreateIssuePayload', values: { issue: issueNode(forge, repo, issue) } };
      return executeSelection(ctx, 'CreateIssuePayload', payload, field.selection ?? []);
    }
    case 'closeIssue': {
      const parsed = parseGlobalId(String(data.issueId ?? ''));
      const repo = parsed !== null ? forge.repoList().find((r) => r.databaseId === Number(parsed.parts[0])) : undefined;
      const item = repo?.items.get(Number(parsed?.parts[1]));
      if (repo === undefined || item === undefined || item.kind !== 'issue') {
        ctx.errors.push({ message: 'closeIssue: issue not found' });
        return null;
      }
      item.state = 'closed';
      const payload: Node = { type: 'CloseIssuePayload', values: { issue: issueNode(forge, repo, item) } };
      return executeSelection(ctx, 'CloseIssuePayload', payload, field.selection ?? []);
    }
    case 'createPullRequest': {
      const repo = findRepoByGlobalId(forge, String(data.repositoryId ?? ''));
      if (repo === null) {
        ctx.errors.push({ message: 'createPullRequest: repository not found' });
        return null;
      }
      const head = String(data.headRefName ?? '');
      const base = String(data.baseRefName ?? '');
      if (forge.branchTip(repo, head) === null || forge.branchTip(repo, base) === null) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
        return null;
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        kind: 'pull',
        number,
        title: typeof data.title === 'string' ? data.title : '',
        body: typeof data.body === 'string' ? data.body : '',
        head,
        base,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.items.set(number, pull);
      forge.itemId(repo, number);
      const payload: Node = { type: 'CreatePullRequestPayload', values: { pullRequest: pullNode(forge, repo, pull) } };
      return executeSelection(ctx, 'CreatePullRequestPayload', payload, field.selection ?? []);
    }
    case 'mergePullRequest': {
      const parsed = parseGlobalId(String(data.pullRequestId ?? ''));
      const repo = parsed !== null ? forge.repoList().find((r) => r.databaseId === Number(parsed.parts[0])) : undefined;
      const item = repo?.items.get(Number(parsed?.parts[1]));
      if (repo === undefined || item === undefined || item.kind !== 'pull') {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
        return null;
      }
      if (!item.merged) {
        const sha = forge.mergePull(repo, item);
        if (sha === null) {
          ctx.errors.push({ message: 'mergePullRequest: the pull request is not mergeable' });
          return null;
        }
      }
      const payload: Node = { type: 'MergePullRequestPayload', values: { pullRequest: pullNode(forge, repo, item) } };
      return executeSelection(ctx, 'MergePullRequestPayload', payload, field.selection ?? []);
    }
    case 'addComment': {
      const parsed = parseGlobalId(String(data.subjectId ?? ''));
      const repo = parsed !== null ? forge.repoList().find((r) => r.databaseId === Number(parsed.parts[0])) : undefined;
      const item = repo?.items.get(Number(parsed?.parts[1]));
      if (repo === undefined || item === undefined || item.kind !== 'issue') {
        ctx.errors.push({ message: 'addComment: subject not found' });
        return null;
      }
      const body = typeof data.body === 'string' ? data.body : '';
      const commentId = item.nextCommentId;
      item.nextCommentId += 1;
      item.comments.push({ id: commentId, body });
      const comment: Node = { type: 'Comment', values: { id: commentGlobalId(repo, item, commentId), body } };
      const edge: Node = { type: 'CommentEdge', values: { node: comment, cursor: globalId('Cursor', [commentId]) } };
      const payload: Node = { type: 'AddCommentPayload', values: { commentEdge: edge } };
      return executeSelection(ctx, 'AddCommentPayload', payload, field.selection ?? []);
    }
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'` });
      return null;
  }
}

// ------------------------------------------------------------------ document execution

function executeOperation(forge: Forge, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { forge, variables, errors: [] };
  let operations: { operation: string; selection: FieldNode[] }[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  // Repository argument-fields and PullRequest.files need bespoke resolution; the
  // generic walker handles the rest. We intercept by wrapping resolveField calls
  // through a dispatch that knows the parent node's stash.
  let data: Record<string, unknown> = {};
  for (const operation of operations) {
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    data = executeRoot(ctx, rootType, operation.selection);
  }
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Root execution with the Repository/PullRequest argument-field interception. */
function executeRoot(ctx: Ctx, rootType: string, selection: FieldNode[]): Record<string, unknown> {
  // Patch the walker for this run: Repository nodes carry __repo, PullRequest nodes
  // carry __repo/__pull; their argument fields resolve in executeSelectionWithRepo.
  return executeSelectionWithRepo(ctx, rootType, null, selection);
}

function executeSelectionWithRepo(ctx: Ctx, type: string, node: Node | null, selection: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    const key = field.alias ?? field.name;
    if (field.name === '__inlineFragment') {
      if (field.fragmentType === type || field.fragmentType === '' || field.fragmentType === null) {
        Object.assign(out, executeSelectionWithRepo(ctx, type, node, field.selection ?? []));
      }
      continue;
    }
    if (field.name === '__fragmentSpread') continue;
    if (field.name === '__type') {
      out[key] = typeNode(ctx, String(argOf(field, 'name', ctx.variables) ?? ''), field);
      continue;
    }
    // Repository argument fields.
    if (type === 'Repository' && node !== null && typeof node.values.__repo === 'string') {
      const repo = ctx.forge.getRepo(node.values.__repo);
      if (repo !== undefined && ['issue', 'issues', 'pullRequest', 'pullRequests'].includes(field.name)) {
        out[key] = resolveRepoField(ctx, repo, field);
        continue;
      }
    }
    // PullRequest.files.
    if (type === 'PullRequest' && node !== null && field.name === 'files') {
      const repo = typeof node.values.__repo === 'string' ? ctx.forge.getRepo(node.values.__repo) : undefined;
      const pullNumber = typeof node.values.__pull === 'number' ? node.values.__pull : -1;
      const item = repo?.items.get(pullNumber);
      if (repo !== undefined && item !== undefined && item.kind === 'pull') {
        const firstRaw = Number(argOf(field, 'first', ctx.variables) ?? 100);
        const files = ctx.forge.pullFiles(repo, item).slice(0, Number.isFinite(firstRaw) && firstRaw > 0 ? Math.trunc(firstRaw) : 100);
        const connection: Node = {
          type: 'PullRequestChangedFileConnection',
          values: {
            nodes: files.map((file) => ({ type: 'PullRequestChangedFile', values: { path: file.filename, additions: file.additions, deletions: file.deletions } }) as Node),
            totalCount: files.length,
          },
        };
        out[key] = executeSelectionWithRepo(ctx, 'PullRequestChangedFileConnection', connection, field.selection ?? []);
        continue;
      }
      out[key] = null;
      continue;
    }
    const known = TYPE_FIELDS[type];
    if (known !== undefined && !known.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'` });
      continue;
    }
    out[key] = resolveFieldWithRepo(ctx, type, node, field);
  }
  return out;
}

function resolveFieldWithRepo(ctx: Ctx, type: string, node: Node | null, field: FieldNode): unknown {
  if (type === 'Query' || type === 'Mutation') {
    // Root fields build their own sub-trees; nested Repository/PullRequest nodes
    // inside them are executed by executeSelectionWithRepo via expand below.
    const value = resolveFieldShallow(ctx, type, field);
    return value;
  }
  return expandWithRepo(ctx, node, field);
}

function expandWithRepo(ctx: Ctx, node: Node | null, field: FieldNode): unknown {
  if (node === null) return null;
  const value = node.values[field.name];
  if (value === undefined || value === null) return null;
  if (field.selection === null) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => (isNode(entry) ? executeSelectionWithRepo(ctx, entry.type, entry, field.selection ?? []) : entry));
  }
  if (isNode(value)) return executeSelectionWithRepo(ctx, value.type, value, field.selection ?? []);
  return value;
}

/** Query/Mutation root fields, with nested selections executed through the repo-aware walker. */
function resolveFieldShallow(ctx: Ctx, type: string, field: FieldNode): unknown {
  const { forge } = ctx;
  if (type === 'Mutation') {
    // Mutations return payload nodes whose children are plain nodes; run them
    // through the repo-aware walker by re-entering resolveMutation with a shim:
    return resolveMutationRouted(ctx, field);
  }
  switch (field.name) {
    case 'viewer':
      return executeSelectionWithRepo(ctx, 'User', { type: 'User', values: { login: forge.viewerLogin(), id: globalId('User', [1]) } }, field.selection ?? []);
    case 'repository': {
      const owner = String(argOf(field, 'owner', ctx.variables) ?? '');
      const name = String(argOf(field, 'name', ctx.variables) ?? '');
      if (!forge.ownerMatches(owner)) return null;
      const repo = forge.getRepo(name);
      if (repo === undefined) return null;
      return executeSelectionWithRepo(ctx, 'Repository', repoNode(forge, repo), field.selection ?? []);
    }
    case 'node': {
      const id = String(argOf(field, 'id', ctx.variables) ?? '');
      const parsed = parseGlobalId(id);
      if (parsed?.kind === 'Repository') {
        const repo = forge.repoList().find((candidate) => candidate.databaseId === Number(parsed.parts[0]));
        if (repo === undefined) return null;
        return executeSelectionWithRepo(ctx, 'Repository', repoNode(forge, repo), field.selection ?? []);
      }
      return null;
    }
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Query'` });
      return null;
  }
}

/** Mutations build payload nodes with plain child nodes; execute their selections repo-aware. */
function resolveMutationRouted(ctx: Ctx, field: FieldNode): unknown {
  const before = ctx.errors.length;
  void before;
  // resolveMutation executes selections with the plain walker; payload children
  // (Issue/PullRequest scalars) need no repo interception, except PullRequest.files
  // which never appears in mutation payloads the suite sends.
  return resolveMutation(ctx, field);
}

// ------------------------------------------------------------------ handler

export async function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (parsed === BAD_JSON || parsed === undefined) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') return { errors: [{ message: 'invalid operation' }] };
      const variables = isRecord(entry.variables) ? entry.variables : {};
      return executeOperation(forge, entry.query, variables);
    });
    sendJson(res, 200, results);
    return;
  }
  if (!isRecord(parsed) || typeof parsed.query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'a query is required' }] });
    return;
  }
  const variables = isRecord(parsed.variables) ? parsed.variables : {};
  sendJson(res, 200, executeOperation(forge, parsed.query, variables));
}
