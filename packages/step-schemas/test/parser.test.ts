import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExpress } from '../gen/parser.ts';

function one(src: string) {
  const schemas = parseExpress(src);
  assert.equal(schemas.length, 1);
  return schemas[0]!;
}

test('entities: attributes, OPTIONAL, aggregates, supertypes', () => {
  const s = one(`
    SCHEMA test_schema 'version 1';
    ENTITY point ABSTRACT SUPERTYPE OF (ONEOF(cartesian_point, other_point)); END_ENTITY;
    ENTITY Cartesian_Point
      SUBTYPE OF (point);
      coordinates : LIST [1:3] OF length_measure;
      label, note : OPTIONAL STRING(80) FIXED;
      grid        : ARRAY [0:hi] OF OPTIONAL ARRAY [1:2] OF UNIQUE REAL(15);
      tags        : SET [1:?] OF STRING;
    END_ENTITY;
    END_SCHEMA;`);
  assert.equal(s.name, 'TEST_SCHEMA');
  assert.deepEqual(s.entities.POINT, {
    abstract: true,
    supertypes: [],
    attrs: [],
    supertypeOf: { op: 'ONEOF', args: ['CARTESIAN_POINT', 'OTHER_POINT'] },
  });
  assert.deepEqual(s.entities.CARTESIAN_POINT, {
    supertypes: ['POINT'],
    attrs: [
      { name: 'coordinates', type: { agg: 'LIST', lo: 1, hi: 3, of: 'LENGTH_MEASURE' } },
      { name: 'label', type: 'STRING', optional: true },
      { name: 'note', type: 'STRING', optional: true },
      {
        name: 'grid',
        type: { agg: 'ARRAY', lo: 0, hi: 'hi', of: { agg: 'ARRAY', lo: 1, hi: 2, of: 'REAL', unique: true },
          optional: true },
      },
      { name: 'tags', type: { agg: 'SET', lo: 1, hi: null, of: 'STRING' } },
    ],
  });
});

test('supertype expressions: AND binds tighter than ANDOR, chains flatten', () => {
  const s = one(`
    SCHEMA t;
    ENTITY a SUPERTYPE OF (ONEOF(b, c) ANDOR d AND e AND (f ANDOR g)); END_ENTITY;
    END_SCHEMA;`);
  assert.deepEqual(s.entities.A!.supertypeOf, {
    op: 'ANDOR',
    args: [
      { op: 'ONEOF', args: ['B', 'C'] },
      { op: 'AND', args: ['D', 'E', { op: 'ANDOR', args: ['F', 'G'] }] },
    ],
  });
});

test('redeclarations, derived attributes and inverses', () => {
  const s = one(`
    SCHEMA t;
    ENTITY sub SUBTYPE OF (base, other);
      SELF\\base.size : positive_length_measure;
      SELF\\base.note RENAMED remark : OPTIONAL STRING;
      own : INTEGER;
    DERIVE
      SELF\\other.dim : dimension_count := 3;
      area : REAL := size ** 2 * (1 + SIZEOF([own, (own)]));
    INVERSE
      users   : SET [1:?] OF user FOR used;
      owner   : holder FOR holder.held;
      bags    : BAG OF bagger FOR item;
    UNIQUE
      ur1 : own;
    WHERE
      wr1 : QUERY(x <* [1, 2] | x > 0) <> [];
    END_ENTITY;
    END_SCHEMA;`);
  assert.deepEqual(s.entities.SUB, {
    supertypes: ['BASE', 'OTHER'],
    attrs: [{ name: 'own', type: 'INTEGER' }],
    redeclared: [
      { from: 'BASE', name: 'size', type: 'POSITIVE_LENGTH_MEASURE' },
      { from: 'BASE', name: 'note', renamed: 'remark', type: 'STRING', optional: true },
    ],
    derivedRedeclared: [{ from: 'OTHER', name: 'dim', type: 'DIMENSION_COUNT' }],
    derived: ['area'],
    inverse: [
      { name: 'users', agg: 'SET', lo: 1, hi: null, entity: 'USER', attr: 'used' },
      { name: 'owner', entity: 'HOLDER', attr: 'held' },
      { name: 'bags', agg: 'BAG', entity: 'BAGGER', attr: 'item' },
    ],
  });
});

test('types: defined, select, enumeration, extensible and BASED_ON forms', () => {
  const s = one(`
    SCHEMA t;
    TYPE length_measure = REAL; END_TYPE;
    TYPE positive_length_measure = length_measure; WHERE wr1 : SELF > 0; END_TYPE;
    TYPE label_list = LIST [1:?] OF UNIQUE label; END_TYPE;
    TYPE item_select = SELECT (Point, curve); END_TYPE;
    TYPE ext_select = EXTENSIBLE GENERIC_ENTITY SELECT; END_TYPE;
    TYPE more_select = SELECT BASED_ON ext_select WITH (surface); END_TYPE;
    TYPE form = ENUMERATION OF (polyline_form, circular_arc, Unspecified); END_TYPE;
    TYPE ext_enum = EXTENSIBLE ENUMERATION; END_TYPE;
    TYPE more_enum = ENUMERATION BASED_ON ext_enum WITH (x, y); END_TYPE;
    END_SCHEMA;`);
  assert.deepEqual(s.types, {
    LENGTH_MEASURE: { kind: 'defined', type: 'REAL' },
    POSITIVE_LENGTH_MEASURE: { kind: 'defined', type: 'LENGTH_MEASURE' },
    LABEL_LIST: { kind: 'defined', type: { agg: 'LIST', lo: 1, hi: null, of: 'LABEL', unique: true } },
    ITEM_SELECT: { kind: 'select', items: ['POINT', 'CURVE'] },
    EXT_SELECT: { kind: 'select', items: [], extensible: true, genericEntity: true },
    MORE_SELECT: { kind: 'select', items: ['SURFACE'], basedOn: 'EXT_SELECT' },
    FORM: { kind: 'enum', values: ['POLYLINE_FORM', 'CIRCULAR_ARC', 'UNSPECIFIED'] },
    EXT_ENUM: { kind: 'enum', values: [], extensible: true },
    MORE_ENUM: { kind: 'enum', values: ['X', 'Y'], basedOn: 'EXT_ENUM' },
  });
});

test('skips remarks, constants, rules, nested algorithms and subtype constraints', () => {
  const s = one(`
    (* outer (* nested remark with ENTITY fake; END_ENTITY; *) still a remark *)
    SCHEMA t;
    USE FROM other_schema (thing);
    CONSTANT dummy : INTEGER := 1; END_CONSTANT;
    SUBTYPE_CONSTRAINT sc FOR a; ONEOF(b, c); END_SUBTYPE_CONSTRAINT;
    FUNCTION f(x : INTEGER) : INTEGER;
      FUNCTION g(y : INTEGER) : INTEGER; RETURN (y); END_FUNCTION;
      PROCEDURE p; END_PROCEDURE;
      RETURN (g(x)); -- END_FUNCTION in a tail remark
    END_FUNCTION;
    RULE r FOR (a); WHERE wr1 : SIZEOF(a) > 0; END_RULE;
    ENTITY a; s : STRING; END_ENTITY;
    END_SCHEMA;`);
  assert.deepEqual(Object.keys(s.entities), ['A']);
  assert.deepEqual(s.types, {});
});

test('errors carry a line number', () => {
  assert.throws(() => parseExpress('SCHEMA t;\nENTITY a;\n  x INTEGER;\nEND_ENTITY;\nEND_SCHEMA;'),
    /line 3: expected ':'/);
  assert.throws(() => parseExpress('SCHEMA t;\nENTITY a; END_ENTITY;\nENTITY A; END_ENTITY;\nEND_SCHEMA;'),
    /duplicate declaration of A/);
});
