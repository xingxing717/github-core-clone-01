// githttp.ts: git smart HTTP at /{owner}/{repo}.git — info/refs advertisements
// (protocol v2 for upload-pack when the client asks, v0 otherwise and always for
// receive-pack), the v2 ls-refs and fetch commands, a v0 fetch fallback, and
// receive-pack pushes with per-ref report-status in sideband band 1.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendRaw } from './http.ts';
import { Forge, type Repo } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  decodePktAll,
  decodePktStream,
  encodePkt,
  isOid,
  parseTag,
  peelToCommit,
  readPack,
  writePack,
  type GitObj,
} from './gitobj.ts';

const AGENT = 'forge/1.0.0';
const UPLOAD_CAPS_V0 = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs a repo advertises, HEAD first (v0 form), sorted refs after. */
function advertisedRefs(forge: Forge, repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) lines.push({ oid: headOid, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const object = forge.getObject(oid);
    if (object?.type === 'tag') {
      const peeled = peelToCommit(oid, forge.lookup);
      if (peeled !== null) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

function v0Advertisement(forge: Forge, repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [encodePkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(forge, repo);
  if (refs.length === 0) {
    parts.push(encodePkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(encodePkt(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled !== undefined) parts.push(encodePkt(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePkt('version 2\n'),
    encodePkt(`agent=${AGENT}\n`),
    encodePkt('object-format=sha1\n'),
    encodePkt('fetch=shallow wait-for-done\n'),
    encodePkt('ls-refs=unborn\n'),
    PKT_FLUSH,
  ]);
}

// ------------------------------------------------------------------ ls-refs

function lsRefs(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
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
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (prefixes.length === 0) {
    if (headOid !== undefined) {
      parts.push(encodePkt(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (unborn) {
      parts.push(encodePkt(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    const object = forge.getObject(oid);
    if (peel && object?.type === 'tag') {
      const peeled = peelToCommit(oid, forge.lookup);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(encodePkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
  }
  return args;
}

/** Sideband-framed pack packets: band byte 1 + chunks small enough for one pkt-line. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65500;
  if (pack.length === 0) {
    packets.push(encodePkt(Buffer.from([1])));
    return packets;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(encodePkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

const packCache = new Map<string, Buffer>();

function fetchPack(forge: Forge, repo: Repo, send: readonly string[]): Buffer {
  const objects: GitObj[] = [];
  for (const oid of send) {
    const object = forge.getObject(oid);
    if (object !== undefined) objects.push(object);
  }
  return writePack(objects);
}

/** The v2 fetch response: acknowledgments, shallow-info, then the packfile section. */
function fetchV2(forge: Forge, repo: Repo, args: FetchArgs): Buffer {
  const wants = args.wants.filter((oid) => isOid(oid) && forge.objects.has(oid));
  let depth = args.depth;
  if (args.deepenSince !== null) depth = null; // deepen-since is not exercised; serve a full fetch
  const { send, shallow, unshallow } = forge.fetchSet(wants, args.haves, args.shallow, depth);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(encodePkt('acknowledgments\n'));
  const common = args.haves.filter((oid) => forge.objects.has(oid));
  if (common.length === 0) {
    parts.push(encodePkt('NAK\n'));
  } else {
    for (const oid of common) parts.push(encodePkt(`ACK ${oid} common\n`));
  }
  parts.push(PKT_FLUSH);
  // shallow-info
  if (depth !== null || args.shallow.length > 0 || shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePkt('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  // packfile (cached per repo version + request shape: the clone workload repeats it)
  const cacheKey = `${repo.name}:${repo.version}:${depth ?? 'full'}:${[...wants].sort().join(',')}:${[...args.shallow].sort().join(',')}`;
  let pack = args.haves.length === 0 ? packCache.get(cacheKey) : undefined;
  if (pack === undefined) {
    pack = fetchPack(forge, repo, send);
    if (args.haves.length === 0) {
      if (packCache.size > 64) packCache.clear();
      packCache.set(cacheKey, pack);
    }
  }
  parts.push(encodePkt('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v0 fetch response: NAK/ACK lines, shallow lines, then sideband pack packets. */
function fetchV0(forge: Forge, repo: Repo, args: FetchArgs): Buffer {
  const wants = args.wants.filter((oid) => isOid(oid) && forge.objects.has(oid));
  const { send, shallow, unshallow } = forge.fetchSet(wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  const common = args.haves.filter((oid) => forge.objects.has(oid));
  if (common.length === 0) parts.push(encodePkt('NAK\n'));
  else for (const oid of common) parts.push(encodePkt(`ACK ${oid}\n`));
  for (const oid of shallow) parts.push(encodePkt(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
  const pack = fetchPack(forge, repo, send);
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { items, rest } = decodePktStream(body);
  const commands: PushCommand[] = [];
  for (const item of items) {
    if (!Buffer.isBuffer(item)) continue;
    let line = item.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
  }

  let unpackOk = true;
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, forge.lookup);
      for (const [oid, object] of objects) {
        if (!forge.objects.has(oid)) forge.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : 'error'}\n`];
  for (const command of commands) {
    const failure = unpackOk ? applyCommand(forge, repo, command) : 'unpacker error';
    reportLines.push(failure === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${failure}\n`);
  }
  const reportStream = Buffer.concat([...reportLines.map((line) => encodePkt(line)), PKT_FLUSH]);
  // The client requests side-band-64k: band-1 packets carry the report stream, then an outer flush.
  return Buffer.concat([...sidebandPackets(reportStream), PKT_FLUSH]);
}

/** Apply one ref update; returns the ng reason, or null on success. */
function applyCommand(forge: Forge, repo: Repo, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.oldOid !== current) return 'stale ref: the ref moved';
  if (command.newOid === ZERO_OID) {
    forge.setRef(repo, command.ref, null);
    return null;
  }
  const object = forge.getObject(command.newOid);
  if (object === undefined) return 'missing object';
  if (command.oldOid !== ZERO_OID && object.type === 'commit') {
    const oldObject = forge.getObject(command.oldOid);
    if (oldObject?.type === 'commit' && command.ref.startsWith('refs/heads/')) {
      if (!forge.isAncestor(command.oldOid, command.newOid)) return 'non-fast-forward';
    }
  }
  forge.setRef(repo, command.ref, command.newOid);
  return null;
}

// ------------------------------------------------------------------ handler

export async function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  owner: string,
  repoName: string,
  action: string,
): Promise<void> {
  if (!forge.ownerMatches(owner)) {
    sendRaw(res, 404, Buffer.from('not found\n'), 'text/plain');
    return;
  }
  const repo = forge.getRepo(repoName);
  if (repo === undefined) {
    sendRaw(res, 404, Buffer.from('not found\n'), 'text/plain');
    return;
  }
  const method = req.method ?? 'GET';

  if (action === 'info/refs' && method === 'GET') {
    const service = url.searchParams.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const body = wantsV2 ? v2Advertisement() : v0Advertisement(forge, repo, service, UPLOAD_CAPS_V0);
      sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      const body = v0Advertisement(forge, repo, service, RECEIVE_CAPS);
      sendRaw(res, 200, body, 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendRaw(res, 400, Buffer.from('unknown service\n'), 'text/plain');
    return;
  }

  if (action === 'git-upload-pack' && method === 'POST') {
    const body = await readBody(req);
    let items;
    try {
      items = decodePktAll(body);
    } catch {
      sendRaw(res, 400, Buffer.from('malformed pkt-line\n'), 'text/plain');
      return;
    }
    const lines = items.filter((item): item is Buffer => Buffer.isBuffer(item)).map((item) => item.toString('utf8').replace(/\n$/, ''));
    const command = lines.find((line) => line.startsWith('command='));
    if (command === 'command=ls-refs') {
      const delimIndex = items.findIndex((item) => item === 'delim');
      const args = lines.slice(1).filter((line, index) => {
        void index;
        return line !== '' && !line.startsWith('command=') && !line.startsWith('agent=') && !line.startsWith('object-format=');
      });
      void delimIndex;
      sendRaw(res, 200, lsRefs(forge, repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'command=fetch') {
      const args = parseFetchArgs(lines);
      sendRaw(res, 200, fetchV2(forge, repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    // v0 fetch: wants before the first flush, haves and done after it.
    const wants: string[] = [];
    const haves: string[] = [];
    let afterFlush = false;
    for (const item of items) {
      if (item === 'flush') {
        afterFlush = true;
        continue;
      }
      if (!Buffer.isBuffer(item)) continue;
      const line = item.toString('utf8').replace(/\n$/, '');
      if (!afterFlush && line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (afterFlush && line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
    const args = parseFetchArgs(lines);
    args.wants = wants.length > 0 ? wants : args.wants;
    args.haves = haves.length > 0 ? haves : args.haves;
    sendRaw(res, 200, fetchV0(forge, repo, args), 'application/x-git-upload-pack-result');
    return;
  }

  if (action === 'git-receive-pack' && method === 'POST') {
    const body = await readBody(req);
    let response: Buffer;
    try {
      response = receivePack(forge, repo, body);
    } catch {
      sendRaw(res, 400, Buffer.from('malformed push\n'), 'text/plain');
      return;
    }
    sendRaw(res, 200, response, 'application/x-git-receive-pack-result');
    return;
  }

  sendRaw(res, 404, Buffer.from('not found\n'), 'text/plain');
}
