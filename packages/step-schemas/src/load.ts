// Dictionary loading. Dynamic JSON imports work in Node.js and in bundlers, and only fetch what's used.

import { DICTIONARIES } from './catalog.ts';
import { Schema } from './schema.ts';
import type { SchemaDictionary } from './types.ts';

const loaders: Record<string, () => Promise<{ default: unknown }>> = {
  ap203: () => import('../dict/ap203.json', { with: { type: 'json' } }),
  ap203e2: () => import('../dict/ap203e2.json', { with: { type: 'json' } }),
  ap214e3: () => import('../dict/ap214e3.json', { with: { type: 'json' } }),
  ap242: () => import('../dict/ap242.json', { with: { type: 'json' } }),
};

export async function loadDictionary(id: string): Promise<SchemaDictionary> {
  const load = loaders[id];
  if (!load || !DICTIONARIES.some((d) => d.id === id)) throw new Error(`unknown schema dictionary '${id}'`);
  return (await load()).default as SchemaDictionary;
}

const schemas = new Map<string, Promise<Schema>>();

/** Load a dictionary and wrap it in a Schema; cached per id. */
export function loadSchema(id: string): Promise<Schema> {
  let s = schemas.get(id);
  if (!s) {
    s = loadDictionary(id).then((d) => new Schema(d));
    schemas.set(id, s);
  }
  return s;
}
