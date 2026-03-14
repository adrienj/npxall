import express from 'express';
import { fileURLToPath } from 'url';
import { createCacheManager } from '../shared/cache.js';
import { spawnSandboxed, isBwrapAvailable } from '../shared/sandbox.js';
import { splitArgs, parseValue, validatePackageName } from '../shared/parse.js';

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

// ─── URL parser (API-specific) ────────────────────────────────────────────────
// URL pattern: /package/method/args/method/args/...
// Scoped:      /@org/package/method/args/...
// Dot chain:   /lodash/concat/[1,2],3/reverse.slice/0,1/

function parseUrl(rawUrl) {
  const path = decodeURIComponent(rawUrl.split('?')[0]);
  const segments = path.split('/').slice(1);
  if (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();

  let pkgName, startIdx;
  if (segments[0]?.startsWith('@') && segments.length >= 2) {
    pkgName = `${segments[0]}/${segments[1]}`;
    startIdx = 2;
  } else {
    pkgName = segments[0];
    startIdx = 1;
  }

  const steps = [];
  for (let i = startIdx; i < segments.length; i += 2) {
    const method = segments[i];
    const argsRaw = segments[i + 1] ?? '';
    if (method !== undefined) steps.push({ method, argsRaw });
  }

  return { pkgName, steps };
}

/**
 * Convert URL steps (with raw string args) into sandbox-ready steps
 * (with parsed native args). Expands dot shorthand: "reverse.slice" → two steps.
 */
function prepareSteps(steps, bodyArgs) {
  const prepared = [];

  for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
    const { method, argsRaw } = steps[stepIdx];
    const urlArgs = splitArgs(argsRaw).map(parseValue);
    const explicitArgs = (urlArgs.length === 0 && stepIdx === 0 && bodyArgs?.length > 0)
      ? bodyArgs : urlArgs;

    // Expand dot shorthand: "reverse.slice" → [reverse, slice]
    const dotMethods = method.split('.');
    for (let di = 0; di < dotMethods.length; di++) {
      const isLastDot = di === dotMethods.length - 1;
      prepared.push({
        method: dotMethods[di],
        args: isLastDot ? explicitArgs : [],
      });
    }
  }

  return prepared;
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();

app.use((req, res, next) => {
  if (!req.headers['content-type']) req.headers['content-type'] = 'application/json';
  next();
});
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cache: { usedMb: cache.totalCachedMb(), maxMb: MAX_CACHE_MB, packages: cache.registry.size },
    sandboxed: isBwrapAvailable(),
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'npxall-api',
    version: '2.0.0',
    cache: { usedMb: cache.totalCachedMb(), maxMb: MAX_CACHE_MB, packages: cache.registry.size },
    usage: {
      pattern: 'GET /:package/:method/:args/:method/:args/...',
      chaining: '/lodash/concat/[1,2],3/reverse.slice/0,1/ → [3]',
      scoped: '/@turf/turf/bearing/pointA,pointB',
      bare: '/ms/60000 → "1m"',
      post: 'POST /:package/:method with JSON array body as args',
    },
    examples: [
      'GET /ms/60000',
      'GET /lodash/camelCase/hello world',
      'GET /lodash/chunk/[1,2,3,4],2',
      'GET /lodash/concat/[1,2],3/reverse/',
    ],
  });
});

app.all('*', async (req, res) => {
  try {
    const { pkgName, steps } = parseUrl(req.url);
    if (!pkgName) return res.status(400).json({ error: 'No package specified' });

    validatePackageName(pkgName);
    await cache.installWithCacheCheck(pkgName);
    cache.acquire(pkgName);

    try {
      const bodyArgs = Array.isArray(req.body) ? req.body : null;

      // Bare function with POST body
      if (steps.length === 0 && bodyArgs?.length > 0) {
        const result = await spawnSandboxed({
          cacheDir: cache.pkgCacheDir(pkgName),
          packageName: pkgName,
          args: bodyArgs,
          timeoutMs: EXEC_TIMEOUT_MS,
        });
        return res.json(result ?? null);
      }

      if (steps.length === 0) {
        return res.status(400).json({ error: `No method or arguments specified for '${pkgName}'` });
      }

      const prepared = prepareSteps(steps, bodyArgs);
      const result = await spawnSandboxed({
        cacheDir: cache.pkgCacheDir(pkgName),
        packageName: pkgName,
        steps: prepared,
        timeoutMs: EXEC_TIMEOUT_MS,
      });
      res.json(result ?? null);
    } finally {
      cache.release(pkgName);
    }
  } catch (error) {
    const status = error.status || 400;
    res.status(status).json({ error: error.message });
  }
});

// ─── Exports (for testing) ────────────────────────────────────────────────────

export { app, splitArgs, parseUrl, parseValue, validatePackageName, cache };

// ─── Boot ─────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cache.bootClean();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`npxall API on port ${PORT} | cache limit: ${MAX_CACHE_MB} MB`);
  });
}
