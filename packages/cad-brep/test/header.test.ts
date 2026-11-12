import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { headerText } from '../gen/header.ts';
import { rustText } from '../gen/rust.ts';
import { COLUMNS, CURVE_KIND, ITEM_KIND, openBrep, SURFACE_KIND, TRIM_PREFERENCES } from '../src/index.ts';
import { MODELS } from './models.ts';

const here = new URL('.', import.meta.url).pathname;

test('include/cad_brep.h is what gen/header.ts writes, include/cad_brep.rs what gen/rust.ts writes', () => {
  assert.equal(readFileSync(join(here, '../include/cad_brep.h'), 'utf8'), headerText(),
    'stale: run node packages/cad-brep/gen/header.ts');
  assert.equal(readFileSync(join(here, '../include/cad_brep.rs'), 'utf8'), rustText(),
    'stale: run node packages/cad-brep/gen/rust.ts');
});

const rustc = spawnSync('rustc', ['--version']).status === 0;

test('a Rust reader sees through cad_brep.rs what the views see', { skip: !rustc && 'no rustc' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cad-brep-rs-'));
  try {
    const exe = join(dir, 'reader-rs');
    execFileSync('rustc', ['--edition', '2021', '-D', 'warnings', '-O', join(here, 'reader.rs'), '-o', exe]);
    // (A cube with ids above 2^31 too: an id column read as i32 would show them negative.)
    const big = () => {
      const d = openBrep(MODELS.cube().finish().buffer.slice(0));
      d.face.id[0] = 2 ** 32 - 1;
      d.vertex.id[1] = 2 ** 31;
      return { finish: () => d };
    };
    for (const [name, make] of [...Object.entries(MODELS), ['bigIds', big] as const]) {
      const d = make().finish(), file = join(dir, `${name}.cbr`);
      writeFileSync(file, new Uint8Array(d.buffer));
      const lines = execFileSync(exe, [file]).toString().trim().split('\n').map((line) => line.split(' '));
      const expected = COLUMNS.map((c, k) => {
        const xs = (d[c.table] as Record<string, ArrayLike<number>>)[c.column]!;
        let sum = 0, bad = 0;
        for (let j = 0; j < xs.length; j++) {
          if (Number.isFinite(xs[j]!)) sum += xs[j]!;
          else bad++;
        }
        return [String(k), String(xs.length), sum, String(bad)];
      });
      assert.deepEqual(lines.slice(0, -3).map(([k, n, sum, bad]) => [k, n, Number(sum), bad]), expected, name);
      assert.deepEqual(lines.at(-3), ['edge.curve', Array.from(d.edge.curve).join(',')], name);
      assert.deepEqual(lines.at(-2), ['face.id', Array.from(d.face.id).join(',')], name);
      assert.deepEqual(lines.at(-1), ['kinds', ...[CURVE_KIND.offset, SURFACE_KIND.fixedReferenceSwept,
        ITEM_KIND.instance, TRIM_PREFERENCES.indexOf('cartesian')].map(String)]);
      // A corrupt header, or another format's magic, is refused: an offset inside the header, one not 8-byte
      // aligned, a column of doubles one value too long (it would fit as 4-byte values).
      const point = COLUMNS.findIndex((c) => c.table === 'vertex' && c.column === 'point');
      const room = (v: DataView) => (v.byteLength - v.getUint32(8 + 8 * point, true)) / 8;
      for (const spoil of [(v: DataView) => v.setUint32(8, 4, true), (v: DataView) => v.setUint8(3, 0x32),
        (v: DataView) => v.setUint32(8 + 8 * point, v.getUint32(8 + 8 * point, true) + 4, true),
        (v: DataView) => v.setUint32(12 + 8 * point, Math.floor(room(v)) + 1, true)]) {
        const bad = new Uint8Array(d.buffer.slice(0));
        spoil(new DataView(bad.buffer));
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

test('a C and a C++ reader see through the header what the views see', { skip: !compilers.length && 'no compiler' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'cad-brep-'));
    try {
      const types = COLUMNS.map((c) => ({ u8: 'b', i32: 'i', u32: 'u', f64: 'f' })[c.type]).join('');
      for (const [cc, std, x, lang] of compilers) {
        const exe = join(dir, `reader-${lang}`);
        execFileSync(cc!, [std!, '-Wall', '-Wextra', '-Werror', '-pedantic', x!, lang!, join(here, 'reader.c'), '-o',
          exe]);
        for (const [name, make] of Object.entries(MODELS)) {
          const d = make().finish(), file = join(dir, `${name}.cbr`);
          writeFileSync(file, new Uint8Array(d.buffer));
          const out = execFileSync(exe, [file], { env: { ...process.env, CBR_TYPES: types } }).toString();
          // Per column: its count, the sum of its finite values (printed with 17 digits, so read back exactly) and
          // how many aren't finite.
          const read = out.trim().split('\n').map((line) => line.split(' '));
          const expected = COLUMNS.map((c, k) => {
            const xs = (d[c.table] as Record<string, ArrayLike<number>>)[c.column]!;
            let sum = 0, bad = 0;
            for (let j = 0; j < xs.length; j++) {
              if (Number.isFinite(xs[j]!)) sum += xs[j]!;
              else bad++;
            }
            return [String(k), String(xs.length), sum, String(bad)];
          });
          assert.deepEqual(read.slice(0, -1).map(([k, n, sum, bad]) => [k, n, Number(sum), bad]), expected,
            `${lang} ${name}`);
          assert.deepEqual(read.at(-1), ['kinds', ...[CURVE_KIND.offset, SURFACE_KIND.fixedReferenceSwept,
            ITEM_KIND.instance, TRIM_PREFERENCES.indexOf('cartesian')].map(String)]);
          // A corrupt header is refused.
          const bad = new Uint8Array(d.buffer.slice(0));
          new DataView(bad.buffer).setUint32(8, 4, true);
          writeFileSync(file, bad);
          const r = spawnSync(exe, [file], { env: { ...process.env, CBR_TYPES: types } });
          assert.equal(r.status, 2, `${lang} ${name}: a corrupt offset`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
