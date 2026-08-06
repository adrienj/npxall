import { NodeRuntime, createNodeDriver, createNodeRuntimeDriverFactory } from 'secure-exec';

/** Exit code used by secure-exec when CPU time limit is exceeded (matches GNU timeout convention). */
const TIMEOUT_EXIT_CODE = 124;

/** Per-isolate V8 heap limit, MB. */
const MEMORY_LIMIT_MB = parseInt(process.env.SANDBOX_MEMORY_LIMIT_MB || '64', 10);

/**
 * Maximum number of concurrent V8 isolate runtimes.
 *
 * This must be sized against the container's memory limit, not picked freely:
 * every live isolate can hold up to MEMORY_LIMIT_MB of heap, and isolated-vm
 * documents that limit as a guideline rather than a hard ceiling ("a determined
 * attacker could use 2-3 times this limit"). The previous value of 16 against a
 * 1 GB container reserved 16 x 64 MB = 1024 MB of isolate heap alone, leaving
 * nothing for the Node host — an OOM-kill of the whole process, not a clean 503.
 *
 * The default of 4 also matches the deployed `cpus: '1.0'`: isolate execution is
 * CPU-bound, so higher concurrency multiplies p99 latency without adding
 * throughput. Override via SANDBOX_MAX_CONCURRENCY when the deploy grows.
 */
const MAX_CONCURRENT_RUNTIMES = parseInt(process.env.SANDBOX_MAX_CONCURRENCY || '4', 10);
let _activeRuntimes = 0;

/**
 * Method names that must never be dispatched.
 *
 * Method segments are used as computed property lookups (`_mod[name]`) inside the
 * isolate, so `constructor` resolves to `Function` on any function export. Chained
 * with a second step it becomes a code-generation gadget:
 *
 *   GET /lodash/constructor/"return 40+2"/call/   →   42
 *
 * The isolate still denies fs, network and child_process, so this is not an escape,
 * but it does defeat the "only the package's own exported API is reachable"
 * property that the URL grammar implies. The prototype-walking names are blocked
 * for the same reason.
 */
const FORBIDDEN_METHODS = new Set([
  'constructor', '__proto__', 'prototype',
  'apply', 'call', 'bind',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);

/**
 * Reject method names that are unsafe to dispatch.
 *
 * Deliberately a denylist and NOT an identifier allowlist. The first URL segment
 * after the package name is overloaded: for a bare-function call like `/ms/60000`
 * or `/@sindresorhus/slugify/Hello World`, that segment is the ARGUMENT, not a
 * method name, and buildCode falls back to calling the module itself with it.
 * Requiring an identifier there breaks every bare-function call.
 *
 * Arbitrary characters are safe because names are JSON.stringify'd into the
 * generated source, so they cannot escape the string literal. The only real hazard
 * is a name that resolves to a dangerous property, which is what FORBIDDEN_METHODS
 * covers.
 *
 * @param {unknown} name
 * @throws {Error} with .status 400 when the name is not dispatchable
 */
export function validateMethodName(name) {
  if (typeof name !== 'string' || FORBIDDEN_METHODS.has(name)) {
    const err = new Error(`Invalid method name: ${JSON.stringify(name)}`);
    err.status = 400;
    throw err;
  }
}

/**
 * Build the JavaScript code to execute inside the V8 isolate.
 * Handles both pipeline mode (API: steps array) and single-call mode (MCP: method + args).
 *
 * Everything runs as ESM (.mjs) regardless of whether the target package is ESM or
 * CommonJS. The isolate's module loader provides CJS interop, so `import * as` works
 * for both, and ESM is the only module type that permits the top-level `await` this
 * generated code needs in order to support packages that return promises.
 *
 * The result is wrapped as `{ default: value }` by the isolate runtime; see
 * unwrapDefault() for the matching unwrap.
 *
 * @param {string} packageName
 * @param {string|undefined} method
 * @param {unknown[]|undefined} args
 * @param {Array<{method: string, args: unknown[]}>|undefined} steps
 * @returns {string} JavaScript source code
 */
export function buildCode(packageName, method, args, steps) {
  const pkg = JSON.stringify(packageName);

  const importLine = `import * as _m from ${pkg};\nvar _mod = _m.default !== undefined ? _m.default : _m;\n`;

  const exportResult = (expr) => `export default ${expr};\n`;

  // Await helper: resolves promises, passes through non-thenables unchanged.
  const awaitHelper = `async function _await(v) { return (v && typeof v.then === 'function') ? await v : v; }\n`;

  // The crypto-browserify polyfill bundled in secure-exec's bridge has two code paths
  // in actualFill(): when process.browser is truthy it uses crypto.getRandomValues()
  // (which the bridge provides natively via _cryptoRandomFill), and when falsy it uses
  // randombytes() + Buffer.copy(Uint8Array) which breaks in the isolate's Buffer bridge.
  // Setting this flag steers the polyfill to the working Web Crypto path.
  const cryptoFix = `if (typeof process !== 'undefined') process.browser = true;\n`;

  if (steps && Array.isArray(steps)) {
    // Pipeline mode (API): chain multiple method calls
    let code = cryptoFix + importLine + awaitHelper + `var _acc;\n`;

    for (let i = 0; i < steps.length; i++) {
      const { method: m, args: a = [] } = steps[i];
      validateMethodName(m);
      const mStr = JSON.stringify(m);
      const aStr = JSON.stringify(a);

      if (i === 0) {
        code += `if (typeof _mod[${mStr}] === 'function') {\n` +
          `  _acc = await _await(_mod[${mStr}].apply(_mod, ${aStr}));\n` +
          `} else if (typeof _mod === 'function') {\n` +
          `  var _p = (function() { try { return JSON.parse(${mStr}); } catch(e) { return ${mStr}; } }());\n` +
          `  _acc = await _await(_mod.apply(null, [_p].concat(${aStr})));\n` +
          `} else {\n` +
          `  throw new Error(${JSON.stringify(`'${m}' is not a function in '${packageName}'`)});\n` +
          `}\n`;
      } else {
        code += `if (_acc !== null && _acc !== undefined && typeof _acc[${mStr}] === 'function') {\n` +
          `  _acc = await _await(_acc[${mStr}].apply(_acc, ${aStr}));\n` +
          `} else if (typeof _mod[${mStr}] === 'function') {\n` +
          `  _acc = await _await(_mod[${mStr}].apply(_mod, [_acc].concat(${aStr})));\n` +
          `} else {\n` +
          `  throw new Error(${JSON.stringify(`'${m}' is not a function on the result or '${packageName}'`)});\n` +
          `}\n`;
      }
    }

    code += exportResult('_acc !== undefined ? _acc : null');
    return code;
  }

  // Single method mode (MCP)
  let code = cryptoFix + importLine + awaitHelper;
  const a = JSON.stringify(args || []);

  if (method) {
    validateMethodName(method);
    const mStr = JSON.stringify(method);
    code += `if (typeof _mod[${mStr}] !== 'function') {\n` +
      `  var _available = Object.keys(_mod).filter(function(k) { return typeof _mod[k] === 'function'; }).slice(0, 10);\n` +
      `  throw new Error(${JSON.stringify(`'${method}' is not a function in '${packageName}'. Available: `)} + _available.join(', '));\n` +
      `}\n` +
      `var _result = await _await(_mod[${mStr}].apply(_mod, ${a}));\n`;
    code += exportResult('_result !== undefined ? _result : null');
  } else if (args && args.length > 0) {
    code += `if (typeof _mod !== 'function') {\n` +
      `  throw new Error(${JSON.stringify(`'${packageName}' is not a function`)});\n` +
      `}\n` +
      `var _result = await _await(_mod.apply(null, ${a}));\n`;
    code += exportResult('_result !== undefined ? _result : null');
  } else {
    code += exportResult('_mod');
  }

  return code;
}

/**
 * Unwrap the isolate's module exports.
 *
 * `export default value` comes back as `{ default: value }`. Testing for the key
 * rather than for a non-nullish value matters: a package that legitimately returns
 * `null` (e.g. lodash.noop) would otherwise fall through and leak the raw
 * `{ default: null }` wrapper to the caller.
 *
 * @param {unknown} exports - the isolate's module exports
 * @returns {unknown} the unwrapped value
 */
export function unwrapDefault(exports) {
  if (exports && typeof exports === 'object' && 'default' in exports) return exports.default;
  return exports;
}

/**
 * Probe whether secure-exec can create a V8 isolate runtime.
 * Called once at startup; result is cached.
 *
 * @returns {boolean}
 */
let _secureExecAvailable;
export function isSecureExecAvailable() {
  if (_secureExecAvailable !== undefined) return _secureExecAvailable;
  try {
    const runtime = new NodeRuntime({
      systemDriver: createNodeDriver({
        moduleAccess: { cwd: '/tmp' },
        permissions: {
          fs: () => ({ allow: false }),
          network: () => ({ allow: false }),
          childProcess: () => ({ allow: false }),
        },
      }),
      runtimeDriverFactory: createNodeRuntimeDriverFactory(),
      memoryLimit: 8,
      cpuTimeLimitMs: 1000,
    });
    runtime.terminate().catch(() => {});
    _secureExecAvailable = true;
  } catch (err) {
    console.log(`[sandbox] WARNING: secure-exec unavailable — ${err.message}`);
    _secureExecAvailable = false;
  }
  return _secureExecAvailable;
}

/**
 * Execute a package function inside a secure-exec V8 isolate.
 *
 * Provides deny-by-default sandboxing powered by V8 isolates:
 * - No network access
 * - No child process spawning
 * - Read-only filesystem (module resolution from cache only)
 * - CPU time limit (terminates runaway code deterministically)
 * - Memory limit
 * - Concurrency-bounded (max {@link MAX_CONCURRENT_RUNTIMES} simultaneous isolates)
 *
 * @param {object} opts
 * @param {string} opts.cacheDir - per-package cache directory containing node_modules/
 * @param {string} opts.packageName - npm package name
 * @param {string} [opts.method] - method name to call on the package export
 * @param {unknown[]} [opts.args] - arguments to pass
 * @param {Array<{method: string, args: unknown[]}>} [opts.steps] - pipeline steps (API mode)
 * @param {number} [opts.timeoutMs=5000] - CPU execution timeout in ms
 * @returns {Promise<unknown>} the function's return value
 */
export async function execSandboxed({ cacheDir, packageName, method, args, steps, timeoutMs = 5000 }) {
  if (_activeRuntimes >= MAX_CONCURRENT_RUNTIMES) {
    // 503, not 400: this is server saturation, and clients (and CDNs) treat 4xx as
    // permanent and will not back off and retry.
    const err = new Error('Too many concurrent sandbox executions, try again later');
    err.status = 503;
    err.retryAfter = 1;
    throw err;
  }

  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      moduleAccess: { cwd: cacheDir },
      processConfig: { cwd: '/root' },
      permissions: {
        // Allow read-only filesystem access for module resolution
        fs: (req) => ({
          allow: req.op === 'read' || req.op === 'stat' || req.op === 'exists' || req.op === 'readdir',
        }),
        // Deny all network access
        network: () => ({ allow: false }),
        // Deny all child process spawning
        childProcess: () => ({ allow: false }),
      },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: MEMORY_LIMIT_MB, // V8 isolate heap limit
    cpuTimeLimitMs: timeoutMs,
    // Without these the bridge will marshal an arbitrarily large return value back
    // to the host, where express then JSON.stringifies it. A package returning a
    // ~60 MB structure stays inside the heap limit but blows the container budget.
    resourceBudgets: { maxOutputBytes: 1_000_000, maxBridgeCalls: 10_000 },
  });

  _activeRuntimes++;
  try {
    const code = buildCode(packageName, method, args, steps);
    // .mjs so the isolate uses ESM module mode (required for top-level await)
    const result = await runtime.run(code, '/root/index.mjs');

    if (result.code !== 0) {
      if (result.code === TIMEOUT_EXIT_CODE) {
        throw new Error(`Execution timed out after ${timeoutMs / 1000}s`);
      }
      const detail = result.errorMessage || `exit code ${result.code}`;
      throw new Error(`Sandbox execution failed: ${detail}`);
    }

    return unwrapDefault(result.exports);
  } finally {
    // Await termination BEFORE freeing the slot. terminate() disposes the V8 isolate;
    // decrementing first would admit a new request while the outgoing isolate still
    // holds its heap, so the real isolate count could exceed MAX_CONCURRENT_RUNTIMES
    // without bound under load — defeating the memory budget the cap exists to enforce.
    try {
      await runtime.terminate();
    } catch (err) {
      console.warn(`[sandbox] runtime.terminate() failed: ${err.message}`);
    } finally {
      _activeRuntimes--;
    }
  }
}
