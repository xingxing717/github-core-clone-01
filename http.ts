// http.ts: shared HTTP plumbing — body reading, JSON replies with the request-id
// header every REST reply carries, bearer auth, and deterministic timestamps.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { EPOCH_SEC } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The token the suite presents; empty in local dev means "no auth configured". */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

export function authorized(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

let requestSeq = 0;

/** A deterministic, non-empty request id (a counter, never the clock). */
export function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(36).padStart(6, '0')}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

/** Read a whole request body (packs included) as one buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; `undefined` for an empty body, the symbol BAD_JSON for a malformed one. */
export const BAD_JSON: unique symbol = Symbol('bad-json');

export function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return BAD_JSON;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isoCache = new Map<number, string>();

/** An ISO timestamp derived from a deterministic sequence number, never the wall clock. */
export function isoFromSeq(seq: number): string {
  let iso = isoCache.get(seq);
  if (iso === undefined) {
    iso = new Date((EPOCH_SEC + seq) * 1000).toISOString();
    isoCache.set(seq, iso);
  }
  return iso;
}
