// The smart-HTTP wire protocol: ref advertisements, upload-pack (protocol v2 with an v0 fallback)
// and receive-pack (v0). Handlers take a repo and a request body and return the exact bytes of
// the reply; app.ts owns the HTTP framing around them.

import type { Repo } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  isAncestor,
  objectClosure,
  parseCommit,
  parsePktLines,
  parseTag,
  parseTree,
  peelToCommit,
  pktLine,
  readPack,
  sidebandPackets,
  writePack,
} from './git.ts';
import type { GitObject } from './store.ts';

export const UPLOAD_PACK_TYPE = 'application/x-git-upload-pack-advertisement';
export const RECEIVE_PACK_TYPE = 'application/x-git-receive-pack-advertisement';
export const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';
export const RECEIVE_PACK_RESULT = 'application/x-git-receive-pack-result';

const AGENT = 'forge/1.0';

/** Refs in advertisement order: name-sorted, each annotated tag followed by its peeled line. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string; peeled: string | null }> {
  const names = [...repo.refs.keys()].sort();
  return names.map((name) => {
    const oid = repo.refs.get(name) as string;
    const obj = repo.objects.get(oid);
    const peeled = obj && obj.type === 'tag' ? peelToCommit(repo, oid) : null;
    return { name, oid, peeled };
  });
}

function v0Capabilities(repo: Repo, service: string): string {
  const head = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (service === 'git-receive-pack') return `report-status delete-refs side-band-64k ofs-delta agent=${AGENT} ${head}`;
  return `side-band-64k ofs-delta shallow agent=${AGENT} ${head}`;
}

/** The v0 ref advertisement body (also receive-pack's, which is v0 only). */
function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = v0Capabilities(repo, service);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}`);
  } else {
    let capsPending = true;
    if (headOid) {
      lines.push(`${headOid} HEAD\0${caps}`);
      capsPending = false;
    }
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}${capsPending ? `\0${caps}` : ''}`);
      capsPending = false;
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}`);
    }
  }
  for (const line of lines) parts.push(pktLine(line.endsWith(caps) || line.includes('\0') ? line : `${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

export function infoRefs(repo: Repo, service: string, version2: boolean): { contentType: string; body: Buffer } {
  if (service === 'git-upload-pack' && version2) return { contentType: UPLOAD_PACK_TYPE, body: v2Advertisement() };
  return {
    contentType: service === 'git-upload-pack' ? UPLOAD_PACK_TYPE : RECEIVE_PACK_TYPE,
    body: v0Advertisement(repo, service),
  };
}

// ------------------------------------------------------------------ ls-refs (v2)

function lsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
    if (headOid) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`${ZERO_OID} HEAD symref-target:${headRef}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch planning

interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  commonHaves: string[];
}

/**
 * What the client already holds: the closure of its haves, except that a commit it holds as
 * shallow contributes itself and its trees but NOT its parents — it does not have them, however
 * reachable they are in our full history. (A plain closure here would wrongly treat a shallow
 * client's whole ancestry as held and starve a deepen fetch of exactly the commits it asks for.)
 */
function clientClosure(repo: Repo, roots: readonly string[], shallow: ReadonlySet<string>): Set<string> {
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
      stack.push(commit.tree);
      if (!shallow.has(oid)) stack.push(...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).target);
    }
  }
  return seen;
}

// Fetch plans are pure functions of the repo's object set and the request, and objects are
// content-addressed and only ever added — so a plan keyed by (repo, object count, request) can
// be reused verbatim. Concurrent identical clones (the common case) then cost one planning.
const planCache = new Map<string, FetchPlan>();

function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const cacheKey = [
    repo.id,
    repo.objects.size,
    request.wants.join(','),
    request.haves.join(','),
    request.clientShallow.join(','),
    request.depth ?? 'full',
  ].join('|');
  const cached = planCache.get(cacheKey);
  if (cached) return cached;
  const plan = planFetchUncached(repo, request);
  if (planCache.size >= 16) {
    const oldest = planCache.keys().next().value;
    if (oldest !== undefined) planCache.delete(oldest);
  }
  planCache.set(cacheKey, plan);
  return plan;
}

function planFetchUncached(repo: Repo, request: FetchRequest): FetchPlan {
  const havePresent = request.haves.filter((oid) => repo.objects.has(oid));
  const clientShallow = new Set(request.clientShallow);
  const haveClosure = clientClosure(repo, havePresent, clientShallow);
  let included: Set<string>;
  const shallow: string[] = [];
  const unshallow: string[] = [];

  if (request.depth === null) {
    included = objectClosure(repo, request.wants);
    for (const oid of included) if (haveClosure.has(oid)) included.delete(oid);
    // A full fetch completes any shallow boundary it covers.
    for (const oid of clientShallow) {
      if (objectClosure(repo, [oid]).size && request.wants.some((want) => isAncestor(repo, oid, want) || oid === want)) unshallow.push(oid);
    }
  } else {
    const depth = request.depth;
    // Generation numbers over commits, wants at generation 0 (tags peel to their commit).
    const generations = new Map<string, number>();
    const queue: string[] = [];
    const extraRoots: string[] = [];
    for (const want of request.wants) {
      const obj = repo.objects.get(want);
      if (!obj) continue;
      if (obj.type === 'commit') {
        if (!generations.has(want)) {
          generations.set(want, 0);
          queue.push(want);
        }
      } else {
        extraRoots.push(want);
        const commit = peelToCommit(repo, want);
        if (repo.objects.get(commit)?.type === 'commit' && !generations.has(commit)) {
          generations.set(commit, 0);
          queue.push(commit);
        }
      }
    }
    while (queue.length) {
      const oid = queue.shift() as string;
      const gen = generations.get(oid) as number;
      if (gen + 1 >= depth) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!generations.has(parent)) {
          generations.set(parent, gen + 1);
          queue.push(parent);
        }
      }
    }
    const includedCommits = new Set([...generations.keys()].filter((oid) => (generations.get(oid) as number) < depth));
    // Objects: the included commits with their full trees, never crossing into a commit that is
    // not included; tags named as wants ride along.
    included = new Set<string>();
    const stack = [...extraRoots, ...includedCommits];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (included.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit' && !includedCommits.has(oid)) continue;
      included.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        stack.push(commit.tree, ...commit.parents);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).target);
      }
    }
    for (const oid of included) if (haveClosure.has(oid)) included.delete(oid);
    // The new boundary: an included commit whose parent was cut off and is not already held.
    for (const oid of includedCommits) {
      if (!included.has(oid) && !havePresent.includes(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      const cut = parents.some((parent) => !includedCommits.has(parent) && !haveClosure.has(parent) && repo.objects.has(parent));
      if (cut) shallow.push(oid);
    }
    // A shallow commit whose parents are all present now stops being shallow.
    for (const oid of clientShallow) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      const complete = parents.every((parent) => includedCommits.has(parent) || haveClosure.has(parent));
      if (complete && (includedCommits.has(oid) || havePresent.includes(oid))) unshallow.push(oid);
    }
  }

  const objects: GitObject[] = [];
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  // A stable pack order: commits first, then trees, then blobs, then tags, ids ascending inside.
  const rank = (obj: GitObject): number => (obj.type === 'commit' ? 0 : obj.type === 'tree' ? 1 : obj.type === 'blob' ? 2 : 3);
  objects.sort((a, b) => rank(a) - rank(b));
  return { pack: writePack(objects), shallow, unshallow, commonHaves: havePresent };
}

// ------------------------------------------------------------------ upload-pack

function parseFetchArgs(lines: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], clientShallow: [], depth: null };
  for (const line of lines) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = parseInt(line.slice(7).trim(), 10);
  }
  return request;
}

export function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = parsePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  const commandLine = lines.find((line) => line.startsWith('command='));
  const command = commandLine ? commandLine.slice('command='.length) : '';
  const args = lines.filter((line) => line !== commandLine && !line.startsWith('agent=') && !line.startsWith('object-format='));
  if (command === 'ls-refs') return lsRefs(repo, args);
  if (command === 'fetch') {
    const plan = planFetch(repo, parseFetchArgs(args));
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    if (plan.commonHaves.length) {
      for (const have of plan.commonHaves) parts.push(pktLine(`ACK ${have}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
    if (plan.shallow.length || plan.unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(plan.pack));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  return pktLine(`ERR unknown command ${command}\n`);
}

export function uploadPackV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = parsePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const [head, ...rest] = text.split(' ');
    if (head === 'want') lines.push(`want ${rest[0]}`);
    else lines.push(text);
  }
  const plan = planFetch(repo, parseFetchArgs(lines));
  const parts: Buffer[] = [];
  if (plan.commonHaves.length) parts.push(pktLine(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function receivePack(repo: Repo, body: Buffer): Promise<Buffer> {
  const { packets, end } = parsePktLines(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const firstSpace = text.indexOf(' ');
    const secondSpace = text.indexOf(' ', firstSpace + 1);
    if (firstSpace < 0 || secondSpace < 0) continue;
    commands.push({
      oldOid: text.slice(0, firstSpace),
      newOid: text.slice(firstSpace + 1, secondSpace),
      ref: text.slice(secondSpace + 1),
    });
  }
  const packBytes = body.subarray(end);
  const sideband = capabilities.split(' ').includes('side-band-64k');

  let unpackError: string | null = null;
  if (commands.some((command) => command.newOid !== ZERO_OID) && packBytes.length > 0) {
    try {
      const objects = await readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (unpackError) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // A delete.
      if (current === ZERO_OID) results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
      else if (command.oldOid !== current) results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'invalid object' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'reference already exists' });
        continue;
      }
    } else if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    } else {
      // An update: fast-forward only, compared on the commits the refs peel to.
      const oldCommit = peelToCommit(repo, current);
      const newCommit = peelToCommit(repo, command.newOid);
      const oldObj = repo.objects.get(oldCommit);
      const newObj = repo.objects.get(newCommit);
      if (oldObj?.type === 'commit' && newObj?.type === 'commit' && !isAncestor(repo, oldCommit, newCommit)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const reportLines: Buffer[] = [pktLine(unpackError ? `unpack ${unpackError}\n` : 'unpack ok\n')];
  for (const result of results) {
    reportLines.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  const report = Buffer.concat(reportLines);
  if (sideband) {
    // The report stream rides inside band 1, itself pkt-framed, and ends with a flush.
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < report.length) {
      const chunk = report.subarray(offset, offset + 65519 - 1);
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
      offset += chunk.length;
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  return Buffer.concat([report, PKT_FLUSH]);
}
