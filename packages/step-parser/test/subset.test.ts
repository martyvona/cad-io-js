import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSubset, closure, parseStep, type StepFile } from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const parse = (s: string | Uint8Array) => parseStep(typeof s === 'string' ? enc.encode(s) : s);
const all = (f: StepFile) => new Map([...f.instances()].map((i) => [i.id, i]));

const FILE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('t'),'2;1');
FILE_NAME('t.stp','',(''),(''),'','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
#1=PRODUCT('p','p','',());
#10 = ADVANCED_BREP_SHAPE_REPRESENTATION ( 'body' , ( #11 , #12 ) , #20 ) ; /* the root */
#11=MANIFOLD_SOLID_BREP('',#13);
#12=MAPPED_ITEM('',#15,#17);
#13=CLOSED_SHELL('',(#14,#99));
#14=CARTESIAN_POINT('',(1.,2.,3.));
#15=REPRESENTATION_MAP(#17,#16);
#16=SHAPE_REPRESENTATION('other',(#18),#20);
#17=AXIS2_PLACEMENT_3D('',#14,$,$);
#18=CARTESIAN_POINT('',(4.,5.,6.));
#20=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#21))REPRESENTATION_CONTEXT('',''));
#21=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#30=STYLED_ITEM('',(),#11);
ENDSEC;
END-ISO-10303-21;
`;

test('closure: everything the root references, in file order, nothing that references it', () => {
  const f = parse(FILE);
  const ids = (ps: Uint32Array) => [...ps].map((p) => f.index.ids[p]);
  assert.deepEqual(ids(closure(f, [f.index.position(10)])), [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21]);
  assert.deepEqual(ids(closure(f, [f.index.position(10)], new Set([f.index.position(12)]))), [10, 11, 13, 14, 20, 21]);
});

test('subsets: verbatim bytes, a root rewritten without excluded items, missing references, the wrapper', () => {
  const f = parse(FILE);
  const source = all(f);
  const root = f.index.position(10);

  const whole = buildSubset(f, [root]);
  const text = dec.decode(whole.bytes);
  assert.ok(text.includes("\n#10 = ADVANCED_BREP_SHAPE_REPRESENTATION ( 'body' , ( #11 , #12 ) , #20 ) ;\n")); // as written
  assert.ok(text.startsWith("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('t'),'2;1');\n"));
  assert.deepEqual(whole.missing, [99]); // dangling in the source too
  const parsed = parse(whole.bytes);
  assert.deepEqual(parsed.diagnostics, []);
  for (const [id, inst] of all(parsed)) assert.deepEqual(inst, source.get(id));

  // Leaving out the mapped item: the root loses it, its closure goes, and nothing new is missing.
  const bare = buildSubset(f, [root], { exclude: new Set([f.index.position(12)]) });
  const b = all(parse(bare.bytes));
  assert.deepEqual([...b.keys()], [10, 11, 13, 14, 20, 21]);
  assert.deepEqual(b.get(10), { id: 10, type: 'ADVANCED_BREP_SHAPE_REPRESENTATION', attrs: [{ k: 'str', v: 'body' }, { k: 'refs', v: [11] }, { k: 'ref', v: 20 }] });
  assert.deepEqual(bare.missing, [99]);
  // An excluded instance that something else in the closure still needs stays missing.
  const shared = buildSubset(f, [root], { exclude: new Set([f.index.position(14)]) });
  assert.deepEqual(shared.missing, [14, 99]);

  // The wrapper: 8 entities above the largest id, the SHAPE_DEFINITION_REPRESENTATION pointing at the root.
  const wrapped = all(parse(buildSubset(f, [root], { wrapper: true }).bytes));
  assert.deepEqual([...wrapped.keys()].filter((id) => id > 99), [100, 101, 102, 103, 104, 105, 106, 107]);
  assert.deepEqual(wrapped.get(107), { id: 107, type: 'SHAPE_DEFINITION_REPRESENTATION', attrs: [{ k: 'ref', v: 106 }, { k: 'ref', v: 10 }] });
});
