import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJson } from 'lexical-json';
import {
  fileDocument, formatValue, instanceJson, jsonChunks, makeList, parseStep, RawJsonError, readJson, TYPED_ARRAY_MIN,
  valueFromJson, valueJson, writeJson, WriteError, writeStep, type Instance, type StepFile, type Value,
} from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const parse = (s: string) => parseStep(enc.encode(s));
const instances = (f: StepFile) => [...f.instances((p, e) => assert.fail(`#${p}: ${e.message}`))];
const long = (n: number, f: (i: number) => string) => `(${Array.from({ length: n }, (_, i) => f(i)).join(',')})`;
// #16's lists: reals, ints, references and ints beyond 32 bits, each long enough for a typed array.
const longReals = long(TYPED_ARRAY_MIN, (i) => `${i}.5`), longInts = long(TYPED_ARRAY_MIN, (i) => String(i * 1000));
const longRefs = long(TYPED_ARRAY_MIN, (i) => `#${i}`), longBig = long(TYPED_ARRAY_MIN, (i) => String(i * 2 ** 40));

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
#12=EVERYTHING(12,-7,+3,1E5,"0FF",.T.,(),((1,2),(#3)),A(B(1)),'#5 is not a ref',*,9007199254740993,-0.,(1,2.,#3,$),(-0.,5.));
#13=PRODUCT('Bob's part','\\X2\\00C4\\X0\\rger \\S\\Drger C:\\temp \\X4\\0001F7CA\\X0\\','line\\N\\two',$);
#14=EDGE_CURVE('',#1,#1,#0, );
#15=!USER_THING(1);
#16=BIG(${longReals},${longInts},${longRefs},${longBig});
ENDSEC;
END-ISO-10303-21;
`;

test('A ≡ B ≡ C: parse → JSON → load → Part 21 → parse', () => {
  const a = parse(FILE);
  const json = writeJson(fileDocument(a));
  const b = readJson(json);
  assert.deepEqual(b.header, a.header);
  assert.deepEqual(b.data.map((d) => d.instances), [instances(a)]);
  const c = parseStep(writeStep(b));
  assert.deepEqual(c.diagnostics, []);
  assert.deepEqual(c.header, a.header);
  assert.deepEqual(instances(c), instances(a));
  // Writing B again gives the same bytes, and the output is standard JSON too.
  assert.deepEqual(writeJson(b), json);
  JSON.parse(dec.decode(json));
});

test('the document layout, one instance per line', () => {
  const a = parse(FILE);
  const lines = dec.decode(writeJson(fileDocument(a))).split('\n');
  assert.deepEqual(lines.slice(0, 7), [
    '{"format":"cad-io-js raw","version":1,"source":"step",',
    '"header":[',
    '{"type":"FILE_DESCRIPTION","attrs":[["a test"],"2;1"]},',
    '{"type":"FILE_NAME","attrs":["t.stp","2026-10-17T00:00:00",["me"],[""],"pp","sys",""]},',
    '{"type":"FILE_SCHEMA","attrs":[["AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }"]]}',
    '],',
    '"data":[',
  ]);
  assert.deepEqual(lines.slice(7, 15), [
    '{"instances":[',
    '{"id":1,"type":"CARTESIAN_POINT","attrs":["origin",[0.0,-1.5,1e-7]]},',
    '{"id":2,"type":"DIRECTION","attrs":["",[0.0,0.0,1.0]]},',
    '{"id":3,"type":"AXIS2_PLACEMENT_3D","attrs":["",{"ref":1},{"ref":2},null]},',
    '{"id":10,"parts":[{"type":"LENGTH_UNIT","attrs":[]},{"type":"NAMED_UNIT","attrs":[{"derived":true}]},'
      + '{"type":"SI_UNIT","attrs":[{"enum":"MILLI"},{"enum":"METRE"}]}]},',
    '{"id":11,"type":"MEASURE_REPRESENTATION_ITEM","attrs":["m",{"type":"LENGTH_MEASURE","value":5.0},{"ref":10}]},',
    '{"id":12,"type":"EVERYTHING","attrs":[12,-7,3,100000.0,{"bin":"0FF"},{"enum":"T"},[],[[1,2],{"refs":[3]}],'
      + '{"type":"A","value":{"type":"B","value":1}},"#5 is not a ref",{"derived":true},9007199254740993,-0.0,[1,2.0,'
      + '{"ref":3},null],[-0.0,5.0]]},',
    '{"id":13,"type":"PRODUCT","attrs":["Bob\'s part","Ärger Ärger C:\\\\temp 🟊","line\\ntwo",null]},',
  ]);
  assert.deepEqual(lines.slice(-5, -4), ['{"id":15,"type":"!USER_THING","attrs":[1]},']);
  assert.match(lines.at(-4)!, new RegExp(String.raw`^\{"id":16,"type":"BIG","attrs":\[\[0\.5,1\.5,.*\],\[0,1000,.*\],`
    + String.raw`\{"refs":\[0,1,.*\]\},\[0,1099511627776,.*\]\]\}$`));
  assert.deepEqual(lines.slice(-3), [']}', ']}', '']);
});

test('values: every kind both ways, typed-array storage, canonical lists', () => {
  const cases: [Value, string][] = [
    [{ k: 'real', v: 5 }, '5.0'], [{ k: 'real', v: -0 }, '-0.0'], [{ k: 'real', v: 1e21 }, '1e+21'],
    [{ k: 'int', v: 5 }, '5'], [{ k: 'int', v: 2n ** 70n }, '1180591620717411303424'],
    [{ k: 'str', v: 'a"b\\é' }, '"a\\"b\\\\é"'], [{ k: 'enum', v: 'T' }, '{"enum":"T"}'],
    [{ k: 'ref', v: 7 }, '{"ref":7}'],
    [{ k: 'bin', v: '0FF' }, '{"bin":"0FF"}'], [{ k: 'unset' }, 'null'], [{ k: 'derived' }, '{"derived":true}'],
    [{ k: 'list', v: [] }, '[]'], [{ k: 'reals', v: [1, 2.5] }, '[1.0,2.5]'], [{ k: 'ints', v: [1, 2] }, '[1,2]'],
    [{ k: 'refs', v: [1, 2] }, '{"refs":[1,2]}'], [{ k: 'refs', v: [2 ** 40] }, '{"refs":[1099511627776]}'],
    [{ k: 'typed', type: 'X', v: { k: 'list', v: [{ k: 'unset' }] } }, '{"type":"X","value":[null]}'],
  ];
  for (const [v, s] of cases) {
    assert.equal(valueJson(v), s);
    assert.deepEqual(valueFromJson(parseJson(s)), v, s);
  }
  // Long lists load into typed arrays, exactly as the parser stores them.
  const n = TYPED_ARRAY_MIN;
  const reals = valueFromJson(
    parseJson(`[${Array.from({ length: n }, (_, i) => (i ? `${i}.25` : '-0.0')).join(',')}]`));
  assert.ok(reals.k === 'reals' && reals.v instanceof Float64Array && Object.is(reals.v[0], -0));
  const refs = valueFromJson(parseJson(`{"refs":[${Array.from({ length: n }, (_, i) => i).join(',')}]}`));
  assert.ok(refs.k === 'refs' && refs.v instanceof Uint32Array);
  const big = valueFromJson(parseJson(`{"refs":[${Array.from({ length: n }, (_, i) => i * 2 ** 40).join(',')}]}`));
  assert.ok(big.k === 'refs' && big.v instanceof Float64Array && big.v[1] === 2 ** 40);
  // Non-canonical lists in the model write the same JSON as canonical ones, and load canonical.
  const loose: Value = { k: 'list', v: [{ k: 'ref', v: 1 }, { k: 'ref', v: 2 }] };
  assert.equal(valueJson(loose), '[{"ref":1},{"ref":2}]');
  assert.deepEqual(valueFromJson(parseJson(valueJson(loose))), makeList(loose.v));
  // The Part 21 writer handles the list kinds and typed arrays.
  assert.equal(formatValue({ k: 'list',
    v: [reals, { k: 'ints', v: new Int32Array([1, -2]) }, { k: 'refs', v: new Uint32Array([3]) }] }).slice(0, 12),
    '((-0.,1.25,2');
  assert.equal(formatValue({ k: 'refs', v: [1, 2] }), '(#1,#2)');
  assert.equal(formatValue({ k: 'ints', v: new Float64Array([2 ** 40]) }), '(1099511627776)');
});

test('values the JSON form cannot hold, and documents that are not raw JSON', () => {
  for (const v of [{ k: 'real', v: NaN }, { k: 'int', v: 1.5 }, { k: 'ref', v: -1 },
    { k: 'refs', v: [0.5] }] as Value[]) {
    assert.throws(() => valueJson(v), WriteError, JSON.stringify(v));
  }
  assert.throws(() => instanceJson({ id: 4, type: 'P', attrs: [{ k: 'real', v: Infinity }] }), /^WriteError: #4: real/);

  const badValues: [string, RegExp][] = [
    ['true', /logicals/], ['{"ref":-1}', /reference/], ['{"ref":1.0}', /reference/],
    ['{"ref":1,"x":2}', /not a raw value/],
    ['{"enum":5}', /expected a string/], ['{"derived":false}', /must be true/], ['{"type":"X"}', /not a raw value/],
    ['{}', /not a raw value/], ['{"refs":[1,2.0]}', /reference/], ['[1,{"what":1}]', /value\[1\]/],
  ];
  for (const [s, re] of badValues) assert.throws(() => valueFromJson(parseJson(s)),
    (e) => e instanceof RawJsonError && re.test(e.message), s);

  const doc = (body: string) => `{"format":"cad-io-js raw","version":1,"source":"step","header":[],"data":[${body}]}`;
  const badDocs: [string, RegExp][] = [
    ['[]', /document: expected an object/],
    ['{"format":"other","version":1,"source":"step","header":[],"data":[]}', /format/],
    ['{"format":"cad-io-js raw","version":2,"source":"step","header":[],"data":[]}', /unsupported version 2/],
    ['{"format":"cad-io-js raw","version":1,"source":"iges","header":[],"data":[]}', /source is "iges"/],
    [doc('{"instances":[{"id":1,"type":"P"}]}'), /data\[0\]\.instances\[0\] \(#1\)\.attrs: expected an array/],
    [doc('{"instances":[{"id":-1,"type":"P","attrs":[]}]}'), /id is not/],
    [doc('{"instances":[{"id":1,"parts":[]}]}'), /no parts/],
    [doc('{"instances":[{"id":1,"type":"P","attrs":[],"parts":[]}]}'), /both parts/],
    [doc('{"instances":[{"id":1,"type":"P","attrs":[true]}]}'), /instances\[0\] \(#1\)\.attrs\[0\]: true/],
  ];
  for (const [s, re] of badDocs) assert.throws(() => readJson(s),
    (e) => e instanceof RawJsonError && re.test(e.message), s);
  // Unknown keys outside values are ignored: room for annotations.
  const r = readJson(doc('{"note":"x","instances":[{"id":1,"type":"P","attrs":[1],"names":["a"]}]}'));
  assert.deepEqual(r.data[0]!.instances, [{ id: 1, type: 'P', attrs: [{ k: 'int', v: 1 }] }]);
});

test('chunked output with multi-byte text, verbatim instances, sections, an empty document', () => {
  const a = parse(FILE);
  const whole = writeJson(fileDocument(a));
  for (let chunkSize = 1; chunkSize <= 256; chunkSize++) {
    const chunks = [...jsonChunks(fileDocument(a), { chunkSize })];
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) { joined.set(c, o); o += c.length; }
    assert.deepEqual(joined, whole); // no UTF-8 sequence is split or lost at a chunk boundary
  }
  // Source bytes are decoded.
  const verbatim = readJson(writeJson({ header: [], data: [{ instances: [a.sourceBytesAt(1)] }] }));
  assert.deepEqual(verbatim.data[0]!.instances, [instances(a)[1]]);

  const e3 = parse(`ISO-10303-21;HEADER;FILE_SCHEMA(('A','B'));ENDSEC;
DATA('first',('A'));#1=P(#2);ENDSEC;DATA('second',('B'));ENDSEC;END-ISO-10303-21;`);
  const j = writeJson(fileDocument(e3));
  assert.ok(dec.decode(j).includes(
    '"data":[\n{"name":"first","schemas":["A"],"instances":[\n{"id":1,"type":"P","attrs":[{"ref":2}]}\n]},'
    + '\n{"name":"second","schemas":["B"],"instances":[]}\n]}\n'));
  const b = readJson(j);
  assert.deepEqual(b.data.map((d) => [d.name, d.schemas]), [['first', ['A']], ['second', ['B']]]);
  const c = parseStep(writeStep(b));
  assert.deepEqual(c.dataSections, e3.dataSections);

  const empty: Instance[] = [];
  assert.equal(dec.decode(writeJson({ header: [], data: [] })),
    '{"format":"cad-io-js raw","version":1,"source":"step",\n"header":[],\n"data":[]}\n');
  assert.deepEqual(readJson(writeJson({ header: [], data: [{ instances: empty }] })),
    { header: [], data: [{ instances: [] }] });
});

test('NDJSON: layout, round trip, CRLF and blank lines, errors', async () => {
  const { writeJsonLines, readJsonLines } = await import('../src/index.ts');
  const a = parse(FILE);
  const text = dec.decode(writeJsonLines(fileDocument(a)));
  const lines = text.split('\n');
  assert.equal(lines[0], '{"format":"cad-io-js raw","version":1,"source":"step","layout":"ndjson",'
    + '"header":[{"type":"FILE_DESCRIPTION","attrs":[["a test"],"2;1"]},{"type":"FILE_NAME","attrs":["t.stp",'
    + '"2026-10-17T00:00:00",["me"],[""],"pp","sys",""]},{"type":"FILE_SCHEMA","attrs":[["AUTOMOTIVE_DESIGN { 1 0 '
    + '10303 214 1 1 1 1 }"]]}]}');
  assert.deepEqual(lines.slice(1, 3),
    ['{"data":{}}', '{"id":1,"type":"CARTESIAN_POINT","attrs":["origin",[0.0,-1.5,1e-7]]}']);
  assert.equal(lines.at(-1), '');
  const b = readJsonLines(text);
  assert.deepEqual(b, readJson(writeJson(fileDocument(a))));
  assert.deepEqual(readJsonLines(text.replaceAll('\n', '\r\n\n  \n')), b);
  // Every line is standard JSON on its own.
  for (const l of lines.filter((x) => x)) JSON.parse(l);
  // Edition 3 sections.
  const e3 = parse(`ISO-10303-21;HEADER;FILE_SCHEMA(('A','B'));ENDSEC;
DATA('first',('A'));#1=P(#2);ENDSEC;DATA('second',('B'));ENDSEC;END-ISO-10303-21;`);
  const t3 = dec.decode(writeJsonLines(fileDocument(e3)));
  assert.ok(t3.includes('\n{"data":{"name":"first","schemas":["A"]}}\n{"id":1,"type":"P",'
    + '"attrs":[{"ref":2}]}\n{"data":{"name":"second","schemas":["B"]}}\n'));
  assert.deepEqual(readJsonLines(t3).data.map((d) => [d.name, d.schemas, d.instances.length]),
    [['first', ['A'], 1], ['second', ['B'], 0]]);

  const env = lines[0]!;
  const bad: [string, RegExp][] = [
    ['', /line 1: empty input/],
    ['{"id":1,"type":"P","attrs":[]}', /line 1: format/],
    ['{"format":"cad-io-js raw","version":1,"source":"step","header":[],"data":[]}',
      /line 1: the first line is not an NDJSON envelope/],
    [`${env}\n{"id":1,"type":"P","attrs":[]}`, /line 2: an instance before any/],
    [`${env}\n{"data":{}}\n{"id":1,"type":"P","attrs":[true]}`, /line 3 \(#1\)\.attrs\[0\]/],
    [`${env}\n{"data":{}}\n{"id":1,`, /line 3: expected a key/],
  ];
  for (const [t, re] of bad) assert.throws(() => readJsonLines(t),
    (e) => e instanceof RawJsonError && re.test(e.message), t);
  // The whole-document reader refuses NDJSON, with a pointer to the right reader.
  assert.throws(() => readJson(lines[0]!), /readJsonLines/);
});
