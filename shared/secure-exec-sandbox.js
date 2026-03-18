import { NodeRuntime, createNodeDriver, createNodeRuntimeDriverFactory } from 'secure-exec';
import { readFileSync } from 'fs';
import { join } from 'path';

/** Exit code used by secure-exec when CPU time limit is exceeded (matches GNU timeout convention). */
const TIMEOUT_EXIT_CODE = 124;

/**
 * Check if an installed npm package is ESM-only by reading its package.json.
 * Returns true if the package has `"type": "module"`.
 *
 * @param {string} cacheDir - per-package cache directory
 * @param {string} packageName - npm package name
 * @returns {boolean}
 */
function isEsmPackage(cacheDir, packageName) {
  const parts = packageName.startsWith('@') ? packageName.split('/').slice(0, 2) : [packageName];
  try {
    const pkg = JSON.parse(readFileSync(join(cacheDir, 'node_modules', ...parts, 'package.json'), 'utf8'));
    return pkg.type === 'module';
  } catch {
    return false;
  }
}

/**
 * Build the JavaScript code to execute inside the V8 isolate.
 * Handles both pipeline mode (API: steps array) and single-call mode (MCP: method + args).
 *
 * - CJS packages: uses `require()` with `module.exports` (synchronous, no wrapping)
 * - ESM packages: uses static `import * as` with `export default` (.mjs mode);
 *   result is wrapped as `{ default: value }` by the isolate runtime.
 *
 * @param {string} packageName
 * @param {string|undefined} method
 * @param {unknown[]|undefined} args
 * @param {Array<{method: string, args: unknown[]}>|undefined} steps
 * @param {boolean} isEsm - whether the package is ESM-only
 * @returns {string} JavaScript source code
 */
function buildCode(packageName, method, args, steps, isEsm) {
  const pkg = JSON.stringify(packageName);

  // Import statement: static import for ESM (supports top-level await),
  // require() for CJS (synchronous, no wrapping overhead).
  const importLine = isEsm
    ? `import * as _m from ${pkg};\nvar _mod = _m.default !== undefined ? _m.default : _m;\n`
    : `var _pkg = require(${pkg});\nvar _mod = _pkg && _pkg.default !== undefined ? _pkg.default : _pkg;\n`;

  // How to export the final value: ESM uses `export default`, CJS uses `module.exports`.
  const exportResult = (expr) => isEsm ? `export default ${expr};\n` : `module.exports = ${expr};\n`;

  // crypto-browserify polyfill (used by node:crypto in the isolate) checks process.browser to
  // decide between crypto.getRandomValues (available) and randombytes+Buffer.copy (broken in isolate).
  // Setting process.browser = true ensures it uses the Web Crypto path, fixing e.g. uuid.v4().
  const preamble = `process.browser = true;\n`;

  if (steps && Array.isArray(steps)) {
    // Pipeline mode (API): chain multiple method calls
    let code = preamble + importLine + `var _acc;\n`;

    for (let i = 0; i < steps.length; i++) {
      const { method: m, args: a = [] } = steps[i];
      const mStr = JSON.stringify(m);
      const aStr = JSON.stringify(a);

      if (i === 0) {
        code += `if (typeof _mod[${mStr}] === 'function') {\n` +
          `  _acc = _mod[${mStr}].apply(_mod, ${aStr});\n` +
          `} else if (typeof _mod === 'function') {\n` +
          `  var _p = (function() { try { return JSON.parse(${mStr}); } catch(e) { return ${mStr}; } }());\n` +
          `  _acc = _mod.apply(null, [_p].concat(${aStr}));\n` +
          `} else {\n` +
          `  throw new Error(${JSON.stringify(`'${m}' is not a function in '${packageName}'`)});\n` +
          `}\n`;
      } else {
        code += `if (_acc !== null && _acc !== undefined && typeof _acc[${mStr}] === 'function') {\n` +
          `  _acc = _acc[${mStr}].apply(_acc, ${aStr});\n` +
          `} else if (typeof _mod[${mStr}] === 'function') {\n` +
          `  _acc = _mod[${mStr}].apply(_mod, [_acc].concat(${aStr}));\n` +
          `} else {\n` +
          `  throw new Error(${JSON.stringify(`'${m}' is not a function on the result or '${packageName}'`)});\n` +
          `}\n`;
      }
    }

    code += exportResult('_acc !== undefined ? _acc : null');
    return code;
  }

  // Single method mode (MCP)
  let code = preamble + importLine;
  const a = JSON.stringify(args || []);

  if (method) {
    const mStr = JSON.stringify(method);
    code += `if (typeof _mod[${mStr}] !== 'function') {\n` +
      `  var _available = Object.keys(_mod).filter(function(k) { return typeof _mod[k] === 'function'; }).slice(0, 10);\n` +
      `  throw new Error(${JSON.stringify(`'${method}' is not a function in '${packageName}'. Available: `)} + _available.join(', '));\n` +
      `}\n` +
      `var _result = _mod[${mStr}].apply(_mod, ${a});\n`;
    code += exportResult('_result !== undefined ? _result : null');
  } else if (args && args.length > 0) {
    code += `if (typeof _mod !== 'function') {\n` +
      `  throw new Error(${JSON.stringify(`'${packageName}' is not a function`)});\n` +
      `}\n` +
      `var _result = _mod.apply(null, ${a});\n`;
    code += exportResult('_result !== undefined ? _result : null');
  } else {
    code += exportResult('_mod');
  }

  return code;
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
  const esm = isEsmPackage(cacheDir, packageName);

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
    memoryLimit: 64, // MB - V8 isolate heap limit
    cpuTimeLimitMs: timeoutMs,
  });

  try {
    const code = buildCode(packageName, method, args, steps, esm);
    // ESM packages need a .mjs extension so the isolate uses ESM module mode
    const filePath = esm ? '/root/index.mjs' : '/root/index.js';
    const result = await runtime.run(code, filePath);

    if (result.code !== 0) {
      if (result.code === TIMEOUT_EXIT_CODE) {
        throw new Error(`Execution timed out after ${timeoutMs / 1000}s`);
      }
      throw new Error(result.errorMessage || `Execution failed with exit code ${result.code}`);
    }

    // ESM `export default value` wraps the result as `{ default: value }`
    return esm ? result.exports?.default ?? result.exports : result.exports;
  } finally {
    runtime.terminate().catch(() => {});
  }
}
