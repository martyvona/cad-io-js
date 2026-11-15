// Writes the B-rep test data as a C++ header for the native tests, so they (WebAssembly ones too) need no file
// access and no JSON: cad-brep's test models (packages/cad-brep/test/models.ts) as buffers, and the reference shapes
// (packages/cad-brep/test/reference/fixtures/: <name>-<variant>.cbr and .json, format 2) as buffers with their facts
// as plain structs, and the 2D geometry queries of the catalogue's cases. It only reads the reference directory.
// build.sh's test mode runs it:
//   node native/test/fixtures.ts <header> [--reference <dir>]
//   #include "brep_models.h"   fixtures::models[i].{name, data, size}, fixtures::model("seamCylinder");
//                              fixtures::references[i] (its curvePoints, nCurvePoints, ... per kind),
//                              fixtures::reference("cylinder", "s1")
// Each fact kind is a row of KINDS: its JSON fields, in order, and their C++ types. A kind, field or top-level key
// the table doesn't know, or one it expects and is missing, fails the run naming the file: the format is the
// reference lane's, so a change there must show up here, not be skipped.
import fs from 'node:fs';
import path from 'node:path';
import { MODELS } from '../../../cad-brep/test/models.ts';

/**
 * A field's type: row (a row index, int), id (the row's source id, uint32), num, bool, vec (2 or 3 numbers, a 2D
 * one padded with z = 0), vecOrNull (null where undefined: hasN false), certainty (result.h's), alts1 (parameters),
 * alts2 ((u, v) pairs).
 */
type Type = 'row' | 'id' | 'num' | 'bool' | 'vec' | 'vecOrNull' | 'certainty' | 'uv' | 'alts1' | 'alts2';
interface Kind { struct: string; list: string; doc: string; fields: [string, Type][] }

const TOLERANCE: [string, Type][] = [['tol', 'num'], ['abs', 'num']];
export const KINDS: Record<string, Kind> = {
  curvePoint: { struct: 'CurvePoint', list: 'curvePoints', doc: 'C(t) and its first two derivatives',
    fields: [['curve', 'row'], ['id', 'id'], ['t', 'num'], ['p', 'vec'], ['d1', 'vec'], ['d2', 'vec'], ...TOLERANCE] },
  curveLength: { struct: 'CurveLength', list: 'curveLengths', doc: 'the length of C over [t0, t1]',
    fields: [['curve', 'row'], ['id', 'id'], ['t0', 'num'], ['t1', 'num'], ['length', 'num'], ...TOLERANCE] },
  surfacePoint: { struct: 'SurfacePoint', list: 'surfacePoints',
    doc: 'S(u, v), its derivatives to second order, and the unit normal of S_u x S_v (hasN false where it vanishes)',
    fields: [['surface', 'row'], ['id', 'id'], ['u', 'num'], ['v', 'num'], ['p', 'vec'], ['du', 'vec'],
      ['dv', 'vec'], ['duu', 'vec'], ['duv', 'vec'], ['dvv', 'vec'], ['n', 'vecOrNull'], ...TOLERANCE] },
  curveInverse: { struct: 'CurveInverse', list: 'curveInverses',
    doc: 'the parameter of the point of C nearest p (in [lo, lo + period) on a periodic curve)',
    fields: [['curve', 'row'], ['id', 'id'], ['p', 'vec'], ['t', 'num'], ['distance', 'num'],
      ['certainty', 'certainty'], ['alternatives', 'alts1'], ['onSeam', 'bool'], ['ptol', 'num'], ...TOLERANCE] },
  surfaceInverse: { struct: 'SurfaceInverse', list: 'surfaceInverses',
    doc: 'the (u, v) of the point of S nearest p (at a singularity, one of the right ones)',
    fields: [['surface', 'row'], ['id', 'id'], ['p', 'vec'], ['uv', 'uv'], ['distance', 'num'],
      ['certainty', 'certainty'], ['alternatives', 'alts2'], ['onSeamU', 'bool'], ['onSeamV', 'bool'],
      ['atSingularity', 'bool'], ['ptol', 'num'], ...TOLERANCE] },
  faceArea: { struct: 'FaceArea', list: 'faceAreas', doc: 'a face\'s area',
    fields: [['face', 'row'], ['id', 'id'], ['area', 'num'], ...TOLERANCE] },
  volume: { struct: 'Volume', list: 'volumes',
    doc: 'a body\'s signed volume (positive with normals out of the material)',
    fields: [['body', 'row'], ['id', 'id'], ['volume', 'num'], ...TOLERANCE] },
};
const TOP = ['format', 'name', 'variant', 'file', 'similarity', 'uncertainty', 'facts', 'cases'];

/** A double as a C++ literal that reads back the same (JS's shortest round trip; JSON has no -0). */
function num(x: unknown, where: string): string {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`${where}: not a finite number: ${x}`);
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}
function vec(x: unknown, where: string): string {
  if (!Array.isArray(x) || (x.length !== 2 && x.length !== 3)) throw new Error(`${where}: not 2 or 3 numbers`);
  return `{${num(x[0], where)}, ${num(x[1], where)}, ${x.length === 3 ? num(x[2], where) : '0.0'}}`;
}
function int(x: unknown, where: string, max: number): string {
  if (!Number.isInteger(x) || (x as number) < 0 || (x as number) > max) throw new Error(`${where}: not an index: ${x}`);
  return String(x);
}
const CXX: Record<Type, string> = { row: 'int', id: 'uint32_t', num: 'double', bool: 'bool', vec: 'Vec',
  vecOrNull: 'Vec', certainty: 'cadgeom::Certainty', uv: 'double', alts1: 'const double*', alts2: 'const double*' };

/** One fact's struct initializer, its alternatives' arrays added to `arrays` (named from `prefix`). */
function fact(k: Kind, f: Record<string, unknown>, where: string, prefix: string, arrays: string[]): string {
  const want = new Set(['kind', ...k.fields.map(([n]) => n)]);
  for (const key of Object.keys(f)) if (!want.has(key)) throw new Error(`${where}: unknown field "${key}"`);
  const parts: string[] = [];
  for (const [name, type] of k.fields) {
    const w = `${where}.${name}`;
    if (!(name in f)) throw new Error(`${w}: missing`);
    const x = f[name];
    switch (type) {
      case 'row': parts.push(int(x, w, 2 ** 31 - 1)); break;
      case 'id': parts.push(int(x, w, 2 ** 32 - 1)); break;
      case 'num': parts.push(num(x, w)); break;
      case 'bool':
        if (typeof x !== 'boolean') throw new Error(`${w}: not a boolean`);
        parts.push(String(x)); break;
      case 'vec': parts.push(vec(x, w)); break;
      case 'vecOrNull': parts.push(x === null ? '{0.0, 0.0, 0.0}, false' : `${vec(x, w)}, true`); break;
      case 'certainty':
        if (x !== 'unique' && x !== 'ambiguous' && x !== 'none') throw new Error(`${w}: unknown certainty ${x}`);
        parts.push(`cadgeom::Certainty::${x}`); break;
      case 'uv':
        if (!Array.isArray(x) || x.length !== 2) throw new Error(`${w}: not 2 numbers`);
        parts.push(num(x[0], w), num(x[1], w)); break;
      case 'alts1': case 'alts2': {
        if (!Array.isArray(x)) throw new Error(`${w}: not an array`);
        const flat = type === 'alts1' ? x : x.map((p, i) => {
          if (!Array.isArray(p) || p.length !== 2) throw new Error(`${w}[${i}]: not 2 numbers`);
          return p;
        }).flat();
        const name2 = `${prefix}_${name}`;
        if (flat.length) arrays.push(`inline const double ${name2}[] = {${flat.map(v => num(v, w)).join(', ')}};`);
        parts.push(flat.length ? name2 : 'nullptr', String(x.length)); break;
      }
    }
  }
  return `{${parts.join(', ')}}`;
}

/** The C++ members a field becomes. */
function members(name: string, type: Type): string[] {
  if (type === 'vecOrNull') return [`Vec ${name};`, `bool has${name.toUpperCase()};`];
  if (type === 'uv') return ['double u, v;'];
  if (type === 'alts1' || type === 'alts2') {
    return [`${CXX[type]} ${name};  // ${type === 'alts1' ? 'parameters' : '(u, v) pairs, flat'}`,
      `int n${name[0]!.toUpperCase()}${name.slice(1)};`];
  }
  return [`${CXX[type]} ${name};`];
}

const ident = (s: string) => s.replace(/[^A-Za-z0-9]/g, '_');
const bytes = (data: Uint8Array) => {
  const out: string[] = [];
  for (let i = 0; i < data.length; i += 24) {
    out.push('  ' + Array.from(data.subarray(i, i + 24), b => `${b},`).join(''));
  }
  return out;
};

// The catalogue's cases (`cases`): each query a row of QUERIES, its input and expected fields (optional ones marked,
// a `has<Name>` member saying whether it was given) and their C++ types, converted as the facts are. The measures
// (OTHER_QUERIES) are known and left out until their lane's converter; any other query, or an unknown or missing
// field, fails the run.
type CaseType = 'row' | 'num' | 'bool' | 'vec2' | 'vec3' | 'range' | 'uv' | 'curveRange' | 'periods' | 'side'
  | 'certainty' | 'crossings' | 'overlaps' | 'ints' | 'alts1' | 'alts2' | 'singularities' | 'family';
type Field = [string, CaseType] | [string, CaseType, 'optional'];
interface Query {
  struct: string;
  list: string;
  doc: string;
  input: Field[];
  expected: Field[];
}
export const QUERIES: Record<string, Query> = {
  intersect2: { struct: 'Intersect2Case', list: 'intersect2Cases',
    doc: 'intersect2 on two curve rows over their ranges',
    input: [['a', 'curveRange'], ['b', 'curveRange'], ['tol', 'num']],
    expected: [['crossings', 'crossings'], ['overlaps', 'overlaps']] },
  selfIntersect2: { struct: 'SelfIntersect2Case', list: 'selfIntersect2Cases',
    doc: 'selfIntersect2 on a face\'s loop (loop: its index among the face\'s loops)',
    input: [['face', 'row'], ['loop', 'row'], ['tol', 'num']],
    expected: [['crossings', 'crossings'], ['overlaps', 'overlaps']] },
  classify2: { struct: 'Classify2Case', list: 'classify2Cases', doc: 'classify2 of a point against a face\'s loops',
    input: [['face', 'row'], ['p', 'vec2'], ['periods', 'periods'], ['tol', 'num']], expected: [['side', 'side']] },
  nest2: { struct: 'Nest2Case', list: 'nest2Cases', doc: 'nest2 on a face\'s loops',
    input: [['face', 'row'], ['periods', 'periods'], ['tol', 'num']], expected: [['parents', 'ints']] },
  invertCurve: { struct: 'InvertCurveCase', list: 'invertCurveCases',
    doc: 'invertCurve of a point on a curve row (range: the curve\'s domain if not given)',
    input: [['curve', 'row'], ['p', 'vec3'], ['range', 'range', 'optional'], ['tol', 'num']],
    expected: [['t', 'num'], ['distance', 'num'], ['certainty', 'certainty'], ['alternatives', 'alts1'],
      ['onSeam', 'bool', 'optional']] },
  invertSurface: { struct: 'InvertSurfaceCase', list: 'invertSurfaceCases',
    doc: 'invertSurface of a point on a surface row (family: a curve of equally near feet, where there is one)',
    input: [['surface', 'row'], ['p', 'vec3'], ['tol', 'num']],
    expected: [['uv', 'uv'], ['distance', 'num'], ['certainty', 'certainty'], ['alternatives', 'alts2'],
      ['onSeamU', 'bool'], ['onSeamV', 'bool'], ['atSingularity', 'bool'], ['family', 'family', 'optional']] },
  singularities: { struct: 'SingularitiesCase', list: 'singularitiesCases', doc: 'a surface row\'s singularities',
    input: [['surface', 'row']], expected: [['singularities', 'singularities']] },
  singular: { struct: 'SingularCase', list: 'singularCases', doc: 'where a curve row\'s speed vanishes over a range',
    input: [['curve', 'row'], ['range', 'range']], expected: [['params', 'alts1'], ['point', 'vec3']] },
};
export const OTHER_QUERIES = ['faceWidth', 'normal', 'loopCoedges', 'edgeLength', 'vertexGap', 'edgeUses'];
const CASE_TOP = ['id', 'description', 'entities', 'query', 'input', 'expected'];
const SINGULARITY_KINDS = ['pole', 'apex', 'normalVanishes'];

const cap = (name: string) => name[0]!.toUpperCase() + name.slice(1);

function caseMembers(name: string, type: CaseType): string[] {
  switch (type) {
    case 'row': return [`int ${name};`];
    case 'num': return [`double ${name};`];
    case 'bool': return [`bool ${name};`];
    case 'vec2': case 'vec3': return [`Vec ${name};`];
    case 'range': return [`double ${name}Lo, ${name}Hi;`];
    case 'uv': return ['double u, v;'];
    case 'curveRange': return [`int ${name}Curve;`, `double ${name}Lo, ${name}Hi;`];
    case 'periods': return ['double periodU, periodV;', 'const double* poleU;', 'int nPoleU;', 'const double* poleV;',
      'int nPoleV;', 'bool hasPoles;  // the input gives poleU and poleV (format 3; else the test derives them)'];
    case 'side': return [`cadgeom::Side ${name};`];
    case 'certainty': return [`cadgeom::Certainty ${name};`];
    case 'crossings': return ['const ExpectedCrossing* crossings;', 'int nCrossings;'];
    case 'overlaps': return ['const ExpectedOverlap* overlaps;', 'int nOverlaps;'];
    case 'ints': return [`const int* ${name};`, `int n${cap(name)};`];
    case 'alts1': return [`const double* ${name};`, `int n${cap(name)};`];
    case 'alts2': return [`const double* ${name};  // (u, v) pairs, flat`, `int n${cap(name)};  // pairs`];
    case 'singularities': return ['const ExpectedSingularity* singularities;', 'int nSingularities;'];
    case 'family': return [`bool ${name}U;  // the feet run along u over [lo, hi] at v = at (else along v)`,
      `double ${name}Lo, ${name}Hi, ${name}At;`];
  }
}

/** The C++ values of a missing optional field. */
function caseDefault(type: CaseType): string {
  switch (type) {
    case 'range': return 'NAN, NAN';
    case 'bool': return 'false';
    case 'family': return 'false, NAN, NAN, NAN';
    default: throw new Error(`no default for an optional ${type}`);
  }
}

function caseValue(type: CaseType, x: any, w: string, prefix: string, arrays: string[], format: number): string {
  const keys = (o: any, want: string[], optional: string[] = []) => {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error(`${w}: not an object`);
    for (const k of Object.keys(o))
      if (!want.includes(k) && !optional.includes(k)) throw new Error(`${w}: unknown "${k}"`);
    for (const k of want) if (!(k in o)) throw new Error(`${w}: missing "${k}"`);
  };
  const range = (r: any, ww: string) => {
    if (!Array.isArray(r) || r.length !== 2) throw new Error(`${ww}: not 2 numbers`);
    return `${num(r[0], ww)}, ${num(r[1], ww)}`;
  };
  const array = (name: string, cxx: string, items: string[], count = items.length) => {
    if (!items.length) return 'nullptr, 0';
    arrays.push(`inline const ${cxx} ${prefix}_${name}[] = {${items.join(', ')}};`);
    return `${prefix}_${name}, ${count}`;
  };
  const list = (v: any, ww: string) => {
    if (!Array.isArray(v)) throw new Error(`${ww}: not an array`);
    return v;
  };
  switch (type) {
    case 'row': return int(x, w, 2 ** 31 - 1);
    case 'num': return num(x, w);
    case 'bool':
      if (typeof x !== 'boolean') throw new Error(`${w}: not a boolean`);
      return String(x);
    case 'vec2':
      if (!Array.isArray(x) || x.length !== 2) throw new Error(`${w}: not 2 numbers`);
      return vec(x, w);
    case 'vec3':
      if (!Array.isArray(x) || x.length !== 3) throw new Error(`${w}: not 3 numbers`);
      return vec(x, w);
    case 'range': case 'uv': return range(x, w);
    case 'curveRange': keys(x, ['curve', 'range']); return `${int(x.curve, w, 2 ** 31 - 1)}, ${range(x.range, w)}`;
    case 'periods': {
      // Format 3 gives the surface's pole lines with its periods; format 2 doesn't.
      if (format >= 3) keys(x, ['u', 'v', 'poleU', 'poleV']);
      else keys(x, ['u', 'v']);
      const poles = (k: string) => array(k, 'double', list(x[k] ?? [], `${w}.${k}`).map((e: unknown) =>
        num(e, `${w}.${k}`)));
      return `${num(x.u, w)}, ${num(x.v, w)}, ${poles('poleU')}, ${poles('poleV')}, ${format >= 3}`;
    }
    case 'side':
      if (x !== 'in' && x !== 'out' && x !== 'on') throw new Error(`${w}: unknown side ${x}`);
      return `cadgeom::Side::${x}`;
    case 'certainty':
      if (x !== 'unique' && x !== 'ambiguous' && x !== 'none') throw new Error(`${w}: unknown certainty ${x}`);
      return `cadgeom::Certainty::${x}`;
    case 'crossings':
      return array('crossings', 'ExpectedCrossing', list(x, w).map((c: any, i: number) => {
        const ww = `${w}[${i}]`;
        keys(c, ['ta', 'tb', 'p', 'tangent']);
        if (typeof c.tangent !== 'boolean') throw new Error(`${ww}.tangent: not a boolean`);
        return `{${num(c.ta, ww)}, ${num(c.tb, ww)}, ${vec(c.p, ww)}, ${c.tangent}}`;
      }));
    case 'overlaps':
      return array('overlaps', 'ExpectedOverlap', list(x, w).map((o: any, i: number) => {
        const ww = `${w}[${i}]`;
        keys(o, ['a', 'b', 'sameDirection']);
        if (typeof o.sameDirection !== 'boolean') throw new Error(`${ww}.sameDirection: not a boolean`);
        return `{${range(o.a, ww)}, ${range(o.b, ww)}, ${o.sameDirection}}`;
      }));
    case 'ints':
      return array('ints', 'int', list(x, w).map((e: unknown) => {
        if (!Number.isInteger(e)) throw new Error(`${w}: not an integer: ${e}`);
        return String(e);
      }));
    case 'alts1': return array('values', 'double', list(x, w).map((e: unknown) => num(e, w)));
    case 'alts2': {
      const pairs = list(x, w).map((e: unknown, i: number) => range(e, `${w}[${i}]`));
      return array('pairs', 'double', pairs, pairs.length);
    }
    case 'singularities':
      return array('singularities', 'ExpectedSingularity', list(x, w).map((o: any, i: number) => {
        const ww = `${w}[${i}]`;
        keys(o, ['kind', 'isoU', 'at', 'point']);
        if (!SINGULARITY_KINDS.includes(o.kind)) throw new Error(`${ww}.kind: unknown ${o.kind}`);
        if (typeof o.isoU !== 'boolean') throw new Error(`${ww}.isoU: not a boolean`);
        if (!Array.isArray(o.point) || o.point.length !== 3) throw new Error(`${ww}.point: not 3 numbers`);
        return `{"${o.kind}", ${o.isoU}, ${num(o.at, ww)}, ${vec(o.point, ww)}}`;
      }));
    case 'family': {
      // One of u and v a range (the feet's direction), the other the number they're at.
      keys(x, ['u', 'v']);
      const uRange = Array.isArray(x.u);
      if (uRange === Array.isArray(x.v)) throw new Error(`${w}: exactly one of u and v must be a range`);
      return `${uRange}, ${range(uRange ? x.u : x.v, w)}, ${num(uRange ? x.v : x.u, w)}`;
    }
  }
}

/** One case's struct initializer, or null for a measure (OTHER_QUERIES). */
function caseRecord(c: any, w: string, prefix: string, arrays: string[], format: number): [Query, string] | null {
  if (typeof c !== 'object' || c === null) throw new Error(`${w}: not an object`);
  for (const k of Object.keys(c)) if (!CASE_TOP.includes(k)) throw new Error(`${w}: unknown key "${k}"`);
  for (const k of CASE_TOP) if (!(k in c)) throw new Error(`${w}: missing "${k}"`);
  if (OTHER_QUERIES.includes(c.query)) return null;
  const q = QUERIES[c.query];
  if (!q) throw new Error(`${w}: unknown query "${c.query}"`);
  if (typeof c.id !== 'string' || !/^[ -~]*$/.test(c.id) || /["\\]/.test(c.id)) throw new Error(`${w}: bad id`);
  const parts = [`"${c.id}"`];
  for (const [section, fields] of [['input', q.input], ['expected', q.expected]] as const) {
    const o = c[section];
    if (typeof o !== 'object' || o === null) throw new Error(`${w}.${section}: not an object`);
    const want = fields.map(([n]) => n);
    for (const k of Object.keys(o)) if (!want.includes(k)) throw new Error(`${w}.${section}: unknown field "${k}"`);
    for (const [name, type, optional] of fields) {
      const ww = `${w}.${section}.${name}`;
      if (!(name in o)) {
        if (!optional) throw new Error(`${ww}: missing`);
        parts.push(caseDefault(type), 'false');
        continue;
      }
      parts.push(caseValue(type, o[name], ww, `${prefix}_${section}_${name}`, arrays, format));
      if (optional) parts.push('true');
    }
  }
  return [q, `{${parts.join(', ')}}`];
}

export function generate(referenceDir: string): string {
  const lines = ['// Generated by native/test/fixtures.ts from packages/cad-brep/test/models.ts and the reference',
    '// fixtures: not to be edited.', '#pragma once', '#include <cstddef>', '#include <cstdint>', '#include <cstring>',
    '#include <cmath>', '', '#include <cad_geom/result.h>', '', 'namespace fixtures {', '',
    '/** A point or vector; 2D ones (p-curves) with z = 0. */', 'struct Vec {', '  double x, y, z;', '};', ''];
  const modelNames = Object.keys(MODELS).sort() as (keyof typeof MODELS)[];
  for (const name of modelNames) {
    const data = new Uint8Array(MODELS[name]().finish().buffer);
    lines.push(`alignas(8) inline const uint8_t ${name}[${data.length}] = {`, ...bytes(data), '};', '');
  }
  lines.push('struct Model {', '  const char* name;', '  const uint8_t* data;', '  size_t size;', '};', '',
    'inline const Model models[] = {', ...modelNames.map(n => `  {"${n}", ${n}, sizeof ${n}},`), '};', '',
    '/** The model of that name, null if there\'s none. */', 'inline const Model* model(const char* name) {',
    '  for (const Model& m : models)', '    if (std::strcmp(m.name, name) == 0) return &m;', '  return nullptr;',
    '}', '',
    '// The reference shapes\' facts. Rows index the .cbr as written; a value passes when |got - expected| <=',
    '// max(tol * |expected|, abs) per field (vectors by Euclidean norm), a parameter when within ptol (absolute).');
  for (const k of Object.values(KINDS)) {
    lines.push('', `/** ${k.doc}. */`, `struct ${k.struct} {`,
      ...k.fields.flatMap(([n, t]) => members(n, t)).map(m => `  ${m}`), '};');
  }
  lines.push('', '// The catalogue\'s cases: input and expected answer per query.', '',
    '/** An expected crossing: parameters on each, the point, touching without crossing. */',
    'struct ExpectedCrossing {', '  double ta, tb;', '  Vec p;', '  bool tangent;', '};', '',
    '/** An expected overlap: the ranges on each, and whether they run the same way. */',
    'struct ExpectedOverlap {', '  double aLo, aHi, bLo, bHi;', '  bool sameDirection;', '};', '',
    '/** An expected singularity: its kind ("pole", "apex", "normalVanishes"), the iso-line (u = at if isoU, else',
    ' * v = at), the point it collapses to. */',
    'struct ExpectedSingularity {', '  const char* kind;', '  bool isoU;', '  double at;', '  Vec point;', '};');
  for (const q of Object.values(QUERIES)) {
    lines.push('', `/** ${q.doc}. */`, `struct ${q.struct} {`, '  const char* id;',
      ...[...q.input, ...q.expected].flatMap(([n, t, optional]) =>
        [...caseMembers(n, t), ...(optional ? [`bool has${cap(n)};`] : [])]).map(m => `  ${m}`), '};');
  }

  const files = fs.existsSync(referenceDir) ? fs.readdirSync(referenceDir).sort() : [];
  const stems = [...new Set(files.filter(f => /\.(cbr|json)$/.test(f)).map(f => f.replace(/\.(cbr|json)$/, '')))];
  const refs: string[] = [];
  const index: string[] = [];  // every converted case: query, id, reference, its index in the query's list
  const seen = new Set<string>();
  for (const stem of stems) {
    const jsonPath = path.join(referenceDir, `${stem}.json`), cbrPath = path.join(referenceDir, `${stem}.cbr`);
    if (!fs.existsSync(jsonPath) || !fs.existsSync(cbrPath)) throw new Error(`${stem}: needs both .cbr and .json`);
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    for (const key of Object.keys(j)) if (!TOP.includes(key)) throw new Error(`${stem}.json: unknown key "${key}"`);
    for (const key of TOP) if (!(key in j)) throw new Error(`${stem}.json: missing "${key}"`);
    if (j.format !== 2 && j.format !== 3) throw new Error(`${stem}.json: format ${j.format}, this reads 2 and 3`);
    if (j.file !== stem || `${j.name}-${j.variant}` !== stem)
      throw new Error(`${stem}.json: file "${j.file}", name "${j.name}" and variant "${j.variant}" don't match`);
    const id = ident(stem);
    if (seen.has(id)) throw new Error(`${stem}: its C++ name ${id} is taken`);
    seen.add(id);
    const s = j.similarity;
    if (!s || !Array.isArray(s.rotation) || s.rotation.length !== 9 || !Array.isArray(s.translation) ||
      s.translation.length !== 3) {
      throw new Error(`${stem}.json: similarity needs scale, rotation (9), translation (3)`);
    }
    if (!Array.isArray(j.facts) || !Array.isArray(j.cases)) throw new Error(`${stem}.json: facts and cases arrays`);
    const data = new Uint8Array(fs.readFileSync(cbrPath));
    lines.push('', `alignas(8) inline const uint8_t ref_${id}_cbr[${data.length}] = {`, ...bytes(data), '};');
    const byKind = new Map<string, string[]>(), arrays: string[] = [];
    j.facts.forEach((f: Record<string, unknown>, i: number) => {
      const k = KINDS[f.kind as string];
      if (!k) throw new Error(`${stem}.json facts[${i}]: unknown kind "${f.kind}"`);
      const list = byKind.get(k.list) ?? [];
      list.push(fact(k, f, `${stem}.json facts[${i}] (${f.kind})`, `ref_${id}_${i}`, arrays));
      byKind.set(k.list, list);
    });
    j.cases.forEach((c: unknown, i: number) => {
      const r = caseRecord(c, `${stem}.json cases[${i}]`, `ref_${id}_case${i}`, arrays, j.format);
      if (!r) return;
      const at = (byKind.get(r[0].list) ?? []).length;
      index.push(`  {"${(c as any).query}", "${(c as any).id}", ${seen.size - 1}, ${at}},`);
      const list = byKind.get(r[0].list) ?? [];
      list.push(r[1]);
      byKind.set(r[0].list, list);
    });
    lines.push(...arrays);
    const lists = [...Object.values(KINDS), ...Object.values(QUERIES)].map(k => {
      const got = byKind.get(k.list);
      if (got) lines.push(`inline const ${k.struct} ref_${id}_${k.list}[] = {`, ...got.map(g => `  ${g},`), '};');
      return got ? `ref_${id}_${k.list}, ${got.length}` : 'nullptr, 0';
    });
    const w = `${stem}.json similarity`;
    refs.push(`  {"${j.name}", "${j.variant}", "${stem}", ref_${id}_cbr, sizeof ref_${id}_cbr, ${num(s.scale, w)},`,
      `    {${s.rotation.map((v: unknown) => num(v, w)).join(', ')}},`,
      `    {${s.translation.map((v: unknown) => num(v, w)).join(', ')}}, ${num(j.uncertainty, `${stem}.json`)},`,
      `    ${lists.join(', ')}},`);
  }
  lines.push('', '/** A reference shape: its buffer, the similarity it was made with, and its facts by kind. */',
    'struct Reference {', '  const char* name;', '  const char* variant;', '  const char* file;',
    '  const uint8_t* data;', '  size_t size;', '  double scale;', '  double rotation[9];  // column-major',
    '  double translation[3];', '  double uncertainty;',
    ...[...Object.values(KINDS), ...Object.values(QUERIES)].map(k => `  const ${k.struct}* ${k.list};\n` +
      `  int n${k.list[0]!.toUpperCase()}${k.list.slice(1)};`), '};', '',
    // An empty array isn't C++: a sentinel when there are no references, excluded by the count.
    `inline const Reference references[] = {`, ...(refs.length ? refs : ['  {}']), '};',
    `inline const int nReferences = ${seen.size};`, '',
    '/** The reference of that name and variant, null if there\'s none. */',
    'inline const Reference* reference(const char* name, const char* variant) {',
    '  for (int i = 0; i < nReferences; i++)',
    '    if (std::strcmp(references[i].name, name) == 0 && std::strcmp(references[i].variant, variant) == 0)',
    '      return &references[i];', '  return nullptr;', '}', '',
    '/** A case by query and id: its reference (references[reference]) and its index in that query\'s list. */',
    'struct CaseEntry {', '  const char* query;', '  const char* id;', '  int reference;', '  int index;', '};',
    `inline const CaseEntry caseIndex[] = {`, ...(index.length ? index : ['  {}']), '};',
    `inline const int nCases = ${index.length};`, '',
    '/** The case with this id, null if there\'s none. */', 'inline const CaseEntry* findCase(const char* id) {',
    '  for (int i = 0; i < nCases; i++)', '    if (std::strcmp(caseIndex[i].id, id) == 0) return &caseIndex[i];',
    '  return nullptr;', '}', '',
    '/** How many cases a query has. */', 'inline int countCases(const char* query) {', '  int n = 0;',
    '  for (int i = 0; i < nCases; i++) n += std::strcmp(caseIndex[i].query, query) == 0;', '  return n;', '}', '',
    '}  // namespace fixtures', '');
  return lines.join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const r = args.indexOf('--reference');
  const referenceDir = r >= 0 ? args.splice(r, 2)[1] : path.resolve(import.meta.dirname,
    '../../../cad-brep/test/reference/fixtures');
  const out = args[0];
  if (!out || !referenceDir || args.length !== 1)
    throw new Error('usage: node native/test/fixtures.ts <header> [--reference <dir>]');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, generate(referenceDir));
}
