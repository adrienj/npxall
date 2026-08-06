# Security Policy

## Reporting a Vulnerability

Do not open a public GitHub issue for a security vulnerability. Report it privately
through [GitHub's private vulnerability reporting](https://github.com/adrienj/npxall/security/advisories/new).

Include a description, steps to reproduce, and the impact you think it has. You will
get a response within 7 days.

## Scope

**In scope:**

- `cli.js`, which runs on end-user machines
- `web/src/`
- `api/`, `mcp/` and `shared/`, which run the hosted service at `api.npxall.com` and
  `mcp.npxall.com`

**Out of scope:** test files, build tooling, development dependencies.

## What the sandbox is meant to guarantee

The hosted API and MCP servers install and execute arbitrary npm packages on behalf of
unauthenticated callers. Execution happens inside a `secure-exec` V8 isolate that gets
no network adapter, no command executor, an empty environment, and only the calling
package's own cache directory.

Reports worth filing include anything that reads the host filesystem outside that cache
directory, reaches the network, starts a process, reads host environment variables,
survives past the CPU or memory limit, or reaches another package's cache.

Two things are known and are not vulnerabilities on their own. A V8 isolate shares the
host process, so it is not a kernel boundary; the container is. And `isolated-vm`
documents its memory limit as a guideline that determined code can exceed, which is why
concurrency is capped rather than the limit being treated as hard.
