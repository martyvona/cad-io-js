// Semantic JSON: what Layer 3 extracts, as standard JSON for any JSON tool. Unlike raw JSON (../json.ts), numbers
// are plain JSON numbers: the meaning of every field is fixed by this format, so there is no integer/real question.
// Matrices are 16 numbers, column-major (as three.js and glTF); lengths are in the representation's own unit unless
// a field says metres; ids are instance ids in the source file.

import type { StepModel } from '../bind.ts';
import type { Diagnostic, Value } from '../model.ts';
import type { Semantics } from './index.ts';
import { productInstances } from './products.ts';
import type { RepresentationContext, Unit } from './units.ts';

export const SEMANTIC_JSON_FORMAT = 'cad-io-js semantic';
export const SEMANTIC_JSON_VERSION = 1;

export interface SemanticJsonOptions {
  /** Include every product instance (each use of a product, with its path and transform to the root). */
  instances?: boolean;
  /** Further diagnostics to include (parse and binding ones, say), before the extractors'. */
  diagnostics?: readonly Diagnostic[];
}

/** The semantic JSON document, as a plain object for JSON.stringify. */
export function semanticJson(model: StepModel, sem: Semantics, opts: SemanticJsonOptions = {}): Record<string, unknown> {
  const s = sem.structure;
  const file = model.file;
  const header = (type: string, i: number): unknown => {
    const v = file.headerEntity(type)?.attrs[i];
    if (v?.k === 'str') return v.v;
    if (v?.k === 'list') return v.v.flatMap((e: Value) => (e.k === 'str' ? [e.v] : []));
    return undefined;
  };
  const doc: Record<string, unknown> = {
    format: SEMANTIC_JSON_FORMAT,
    version: SEMANTIC_JSON_VERSION,
    source: 'step',
    file: {
      name: header('FILE_NAME', 0),
      timeStamp: header('FILE_NAME', 1),
      author: header('FILE_NAME', 2),
      organization: header('FILE_NAME', 3),
      preprocessorVersion: header('FILE_NAME', 4),
      originatingSystem: header('FILE_NAME', 5),
      authorization: header('FILE_NAME', 6),
      description: header('FILE_DESCRIPTION', 0),
      implementationLevel: header('FILE_DESCRIPTION', 1),
      schemas: file.schemaNames,
      dictionary: model.schema?.name ?? null,
      fallbackDictionary: model.fallback?.name ?? null,
    },
    roots: s.roots,
    products: s.products,
    occurrences: s.occurrences.map((o) => ({ ...o, transform: matrix(o.transform) })),
    representations: [...s.representations.values()].map((r) => ({
      ...r,
      context: r.context && context(r.context),
      related: r.related.map((x) => ({ ...x, transform: matrix(x.transform) })),
    })),
  };
  if (opts.instances) {
    doc.instances = productInstances(s).map((i) => ({ product: i.product, path: i.path, transform: matrix(i.transform) }));
  }
  doc.styles = { styled: sem.styles.styled, layers: sem.styles.layers };
  doc.validation = sem.validation;
  doc.diagnostics = [...(opts.diagnostics ?? []), ...sem.diagnostics];
  return doc;
}

function matrix(m: Float64Array | undefined): number[] | null {
  return m ? Array.from(m, (x) => (Object.is(x, -0) ? 0 : x)) : null;
}

function unit(u: Unit | undefined) {
  return u && { name: u.name, kind: u.kind, factor: u.factor ?? null, id: u.id };
}

function context(c: RepresentationContext) {
  return {
    id: c.id,
    identifier: c.identifier,
    type: c.type,
    dimension: c.dimension,
    lengthUnit: unit(c.lengthUnit),
    planeAngleUnit: unit(c.planeAngleUnit),
    solidAngleUnit: unit(c.solidAngleUnit),
    otherUnits: c.otherUnits.map(unit),
    uncertainty: c.uncertainty,
  };
}
