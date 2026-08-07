# npxall — Product

## Vision
npxall lets anyone call any npm package function from the CLI, REST API, or AI assistant — without writing a script. It's a universal function caller for the 2M+ npm ecosystem. Target users: developers who need quick utility calls during development, AI agents that need runtime access to npm functions, and automation scripts that need lightweight package access.

## User Personas

- **Dev at 2am** — Backend developer who just needs to slugify a string, parse a date, or validate an email. Doesn't want to write a script. Uses CLI.
- **AI Agent Builder** — Building with Claude/GPT and needs the agent to call npm functions at runtime. Uses the MCP server or REST API.
- **Script Automator** — Writes bash scripts and CI pipelines that need lightweight access to npm utilities. Uses CLI piping or API calls.

## Roadmap

### Shipped
- [x] CLI with method chaining, sub-expressions, stdin piping — v0.2.0 on npm
- [x] REST API with URL pipeline chaining, `api.npxall.com` (see Status below)
- [x] MCP server with single `call` tool, `mcp.npxall.com` (see Status below)
- [x] Homepage at `npxall.com` with favicon, terminal demo (CLI + API curl examples), API and MCP docs
- [x] CI: Linux/macOS/Windows x Node 20/22, plus shared, API, MCP and a Docker build job
- [x] npm v0.2.0 published (2026-03-13)
- [x] Coolify deploy from public `adrienj/npxall` repo (private repo eliminated)
- [x] Custom domain: npxall.com, api.npxall.com, mcp.npxall.com, status.npxall.com
- [x] Execution timeouts (5s) and install timeouts (60s) on API/MCP
- [x] Docker non-root containers with resource limits
- [x] Sandboxed execution via bubblewrap, 2026-03-14 (replaced by V8 isolates, see below)
- [x] Shared module extraction (parse, cache, sandbox), DRY refactor of api/mcp servers, 2026-03-14
- [x] Sandboxed execution via secure-exec V8 isolates, replacing bubblewrap and its `CAP_SYS_ADMIN` requirement, 2026-08-06

## Status

`npxall.com` (GitHub Pages) is up.

The API and MCP servers were down from 2026-06-12, when the Coolify/Hetzner deployment
was retired, until 2026-08-07. They now run on Google Cloud Run with scale-to-zero:

- API: https://npxall-api-3eia2da3ha-ew.a.run.app
- MCP: https://npxall-mcp-3eia2da3ha-ew.a.run.app

`api.npxall.com` and `mcp.npxall.com` do **not** resolve to these yet. Mapping them
needs `npxall.com` verified in Google Search Console, which is a manual browser step.
Until then the custom hostnames stay parked.

### In Progress
- Verify `npxall.com` so the custom domains can be mapped to Cloud Run
- Publish npxall 0.3.1 to npm

### Planned (Next)
- [ ] Add npxall MCP server to public MCP registries (Smithery, MCP Hub) — S, high discovery value
- [ ] Post on Hacker News / dev communities — S, first real GTM push
- [ ] Bot/crawler protection on API — bots installing `checkout`, `robots.txt` etc. as packages — M

### Icebox
- [ ] Authentication / rate limiting on API — not needed until abuse appears
- [ ] Package allowlist/blocklist — security hardening, defer until real traffic
- [ ] WebSocket transport for MCP — no demand signal yet
- [ ] npm org/team features — no B2B signal

## Current Focus

Everything is shipped and live. The product works end-to-end across CLI, API, and MCP. **The bottleneck is now distribution, not features.** Priority: get the MCP server listed on public registries and do a first GTM push to developer communities.

## GTM & Marketing
- **Launch status:** Soft launch (npm published, all endpoints live, homepage up)
- **First users:** ~350 npm downloads/week (organic). No known repeat users. No paying users.
- **Channels:** npm search, GitHub. No active promotion yet.
- **Conversion funnel:** Unknown. No analytics.
- **Next GTM action:** Get listed on MCP registries (Smithery, mcp.run, etc.) — this is where AI-tool-using developers discover MCP servers. Then post to HN/Reddit/dev Twitter.

## Monetization
- **Revenue today:** $0
- **Pricing:** Free / open source. No monetization plan yet.
- **Stripe/payments:** N/A
- **Next monetization action:** None planned. Focus is on distribution and usage first. Potential future: hosted API with rate limits (free tier + paid for higher limits).

## Quality
- **Tests:** 309 passing (177 CLI + 49 API + 31 MCP + 52 Shared), 0 failing
- **CI:** All 8 jobs green (ubuntu/macos/windows x node20/22 + api + mcp) — needs shared/ job added
- **Known bugs:** None critical
- **Tech debt:**
  - Bot/crawler traffic polluting API cache (packages like `checkout`, `robots.txt` being installed)

## Key Decisions
- [2026-03-13] API: custom URL parsing with pipeline chaining instead of Express route params
- [2026-03-13] Direct response format (no `{success, result}` wrapper) — cleaner for programmatic use
- [2026-03-13] MCP server as separate service from API — different transport requirements
- [2026-03-13] Coolify deploy fix: source_id=0 → delete and recreate with github_app_uuid
- [2026-03-13] Removed search bar / auto-doc generation from homepage — unreliable feature, cut it
- [2026-03-14] Distribution > features — product is complete, focus shifts to GTM
