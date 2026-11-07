'use strict';
// The frontend's modules as one classic script, so a test can cut a function
// or a marked block out of it and run that in vm, which has no import or export.
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '..', 'app');
module.exports = fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.js')).sort()
  .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
  .join('\n')
  .replace(/^import [\s\S]*?;$/gm, '')
  .replace(/^export /gm, '');
