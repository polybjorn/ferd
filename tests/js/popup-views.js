'use strict';
// Renders the map's popup views (the POPUP-VIEWS block in app/map/popups.js)
// to HTML for tests that read the markup. The views run on the vendored
// Preact and htm; state holds its first value and effects do not run, which
// is the popup as it first opens.
const path = require('node:path');
const vm = require('node:vm');

const app = require('./app-source');
const VENDOR = path.join(__dirname, '..', '..', 'vendor');
const VOID = new Set(['img', 'path', 'input', 'br']);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function styleText(v) {
  if (typeof v === 'string') return v;
  return Object.entries(v)
    .map(([k, x]) => (k.startsWith('-') ? k : k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())) + ':' + x)
    .join(';');
}

// Globals the block reads (state, getShowField and the like) come in
// `globals`; `prelude` is more app source to run first in the same context.
async function loadPopupViews(globals, prelude = '') {
  const [{ h, Fragment }, { default: htm }, { t }] = await Promise.all([
    import(path.join(VENDOR, 'preact', 'preact.js')),
    import(path.join(VENDOR, 'htm', 'htm.js')),
    import(path.join(__dirname, '..', '..', 'app', 'i18n.js')),
  ]);
  const m = /POPUP-VIEWS-BEGIN[^\n]*\n([\s\S]*?)\n\/\/ POPUP-VIEWS-END/.exec(app);
  if (!m) throw new Error('POPUP-VIEWS markers not found in app/');
  const ctx = Object.assign({
    html: htm.bind(h),
    t,
    useState: init => [init, () => {}],
    useEffect: () => {},
  }, globals);
  vm.createContext(ctx);
  vm.runInContext(`${prelude}\n${m[1]}\nglobalThis.__views = { PlacePopup, RoutePopup, AreaPopup };`, ctx);
  const render = v => {
    if (v == null || typeof v === 'boolean') return '';
    if (Array.isArray(v)) return v.map(render).join('');
    if (typeof v !== 'object') return esc(v);
    if (v.type === Fragment) return render(v.props.children);
    if (typeof v.type === 'function') return render(v.type(v.props));
    let attrs = '';
    for (const [k, x] of Object.entries(v.props)) {
      if (k === 'children' || x == null || x === false || typeof x === 'function') continue;
      attrs += ' ' + k + (x === true ? '' : '="' + esc(k === 'style' ? styleText(x) : x) + '"');
    }
    return VOID.has(v.type) ? `<${v.type}${attrs}>` : `<${v.type}${attrs}>${render(v.props.children)}</${v.type}>`;
  };
  const view = (name, props) => render(h(ctx.__views[name], props));
  return {
    place: place => view('PlacePopup', { place, onEdit() {} }),
    route: (route, region, color) => view('RoutePopup', { route, region, color }),
    area: (area, visited) => view('AreaPopup', {
      area, visited, places: [], routes: new Promise(() => {}), onEdit() {}, close() {}, relayout() {},
    }),
  };
}

module.exports = { loadPopupViews };
