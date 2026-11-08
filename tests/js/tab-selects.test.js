'use strict';
// A Preact dialog with a tab row renders a tab's selects after the dialog
// opened, when openModal's one enhanceSelectsIn pass has already run. Each one
// has to theme its body again on a tab switch, or a select there keeps the
// system picker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '..', 'app');
const files = fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.js')).sort();

// Top-level functions that put a tab row in a Preact template.
function tabbedViews() {
  const found = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /^function (\w+)\([\s\S]*?^\}$/gm;
    let m;
    while ((m = re.exec(src))) {
      if (/html`<div class="ui-tabs"/.test(m[0])) found.push({ file: f, name: m[1], body: m[0] });
    }
  }
  return found;
}

// Sign-in's tabs switch the one form between sign in and register, and the
// form has no select to theme.
const SELECTLESS = new Set(['SignInForm']);

test('the Add, Settings and sign-in dialogs are the tabbed views', () => {
  const names = tabbedViews().map(v => v.name).sort();
  assert.deepEqual(names, ['AddDialog', 'SettingsView', 'SignInForm']);
});

for (const v of tabbedViews()) {
  if (SELECTLESS.has(v.name)) {
    test(`${v.name} has no select to theme`, () => {
      assert.doesNotMatch(v.body, /<select|Select\b/, `${v.file}: ${v.name} gained a select, so it needs the tab effect`);
    });
    continue;
  }
  test(`${v.name} themes its selects on every tab switch`, () => {
    assert.match(v.body, /useEffect\(\(\) => \{ enhanceSelectsIn\((\w+)\.current\); \}, \[tab\]\);/,
      `${v.file}: ${v.name} needs useEffect(() => { enhanceSelectsIn(<ref>.current); }, [tab])`);
    const ref = /enhanceSelectsIn\((\w+)\.current\)/.exec(v.body)[1];
    assert.match(v.body, new RegExp(`ref=\\$\\{${ref}\\}`), `${v.file}: ${v.name} never attaches ${ref}`);
  });
}
