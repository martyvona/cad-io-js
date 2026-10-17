// Crude Part 21 indexer + closure + subset writer for the phase 0 spike. Not production code.
import fs from 'node:fs';

// Index a Part 21 file: id -> {start, end, types, refs}. Operates on a latin1 string so offsets == byte offsets.
export function indexP21(buf) {
  const s = typeof buf === 'string' ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1');
  const dataPos = findDataSection(s);
  const ents = new Map();
  const order = [];
  const n = s.length;
  let i = dataPos;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 35 /* # */) {
      // entity start: #digits ws = ...
      const start = i;
      let j = i + 1, id = 0;
      while (j < n) { const d = s.charCodeAt(j); if (d < 48 || d > 57) break; id = id * 10 + (d - 48); j++; }
      while (j < n && isWs(s.charCodeAt(j))) j++;
      if (s.charCodeAt(j) !== 61 /* = */) { i = j; continue; }
      j++;
      while (j < n && isWs(s.charCodeAt(j))) j++;
      const typeDepth = s.charCodeAt(j) === 40 ? 1 : 0; // complex instance: types live at depth 1
      const refs = [];
      const types = [];
      let depth = 0, ident = -1;
      for (; j < n; j++) {
        const d = s.charCodeAt(j);
        if (d === 39 /* ' */) { // string; '' is an escaped quote
          j++;
          for (; j < n; j++) { if (s.charCodeAt(j) === 39) { if (s.charCodeAt(j + 1) === 39) j++; else break; } }
          continue;
        }
        if (d === 47 && s.charCodeAt(j + 1) === 42) { j = s.indexOf('*/', j + 2) + 1; continue; }
        if (d === 35) {
          let k = j + 1, r = 0;
          while (k < n) { const e = s.charCodeAt(k); if (e < 48 || e > 57) break; r = r * 10 + (e - 48); k++; }
          if (k > j + 1) refs.push(r);
          j = k - 1;
          continue;
        }
        if (isIdent(d)) { if (ident < 0) ident = j; continue; }
        if (d === 40 /* ( */) {
          if (ident >= 0 && depth === typeDepth) types.push(s.slice(ident, j).trim());
          depth++;
        } else if (d === 41) depth--;
        else if (d === 59 /* ; */ && depth === 0) break;
        ident = -1;
      }
      ents.set(id, { id, start, end: j + 1, types, refs });
      order.push(id);
      i = j + 1;
      continue;
    }
    if (c === 69 && s.startsWith('ENDSEC;', i)) {
      // allow multiple DATA sections (edition 3)
      const nd = s.indexOf('DATA', i);
      if (nd < 0) break;
      i = nd;
      continue;
    }
    if (c === 47 && s.charCodeAt(i + 1) === 42) { i = s.indexOf('*/', i + 2) + 2; continue; }
    i++;
  }
  return { s, header: s.slice(0, dataPos), ents, order };
}

function findDataSection(s) {
  // first DATA; outside the header (header strings practically never contain "DATA;" on its own line)
  const m = /\n\s*DATA\s*(\([^;]*\))?\s*;/.exec(s);
  if (!m) throw new Error('no DATA section');
  return m.index + m[0].length;
}
const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9;
const isIdent = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45 || c === 33;

export function closure(idx, roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    const e = idx.ents.get(id);
    if (!e) continue; // dangling ref
    seen.add(id);
    for (const r of e.refs) if (!seen.has(r)) stack.push(r);
  }
  return seen;
}

// Emit a Part 21 file: original header, the given ids (original order, original bytes), plus extra entity text lines.
export function emitSubset(idx, ids, extra = []) {
  const parts = [idx.header, '\n'];
  for (const id of idx.order) if (ids.has(id)) { const e = idx.ents.get(id); parts.push(idx.s.slice(e.start, e.end), '\n'); }
  for (const x of extra) parts.push(x, '\n');
  parts.push('ENDSEC;\nEND-ISO-10303-21;\n');
  return Buffer.from(parts.join(''), 'latin1');
}

export const typeOf = (e) => (e.types.length === 1 ? e.types[0] : '(' + e.types.join(' ') + ')');
export const hasType = (e, t) => e.types.includes(t);

export function byType(idx, t) {
  const out = [];
  for (const id of idx.order) { const e = idx.ents.get(id); if (hasType(e, t)) out.push(e); }
  return out;
}

// Raw attribute text of a simple entity (for quick parsing of a few things), e.g. "'name',(#1,#2),#3"
export function attrText(idx, e) {
  const t = idx.s.slice(e.start, e.end);
  const p = t.indexOf('(');
  return t.slice(p + 1, t.lastIndexOf(')'));
}

export function load(path) { return indexP21(fs.readFileSync(path)); }
