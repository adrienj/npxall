# anyx

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![CI](https://github.com/adrienj/anyx/actions/workflows/ci.yml/badge.svg)](https://github.com/adrienj/anyx/actions/workflows/ci.yml)
[![Web UI](https://img.shields.io/badge/web-adrienj.github.io%2Fanyx-blue)](https://adrienj.github.io/anyx/)

**Run any npm function directly from the command line — without writing a script.**

```bash
npx anyx lodash camelCase "hello world"   # → helloWorld
npx anyx ms 2000                          # → 2s
npx anyx change-case snakeCase "Foo Bar"  # → foo_bar
```

Packages are downloaded on first use and cached in `~/.anyx/`. No global installs, no boilerplate.

---

## Install

```bash
npm install -g anyx
```

Or use without installing via `npx anyx <package> ...`.

---

## Usage

```
anyx <package> [method] [args...]
```

### Basic call

```bash
anyx ms 60000                              # → 1m
anyx semver valid "1.2.3"                  # → 1.2.3
anyx semver gt "2.0.0" "1.0.0"            # → true
anyx lodash chunk '[1,2,3,4]' 2           # → [[1,2],[3,4]]
```

### Method chaining with `.`

```bash
anyx lodash "hello world" . split " " . reverse . join "-"
# → world-hello
```

### Dot shorthand

```bash
anyx lodash camelCase.toUpper "hello world"
# → HELLOWORLD
```

### Sub-expressions `[ pkg method args ]`

Use `[...]` to pass the result of one call as an argument to another:

```bash
anyx lodash cloneDeep '[ lodash omit {"a":1,"b":2} "b" ]'
# → {"a":1}
```

### Stdin with `-`

```bash
echo '"hello world"' | anyx lodash camelCase -
# → helloWorld

cat data.json | anyx lodash get - "user.name"
```

### JSON arguments

Arguments that look like valid JSON are parsed automatically:

```bash
anyx lodash pick '{"a":1,"b":2,"c":3}' '["a","c"]'
# → {"a":1,"c":3}
```

---

## Web UI

Browse exported functions for any package at **[adrienj.github.io/anyx](https://adrienj.github.io/anyx/)** — type a package name and see every function with its signature, description, and ready-to-run CLI example.

---

## How it works

1. On first use, the package is installed into `~/.anyx/` (a private npm workspace).
2. The package is loaded via `require` or dynamic `import()` depending on its module format.
3. Arguments are JSON-parsed where possible, falling back to strings.
4. The result is printed to stdout as JSON (objects/arrays) or a plain string (primitives).

Packages are cached indefinitely — subsequent calls skip installation entirely.

---

## Development

```bash
git clone https://github.com/adrienj/anyx.git
cd anyx
npm install
npm test          # run CLI tests (79 tests)

cd web
npm install
npm test          # run web unit tests (21 tests)
npm run dev       # start local dev server at localhost:5173/anyx/
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[MIT](LICENSE)
