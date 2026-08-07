# npxall API

REST API and MCP server for calling any npm package function over HTTP.

> **Never ship a CLI again.** *(Disclaimer: won't replace your actual backend, handle auth, or attend your sprint reviews.)*

---

## Services

| Service | URL | Protocol |
|---------|-----|----------|
| REST API | https://npxall-api-3eia2da3ha-ew.a.run.app | HTTP/JSON |
| MCP server | https://npxall-mcp-3eia2da3ha-ew.a.run.app | MCP (Streamable HTTP + SSE) |

The `api.npxall.com` and `mcp.npxall.com` hostnames are not live. They are parked
pending Google domain verification, so use the URLs above. Examples below still show
the custom hostnames as the intended endpoints; substitute until the mapping lands.

---

## REST API

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/:package/:method/:args/:method/:args/...` | Execute a pipeline |
| `POST` | `/:package/:method` | JSON **array** body as args |
| `GET` | `/health` | Cache stats + sandbox status |
| `GET` | `/` | API info and examples |

### Examples

```bash
# Bare function
curl https://api.npxall.com/ms/60000
# → "1m"

# Method with args
curl "https://api.npxall.com/lodash/camelCase/hello%20world"
# → "helloWorld"

# Chaining: concat, then reverse
curl 'https://api.npxall.com/lodash/concat/%5B1,2%5D,3/reverse/'
# → [3,2,1]

# POST: the array IS the argument list, not one array argument
curl -X POST https://api.npxall.com/lodash/chunk \
  -H "Content-Type: application/json" \
  -d '[[1,2,3,4],2]'
# → [[1,2],[3,4]]
```

### Argument handling

Arguments come from **path segments**, or from a top-level JSON **array** body.

- A JSON array body supplies the argument list for the **first step only**. `POST /ms` with `[60000]` calls `ms(60000)`.
- Query strings are **discarded**. `?value=hello` does not become an argument; the call runs with no args and returns 200 with whatever that produces.
- Object bodies are **ignored**. `{"array":[1,2],"size":2}` is not spread into arguments.
- A method segment that is not a function on the package falls through to calling the package itself with that segment as a string, so a typo can return a value rather than an error. `GET /lodash/nosuchmethod/` returns a lodash wrapper object with HTTP 200.
- Percent-encoded `/` inside an argument does not survive: the path is decoded before it is split, so `%2F` becomes a segment separator. URLs and file paths cannot be passed as arguments.

### Responses

Success returns the value itself, with no envelope:

```json
"1m"
[[1,2],[3,4]]
```

Errors return an object with a single `error` key:

```json
{ "error": "Invalid method name: \"constructor\"" }
```

| Status | Meaning |
|--------|---------|
| `400` | Invalid package name, invalid method name, malformed JSON body, or no method given |
| `503` | Too many concurrent executions; retry after the `Retry-After` header |
| `507` | Cache is full and every package in it is in use |

Because a successful result is returned bare, a package that returns `{"error": "..."}` is indistinguishable from a failure by body alone. Check the status code.

---

## MCP Server

The MCP server exposes npxall as a single `call` tool, usable from Claude, Cursor, and any MCP-compatible LLM client.

### Transports

| Transport | URL | Client support |
|-----------|-----|----------------|
| Streamable HTTP (2025-03-26) | `POST https://mcp.npxall.com/mcp` | Claude.ai, newer clients |
| SSE (legacy) | `GET https://mcp.npxall.com/sse` | Claude Desktop, older clients |

### Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "npxall": {
      "url": "https://mcp.npxall.com/sse"
    }
  }
}
```

### Tool: `call`

```
call(package, method?, args?)
```

| Param | Type | Description |
|-------|------|-------------|
| `package` | `string` | npm package name, e.g. `"lodash"`, `"ms"` |
| `method` | `string?` | Function/method to call, e.g. `"camelCase"` |
| `args` | `unknown[]?` | Native JSON arguments — no quoting needed |

**Example LLM prompt:**
> Call `lodash.chunk` with array `[1,2,3,4,5,6]` and size `2`

The LLM calls:
```json
{
  "package": "lodash",
  "method": "chunk",
  "args": [[1,2,3,4,5,6], 2]
}
```
Returns: `[[1,2],[3,4],[5,6]]`

### JSON-RPC directly

```bash
curl -X POST https://mcp.npxall.com/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "call",
      "arguments": {
        "package": "ms",
        "args": [60000]
      }
    }
  }'
```

---

## Disk Cache

Both services use an LRU disk cache, wiped clean on every boot.

| Env var / CLI arg | Default | Description |
|-------------------|---------|-------------|
| `CACHE_MAX_MB` or `--max-cache-mb=N` | `500` | Maximum cache size in MB |
| `NPXALL_CACHE_DIR` | `/app/cache` | Cache directory |

**Behavior:**
- All cached packages are wiped when the container starts
- Packages are installed on first request and measured by disk usage (`du`)
- When the cache exceeds the limit, the least recently used non-in-use packages are evicted
- If the cache is full and all packages are actively serving requests, new installs are rejected (507)
- A `refCount` per package prevents evicting a package mid-execution

**`/health` response:**
```json
{
  "status": "ok",
  "cache": { "usedMb": 142, "maxMb": 500, "packages": 8 },
  "sandboxed": true,
  "sandboxEngine": "secure-exec"
}
```

`sandboxed` reports whether the server can construct a V8 isolate. If it is `false`, every execution request fails; the server does not fall back to running packages unsandboxed.

---

## Deployment

### Docker Compose (local / server)

```bash
docker compose up --build
```

Services:
- API: http://localhost:3000
- MCP: http://localhost:3001

### Google Cloud Run (production)

Both services run on Cloud Run in `europe-west1`, project `npxall-prod`, scaling to
zero when idle. The Coolify/Hetzner deployment they replaced was retired 2026-06-12.

| Setting | Value | Why |
|---------|-------|-----|
| `--min-instances` | `0` | Nothing is billed while idle |
| `--max-instances` | `2` | Caps the blast radius of an unauthenticated execution endpoint |
| `--concurrency` | `4` | Matches `SANDBOX_MAX_CONCURRENCY`; the default of 80 would queue requests into 4 isolate slots |
| `--memory` | `2Gi` | Cloud Run's filesystem is in-memory, so the package cache counts against this |
| `--timeout` | `120` | Covers a 60s install plus a 5s execution |

Because instances scale to zero and the cache lives in memory, a cold start pays both
container boot and a fresh `npm install` for the requested package.

### Environment variables

| Variable | Production value | Description |
|----------|------------------|-------------|
| `NPXALL_CACHE_DIR` | `/tmp/cache` | Only writable path on Cloud Run |
| `CACHE_MAX_MB` | `512` | Cache size limit per service |
| `SANDBOX_MAX_CONCURRENCY` | `4` | Simultaneous V8 isolates |
| `SANDBOX_MEMORY_LIMIT_MB` | `64` (default) | Per-isolate heap |
| `EXEC_TIMEOUT_MS` | `5000` (default) | CPU limit per execution |
| `PORT` | injected by Cloud Run | Service port |

---

## Security & Rate Limiting

### fail2ban (recommended)

These services are public and unauthenticated. Without rate limiting, they can be abused to install arbitrary packages or exhaust disk/CPU. **Set up fail2ban on the host** to ban IPs with excessive requests.

Install and configure on the server:

```bash
apt install fail2ban
```

Create `/etc/fail2ban/filter.d/npxall.conf`:

```ini
[Definition]
failregex = ^<HOST> .* "(GET|POST) /
ignoreregex =
```

Create `/etc/fail2ban/jail.d/npxall.conf`:

```ini
[npxall-api]
enabled  = true
port     = 3000,3001
filter   = npxall
logpath  = /var/log/nginx/access.log
maxretry = 60
findtime = 60
bantime  = 600

[npxall-mcp]
enabled  = true
port     = 3000,3001
filter   = npxall
logpath  = /var/log/traefik/access.log
maxretry = 30
findtime = 60
bantime  = 3600
```

> **Note on log paths:** Traefik (used by Coolify) writes access logs differently than nginx. Enable Traefik access logs in Coolify → Server → Proxy settings, then adjust `logpath` above to match.

Restart fail2ban:

```bash
systemctl restart fail2ban
fail2ban-client status npxall-api
```

### Additional hardening

- Set `CACHE_MAX_MB` conservatively to limit disk exhaustion from package install abuse
- Consider adding a simple API key via Traefik middleware if public abuse becomes a problem
- Monitor `/health` endpoints for cache pressure

---

## Architecture

```
                  DNS
  api.npxall.com ──────► 46.225.130.176
  mcp.npxall.com ──────► 46.225.130.176
                               │
                           Traefik
                          (Coolify)
                         /         \
                   :3000            :3001
                api/server.js   mcp/server.js
                     │               │
               npm install      npm install
               (~/.npxall/)    (~/.npxall/)
               LRU cache        LRU cache
```

Both services share the same package-loading logic but maintain independent caches (separate containers). The MCP server passes arguments as native JSON, while the REST API parses stringified values from query params and JSON bodies.
