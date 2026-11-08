import { state } from './core.js';
import { apiUrl } from './auth.js';

/** A fetch init whose headers are a plain object, so the auth header can be added to it. @typedef {RequestInit & { headers?: Record<string, string> }} AuthInit */

// When the frontend is bundled in a native/WebView shell it has no
// same-origin API, so it stores which Ferd server to talk to. Empty means
// same-origin (the normal web/PWA deploy): every URL stays relative and
// auth keeps using the HttpOnly session cookie. A configured cross-origin
// base switches the client to bearer-token auth (cookies don't cross
// origins), with the token kept in localStorage and cleared on logout or
// server switch.
const SERVER_KEY = 'ferd-server';
const MODE_KEY = 'ferd-mode';
const TOKEN_KEY = 'ferd-token';

// With no server configured the app runs on this device alone: the store
// keeps everything in IndexedDB and the server UI (sign-in, publish,
// sessions, admin, catalog) is hidden. The device's own map and each
// server's maps are kept apart, so switching never touches the other.
export function hasServer() {
  try { return localStorage.getItem(MODE_KEY) !== 'local'; } catch { return true; }
}
/** @param {boolean} on */
export function setServerless(on) {
  try { on ? localStorage.setItem(MODE_KEY, 'local') : localStorage.removeItem(MODE_KEY); } catch {}
}

export function serverBase() {
  try { return (localStorage.getItem(SERVER_KEY) || '').replace(/\/+$/, ''); }
  catch { return ''; }
}
/** @param {string} base empty to use the page's own origin */
export function setServerBase(base) {
  try {
    if (base) localStorage.setItem(SERVER_KEY, base.replace(/\/+$/, ''));
    else localStorage.removeItem(SERVER_KEY);
  } catch {}
}
function bearerToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; }
  catch { return ''; }
}
/** @param {string} tok empty to clear it */
export function setBearerToken(tok) {
  try {
    if (tok) localStorage.setItem(TOKEN_KEY, tok);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
// True when API calls target a different origin than the page (a bundled
// shell on file:// always counts). Drives bearer-vs-cookie auth.
export function isCrossOrigin() {
  const b = serverBase();
  if (!b) return false;
  try { return new URL(b).origin !== location.origin; }
  catch { return false; }
}
// Absolute URL for a static file on the configured server (site-config.json
// lives next to the API root, not under api_base).
/** @param {string} file */
export function serverFileUrl(file) {
  const b = serverBase();
  return b ? b + '/' + file : file;
}

// Apply the request's auth mode to a fetch init. Same-origin keeps the
// HttpOnly cookie; cross-origin omits cookies (they don't cross origins)
// and presents the stored session token as a bearer. Mutates and returns
// the init so call sites can keep their own method/body/headers.
/**
 * @param {AuthInit} [init]
 * @returns {AuthInit}
 */
export function applyAuth(init) {
  init = init || {};
  init.headers = Object.assign({}, init.headers);
  if (isCrossOrigin()) {
    init.credentials = 'omit';
    const t = bearerToken();
    if (t) init.headers['Authorization'] = 'Bearer ' + t;
  } else {
    init.credentials = 'same-origin';
  }
  return init;
}

// viewer mode: 'public' when the URL is /u/<username>/..., else 'owner'
// (read+write against /api/places etc. for the signed-in user).
// VIEWER-BEGIN
// Leading slashes are tolerated: a link built by joining a base ending in
// '/' with '/u/...' reaches the shell as '//u/...', which the server serves.
/** @param {string} pathname */
function viewerOf(pathname) {
  const m = (pathname || '/').match(/^\/+u\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if (m) return { mode: 'public', username: m[1] };
  return { mode: 'owner', username: null };
}
// VIEWER-END

export function detectViewer() {
  return viewerOf(location.pathname);
}

/** @param {'places' | 'areas' | 'routes' | 'metadata'} kind */
export function dataUrl(kind) {
  const v = state.viewer;
  if (v && v.mode === 'public') return apiUrl('/u/' + encodeURIComponent(v.username) + '/' + kind);
  return apiUrl('/' + kind);
}

export function categoryLabelsUrl() {
  const v = state.viewer;
  if (v && v.mode === 'public') return apiUrl('/u/' + encodeURIComponent(v.username) + '/category-labels');
  return apiUrl('/me/category-labels');
}

/** @param {string} file */
export function gpxUrlFor(file) {
  if (!hasServer()) return 'local:' + file;
  const v = state.viewer;
  if (v && v.mode === 'public') return apiUrl('/u/' + encodeURIComponent(v.username) + '/gpx/' + file);
  return apiUrl('/gpx/' + file);
}

// POPUP-EDIT-BEGIN (tests/js/popup-edit.test.js runs this block)
export function isReadOnly() {
  return !!(state.viewer && state.viewer.mode === 'public');
}
// Edit on a map popup: the owner, signed in (local mode signs in as one).
export function canEditPopup() {
  return !isReadOnly() && !!(state.auth && state.auth.authenticated);
}
// POPUP-EDIT-END

/** @type {{ completed: string, planned: string } | null} */
let _routeColorCache = null;
/** @param {boolean} completed */
export function routeStatusColor(completed) {
  // Cache both values per theme; applyTheme() invalidates. Avoids one
  // getComputedStyle (and forced style recalc) per polyline draw.
  if (!_routeColorCache) {
    const cs = getComputedStyle(document.documentElement);
    _routeColorCache = {
      completed: cs.getPropertyValue('--completed').trim() || '#a3be8c',
      planned:   cs.getPropertyValue('--planned').trim()   || '#bf616a',
    };
  }
  return completed ? _routeColorCache.completed : _routeColorCache.planned;
}
export function clearRouteColorCache() { _routeColorCache = null; }

/**
 * The parsed body, or `fallback` on a network error or a non-OK status.
 * @template T
 * @param {string} url
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export function fetchJson(url, fallback) {
  return fetch(url, applyAuth({})).then(r => r.ok ? r.json() : fallback).catch(() => fallback);
}
