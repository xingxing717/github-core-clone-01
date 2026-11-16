// main.ts — the forge process's lifecycle, and nothing else.
//
// The trial harness starts this program beside its suite and waits for it
// to announce itself, in this order:
//
//   1. listen on port 0, so the kernel assigns a free port (8080 belongs to
//      the env; binding it, or any fixed port, is not an option);
//   2. POST {"port": <the bound port>} to $MAKEFUN_ENV_URL/register — the
//      env notes the address the request came from and drives the forge at
//      that base URL from then on;
//   3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//      then close the server and exit 0.
//
// Leaving before step 3 — crashing, exiting early, never registering —
// leaves the suite nothing to drive and scores 0, so the waits below are
// patient: transient failures retry with backoff, and only a /register
// answer that breaks the contract itself (400/405) is fatal. The one
// deliberate early exit is a signal: SIGINT/SIGTERM close the server and
// exit 0, which is what a local Ctrl-C during development should do.

import { createApp } from './app.ts';

/** How long a single env request may take before it counts as failed. */
const REQUEST_DEADLINE_MS = 30_000;
/** Retry waits double from the floor to the ceiling, then stay there. */
const BACKOFF_FLOOR_MS = 200;
const BACKOFF_CEILING_MS = 2_000;

function log(line: string): void {
  process.stderr.write(`[main] ${line}\n`);
}

/** Thrown through the waits when a signal asks the process to stop. */
class Shutdown extends Error {}

/**
 * The process's remaining lifetime, ended early by the first SIGINT or
 * SIGTERM. Every wait and request below hangs off this signal, so a stop
 * request interrupts whatever is in flight instead of being noticed late.
 */
const lifetime = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (!lifetime.signal.aborted) {
      log(`received ${signal}; shutting down`);
      lifetime.abort(new Shutdown(signal));
    }
  });
}

function throwIfShutdown(): void {
  if (lifetime.signal.aborted) throw lifetime.signal.reason ?? new Shutdown();
}

/** Sleep for `ms`, but wake at once — throwing Shutdown — if a signal lands. */
function pause(ms: number): Promise<void> {
  throwIfShutdown();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(lifetime.signal.reason ?? new Shutdown());
    };
    const timer = setTimeout(() => {
      lifetime.signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    lifetime.signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The wait after `failures` consecutive failures: doubling, capped. */
function backoff(failures: number): number {
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_FLOOR_MS * 2 ** Math.min(failures, 10));
}

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/**
 * One call to the env, bounded by the request deadline and the process
 * lifetime. A call that cannot be made at all — the env is not up yet, the
 * connection dropped, the deadline hit — comes back null, which callers
 * read as "not yet" and retry. Shutdown is never folded into null: it
 * throws, so a stop request is honoured even mid-retry.
 */
async function callEnv(path: string, init?: RequestInit): Promise<Response | null> {
  throwIfShutdown();
  try {
    return await fetch(`${envBase}${path}`, {
      ...init,
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_DEADLINE_MS), lifetime.signal]),
    });
  } catch {
    throwIfShutdown();
    return null;
  }
}

/**
 * Announce the bound port until the env takes it. 200 means the env
 * recorded us; 409 means an earlier register already won and this one is
 * moot — either way the env knows where a forge lives, so we go on to the
 * done poll. 400 and 405 say the request itself broke the contract, which
 * no retry can fix, so they throw. Anything else — the env still starting,
 * a 5xx, a dropped connection — retries with backoff for as long as it
 * takes: giving up here would score 0.
 */
async function announce(port: number): Promise<void> {
  const body = JSON.stringify({ port });
  for (let failures = 0; ; failures += 1) {
    const res = await callEnv('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (res !== null) {
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      }
    }
    await pause(backoff(failures));
  }
}

/**
 * Poll /done until the env answers {"done": true}. While the env is
 * reachable but still working, the backoff resets after each answer, so
 * the steady poll stays brisk and the end is noticed quickly; while it is
 * unreachable, the wait backs off to the ceiling instead of spinning.
 */
async function untilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    const res = await callEnv('/done');
    if (res !== null && res.ok) {
      const body = (await res.json().catch(() => null)) as { done?: unknown } | null;
      if (body?.done === true) return;
      failures = 0;
    } else {
      failures += 1;
    }
    await pause(backoff(failures));
  }
}

/** Bind, register, wait: the whole life of the process. */
async function run(): Promise<void> {
  if (envBase === '') throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');

  const startedAt = Date.now();
  const server = createApp();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the server bound no ephemeral TCP port');
    }
    log(`forge listening on port ${address.port}`);

    await announce(address.port);
    log('registered; polling the env for done');

    await untilDone();
    log(`env reports done after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } finally {
    server.close();
  }
}

try {
  await run();
  process.exit(0);
} catch (err) {
  if (err instanceof Shutdown || lifetime.signal.aborted) {
    process.exit(0); // a signal asked us to stop: a clean end, not a failure
  }
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
