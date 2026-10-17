// The committed dictionaries must match what the generator produces from stepcode. Skipped when the stepcode
// checkout isn't available.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildDictionary, formatDictionary } from '../gen/build.ts';
import { pkgDir, stepcodeDir } from '../gen/generate.ts';
import { DICTIONARIES, Schema } from '../src/index.ts';

const haveStepcode = fs.existsSync(path.join(stepcodeDir, 'data'));

for (const d of DICTIONARIES) {
  test(`dict/${d.id}.json is up to date`, { skip: !haveStepcode && 'stepcode checkout not found' }, () => {
    const built = formatDictionary(buildDictionary(d, fs.readFileSync(path.join(stepcodeDir, 'data', d.source))));
    const committed = fs.readFileSync(path.join(pkgDir, 'dict', `${d.id}.json`), 'utf8');
    assert.ok(built === committed, `dict/${d.id}.json is stale; run npm run gen -w step-schemas`);
  });

  test(`dict/${d.id}.json is consistent`, () => {
    const s = new Schema(JSON.parse(fs.readFileSync(path.join(pkgDir, 'dict', `${d.id}.json`), 'utf8')));
    const { entities, types } = s.dict;
    const known = (t: string) => Object.hasOwn(entities, t) || Object.hasOwn(types, t) ||
      ['INTEGER', 'REAL', 'NUMBER', 'LOGICAL', 'BOOLEAN', 'STRING', 'BINARY'].includes(t);
    const checkRef = (where: string, t: unknown): void => {
      if (typeof t === 'string') assert.ok(known(t), `${where}: unknown type ${t}`);
      else checkRef(where, (t as { of: unknown }).of);
    };
    for (const [name, e] of Object.entries(entities)) {
      for (const st of e.supertypes) assert.ok(Object.hasOwn(entities, st), `${name}: unknown supertype ${st}`);
      for (const a of e.attrs) checkRef(`${name}.${a.name}`, a.type);
      for (const inv of e.inverse ?? []) assert.ok(Object.hasOwn(entities, inv.entity), `${name}.${inv.name}`);
      // Flattening must succeed for every entity (no cycles, redeclarations resolve).
      for (const r of [...(e.redeclared ?? []), ...(e.derivedRedeclared ?? [])]) {
        assert.ok(s.isSubtypeOf(name, r.from), `${name} redeclares ${r.from}.${r.name}`);
        assert.ok(entities[r.from]!.attrs.some((a) => a.name === r.name), `${name} redeclares ${r.from}.${r.name}`);
      }
      s.instanceAttributes(name);
    }
    for (const [name, t] of Object.entries(types)) {
      if (t.kind === 'defined') checkRef(name, t.type);
      if (t.kind === 'select') for (const i of t.items) assert.ok(known(i), `${name}: unknown select item ${i}`);
    }
  });
}
