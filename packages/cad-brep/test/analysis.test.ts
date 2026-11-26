import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analysisHeaderText } from '../gen/header.ts';
import { analysisRustText } from '../gen/rust.ts';
import {
  ANALYSIS_COLUMNS, ANALYSIS_MAGIC, ANALYSIS_TABLES, analysisFor, analysisRowCount, type AnalysisRows,
  type AnalysisTableName, type BrepAnalysis, type BrepData, BrepFormatError, COLUMNS, CONTINUITY, FACING,
  FACING_FROM, LOGICAL, MEASURE_TRUST, modelHash, openAnalysis, openBrep, PER_ENTITY, PROVENANCE, rowCount,
  SINGULARITY, writeAnalysis,
} from '../src/index.ts';
import { sha256Words, sha256WordsJs } from '../src/sha256.ts';
import { MODELS } from './models.ts';

const here = new URL('.', import.meta.url).pathname;
const BYTES = { u8: 1, i32: 4, u32: 4, f64: 8 } as const;
/** The per-entity tables, as analysis-layout.ts lists them (written out, not PER_ENTITY, so a table missing from it
 * is caught). */
const ENTITIES = ['vertex', 'edge', 'coedge', 'face', 'surface', 'shell'] as const;

/** A deterministic generator of values every column type can hold, edge cases included. */
function values(seed: number) {
  let s = seed >>> 0;
  const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
  const special = { u8: [0, 255, 1], i32: [-1, -(2 ** 31), 2 ** 31 - 1, 0], u32: [0, 2 ** 32 - 1, 2 ** 31],
    f64: [NaN, -0, Infinity, -Infinity, 5e-324, -1.7976931348623157e308, 0.1] } as const;
  return (type: keyof typeof BYTES, k: number): number => {
    const r = next();
    if (k < special[type].length) return special[type][k]!;
    return type === 'u8' ? r & 255 : type === 'i32' ? r | 0 : type === 'u32' ? r : (r - 2 ** 31) / 977;
  };
}

/** An analysis of `model` with every table full (per-entity tables of the model's rows; `extra` rows for others). */
function sampleRows(d: BrepData, hash: Uint32Array, seed = 1, extra = 5): AnalysisRows {
  const gen = values(seed);
  const rows: Record<string, Record<string, number[]>> = {};
  for (const c of ANALYSIS_COLUMNS) {
    const n = c.table === 'analysis' ? 1 : (ENTITIES as readonly string[]).includes(c.table)
      ? rowCount(d, c.table as typeof ENTITIES[number]) : c.table === 'pool' ? extra + c.column.length
      : c.table === 'trace' ? Math.min(extra, rowCount(d, 'coedge')) : extra;
    (rows[c.table] ??= {})[c.column] = Array.from({ length: n * c.width }, (_, k) => gen(c.type, k));
  }
  rows.analysis!.model = Array.from(hash);
  // The trace rows' coedges: the model's, in order (analysisFor refuses others).
  rows.trace!.coedge = rows.trace!.coedge!.map((_, i) => 2 * i);
  if (rows.trace!.coedge.at(-1)! >= rowCount(d, 'coedge')) rows.trace!.coedge = rows.trace!.coedge.map((_, i) => i);
  return rows as AnalysisRows;
}

const sameValues = (a: ArrayLike<number>, b: ArrayLike<number>, what: string) => {
  assert.equal(a.length, b.length, what);
  for (let i = 0; i < a.length; i++) assert.ok(Object.is(a[i], b[i]), `${what}[${i}]: ${a[i]} vs ${b[i]}`);
};

test('include/cad_analysis.h is what gen/header.ts writes, include/cad_analysis.rs what gen/rust.ts writes', () => {
  assert.equal(readFileSync(join(here, '../include/cad_analysis.h'), 'utf8'), analysisHeaderText(),
    'stale: run node packages/cad-brep/gen/header.ts');
  assert.equal(readFileSync(join(here, '../include/cad_analysis.rs'), 'utf8'), analysisRustText(),
    'stale: run node packages/cad-brep/gen/rust.ts');
});

test('the generated headers name every column and enum value of analysis-layout.ts, in order', () => {
  const h = analysisHeaderText(), rs = analysisRustText();
  const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  const names = ANALYSIS_COLUMNS.map((c) => `CBA_${snake(c.table)}_${snake(c.column)}`.toUpperCase());
  const enumBody = h.slice(h.indexOf('enum cba_column {'), h.indexOf('CBA_COLUMN_COUNT\n'));
  const C_TYPES = { u8: 'uint8_t', i32: 'int32_t', u32: 'uint32_t', f64: 'double' };
  assert.deepEqual([...enumBody.matchAll(/^ {2}(CBA_\w+), \/\* (\w+) x (\d+) \*\//gm)].map((m) => m.slice(1)),
    ANALYSIS_COLUMNS.map((c, k) => [names[k], C_TYPES[c.type], String(c.width)]));
  assert.match(h, new RegExp(`#define CBA_MAGIC "${ANALYSIS_MAGIC}"`));
  assert.match(rs, new RegExp(`pub const MAGIC: &\\[u8; 4\\] = b"${ANALYSIS_MAGIC}";`));
  assert.match(rs, new RegExp(`pub const COLUMN_COUNT: usize = ${ANALYSIS_COLUMNS.length};`));
  const header = 8 + 8 * ANALYSIS_COLUMNS.length;
  assert.match(h, new RegExp(`#define CBA_HEADER_BYTES ${header}\n`));
  assert.match(rs, new RegExp(`pub const HEADER_BYTES: usize = ${header};`));
  const letters = ANALYSIS_COLUMNS.map((c) => ({ u8: 'b', i32: 'i', u32: 'u', f64: 'f' })[c.type]).join('');
  assert.match(rs, new RegExp(`const TYPES: &\\[u8; COLUMN_COUNT\\] = b"${letters}";`));
  // Each accessor returns its column's type, at its index.
  ANALYSIS_COLUMNS.forEach((c, k) => assert.ok(rs.includes(`pub fn ${snake(c.table).toLowerCase()}_`
    + `${snake(c.column).toLowerCase()}(&self) -> &[${c.type}] { self.slice(${k}) }`), `${c.table}.${c.column}`));
  const bytes = h.slice(h.indexOf('bytes[CBA_COLUMN_COUNT] = {'), h.indexOf('};', h.indexOf('bytes[CBA_COLUMN')));
  assert.deepEqual(bytes.match(/\d+(?=,)/g)!.map(Number), ANALYSIS_COLUMNS.map((c) => BYTES[c.type]));
  for (const [name, table] of [['PROVENANCE', PROVENANCE], ['TRUST', MEASURE_TRUST], ['CONTINUITY', CONTINUITY],
    ['SINGULARITY', SINGULARITY], ['FACING', FACING], ['FACING_FROM', FACING_FROM], ['LOGICAL', LOGICAL]] as const) {
    for (const [k, v] of Object.entries(table)) {
      assert.ok(h.includes(`  CBA_${name}_${snake(k).toUpperCase()} = ${v},\n`), `${name} ${k}`);
    }
  }
});

test('writeAnalysis and openAnalysis: every column type round trips, the bytes deterministic and laid out',
  async () => {
  for (const [name, make] of Object.entries(MODELS)) {
    const d = make().finish(), rows = sampleRows(d, await modelHash(d));
    const a = writeAnalysis(rows);
    for (const c of ANALYSIS_COLUMNS) {
      const given = (rows as Record<string, Record<string, ArrayLike<number>>>)[c.table]![c.column]!;
      sameValues((a as unknown as Record<string, Record<string, ArrayLike<number>>>)[c.table]![c.column]!, given,
        `${name} ${c.table}.${c.column}`);
    }
    // The same values, from typed arrays, give the same bytes; reopening the bytes gives the same views.
    const typed = Object.fromEntries(Object.entries(rows).map(([t, cols]) => [t, Object.fromEntries(
      Object.entries(cols!).map(([col, xs]) => {
        const c = ANALYSIS_COLUMNS.find((s) => s.table === t && s.column === col)!;
        const Ctor = { u8: Uint8Array, i32: Int32Array, u32: Uint32Array, f64: Float64Array }[c.type];
        return [col, Ctor.from(xs as ArrayLike<number>)];
      }))]));
    const again = writeAnalysis(typed as AnalysisRows);
    assert.deepEqual(new Uint8Array(again.buffer), new Uint8Array(a.buffer), `${name}: deterministic`);
    assert.deepEqual(new Uint8Array(openAnalysis(new Uint8Array(a.buffer)).buffer), new Uint8Array(a.buffer));
    // The layout, worked out independently: the magic, the count, then columns in order from the header's end, each
    // starting at the next multiple of 8, zeros between, the buffer ending on one.
    const v = new DataView(a.buffer), bytes = new Uint8Array(a.buffer);
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'CBA8');
    assert.equal(v.getUint32(4, true), ANALYSIS_COLUMNS.length);
    let at = 8 + 8 * ANALYSIS_COLUMNS.length;
    ANALYSIS_COLUMNS.forEach((c, k) => {
      const given = (rows as Record<string, Record<string, ArrayLike<number>>>)[c.table]![c.column]!;
      assert.equal(v.getUint32(8 + 8 * k, true), at, `${name} ${c.table}.${c.column} offset`);
      assert.equal(v.getUint32(12 + 8 * k, true), given.length, `${name} ${c.table}.${c.column} count`);
      const end = at + given.length * BYTES[c.type];
      at = Math.ceil(end / 8) * 8;
      assert.ok(bytes.subarray(end, at).every((b) => b === 0), `${name} ${c.table}.${c.column} padding`);
    });
    assert.equal(a.buffer.byteLength, at, name);
  }
});

test('writeAnalysis: a table left out is empty; values a column can\'t hold, missing columns and bad rows refused',
  async () => {
    const d = MODELS.cube().finish(), hash = await modelHash(d);
    const minimal = writeAnalysis({ analysis: { model: hash, uncertainty: [NaN], measureRelTol: [NaN],
      measureProject: [0] } });
    for (const t of Object.keys(ANALYSIS_TABLES) as AnalysisTableName[]) {
      assert.equal(analysisRowCount(minimal, t), t === 'analysis' ? 1 : 0, t);
    }
    assert.equal(minimal.analysis.uncertainty[0], NaN);
    // A pool's rows are its first array's (here 4 reals and 3 ints).
    const full = writeAnalysis(sampleRows(d, hash));
    assert.equal(analysisRowCount(full, 'pool'), full.pool.real.length);
    assert.notEqual(full.pool.real.length, full.pool.int.length);
    const rows = sampleRows(d, hash);
    const spoil = (f: (r: Record<string, Record<string, number[]>>) => void) => {
      const r = structuredClone(rows) as Record<string, Record<string, number[]>>;
      f(r);
      return () => writeAnalysis(r as AnalysisRows);
    };
    for (const [what, f] of [['u8 256', (r) => { r.edge!.rangeFrom![0] = 256; }],
      ['u8 -1', (r) => { r.edge!.rangeFrom![0] = -1; }], ['u8 0.5', (r) => { r.face!.outerFrom![1] = 0.5; }],
      ['i32 2^31', (r) => { r.coedge!.face![0] = 2 ** 31; }],
      ['i32 below', (r) => { r.pool!.int![0] = -(2 ** 31) - 1; }],
      ['i32 NaN', (r) => { r.vertex!.first![0] = NaN; }], ['u32 -1', (r) => { r.analysis!.model![3] = -1; }],
      ['u32 2^32', (r) => { r.analysis!.model![7] = 2 ** 32; }],
      ['f64 not a number', (r) => { (r.shell!.volume as unknown[])[0] = '1'; }]] as const satisfies
      readonly (readonly [string, (r: Record<string, Record<string, number[]>>) => void])[]) {
      assert.throws(spoil(f), RangeError, what);
    }
    // A typed array of another type is checked as a plain one.
    assert.throws(() => writeAnalysis({ analysis: { model: Int32Array.of(-1, 0, 0, 0, 0, 0, 0, 0),
      uncertainty: [1], measureRelTol: [NaN], measureProject: [0] } }), RangeError);
    assert.throws(spoil((r) => { delete r.edge!.measured; }), /edge\.measured not given/);
    assert.throws(spoil((r) => { r.facts = { x: [1] }; }), /facts: not an analysis table/);
    assert.throws(spoil((r) => { r.edge!.measured!.push(1); }), BrepFormatError);
    assert.throws(spoil((r) => { r.face!.uv!.pop(); }), BrepFormatError);
    assert.throws(spoil((r) => {
      const a = r.analysis!;
      a.uncertainty!.push(1), a.measureRelTol!.push(1), a.measureProject!.push(0), a.model!.push(...a.model!);
    }), /not one analysis row/);
    assert.throws(() => writeAnalysis({}), /not one analysis row/);
    // The pools' arrays are independent.
    assert.doesNotThrow(spoil((r) => { r.pool!.real!.push(1, 2, 3); }));
  });

test('openAnalysis refuses a buffer whose header is corrupt, and a model buffer; openBrep refuses an analysis',
  async () => {
    const d = MODELS.everyKind().finish(), a = writeAnalysis(sampleRows(d, await modelHash(d)));
    assert.throws(() => openAnalysis(d.buffer), /magic "CBR6", not CBA8/);
    assert.throws(() => openBrep(a.buffer), /magic "CBA8", not CBR6/);
    assert.throws(() => openAnalysis(new ArrayBuffer(8 + 8 * ANALYSIS_COLUMNS.length - 1)), /too short/);
    const col = (table: string, column: string) =>
      ANALYSIS_COLUMNS.findIndex((c) => c.table === table && c.column === column);
    const range = col('edge', 'range'), model = col('analysis', 'model'), face = col('coedge', 'face');
    const cases: [string, (v: DataView) => void, RegExp][] = [
      ['column count', (v) => v.setUint32(4, ANALYSIS_COLUMNS.length + 1, true),
        new RegExp(`columns, not ${ANALYSIS_COLUMNS.length}`)],
      ['an offset inside the header', (v) => v.setUint32(8 + 8 * range, 8, true), /don't fit/],
      ['an aligned offset 8 bytes inside the header',
        (v) => v.setUint32(8 + 8 * range, 8 * ANALYSIS_COLUMNS.length, true), /don't fit/],
      ['an offset not 8-byte aligned', (v) => v.setUint32(8 + 8 * range, v.getUint32(8 + 8 * range, true) + 4, true),
        /don't fit/],
      ['a column past the end', (v) => v.setUint32(12 + 8 * range, (v.byteLength
        - v.getUint32(8 + 8 * range, true)) / 8 + 2 & ~1, true), /don't fit/],
      ['part of a row', (v) => v.setUint32(12 + 8 * range, v.getUint32(12 + 8 * range, true) - 1, true),
        /not rows of 2/],
      ['a column of another row count', (v) => v.setUint32(12 + 8 * face, v.getUint32(12 + 8 * face, true) - 1, true),
        /coedge: columns of/],
      ['no analysis row', (v) => {
        for (let k = model; k < model + ANALYSIS_TABLES.analysis.length; k++) v.setUint32(12 + 8 * k, 0, true);
      }, /not one analysis row/],
    ];
    for (const [what, spoil, message] of cases) {
      const bad = a.buffer.slice(0);
      spoil(new DataView(bad));
      assert.throws(() => openAnalysis(bad), (e) => e instanceof BrepFormatError && message.test(e.message), what);
    }
    // The last column ending exactly at the buffer's end fits; a view at an offset is copied.
    const last = ANALYSIS_COLUMNS.length - 1, v = new DataView(a.buffer);
    assert.ok(v.getUint32(8 + 8 * last, true) + v.getUint32(12 + 8 * last, true) <= a.buffer.byteLength);
    const padded = new Uint8Array(a.buffer.byteLength + 8);
    padded.set(new Uint8Array(a.buffer), 8);
    assert.deepEqual(new Uint8Array(openAnalysis(padded.subarray(8)).buffer), new Uint8Array(a.buffer));
  });

test('analysisFor: an analysis of exactly this model accepted, of any other refused', async () => {
  assert.deepEqual(PER_ENTITY, ENTITIES);
  for (const [name, make] of Object.entries(MODELS)) {
    const d = make().finish(), hash = await modelHash(d);
    assert.equal(Array.from(hash, (w) => w.toString(16).padStart(8, '0')).join(''),
      createHash('sha256').update(new Uint8Array(d.buffer)).digest('hex'), `${name}: the hash, big-endian words`);
    const a = writeAnalysis(sampleRows(d, hash));
    assert.equal(await analysisFor(d, a), a, name);
    assert.deepEqual(new Uint8Array((await analysisFor(d, a.buffer)).buffer), new Uint8Array(a.buffer));
    assert.deepEqual(new Uint8Array((await analysisFor(d, new Uint8Array(a.buffer))).buffer),
      new Uint8Array(a.buffer));
    // Every per-entity table empty, the others (continuity, the pools) any length: accepted.
    const rows = sampleRows(d, hash, 2, 11) as Record<string, unknown>;
    for (const t of ENTITIES) delete rows[t];
    await analysisFor(d, writeAnalysis(rows as AnalysisRows));
    // Trace rows naming a coedge the model hasn't, or out of order, or twice.
    if (rowCount(d, 'coedge') >= 2) {
      for (const coedges of [[0, rowCount(d, 'coedge')], [-1, 0], [1, 0], [1, 1]]) {
        const r = sampleRows(d, hash) as Record<string, Record<string, number[]>>;
        for (const c of ANALYSIS_COLUMNS.filter((s) => s.table === 'trace')) r.trace![c.column] = r.trace![c.column]!
          .slice(0, 2 * c.width);
        r.trace!.coedge = coedges;
        await assert.rejects(analysisFor(d, writeAnalysis(r as AnalysisRows)),
          (e) => e instanceof BrepFormatError && /analysis trace row/.test(e.message), `${name} ${coedges}`);
      }
    }
    // A hash off by one bit, anywhere.
    for (const bit of [0, 31, 32 * 3 + 7, 255]) {
      const off = hash.slice();
      off[bit >> 5] = off[bit >> 5]! ^ 1 << (31 - (bit & 31));
      await assert.rejects(analysisFor(d, writeAnalysis(sampleRows(d, off))),
        (e) => e instanceof BrepFormatError && /another model/.test(e.message), `${name} bit ${bit}`);
    }
    // A table of a row count other than the model's: each table, one row more and one fewer.
    for (const t of ENTITIES) {
      for (const delta of [1, -1]) {
        const n = rowCount(d, t) + delta;
        if (n < 0) continue;
        const r = sampleRows(d, hash) as Record<string, Record<string, number[]>>;
        for (const c of ANALYSIS_COLUMNS.filter((s) => s.table === t)) {
          r[t]![c.column] = Array.from({ length: n * c.width }, () => 0);
        }
        const a = writeAnalysis(r as AnalysisRows);
        // (A table of no rows is empty, so accepted: one row fewer than a model's one.)
        if (n === 0) await analysisFor(d, a);
        else {
          await assert.rejects(analysisFor(d, a), (e) => e instanceof BrepFormatError
            && new RegExp(`analysis ${t}: ${n} rows, the model's ${n - delta}`).test(e.message), `${name} ${t} ${n}`);
        }
      }
    }
    // The model edited after analysis (one byte of one value): refused.
    const edited = openBrep(d.buffer.slice(0));
    edited.vertex.point[0] = edited.vertex.point[0]! + 1;
    await assert.rejects(analysisFor(edited, a), /another model/, name);
  }
});

test('sha256WordsJs and sha256Words: FIPS 180-4\'s examples, node:crypto at every length about the padding, and '
  + 'without Web Crypto', async () => {
  const ascii = (s: string) => new TextEncoder().encode(s);
  const hex = (w: Uint32Array) => Array.from(w, (x) => x.toString(16).padStart(8, '0')).join('');
  const vectors: [Uint8Array, string][] = [
    [ascii('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [ascii(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    [ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    [ascii('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrst'
      + 'nopqrstu'), 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
    [new Uint8Array(1e6).fill(0x61), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ];
  for (const [bytes, digest] of vectors) {
    assert.equal(hex(sha256WordsJs(bytes)), digest);
    assert.equal(hex(await sha256Words(bytes)), digest);
  }
  const data = randomBytes(3 * 64 + 10);
  for (let n = 0; n <= data.length; n++) {
    assert.equal(hex(sha256WordsJs(data.subarray(0, n))), createHash('sha256').update(data.subarray(0, n))
      .digest('hex'), `length ${n}`);
  }
  // A view at an offset hashes its own bytes only.
  const view = data.subarray(5, 140);
  assert.equal(hex(sha256WordsJs(view)), createHash('sha256').update(view).digest('hex'));
  // (node:test's mock.property hangs on Node's getter for globalThis.crypto, so the property is replaced by hand.)
  const own = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(hex(await sha256Words(vectors[0]![0])), vectors[0]![1]);
    const d = MODELS.cube().finish();
    await analysisFor(d, writeAnalysis(sampleRows(d, await modelHash(d))));
  } finally {
    Object.defineProperty(globalThis, 'crypto', own);
  }
});

/** Per column: its count, the sum of its finite values and how many aren't finite, as the readers print them. */
function expectedSums(a: BrepAnalysis): [string, string, number, string][] {
  return ANALYSIS_COLUMNS.map((c, k) => {
    const xs = (a as unknown as Record<string, Record<string, ArrayLike<number>>>)[c.table]![c.column]!;
    let sum = 0, bad = 0;
    for (let j = 0; j < xs.length; j++) {
      if (Number.isFinite(xs[j]!)) sum += xs[j]!;
      else bad++;
    }
    return [String(k), String(xs.length), sum, String(bad)];
  });
}

/** Analyses for the readers: every model's, full and with only the required table, as files in `dir`. */
async function samples(dir: string): Promise<[string, BrepAnalysis, string][]> {
  const out: [string, BrepAnalysis, string][] = [];
  for (const [name, make] of Object.entries(MODELS)) {
    const d = make().finish(), hash = await modelHash(d);
    for (const [kind, a] of [['full', writeAnalysis(sampleRows(d, hash))],
      ['minimal', writeAnalysis({ analysis: { model: hash, uncertainty: [0.001], measureRelTol: [NaN],
        measureProject: [0] } })]] as const) {
      const file = join(dir, `${name}-${kind}.cba`);
      writeFileSync(file, new Uint8Array(a.buffer));
      out.push([`${name} ${kind}`, a, file]);
    }
  }
  return out;
}

/**
 * Corrupt copies of an analysis's header: another format's magic, an offset inside the header, one aligned but 8
 * bytes inside it, one not 8-byte aligned, a column of doubles one value too long (it would fit as 4-byte values),
 * the column count.
 */
function corrupt(a: BrepAnalysis): Uint8Array[] {
  const range = ANALYSIS_COLUMNS.findIndex((c) => c.table === 'edge' && c.column === 'range');
  const measured = ANALYSIS_COLUMNS.findIndex((c) => c.table === 'vertex' && c.column === 'measured');
  const room = (v: DataView) => (v.byteLength - v.getUint32(8 + 8 * measured, true)) / 8;
  return [(v: DataView) => v.setUint8(2, 0x52), (v: DataView) => v.setUint32(8, 4, true),
    (v: DataView) => v.setUint32(8, 8 * ANALYSIS_COLUMNS.length, true),
    (v: DataView) => v.setUint32(8 + 8 * range, v.getUint32(8 + 8 * range, true) + 4, true),
    (v: DataView) => v.setUint32(12 + 8 * measured, Math.floor(room(v)) + 1, true),
    (v: DataView) => v.setUint32(4, 36, true)].map((spoil) => {
    const bad = new Uint8Array(a.buffer.slice(0));
    spoil(new DataView(bad.buffer));
    return bad;
  });
}

const kinds = [PROVENANCE.healed, MEASURE_TRUST.exact, CONTINUITY.g2, SINGULARITY.normalVanishes, FACING.in,
  FACING_FROM.both, LOGICAL.unknown, COLUMNS.length].map(String);
const words = (a: BrepAnalysis) => Array.from(a.analysis.model, (w) => w.toString(16).padStart(8, '0'));

const rustc = spawnSync('rustc', ['--version']).status === 0;

test('a Rust reader sees through cad_analysis.rs what the views see', { skip: !rustc && 'no rustc' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cad-analysis-rs-'));
  try {
    const exe = join(dir, 'reader-rs');
    execFileSync('rustc', ['--edition', '2021', '-D', 'warnings', '-O', join(here, 'reader_analysis.rs'), '-o', exe]);
    for (const [name, a, file] of await samples(dir)) {
      const lines = execFileSync(exe, [file]).toString().trim().split('\n').map((line) => line.split(' '));
      assert.deepEqual(lines.slice(0, -3).map(([k, n, sum, bad]) => [k, n, Number(sum), bad]), expectedSums(a), name);
      assert.deepEqual(lines.at(-3), ['model', ...words(a)], name);
      assert.deepEqual(lines.at(-2), ['coedge.face', Array.from(a.coedge.face).join(',')], name);
      assert.deepEqual(lines.at(-1), ['kinds', ...kinds]);
      for (const bad of corrupt(a)) {
        writeFileSync(file, bad);
        assert.equal(spawnSync(exe, [file]).status, 2, `${name}: refused`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const compilers = [['cc', '-std=c99', '-x', 'c'], ['c++', '-std=c++17', '-x', 'c++']].filter(([cc]) =>
  spawnSync(cc!, ['--version']).status === 0);

test('a C and a C++ reader see through cad_analysis.h what the views see', { skip: !compilers.length && 'no compiler' },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cad-analysis-'));
    try {
      const types = ANALYSIS_COLUMNS.map((c) => ({ u8: 'b', i32: 'i', u32: 'u', f64: 'f' })[c.type]).join('');
      const env = { ...process.env, CBA_TYPES: types };
      const all = await samples(dir);
      for (const [cc, std, x, lang] of compilers) {
        const exe = join(dir, `reader-${lang}`);
        execFileSync(cc!, [std!, '-Wall', '-Wextra', '-Werror', '-pedantic', x!, lang!, join(here, 'reader_analysis.c'),
          '-o', exe]);
        for (const [name, a, file] of all) {
          writeFileSync(file, new Uint8Array(a.buffer));
          const read = execFileSync(exe, [file], { env }).toString().trim().split('\n').map((line) => line.split(' '));
          assert.deepEqual(read.slice(0, -2).map(([k, n, sum, bad]) => [k, n, Number(sum), bad]), expectedSums(a),
            `${lang} ${name}`);
          assert.deepEqual(read.at(-2), ['model', ...words(a)], `${lang} ${name}`);
          assert.deepEqual(read.at(-1), ['kinds', ...kinds]);
          for (const bad of corrupt(a)) {
            writeFileSync(file, bad);
            assert.equal(spawnSync(exe, [file], { env }).status, 2, `${lang} ${name}: refused`);
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
