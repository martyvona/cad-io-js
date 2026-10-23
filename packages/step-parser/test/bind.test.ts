import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema, type SchemaDictionary } from 'step-schemas';
import { openModel, parseStep, readJson, StepModel, writeJson, fileDocument, type Value } from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const parse = (s: string) => parseStep(enc.encode(s));
const file = (schema: string, data: string) =>
  parse(`ISO-10303-21;HEADER;FILE_SCHEMA((${schema ? `'${schema}'` : ''}));ENDSEC;DATA;\n${data}\nENDSEC;`
    + `END-ISO-10303-21;`);
const messages = (b: { diagnostics: { severity: string; message: string }[] }) => b.diagnostics.map(
  (d) => `${d.severity}: ${d.message}`);

const AP214 = 'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }';
const DATA = `#1=CARTESIAN_POINT('origin',(0.,-1.5,1.));
#2=DIRECTION('',(0.,0.,1.));
#3=AXIS2_PLACEMENT_3D('',#1,#2,$);
#4=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#5=COORDINATES_LIST('',2,((0.,0.,0.),(1.,0.,0.)));
#6=MYSTERY_ENTITY(1);
#7=DIRECTION('',(0.,1.),3);
#8=(CONVERSION_BASED_UNIT('INCH',#9)LENGTH_UNIT()NAMED_UNIT(#10));
#9=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#4);
#10=DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);
#11=VECTOR('',#2,1.);
#12=LINE('',#1,#11);`;

test('openModel: dictionary from FILE_SCHEMA, AP242 fallback, no dictionary', async () => {
  const m = await openModel(file(AP214, DATA));
  assert.equal(m.schema?.name, 'AUTOMOTIVE_DESIGN');
  assert.equal(m.fallback?.name, 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF');
  assert.deepEqual(m.diagnostics, []);
  const ap242 = await openModel(file('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }', DATA));
  assert.equal(ap242.fallback, undefined); // it would be the same dictionary
  const none = await openModel(file('STRUCTURAL_ANALYSIS_DESIGN', DATA));
  assert.equal(none.schema, undefined);
  assert.deepEqual(messages(none),
    ["warning: no dictionary for FILE_SCHEMA ('STRUCTURAL_ANALYSIS_DESIGN'); binding with "
    + "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF"]);
  assert.equal(none.bind(0).schema, none.fallback);
  const bare = await openModel(file('', DATA), { fallback: null });
  assert.deepEqual(messages(bare), ['warning: no dictionary for FILE_SCHEMA (none)']);
  assert.deepEqual(messages(bare.bind(0)), ['warning: unknown entity CARTESIAN_POINT']);
});

test('bind: names, qualified names, complex instances, the tolerance policy', async () => {
  const m = await openModel(file(AP214, DATA));
  const p = (id: number) => m.resolve(id);
  const pt = m.bind(p(1), { check: true });
  assert.equal(pt.schema, m.schema);
  assert.deepEqual(pt.types, ['CARTESIAN_POINT']);
  assert.deepEqual(pt.attributes!.map((a) => `${a.slot.owner}.${a.slot.name}`),
    ['REPRESENTATION_ITEM.name', 'CARTESIAN_POINT.coordinates']);
  assert.deepEqual(pt.get('coordinates'), { k: 'reals', v: [0, -1.5, 1] });
  assert.deepEqual(pt.get('representation_item.name'), { k: 'str', v: 'origin' });
  assert.equal(pt.get('nothing'), undefined);
  assert.deepEqual(pt.diagnostics, []);
  assert.deepEqual(messages(m.bind(p(3), { check: true })), []); // optional ref_direction is $

  // A complex instance: each partial's own attributes, with SI_UNIT making NAMED_UNIT.dimensions derived.
  const unit = m.bind(p(4), { check: true });
  assert.deepEqual(unit.types, ['LENGTH_UNIT', 'NAMED_UNIT', 'SI_UNIT']);
  assert.deepEqual(unit.attributes!.map((a) => [a.record, a.slot.name, a.slot.derived]), [
    ['NAMED_UNIT', 'dimensions', true], ['SI_UNIT', 'prefix', false], ['SI_UNIT', 'name', false],
  ]);
  assert.deepEqual(unit.get('prefix'), { k: 'enum', v: 'MILLI' });
  assert.deepEqual(unit.diagnostics, []);

  // AP214 derives NAMED_UNIT.dimensions for CONVERSION_BASED_UNIT, but writers give a value.
  assert.deepEqual(messages(m.bind(p(8), { check: true })),
    ['warning: NAMED_UNIT.dimensions: value where the schema derives the attribute (*)']);
  // An AP242 entity in an AP214 file binds with the fallback.
  const cl = m.bind(p(5), { check: true });
  assert.equal(cl.schema, m.fallback);
  assert.deepEqual(messages(cl),
    ['info: COORDINATES_LIST not in AUTOMOTIVE_DESIGN; bound with AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF']);
  assert.deepEqual(cl.get('position_coords'),
    { k: 'list', v: [{ k: 'reals', v: [0, 0, 0] }, { k: 'reals', v: [1, 0, 0] }] });
  // Unknown entities and wrong attribute counts stay positional.
  const unknown = m.bind(p(6));
  assert.equal(unknown.attributes, undefined);
  assert.equal(unknown.get('x'), undefined);
  assert.deepEqual(messages(unknown), ['warning: unknown entity MYSTERY_ENTITY']);
  assert.deepEqual(messages(m.bind(p(7))), ['warning: DIRECTION: 3 attributes, schema has 2']);
  const short = (await openModel(file(AP214, `#1=DIRECTION('');`))).bind(0);
  assert.deepEqual([short.attributes, messages(short)],
    [undefined, ['warning: DIRECTION: 1 attributes, schema has 2']]);
  // Without check, only the structural problems are reported.
  assert.deepEqual(messages(m.bind(p(8))), messages(m.bind(p(8), { check: true })));

  // AP242 doesn't derive it, so there `*` is the problem. Partials out of order are noted.
  const m242 = await openModel(
    file('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF',
    `#8=(NAMED_UNIT(*)LENGTH_UNIT()CONVERSION_BASED_UNIT('INCH',#9));`
    + `\n#9=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#4);`));
  assert.deepEqual(messages(m242.bind(0)),
    ["info: partials not in alphabetical order", "warning: NAMED_UNIT.dimensions: * but the attribute isn't derived"]);
});

test('types, isInstanceOf, instancesOf, referrers', async () => {
  const m = await openModel(file(AP214,
    DATA + `\n#13=LINE('',#1,#11);\n#14=EDGE_CURVE('',#99,#1,#12,.T.);\n#15=POLYLINE('',(#1,#2,#1));`));
  const p = (id: number) => m.resolve(id);
  assert.deepEqual(m.types(p(8)), ['CONVERSION_BASED_UNIT', 'LENGTH_UNIT', 'NAMED_UNIT']);
  assert.ok(m.isInstanceOf(p(1), 'point'));
  assert.ok(m.isInstanceOf(p(1), 'REPRESENTATION_ITEM'));
  assert.ok(!m.isInstanceOf(p(1), 'DIRECTION'));
  assert.ok(m.isInstanceOf(p(8), 'NAMED_UNIT') && m.isInstanceOf(p(4), 'SI_UNIT'));
  assert.ok(m.isInstanceOf(p(5), 'REPRESENTATION_ITEM')); // via the fallback
  assert.ok(m.isInstanceOf(p(6), 'MYSTERY_ENTITY') && !m.isInstanceOf(p(6), 'REPRESENTATION_ITEM'));
  const ids = (ps: Uint32Array) => [...ps].map((q) => m.file.index.ids[q]);
  assert.deepEqual(ids(m.instancesOf('named_unit')), [4, 8]);
  assert.deepEqual(ids(m.instancesOf('CURVE')), [12, 13, 15]);
  // #5 through the fallback
  assert.deepEqual(ids(m.instancesOf('GEOMETRIC_REPRESENTATION_ITEM')), [1, 2, 3, 5, 7, 11, 12, 13, 14, 15]);
  assert.deepEqual(ids(m.instancesOf('TOPOLOGICAL_REPRESENTATION_ITEM')), [14]);
  assert.deepEqual(ids(m.instancesOf('MYSTERY_ENTITY')), [6]);
  assert.deepEqual(ids(m.instancesOf('NOTHING')), []);
  // Distinct referrers in file order; the dangling #99 is left out, and #15's two references to #1 count once.
  assert.deepEqual(ids(m.referrers(p(1))), [3, 12, 13, 14, 15]);
  assert.deepEqual(ids(m.referrers(p(2))), [3, 11, 15]);
  assert.deepEqual(ids(m.referrers(p(14))), []);
  assert.deepEqual(messages(m.bind(p(14), { check: true })), [
    'warning: EDGE.edge_start: dangling reference',
    'warning: EDGE.edge_end: reference to CARTESIAN_POINT, expected VERTEX',
  ]);
});

// A small dictionary that exercises every check.
const dict: SchemaDictionary = {
  format: 1, schema: 'TEST', source: { file: 'test', sha256: '' },
  entities: {
    BASE: { supertypes: [], attrs: [{ name: 'name', type: 'STRING' }] },
    THING: {
      supertypes: ['BASE'],
      attrs: [
        { name: 'i', type: 'INTEGER' }, { name: 'r', type: 'REAL' }, { name: 'n', type: 'NUMBER' },
        { name: 'b', type: 'BINARY' },
        { name: 'bool', type: 'BOOLEAN' }, { name: 'lg', type: 'LOGICAL' }, { name: 'e', type: 'COLOUR' },
        { name: 'len', type: 'LENGTH' },
        { name: 's', type: 'MEASURE_OR_BASE' }, { name: 'pts', type: { agg: 'LIST', lo: 2, hi: 3, of: 'REAL' } },
        { name: 'refs', type: { agg: 'SET', lo: 1, hi: null, of: 'BASE' } },
        { name: 'opt', type: 'INTEGER', optional: true },
        { name: 'holes', type: { agg: 'ARRAY', lo: 1, hi: 2, of: 'INTEGER', optional: true } },
      ],
    },
    OTHER: { supertypes: [], attrs: [{ name: 'name', type: 'STRING' }] },
    TWIN: { supertypes: ['BASE', 'OTHER'], attrs: [] },
  },
  types: {
    COLOUR: { kind: 'enum', values: ['RED', 'GREEN'] },
    LENGTH: { kind: 'defined', type: 'REAL' },
    POSITIVE_LENGTH: { kind: 'defined', type: 'LENGTH' },
    MEASURE_OR_BASE: { kind: 'select', items: ['LENGTH', 'INNER_SELECT'] },
    INNER_SELECT: { kind: 'select', items: ['BASE', 'COLOUR'] },
  },
};

test('value checks against declared types', () => {
  const good = `#1=THING('t',1,2.,3,"0F",.T.,.U.,.RED.,4.,LENGTH(5.),(1.,2.),(#2,#3),$,(1,$));\n#2=BASE('b');`
    + `\n#3=TWIN('w','v');\n#4=OTHER('o');`;
  const m = new StepModel(file('TEST', good), new Schema(dict));
  assert.deepEqual(messages(m.bind(0, { check: true })), []);
  // Each variation of #1 and the problems it should report.
  const cases: [string, string[]][] = [
    ["THING('t',1.,2,3.,'x',.U.,.X.,.BLUE.,LENGTH(4.),5.,(1.),(#4),7,(1,2,3))", [
      'THING.i: expected INTEGER, got a real', 'THING.r: expected REAL, got an integer',
      'THING.b: expected BINARY, got a string',
      'THING.bool: expected BOOLEAN, got .U.', 'THING.lg: expected LOGICAL, got .X.',
      'THING.e: .BLUE. is not a COLOUR value',
      'THING.len: typed parameter LENGTH(...) where a plain value is expected (only SELECT values are typed)',
      'THING.s: a real without a type name in SELECT MEASURE_OR_BASE', 'THING.pts: LIST of 1 elements, expected [2:3]',
      'THING.refs: reference to OTHER, expected BASE', 'THING.holes: ARRAY of 3 elements, expected [1:2]',
    ]],
    ["THING($,'1',2.,.T.,\"0F\",.T.,.U.,'RED',4.,COLOUR(.GREEN.),(1.,'a'),(#2,#99),$,(1,2))", [
      'BASE.name: $ in a mandatory attribute', 'THING.i: expected INTEGER, got a string',
      'THING.n: expected NUMBER, got .T.',
      'THING.e: expected COLOUR, got a string', 'THING.pts: expected REAL, got a string',
      'THING.refs: dangling reference',
    ]],
    // a specialization of LENGTH
    ["THING('t',1,2.,3,\"0F\",.T.,.U.,.RED.,4.,POSITIVE_LENGTH(5.),(1.,2.),(#2),$,(1,2))", []],
    ["THING('t',1,2.,3,\"0F\",.T.,.U.,.RED.,4.,#2,(1.,2.),(#2),$,(1,2))", []], // an entity through the inner SELECT
    ["THING('t',1,2.,3,\"0F\",.T.,.U.,.RED.,4.,COLOUR(.BLUE.),(1.,2.),(#2),$,(1,2))",
      ['THING.s: .BLUE. is not a COLOUR value']],
    ["THING('t',1,2.,3,\"0F\",.T.,.U.,.RED.,4.,#4,(1.,2.),(#2),$,(1,2))",
      ['THING.refs: reference to OTHER, expected SELECT MEASURE_OR_BASE'.replace('THING.refs', 'THING.s')]],
    ["THING('t',1,2.,3,\"0F\",.T.,.U.,.RED.,4.,REAL(1.),(1.,2.),(#2),$,(1,*))", [
      'THING.s: typed parameter REAL(...) is not in SELECT MEASURE_OR_BASE', 'THING.holes: * inside a value',
    ]],
    ["THING('t',1,2.,3,\"0F\",.T.,.U.,.RED.,4.,(1.),(1.,2.),(),$,(1,2))", [
      'THING.s: expected SELECT MEASURE_OR_BASE, got a list', 'THING.refs: SET of 0 elements, expected [1:?]',
    ]],
    ["THING('t',1,2.,3,\"0F\",.T.,.U.,.RED.,4.,#2,(1.,2.),(#2,$),$,(1,2))", ['THING.refs: $ in SET']],
  ];
  for (const [inst, expected] of cases) {
    const mm = new StepModel(file('TEST', `#1=${inst};\n#2=BASE('b');\n#3=TWIN('w','v');\n#4=OTHER('o');`),
      new Schema(dict));
    const b = mm.bind(0, { check: true });
    assert.deepEqual(b.diagnostics.map((d) => d.message), expected, inst);
    assert.ok(b.diagnostics.every(
      (d) => d.severity === (d.message.includes('mandatory') ? 'info' : 'warning') && d.id === 1));
  }
  // A name declared by two supertypes is ambiguous unless qualified.
  const twin = m.bind(2);
  assert.throws(() => twin.get('name'), /ambiguous/);
  assert.deepEqual([twin.get('BASE.name'), twin.get('other.name')],
    [{ k: 'str', v: 'w' }, { k: 'str', v: 'v' }] as Value[]);
});

test('raw JSON with attribute names; the loader ignores them', async () => {
  const f = file(AP214, DATA);
  const m = await openModel(f);
  const json = writeJson(fileDocument(f), { names: (inst) => m.attributeNames(inst) });
  const lines = dec.decode(json).split('\n');
  assert.ok(lines.includes('{"id":1,"type":"CARTESIAN_POINT","names":["name","coordinates"],"attrs":["origin",[0.0,'
    + '-1.5,1.0]]},'));
  assert.ok(lines.includes('{"id":4,"parts":[{"type":"LENGTH_UNIT","names":[],"attrs":[]},{"type":"NAMED_UNIT",'
    + '"names":["dimensions"],"attrs":[{"derived":true}]},{"type":"SI_UNIT","names":["prefix","name"],'
    + '"attrs":[{"enum":"MILLI"},{"enum":"METRE"}]}]},'));
  assert.ok(lines.includes('{"id":6,"type":"MYSTERY_ENTITY","attrs":[1]},')); // unbound: no names
  assert.deepEqual(readJson(json), readJson(writeJson(fileDocument(f))));
});
