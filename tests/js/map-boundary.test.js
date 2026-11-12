'use strict';
// The map sits behind one boundary: app/map/index.js, and app/map/load.js,
// which loads it after sign-in. Modules under app/map/ may call Leaflet and
// hold its objects; every other module reaches the map through those two
// alone and never touches Leaflet or the layers it keeps.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', '..', 'app');
const outside = fs.readdirSync(APP, { recursive: true })
  .filter(f => f.endsWith('.js') && !f.startsWith('map' + path.sep))
  .map(f => ({ file: f, src: fs.readFileSync(path.join(APP, f), 'utf8') }));

// Comments may name Leaflet; code may not.
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The Leaflet objects home-map.js and its layers keep on state.
const MAP_STATE = /\bstate\.(currentMap|tilePicker\w*|_place(Records|ClusterGroup)|_area(Group|Layers|Renderer)|_country(Group|Renderer)|_route(Layers|Renderer|Group\w*)|_syncRoutesOnMap|_glRoutesDirty)\b/;

test('the boundary covers some modules on each side', () => {
  assert.ok(outside.length > 10);
  assert.ok(fs.existsSync(path.join(APP, 'map', 'index.js')));
});

test('no module outside app/map/ calls Leaflet', () => {
  for (const { file, src } of outside) {
    assert.doesNotMatch(code(src), /\bL\.[A-Za-z]|\bwindow\.L\b/, file);
  }
});

test('no module outside app/map/ reaches the map layers kept on state', () => {
  for (const { file, src } of outside) {
    assert.doesNotMatch(code(src), MAP_STATE, file);
  }
});

test('modules outside app/map/ import the map through index.js or load.js only', () => {
  for (const { file, src } of outside) {
    for (const [, spec] of src.matchAll(/^import [^;]*? from '([^']+)';$/gm)) {
      const target = path.relative(APP, path.join(APP, path.dirname(file), spec));
      if (target.startsWith('map' + path.sep)) {
        assert.ok([path.join('map', 'index.js'), path.join('map', 'load.js')].includes(target), file + ' imports ' + spec);
      }
    }
  }
});
