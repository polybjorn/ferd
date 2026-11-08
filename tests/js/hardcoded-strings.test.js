'use strict';
// A ratchet on English text written straight into the Preact views' templates
// instead of going through t() from app/i18n.js. Each ceiling below is what a
// module holds today. A change that adds one fails here: add a key to the
// table and call t(). A change that removes some fails too, until the ceiling
// is lowered to match, so the slack can't be spent again. The scan reads only
// the static parts of html`...` templates, so text built in plain strings
// outside a template is not counted; treat the numbers as a floor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '..', 'app');

// Lower these as views move to t(). Never raise them, and drop a line at 0.
const CEILINGS = {
  'app/map/route-detail.js': 1,
};

const TEXT_NODE = />\s*[A-Z][a-z]/g;
const ATTRIBUTE = /(?<![\w-])(?:title|aria-label|placeholder|alt)="[^"]*[A-Za-z]/g;

/**
 * The static chunks of every html`...` template in `src`, nested ones
 * included. A module that imports `html as vhtml` tags its templates vhtml.
 */
function templateChunks(src) {
  const tag = '(?:' + ['html', ...[...src.matchAll(/\bhtml as (\w+)/g)].map(m => m[1])].join('|') + ')';
  const chunks = [];
  let i = 0;

  function skipString(q) {
    for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
    i++;
  }
  // i sits just past the opening backtick; leaves i just past the closing one.
  function template(isHtml) {
    let chunk = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') { chunk += src.slice(i, i + 2); i += 2; continue; }
      if (ch === '`') { i++; break; }
      if (ch === '$' && src[i + 1] === '{') {
        if (isHtml) chunks.push(chunk);
        chunk = '';
        i += 2;
        expression();
        continue;
      }
      chunk += ch;
      i++;
    }
    if (isHtml) chunks.push(chunk);
  }
  // i sits just past `${`; leaves i just past the matching `}`.
  function expression() {
    let depth = 1;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\'' || ch === '"') { skipString(ch); continue; }
      if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
      if (ch === '`') {
        const isHtml = new RegExp('\\b' + tag + '$').test(src.slice(Math.max(0, i - 20), i));
        i++;
        template(isHtml);
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { i++; return; }
      i++;
    }
  }

  const start = new RegExp('\\b' + tag + '`', 'g');
  let m;
  while ((m = start.exec(src))) {
    i = m.index + m[0].length;
    template(true);
    start.lastIndex = i;
  }
  return chunks;
}

function countStrings(src) {
  return templateChunks(src).reduce(
    (n, chunk) => n + (chunk.match(TEXT_NODE) || []).length + (chunk.match(ATTRIBUTE) || []).length, 0);
}

function counts() {
  const out = {};
  for (const f of fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.js') && f !== 'i18n.js').sort()) {
    const n = countStrings(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (n) out['app/' + f.split(path.sep).join('/')] = n;
  }
  return out;
}

test('no Preact view holds more hard-coded strings than its ceiling', () => {
  const now = counts();
  const over = Object.entries(now)
    .filter(([f, n]) => n > (CEILINGS[f] || 0))
    .map(([f, n]) => `${f} has ${n} hard-coded strings, over the ceiling of ${CEILINGS[f] || 0}`);
  assert.deepEqual(over, [], 'add a key to app/i18n.js and call t() instead');
});

test('every ceiling matches its count', () => {
  const now = counts();
  const slack = Object.entries(CEILINGS)
    .filter(([f, ceiling]) => (now[f] || 0) < ceiling)
    .map(([f, ceiling]) => `${f} is down to ${now[f] || 0}: lower its ceiling from ${ceiling}` + (now[f] ? '' : ' by dropping the line'));
  assert.deepEqual(slack, [], 'lower the ceilings in tests/js/hardcoded-strings.test.js');
});

test('counts text nodes and literal attributes, not slots or keys', () => {
  const src = [
    'const a = html`<div title="Go to source" aria-label=${t(\'x\')}><p>No places yet.</p>',
    '  ${ok && html`<button alt="" placeholder="Name">Save</button>`}',
    '  <span>${n} items</span><p>${t(\'y\')}</p></div>`;',
    'const b = `<p>Not a template</p>`;',
    'const c = html`<p>${`<b>Plain</b>`}</p><${Foo} label="Bar" />`;',
    'import { html as vhtml } from "./view.js"; const d = vhtml`<h2>Meta</h2>`;',
  ].join('\n');
  // title, "No places", placeholder, "Save" and the aliased "Meta"; not
  // alt="", the slots, the plain template literals or a component prop.
  assert.equal(countStrings(src), 5);
});
