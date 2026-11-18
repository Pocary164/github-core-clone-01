// The REST v3 surface under /api/v3. Repositories, contents, branches, commits, labels, issues,
// comments and pull requests — all backed by the same store and the same git objects the
// smart-HTTP surface serves, so a file written by PUT /contents is the blob a clone fetches.

import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, nextInstant, store } from './store.ts';
import type { Issue, Label, Pull, Repo } from './store.ts';
import {
  buildCommitData,
  commitTree,
  countLines,
  diffFlat,
  flattenTree,
  isAncestor,
  lineDiffCounts,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  putObject,
  treeFromFlat,
} from './git.ts';
import type { FlatEntry } from './git.ts';

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestReply => ({ status: 404, body: { message: 'Not Found' } });
const badRequest = (message: string): RestReply => ({ status: 400, body: { message } });

// ------------------------------------------------------------------ shared shapes

export function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL, site_admin: false };
}

export function repoJson(repo: Repo, base: string): Record<string, unknown> {
  const url = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    description: repo.description,
    fork: false,
    url,
    html_url: url,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
  };
}

export function labelJson(label: Label, repo: Repo, base: string): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${repo.id}:${label.id}`, 'utf8').toString('base64'),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue, base: string): Record<string, unknown> {
  const url = `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${issue.id}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label, repo, base) : { name };
    }),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: url,
    labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/comments`,
    events_url: `${url}/events`,
  };
}

/** An issue-shaped view of a pull request, as GitHub's issue endpoints present one. */
export function pullAsIssueJson(repo: Repo, pull: Pull, base: string): Record<string, unknown> {
  const url = `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`;
  return {
    id: pull.id,
    node_id: Buffer.from(`Issue:${pull.id}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: [],
    assignees: [],
    comments: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    url,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: url,
    pull_request: {
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
      html_url: url,
      diff_url: `${url}.diff`,
      patch_url: `${url}.patch`,
      merged_at: pull.mergedAt,
    },
  };
}

export function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string; updatedAt: string }, base: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`, 'utf8').toString('base64'),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    issue_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    html_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

// ------------------------------------------------------------------ git-backed helpers

export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a branch name, a full ref, HEAD, or a commit id to a commit id. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') {
    const tip = branchTip(repo, repo.defaultBranch);
    return tip ? peelToCommit(repo, tip) : null;
  }
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch) return peelToCommit(repo, byBranch);
  const byRef = repo.refs.get(ref);
  if (byRef) return peelToCommit(repo, byRef);
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.get(ref)?.type === 'commit') return ref;
  return null;
}

/** Commit a tree change on a branch: returns the new commit id, or null when the branch is unknown. */
export function commitOnBranch(repo: Repo, branch: string, message: string, flat: Map<string, FlatEntry>): string | null {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (!tip && branch !== repo.defaultBranch) return null;
  const tree = treeFromFlat(repo, flat);
  const { unix } = nextInstant();
  const data = buildCommitData({
    tree,
    parents: tip ? [peelToCommit(repo, tip)] : [],
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    unix,
    message,
  });
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(ref, oid);
  repo.updatedAt = nextInstant().iso;
  return oid;
}

/** The flat path map at a commit (empty when the commit is unknown). */
export function flatAtCommit(repo: Repo, commitOid: string | null): Map<string, FlatEntry> {
  if (!commitOid) return new Map();
  const tree = commitTree(repo, commitOid);
  return flattenTree(repo, tree);
}

// ------------------------------------------------------------------ pull request mechanics

export interface PullDiff {
  base: string | null;
  changes: Array<{ path: string; status: 'added' | 'modified' | 'removed'; beforeOid: string | null; afterOid: string | null; additions: number; deletions: number }>;
  commits: number;
}

/** The diff a pull request shows: merge-base to head, with line counts and the commit count. */
export function pullDiff(repo: Repo, pull: Pull): PullDiff {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef);
  const base = baseTip ? mergeBase(repo, baseTip, headTip) : null;
  const before = flatAtCommit(repo, base);
  const after = flatAtCommit(repo, headTip);
  const changes = diffFlat(before, after).map((change) => {
    const beforeData = change.beforeOid ? (repo.objects.get(change.beforeOid)?.data ?? null) : null;
    const afterData = change.afterOid ? (repo.objects.get(change.afterOid)?.data ?? null) : null;
    const counts = lineDiffCounts(beforeData, afterData);
    return { path: change.path, status: change.status, beforeOid: change.beforeOid, afterOid: change.afterOid, ...counts };
  });
  let commits = 0;
  if (baseTip) {
    const headAncestors = new Set<string>();
    const stack = [headTip];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (headAncestors.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      headAncestors.add(oid);
      stack.push(...parseCommit(obj.data).parents);
    }
    const baseAncestors = new Set<string>();
    const stack2 = [baseTip];
    while (stack2.length) {
      const oid = stack2.pop() as string;
      if (baseAncestors.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      baseAncestors.add(oid);
      stack2.push(...parseCommit(obj.data).parents);
    }
    commits = [...headAncestors].filter((oid) => !baseAncestors.has(oid)).length;
  }
  return { base, changes, commits };
}

export interface MergeOutcome {
  ok: boolean;
  sha: string | null;
  conflict: boolean;
}

/** Three-way merge of head into the base branch tip; on success the merged tree id. */
export function mergedTree(repo: Repo, baseTip: string, headTip: string): { tree: string } | { conflict: true } {
  const base = mergeBase(repo, baseTip, headTip);
  const baseFlat = flatAtCommit(repo, base);
  const headFlat = flatAtCommit(repo, headTip);
  const tipFlat = flatAtCommit(repo, baseTip);
  const result = new Map(tipFlat);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path)?.oid ?? null;
    const h = headFlat.get(path)?.oid ?? null;
    const t = tipFlat.get(path)?.oid ?? null;
    if (h === b) continue; // the head did not change this path
    if (t === b) {
      // Only the head changed it: take the head's version (or its deletion).
      if (h === null) result.delete(path);
      else result.set(path, headFlat.get(path) as FlatEntry);
      continue;
    }
    if (h === t) continue; // both sides made the same change
    return { conflict: true };
  }
  return { tree: treeFromFlat(repo, result) };
}

export function pullMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  if (!baseTip || !headTip) return false;
  if (isAncestor(repo, headTip, baseTip)) return true;
  return 'tree' in mergedTree(repo, baseTip, headTip);
}

/** Merge a pull request (squash by default; 'merge' makes a two-parent commit). */
export function mergePull(repo: Repo, pull: Pull, method: string, messageOverride?: string): MergeOutcome {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  if (!baseTip || !headTip) return { ok: false, sha: null, conflict: true };
  if (isAncestor(repo, headTip, baseTip)) {
    const stamp = nextInstant().iso;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = stamp;
    pull.closedAt = stamp;
    pull.updatedAt = stamp;
    pull.mergeCommitSha = baseTip;
    return { ok: true, sha: baseTip, conflict: false };
  }
  const merged = mergedTree(repo, baseTip, headTip);
  if ('conflict' in merged) return { ok: false, sha: null, conflict: true };
  const { unix } = nextInstant();
  const message = messageOverride ?? `${pull.title} (#${pull.number})${pull.body ? `\n\n${pull.body}` : ''}`;
  const data = buildCommitData({
    tree: merged.tree,
    parents: method === 'merge' ? [baseTip, headTip] : [baseTip],
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    unix,
    message,
  });
  const sha = putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const stamp = nextInstant().iso;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp;
  pull.closedAt = stamp;
  pull.updatedAt = stamp;
  pull.mergeCommitSha = sha;
  repo.updatedAt = stamp;
  return { ok: true, sha, conflict: false };
}

export function pullJson(repo: Repo, pull: Pull, base: string): Record<string, unknown> {
  const url = `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`;
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef);
  const diff = pullDiff(repo, pull);
  const refJson = (ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    repo: repoJson(repo, base),
  });
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${pull.id}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: refJson(pull.headRef, headTip),
    base: refJson(pull.baseRef, baseTip),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    closed_at: pull.closedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (pullMergeable(repo, pull) ? 'clean' : 'dirty') : 'unknown',
    draft: false,
    commits: diff.commits,
    additions: diff.changes.reduce((sum, change) => sum + change.additions, 0),
    deletions: diff.changes.reduce((sum, change) => sum + change.deletions, 0),
    changed_files: diff.changes.length,
    comments: 0,
    review_comments: 0,
    url,
    html_url: url,
    diff_url: `${url}.diff`,
    patch_url: `${url}.patch`,
    _links: { self: { href: url } },
  };
}

// ------------------------------------------------------------------ pagination

interface PageResult<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(items: readonly T[], query: URLSearchParams, base: string, path: string): PageResult<T> {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const sep = path.includes('?') ? '&' : '?';
    link = `<${base}${path}${sep}page=${page + 1}&per_page=${perPage}>; rel="next", <${base}${path}${sep}page=${lastPage}&per_page=${perPage}>; rel="last"`;
  }
  return { items: slice, link };
}

// ------------------------------------------------------------------ the router

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3. */
  segments: string[];
  query: URLSearchParams;
  /** The raw request body text ('' when there is none). */
  bodyText: string;
  /** The request origin, e.g. http://127.0.0.1:1234, for absolute URLs in replies. */
  base: string;
}

function parseBody(request: RestRequest): { value: Record<string, unknown> } | { error: RestReply } {
  if (request.bodyText.trim() === '') return { value: {} };
  try {
    const parsed: unknown = JSON.parse(request.bodyText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: badRequest('Invalid request body') };
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: { status: 400, body: { message: 'Problems parsing JSON' } } };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function handleRest(request: RestRequest): RestReply {
  const { method, segments, query, base } = request;
  const [s0, s1, s2, s3] = segments;

  // The API root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: `${base}/api/v3/user`,
        repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
        issue_search_url: `${base}/api/v3/search/issues?q={query}`,
        rate_limit_url: `${base}/api/v3/rate_limit`,
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (s0 === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { installed_version: '1.0.0-forge', api_version: '3' } };
  }
  if (s0 === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: userJson() };
  }
  if (s0 === 'rate_limit' && segments.length === 1) {
    return { status: 200, body: { resources: { core: { limit: 5000, remaining: 5000, reset: 1893456000 } }, rate: { limit: 5000, remaining: 5000, reset: 1893456000 } } };
  }

  // The viewer's repository list and creation.
  if (s0 === 'user' && s1 === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const page = paginate(store.viewerRepos(), query, base, '/api/v3/user/repos');
      return { status: 200, body: page.items.map((repo) => repoJson(repo, base)), headers: page.link ? { link: page.link } : {} };
    }
    if (method === 'POST') {
      const parsed = parseBody(request);
      if ('error' in parsed) return parsed.error;
      const name = asString(parsed.value.name);
      if (name === '') return { status: 422, body: { message: 'Validation Failed: name is required' } };
      if (store.findRepo(VIEWER_LOGIN, name)) {
        return { status: 422, body: { message: `name already exists on this account` } };
      }
      const repo = store.createRepo(name, asString(parsed.value.description), parsed.value.private === true);
      if (parsed.value.auto_init === true) {
        const flat = new Map<string, FlatEntry>();
        commitOnBranch(repo, repo.defaultBranch, 'Initial commit', flat);
      }
      return { status: 201, body: repoJson(repo, base) };
    }
    return notFound();
  }

  if (s0 !== 'repos' || s1 === undefined || s2 === undefined) return notFound();
  const repo = store.findRepo(s1, s2);
  if (!repo) return notFound();
  const rest = segments.slice(3);

  // Repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo, base) };
    if (method === 'PATCH') {
      const parsed = parseBody(request);
      if ('error' in parsed) return parsed.error;
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      if (typeof parsed.value.default_branch === 'string' && parsed.value.default_branch !== '') repo.defaultBranch = parsed.value.default_branch;
      repo.updatedAt = nextInstant().iso;
      return { status: 200, body: repoJson(repo, base) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: peelToCommit(repo, repo.refs.get(`refs/heads/${name}`) as string) }, protected: false }));
      return { status: 200, body: branches };
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (!tip) return notFound();
      return { status: 200, body: { name: branch, commit: { sha: peelToCommit(repo, tip) }, protected: false } };
    }
    return notFound();
  }

  // Git refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'POST') {
        const parsed = parseBody(request);
        if ('error' in parsed) return parsed.error;
        const ref = asString(parsed.value.ref);
        const sha = asString(parsed.value.sha);
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
          return { status: 422, body: { message: 'Validation Failed: ref or sha is invalid' } };
        }
        if (repo.refs.has(ref)) return { status: 422, body: { message: 'Reference already exists' } };
        repo.refs.set(ref, sha);
        const obj = repo.objects.get(sha) as { type: string };
        return { status: 201, body: { ref, node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'), object: { sha, type: obj.type } } };
      }
      if (method === 'GET') {
        const all = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
        return { status: 200, body: all };
      }
      return notFound();
    }
    if (method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return notFound();
      return { status: 200, body: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
    }
    return notFound();
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    const startRef = query.get('sha') ?? repo.defaultBranch;
    const start = resolveRef(repo, startRef);
    if (!start) return { status: 200, body: [] };
    const seen = new Set<string>();
    const ordered: string[] = [];
    const stack = [start];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      ordered.push(oid);
      const parents = parseCommit(obj.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
    }
    const page = paginate(ordered, query, base, `/api/v3/repos/${repo.owner}/${repo.name}/commits`);
    const body = page.items.map((oid) => {
      const commit = parseCommit(repo.objects.get(oid)?.data as Buffer);
      const ident = (line: string): { name: string; email: string; date: string } => {
        const match = /^(.*) <(.*)> (\d+) /.exec(line);
        if (!match) return { name: line, email: '', date: nextInstant().iso };
        return { name: match[1], email: match[2], date: new Date(parseInt(match[3], 10) * 1000).toISOString() };
      };
      return {
        sha: oid,
        node_id: Buffer.from(`Commit:${oid}`).toString('base64'),
        commit: {
          author: ident(commit.author),
          committer: ident(commit.committer),
          message: commit.message.replace(/\n$/, ''),
          tree: { sha: commit.tree },
          comment_count: 0,
        },
        author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    return { status: 200, body, headers: page.link ? { link: page.link } : {} };
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return handleContents(request, repo, path);
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') {
        return { status: 200, body: [...repo.labels.values()].map((label) => labelJson(label, repo, base)) };
      }
      if (method === 'POST') {
        const parsed = parseBody(request);
        if ('error' in parsed) return parsed.error;
        const name = asString(parsed.value.name);
        if (name === '') return { status: 422, body: { message: 'Validation Failed: name is required' } };
        if (repo.labels.has(name)) return { status: 422, body: { message: 'Validation Failed: label already exists' } };
        const label: Label = {
          id: store.nextLabelId(),
          name,
          color: asString(parsed.value.color).replace(/^#/, '') || 'ededed',
          description: typeof parsed.value.description === 'string' ? parsed.value.description : null,
        };
        repo.labels.set(name, label);
        return { status: 201, body: labelJson(label, repo, base) };
      }
      return notFound();
    }
    return notFound();
  }

  // Issues and their comments.
  if (rest[0] === 'issues') {
    return handleIssues(request, repo, rest.slice(1));
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    return handlePulls(request, repo, rest.slice(1));
  }

  return notFound();
}

// ------------------------------------------------------------------ contents

function handleContents(request: RestRequest, repo: Repo, path: string): RestReply {
  const { method, query, base } = request;
  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (!tip) return notFound();
    const tree = commitTree(repo, tip);
    if (!tree) return notFound();
    // Walk to the path: a blob answers as a file, a tree as a directory listing.
    const parts = path === '' ? [] : path.split('/');
    let current: string = tree;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tree') return notFound();
      const entry = parseTree(obj.data).find((candidate) => candidate.name === parts[i]);
      if (!entry) return notFound();
      if (i === parts.length - 1) {
        const target = repo.objects.get(entry.oid);
        if (!target) return notFound();
        if (target.type === 'blob') {
          return {
            status: 200,
            body: {
              type: 'file',
              encoding: 'base64',
              content: target.data.toString('base64'),
              sha: entry.oid,
              size: target.data.length,
              name: entry.name,
              path,
            },
          };
        }
        current = entry.oid;
      } else {
        current = entry.oid;
      }
    }
    const dirObj = repo.objects.get(current);
    if (!dirObj || dirObj.type !== 'tree') return notFound();
    const listing = parseTree(dirObj.data).map((entry) => {
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      const target = repo.objects.get(entry.oid);
      return {
        type: isDir ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
        size: !isDir && target ? target.data.length : 0,
      };
    });
    return { status: 200, body: listing };
  }

  if (method === 'PUT' || method === 'DELETE') {
    const parsed = parseBody(request);
    if ('error' in parsed) return parsed.error;
    const branch = typeof parsed.value.branch === 'string' && parsed.value.branch !== '' ? parsed.value.branch : repo.defaultBranch;
    const tip = branchTip(repo, branch);
    if (!tip && branch !== repo.defaultBranch) return notFound();
    const flat = flatAtCommit(repo, tip ? peelToCommit(repo, tip) : null);
    const existing = flat.get(path);
    const message = asString(parsed.value.message) || (method === 'PUT' ? `Update ${path}` : `Delete ${path}`);
    if (method === 'PUT') {
      const shaGiven = typeof parsed.value.sha === 'string' ? parsed.value.sha : null;
      if (existing && shaGiven !== existing.oid) {
        return { status: 409, body: { message: `Conflict: ${path} has changed since the given sha` } };
      }
      if (!existing && shaGiven) return { status: 422, body: { message: 'Validation Failed: sha supplied for a file that does not exist' } };
      const content = typeof parsed.value.content === 'string' ? parsed.value.content : '';
      const blobOid = putObject(repo, 'blob', Buffer.from(content, 'base64'));
      flat.set(path, { oid: blobOid, mode: '100644' });
      const commitSha = commitOnBranch(repo, branch, message, flat);
      if (!commitSha) return notFound();
      const blob = repo.objects.get(blobOid) as { data: Buffer };
      return {
        status: existing ? 200 : 201,
        body: {
          content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: blob.data.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, message },
        },
      };
    }
    // DELETE
    if (!existing) return notFound();
    const shaGiven = typeof parsed.value.sha === 'string' ? parsed.value.sha : null;
    if (shaGiven !== existing.oid) return { status: 409, body: { message: `Conflict: ${path} has changed since the given sha` } };
    flat.delete(path);
    const commitSha = commitOnBranch(repo, branch, message, flat);
    if (!commitSha) return notFound();
    return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
  }
  return notFound();
}

// ------------------------------------------------------------------ issues

function handleIssues(request: RestRequest, repo: Repo, rest: string[]): RestReply {
  const { method, query, base } = request;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      const entries: Array<Record<string, unknown> & { number: number }> = [];
      for (const issue of repo.issues.values()) {
        if (state === 'open' && issue.state !== 'open') continue;
        if (state === 'closed' && issue.state !== 'closed') continue;
        entries.push(issueJson(repo, issue, base) as Record<string, unknown> & { number: number });
      }
      for (const pull of repo.pulls.values()) {
        const pullState = pull.merged || pull.state === 'closed' ? 'closed' : 'open';
        if (state === 'open' && pullState !== 'open') continue;
        if (state === 'closed' && pullState !== 'closed') continue;
        entries.push(pullAsIssueJson(repo, pull, base) as Record<string, unknown> & { number: number });
      }
      entries.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(entries, query, base, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return { status: 200, body: page.items, headers: page.link ? { link: page.link } : {} };
    }
    if (method === 'POST') {
      const parsed = parseBody(request);
      if ('error' in parsed) return parsed.error;
      const title = asString(parsed.value.title);
      if (title === '') return { status: 422, body: { message: 'Validation Failed: title is required' } };
      const labelNames: string[] = [];
      if (Array.isArray(parsed.value.labels)) {
        for (const raw of parsed.value.labels) {
          const name = typeof raw === 'string' ? raw : typeof (raw as { name?: unknown })?.name === 'string' ? (raw as { name: string }).name : '';
          if (name === '' || !repo.labels.has(name)) {
            return { status: 422, body: { message: `Validation Failed: label '${name}' does not exist` } };
          }
          labelNames.push(name);
        }
      }
      const stamp = nextInstant().iso;
      const issue: Issue = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title,
        body: asString(parsed.value.body),
        state: 'open',
        labels: labelNames,
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
        closedAt: null,
      };
      repo.issues.set(issue.number, issue);
      repo.updatedAt = stamp;
      return { status: 201, body: issueJson(repo, issue, base) };
    }
    return notFound();
  }

  const number = parseInt(rest[0], 10);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue) return { status: 200, body: issueJson(repo, issue, base) };
      if (pull) return { status: 200, body: pullAsIssueJson(repo, pull, base) };
      return notFound();
    }
    if (method === 'PATCH') {
      const parsed = parseBody(request);
      if ('error' in parsed) return parsed.error;
      const stamp = nextInstant().iso;
      if (issue) {
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        if (Array.isArray(parsed.value.labels)) {
          const names: string[] = [];
          for (const raw of parsed.value.labels) {
            const name = typeof raw === 'string' ? raw : '';
            if (name === '' || !repo.labels.has(name)) return { status: 422, body: { message: `Validation Failed: label '${name}' does not exist` } };
            names.push(name);
          }
          issue.labels = names;
        }
        if (parsed.value.state === 'closed' || parsed.value.state === 'open') {
          issue.state = parsed.value.state;
          issue.closedAt = parsed.value.state === 'closed' ? stamp : null;
        }
        issue.updatedAt = stamp;
        return { status: 200, body: issueJson(repo, issue, base) };
      }
      if (pull) {
        if (parsed.value.state === 'closed' || parsed.value.state === 'open') {
          pull.state = parsed.value.state;
          pull.closedAt = parsed.value.state === 'closed' ? stamp : null;
        }
        pull.updatedAt = stamp;
        return { status: 200, body: pullAsIssueJson(repo, pull, base) };
      }
      return notFound();
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue && !pull) return notFound();
    if (method === 'GET') {
      const comments = issue ? issue.comments : [];
      return { status: 200, body: comments.map((comment) => commentJson(repo, number, comment, base)) };
    }
    if (method === 'POST') {
      const parsed = parseBody(request);
      if ('error' in parsed) return parsed.error;
      const body = asString(parsed.value.body);
      if (body === '') return { status: 422, body: { message: 'Validation Failed: body is required' } };
      const stamp = nextInstant().iso;
      const comment = { id: store.nextCommentId(), body, createdAt: stamp, updatedAt: stamp };
      if (issue) {
        issue.comments.push(comment);
        issue.updatedAt = stamp;
      }
      return { status: 201, body: commentJson(repo, number, comment, base) };
    }
    return notFound();
  }

  // A label change on one issue (POST /issues/{n}/labels) — supported for completeness.
  if (rest.length === 2 && rest[1] === 'labels' && method === 'POST') {
    if (!issue) return notFound();
    const parsed = parseBody(request);
    if ('error' in parsed) return parsed.error;
    const names = Array.isArray(parsed.value.labels) ? parsed.value.labels : [];
    for (const raw of names) {
      const name = typeof raw === 'string' ? raw : '';
      if (name === '' || !repo.labels.has(name)) return { status: 422, body: { message: `Validation Failed: label '${name}' does not exist` } };
      if (!issue.labels.includes(name)) issue.labels.push(name);
    }
    return { status: 200, body: issue.labels.map((name) => labelJson(repo.labels.get(name) as Label, repo, base)) };
  }

  return notFound();
}

// ------------------------------------------------------------------ pull requests

function handlePulls(request: RestRequest, repo: Repo, rest: string[]): RestReply {
  const { method, query, base } = request;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      const pulls = [...repo.pulls.values()].filter((pull) => {
        if (state === 'all') return true;
        if (state === 'closed') return pull.state === 'closed';
        return pull.state === 'open';
      });
      pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(pulls, query, base, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      return { status: 200, body: page.items.map((pull) => pullJson(repo, pull, base)), headers: page.link ? { link: page.link } : {} };
    }
    if (method === 'POST') {
      const parsed = parseBody(request);
      if ('error' in parsed) return parsed.error;
      const stripOwner = (ref: string): string => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);
      const head = stripOwner(asString(parsed.value.head));
      const baseRef = stripOwner(asString(parsed.value.base));
      const headTip = branchTip(repo, head);
      if (!headTip) return { status: 422, body: { message: `Validation Failed: head branch '${head}' does not exist` } };
      if (!branchTip(repo, baseRef)) return { status: 422, body: { message: `Validation Failed: base branch '${baseRef}' does not exist` } };
      const stamp = nextInstant().iso;
      const pull: Pull = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title: asString(parsed.value.title),
        body: asString(parsed.value.body),
        state: 'open',
        merged: false,
        headRef: head,
        baseRef,
        headSha: peelToCommit(repo, headTip),
        mergeCommitSha: null,
        createdAt: stamp,
        updatedAt: stamp,
        mergedAt: null,
        closedAt: null,
      };
      repo.pulls.set(pull.number, pull);
      return { status: 201, body: pullJson(repo, pull, base) };
    }
    return notFound();
  }

  const number = parseInt(rest[0], 10);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.get(number);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (!pull) return notFound();
      return { status: 200, body: pullJson(repo, pull, base) };
    }
    if (method === 'PATCH') {
      if (!pull) return notFound();
      const parsed = parseBody(request);
      if ('error' in parsed) return parsed.error;
      if (typeof parsed.value.title === 'string') pull.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') pull.body = parsed.value.body;
      if (parsed.value.state === 'closed' || parsed.value.state === 'open') {
        pull.state = parsed.value.state;
        pull.closedAt = parsed.value.state === 'closed' ? nextInstant().iso : null;
      }
      pull.updatedAt = nextInstant().iso;
      return { status: 200, body: pullJson(repo, pull, base) };
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (!pull) return notFound();
    const diff = pullDiff(repo, pull);
    const body = diff.changes.map((change) => ({
      filename: change.path,
      sha: change.afterOid ?? change.beforeOid ?? '',
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    }));
    return { status: 200, body };
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (!pull) return notFound();
    if (pull.merged || pull.state !== 'open') {
      return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    }
    const parsed = parseBody(request);
    if ('error' in parsed) return parsed.error;
    const methodName = typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'squash';
    const message = typeof parsed.value.commit_message === 'string' && parsed.value.commit_message !== '' ? parsed.value.commit_message : undefined;
    const outcome = mergePull(repo, pull, methodName === 'merge' ? 'merge' : 'squash', message);
    if (!outcome.ok) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
  }

  return notFound();
}

// countLines is part of the shared helpers; referenced here so tree-shaking never drops the import.
void countLines;
