// Writes the reference fixtures: per shape and variant, fixtures/<name>-<variant>.cbr (the model's buffer) and
// <name>-<variant>.json (its facts and cases), the C++ tests' data; reference.test.ts checks they're current.
// Run: node packages/cad-brep/test/reference/generate.ts
//
// The JSON (format 1): { format, name, variant, file, similarity: { scale, rotation (9, column-major), translation },
// uncertainty, facts, cases }. A fact passes when |got - expected| <= max(tol |expected|, abs) per field (vectors by
// their Euclidean norm), parameters (t, uv, alternatives) within ptol; no NaN or Infinity anywhere, null where a
// value is undefined (a normal at a pole). The cad-geom tests read these files field by field: a change of format
// is a change of `format` and of their reader (packages/cad-geom/native/test/fixtures.ts).

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrepData } from '../../src/data.ts';
import { type Fact, Maker } from './maker.ts';
import { SHAPES } from './shapes.ts';
import { VARIANTS } from './vec.ts';

export const FORMAT = 1;
export const FIXTURES = join(new URL('.', import.meta.url).pathname, 'fixtures');

export interface Fixture {
  file: string;
  data: BrepData;
  facts: Fact[];
  json: string;
}

/** Every fixture, in order: shapes as listed, each at every variant. */
export function fixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const shape of SHAPES) for (const { name: variant, T } of VARIANTS) {
    const m = new Maker(T, shape.uncertainty);
    m.size = shape.size;
    shape.make(m);
    const { data, facts } = m.finish();
    const file = `${shape.name}-${variant}`;
    const head = { format: FORMAT, name: shape.name, variant, file,
      similarity: { scale: T.s, rotation: T.q.flat().map((x) => x + 0), translation: T.t.map((x) => x + 0) },
      uncertainty: shape.uncertainty * T.s };
    // One fact per line, so a change shows as the facts it changes.
    const json = JSON.stringify(head).slice(0, -1) + ',\n"facts": [\n' + facts.map((f) => JSON.stringify(f))
      .join(',\n') + '\n],\n"cases": []\n}\n';
    out.push({ file, data, facts, json });
  }
  return out;
}

if (import.meta.main) {
  mkdirSync(FIXTURES, { recursive: true });
  for (const f of readdirSync(FIXTURES)) rmSync(join(FIXTURES, f));
  for (const f of fixtures()) {
    writeFileSync(join(FIXTURES, `${f.file}.cbr`), new Uint8Array(f.data.buffer));
    writeFileSync(join(FIXTURES, `${f.file}.json`), f.json);
  }
}
