// Writes the reference fixtures: per shape and variant, fixtures/<name>-<variant>.cbr (the model's buffer) and
// <name>-<variant>.json (its facts and cases), the C++ tests' data; reference.test.ts checks they're current.
// Run: node packages/cad-brep/test/reference/generate.ts
//
// The JSON (format 3): { format, name, variant, file, similarity: { scale, rotation (9, column-major), translation },
// uncertainty, facts, cases }. A fact passes when |got - expected| <= max(tol |expected|, abs) per field (vectors by
// their Euclidean norm), parameters (t, uv, alternatives) within ptol; no NaN or Infinity anywhere, null where a
// value is undefined (a normal at a pole). Cases (cases.ts) only in the case models, case-<topic>-s1. The cad-geom
// tests read these files field by field: a change of format is a change of `format` and of their reader
// (packages/cad-geom/native/test/fixtures.ts).

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrepData } from '../../src/data.ts';
import { type CaseRecord, CASES } from './cases.ts';
import { type Fact, Maker } from './maker.ts';
import { SHAPES } from './shapes.ts';
import { IDENTITY, type Similarity, VARIANTS } from './vec.ts';

export const FORMAT = 3;
export const FIXTURES = join(new URL('.', import.meta.url).pathname, 'fixtures');

export interface Fixture {
  file: string;
  data: BrepData;
  facts: Fact[];
  cases: CaseRecord[];
  json: string;
}

function fixture(name: string, variant: string, T: Similarity, data: BrepData, facts: Fact[], cases: CaseRecord[],
  uncertainty: number): Fixture {
  const file = `${name}-${variant}`;
  const head = { format: FORMAT, name, variant, file,
    similarity: { scale: T.s, rotation: T.q.flat().map((x) => x + 0), translation: T.t.map((x) => x + 0) },
    uncertainty };
  // One fact or case per line, so a change shows as the ones it changes.
  const list = (xs: unknown[]) => xs.length ? '[\n' + xs.map((x) => JSON.stringify(x)).join(',\n') + '\n]' : '[]';
  const json = JSON.stringify(head).slice(0, -1) + ',\n"facts": ' + list(facts) + ',\n"cases": ' + list(cases)
    + '\n}\n';
  return { file, data, facts, cases, json };
}

/** Every fixture, in order: shapes as listed, each at every variant, then the cases' models at s1. */
export function fixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const shape of SHAPES) for (const { name: variant, T } of VARIANTS) {
    const m = new Maker(T, shape.uncertainty);
    m.size = shape.size;
    shape.make(m);
    const { data, facts } = m.finish();
    out.push(fixture(shape.name, variant, T, data, facts, [], shape.uncertainty * T.s));
  }
  for (const c of CASES) {
    const m = new Maker(IDENTITY, c.uncertainty);
    m.size = c.size;
    const records = c.make(m);
    const { data, facts } = m.finish();
    out.push(fixture(c.name, 's1', IDENTITY, data, facts, records(data), c.uncertainty));
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
