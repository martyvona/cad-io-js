import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { parseStep, readJson, readJsonLines } from 'step-parser';
import { step2json } from '../src/index.ts';

const FILE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test'),'2;1');
FILE_NAME('t.stp','2026-10-17T00:00:00',('me'),(''),'pp','sys','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#1=APPLICATION_CONTEXT('');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#4=PRODUCT('P1','Part','',(#2));
#5=PRODUCT_DEFINITION_FORMATION('','',#4);
#6=PRODUCT_DEFINITION('','',#5,#3);
#7=PRODUCT_DEFINITION_SHAPE('','',#6);
#8=SHAPE_REPRESENTATION('',(#12),#11);
#9=SHAPE_DEFINITION_REPRESENTATION(#7,#8);
#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#11=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#10))REPRESENTATION_CONTEXT('',''));
#12=AXIS2_PLACEMENT_3D('',#13,$,$);
#13=CARTESIAN_POINT('',(0.,0.,0.));
#14=DIRECTION('',(1.,0.));
#15=EDGE_CURVE('',#13,#99,#13,.T.);
#16=BROKEN(1 2);
ENDSEC;
END-ISO-10303-21;
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'step2json-'));
const input = path.join(tmp, 't.stp');
fs.writeFileSync(input, FILE);
fs.writeFileSync(path.join(tmp, 't.stpZ'), gzipSync(FILE));

/** Run in-process; collects standard output and error. */
async function run(args: string[], stdin = '') {
  const chunks: Buffer[] = [], err: Buffer[] = [];
  const stdout = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  const stderr = new Writable({ write(c, _e, cb) { err.push(Buffer.from(c)); cb(); } });
  const code = await step2json(args, { stdout, stderr, stdin: Readable.from([Buffer.from(stdin)]) });
  return { code, out: Buffer.concat(chunks), err: Buffer.concat(err).toString() };
}

test('raw mode: JSON and NDJSON load back to the parsed model; malformed instances reported', async () => {
  const model = parseStep(new TextEncoder().encode(FILE));
  const expected = [...model.instances(() => {})];
  const r = await run([input]);
  assert.equal(r.code, 0);
  assert.deepEqual(readJson(r.out).data[0]!.instances, expected);
  assert.match(r.err, /^16 instances; 1 errors, 0 warnings, 0 notes\n {2}error: #16: malformed instance, left out: expected ',' or '\)'/);
  const n = await run([input, '--ndjson', '-q']);
  assert.deepEqual(readJsonLines(n.out).data[0]!.instances, expected);
  assert.equal(n.err, '');
  // --names: the loader ignores them, so the model is the same.
  const named = await run([input, '--names', '-q']);
  assert.ok(named.out.toString().includes('{"id":4,"type":"PRODUCT","names":["id","name","description","frame_of_reference"],"attrs":["P1","Part","",{"refs":[2]}]}'));
  assert.deepEqual(readJson(named.out), readJson(r.out));
});

test('semantic mode: structure, instances, schema checks, pretty printing', async () => {
  const r = await run(['-m', 'semantic', input, '--instances', '-q']);
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.out.toString());
  assert.deepEqual([doc.format, doc.version, doc.file.name, doc.file.dictionary, doc.roots], ['cad-io-js semantic', 1, 't.stp', 'AUTOMOTIVE_DESIGN', [0]]);
  assert.deepEqual(doc.products.map((p: { partNumber: string; name: string; shapes: number[] }) => [p.partNumber, p.name, p.shapes]), [['P1', 'Part', [8]]]);
  assert.deepEqual(doc.representations[0].context.lengthUnit, { name: 'millimetre', kind: 'length', factor: 0.001, id: 10 });
  assert.deepEqual(doc.instances, [{ product: 0, path: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }]);
  const messages = (d: { diagnostics: { message: string }[] }) => d.diagnostics.map((x) => x.message);
  assert.deepEqual(messages(doc), []); // parse problems in instances only show with --check
  const checked = JSON.parse((await run(['-m', 'semantic', input, '--check', '-q'])).out.toString());
  assert.deepEqual(messages(checked), [
    'EDGE.edge_start: reference to CARTESIAN_POINT, expected VERTEX',
    'EDGE.edge_end: dangling reference',
    'EDGE_CURVE.edge_geometry: reference to CARTESIAN_POINT, expected CURVE',
    `malformed instance: expected ',' or ')' at byte ${FILE.indexOf('#16=') + 13}`,
  ]);
  const pretty = await run(['-m', 'semantic', input, '--pretty', '-q']);
  assert.ok(pretty.out.toString().startsWith('{\n  "format": "cad-io-js semantic",'));
});

test('inputs and outputs: gzip, standard input, -o, errors', async () => {
  const gz = await run([path.join(tmp, 't.stpZ'), '-q']);
  const plain = await run([input, '-q']);
  assert.deepEqual(gz.out, plain.out);
  assert.deepEqual((await run(['-', '-q'], FILE)).out, plain.out);
  const outFile = path.join(tmp, 'out.json');
  assert.equal((await run([input, '-o', outFile, '-q'])).code, 0);
  assert.deepEqual(fs.readFileSync(outFile), plain.out);

  assert.equal((await run([])).code, 1);
  assert.equal((await run([input, '--mode', 'other'])).code, 1);
  assert.equal((await run([input, '--pretty'])).code, 1);
  assert.equal((await run([input, '-m', 'semantic', '--ndjson'])).code, 1);
  assert.equal((await run([input, '--bogus'])).code, 1);
  const missing = await run([path.join(tmp, 'nope.stp')]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /can't read/);
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out.toString(), /^Usage: step2json/);
});

test('backpressure: output to a slow stream arrives complete and in order', async () => {
  // Many instances, a 1-byte high-water mark, and a sink that acknowledges asynchronously.
  const big = FILE.replace('#16=BROKEN(1 2);', Array.from({ length: 5000 }, (_, i) => `#${100 + i}=CARTESIAN_POINT('p${i}',(${i}.,0.,0.));`).join('\n'));
  const file = path.join(tmp, 'big.stp');
  fs.writeFileSync(file, big);
  const chunks: Buffer[] = [];
  let writes = 0;
  const stdout = new Writable({ highWaterMark: 1, write(c, _e, cb) { writes++; chunks.push(Buffer.from(c)); setImmediate(cb); } });
  const code = await step2json([file, '-q'], { stdout, stderr: new PassThrough(), stdin: Readable.from([]) });
  assert.equal(code, 0);
  assert.ok(writes > 1);
  assert.equal(readJson(Buffer.concat(chunks)).data[0]!.instances.length, 5015);
});

test('the bin script runs under Node with type stripping', () => {
  const out = execFileSync(process.execPath, [path.join(import.meta.dirname, '../bin/step2json.ts'), input, '-q', '--ndjson'], { encoding: 'utf8' });
  assert.equal(out.split('\n')[1], '{"data":{}}');
});
