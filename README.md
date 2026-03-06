# npxall

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![CI](https://github.com/adrienj/npxall/actions/workflows/ci.yml/badge.svg)](https://github.com/adrienj/npxall/actions/workflows/ci.yml)
[![Web UI](https://img.shields.io/badge/web-adrienj.github.io%2Fnpxall-blue)](https://adrienj.github.io/npxall/)

**Run any npm function directly from the command line — without writing a script.**

```bash
npx npxall lodash camelCase "hello world"   # → helloWorld
npx npxall ms 2000                          # → 2s
npx npxall change-case snakeCase "Foo Bar"  # → foo_bar
```

Packages are downloaded on first use and cached in `~/.npxall/`. No global installs, no boilerplate.

---

## Install

```bash
npm install -g npxall
```

Or use without installing via `npx npxall <package> ...`.

---

## Usage

```
npxall <package> [method] [args...]
```

### Basic call

```bash
npxall ms 60000                              # → 1m
npxall semver valid "1.2.3"                  # → 1.2.3
npxall semver gt "2.0.0" "1.0.0"            # → true
npxall lodash chunk '[1,2,3,4]' 2           # → [[1,2],[3,4]]
npxall slugify "Hello World! 2024" '{"lower":true,"strict":true}'  # → hello-world-2024
npxall uuid v4                               # → 550e8400-e29b-41d4-a716-…
npxall pretty-bytes 1073741824              # → 1 GB
npxall chroma-js contrast '"#ff0000"' '"#ffffff"'  # → 3.998…
npxall yaml parse "key: value"              # → {"key":"value"}
npxall marked parse '"# Hello"'            # → <h1>Hello</h1>
npxall he encode '"<b>Hello & World</b>"'  # → &#x3C;b&#x3E;Hello &#x26; World&#x3C;/b&#x3E;
npxall qs stringify '{"page":1,"q":"foo"}' # → page=1&q=foo
npxall jsonpath query '{"a":{"b":42}}' '"$.a.b"'  # → [42]
npxall flat flatten '{"a":{"b":{"c":1}}}'  # → {"a.b.c":1}
```

### Method chaining with `.`

```bash
npxall lodash "hello world" . split " " . reverse . join "-"
# → world-hello
```

### Dot shorthand

```bash
npxall lodash camelCase.toUpper "hello world"
# → HELLOWORLD
```

### Sub-expressions `[ pkg method args ]`

Use `[...]` to pass the result of one call as an argument to another:

```bash
npxall lodash cloneDeep '[ lodash omit {"a":1,"b":2} "b" ]'
# → {"a":1}
```

### Stdin with `-`

```bash
echo '"hello world"' | npxall lodash camelCase -
# → helloWorld

cat data.json | npxall lodash get - "user.name"
```

### Shell substitution `"$(command)"`

Pass the output of any shell command as an argument. **Always double-quote** the substitution — without quotes the shell word-splits the output on whitespace and only the first word reaches npxall.

```bash
# Parse a YAML config file
npxall yaml parse "$(cat config.yaml)"

# Query a JSON file with a JSONPath expression
npxall jsonpath query "$(cat users.json)" '"$.users[0].name"'

# Convert a Markdown file to HTML
npxall marked parse "$(cat README.md)"

# HTML-encode a template
npxall he encode "$(cat template.html)"

# Turn a JSON filter file into a query string
npxall qs stringify "$(cat filter.json)"

# Combine with chaining
npxall yaml parse "$(cat config.yaml)" . get '"db.host"'
```

#### Shell compatibility

| Shell | Syntax | Notes |
|-------|--------|-------|
| sh, bash, zsh, dash | `"$(cat file)"` | Standard POSIX substitution |
| PowerShell (pwsh) | `"$(cat file)"` | `cat` aliases `Get-Content` on Windows; identical syntax on macOS/Linux |
| fish | `(cat file \| string collect)` | Different substitution syntax; `string collect` joins lines into one argument |
| cmd.exe | ❌ | No substitution support — use Git Bash, WSL, or PowerShell |

> **Why the quotes matter:**
> `"$(cat file)"` → one argument containing the full file content
> `$(cat file)` → shell word-splits on whitespace; npxall only sees the first word

### JSON arguments

Arguments that look like valid JSON are parsed automatically:

```bash
npxall lodash pick '{"a":1,"b":2,"c":3}' '["a","c"]'
# → {"a":1,"c":3}
```

---

## Web UI

Browse exported functions for any package at **[adrienj.github.io/npxall](https://adrienj.github.io/npxall/)** — type a package name and see every function with its signature, description, and ready-to-run CLI example.

---

## How it works

1. On first use, the package is installed into `~/.npxall/` (a private npm workspace).
2. The package is loaded via `require` or dynamic `import()` depending on its module format.
3. Arguments are JSON-parsed where possible, falling back to strings.
4. The result is printed to stdout as JSON (objects/arrays) or a plain string (primitives).

Packages are cached indefinitely — subsequent calls skip installation entirely.

---

## Development

```bash
git clone https://github.com/adrienj/npxall.git
cd npxall
npm install
npm test          # run CLI tests (146 tests)

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
