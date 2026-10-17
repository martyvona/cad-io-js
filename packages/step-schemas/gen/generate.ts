// Build-time generator: EXPRESS long-form schemas from stepcode → JSON dictionaries in dict/.
// Usage: node gen/generate.ts   (STEPCODE_DIR overrides the stepcode checkout location)
// The output is committed, so the library has no build-time dependency on stepcode.

import fs from 'node:fs';
import path from 'node:path';
import { buildDictionary, formatDictionary } from './build.ts';
import { DICTIONARIES } from '../src/catalog.ts';

export const pkgDir = path.resolve(import.meta.dirname, '..');
export const stepcodeDir = process.env.STEPCODE_DIR ?? path.resolve(pkgDir, '../../../../others/stepcode');

if (import.meta.main) {
  for (const d of DICTIONARIES) {
    const dict = buildDictionary(d, fs.readFileSync(path.join(stepcodeDir, 'data', d.source)));
    const out = path.join(pkgDir, 'dict', `${d.id}.json`);
    fs.writeFileSync(out, formatDictionary(dict));
    console.log(`${d.id}: ${Object.keys(dict.entities).length} entities, ${Object.keys(dict.types).length} types → ${path.relative(process.cwd(), out)}`);
  }
}
