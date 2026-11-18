// The forge's in-memory store: one process, one store, four surfaces (git smart HTTP, REST v3,
// GraphQL v4, MCP) all reading and writing the same objects, so an id means the same thing on
// every surface.
//
// Determinism: nothing here reads the wall clock or a random source. Timestamps come from a
// logical clock seeded by MAKEFUN_TRIAL_NOW (the trial's opening instant, the only "now" a trial
// may carry) and advanced by a counter, and every id is a counter or a content hash, so two runs
// that receive the same requests produce the same bytes.

/** The one login the trial's bearer token names (the scenario viewer in wire.ts). */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's numeric id, as the scenario generates it. */
export const VIEWER_ID = 1000;
/** The viewer's display name and e-mail, used for commits this forge authors itself. */
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

// ------------------------------------------------------------------ logical clock

const TRIAL_NOW_MS = ((): number => {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.UTC(2025, 0, 1, 0, 0, 0);
})();

let tickCount = 0;

/** The next logical instant, one second after the previous one handed out. */
export function nextInstant(): { iso: string; unix: number } {
  const ms = TRIAL_NOW_MS + tickCount * 1000;
  tickCount += 1;
  return { iso: new Date(ms).toISOString(), unix: Math.floor(ms / 1000) };
}

// ------------------------------------------------------------------ git objects

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

// ------------------------------------------------------------------ domain records

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  /** The global REST id (unique across the forge). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
}

export interface Repo {
  /** The numeric database id (GraphQL databaseId, REST id). */
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** Every git object this repository holds, by sha1 hex. */
  objects: Map<string, GitObject>;
  /** Full ref names ('refs/heads/main') to the object id they point at. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
}

// ------------------------------------------------------------------ the store

export class Store {
  repos: Map<string, Repo> = new Map();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private labelSeq = 0;

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const stamp = nextInstant().iso;
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      owner: VIEWER_LOGIN,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: stamp,
      updatedAt: stamp,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(Store.key(repo.owner, name), repo);
    return repo;
  }

  /** A repository only ever answers under its owner's login: any other owner is "not found". */
  findRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(Store.key(owner, name)) ?? null;
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(Store.key(owner, name));
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  nextLabelId(): number {
    this.labelSeq += 1;
    return this.labelSeq;
  }
}

/** The process-wide store the four surfaces share. */
export const store = new Store();
