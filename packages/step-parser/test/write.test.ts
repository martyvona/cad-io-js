import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeString, fileDocument, formatInstance, formatReal, formatString, formatValue, makeHeader, parseStep, writeChunks,
  writeStep, WriteError, type Instance, type StepFile, type Value,
} from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const parse = (s: string) => parseStep(enc.encode(s));
const instances = (f: StepFile) => [...f.instances((p, e) => assert.fail(`#${p}: ${e.message}`))];

const FILE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('a test'),'2;1');
FILE_NAME('t.stp','2026-10-17T00:00:00',('me'),(''),'pp','sys','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('origin',(0.,-1.5,1.E-07));
#2 = DIRECTION ( '' , ( 0. , 0. , 1. ) ) ; /* comment */
#3=AXIS2_PLACEMENT_3D('',#1,#2,$);
#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#11=MEASURE_REPRESENTATION_ITEM('m',LENGTH_MEASURE(5.),#10);
#12=EVERYTHING(12,-7,+3,1E5,"0FF",.T.,(),((1,2),(#3)),A(B(1)),'#5 is not a ref',*,9007199254740993,-0.);
#13=PRODUCT('Bob's part','\\X2\\00C4\\X0\\rger \\S\\Drger C:\\temp \\X4\\0001F7CA\\X0\\','line\\N\\two',$);
#14=EDGE_CURVE('',#1,#1,#0, );
#15=!USER_THING(1);
ENDSEC;
END-ISO-10303-21;
`;

test('formatReal: a decimal point always, exact round trip', () => {
  const cases: [number, string][] = [
    [5, '5.'], [0, '0.'], [-0, '-0.'], [0.25, '0.25'], [-1.5, '-1.5'], [1e-7, '1.E-7'], [1.5e-7, '1.5E-7'],
    [1e21, '1.E21'], [123456789012345680000, '123456789012345680000.'], [5e-324, '5.E-324'],
    [Number.MAX_VALUE, '1.7976931348623157E308'],
  ];
  for (const [x, s] of cases) assert.equal(formatReal(x), s);
  for (const x of [NaN, Infinity, -Infinity]) assert.throws(() => formatReal(x), WriteError);

  // Random doubles over the whole range, by bit pattern, read back through the parser.
  const bits = new Float64Array(1);
  const words = new Uint32Array(bits.buffer);
  let seed = 12345;
  const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  const values: Value[] = [];
  while (values.length < 20000) {
    words[0] = rand();
    words[1] = rand();
    if (Number.isFinite(bits[0]!)) values.push({ k: 'real', v: bits[0]! });
  }
  const f = parse(`ISO-10303-21;HEADER;ENDSEC;DATA;${formatInstance({ id: 1, type: 'R', attrs: values })}ENDSEC;`
    + `END-ISO-10303-21;`);
  assert.deepEqual((f.instance(1) as { attrs: Value[] }).attrs, values);
});

test('formatString: escapes, and decoding gives the string back', () => {
  assert.equal(formatString('plain'), "'plain'");
  assert.equal(formatString("it's C:\\x"), "'it''s C:\\\\x'");
  assert.equal(formatString('\u00C4rger \u03C0'), "'\\X2\\00C4\\X0\\rger \\X2\\03C0\\X0\\'");
  assert.equal(formatString('\u03B1\u03B2'), "'\\X2\\03B103B2\\X0\\'");
  assert.equal(formatString('a\u{1F7CA}\u{1F80A}\u00E9'), "'a\\X4\\0001F7CA0001F80A\\X0\\\\X2\\00E9\\X0\\'");
  assert.equal(formatString('a\nb\t'), "'a\\X2\\000A\\X0\\b\\X2\\0009\\X0\\'");
  assert.equal(formatString('\uD83D'), "'\\X2\\D83D\\X0\\'"); // a lone surrogate survives as a UTF-16 code unit

  const pool = ["'", '\\', 'a', ' ', ',', ')', '\n', '\r', '\u0000', '\u007f', '\u00E9', '\u0416', '\uffff',
    '\u{1F600}', '\uDC00', 'X', '0'];
  let seed = 7;
  const rand = (n: number) => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n;
  for (let t = 0; t < 5000; t++) {
    let s = '';
    for (let n = rand(12); n > 0; n--) s += pool[rand(pool.length)];
    const lit = formatString(s);
    assert.match(lit, /^[\x20-\x7e]*$/);
    assert.equal(decodeString(enc.encode(lit + ')'), 0)?.value, s, JSON.stringify(s));
  }
});

test('formatValue: every kind, and values Part 21 cannot hold', () => {
  assert.equal(formatValue({ k: 'list', v: [
    { k: 'int', v: -3 }, { k: 'int', v: 2n ** 70n }, { k: 'int', v: 1e21 }, { k: 'enum', v: 'T' }, { k: 'ref', v: 7 },
    { k: 'bin', v: '0FF' }, { k: 'unset' }, { k: 'derived' }, { k: 'list', v: [] },
    { k: 'typed', type: 'LENGTH_MEASURE', v: { k: 'real', v: 2 } },
  ] }), '(-3,1180591620717411303424,1000000000000000000000,.T.,#7,"0FF",$,*,(),LENGTH_MEASURE(2.))');
  const bad: Value[] = [
    { k: 'int', v: 1.5 }, { k: 'real', v: NaN }, { k: 'enum', v: 'A B' }, { k: 'ref', v: -1 }, { k: 'bin', v: 'xyz' },
    { k: 'typed', type: '1BAD', v: { k: 'unset' } },
  ];
  for (const v of bad) assert.throws(() => formatValue(v), WriteError, JSON.stringify(v));
  assert.throws(() => formatInstance({ id: 9, type: 'P', attrs: [{ k: 'real', v: Infinity }] }),
    /^WriteError: #9: real/);
  assert.throws(() => formatInstance({ id: 9, parts: [] }), WriteError);
});

test('round trip: parse -> write -> parse gives the same model (A == C)', () => {
  const a = parse(FILE);
  const out = writeStep(fileDocument(a));
  assert.match(dec.decode(out), /^[\x20-\x7e\n]*$/);
  const c = parseStep(out);
  assert.deepEqual(c.diagnostics, []);
  assert.deepEqual(c.header, a.header);
  assert.deepEqual(instances(c), instances(a));
  // Rewriting the rewritten file is a fixed point, byte for byte.
  assert.deepEqual(writeStep(fileDocument(c)), out);
  assert.equal(dec.decode(out).split('\n').find((l) => l.startsWith('#13=')),
    "#13=PRODUCT('Bob''s part','\\X2\\00C4\\X0\\rger \\X2\\00C4\\X0\\rger C:\\\\temp \\X4\\0001F7CA\\X0\\',"
      + "'line\\X2\\000A\\X0\\two',$);");
  assert.ok(dec.decode(out).includes('\n#14=EDGE_CURVE(\'\',#1,#1,#0,$);\n')); // the empty parameter is written as $
});

test('chunked output, verbatim instances, malformed instances', () => {
  const a = parse(FILE);
  const whole = writeStep(fileDocument(a));
  const chunks = [...writeChunks(fileDocument(a), { chunkSize: 16 })];
  // Text longer than a chunk (the header, long instances) gets a chunk of its own.
  assert.ok(chunks.length > 10 && chunks.every((c) => c.length <= 16 || /^(#|ISO|END)/.test(dec.decode(c))));
  assert.equal(chunks.map((c) => dec.decode(c)).join(''), dec.decode(whole));
  for (let chunkSize = 1; chunkSize <= 256; chunkSize++) {
    assert.equal([...writeChunks(fileDocument(a), { chunkSize })].map((c) => dec.decode(c)).join(''),
      dec.decode(whole));
  }

  // The subset fast path: copy source bytes, comments and spacing included.
  const doc = { header: a.header, data: [{ instances: [a.sourceBytesAt(1), a.sourceBytesAt(0)] }] };
  for (const chunkSize of [8, 65536]) {
    const text = dec.decode(writeStep(doc, { chunkSize }));
    assert.ok(text.includes("DATA;\n#2 = DIRECTION ( '' , ( 0. , 0. , 1. ) ) ;\n#1=CARTESIAN_POINT('origin',(0.,-1.5,"
      + "1.E-07));\nENDSEC;"));
  }

  const broken = parse("ISO-10303-21;HEADER;ENDSEC;DATA;#1=A(1);#2=B(1 2);#3=C(3);ENDSEC;END-ISO-10303-21;");
  const errors: number[] = [];
  assert.deepEqual(instances(parseStep(writeStep(fileDocument(broken, (p) => errors.push(p))))).map(
    (i) => i.id), [1, 3]);
  assert.deepEqual(errors, [1]);
  assert.throws(() => writeStep(fileDocument(broken)), /expected/);
});

test('edition 3 DATA sections, an empty document, makeHeader', () => {
  const a = parse(`ISO-10303-21;HEADER;FILE_SCHEMA(('A','B'));ENDSEC;
DATA('first',('A'));#1=P(#2);ENDSEC;DATA('it''s',('B'));#2=Q(1);#3=Q(2);ENDSEC;END-ISO-10303-21;`);
  const out = dec.decode(writeStep(fileDocument(a)));
  assert.ok(out.includes("DATA('first',('A'));\n#1=P(#2);\nENDSEC;\nDATA('it''s',('B'));\n"));
  const c = parse(out);
  assert.deepEqual(c.dataSections, a.dataSections);
  assert.deepEqual(instances(c), instances(a));

  const header = makeHeader({ name: 'sub.stp', timeStamp: '2026-10-17T12:00:00',
    schemas: ['AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF'] });
  const empty: Instance[] = [];
  assert.equal(dec.decode(writeStep({ header, data: [] })), `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('sub.stp','2026-10-17T12:00:00',(''),(''),'','','');
FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF'));
ENDSEC;
DATA;
ENDSEC;
END-ISO-10303-21;
`);
  const f = parse(dec.decode(writeStep({ header, data: [{ instances: empty }] })));
  assert.deepEqual(f.diagnostics, []);
  assert.deepEqual(f.schemaNames, ['AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF']);
});
