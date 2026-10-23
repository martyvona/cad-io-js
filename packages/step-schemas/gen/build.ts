// Dictionary building, shared by the generator CLI and the tests.

import crypto from 'node:crypto';
import { parseExpress } from './parser.ts';
import type { DictionaryInfo } from '../src/catalog.ts';
import type { EntityDef, SchemaDictionary } from '../src/types.ts';

/** Parse one EXPRESS long-form file into a dictionary. */
export function buildDictionary(info: DictionaryInfo, bytes: Uint8Array): SchemaDictionary {
  const schemas = parseExpress(new TextDecoder('latin1').decode(bytes));
  if (schemas.length !== 1) throw new Error(`${info.source}: expected one schema, found ${schemas.length}`);
  const s = schemas[0]!;
  if (s.name !== info.schema) throw new Error(`${info.source}: schema is ${s.name}, expected ${info.schema}`);
  resolveRedeclarations(s.entities, info.source);
  return {
    format: 1,
    schema: s.name,
    source: {
      file: `stepcode/data/${info.source}`,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      title: info.title,
    },
    entities: sortKeys(s.entities),
    types: sortKeys(s.types),
  };
}

/**
 * `SELF\x.attr` can name any supertype x in which attr is visible. Rewrite `from` to the entity that declares
 * attr, so consumers can key attributes by (declarer, name).
 */
function resolveRedeclarations(entities: Record<string, EntityDef>, source: string): void {
  const declarer = (e: string, attr: string): string[] => {
    const def = entities[e];
    if (!def) throw new Error(`${source}: unknown entity ${e}`);
    if (def.attrs.some((a) => a.name === attr)) return [e];
    return [...new Set(def.supertypes.flatMap((s) => declarer(s, attr)))];
  };
  for (const [name, def] of Object.entries(entities)) {
    for (const r of [...(def.redeclared ?? []), ...(def.derivedRedeclared ?? [])]) {
      const found = declarer(r.from, r.name);
      if (found.length !== 1) {
        throw new Error(`${source}: ${name} redeclares ${r.from}.${r.name}, declared in `
          + `${found.length ? found.join(', ') : 'no entity'}`);
      }
      r.from = found[0]!;
    }
  }
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]!]));
}

/** One entity or type per line: compact, but still diffable when a schema changes. */
export function formatDictionary(d: SchemaDictionary): string {
  const table = (o: Record<string, unknown>) =>
    Object.entries(o).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  return [
    '{',
    `  "format": ${d.format},`,
    `  "schema": ${JSON.stringify(d.schema)},`,
    `  "source": ${JSON.stringify(d.source)},`,
    '  "entities": {',
    table(d.entities),
    '  },',
    '  "types": {',
    table(d.types),
    '  }',
    '}',
    '',
  ].join('\n');
}
