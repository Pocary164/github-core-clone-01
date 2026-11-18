// The HTTP shell: one node:http server routing the four surfaces — git smart HTTP under
// /{owner}/{repo}.git, REST under /api/v3, GraphQL at /api/graphql, MCP at /mcp — plus the
// unauthenticated /healthz probe. Every surface sits behind the bearer-token check: the token
// names the viewer, and a repository under any other owner is a 404, never a 403.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { RECEIVE_PACK_RESULT, UPLOAD_PACK_RESULT, infoRefs, receivePack, uploadPackV0, uploadPackV2 } from './protocol.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(36)}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extraHeaders?: Record<string, string>): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId,
    ...(extraHeaders ?? {}),
  });
  res.end(payload);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-cache' });
  res.end(body);
}

const GIT_PATH = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function route(req: IncomingMessage, res: ServerResponse, token: string | undefined): Promise<void> {
  const requestId = nextRequestId();
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The health probe is the one unauthenticated route.
  if (path === '/healthz') {
    sendJson(res, 200, { ok: true }, requestId);
    return;
  }

  if (token) {
    const header = req.headers.authorization ?? '';
    if (header !== `Bearer ${token}`) {
      sendJson(res, 401, { message: 'Bad credentials' }, requestId);
      return;
    }
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    const body = await readBody(req);
    const reply = handleGraphQL(body.toString('utf8'));
    sendJson(res, reply.status, reply.body, requestId);
    return;
  }

  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed: MCP here is POST only' } }, requestId);
      return;
    }
    const body = await readBody(req);
    const reply = handleMcp(body.toString('utf8'));
    if (reply.body === undefined) {
      res.writeHead(reply.status, { 'x-github-request-id': requestId });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body, requestId);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    const host = req.headers.host ?? '127.0.0.1';
    const reply = handleRest({ method, segments, query: url.searchParams, bodyText: body.toString('utf8'), base: `http://${host}` });
    sendJson(res, reply.status, reply.body, requestId, reply.headers);
    return;
  }

  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const endpoint = gitMatch[3];
    const repo = store.findRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    if (endpoint === 'info/refs') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Bad Request: unknown service' }, requestId);
        return;
      }
      const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const advertisement = infoRefs(repo, service, version2);
      sendBytes(res, 200, advertisement.body, advertisement.contentType);
      return;
    }
    const body = await readBody(req);
    if (endpoint === 'git-upload-pack') {
      const headerSaysV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const bodySaysV2 = body.includes('command=');
      const reply = headerSaysV2 || bodySaysV2 ? uploadPackV2(repo, body) : uploadPackV0(repo, body);
      sendBytes(res, 200, reply, UPLOAD_PACK_RESULT);
      return;
    }
    const reply = await receivePack(repo, body);
    sendBytes(res, 200, reply, RECEIVE_PACK_RESULT);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, requestId);
}

/** Build the forge's HTTP server. `token` is the bearer token every surface but /healthz requires. */
export function createApp(token: string | undefined): Server {
  const server = createServer((req, res) => {
    route(req, res, token).catch(() => {
      // A handler failure must never take the server down: answer 500 and stay up.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, nextRequestId());
        else res.end();
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
  return server;
}
