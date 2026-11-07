import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { headerText } from '../gen/header.ts';
import { COLUMNS, CURVE_KIND, ITEM_KIND, SURFACE_KIND, TRIM_PREFERENCES } from '../src/index.ts';
import { MODELS } from './models.ts';

const here = new URL('.', import.meta.url).pathname;

test('include/cad_brep.h is what gen/header.ts writes', () => {
  assert.equal(readFileSync(join(here, '../include/cad_brep.h'), 'utf8'), headerText(),
    'stale: run node packages/cad-brep/gen/header.ts');
});

const compilers = [['cc', '-std=c99', '-x', 'c'], ['c++', '-std=c++17', '-x', 'c++']].filter(([cc]) =>
  spawnSync(cc!, ['--version']).status === 0);

test('a C and a C++ reader see through the header what the views see', { skip: !compilers.length && 'no compiler' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'cad-brep-'));
    try {
      const types = COLUMNS.map((c) => ({ u8: 'b', i32: 'i', f64: 'f' })[c.type]).join('');
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
