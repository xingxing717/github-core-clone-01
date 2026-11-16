// rest.ts: the GitHub REST v3 surface under /api/v3 — root, meta, user, repos,
// branches, commits, contents, labels, issues, comments and pull requests.
// Every reply is JSON with an X-GitHub-Request-Id; errors are {message}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { BAD_JSON, JSON_TYPE, isRecord, isoFromSeq, nextRequestId, parseJsonBody, readBody, sendJson } from './http.ts';
import { Forge, type IssueRec, type PullRec, type Repo } from './store.ts';
import { parseCommit } from './gitobj.ts';

const SCOPES = 'repo, read:org';
const INSTALLED_VERSION = 'forge-1.0.0';

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function message(res: ServerResponse, status: number, text: string): void {
  sendJson(res, status, { message: text });
}

// ------------------------------------------------------------------ shapes

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = forge.viewerLogin();
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: owner },
    html_url: `/${owner}/${repo.name}`,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: IssueRec): Record<string, unknown> {
  const id = forge.itemId(repo, issue.number);
  return {
    id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: forge.viewerLogin() },
    comments: issue.comments.length,
    created_at: isoFromSeq(id),
    updated_at: isoFromSeq(id),
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRec): Record<string, unknown> {
  const id = forge.itemId(repo, pull.number);
  const owner = forge.viewerLogin();
  return {
    id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.head,
      sha: forge.branchTip(repo, pull.head) ?? '',
      label: `${owner}:${pull.head}`,
    },
    base: {
      ref: pull.base,
      sha: forge.branchTip(repo, pull.base) ?? '',
      label: `${owner}:${pull.base}`,
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: owner },
    created_at: isoFromSeq(id),
    updated_at: isoFromSeq(id),
  };
}

// ------------------------------------------------------------------ helpers

interface Page {
  page: number;
  perPage: number;
}

/** Paginate a list and emit the Link rel="next" header while more pages exist. */
function paginate<T>(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  items: readonly T[],
  render: (item: T) => unknown,
): void {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URL(url.pathname, `http://${req.headers.host ?? 'localhost'}`);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  sendJson(res, 200, slice.map(render), headers);
}

function bodyObject(raw: Buffer): Record<string, unknown> | null {
  const parsed = parseJsonBody(raw);
  if (parsed === BAD_JSON || parsed === undefined) return null;
  return isRecord(parsed) ? parsed : null;
}

// ------------------------------------------------------------------ handler

export async function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
  // segments: ['api', 'v3', ...]
  const rest = segments.slice(2);
  // DELETE may carry a body (contents delete); read the body for every non-GET method, once.
  const bodyRaw = method === 'GET' ? Buffer.alloc(0) : await readBody(req);

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', user_repositories_url: '/api/v3/user/repos' }, { 'x-oauth-scopes': SCOPES });
      return;
    }
    notFound(res);
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: INSTALLED_VERSION });
    return;
  }

  if (rest[0] === 'user') {
    if (rest.length === 1 && method === 'GET') {
      sendJson(res, 200, { login: forge.viewerLogin(), id: 1, type: 'User' });
      return;
    }
    if (rest[1] === 'repos' && rest.length === 2) {
      if (method === 'GET') {
        paginate(req, url, res, forge.repoList(), (repo) => repoJson(forge, repo));
        return;
      }
      if (method === 'POST') {
        const body = bodyObject(bodyRaw);
        if (body === null) return message(res, 400, 'Problems parsing JSON');
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return message(res, 422, 'name is required');
        const created = forge.createRepo(name, body.private !== false, typeof body.description === 'string' ? body.description : '');
        if (created === null) return message(res, 422, 'name already exists on this account');
        sendJson(res, 201, repoJson(forge, created));
        return;
      }
    }
    notFound(res);
    return;
  }

  if (rest[0] !== 'repos' || rest.length < 3) {
    notFound(res);
    return;
  }

  const owner = rest[1]!;
  const repoName = rest[2]!;
  if (!forge.ownerMatches(owner)) return notFound(res);
  const repo = forge.getRepo(repoName);
  if (repo === undefined) return notFound(res);
  const tail = rest.slice(3);

  // ---- the repository itself
  if (tail.length === 0) {
    if (method === 'GET') return void sendJson(res, 200, repoJson(forge, repo));
    if (method === 'PATCH') {
      const body = bodyObject(bodyRaw);
      if (body === null) return message(res, 400, 'Problems parsing JSON');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return void sendJson(res, 200, repoJson(forge, repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repoName);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    return notFound(res);
  }

  // ---- branches and commits
  if (tail[0] === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return void sendJson(res, 200, branches);
    }
    if (method === 'GET' && tail.length === 2) {
      const sha = forge.branchTip(repo, tail[1]!);
      if (sha === null) return notFound(res);
      return void sendJson(res, 200, { name: tail[1], commit: { sha } });
    }
    return notFound(res);
  }

  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    const tip = shaParam !== null && shaParam !== ''
      ? forge.resolveCommitish(repo, shaParam)
      : forge.branchTip(repo, repo.defaultBranch);
    if (tip === null) return void sendJson(res, 200, []);
    const commits = forge.ancestors(tip).map((oid) => {
      const object = forge.getObject(oid)!;
      const commit = parseCommit(object.data);
      return { sha: oid, commit: { message: commit.message, author: identityOf(commit.author), committer: identityOf(commit.committer) } };
    });
    return void sendJson(res, 200, commits);
  }

  // ---- git refs
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = bodyObject(bodyRaw);
      if (body === null) return message(res, 400, 'Problems parsing JSON');
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (ref === '' || !forge.objects.has(sha)) return message(res, 422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return message(res, 422, 'Reference already exists');
      forge.setRef(repo, ref, sha);
      return void sendJson(res, 201, { ref, object: { sha, type: forge.getObject(sha)?.type ?? 'commit' } });
    }
    if (method === 'GET' && tail.length >= 3) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound(res);
      return void sendJson(res, 200, { ref, object: { sha, type: forge.getObject(sha)?.type ?? 'commit' } });
    }
    return notFound(res);
  }

  // ---- contents
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    return contentsRoute(forge, req, res, url, method, repo, path, bodyRaw);
  }

  // ---- labels
  if (tail[0] === 'labels' && tail.length === 1 && method === 'POST') {
    const body = bodyObject(bodyRaw);
    if (body === null) return message(res, 400, 'Problems parsing JSON');
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return message(res, 422, 'name is required');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    if (!repo.labels.has(name)) repo.labels.set(name, { name, color });
    return void sendJson(res, 201, { name, color });
  }

  // ---- issues
  if (tail[0] === 'issues') {
    return issuesRoute(forge, req, res, url, method, repo, tail.slice(1), bodyRaw);
  }

  // ---- pulls
  if (tail[0] === 'pulls') {
    return pullsRoute(forge, req, res, url, method, repo, tail.slice(1), bodyRaw);
  }

  notFound(res);
}

/** The read workload hammers one issue; cache its serialized body against a field stamp. */
const issueBodyCache = new Map<string, { stamp: string; text: string }>();

function sendIssueCached(forge: Forge, res: ServerResponse, repo: Repo, issue: IssueRec): void {
  const stamp = `${issue.state}|${issue.title}|${issue.body}|${issue.labels.join(',')}|${issue.comments.length}`;
  const key = `${repo.name}#${issue.number}`;
  const hit = issueBodyCache.get(key);
  if (hit !== undefined && hit.stamp === stamp) {
    res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(hit.text), 'x-github-request-id': nextRequestId() });
    res.end(hit.text);
    return;
  }
  const text = JSON.stringify(issueJson(forge, repo, issue));
  if (issueBodyCache.size > 512) issueBodyCache.clear();
  issueBodyCache.set(key, { stamp, text });
  res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': nextRequestId() });
  res.end(text);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function identityOf(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
}

// ------------------------------------------------------------------ contents

async function contentsRoute(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  repo: Repo,
  path: string,
  bodyRaw: Buffer,
): Promise<void> {
  const cleanPath = path.replace(/^\/+|\/+$/g, '');

  if (method === 'GET') {
    const refParam = url.searchParams.get('ref');
    const tip = refParam !== null && refParam !== ''
      ? forge.resolveCommitish(repo, refParam)
      : forge.branchTip(repo, repo.defaultBranch);
    const rootTree = tip === null ? null : forge.commitTree(tip);
    if (cleanPath === '') {
      const entries = forge.listDir(rootTree, '');
      if (entries === null) return void sendJson(res, 200, []);
      return void sendJson(res, 200, entries);
    }
    const blobOid = forge.blobAt(rootTree, cleanPath);
    if (blobOid !== null) {
      const object = forge.getObject(blobOid)!;
      return void sendJson(res, 200, {
        type: 'file',
        name: cleanPath.split('/').pop(),
        path: cleanPath,
        sha: blobOid,
        size: object.data.length,
        encoding: 'base64',
        content: object.data.toString('base64'),
      });
    }
    const entries = forge.listDir(rootTree, cleanPath);
    if (entries !== null) return void sendJson(res, 200, entries);
    return notFound(res);
  }

  if (method === 'PUT') {
    const body = bodyObject(bodyRaw);
    if (body === null) return message(res, 400, 'Problems parsing JSON');
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    const commitMessage = typeof body.message === 'string' ? body.message : 'Update file';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref) ?? null;
    if (tip === null) tip = forge.branchTip(repo, repo.defaultBranch);
    const rootTree = tip === null ? null : forge.commitTree(tip);
    const existing = forge.blobAt(rootTree, cleanPath);
    if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing) {
      return message(res, 409, 'Conflict: the sha does not match the current blob');
    }
    const blobOid = forge.putObject('blob', data);
    const flat = forge.flattenTree(rootTree);
    flat.set(cleanPath, blobOid);
    const tree = forge.treeFromFlat(flat);
    const commit = forge.forgeCommit(repo, tree, tip === null ? [] : [tip], commitMessage);
    forge.setRef(repo, ref, commit);
    return void sendJson(res, existing !== null ? 200 : 201, {
      content: { name: cleanPath.split('/').pop(), path: cleanPath, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commit, message: commitMessage },
    });
  }

  if (method === 'DELETE') {
    const body = bodyObject(bodyRaw);
    if (body === null) return message(res, 400, 'Problems parsing JSON');
    const commitMessage = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    const rootTree = tip === null ? null : forge.commitTree(tip);
    const existing = forge.blobAt(rootTree, cleanPath);
    if (existing === null) return notFound(res);
    if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing) {
      return message(res, 409, 'Conflict: the sha does not match the current blob');
    }
    const flat = forge.flattenTree(rootTree);
    flat.delete(cleanPath);
    const tree = forge.treeFromFlat(flat);
    const commit = forge.forgeCommit(repo, tree, tip === null ? [] : [tip], commitMessage);
    forge.setRef(repo, ref, commit);
    return void sendJson(res, 200, { content: null, commit: { sha: commit, message: commitMessage } });
  }

  notFound(res);
}

// ------------------------------------------------------------------ issues

function issuesRoute(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  repo: Repo,
  tail: string[],
  bodyRaw: Buffer,
): void {
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = bodyObject(bodyRaw);
      if (body === null) return message(res, 400, 'Problems parsing JSON');
      const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return message(res, 422, `Label '${label}' does not exist`);
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        kind: 'issue',
        number,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels,
        comments: [],
        nextCommentId: 1,
      };
      repo.items.set(number, issue);
      forge.itemId(repo, number);
      return void sendJson(res, 201, issueJson(forge, repo, issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      if (sort === 'created' && direction === 'desc') issues.reverse();
      return void paginate(req, url, res, issues, (issue) => issueJson(forge, repo, issue));
    }
    return notFound(res);
  }

  const number = Number(tail[0]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (item === undefined || item.kind !== 'issue') return notFound(res);
  const issue = item;

  if (tail.length === 1) {
    if (method === 'GET') return void sendIssueCached(forge, res, repo, issue);
    if (method === 'PATCH') {
      const body = bodyObject(bodyRaw);
      if (body === null) return message(res, 400, 'Problems parsing JSON');
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return void sendJson(res, 200, issueJson(forge, repo, issue));
    }
    return notFound(res);
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const body = bodyObject(bodyRaw);
      if (body === null) return message(res, 400, 'Problems parsing JSON');
      const comment = { id: issue.nextCommentId, body: typeof body.body === 'string' ? body.body : '' };
      issue.nextCommentId += 1;
      issue.comments.push(comment);
      return void sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: forge.viewerLogin() } });
    }
    if (method === 'GET') {
      return void sendJson(res, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: forge.viewerLogin() } })));
    }
  }

  notFound(res);
}

// ------------------------------------------------------------------ pulls

function pullsRoute(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  repo: Repo,
  tail: string[],
  bodyRaw: Buffer,
): void {
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = bodyObject(bodyRaw);
      if (body === null) return message(res, 400, 'Problems parsing JSON');
      const head = stripOwnerPrefix(typeof body.head === 'string' ? body.head : '');
      const base = stripOwnerPrefix(typeof body.base === 'string' ? body.base : '');
      if (head === '' || base === '' || forge.branchTip(repo, head) === null) {
        return message(res, 422, 'Validation Failed: head branch does not exist');
      }
      if (forge.branchTip(repo, base) === null) return message(res, 422, 'Validation Failed: base branch does not exist');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        kind: 'pull',
        number,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        head,
        base,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.items.set(number, pull);
      forge.itemId(repo, number);
      return void sendJson(res, 201, pullJson(forge, repo, pull));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      return void paginate(req, url, res, pulls, (pull) => pullJson(forge, repo, pull));
    }
    return notFound(res);
  }

  const number = Number(tail[0]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (item === undefined || item.kind !== 'pull') return notFound(res);
  const pull = item;

  if (tail.length === 1 && method === 'GET') {
    return void sendJson(res, 200, pullJson(forge, repo, pull));
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    return void sendJson(res, 200, forge.pullFiles(repo, pull));
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull.merged) return message(res, 405, 'Pull Request is not mergeable: already merged');
    const sha = forge.mergePull(repo, pull);
    if (sha === null) return message(res, 405, 'Pull Request is not mergeable: conflicts must be resolved first');
    return void sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }

  notFound(res);
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}
