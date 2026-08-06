# Changelog

## [0.3.1] - 2026-08-06

The CLI is unchanged in this release. Everything below affects the hosted API and MCP
servers, which are published from the same repository but not from the npm package.

### Security

- **Execution moved from bubblewrap to [secure-exec](https://www.npmjs.com/package/secure-exec) V8 isolates.**
  Packages no longer run in a bwrap subprocess; they run in a V8 isolate with no
  network adapter, no command executor, an empty environment, and only their own
  cache directory projected in. Verified against a running container: `fetch` and
  `child_process.spawn` fail with `ENOSYS`, reading `/etc/passwd` gives `ENOENT`,
  `process.env` is `{}`, and a busy loop is terminated at the 5s CPU limit.
- **Method names are validated before dispatch.** `constructor`, `__proto__`,
  `prototype`, `call`, `apply` and `bind` are rejected with HTTP 400. Because method
  segments were used as computed property lookups, `GET /lodash/constructor/"return
  40+2"/call/` previously returned `42` to any unauthenticated caller. The isolate
  still denied filesystem, network and subprocess access, so this was a broken
  guarantee rather than a sandbox escape.
- **Containers dropped their bubblewrap-era privileges.** `CAP_SYS_ADMIN`,
  `CAP_NET_ADMIN` and unconfined seccomp/AppArmor existed only so bwrap could create
  namespaces. Both images now run as the unprivileged `node` user with
  `no-new-privileges`.
- Per-execution output and bridge-call budgets now cap what an isolate can marshal
  back to the host.

### Fixed

- **CommonJS packages could not run at all.** The generated isolate source used a
  top-level `await` inside a CommonJS module, which is a syntax error, so `ms`,
  `lodash` and most of npm failed. Everything now runs as ESM.
- **The servers could not boot.** `shared/` imported `secure-exec` while the
  dependency was declared only in `api/` and `mcp/`, which Node's resolution never
  reaches from `shared/`. It is now a dependency of `shared/`.
- **The Docker images could not build.** Both were Node 20 while `isolated-vm`
  requires Node 22 and ships no musl prebuild. Both are now multi-stage on
  `node:22-alpine`.
- A package returning `null` (such as `lodash.noop`) returned `{"default": null}`
  instead of `null`.
- Concurrency is capped at 4 isolates rather than 16. Sixteen 64 MB isolates
  reserved the entire 1 GB container. Tunable via `SANDBOX_MAX_CONCURRENCY`.
- Saturation returns HTTP 503 with `Retry-After` instead of 400.
- A malformed JSON body returns a JSON error instead of an HTML error page.

### Changed

- **API and MCP now require Node 22.** `isolated-vm` ships prebuilds for Node 22 and
  24 only; on Node 25 it segfaults when constructing an isolate.
- Packages with native bindings (`.node` files) no longer run, and the isolate has no
  writable `/tmp`. Both were possible under bwrap.
- CI builds both Docker images and boots each server under real Node resolution.
  Neither check existed, which is how a non-building image and a non-booting server
  stayed green.
- Removed the orphaned bwrap modules (`shared/sandbox.js`, `shared/sandbox-runner.js`,
  `shared/loader.js`) and added tests for the sandbox that actually ships.

### Documentation

- Corrected the README security table, which described the removed bubblewrap
  mechanisms, and the API README, which documented a `{success, result}` response
  envelope, query-parameter arguments and object request bodies that the server has
  never implemented.

## [0.3.0] — 2026-03-14

### Security

- **Sandboxed execution** — API and MCP requests now run in isolated subprocesses via [bubblewrap](https://github.com/containers/bubblewrap):
  - Network isolation (`--unshare-net`) — packages cannot make outbound requests during execution
  - Read-only filesystem (`--ro-bind`) — packages cannot write outside `/tmp`
  - PID namespace isolation (`--unshare-pid`) — packages cannot see host processes
  - Sanitized environment — no host secrets or env vars leak into execution
  - Per-package cache directories — packages cannot read other installed packages
  - `--ignore-scripts` on `npm install` — postinstall scripts are not executed
- Graceful fallback to unsandboxed subprocess on systems without bwrap (macOS, Windows, Docker without `CAP_SYS_ADMIN`)

### Changed

- **Execution timeout default reduced from 20s to 5s** — configurable via `EXEC_TIMEOUT_MS`
- API and MCP servers refactored to use shared modules (`shared/parse.js`, `shared/loader.js`, `shared/cache.js`, `shared/sandbox.js`)
- Docker build context moved to repo root to support `shared/` directory
- Dockerfiles now install bubblewrap and require `CAP_SYS_ADMIN` for full sandboxing

### Breaking

- Packages requiring postinstall scripts (e.g. `sharp`, `esbuild`, `bcrypt`) will not install correctly
- Packages making HTTP requests during execution will fail (network isolated)
- Long-running executions (>5s) will timeout — increase `EXEC_TIMEOUT_MS` if needed

### Added

- `shared/` module with extracted parse, loader, cache, and sandbox utilities (52 tests)
- `shared-tests` CI job
- Security section in README

## [0.2.0] — 2026-03-13

### Added

- REST API server at `api.npxall.com` with URL pipeline chaining
- MCP server at `mcp.npxall.com` (Streamable HTTP + SSE transports)
- Homepage at `npxall.com` with terminal demo and docs
- Execution timeouts (20s) and install timeouts (60s)
- LRU cache eviction (500 MB default)
- Docker non-root containers with resource limits
- CI: 8-job matrix (Linux/macOS/Windows × Node 20/22 + API + MCP)

## [0.1.0] — 2026-03-12

### Added

- CLI with method chaining, sub-expressions, stdin piping
- JSON-aware argument parsing
- Package caching in `~/.npxall/`
- Published to npm as `npxall`
