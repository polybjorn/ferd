'use strict';
// A ratchet on English text written straight into the frontend instead of
// going through t() from app/i18n.js, and on innerHTML writes. Each ceiling
// below is what a module holds today. A change that adds one fails here: add a
// key to the table and call t(). A change that removes some fails too, until
// the ceiling is lowered to match, so the slack can't be spent again.
//
// Three counts, each with ceilings of its own:
// - TEMPLATES: text in the static parts of html`...` templates.
// - LITERALS: English in plain string literals assigned to textContent,
//   title, placeholder or ariaLabel, or passed to setAttribute for title,
//   aria-label or placeholder. Text built some other way is not counted, so
//   treat the numbers as a floor.
// - INNER_HTML: assignments to innerHTML, which go when a view moves to Preact.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '..', 'app');

// Lower these as views move to t(). Never raise them, and drop a line at 0.
const TEMPLATES = {
  'app/map/route-detail.js': 1,
};
const LITERALS = {
  'app/map/home-map.js': 4,
  'app/map/map-panel.js': 2,
  'app/map/route-detail.js': 4,
  'app/places-list.js': 7,
  'app/sign-in.js': 11,
};
const INNER_HTML = {
  'app/auth.js': 2,
  'app/list-controls.js': 2,
  'app/map/home-map.js': 8,
  'app/map/map-panel.js': 1,
  'app/map/map-phone.js': 4,
  'app/map/place-layer.js': 2,
  'app/map/route-detail.js': 9,
  'app/modal.js': 1,
  'app/sign-in.js': 3,
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

const SINK = /\.(?:textContent|title|placeholder|ariaLabel)\s*=(?!=)|\.setAttribute\(\s*['"](?:title|aria-label|placeholder)['"]\s*,/g;
// A literal written to one of those sinks is text unless it is a t() key,
// CSS or markup, or has no word in it (an icon letter, a separator).
const isEnglish = (/** @type {string} */ s) =>
  !/^[a-z]\w*(\.\w+)+$/.test(s) && !/[{};<>]/.test(s) && /[A-Za-z]{2}/.test(s);

/**
 * The string literals in the expression starting at `i`, up to the `;`, `,`
 * or unmatched closing bracket that ends it. A template literal gives its
 * static parts.
 */
function expressionLiterals(src, i) {
  const out = [];
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      let lit = '';
      for (i++; i < src.length && src[i] !== ch; i++) {
        if (src[i] === '\\') { lit += src[++i]; continue; }
        if (ch === '`' && src[i] === '$' && src[i + 1] === '{') {
          out.push(lit);
          lit = '';
          let d = 1;
          for (i += 2; i < src.length && d; i++) if (src[i] === '{') d++; else if (src[i] === '}') d--;
          i--;
          continue;
        }
        lit += src[i];
      }
      out.push(lit);
      i++;
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth-- === 0) break; }
    else if ((ch === ';' || ch === ',') && depth === 0) break;
    i++;
  }
  return out;
}

function countLiterals(src) {
  let n = 0;
  for (const m of src.matchAll(SINK)) {
    n += expressionLiterals(src, /** @type {number} */ (m.index) + m[0].length).filter(isEnglish).length;
  }
  return n;
}

function countInnerHtml(src) {
  return (src.match(/\.innerHTML\s*=(?!=)/g) || []).length;
}

/** @param {(src: string) => number} count */
function counts(count) {
  const out = {};
  for (const f of fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.js') && f !== 'i18n.js').sort()) {
    const n = count(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (n) out['app/' + f.split(path.sep).join('/')] = n;
  }
  return out;
}

const RATCHETS = [
  ['hard-coded template strings', TEMPLATES, countStrings, 'TEMPLATES', 'add a key to app/i18n.js and call t() instead'],
  ['hard-coded literal strings', LITERALS, countLiterals, 'LITERALS', 'add a key to app/i18n.js and call t() instead'],
  ['innerHTML writes', INNER_HTML, countInnerHtml, 'INNER_HTML', 'render it with Preact or build the nodes instead'],
];

for (const [what, ceilings, count, name, fix] of RATCHETS) {
  test(`no module holds more ${what} than its ceiling`, () => {
    const now = counts(count);
    const over = Object.entries(now)
      .filter(([f, n]) => n > (ceilings[f] || 0))
      .map(([f, n]) => `${f} has ${n} ${what}, over the ceiling of ${ceilings[f] || 0}`);
    assert.deepEqual(over, [], fix);
  });

  test(`every ${name} ceiling matches its count`, () => {
    const now = counts(count);
    const slack = Object.entries(ceilings)
      .filter(([f, ceiling]) => (now[f] || 0) < ceiling)
      .map(([f, ceiling]) => `${f} is down to ${now[f] || 0}: lower its ceiling from ${ceiling}` + (now[f] ? '' : ' by dropping the line'));
    assert.deepEqual(slack, [], `lower the ${name} ceilings in tests/js/hardcoded-strings.test.js`);
  });
}

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

test('counts English literals written to text and labelling properties', () => {
  const src = [
    "btn.textContent = on ? 'Clear' : 'Select all';",
    "el.title = 'Expand map'; el.setAttribute('aria-label', name + ' opacity');",
    "input.placeholder = `Search ${n} places`;",
    "a.textContent = t('x.y'); b.textContent = c.name; d.title === 'Not a write';",
    "st.textContent = '.gl-routes-active path.route-line{opacity:0}';",
    "e.setAttribute('role', 'Some role'); f.textContent = ' / ' + crumb; g.textContent = 'i';",
    "h.innerHTML = '<p>Hi</p>'; if (h.innerHTML == '') {}",
  ].join('\n');
  // Clear, Select all, Expand map, " opacity" and the template's two static
  // parts; not keys, names, comparisons, CSS, other attributes or punctuation.
  assert.equal(countLiterals(src), 6);
  assert.equal(countInnerHtml(src), 1);
});
