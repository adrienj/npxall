import { describe, it, expect } from 'vitest';
import { buildCode, validateMethodName, unwrapDefault } from './secure-exec-sandbox.js';

// These tests cover the pure parts of the sandbox: the source it generates and the
// names it will dispatch. They deliberately do NOT construct a V8 isolate, so they
// run on any Node version. End-to-end execution (and the fs/network/childProcess
// denials) is covered by api/server.test.js and mcp/server.test.js in CI.

describe('buildCode — module mode', () => {
  // Regression guard for the bug that broke every CommonJS package on this branch.
  // The generated code uses top-level `await` so that packages returning promises
  // resolve correctly. Top-level await is legal ONLY in ESM. The previous CJS branch
  // emitted `require()` + `module.exports` + a top-level await, which is a
  // SyntaxError — so `ms`, `lodash` and most of npm failed with
  // "await is only valid in async functions and the top level bodies of modules".
  it('emits ESM for every package, never CommonJS', () => {
    const code = buildCode('ms', undefined, [60000], undefined);
    expect(code).toContain('import * as _m from "ms"');
    expect(code).toContain('export default');
    expect(code).not.toContain('require(');
    expect(code).not.toContain('module.exports');
  });

  it('emits a top-level await, which is why ESM is mandatory', () => {
    const code = buildCode('lodash', 'camelCase', ['x'], undefined);
    expect(code).toMatch(/^(?!.*async function _run).*await _await\(/ms);
    expect(code).toContain('export default');
  });
});

describe('buildCode — injection containment', () => {
  // Every value interpolated into the generated source must go through
  // JSON.stringify. If any of these were concatenated raw, a package or method name
  // would break out of its string literal into executable isolate source.
  it('escapes a package name carrying a quote and a statement separator', () => {
    const code = buildCode('evil";globalThis.pwned=1;"', undefined, [], undefined);
    expect(code).not.toContain('globalThis.pwned=1;"\n');
    expect(code).toContain(JSON.stringify('evil";globalThis.pwned=1;"'));
  });

  it('escapes argument values', () => {
    const code = buildCode('lodash', 'identity', ['");globalThis.pwned=1;("'], undefined);
    expect(code).toContain(JSON.stringify(['");globalThis.pwned=1;("']));
  });
});

describe('validateMethodName', () => {
  // `_mod[name]` is a computed property lookup inside the isolate, so `constructor`
  // resolves to Function. Chained with a second step that calls it, an unauthenticated
  // GET becomes arbitrary JS execution in the isolate:
  //   GET /lodash/constructor/"return 40+2"/call/  ->  42
  // Confirmed reproducible against a running container before this guard was added.
  // The isolate still denies fs/network/childProcess, so it is not an escape — but it
  // defeats the "only the package's exported API is reachable" property.
  it.each(['constructor', '__proto__', 'prototype', 'call', 'apply', 'bind'])(
    'rejects the %s gadget',
    (name) => {
      expect(() => validateMethodName(name)).toThrow(/Invalid method name/);
    },
  );

  it('rejects non-string names', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(() => validateMethodName(bad)).toThrow(/Invalid method name/);
    }
  });

  // The segment after the package name is overloaded: in a bare-function call it
  // carries the ARGUMENT, not a method name. `/ms/60000` and
  // `/@sindresorhus/slugify/Hello World` must keep working, so this guard must not
  // become an identifier allowlist. Enforcing one broke 5 tests when first written.
  it('accepts non-identifier segments, which bare-function calls rely on', () => {
    for (const ok of ['60000', 'Hello World', 'hello-world', '2026-01-01', '']) {
      expect(() => validateMethodName(ok)).not.toThrow();
    }
  });

  it('marks the rejection as a client error, not a server error', () => {
    expect.assertions(1);
    try {
      validateMethodName('constructor');
    } catch (err) {
      expect(err.status).toBe(400);
    }
  });

  it('accepts ordinary method names', () => {
    for (const ok of ['camelCase', 'reverse', 'slice', '_private', '$dollar', 'toString']) {
      expect(() => validateMethodName(ok)).not.toThrow();
    }
  });
});

describe('buildCode — method validation reaches every pipeline step', () => {
  // The gadget needs TWO steps (generate, then invoke), so validating only the first
  // step would leave it fully exploitable.
  it('rejects a forbidden method in a later step', () => {
    const steps = [{ method: 'concat', args: [[1, 2]] }, { method: 'constructor', args: [] }];
    expect(() => buildCode('lodash', undefined, undefined, steps)).toThrow(/Invalid method name/);
  });

  it('rejects a forbidden method in single-call mode', () => {
    expect(() => buildCode('lodash', 'constructor', ['return 1'], undefined))
      .toThrow(/Invalid method name/);
  });
});

describe('unwrapDefault', () => {
  // `export default value` comes back as { default: value }. The previous unwrap used
  // `exports?.default ?? exports`, so a package legitimately returning null (lodash.noop,
  // and every undefined return, which is coerced to null) fell through the ?? and leaked
  // the raw wrapper object to the caller as {"default":null}.
  it('returns null — not the wrapper — when the package returned null', () => {
    expect(unwrapDefault({ default: null })).toBeNull();
  });

  it('unwraps ordinary values', () => {
    expect(unwrapDefault({ default: '1m' })).toBe('1m');
    expect(unwrapDefault({ default: [1, 2] })).toEqual([1, 2]);
    expect(unwrapDefault({ default: false })).toBe(false);
    expect(unwrapDefault({ default: 0 })).toBe(0);
  });

  it('passes through exports that have no default key', () => {
    expect(unwrapDefault({ a: 1 })).toEqual({ a: 1 });
    expect(unwrapDefault(null)).toBeNull();
  });
});
