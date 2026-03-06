import { lookup } from './lookup';
import type { FnDoc } from './lookup';

const app = document.querySelector<HTMLDivElement>('#app')!;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Terminal demo ─────────────────────────────────────────────────────────────

const DEMOS: Array<{ cmd: string; result: string }> = [
  { cmd: 'npx npxall ms 86400000',                                  result: '1d'           },
  { cmd: 'npxall change-case camelCase "hello world"',              result: 'helloWorld'   },
  { cmd: 'npx npxall semver gt "2.0.0" "1.0.0"',                   result: 'true'         },
  { cmd: "npxall lodash chunk '[1,2,3,4,5,6]' 2",                  result: '[[1,2],[3,4],[5,6]]' },
  { cmd: 'npx npxall lodash "foo bar" . split " " . reverse . join "-"', result: 'bar-foo' },
];

async function startTerminalDemo(): Promise<void> {
  let i = 0;
  while (true) {
    const body = document.getElementById('term-body');
    if (!body) return;

    const demo = DEMOS[i % DEMOS.length];

    const line = document.createElement('div');
    line.className = 'tl';
    line.innerHTML = '<span class="tp">%</span><span class="tc"></span><span class="tk">▋</span>';
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;

    const tc = line.querySelector<HTMLSpanElement>('.tc')!;
    const tk = line.querySelector<HTMLSpanElement>('.tk')!;

    for (const char of demo.cmd) {
      if (!document.getElementById('term-body')) return;
      tc.textContent += char;
      await sleep(36 + Math.random() * 24);
    }

    await sleep(200);
    tk.remove();
    await sleep(80);

    const res = document.createElement('div');
    res.className = 'tr';
    res.textContent = demo.result;
    body.appendChild(res);
    body.scrollTop = body.scrollHeight;

    await sleep(2000);
    while (body.children.length > 12) body.children[0].remove();
    i++;
  }
}

// ── Landing ───────────────────────────────────────────────────────────────────

function exCard(label: string, cmd: string, result: string): string {
  return `
    <div class="ex-card">
      <div class="ex-label">${escHtml(label)}</div>
      <div class="ex-cmd"><span class="ex-dollar">$</span> ${escHtml(cmd)}</div>
      <div class="ex-result">${escHtml(result)}</div>
    </div>
  `;
}

function landingHtml(): string {
  return `
    <section class="landing">

      <div class="term-window">
        <div class="term-bar">
          <span class="tdot" style="background:#ff5f57"></span>
          <span class="tdot" style="background:#febc2e"></span>
          <span class="tdot" style="background:#28c840"></span>
          <span class="tbar-title">zsh</span>
        </div>
        <div class="term-body" id="term-body"></div>
      </div>

      <div class="syntax-note">
        Use <code>npx npxall</code> without installing — or <code>npm install -g npxall</code> for the short form <code>npxall</code>
      </div>

      <div class="feat-row">
        <span class="feat-badge feat-primary">2M+ packages</span>
        <span class="feat-badge">Zero setup</span>
        <span class="feat-badge">Cached locally</span>
        <span class="feat-badge">Pipe-friendly</span>
        <span class="feat-badge">Method chaining</span>
      </div>

      <div class="install-strip">
        <div class="install-option">
          <span class="install-label">One-off</span>
          <code class="install-cmd">npx npxall &lt;package&gt; &lt;fn&gt; [args]</code>
        </div>
        <div class="install-divider">or</div>
        <div class="install-option">
          <span class="install-label">Global install</span>
          <code class="install-cmd">npm install -g npxall</code>
          <button class="install-copy" id="install-copy-btn">copy</button>
        </div>
      </div>

      <div class="ex-section">
        <h2 class="section-heading">One command. Any function.</h2>
        <div class="ex-grid">
          ${exCard('String case',     'npx npxall change-case camelCase "hello world"',             'helloWorld')}
          ${exCard('Time conversion', 'npx npxall ms 86400000',                                     '1d')}
          ${exCard('Version compare', 'npx npxall semver gt "2.0.0" "1.0.0"',                       'true')}
          ${exCard('Array split',     "npx npxall lodash chunk '[1,2,3,4]' 2",                      '[[1,2],[3,4]]')}
          ${exCard('Method chaining', 'npxall lodash "foo bar" . split " " . reverse . join "-"',   'bar-foo')}
          ${exCard('Stdin piping',    'echo "hello world" | npxall change-case pascalCase -',       'HelloWorld')}
        </div>
      </div>

      <div class="how-section">
        <h2 class="section-heading">How it works</h2>
        <div class="steps">
          <div class="step">
            <div class="step-n">1</div>
            <div class="step-body">
              <div class="step-title">Type a package and function</div>
              <div class="step-desc">Any of 2 million packages on npm — no script, no boilerplate.</div>
            </div>
          </div>
          <div class="step">
            <div class="step-n">2</div>
            <div class="step-body">
              <div class="step-title">Downloads once, cached forever</div>
              <div class="step-desc">Packages live in <code>~/.npxall/</code>. Every subsequent call is instant.</div>
            </div>
          </div>
          <div class="step">
            <div class="step-n">3</div>
            <div class="step-body">
              <div class="step-title">Result goes to stdout</div>
              <div class="step-desc">JSON for objects, plain text for primitives. Pipe it anywhere.</div>
            </div>
          </div>
        </div>
      </div>

      <div class="browse-cta">
        <span class="browse-label">Browse functions for any package</span>
        <button class="browse-btn" id="browse-focus-btn">Try the search ↑</button>
      </div>

      <footer class="site-footer">
        <a href="https://github.com/adrienj/anyx" target="_blank">GitHub</a>
        <span>·</span>
        <a href="https://www.npmjs.com/package/npxall" target="_blank">npm</a>
        <span>·</span>
        <span>MIT</span>
      </footer>

    </section>
  `;
}

function attachLanding() {
  document.getElementById('install-copy-btn')?.addEventListener('click', function(this: HTMLButtonElement) {
    navigator.clipboard.writeText('npm install -g npxall').then(() => {
      this.textContent = 'copied!';
      setTimeout(() => { this.textContent = 'copy'; }, 1800);
    }).catch(() => {});
  });

  document.getElementById('browse-focus-btn')?.addEventListener('click', () => {
    document.querySelector<HTMLInputElement>('input[name="pkg"]')?.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ── Search UI ─────────────────────────────────────────────────────────────────

function searchHtml(value = '') {
  return `
    <header>
      <div class="logo">npxall</div>
      <p class="tagline">Run any npm function from the command line</p>
      <form id="search" class="search-wrap">
        <input name="pkg" value="${escHtml(value)}" placeholder="lodash, semver, ms, change-case…" autocomplete="off" autofocus />
        <button type="submit">→</button>
      </form>
    </header>
  `;
}

function cardHtml(fn: FnDoc, i: number): string {
  const params = fn.params.map(p =>
    `<span class="param${p.optional ? ' opt' : ''}">${escHtml(p.name)}: ${escHtml(p.type)}</span>`
  ).join(', ');

  const delay = Math.min(i * 25, 500);
  const copyText = escHtml(fn.cliExample);
  const retBadge = fn.returnType && fn.returnType !== 'unknown'
    ? `<span class="ret-badge">→ ${escHtml(fn.returnType)}</span>`
    : '';

  return `
    <div class="card" style="--delay:${delay}ms">
      <div class="card-head">
        <span class="fn-name">${escHtml(fn.name)}</span>
        ${retBadge}
      </div>
      ${fn.doc ? `<p class="doc">${escHtml(fn.doc)}</p>` : ''}
      <div class="sig">(${params})</div>
      <div class="cli-block">
        <span class="cli-prompt">›</span>
        <pre class="cli">${copyText}</pre>
        <button class="copy-btn" data-copy="${copyText}" type="button">copy</button>
      </div>
    </div>
  `;
}

function attach() {
  document.querySelector<HTMLFormElement>('#search')?.addEventListener('submit', e => {
    e.preventDefault();
    const pkg = (e.currentTarget as HTMLFormElement).pkg.value.trim();
    if (pkg) run(pkg);
  });
}

function loadingHtml(pkg: string) {
  return `<p class="status">Loading <strong>${escHtml(pkg)}</strong><span class="dots"><span></span><span></span><span></span></span></p>`;
}

async function run(pkg: string) {
  app.innerHTML = searchHtml(pkg) + loadingHtml(pkg);
  attach();
  try {
    const fns = await lookup(pkg);
    app.innerHTML = searchHtml(pkg)
      + `<p class="status">${fns.length} functions — <strong>${escHtml(pkg)}</strong></p>`
      + `<div class="grid">${fns.map((fn, i) => cardHtml(fn, i)).join('')}</div>`;
    attach();
    history.replaceState(null, '', `#${encodeURIComponent(pkg)}`);

    app.querySelector('.grid')?.addEventListener('click', e => {
      const btn = (e.target as Element).closest<HTMLButtonElement>('.copy-btn');
      if (!btn) return;
      const text = btn.dataset.copy ?? '';
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1800);
      }).catch(() => {});
    });
  } catch (e: unknown) {
    app.innerHTML = searchHtml(pkg) + `<p class="error">${escHtml(e instanceof Error ? e.message : String(e))}</p>`;
    attach();
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const hash = location.hash.slice(1);
if (hash) {
  run(decodeURIComponent(hash));
} else {
  app.innerHTML = searchHtml() + landingHtml();
  attach();
  attachLanding();
  startTerminalDemo();
}
