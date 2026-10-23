import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExpress } from '../gen/parser.ts';
import { Schema, dictionaryForFileSchema, dictionaryForSchemaName, loadSchema,
  type SchemaDictionary } from '../src/index.ts';

function schemaOf(src: string): Schema {
  const p = parseExpress(src)[0]!;
  const dict: SchemaDictionary = { format: 1, schema: p.name, source: { file: 'test', sha256: '' }, ...p };
  return new Schema(dict);
}

const slotNames = (s: Schema, e: string) => s.instanceAttributes(e).map(
  (a) => `${a.owner}.${a.name}${a.derived ? '*' : ''}`);

test('instance attributes: supertypes first, SUBTYPE OF order, shared supertypes once', () => {
  const s = schemaOf(`
    SCHEMA t;
    ENTITY root; r : INTEGER; END_ENTITY;
    ENTITY left SUBTYPE OF (root); l : INTEGER; END_ENTITY;
    ENTITY right SUBTYPE OF (root); x : INTEGER; END_ENTITY;
    ENTITY leaf SUBTYPE OF (right, left); x : INTEGER; END_ENTITY;
    END_SCHEMA;`);
  // Same-named attributes from different declarers are distinct slots.
  assert.deepEqual(slotNames(s, 'leaf'), ['ROOT.r', 'RIGHT.x', 'LEFT.l', 'LEAF.x']);
  assert.deepEqual(s.ancestors('LEAF'), ['ROOT', 'RIGHT', 'LEFT', 'LEAF']);
  assert.ok(s.isSubtypeOf('leaf', 'root'));
  assert.ok(!s.isSubtypeOf('left', 'right'));
  assert.deepEqual(s.subtypes('ROOT'), ['LEFT', 'RIGHT']);
});

test('redeclarations narrow types, drop OPTIONAL, or make a slot derived', () => {
  const s = schemaOf(`
    SCHEMA t;
    ENTITY base; a : OPTIONAL REAL; b : INTEGER; END_ENTITY;
    ENTITY mid SUBTYPE OF (base); SELF\\base.a : NUMBER; END_ENTITY;
    ENTITY sub SUBTYPE OF (mid); SELF\\base.a : positive; DERIVE SELF\\base.b : INTEGER := 1; END_ENTITY;
    END_SCHEMA;`);
  const [a, b] = s.instanceAttributes('SUB');
  assert.deepEqual(a, { name: 'a', owner: 'BASE', type: 'POSITIVE', optional: false, derived: false });
  assert.deepEqual(b, { name: 'b', owner: 'BASE', type: 'INTEGER', optional: false, derived: true });
  assert.equal(s.instanceAttributes('MID')[0]!.type, 'NUMBER');
  assert.equal(s.instanceAttributes('BASE')[0]!.optional, true);
});

test('AP242: complex unit instance partials, SI_UNIT makes NAMED_UNIT.dimensions derived', async () => {
  const s = await loadSchema('ap242');
  // #1=(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.));
  const members = ['LENGTH_UNIT', 'NAMED_UNIT', 'SI_UNIT'];
  assert.deepEqual(s.partialAttributes('LENGTH_UNIT', members), []);
  assert.deepEqual(s.partialAttributes('NAMED_UNIT', members).map((a) => a.derived), [true]);
  assert.deepEqual(s.partialAttributes('SI_UNIT', members).map((a) => a.name), ['prefix', 'name']);
  // Without SI_UNIT, dimensions is explicit.
  const cbu = ['CONVERSION_BASED_UNIT', 'NAMED_UNIT', 'PLANE_ANGLE_UNIT'];
  assert.deepEqual(s.partialAttributes('NAMED_UNIT', cbu).map((a) => a.derived), [false]);
});

test('AP242: B_SPLINE_CURVE_WITH_KNOTS layout', async () => {
  const s = await loadSchema('ap242');
  assert.deepEqual(s.instanceAttributes('b_spline_curve_with_knots').map((a) => a.name), [
    'name', 'degree', 'control_points_list', 'curve_form', 'closed_curve', 'self_intersect',
    'knot_multiplicities', 'knots', 'knot_spec',
  ]);
});

test('FILE_SCHEMA names map to dictionaries', () => {
  const cases: [string, string | undefined][] = [
    ['CONFIG_CONTROL_DESIGN', 'ap203'],
    ["AP203_CONFIGURATION_CONTROLLED_3D_DESIGN_OF_MECHANICAL_PARTS_AND_ASSEMBLIES_MIM_LF { 1 0 10303 403 2 1 "
      + "2}", 'ap203e2'],
    ['CONFIGURATION_CONTROL_3D_DESIGN_ED2_MIM_LF { 1 0 10303 403 1 1 4}', 'ap203e2'],
    ['AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }', 'ap214e3'],
    ['automotive_design', 'ap214e3'],
    ['AUTOMOTIVE_DESIGN_CC2 { 1 2 10303 214 -1 1 5 4 }', 'ap214e3'],
    ['AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF {1 0 10303 442 4 1 4}', 'ap242'],
    ['STRUCTURAL_ANALYSIS_DESIGN', undefined],
    ['CCD_CLA_GVP_AST', undefined],
  ];
  for (const [name, id] of cases) assert.equal(dictionaryForSchemaName(name), id, name);
  assert.equal(dictionaryForFileSchema(['GEOMETRIC_VALIDATION_PROPERTIES_MIM', 'CONFIG_CONTROL_DESIGN']), 'ap203');
});
