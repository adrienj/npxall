import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { createCacheManager } from '../shared/cache.js';
import { spawnSandboxed, isBwrapAvailable } from '../shared/sandbox.js';
import { validatePackageName } from '../shared/parse.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const CACHE_DIR = process.env.NPXALL_CACHE_DIR || '/app/cache';
const argMaxMb = process.argv.find(a => a.startsWith('--max-cache-mb='));
const MAX_CACHE_MB = argMaxMb
  ? parseInt(argMaxMb.split('=')[1], 10)
  : parseInt(process.env.CACHE_MAX_MB || '500', 10);
const INSTALL_TIMEOUT_MS = parseInt(process.env.INSTALL_TIMEOUT_MS || '60000', 10);
const EXEC_TIMEOUT_MS = parseInt(process.env.EXEC_TIMEOUT_MS || '5000', 10);

const cache = createCacheManager({
  baseDir: CACHE_DIR,
  maxCacheMb: MAX_CACHE_MB,
  installTimeoutMs: INSTALL_TIMEOUT_MS,
});

// ─── Format result for MCP text content ──────────────────────────────────────

function formatResult(result) {
  if (result === undefined || result === null) return 'null';
  if (typeof result === 'object') return JSON.stringify(result, null, 2);
  return String(result);
}

// ─── MCP server factory ──────────────────────────────────────────────────────
// Create a new McpServer per connection to avoid shared state across transports.

function createMcpServer() {
  const server = new McpServer({ name: 'npxall', version: '0.2.0' });

  server.tool(
    'call',
    'Call any function from any npm package. ' +
    'Packages are installed on first use and cached. ' +
    'Args are native JSON — pass numbers, arrays, objects directly. ' +
    'Execution is sandboxed: no network, read-only filesystem.',
    {
      package: z.string().describe(
        'npm package name, e.g. "lodash", "ms", "date-fns", "change-case", "@turf/turf"',
      ),
      method: z.string().optional().describe(
        'Function or method name on the package export, e.g. "camelCase", "format", "chunk"',
      ),
      args: z.array(z.unknown()).optional().describe(
        'Arguments as native JSON values — numbers, strings, arrays, objects. No quoting needed.',
      ),
    },
    async ({ package: pkgName, method, args = [] }) => {
      try {
        validatePackageName(pkgName);
        await cache.installWithCacheCheck(pkgName);
        cache.acquire(pkgName);
        try {
          const result = await spawnSandboxed({
            cacheDir: cache.pkgCacheDir(pkgName),
            packageName: pkgName,
            method,
            args,
            timeoutMs: EXEC_TIMEOUT_MS,
          });
          return { content: [{ type: 'text', text: formatResult(result) }] };
        } finally {
          cache.release(pkgName);
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    },
  );

  return server;
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── Modern: Streamable HTTP transport (MCP spec 2025-03-26) ──────────────────
app.post('/mcp', async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.on('finish', () => transport.close().catch(() => {}));
});

// ── Legacy: SSE transport (Claude Desktop, older MCP clients) ────────────────
const sseTransports = new Map();
const SSE_MAX_AGE_MS = 30 * 60 * 1000;
const SSE_MAX_SESSIONS = 100;

function cleanStaleSse() {
  const now = Date.now();
  for (const [id, entry] of sseTransports) {
    if (now - entry.createdAt > SSE_MAX_AGE_MS) {
      entry.transport.close().catch(() => {});
      sseTransports.delete(id);
    }
  }
}

app.get('/sse', async (req, res) => {
  cleanStaleSse();
  if (sseTransports.size >= SSE_MAX_SESSIONS) {
    return res.status(503).json({ error: 'Too many SSE sessions' });
  }
  const server = createMcpServer();
  const transport = new SSEServerTransport('/messages', res);
  sseTransports.set(transport.sessionId, { transport, createdAt: Date.now() });
  await server.connect(transport);
  res.on('close', () => sseTransports.delete(transport.sessionId));
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const entry = sseTransports.get(sessionId);
  if (!entry) return res.status(404).json({ error: 'Session not found' });
  await entry.transport.handlePostMessage(req, res, req.body);
});

// ── Info & health ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cache: { usedMb: cache.totalCachedMb(), maxMb: MAX_CACHE_MB, packages: cache.registry.size },
    sandboxed: isBwrapAvailable(),
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'npxall-mcp',
    version: '0.2.0',
    description: 'MCP server — call any npm function from your LLM. Sandboxed execution.',
    transports: {
      streamableHttp: 'POST https://mcp.npxall.com/mcp',
      sse: 'GET https://mcp.npxall.com/sse  (POST https://mcp.npxall.com/messages)',
    },
    tool: {
      name: 'call',
      params: { package: 'string', method: 'string?', args: 'unknown[]?' },
    },
    cache: { usedMb: cache.totalCachedMb(), maxMb: MAX_CACHE_MB, packages: cache.registry.size },
  });
});

// ─── Exports (for testing) ────────────────────────────────────────────────────

export { app, createMcpServer, validatePackageName, formatResult, cache };

// ─── Boot ─────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cache.bootClean();
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`npxall MCP server on port ${PORT} | cache limit: ${MAX_CACHE_MB} MB`);
    console.log(`  Streamable HTTP : POST http://localhost:${PORT}/mcp`);
    console.log(`  SSE (legacy)    : GET  http://localhost:${PORT}/sse`);
  });
}
