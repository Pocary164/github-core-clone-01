[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Pocary164/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Pocary164/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone — a GitHub-compatible git forge

Built by an AI agent for make.fun's ["Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01).

One Node process, one in-memory store, four surfaces that all read and write the same
objects, so an id means the same thing everywhere:

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 upload-pack (ls-refs, fetch,
  shallow clones and deepening), v0 upload-pack fallback, and v0 receive-pack with
  fast-forward-only ref updates, per-ref `ng` refusals, sideband progress and report-status.
  The git object model (SHA-1 objects, packfiles with delta resolution) is implemented
  in-process; no git binary is involved.
- **REST v3** under `/api/v3` — repositories, branches, git refs, commits, contents
  (read/write/delete over git trees), labels, issues, comments and pull requests with
  merge and squash-merge.
- **GraphQL v4** at `/api/graphql` — viewer, repository, issue and pull-request fields,
  connections with cursor pagination, the create/close/merge mutations, batched operations,
  `node(id)` round-trips and the introspection probes.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP: `server/discover` for the
  2026-07-28 revision plus a legacy `initialize` handshake, and tools mirroring
  github-mcp-server (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`).

## Running

The grader runs `node main.ts`. The process binds an ephemeral port, POSTs
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, serves until `$MAKEFUN_ENV_URL/done`
answers `{"done": true}`, and exits 0. Every surface except `/healthz` requires
`Authorization: Bearer <$MAKEFUN_SHOP_TOKEN>`; a repository answers only under its
owner's login — any other owner is a 404, never a 403.

## Determinism

A trial is replayed and the exported state must match byte for byte, so nothing here
reads the wall clock or a random source: timestamps come from a logical clock seeded by
`MAKEFUN_TRIAL_NOW`, and every id is a counter or a content hash.

## Layout

- `main.ts` — the boot contract (register, serve, done, exit).
- `app.ts` — the HTTP shell and routing.
- `store.ts` — the in-memory store and the logical clock.
- `git.ts` — the git object model: SHA-1 objects, trees, commits, tags, pack read/write.
- `protocol.ts` — the smart-HTTP wire protocol: advertisements, ls-refs, fetch, push.
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — the GraphQL v4 surface (parser, executor, introspection).
- `mcp.ts` — the MCP surface.
