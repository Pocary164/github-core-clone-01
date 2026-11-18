// The GraphQL v4 surface at /api/graphql: the documents gh and github-mcp-server send — viewer,
// repository fields, issue and pull-request connections, the five mutations of the checks, node()
// round-trips and the introspection probes — over a small hand-written parser and executor.
// No library ships in the pod, and none is needed: the grammar used here is names, arguments,
// variables, lists, objects and inline fragments.

import { VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, nextInstant, store } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';
import { branchTip, issueJson, mergePull, pullDiff, pullMergeable } from './rest.ts';

// ------------------------------------------------------------------ global ids

export function globalId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

function decodeGlobalId(value: string): { type: string; id: number } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const colon = text.lastIndexOf(':');
    if (colon < 0) return null;
    const id = parseInt(text.slice(colon + 1), 10);
    if (!Number.isInteger(id)) return null;
    return { type: text.slice(0, colon), id };
  } catch {
    return null;
  }
}

function findRepoByDbId(id: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function findIssueByGlobalId(id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(id: number): { repo: Repo; pull: Pull } | null {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return null;
}

// ------------------------------------------------------------------ lexer

type TokenKind = 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in the GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selection: SelectionNode[] | null;
}
interface FragmentNode {
  kind: 'inline' | 'spread';
  typeCondition: string | null;
  name: string | null;
  selection: SelectionNode[] | null;
}
type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  fragments = new Map<string, SelectionNode[]>();

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }
  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, found ${token.value}`);
  }
  private skip(value: string): boolean {
    if (this.peek().value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.expect('on');
        this.next(); // the type condition
        this.skipDirectives();
        this.fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected token ${token.value} in the document`);
    }
    return operations;
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek().value !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.skip('=')) this.parseValue();
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    this.skip('!');
  }

  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    this.expect('(');
    while (this.peek().value !== ')') {
      const name = this.next().value;
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.value === '$') {
      const name = this.next();
      return { kind: 'variable', name: name.value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.value === '[') {
      const items: Value[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      const fields = new Map<string, Value>();
      while (this.peek().value !== '}') {
        const name = this.next().value;
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const condition = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition: condition, name: null, selection: this.parseSelectionSet() });
        } else {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'spread', typeCondition: null, name, selection: null });
        }
        continue;
      }
      const first = this.next();
      let alias: string | null = null;
      let name = first.value;
      if (this.peek().value === ':') {
        this.next();
        alias = name;
        name = this.next().value;
      }
      const args = this.peek().value === '(' ? this.parseArguments() : new Map<string, Value>();
      this.skipDirectives();
      const selection = this.peek().value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    this.expect('}');
    return selections;
  }
}

// ------------------------------------------------------------------ schema (for introspection)

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'meta'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'addLabelsToLabelable', 'removeLabelsFromLabelable'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'repositories', 'issues', 'pullRequests'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'label', 'labels', 'stargazerCount', 'forkCount', 'watchers', 'primaryLanguage', 'isFork', 'parent',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'author', 'repository', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'locked', 'assignees', 'participants', 'reactions',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'author', 'repository', 'files', 'commits', 'comments', 'createdAt', 'updatedAt',
    'closedAt', 'mergedAt', 'url', 'additions', 'deletions', 'changedFiles', 'mergeCommit', 'isDraft', 'labels',
  ],
  Label: ['id', 'name', 'color', 'description', 'url'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'issue'],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  Commit: ['id', 'oid', 'message', 'authoredDate', 'author', 'tree', 'parents', 'url'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  CommentEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  MergeMethod: ['MERGE', 'REBASE', 'SQUASH'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'HTML', 'GitObjectID', 'Base64String']);

// ------------------------------------------------------------------ execution

type GqlObject = Record<string, unknown> & { __typename: string };

interface ExecContext {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, SelectionNode[]>;
}

function resolveValue(value: Value, ctx: ExecContext): unknown {
  switch (value.kind) {
    case 'variable':
      return ctx.variables[value.name];
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(inner, ctx);
      return out;
    }
  }
}

function argsOf(node: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of node.args) out[key] = resolveValue(value, ctx);
  return out;
}

function viewerObject(): GqlObject {
  return { __typename: 'User', login: VIEWER_LOGIN, id: globalId('User', VIEWER_ID), databaseId: VIEWER_ID, name: VIEWER_NAME };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function connection(typename: string, items: GqlObject[], first: number | undefined, after: string | undefined): GqlObject {
  const keyOf = (item: GqlObject): string => {
    const record = item as unknown as { issue?: Issue; pull?: Pull };
    if (record.issue) return `n${record.issue.number}`;
    if (record.pull) return `n${record.pull.number}`;
    return `x${items.indexOf(item)}`;
  };
  let startIndex = 0;
  if (after) {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const key = decoded.replace(/^cursor:/, '');
      const found = items.findIndex((item) => keyOf(item) === key);
      if (found >= 0) startIndex = found + 1;
    } catch {
      startIndex = 0;
    }
  }
  const limit = first === undefined ? items.length : Math.max(0, first);
  const page = items.slice(startIndex, startIndex + limit);
  const hasNextPage = startIndex + page.length < items.length;
  const edges = page.map((node) => ({ __typename: 'Edge', node, cursor: Buffer.from(`cursor:${keyOf(node)}`, 'utf8').toString('base64') }));
  return {
    __typename: typename,
    nodes: page,
    edges,
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: startIndex > 0,
      startCursor: edges.length ? edges[0].cursor : null,
      endCursor: edges.length ? edges[edges.length - 1].cursor : null,
    },
  };
}

function sortIssues(issues: Issue[], args: Record<string, unknown>): Issue[] {
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : 'DESC';
  const sorted = [...issues].sort((a, b) => a.number - b.number);
  if (direction === 'DESC') sorted.reverse();
  return sorted;
}

function resolveField(obj: GqlObject, field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const typename = obj.__typename;
  if (field === '__typename') return typename;

  if (typename === 'Query') {
    switch (field) {
      case 'viewer':
        return viewerObject();
      case 'repository': {
        const repo = store.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoObject(repo) : null;
      }
      case 'node': {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.type === 'Repository') {
          const repo = findRepoByDbId(decoded.id);
          return repo ? repoObject(repo) : null;
        }
        if (decoded.type === 'Issue') {
          const found = findIssueByGlobalId(decoded.id);
          return found ? issueObject(found.repo, found.issue) : null;
        }
        if (decoded.type === 'PullRequest') {
          const found = findPullByGlobalId(decoded.id);
          return found ? pullObject(found.repo, found.pull) : null;
        }
        if (decoded.type === 'User') return viewerObject();
        return null;
      }
      case '__type': {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name]) return { __typename: '__Type', name, kind: 'OBJECT' };
        if (ENUM_VALUES[name]) return { __typename: '__Type', name, kind: 'ENUM' };
        if (SCALAR_TYPES.has(name)) return { __typename: '__Type', name, kind: 'SCALAR' };
        return null;
      }
      case '__schema':
        return { __typename: '__Schema' };
      default:
        break;
    }
  }

  if (typename === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field) {
      case 'createIssue': {
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded ? findRepoByDbId(decoded.id) : null;
        if (!repo) throw new Error('createIssue: the repository does not exist');
        const stamp = nextInstant().iso;
        const issue: Issue = {
          id: store.nextIssueId(),
          number: repo.nextNumber++,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          labels: [],
          comments: [],
          createdAt: stamp,
          updatedAt: stamp,
          closedAt: null,
        };
        repo.issues.set(issue.number, issue);
        return { __typename: 'CreateIssuePayload', clientMutationId: (input.clientMutationId as string) ?? null, issue: issueObject(repo, issue) };
      }
      case 'closeIssue': {
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        const found = decoded ? findIssueByGlobalId(decoded.id) : null;
        if (!found) throw new Error('closeIssue: the issue does not exist');
        const stamp = nextInstant().iso;
        found.issue.state = 'closed';
        found.issue.closedAt = stamp;
        found.issue.updatedAt = stamp;
        return { __typename: 'CloseIssuePayload', clientMutationId: (input.clientMutationId as string) ?? null, issue: issueObject(found.repo, found.issue) };
      }
      case 'createPullRequest': {
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded ? findRepoByDbId(decoded.id) : null;
        if (!repo) throw new Error('createPullRequest: the repository does not exist');
        const headRefName = String(input.headRefName ?? '');
        const baseRefName = String(input.baseRefName ?? '');
        const headTip = branchTip(repo, headRefName);
        if (!headTip) throw new Error(`createPullRequest: the head branch '${headRefName}' does not exist`);
        const stamp = nextInstant().iso;
        const pull: Pull = {
          id: store.nextIssueId(),
          number: repo.nextNumber++,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          merged: false,
          headRef: headRefName,
          baseRef: baseRefName,
          headSha: headTip,
          mergeCommitSha: null,
          createdAt: stamp,
          updatedAt: stamp,
          mergedAt: null,
          closedAt: null,
        };
        repo.pulls.set(pull.number, pull);
        return { __typename: 'CreatePullRequestPayload', clientMutationId: (input.clientMutationId as string) ?? null, pullRequest: pullObject(repo, pull) };
      }
      case 'mergePullRequest': {
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        const found = decoded ? findPullByGlobalId(decoded.id) : null;
        if (!found) throw new Error('mergePullRequest: the pull request does not exist');
        const method = String(input.mergeMethod ?? 'SQUASH');
        if (found.pull.state === 'open') {
          const outcome = mergePull(found.repo, found.pull, method === 'MERGE' ? 'merge' : 'squash');
          if (!outcome.ok) throw new Error('mergePullRequest: the pull request is not mergeable');
        }
        return { __typename: 'MergePullRequestPayload', clientMutationId: (input.clientMutationId as string) ?? null, pullRequest: pullObject(found.repo, found.pull) };
      }
      case 'addComment': {
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        const found = decoded ? findIssueByGlobalId(decoded.id) : null;
        if (!found) throw new Error('addComment: the subject does not exist');
        const stamp = nextInstant().iso;
        const comment = { id: store.nextCommentId(), body: String(input.body ?? ''), createdAt: stamp, updatedAt: stamp };
        found.issue.comments.push(comment);
        found.issue.updatedAt = stamp;
        const node: GqlObject = { __typename: 'IssueComment', repo: found.repo, issue: found.issue, comment };
        return {
          __typename: 'AddCommentPayload',
          clientMutationId: (input.clientMutationId as string) ?? null,
          commentEdge: { __typename: 'CommentEdge', node, cursor: Buffer.from(`cursor:c${comment.id}`).toString('base64') },
          subject: issueObject(found.repo, found.issue),
        };
      }
      default:
        break;
    }
  }

  if (typename === 'User') {
    switch (field) {
      case 'login':
        return obj.login;
      case 'id':
        return obj.id;
      case 'databaseId':
        return obj.databaseId;
      case 'name':
        return obj.name;
      case 'email':
        return 'adaiversen@example.invalid';
      case 'url':
        return `https://github.invalid/${obj.login}`;
      case 'avatarUrl':
        return '';
      default:
        break;
    }
  }

  if (typename === 'Repository') {
    const repo = obj.repo as Repo;
    switch (field) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return viewerObject();
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'isFork':
        return false;
      case 'url':
        return `https://github.invalid/${repo.owner}/${repo.name}`;
      case 'createdAt':
        return repo.createdAt;
      case 'updatedAt':
        return repo.updatedAt;
      case 'stargazerCount':
        return 0;
      case 'forkCount':
        return 0;
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.defaultBranch);
        return {
          __typename: 'Ref',
          name: repo.defaultBranch,
          prefix: 'refs/heads/',
          target: tip ? { __typename: 'Commit', oid: tip } : null,
        };
      }
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueObject(repo, issue) : null;
      }
      case 'issues': {
        let issues = [...repo.issues.values()];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length) {
          const wanted = new Set(states.map((state) => state.toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const sorted = sortIssues(issues, args);
        return connection('IssueConnection', sorted.map((issue) => issueObject(repo, issue)), args.first as number | undefined, args.after as string | undefined);
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullObject(repo, pull) : null;
      }
      case 'pullRequests': {
        let pulls = [...repo.pulls.values()];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length) {
          pulls = pulls.filter((pull) => {
            const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
            return states.includes(state);
          });
        }
        pulls.sort((a, b) => b.number - a.number);
        return connection('PullRequestConnection', pulls.map((pull) => pullObject(repo, pull)), args.first as number | undefined, args.after as string | undefined);
      }
      default:
        break;
    }
  }

  if (typename === 'Issue') {
    const repo = obj.repo as Repo;
    const issue = obj.issue as Issue;
    switch (field) {
      case 'id':
        return globalId('Issue', issue.id);
      case 'databaseId':
        return issue.id;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'url':
        return `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'author':
        return viewerObject();
      case 'repository':
        return repoObject(repo);
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'closedAt':
        return issue.closedAt;
      case 'locked':
        return false;
      case 'labels': {
        const nodes = issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed', repo }));
        return connection('LabelConnection', nodes as GqlObject[], args.first as number | undefined, args.after as string | undefined);
      }
      case 'comments': {
        const nodes = issue.comments.map((comment) => ({ __typename: 'IssueComment', repo, issue, comment }) as GqlObject);
        return connection('IssueCommentConnection', nodes, args.first as number | undefined, args.after as string | undefined);
      }
      default:
        break;
    }
  }

  if (typename === 'PullRequest') {
    const repo = obj.repo as Repo;
    const pull = obj.pull as Pull;
    switch (field) {
      case 'id':
        return globalId('PullRequest', pull.id);
      case 'databaseId':
        return pull.id;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'mergeable':
        if (pull.state !== 'open') return 'UNKNOWN';
        return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRef': {
        const tip = branchTip(repo, pull.headRef) ?? pull.headSha;
        return { __typename: 'Ref', name: pull.headRef, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: tip } };
      }
      case 'baseRef': {
        const tip = branchTip(repo, pull.baseRef);
        return { __typename: 'Ref', name: pull.baseRef, prefix: 'refs/heads/', target: tip ? { __typename: 'Commit', oid: tip } : null };
      }
      case 'author':
        return viewerObject();
      case 'repository':
        return repoObject(repo);
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'closedAt':
        return pull.closedAt;
      case 'mergedAt':
        return pull.mergedAt;
      case 'url':
        return `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'isDraft':
        return false;
      case 'mergeCommit':
        return pull.mergeCommitSha ? { __typename: 'Commit', oid: pull.mergeCommitSha } : null;
      case 'additions':
        return pullDiff(repo, pull).changes.reduce((sum, change) => sum + change.additions, 0);
      case 'deletions':
        return pullDiff(repo, pull).changes.reduce((sum, change) => sum + change.deletions, 0);
      case 'changedFiles':
        return pullDiff(repo, pull).changes.length;
      case 'files': {
        const nodes = pullDiff(repo, pull).changes.map((change) => ({
          __typename: 'PullRequestChangedFile',
          path: change.path,
          additions: change.additions,
          deletions: change.deletions,
          changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
        })) as GqlObject[];
        return connection('PullRequestChangedFileConnection', nodes, args.first as number | undefined, args.after as string | undefined);
      }
      case 'labels': {
        return connection('LabelConnection', [], args.first as number | undefined, args.after as string | undefined);
      }
      case 'comments': {
        return connection('IssueCommentConnection', [], args.first as number | undefined, args.after as string | undefined);
      }
      default:
        break;
    }
  }

  if (typename === 'IssueComment') {
    const comment = obj.comment as { id: number; body: string; createdAt: string; updatedAt: string };
    switch (field) {
      case 'id':
        return globalId('IssueComment', comment.id);
      case 'databaseId':
        return comment.id;
      case 'body':
        return comment.body;
      case 'author':
        return viewerObject();
      case 'createdAt':
        return comment.createdAt;
      case 'updatedAt':
        return comment.updatedAt;
      default:
        break;
    }
  }

  if (typename === 'Label') {
    switch (field) {
      case 'id':
        return globalId('Label', 0);
      case 'name':
        return obj.name;
      case 'color':
        return obj.color;
      case 'description':
        return null;
      default:
        break;
    }
  }

  if (typename === 'Ref') {
    switch (field) {
      case 'id':
        return globalId('Ref', 0);
      case 'name':
        return obj.name;
      case 'prefix':
        return obj.prefix;
      case 'target':
        return obj.target;
      default:
        break;
    }
  }

  if (typename === 'Commit') {
    switch (field) {
      case 'id':
        return globalId('Commit', 0);
      case 'oid':
        return obj.oid;
      default:
        break;
    }
  }

  if (typename === 'PullRequestChangedFile') {
    switch (field) {
      case 'path':
        return obj.path;
      case 'additions':
        return obj.additions;
      case 'deletions':
        return obj.deletions;
      case 'changeType':
        return obj.changeType;
      default:
        break;
    }
  }

  if (typename === '__Type') {
    const name = obj.name as string;
    switch (field) {
      case 'name':
        return name;
      case 'kind':
        return obj.kind;
      case 'description':
        return null;
      case 'fields':
        return (TYPE_FIELDS[name] ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName }));
      case 'enumValues':
        return (ENUM_VALUES[name] ?? []).map((value) => ({ __typename: '__EnumValue', name: value }));
      case 'possibleTypes':
        return [];
      case 'inputFields':
        return [];
      case 'ofType':
        return null;
      default:
        break;
    }
  }

  if (typename === '__Field' || typename === '__EnumValue') {
    if (field === 'name') return obj.name;
    if (field === 'description') return null;
    if (field === 'isDeprecated') return false;
    if (field === 'deprecationReason') return null;
  }

  if (typename === '__Schema') {
    switch (field) {
      case 'queryType':
        return { __typename: '__Type', name: 'Query', kind: 'OBJECT' };
      case 'mutationType':
        return { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' };
      case 'subscriptionType':
        return null;
      case 'types':
        return [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => ({
          __typename: '__Type',
          name,
          kind: ENUM_VALUES[name] ? 'ENUM' : 'OBJECT',
        }));
      case 'directives':
        return [];
      default:
        break;
    }
  }

  if (typename.endsWith('Connection')) {
    switch (field) {
      case 'nodes':
        return obj.nodes;
      case 'edges':
        return obj.edges;
      case 'pageInfo':
        return obj.pageInfo;
      case 'totalCount':
        return obj.totalCount;
      default:
        break;
    }
  }

  if (typename === 'PageInfo') {
    switch (field) {
      case 'hasNextPage':
        return obj.hasNextPage;
      case 'hasPreviousPage':
        return obj.hasPreviousPage;
      case 'startCursor':
        return obj.startCursor;
      case 'endCursor':
        return obj.endCursor;
      default:
        break;
    }
  }

  if (typename === 'Edge' || typename === 'CommentEdge') {
    if (field === 'node') return obj.node;
    if (field === 'cursor') return obj.cursor;
  }

  if (typename.endsWith('Payload')) {
    if (field in obj) return obj[field];
  }

  // A field this type does not carry: an error naming it, and a null value (HTTP stays 200).
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typename}".` });
  return null;
}

function executeSelection(obj: GqlObject, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === obj.__typename) {
        Object.assign(out, executeSelection(obj, selection.selection ?? [], ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = selection.name ? ctx.fragments.get(selection.name) : undefined;
      if (fragment) Object.assign(out, executeSelection(obj, fragment, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    let value: unknown;
    try {
      value = resolveField(obj, selection.name, argsOf(selection, ctx), ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      value = null;
    }
    if (selection.selection && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        value = value.map((item) =>
          typeof item === 'object' && item !== null && '__typename' in (item as GqlObject)
            ? executeSelection(item as GqlObject, selection.selection as SelectionNode[], ctx)
            : item,
        );
      } else if (typeof value === 'object' && '__typename' in (value as GqlObject)) {
        value = executeSelection(value as GqlObject, selection.selection, ctx);
      }
    }
    out[key] = value === undefined ? null : value;
  }
  return out;
}

function runOperation(operation: Operation, variables: Record<string, unknown>, fragments: Map<string, SelectionNode[]>): Record<string, unknown> {
  const ctx: ExecContext = { variables, errors: [], fragments };
  const root: GqlObject = operation.type === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelection(root, operation.selection, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

/** Handle one POST /api/graphql body: a single operation or a batch array of them. */
export function handleGraphQL(bodyText: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    const record = (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
    try {
      const parser = new Parser(query);
      const operations = parser.parseDocument();
      if (operations.length === 0) return { errors: [{ message: 'The document holds no operation' }] };
      const operation =
        typeof record.operationName === 'string' ? (operations.find((candidate) => candidate.name === record.operationName) ?? operations[0]) : operations[0];
      return runOperation(operation, variables, parser.fragments);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) return { status: 200, body: parsed.map(runOne) };
  return { status: 200, body: runOne(parsed) };
}

// issueJson is part of the REST surface this module mirrors for ids; referenced to keep the
// GraphQL issue ids and the REST issue ids the same numbers by construction.
void issueJson;
