// app.ts: the forge's HTTP server. Routes the four surfaces — REST v3 under
// /api/v3, GraphQL at /api/graphql, MCP at /mcp, git smart HTTP at
// /{owner}/{repo}.git — behind the one bearer token, plus the /healthz boot
// probe. main.ts owns the lifecycle; this file is the whole surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { authorized, sendJson } from './http.ts';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(forge, req, res).catch((error: unknown) => {
      // A malformed request must never take the server down.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: `internal error: ${error instanceof Error ? error.message : String(error)}` });
        else res.end();
      } catch {
        // the socket is gone; the next request is unaffected
      }
    });
  });
  return server;
}

async function route(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const gitMatch = GIT_PATH.exec(path);
  const isApi = path === '/api/v3' || path.startsWith('/api/v3/') || path === '/api/graphql' || path === '/mcp';

  if (gitMatch === null && !isApi) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Every surface but /healthz requires the suite's bearer token.
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]!);
    const repo = decodeSegment(gitMatch[2]!);
    await handleGit(forge, req, res, url, owner, repo, gitMatch[3]!);
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    await handleGraphQL(forge, req, res);
    return;
  }

  if (path === '/mcp') {
    await handleMcp(forge, req, res);
    return;
  }

  await handleRest(forge, req, res, url);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
