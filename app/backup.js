import { exportLocal, importLocal } from './store.js';
import { areaHasGeometry } from './area-geo.js';

// Export/import a local map as a zip with the same layout the server uses
// (places.json, routes.json, metadata.json, category-labels.json, gpx/...),
// so a local map can be moved to a server (and back) with no conversion.
// Written uncompressed (store); reads handle both store and deflate so a
// server's deflated export imports cleanly.
const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function _crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = _crcTable[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function _concatBytes(arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function _zipStore(files) {
  const enc = new TextEncoder();
  const u16 = n => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xFFFF, true); return b; };
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
  const locals = [], central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = _crc32(data);
    const lh = _concatBytes([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
    locals.push(lh);
    central.push(_concatBytes([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += lh.length;
  }
  const cd = _concatBytes(central);
  const eocd = _concatBytes([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0)]);
  return new Blob([_concatBytes(locals), cd, eocd], { type: 'application/zip' });
}
function _inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  return new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer().then(b => new Uint8Array(b));
}
async function _zipRead(buf) {
  const dv = new DataView(buf), bytes = new Uint8Array(buf);
  let p = buf.byteLength - 22;
  while (p >= 0 && dv.getUint32(p, true) !== 0x06054b50) p--;
  if (p < 0) throw new Error('not a zip file');
  const count = dv.getUint16(p + 10, true);
  let cd = dv.getUint32(p + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(cd, true) !== 0x02014b50) break;
    const method = dv.getUint16(cd + 10, true);
    const compSize = dv.getUint32(cd + 20, true);
    const nameLen = dv.getUint16(cd + 28, true), extraLen = dv.getUint16(cd + 30, true), commentLen = dv.getUint16(cd + 32, true);
    const lho = dv.getUint32(cd + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cd + 46, cd + 46 + nameLen));
    const dataStart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const comp = bytes.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = await _inflateRaw(comp);
    else throw new Error('unsupported zip compression');
    out.push({ name, data });
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
export const localBackup = {
  exportZip() {
    return exportLocal().then(d => {
      const enc = new TextEncoder();
      const j = (/** @type {any} */ o) => enc.encode(JSON.stringify(o, null, 2));
      const files = [
        { name: 'places.json', data: j(d.places) },
        { name: 'areas.json', data: j(d.areas) },
        { name: 'routes.json', data: j(d.routes) },
        { name: 'metadata.json', data: j(d.metadata) },
        { name: 'category-labels.json', data: j(d.labels) },
      ];
      for (const g of d.gpx) files.push({ name: 'gpx/' + g.file, data: enc.encode(g.text) });
      return _zipStore(files);
    });
  },
  /** @param {Blob} file @param {string} mode */
  importZip(file, mode) {
    return file.arrayBuffer().then(_zipRead).then(entries => {
      const dec = new TextDecoder();
      /** @type {Record<string, Uint8Array>} */
      const byName = {};
      for (const e of entries) byName[e.name] = e.data;
      const parse = (/** @type {string} */ n) => { if (!byName[n]) return null; try { return JSON.parse(dec.decode(byName[n])); } catch { return null; } };
      const areas = parse('areas.json');
      const gpx = [];
      for (const name in byName) {
        if (name.startsWith('gpx/') && name.endsWith('.gpx')) gpx.push({ file: name.slice(4), text: dec.decode(byName[name]) });
      }
      return importLocal({
        places: parse('places.json'),
        areas: Array.isArray(areas) ? areas.filter(areaHasGeometry) : null,
        metadata: parse('metadata.json'),
        labels: parse('category-labels.json'),
        gpx,
      }, mode);
    });
  },
};
