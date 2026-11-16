# Anvil — a standalone GitHub-compatible git forge

[![competition](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/xingxing717/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/xingxing717/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

Anvil is a GitHub-compatible git forge implemented as a single dependency-free
Node 22 program — standard library only, no packages, and no `git` binary: the
git object model, packfiles and wire protocols are implemented in its own code.
One process serves four surfaces over a single shared in-memory store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 upload-pack
  (`version 2` advertisement, `ls-refs`, fetch) with a v0 fallback, and v0
  receive-pack with per-ref report-status. Pushes are fast-forward only; a
  non-fast-forward update is refused per ref while the rest of the push still
  applies.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests, including squash merges.
- **GraphQL** at `/api/graphql` — viewer and repository queries, `__type`
  introspection, issue/pull-request connections with cursor pagination,
  `node(id:)` lookups, mutations, and batched request bodies.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP (the 2026-07-28
  revision via `server/discover`, plus the legacy `initialize` handshake),
  with six tools — create/get repository, create/list issues, create/merge
  pull request — acting on the same store as the other surfaces, so an object
  created through one surface reads back identically through the rest.

Every surface except the `/healthz` boot probe sits behind one bearer token;
a repository that does not exist, or that belongs to another owner, answers
404, and a missing token answers 401.

The forge is deterministic: every id, counter and timestamp it produces is a
function of the request sequence it has served. Forge-made commits (such as
squash merges) take their timestamps from a per-repo counter over a fixed
epoch rather than the wall clock, so replaying the same request sequence
reproduces the same state byte for byte.

## Module map

| File | Job |
| --- | --- |
| `main.ts` | Process lifecycle only: bind, register, poll for done, exit. |
| `app.ts` | HTTP server and routing for the four surfaces behind the bearer token. |
| `http.ts` | Body/JSON plumbing, the `X-GitHub-Request-Id` header, auth, deterministic timestamps. |
| `gitobj.ts` | SHA-1 object model: commit/tree/tag parse and build, packfile read (with OFS/REF delta resolution) and write, pkt-line framing. |
| `store.ts` | The single in-memory store: one content-addressed object store plus per-repo refs, labels, issues and pull requests (issues and PRs share one number sequence); tree surgery, merge-base and squash merge. |
| `rest.ts` | The REST v3 surface under `/api/v3`. |
| `githttp.ts` | Git smart HTTP: v2/v0 advertisements, `ls-refs`, fetch, receive-pack. |
| `graphql.ts` | The GraphQL tokenizer/parser and executor, including introspection and batching. |
| `mcp.ts` | The MCP endpoint and its six tools. |

## How it runs

At trial time the harness starts the program beside its suite with
`MAKEFUN_ENV_URL` pointing at the suite environment:

1. `main.ts` listens on port 0, so the kernel assigns a free ephemeral port
   (it never binds a fixed port).
2. It POSTs `{"port": <bound port>}` to `$MAKEFUN_ENV_URL/register`.
   Transient failures retry with backoff for as long as it takes; only a
   contract-breaking answer (400/405) is fatal.
3. It polls `GET $MAKEFUN_ENV_URL/done` until the suite answers
   `{"done": true}`, then closes the server and exits 0. SIGINT/SIGTERM also
   shut it down cleanly with exit 0.

State lives only in memory for the life of the process; there is nothing to
install and nothing to configure beyond the environment variables above
(`MAKEFUN_ENV_URL`, and `MAKEFUN_SHOP_TOKEN` for the bearer token).

## Local verification

Against the competition kit's own SDK conformance runner, on a fresh server
instance, the forge passes **120/120 checks**: the feature column scores
**600/600** and the agent-native (MCP) column **200/200**. Two identical runs
produce byte-identical results, including the commit SHAs and ids embedded in
the check details. The register/poll/exit lifecycle was additionally verified
against a hand-rolled fake environment (registered port probed live, exit 0
once done flips true).

---

Built by an AI agent for the make.fun ["Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01) bounty.
