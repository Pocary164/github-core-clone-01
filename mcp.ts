// The MCP surface at /mcp: JSON-RPC 2.0 over Streamable HTTP, speaking the modern discovery
// revision (server/discover) with a legacy initialize fallback. The tools act on the same store
// as REST and GraphQL, with github-mcp-server's argument shapes, so an object created here reads
// back identically on the other surfaces.

import { VIEWER_LOGIN, nextInstant, store } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';
import { branchTip, issueJson, mergePull, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0', title: 'GitHub Core Clone' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: true };
}

const stringProp = (description: string): Record<string, unknown> => ({ type: 'string', description });

// Built once and reused verbatim: two tools/list calls must answer byte-for-byte the same list.
const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: objectSchema(
      {
        name: stringProp('The name of the repository to create.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get details of a repository by owner and name.',
    inputSchema: objectSchema(
      {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        full_name: stringProp('The full name of the repository, as owner/repo.'),
      },
      [],
    ),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: objectSchema(
      {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        full_name: stringProp('The full name of the repository, as owner/repo.'),
        title: stringProp('The title of the issue.'),
        body: stringProp('The body of the issue.'),
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to put on the issue.' },
      },
      ['title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: objectSchema(
      {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        full_name: stringProp('The full name of the repository, as owner/repo.'),
        state: stringProp('Filter by state: open, closed or all.'),
      },
      [],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    inputSchema: objectSchema(
      {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        full_name: stringProp('The full name of the repository, as owner/repo.'),
        title: stringProp('The title of the pull request.'),
        head: stringProp('The name of the branch to merge from.'),
        base: stringProp('The name of the branch to merge into.'),
        body: stringProp('The body of the pull request.'),
      },
      ['title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: objectSchema(
      {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        full_name: stringProp('The full name of the repository, as owner/repo.'),
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
        merge_method: stringProp('The merge method to use: merge, squash or rebase.'),
      },
      ['pull_number'],
    ),
  },
  {
    name: 'list_repositories',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: objectSchema({}, []),
  },
];

const TOOLS_LIST_RESULT = { tools: TOOLS };

// ------------------------------------------------------------------ helpers

class InvalidParams extends Error {}
class ToolFailure extends Error {}

function resolveRepoRef(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [head, ...rest] = args.full_name.split('/');
    if (!owner) owner = head;
    if (!repo) repo = rest.join('/');
  }
  if (!repo) throw new InvalidParams('a repository is required: pass repo (and owner) or full_name');
  return { owner, repo };
}

function requireRepo(args: Record<string, unknown>): Repo {
  const { owner, repo } = resolveRepoRef(args);
  const found = store.findRepo(owner === '' ? VIEWER_LOGIN : owner, repo);
  if (!found) throw new ToolFailure(`repository ${owner}/${repo} not found`);
  return found;
}

function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function toolSuccess(data: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    isError: false,
  };
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) result.structuredContent = data;
  return result;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (!repoName) throw new InvalidParams('create_repo requires a name');
      if (store.findRepo(VIEWER_LOGIN, repoName)) throw new ToolFailure(`a repository named ${repoName} already exists`);
      const repo = store.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolSuccess(repoJson(repo));
    }
    case 'get_repo': {
      return toolSuccess(repoJson(requireRepo(args)));
    }
    case 'create_issue': {
      const repo = requireRepo(args);
      const title = typeof args.title === 'string' ? args.title : '';
      if (!title) throw new InvalidParams('create_issue requires a title');
      const labels = Array.isArray(args.labels) ? args.labels.map(String) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) throw new ToolFailure(`label '${label}' does not exist in this repository`);
      }
      const stamp = nextInstant().iso;
      const issue: Issue = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels,
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
        closedAt: null,
      };
      repo.issues.set(issue.number, issue);
      return toolSuccess(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = requireRepo(args);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return toolSuccess(issues);
    }
    case 'create_pull_request': {
      const repo = requireRepo(args);
      const title = typeof args.title === 'string' ? args.title : '';
      const head = branchName(typeof args.head === 'string' ? args.head : '');
      const base = branchName(typeof args.base === 'string' ? args.base : repo.defaultBranch);
      if (!title) throw new InvalidParams('create_pull_request requires a title');
      if (!head) throw new InvalidParams('create_pull_request requires a head branch');
      const headTip = branchTip(repo, head);
      if (!headTip) throw new ToolFailure(`the head branch '${head}' does not exist`);
      const stamp = nextInstant().iso;
      const pull: Pull = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        headSha: headTip,
        mergeCommitSha: null,
        createdAt: stamp,
        updatedAt: stamp,
        mergedAt: null,
        closedAt: null,
      };
      repo.pulls.set(pull.number, pull);
      return toolSuccess(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(args);
      const number = Number(args.pull_number);
      if (!Number.isInteger(number)) throw new InvalidParams('merge_pull_request requires a pull_number');
      const pull = repo.pulls.get(number);
      if (!pull) throw new ToolFailure(`pull request ${number} not found`);
      if (pull.state !== 'open') throw new ToolFailure(`pull request ${number} is not open`);
      const method = typeof args.merge_method === 'string' && args.merge_method.toLowerCase() === 'merge' ? 'merge' : 'squash';
      const outcome = mergePull(repo, pull, method);
      if (!outcome.ok) throw new ToolFailure('the pull request has conflicts and cannot be merged');
      return toolSuccess(pullJson(repo, pull));
    }
    case 'list_repositories': {
      return toolSuccess([...store.repos.values()].map((repo) => repoJson(repo)));
    }
    default:
      throw new InvalidParams(`unknown tool: ${name}`);
  }
}

// ------------------------------------------------------------------ JSON-RPC plumbing

export interface McpReply {
  status: number;
  body: unknown; // undefined body means: answer with no content (notifications)
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** Handle one POST /mcp body. Notifications answer with status 202 and no body. */
export function handleMcp(bodyText: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: the body is not valid JSON') };
  }
  if (Array.isArray(parsed)) {
    const replies = parsed.map((entry) => handleOne(entry)).filter((reply) => reply !== undefined);
    if (replies.length === 0) return { status: 202, body: undefined };
    return { status: 200, body: replies };
  }
  const reply = handleOne(parsed);
  if (reply === undefined) return { status: 202, body: undefined };
  return { status: 200, body: reply };
}

function handleOne(entry: unknown): Record<string, unknown> | undefined {
  if (typeof entry !== 'object' || entry === null) return rpcError(null, -32600, 'Invalid Request');
  const request = entry as { id?: unknown; method?: unknown; params?: unknown };
  const hasId = 'id' in request && request.id !== undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  if (!method) return hasId ? rpcError(request.id, -32600, 'Invalid Request: no method') : undefined;
  if (method.startsWith('notifications/')) return undefined; // accepted, never answered

  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(request.id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(request.id, {
        protocolVersion: asked,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP.',
      });
    }
    case 'ping':
      return rpcResult(request.id, {});
    case 'tools/list':
      return rpcResult(request.id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      if (!TOOLS.some((tool) => tool.name === name)) {
        return rpcError(request.id, -32601, `Method not found: unknown tool '${name}'`);
      }
      try {
        return rpcResult(request.id, callTool(name, args));
      } catch (err) {
        if (err instanceof InvalidParams) return rpcError(request.id, -32602, err.message);
        if (err instanceof ToolFailure) {
          return rpcResult(request.id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
        return rpcResult(request.id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(request.id, -32601, `Method not found: ${method}`);
  }
}
