import { NodeRuntime, createNodeDriver, createNodeRuntimeDriverFactory } from 'secure-exec';

/** Exit code used by secure-exec when CPU time limit is exceeded (matches GNU timeout convention). */
const TIMEOUT_EXIT_CODE = 124;

/**
 * Build the JavaScript code to execute inside the V8 isolate.
 * Handles both pipeline mode (API: steps array) and single-call mode (MCP: method + args).
 *
 * @param {string} packageName
 * @param {string|undefined} method
 * @param {unknown[]|undefined} args
 * @param {Array<{method: string, args: unknown[]}>|undefined} steps
 * @returns {string} JavaScript source code
 */
function buildCode(packageName, method, args, steps) {
  const pkg = JSON.stringify(packageName);

  if (steps && Array.isArray(steps)) {
    // Pipeline mode (API): chain multiple method calls
    let code = `var _pkg = require(${pkg});\nvar _mod = _pkg && _pkg.default !== undefined ? _pkg.default : _pkg;\nvar _acc;\n`;

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

    code += `module.exports = _acc !== undefined ? _acc : null;\n`;
    return code;
  }

  // Single method mode (MCP)
  let code = `var _pkg = require(${pkg});\nvar _mod = _pkg && _pkg.default !== undefined ? _pkg.default : _pkg;\n`;
  const a = JSON.stringify(args || []);

  if (method) {
    const mStr = JSON.stringify(method);
    code += `if (typeof _mod[${mStr}] !== 'function') {\n` +
      `  var _available = Object.keys(_mod).filter(function(k) { return typeof _mod[k] === 'function'; }).slice(0, 10);\n` +
      `  throw new Error(${JSON.stringify(`'${method}' is not a function in '${packageName}'. Available: `)} + _available.join(', '));\n` +
      `}\n` +
      `var _result = _mod[${mStr}].apply(_mod, ${a});\n` +
      `module.exports = _result !== undefined ? _result : null;\n`;
  } else if (args && args.length > 0) {
    code += `if (typeof _mod !== 'function') {\n` +
      `  throw new Error(${JSON.stringify(`'${packageName}' is not a function`)});\n` +
      `}\n` +
      `var _result = _mod.apply(null, ${a});\n` +
      `module.exports = _result !== undefined ? _result : null;\n`;
  } else {
    code += `module.exports = _mod;\n`;
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
    const code = buildCode(packageName, method, args, steps);
    const result = await runtime.run(code, '/root/index.js');

    if (result.code !== 0) {
      if (result.code === TIMEOUT_EXIT_CODE) {
        throw new Error(`Execution timed out after ${timeoutMs / 1000}s`);
      }
      throw new Error(result.errorMessage || `Execution failed with exit code ${result.code}`);
    }

    return result.exports;
  } finally {
    runtime.terminate().catch(() => {});
  }
}
