// The git object model and the smart-HTTP wire protocol, implemented in-process on node:crypto
// and node:zlib: no git binary exists in the trial pod. Objects are SHA-1 addressed, packs are
// version 2 with plain (undelta'd) objects on the way out and full delta resolution on the way in.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const TYPE_NUMBERS: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUMBER_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ------------------------------------------------------------------ object ids and parsing

/** The SHA-1 of an object's canonical stored form. */
export function objectId(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object in a repo and return its id (idempotent). */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const split = data.indexOf('\n\n');
  const head = (split < 0 ? data : data.subarray(0, split)).toString('utf8');
  const message = split < 0 ? '' : data.subarray(split + 2).toString('utf8');
  const commit: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

export function buildCommitData(input: {
  tree: string;
  parents: readonly string[];
  name: string;
  email: string;
  unix: number;
  message: string;
}): Buffer {
  const ident = `${input.name} <${input.email}> ${input.unix} +0000`;
  let head = `tree ${input.tree}\n`;
  for (const parent of input.parents) head += `parent ${parent}\n`;
  head += `author ${ident}\ncommitter ${ident}\n\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(input.message, 'utf8')]);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.subarray(pos, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories compared as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  target: string;
  targetType: string;
  name: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const split = data.indexOf('\n\n');
  const head = (split < 0 ? data : data.subarray(0, split)).toString('utf8');
  const tag: ParsedTag = { target: '', targetType: '', name: '', tagger: '', message: split < 0 ? '' : data.subarray(split + 2).toString('utf8') };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) tag.target = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.targetType = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag.name = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  return tag;
}

/** Follow tag objects until a non-tag object; returns that object's id (or the input). */
export function peelTo(repo: Repo, oid: string, want: GitObjectType): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type === want || obj.type !== 'tag') return current;
    current = parseTag(obj.data).target;
  }
  return current;
}

export function peelToCommit(repo: Repo, oid: string): string {
  return peelTo(repo, oid, 'commit');
}

// ------------------------------------------------------------------ graph walks

/** Every commit reachable from `start` through parents (start included), tags peeled. */
export function commitAncestors(repo: Repo, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [peelToCommit(repo, start)];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  // The same reachability question commitAncestors answers, but walking parents from the
  // descendant and stopping the moment the target commit is reached — the common case (the
  // target is the descendant's parent) costs one step instead of the whole history. Only
  // commits count, exactly as in commitAncestors' set: a missing or non-commit id on the
  // walk is skipped, never matched.
  const target = peelToCommit(repo, ancestor);
  const seen = new Set<string>();
  const stack = [peelToCommit(repo, descendant)];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (oid === target) return true;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** The nearest common ancestor of two commits, or null when they share no history. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfA = commitAncestors(repo, a);
  const seen = new Set<string>();
  const queue = [peelToCommit(repo, b)];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** The full object closure of the given roots: commits with their trees, blobs and history. */
export function objectClosure(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).target);
    }
  }
  return seen;
}

// ------------------------------------------------------------------ trees as flat path maps

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Every blob in a tree, keyed by its slash-separated path. */
export function flattenTree(repo: Repo, treeOid: string | null): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (treeOid) walk(treeOid, '');
  return out;
}

/** Write a flat path map back into nested tree objects; returns the root tree id. */
export function treeFromFlat(repo: Repo, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Dir {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i], next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1], entry);
  }
  const write = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: write(sub) });
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    return putObject(repo, 'tree', buildTreeData(entries));
  };
  return write(root);
}

/** The tree id of a commit (or of a tag's commit), or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(peelToCommit(repo, commitOid));
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  beforeOid: string | null;
  afterOid: string | null;
}

/** Path-level differences between two flat tree maps. */
export function diffFlat(before: ReadonlyMap<string, FlatEntry>, after: ReadonlyMap<string, FlatEntry>): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, entry] of after) {
    const old = before.get(path);
    if (!old) changes.push({ path, status: 'added', beforeOid: null, afterOid: entry.oid });
    else if (old.oid !== entry.oid) changes.push({ path, status: 'modified', beforeOid: old.oid, afterOid: entry.oid });
  }
  for (const [path, entry] of before) {
    if (!after.has(path)) changes.push({ path, status: 'removed', beforeOid: entry.oid, afterOid: null });
  }
  changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return changes;
}

/** Line counts of a blob (a final line without a newline still counts). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/**
 * Added/deleted line counts between two blob versions, by a longest-common-subsequence over
 * lines. Contents in this forge are small; a generous cap keeps a pathological pair cheap.
 */
export function lineDiffCounts(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const a = before === null ? [] : before.toString('utf8').split('\n');
  const b = after === null ? [] : after.toString('utf8').split('\n');
  if (a.length * b.length > 4_000_000) {
    return { additions: after === null ? 0 : countLines(after), deletions: before === null ? 0 : countLines(before) };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(dp[j], dp[j - 1]);
      diagonal = above;
    }
  }
  const common = dp[b.length];
  const aLines = before === null ? 0 : countLines(before);
  const bLines = after === null ? 0 : countLines(after);
  const lcsLines = Math.min(common, aLines, bLines);
  return { additions: Math.max(0, bLines - lcsLines), deletions: Math.max(0, aLines - lcsLines) };
}

// ------------------------------------------------------------------ packfiles

function packObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack holding the given objects whole (no deltas), with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    parts.push(packObjectHeader(TYPE_NUMBERS[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Adler-32 of `data` (RFC 1950): the checksum every zlib stream carries as its last 4 bytes. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  // The sums are reduced every NMAX bytes (the classic zlib bound); JS doubles stay exact
  // far past it, so the result is the same as reducing on every byte.
  const NMAX = 5552;
  for (let i = 0; i < data.length; ) {
    const end = Math.min(i + NMAX, data.length);
    for (; i < end; i += 1) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate the zlib stream starting at `offset`, finding its exact length: inflateSync ignores
 * trailing bytes past the stream's end and throws on any shorter prefix, so the shortest
 * prefix that inflates is the stream itself. (Node's synchronous zlib exposes no consumed-byte
 * count, so the stream's end has to be measured from the bytes: the first probe inflates a
 * guessed length, the stream's own Adler-32 trailer then marks the end — see below — and a
 * binary search over prefix lengths covers every case the trailer does not settle.)
 * When `streamEnd` is given (the pack's last entry, whose stream ends where the pack's SHA-1
 * trailer begins) the length is already known and a single inflate suffices.
 *
 * The search's shorter probes throw by design, and constructing those errors is the expensive
 * part (V8 builds a stack trace for each). Error.stackTraceLimit is therefore 0 for the
 * duration of this call and restored on exit; the probe errors are discarded unread, and
 * callers only ever read `.message` from the errors this function throws itself.
 */
function inflateAt(pack: Buffer, offset: number, expectedSize: number, streamEnd?: number): { out: Buffer; consumed: number } {
  const traceLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    if (streamEnd !== undefined) {
      let out: Buffer;
      try {
        out = inflateSync(pack.subarray(offset, streamEnd));
      } catch {
        throw new Error('pack entry does not inflate');
      }
      if (out.length !== expectedSize) throw new Error('pack entry does not inflate');
      return { out, consumed: streamEnd - offset };
    }
    const remaining = pack.length - offset;
    const tryLength = (length: number): Buffer | null => {
      try {
        const out = inflateSync(pack.subarray(offset, offset + length));
        return out.length === expectedSize ? out : null;
      } catch {
        return null;
      }
    };
    // The compressed form is rarely larger than the plain data plus wrapper overhead; probe
    // there first, then fall back to a binary search over the rest of the pack.
    let hi = Math.min(remaining, expectedSize + Math.ceil(expectedSize / 65535) * 5 + 64);
    let found = tryLength(hi);
    if (found === null) {
      hi = remaining;
      found = tryLength(hi);
      if (found === null) throw new Error('pack entry does not inflate');
    }
    // Fast path: the stream ends with the Adler-32 of its output, and a probe only succeeds
    // when that trailer checks out (zlib validates it at the stream's end), so the stream's
    // exact end is the first position at or before `hi` where the output's Adler-32 bytes sit
    // AND a probe at that length succeeds — exactly the shortest succeeding prefix the binary
    // search below finds, at the cost of one verification probe instead of ~log2(hi) of them.
    // (Native git's index-pack and isomorphic-git read this same boundary off the inflate
    // stream's avail_in accounting; node's synchronous zlib has no such counter, so the
    // trailer itself is the marker.) A candidate that does not verify — the checksum's bytes
    // occurring inside the compressed data — is skipped, and no candidate at all falls
    // through to the search, so the result is the search's result in every case.
    const trailer = Buffer.alloc(4);
    trailer.writeUInt32BE(adler32(found), 0);
    const lastStart = offset + hi - 4;
    for (let at = pack.indexOf(trailer, offset + 2); at >= 0 && at <= lastStart; at = pack.indexOf(trailer, at + 1)) {
      if (tryLength(at + 4 - offset) !== null) return { out: found, consumed: at + 4 - offset };
    }
    // The shortest succeeding prefix is the stream; `found` always holds the output at `hi`.
    let lo = 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const midOut = tryLength(mid);
      if (midOut !== null) {
        hi = mid;
        found = midOut;
      } else lo = mid + 1;
    }
    return { out: found, consumed: lo };
  } finally {
    Error.stackTraceLimit = traceLimit;
  }
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  readVarint(); // source size (the base's length; trusted)
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos]; pos += 1; }
      if (op & 0x02) { offset |= delta[pos] << 8; pos += 1; }
      if (op & 0x04) { offset |= delta[pos] << 16; pos += 1; }
      if (op & 0x08) { offset |= delta[pos] << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos]; pos += 1; }
      if (op & 0x20) { size |= delta[pos] << 8; pos += 1; }
      if (op & 0x40) { size |= delta[pos] << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error(`delta produced ${out.length} bytes, expected ${targetSize}`);
  return out;
}

interface RawPackEntry {
  typeNum: number;
  data: Buffer;
  baseOid: string | null;
  baseStart: number;
  start: number;
}

/**
 * Read a pack into whole objects, resolving REF_DELTA and OFS_DELTA against the pack itself and
 * `resolveExternal` (a thin pack's bases, which live in the receiving repo). Returns id -> object.
 */
export function readPack(
  pack: Buffer,
  resolveExternal: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  const count = pack.readUInt32BE(8);
  const raw: RawPackEntry[] = [];
  const byStart = new Map<number, number>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const typeNum = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseStart = -1;
    if (typeNum === 6) {
      let c = pack[offset];
      offset += 1;
      let back = c & 0x7f;
      while (c & 0x80) {
        c = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (c & 0x7f);
      }
      baseStart = start - back;
    } else if (typeNum === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // The last entry's stream ends exactly where the pack's SHA-1 trailer begins.
    const inflated = i === count - 1 ? inflateAt(pack, offset, size, pack.length - 20) : inflateAt(pack, offset, size);
    offset += inflated.consumed;
    byStart.set(start, raw.length);
    raw.push({ typeNum, data: inflated.out, baseOid, baseStart, start });
  }
  const resolved: Array<GitObject | null> = raw.map(() => null);
  const out = new Map<string, GitObject>();
  const resolveIndex = (index: number): GitObject => {
    const memo = resolved[index];
    if (memo) return memo;
    const entry = raw[index];
    let obj: GitObject;
    if (entry.typeNum === 6 || entry.typeNum === 7) {
      let base: GitObject | undefined;
      if (entry.typeNum === 6) {
        const baseIndex = byStart.get(entry.baseStart);
        if (baseIndex === undefined) throw new Error('ofs-delta base is not in the pack');
        base = resolveIndex(baseIndex);
      } else {
        const baseOid = entry.baseOid as string;
        base = out.get(baseOid) ?? resolveExternal(baseOid);
        if (!base) throw new Error(`ref-delta base ${baseOid} is not available`);
      }
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      obj = { type: NUMBER_TYPES[entry.typeNum], data: entry.data };
    }
    resolved[index] = obj;
    out.set(objectId(obj.type, obj.data), obj);
    return obj;
  };
  for (let i = 0; i < raw.length; i += 1) resolveIndex(i);
  return out;
}

// ------------------------------------------------------------------ pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse pkt-lines from `buffer` starting at `start`; returns the packets and the offset after them. */
export function parsePktLines(buffer: Buffer, start = 0): { packets: PktPacket[]; end: number } {
  const packets: PktPacket[] = [];
  let pos = start;
  while (pos + 4 <= buffer.length) {
    const hex = buffer.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, end: pos };
}

/** Wrap pack bytes in side-band-64k packets: band 1 carries the data. */
export function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const packets: Buffer[] = [];
  // A pkt-line is at most 65520 bytes framed: 4 of length prefix, 1 of band byte, so a band
  // carries at most 65515 bytes of payload per packet.
  const MAX_CHUNK = 65515;
  for (let offset = 0; offset < data.length; offset += MAX_CHUNK) {
    const chunk = data.subarray(offset, offset + MAX_CHUNK);
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([band])));
  return packets;
}
