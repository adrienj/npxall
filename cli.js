#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';

const CACHE_DIR = join(homedir(), '.npxall');
const CACHE_PKG = join(CACHE_DIR, 'package.json');

function ensureCache() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_PKG, JSON.stringify({ name: 'anyx-cache', version: '1.0.0', private: true }));
  }
}

function pkgDir(packageName) {
  const parts = packageName.startsWith('@') ? packageName.split('/').slice(0, 2) : [packageName];
  return join(CACHE_DIR, 'node_modules', ...parts);
}

function isInstalled(packageName) {
  return existsSync(pkgDir(packageName));
}

function install(packageName) {
  ensureCache();
  const result = spawnSync('npm', ['install', packageName, '--no-save', '--silent'], {
    cwd: CACHE_DIR,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.stderr.write(`Failed to install '${packageName}'\n`);
    if (result.stderr) process.stderr.write(result.stderr.toString());
    process.exit(1);
  }
}

async function loadPackage(packageName) {
  const req = createRequire(CACHE_PKG);
  let cjsError;
  try {
    return req(packageName);
  } catch (e) {
    cjsError = e;
  }
  // CJS require failed — try ESM import
  try {
    const dir = pkgDir(packageName);
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const exports = meta.exports;
    const mainField =
      (typeof exports === 'object' && exports !== null
        ? exports['.']?.import ?? exports['.']?.default ?? (typeof exports['.'] === 'string' ? exports['.'] : null)
        : null)
      ?? meta.module ?? meta.main ?? 'index.js';
    return await import(pathToFileURL(join(dir, mainField)).href);
  } catch (e) {
    process.stderr.write(`Failed to load '${packageName}': ${cjsError?.message ?? e.message}\n`);
    process.exit(1);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString().trim();
}

// ─── Double-dash args: --key=value or --key value → {key: value} ─────────────

function parseDoubleDashArgs(tokens) {
  const result = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === '--') {
      // Bare -- means stdin JSON
      result.push(token);
      i++;
      continue;
    }
    if (typeof token === 'string' && token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      if (eqIdx !== -1) {
        // --key=value form
        const key = token.slice(2, eqIdx);
        const value = token.slice(eqIdx + 1);
        result.push({ __dblDash: true, [key]: parseValue(value) });
      } else {
        // --key value form (next token is the value, not a flag)
        const key = token.slice(2);
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          result.push({ __dblDash: true, [key]: parseValue(next) });
          i++;
        } else {
          // Boolean flag: --flag → {flag: true}
          result.push({ __dblDash: true, [key]: true });
        }
      }
      i++;
      continue;
    }
    result.push(token);
    i++;
  }
  return result;
}

// Parse a value: try JSON, then comma-separated array, then string
function parseValue(val) {
  // Try JSON first
  try { return JSON.parse(val); } catch {}
  // Try comma-separated array
  if (val.includes(',')) {
    const parts = val.split(',').map(p => p.trim()).filter(p => p !== '');
    if (parts.length > 1) {
      // Try to parse each part as JSON, fall back to string
      return parts.map(p => {
        try { return JSON.parse(p); } catch { return p; }
      });
    }
  }
  // Fall back to string
  return val;
}

// Merge multiple --flag objects into a single object
// Handles: [method, --flag1, --flag2] → [method, {flag1, flag2}]
// Or: [--flag1, --flag2] → [{flag1, flag2}] (if no method name)
function mergeDoubleDashArgs(tokens) {
  if (tokens.length === 0) return tokens;
  
  // Find where the dbl-dash tokens start
  // First, check if FIRST token is already a dbl-dash object
  if (typeof tokens[0] === 'object' && tokens[0].__dblDash) {
    // All tokens are --flags, merge them all
    const merged = {};
    for (const token of tokens) {
      if (typeof token === 'object' && token.__dblDash) {
        Object.assign(merged, token);
      }
    }
    delete merged.__dblDash;
    return Object.keys(merged).length > 0 ? [merged] : tokens;
  }
  
  // First token is NOT a dbl-dash (likely method name)
  // Look for dbl-dash tokens after the method name
  let dblDashStart = -1;
  for (let i = 1; i < tokens.length; i++) {
    if (typeof tokens[i] === 'object' && tokens[i].__dblDash) {
      dblDashStart = i;
      break;
    }
  }
  
  if (dblDashStart === -1) {
    // No dbl-dash tokens found
    return tokens;
  }
  
  // Merge the dbl-dash tokens into a single object
  const methodName = tokens[0];
  const dblDashTokens = tokens.slice(dblDashStart);
  
  const merged = {};
  for (const token of dblDashTokens) {
    if (typeof token === 'object' && token.__dblDash) {
      Object.assign(merged, token);
    }
  }
  delete merged.__dblDash;
  
  if (Object.keys(merged).length > 0) {
    return [methodName, merged];
  }
  return tokens;
}

function makeParseArg(stdin) {
  return function parseArg(token) {
    if (token === '-') {
      if (stdin === null) { process.stderr.write('Error: - used but no stdin\n'); process.exit(1); }
      try { return JSON.parse(stdin); } catch { return stdin; }
    }
    // Try JSON first
    try { return JSON.parse(token); } catch {}
    // Try comma-separated array
    if (typeof token === 'string' && token.includes(',')) {
      const parts = token.split(',').map(p => p.trim()).filter(p => p !== '');
      if (parts.length > 1) {
        return parts.map(p => {
          try { return JSON.parse(p); } catch { return p; }
        });
      }
    }
    return token;
  };
}

// ─── Shell string tokenizer (for quoted subexpressions) ──────────────────────

// Tokenize a string the way a shell would, respecting single/double quotes.
// Used to parse '[ pkg method args... ]' passed as a single quoted shell word.
function tokenizeShell(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let token = '';
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) { i++; token += s[i]; }
        else token += s[i];
        i++;
      }
      i++;
    } else if (s[i] === "'") {
      i++;
      while (i < s.length && s[i] !== "'") token += s[i++];
      i++;
    } else {
      while (i < s.length && !/\s/.test(s[i])) token += s[i++];
    }
    if (token) tokens.push(token);
  }
  return tokens;
}

// Detect a quoted subexpression string like '[ pkg method args ]'.
// Returns inner token array, or null if not a subexpr string.
function tryParseSubexprString(token) {
  if (typeof token !== 'string') return null;
  const t = token.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  // Valid JSON arrays like [1,2,3] are NOT subexpressions.
  try { JSON.parse(t); return null; } catch {}
  const inner = t.slice(1, -1).trim();
  if (!inner) return null;
  return tokenizeShell(inner);
}

// ─── Token grouping ──────────────────────────────────────────────────────────

// Group [ ... ] spans into subexpr objects: { subexpr: string[] }
// Supports nesting: [ pkg method [ pkg2 method2 arg ] ]
function groupSubExpressions(tokens) {
  const result = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === '[') {
      // Unquoted form: [ pkg method args ]
      let depth = 1, j = i + 1;
      while (j < tokens.length && depth > 0) {
        if (tokens[j] === '[') depth++;
        else if (tokens[j] === ']') depth--;
        j++;
      }
      result.push({ subexpr: tokens.slice(i + 1, j - 1) });
      i = j;
    } else {
      // Quoted form: '[ pkg method args ]' passed as a single shell word
      const inner = tryParseSubexprString(tokens[i]);
      if (inner !== null) {
        result.push({ subexpr: inner });
      } else {
        result.push(tokens[i]);
      }
      i++;
    }
  }
  return result;
}

// Expand "method.other" shorthands on string tokens only
function expandShorthands(tokens) {
  const identChain = /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)+$/;
  return tokens.flatMap(token =>
    typeof token === 'string' && identChain.test(token)
      ? token.split('.').flatMap(part => ['.', part])
      : [token]
  );
}

function splitByDot(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (token === '.') { segments.push(current); current = []; }
    else current.push(token);
  }
  segments.push(current);
  return segments;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

async function resolveToken(token, stdin) {
  if (typeof token === 'object' && token.subexpr) {
    return evalSubExpr(token.subexpr, stdin);
  }
  return makeParseArg(stdin)(token);
}

async function resolveTokens(tokens, stdin) {
  return Promise.all(tokens.map(t => resolveToken(t, stdin)));
}

// Evaluate [ pkg method args... ] — raw JS result, no serialization
async function evalSubExpr(rawTokens, stdin) {
  const grouped = groupSubExpressions(rawTokens);
  const [pkgToken, ...rest] = grouped;
  const pkgName = typeof pkgToken === 'string' ? pkgToken : null;
  if (!pkgName) { process.stderr.write('Sub-expression must start with a package name\n'); process.exit(1); }
  validatePackageName(pkgName);
  if (!isInstalled(pkgName)) install(pkgName);
  const raw = await loadPackage(pkgName);
  const mod = raw?.default ?? raw;
  const resolved = await resolveTokens(rest, stdin);
  return dispatch(mod, pkgName, resolved);
}

async function dispatch(mod, packageName, resolvedArgs) {
  // Method dispatch: first arg is a string name of a function on mod
  if (resolvedArgs.length > 0 && typeof resolvedArgs[0] === 'string' && typeof mod[resolvedArgs[0]] === 'function') {
    const [method, ...params] = resolvedArgs;
    return mod[method].apply(mod, params);
  }
  // Direct call
  if (typeof mod === 'function') return mod.apply(null, resolvedArgs);
  // No-arg: return the module value itself
  return mod;
}

async function callMethod(mod, packageName, methodToken, resolvedArgs) {
  if (typeof methodToken !== 'string' || typeof mod[methodToken] !== 'function') {
    process.stderr.write(`Error: '${methodToken}' is not a function in '${packageName}'\n`);
    process.stderr.write(`Available: ${Object.keys(mod).filter(k => typeof mod[k] === 'function').slice(0, 10).join(', ')}\n`);
    process.exit(1);
  }
  return mod[methodToken].apply(mod, resolvedArgs);
}

function formatResult(result) {
  if (result === undefined) return 'undefined';
  if (result === null) return 'null';
  if (typeof result === 'object') return JSON.stringify(result, null, 2);
  return String(result);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const PKG_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function validatePackageName(name) {
  if (!PKG_NAME_RE.test(name)) {
    process.stderr.write(`Error: invalid package name '${name}'\n`);
    process.exit(1);
  }
}

// ─── --setup: add shell function so bare [ ] work in zsh ─────────────────────

function runSetup() {
  const shell = process.env.SHELL ?? '';
  const home = homedir();
  let rcFile;
  if (shell.includes('zsh'))       rcFile = join(home, '.zshrc');
  else if (shell.includes('bash')) rcFile = join(home, '.bashrc');
  else {
    process.stderr.write('Unknown shell. Add this to your shell config manually:\n');
    process.stderr.write("  npxall() { noglob npx npxall \"$@\"; }\n");
    process.exit(0);
  }

  const marker = '# added by npxall --setup';
  let existing = '';
  try { existing = readFileSync(rcFile, 'utf8'); } catch {}

  if (existing.includes(marker)) {
    process.stdout.write(`Shell function already present in ${rcFile}\n`);
    process.stdout.write(`Reload with: source ${rcFile}\n`);
    process.exit(0);
  }

  // In bash, [  ] don't cause glob issues so a plain passthrough is fine.
  const fn = shell.includes('zsh')
    ? `npxall() { noglob npx npxall "$@"; }`
    : `npxall() { npx npxall "$@"; }`;

  appendFileSync(rcFile, `\n${marker}\n${fn}\n`);
  process.stdout.write(`Added shell function to ${rcFile}\n`);
  process.stdout.write(`Run: source ${rcFile}\n`);
  process.stdout.write(`Then use brackets without quoting:\n`);
  process.stdout.write(`  npxall lodash cloneDeep [ lodash omit '{"a":1,"b":2}' b ]\n`);
  process.exit(0);
}

const [packageName, ...rawRest] = process.argv.slice(2);

if (packageName === '--setup') runSetup();

if (!packageName) {
  process.stdout.write(`
npxall — run any npm function from the command line.
Never write a one-off script again. (Limitations apply. Not valid in production. Consult your architect.)

Usage:
  npxall <package> [method] [args...]

Examples:
  npxall ms 60000                               → 1m
  npxall semver valid "1.2.3"                   → 1.2.3
  npxall lodash camelCase "hello world"         → helloWorld
  npxall pretty-bytes 1073741824                → 1 GB
  npxall uuid v4                                → 550e8400-...
  npxall slugify "Hello World" '{"lower":true}' → hello-world
  npxall yaml parse "key: value"                → {"key":"value"}

Features:
  Method chaining      npxall lodash "foo bar" . split " " . reverse . join "-"
  Dot shorthand        npxall lodash camelCase.toUpper "hello world"
  Sub-expressions      npxall lodash cloneDeep '[ lodash omit {"a":1,"b":2} "b" ]'
  Stdin                echo '"hello"' | npxall lodash camelCase -
  Shell substitution   npxall yaml parse "$(cat config.yaml)"
  Double-dash args     npxall lodash pick --obj='{"a":1}' --paths=a
  Comma arrays         npxall lodash uniq 1,2,3,2,1

Shell setup (enables bare [ ] brackets):
  npxall --setup

REST API:
  https://api.npxall.com/<package>/<method>/<args>/<method>/<args>
  POST https://api.npxall.com/<package>/<method>  (JSON array body as args)

Docs: https://npxall.com
`);
  process.exit(0);
}

validatePackageName(packageName);

if (!isInstalled(packageName)) install(packageName);
const raw = await loadPackage(packageName);
const mod = raw?.default ?? raw;

// Pre-read stdin only if needed
const needsStdin = rawRest.includes('-');
const stdin = needsStdin ? await readStdin() : null;

// Pre-process double-dash args: --key=value → {key: value}
const processedRest = parseDoubleDashArgs(rawRest);

// If all args were --flags, merge them into a single object argument
const maybeMerged = mergeDoubleDashArgs(processedRest);

// Check if merge happened: last element is the merged object (and we have more than just the merged object)
const lastIsMerged = maybeMerged.length > 0 && typeof maybeMerged[maybeMerged.length - 1] === 'object' && !Array.isArray(maybeMerged[maybeMerged.length - 1]);
const finalRest = lastIsMerged && maybeMerged.length !== 1
  ? maybeMerged  // Merge happened, use merged result
  : processedRest;

// Group sub-expressions, expand shorthands, split by dot
const grouped = groupSubExpressions(finalRest);
const segments = splitByDot(expandShorthands(grouped));
const isChained = segments.length > 1;

if (isChained) {
  let acc;
  let methodSegments;
  const first = segments[0];

  if (first.length === 0) {
    // Leading dot: first method segment called with no prepended accumulator
    const [methodToken, ...args] = segments[1];
    const resolved = await resolveTokens(args, stdin);
    acc = await callMethod(mod, packageName, methodToken, resolved);
    methodSegments = segments.slice(2);
  } else if (first.length === 1 && typeof first[0] === 'string' && typeof mod[first[0]] !== 'function') {
    acc = await resolveToken(first[0], stdin);
    methodSegments = segments.slice(1);
  } else {
    const resolved = await resolveTokens(first, stdin);
    acc = await dispatch(mod, packageName, resolved);
    methodSegments = segments.slice(1);
  }

  for (const segment of methodSegments) {
    if (segment.length === 0) continue;
    const [methodToken, ...args] = segment;
    const resolved = await resolveTokens(args, stdin);
    acc = await callMethod(mod, packageName, methodToken, [acc, ...resolved]);
  }

  process.stdout.write(formatResult(acc) + '\n');
  process.exit(0);
}

// Single call
const resolvedArgs = await resolveTokens(grouped, stdin);
const result = await dispatch(mod, packageName, resolvedArgs);
process.stdout.write(formatResult(result) + '\n');
