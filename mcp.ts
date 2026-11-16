// mcp.ts: the MCP endpoint at /mcp — JSON-RPC 2.0 over Streamable HTTP.
// Speaks the 2026-07-28 revision (server/discover with supportedVersions) and the
// legacy initialize handshake. Six tools act on the same store as REST, and
// tools/list is a fixed array so two calls answer byte for byte.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { BAD_JSON, isRecord, parseJsonBody, readBody, sendJson } from './http.ts';
import { Forge, type Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the token user', {
    name: { type: 'string', description: 'The repository name' },
    description: { type: 'string', description: 'The repository description' },
    private: { type: 'boolean', description: 'Whether the repository is private' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name', {
    owner: { type: 'string', description: 'The repository owner login' },
    repo: { type: 'string', description: 'The repository name' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository', {
    owner: { type: 'string', description: 'The repository owner login' },
    repo: { type: 'string', description: 'The repository name' },
    title: { type: 'string', description: 'The issue title' },
    body: { type: 'string', description: 'The issue body' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository', {
    owner: { type: 'string', description: 'The repository owner login' },
    repo: { type: 'string', description: 'The repository name' },
    state: { type: 'string', description: 'open, closed or all' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch', {
    owner: { type: 'string', description: 'The repository owner login' },
    repo: { type: 'string', description: 'The repository name' },
    title: { type: 'string', description: 'The pull request title' },
    body: { type: 'string', description: 'The pull request body' },
    head: { type: 'string', description: 'The head branch name' },
    base: { type: 'string', description: 'The base branch name' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request by number (squash)', {
    owner: { type: 'string', description: 'The repository owner login' },
    repo: { type: 'string', description: 'The repository name' },
    pull_number: { type: 'number', description: 'The pull request number' },
  }, ['owner', 'repo', 'pull_number']),
];

const TOOLS_BY_NAME = new Map(TOOLS.map((def) => [def.name, def]));

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolText(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const result: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

function findRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== '' && !forge.ownerMatches(owner)) return null;
  return forge.getRepo(repoName) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const def = TOOLS_BY_NAME.get(name);
  if (def === undefined) return { error: { code: -32602, message: `unknown tool: ${name}` } };
  const schema = def.inputSchema as { required?: string[] };
  const missing = (schema.required ?? []).filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return { result: toolText(`missing required argument(s): ${missing.join(', ')}`, true) };
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const created = forge.createRepo(repoName, args.private !== false, typeof args.description === 'string' ? args.description : '');
      const repo = created ?? forge.getRepo(repoName)!;
      return { result: toolText(repoJson(forge, repo)) };
    }
    case 'get_repo': {
      const repo = findRepo(forge, args);
      if (repo === null) return { result: toolText(`repository not found: ${String(args.owner)}/${String(args.repo)}`, true) };
      return { result: toolText(repoJson(forge, repo)) };
    }
    case 'create_issue': {
      const repo = findRepo(forge, args);
      if (repo === null) return { result: toolText('repository not found', true) };
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue = {
        kind: 'issue' as const,
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [],
        nextCommentId: 1,
      };
      repo.items.set(number, issue);
      forge.itemId(repo, number);
      return { result: toolText(issueJson(forge, repo, issue)) };
    }
    case 'list_issues': {
      const repo = findRepo(forge, args);
      if (repo === null) return { result: toolText('repository not found', true) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.items.values()]
        .filter((item) => item.kind === 'issue')
        .filter((item) => state === 'all' || item.state === state)
        .map((item) => issueJson(forge, repo, item));
      return { result: toolText(issues) };
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === null) return { result: toolText('repository not found', true) };
      const head = String(args.head);
      const base = String(args.base);
      if (forge.branchTip(repo, head) === null || forge.branchTip(repo, base) === null) {
        return { result: toolText(`head or base branch does not exist: ${head} -> ${base}`, true) };
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull = {
        kind: 'pull' as const,
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
        state: 'open' as const,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.items.set(number, pull);
      forge.itemId(repo, number);
      return { result: toolText(pullJson(forge, repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === null) return { result: toolText('repository not found', true) };
      const number = Number(args.pull_number);
      const item = repo.items.get(number);
      if (item === undefined || item.kind !== 'pull') return { result: toolText(`pull request #${number} not found`, true) };
      if (!item.merged) {
        const sha = forge.mergePull(repo, item);
        if (sha === null) return { result: toolText(`pull request #${number} is not mergeable`, true) };
      }
      return { result: toolText(pullJson(forge, repo, item)) };
    }
    default:
      return { error: { code: -32602, message: `unknown tool: ${name}` } };
  }
}

function handleRpc(forge: Forge, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // a notification: no JSON-RPC response
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const outcome = callTool(forge, name, args);
      if (outcome.error !== undefined) return rpcError(id, outcome.error.code, outcome.error.message);
      return rpcResult(id, outcome.result);
    }
    default:
      if (id === undefined) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' || req.method === 'DELETE') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (parsed === BAD_JSON || parsed === undefined) {
    // A body that is not JSON: HTTP 400 with a JSON-RPC parse error.
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => (isRecord(entry) ? handleRpc(forge, entry) : null)).filter((entry) => entry !== null);
    sendJson(res, 200, results);
    return;
  }
  if (!isRecord(parsed)) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
    return;
  }
  const result = handleRpc(forge, parsed);
  if (result === null) {
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
    res.end('');
    return;
  }
  sendJson(res, 200, result);
}
