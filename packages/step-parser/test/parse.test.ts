import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { formatReal, listItems, makeList, ParseError, parseStep, TYPED_ARRAY_MIN, readStep, type Diagnostic, type Instance, type Value } from '../src/index.ts';

const enc = new TextEncoder();
const parse = (s: string) => parseStep(enc.encode(s));

const FILE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('a test'),'2;1');
FILE_NAME('t.stp','2026-10-17T00:00:00',('me'),(''),'pp','sys','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('origin',(0.,-1.5,1.E-07));
#2 = DIRECTION ( '' , ( 0. , 0. , 1. ) ) ;
/* a comment with #99 and ' in it */
#3=AXIS2_PLACEMENT_3D('',#1,#2,$);
#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#11=MEASURE_REPRESENTATION_ITEM('m',LENGTH_MEASURE(5.),#10);
#12=EVERYTHING(12,-7,+3,1E5,"0FF",.T.,(),((1,2),(#3)),A(B(1)),'#5 is not a ref',*,9007199254740993);
ENDSEC;
END-ISO-10303-21;
`;

test('header, lookup and value kinds', () => {
  const f = parse(FILE);
  assert.deepEqual(f.diagnostics, []);
  assert.equal(f.count, 6);
  assert.deepEqual(f.schemaNames, ['AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }']);
  assert.deepEqual(f.header.map((h) => h.type), ['FILE_DESCRIPTION', 'FILE_NAME', 'FILE_SCHEMA']);
  assert.deepEqual(f.headerEntity('FILE_DESCRIPTION')!.attrs[1], { k: 'str', v: '2;1' });

  assert.deepEqual(f.instance(1), {
    id: 1, type: 'CARTESIAN_POINT',
    attrs: [{ k: 'str', v: 'origin' }, { k: 'reals', v: [0, -1.5, 1e-7] }],
  });
  assert.equal((f.instance(2) as { type: string }).type, 'DIRECTION');
  assert.deepEqual(f.instance(3), {
    id: 3, type: 'AXIS2_PLACEMENT_3D',
    attrs: [{ k: 'str', v: '' }, { k: 'ref', v: 1 }, { k: 'ref', v: 2 }, { k: 'unset' }],
  });
  assert.deepEqual(f.instance(10), {
    id: 10,
    parts: [
      { type: 'LENGTH_UNIT', attrs: [] },
      { type: 'NAMED_UNIT', attrs: [{ k: 'derived' }] },
      { type: 'SI_UNIT', attrs: [{ k: 'enum', v: 'MILLI' }, { k: 'enum', v: 'METRE' }] },
    ],
  });
  assert.deepEqual((f.instance(11) as { attrs: unknown[] }).attrs[1], { k: 'typed', type: 'LENGTH_MEASURE', v: { k: 'real', v: 5 } });
  assert.deepEqual((f.instance(12) as { attrs: unknown[] }).attrs, [
    { k: 'int', v: 12 }, { k: 'int', v: -7 }, { k: 'int', v: 3 }, { k: 'real', v: 1e5 }, { k: 'bin', v: '0FF' },
    { k: 'enum', v: 'T' }, { k: 'list', v: [] },
    { k: 'list', v: [{ k: 'ints', v: [1, 2] }, { k: 'refs', v: [3] }] },
    { k: 'typed', type: 'A', v: { k: 'typed', type: 'B', v: { k: 'int', v: 1 } } },
    { k: 'str', v: '#5 is not a ref' }, { k: 'derived' }, { k: 'int', v: 9007199254740993n },
  ]);
  assert.equal(f.instance(4), undefined);
});

test('canonical lists: kinds and storage', () => {
  const n = TYPED_ARRAY_MIN;
  const reals = (k: number) => Array.from({ length: k }, (_, i) => (i ? i / 4 : -0));
  const ints = (k: number, big = 0) => Array.from({ length: k }, (_, i) => (i === k - 1 ? big || i : i));
  const text = (xs: (number | string)[]) => `(${xs.join(',')})`;
  const f = parse(`ISO-10303-21;HEADER;ENDSEC;DATA;
#1=X(${text(reals(n - 1).map(formatReal))},${text(reals(n).map(formatReal))});
#2=X(${text(ints(n - 1))},${text(ints(n))},${text(ints(n, 2 ** 31))},${text(ints(n, 2 ** 60))});
#3=X(${text(ints(n - 1).map((i) => '#' + i))},${text(ints(n, 4294967295).map((i) => '#' + i))});
#4=X((1,2.),(#1,$),(.T.),('a'),(),((1.)));
ENDSEC;END-ISO-10303-21;`);
  const attrs = (id: number) => (f.instance(id) as { attrs: Value[] }).attrs;
  const [r0, r1] = attrs(1) as Extract<Value, { k: 'reals' }>[];
  assert.ok(Array.isArray(r0!.v) && r1!.v instanceof Float64Array);
  assert.deepEqual([...r1!.v], reals(n));
  assert.ok(Object.is(r1!.v[0], -0) && Object.is(r0!.v[0], -0));
  const [i0, i1, i2, i3] = attrs(2);
  assert.ok(i0!.k === 'ints' && Array.isArray(i0.v));
  assert.ok(i1!.k === 'ints' && i1.v instanceof Int32Array);
  assert.ok(i2!.k === 'ints' && i2.v instanceof Float64Array && i2.v[n - 1] === 2 ** 31);
  assert.equal(i3!.k, 'list'); // contains a bigint
  const [f0, f1] = attrs(3);
  assert.ok(f0!.k === 'refs' && Array.isArray(f0.v));
  assert.ok(f1!.k === 'refs' && f1.v instanceof Uint32Array && f1.v[n - 1] === 4294967295);
  assert.deepEqual(attrs(4).map((v) => v.k), ['list', 'list', 'list', 'list', 'list', 'list']);
  assert.deepEqual(attrs(4)[5], { k: 'list', v: [{ k: 'reals', v: [1] }] });
  // makeList and listItems are inverses on canonical lists.
  for (const id of [1, 2, 3, 4]) {
    for (const v of attrs(id)) {
      if (v.k === 'list' || v.k === 'reals' || v.k === 'ints' || v.k === 'refs') assert.deepEqual(makeList(listItems(v)), v);
    }
  }
});

test('index: types, references, byte ranges', () => {
  const f = parse(FILE);
  const ix = f.index;
  assert.deepEqual([...ix.ids], [1, 2, 3, 10, 11, 12]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((p) => ix.typeName(p)),
    ['CARTESIAN_POINT', 'DIRECTION', 'AXIS2_PLACEMENT_3D', undefined, 'MEASURE_REPRESENTATION_ITEM', 'EVERYTHING']);
  // References in strings and comments don't count.
  assert.deepEqual([...ix.refsOf(2)], [1, 2]);
  assert.deepEqual([...ix.refsOf(4)], [10]);
  assert.deepEqual([...ix.refsOf(5)], [3]);
  assert.equal(f.sourceAt(1), '#2 = DIRECTION ( \'\' , ( 0. , 0. , 1. ) ) ;');
  assert.ok(ix.idsIncreasing);
});

test('lookup with sparse and unordered ids', () => {
  const body = [9_000_000, 5, 4_000_000_000, 77].map((id) => `#${id}=X(${id});`).join('\n');
  const f = parse(`ISO-10303-21;HEADER;ENDSEC;DATA;${body}ENDSEC;END-ISO-10303-21;`);
  assert.ok(!f.index.idsIncreasing);
  for (const id of [9_000_000, 5, 4_000_000_000, 77]) assert.deepEqual((f.instance(id) as { attrs: unknown[] }).attrs, [{ k: 'int', v: id }]);
  assert.equal(f.instance(6), undefined);
  assert.equal(f.index.position(4_000_000_001), -1);
});

test('lenient lexical forms: lowercase, BOM, CRLF, wrapped strings, comments between tokens', () => {
  const f = parse('﻿ISO-10303-21;\r\nheader;\r\nendsec;\r\ndata;\r\n#1 /*c*/ = /*c*/ product(\'long\r\n name\', /*c*/ \'x\', $, (#2))/*c*/;\r\n#2=product_context(\'\',$,\'\');\r\nendsec;\r\nend-iso-10303-21;');
  assert.deepEqual(f.diagnostics, []);
  const p = f.instance(1) as { type: string; attrs: { v: unknown }[] };
  assert.equal(p.type, 'PRODUCT');
  assert.equal(p.attrs[0]!.v, 'long name');
  assert.equal(f.index.typeName(1), 'PRODUCT_CONTEXT');
});

test('edition 3: several DATA sections with parameters; ANCHOR and REFERENCE sections are skipped', () => {
  const f = parse(`ISO-10303-21;
HEADER; FILE_SCHEMA(('A','B')); ENDSEC;
ANCHOR; <thing>=#1; ENDSEC;
REFERENCE; #50=<http://example.com/x.stp#a>; ENDSEC;
DATA('first',('A')); #1=P(#2); ENDSEC;
DATA('second',('B')); #2=Q(1); #3=Q(2); ENDSEC;
END-ISO-10303-21;`);
  assert.deepEqual(f.dataSections, [
    { name: 'first', schemas: ['A'], first: 0, last: 1 },
    { name: 'second', schemas: ['B'], first: 1, last: 3 },
  ]);
  assert.deepEqual([...f.index.ids], [1, 2, 3]);
  assert.deepEqual(f.diagnostics.map((d) => d.message), [
    '2 DATA sections (edition 3)', 'ANCHOR section ignored', 'REFERENCE section ignored',
  ]);
});

test('problems: duplicates, malformed instances, truncation', () => {
  const f = parse(`ISO-10303-21;HEADER;ENDSEC;DATA;
#1=A(1);
#1=A(2);
#2=EDGE_CURVE('',#1,#1,#0, );
#4=EDGE_CURVE('',#1,#18446744073709551617,#1,.T.);
#3=B('unterminated);
`);
  assert.deepEqual(f.diagnostics.map((d) => [d.message, d.id]), [
    ['reference beyond the largest instance id (2^32 - 1) read as $', 4], ['unterminated string', undefined],
    ['DATA section not closed by ENDSEC', undefined], ['missing END-ISO-10303-21;', undefined], ['duplicate instance id #1', 1],
  ]);
  assert.deepEqual((f.instance(1) as { attrs: unknown[] }).attrs, [{ k: 'int', v: 1 }]); // the first one wins
  // An empty parameter is read as $, with a warning.
  const warnings: Diagnostic[] = [];
  assert.deepEqual((f.instance(2, warnings) as { attrs: unknown[] }).attrs.slice(3), [{ k: 'ref', v: 0 }, { k: 'unset' }]);
  assert.deepEqual(warnings.map((w) => [w.message, w.id]), [['empty parameter read as $', 2]]);
  // A reference too large to be an id (OCCT's bug31292.stp) is read as $, with the scan's warning (above) and none
  // when decoded, and doesn't wrap around to #1 in the index.
  assert.deepEqual([...f.index.refsOf(3)], [1, 1]);
  warnings.length = 0;
  assert.deepEqual((f.instanceAt(3, warnings) as { attrs: unknown[] }).attrs.slice(1, 4), [{ k: 'ref', v: 1 }, { k: 'unset' }, { k: 'ref', v: 1 }]);
  assert.deepEqual(warnings, []);
  assert.throws(() => f.instanceAt(4), (e) => e instanceof ParseError && /unterminated string/.test(e.message));
  const errors: number[] = [];
  const ok: Instance[] = [...f.instances((p) => errors.push(p))];
  assert.equal(ok.length, 4);
  assert.deepEqual(errors, [4]);
});

test('readStep: gzip input and streams', async () => {
  const gz = gzipSync(enc.encode(FILE));
  const f = await readStep(new Uint8Array(gz));
  assert.equal(f.count, 6);
  const stream = new Blob([FILE]).stream();
  assert.equal((await readStep(stream)).count, 6);
});
