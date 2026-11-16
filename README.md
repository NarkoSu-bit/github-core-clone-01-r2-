# github-core-clone-01 — r2

A standalone, GitHub-compatible git forge written from the make.fun kit's wire spec,
stdlib only (Node 22, no dependencies, no git binary).

- Git smart HTTP: upload-pack protocol v2 (ls-refs, fetch, shallow/deepen), upload-pack v0
  fallback, receive-pack v0 (report-status, side-band-64k, delete-refs, fast-forward only).
- REST v3 under `/api/v3`: repositories, branches, commits, contents, labels, issues,
  pull requests (squash merge with conflict detection).
- GraphQL v4 at `/api/graphql`: viewer, repository, node, `__type` introspection, issues
  and pullRequests connections, create/close issue, create/merge pull request.
- MCP at `/mcp`: JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 (`server/discover`)
  plus the legacy `initialize` handshake; six tools (create_repo, get_repo, create_issue,
  list_issues, create_pull_request, merge_pull_request) sharing one store with REST.

## Run

```
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

With `MAKEFUN_ENV_URL` set it registers its port with the suite and exits when the
suite reports done; without it, it serves on `$PORT` (default 8080) for local testing.
