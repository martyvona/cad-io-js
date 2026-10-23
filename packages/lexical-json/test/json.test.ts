import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatInt, formatReal, formatString, JsonParseError, parseJson, stringify,
  type JsonValue } from '../src/index.ts';

let seed = 4242;
const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);

test('numbers: integers are bigints, reals are numbers, by lexical form', () => {
  assert.deepEqual(parseJson('[0,-0,5,-12,9007199254740993,123456789012345678901234567890]'),
    [0n, 0n, 5n, -12n, 9007199254740993n, 123456789012345678901234567890n]);
  const reals = parseJson('[0.0,-0.0,5.0,5e0,5E+0,1e-7,-1.5e-300,0.1,1e-400]') as number[];
  assert.ok(Object.is(reals[1], -0));
  assert.deepEqual(reals.slice(2), [5, 5, 5, 1e-7, -1.5e-300, 0.1, 0]); // underflow reads as 0, as with JSON.parse
});

test('formatReal: a point or exponent always; exact round trip of random doubles', () => {
  const cases: [number, string][] = [
    [5, '5.0'], [0, '0.0'], [-0, '-0.0'], [0.25, '0.25'], [-1.5, '-1.5'], [1e-7, '1e-7'], [1e21, '1e+21'],
    [123456789012345680000, '123456789012345680000.0'], [5e-324, '5e-324'],
    [Number.MAX_VALUE, '1.7976931348623157e+308'],
  ];
  for (const [x, s] of cases) assert.equal(formatReal(x), s);
  for (const x of [NaN, Infinity, -Infinity]) assert.throws(() => formatReal(x), RangeError);

  const bits = new Float64Array(1);
  const words = new Uint32Array(bits.buffer);
  const xs: number[] = [];
  while (xs.length < 20000) {
    words[0] = rand();
    words[1] = rand();
    if (Number.isFinite(bits[0]!)) xs.push(bits[0]!);
  }
  const text = `[${xs.map(formatReal).join(',')}]`;
  assert.deepEqual(parseJson(text), xs);
  assert.deepEqual(JSON.parse(text), xs); // standard JSON too
});

test('formatInt', () => {
  assert.equal(formatInt(5), '5');
  assert.equal(formatInt(-0), '0');
  assert.equal(formatInt(2 ** 60), '1152921504606846976');
  assert.equal(formatInt(-(2n ** 70n)), '-1180591620717411303424');
  assert.throws(() => formatInt(1.5), RangeError);
});

test('strings: escapes, raw UTF-8, lone surrogates, BOM inside a string', () => {
  assert.deepEqual(parseJson(String.raw`["a\"b\\c\/d\b\f\n\r\t", "Ää", "😀", "\udc00x"]`),
    ['a"b\\c/d\b\f\n\r\t', 'Ää', '😀', '\udc00x']);
  assert.equal(parseJson(new TextEncoder().encode('"Ärger π 😀 ﻿x"')), 'Ärger π 😀 ﻿x');
  assert.equal(parseJson('"﻿"'), '﻿');
  assert.equal(parseJson('﻿ "x"'), 'x'); // a BOM before the value is skipped
  // Random strings from awkward characters round trip through formatString.
  const pool = ['a', 'Z', ' ', '"', '\\', '/', '\n', '\t', '\0', '\x7f', 'é', 'Ж', '￿', '😀', '\ud800', '\udfff', '﻿'];
  for (let n = 0; n < 5000; n++) {
    let s = '';
    for (let k = rand() % 12; k > 0; k--) s += pool[rand() % pool.length];
    assert.equal(parseJson(formatString(s)), s);
    assert.equal(parseJson(new TextEncoder().encode(formatString(s))), s);
  }
  // A long ASCII string and a long non-ASCII string take the TextDecoder path.
  const long = 'x'.repeat(1000) + 'é'.repeat(1000);
  assert.equal(parseJson(formatString(long)), long);
});

test('structure matches JSON.parse on documents without numbers', () => {
  const gen = (d: number): JsonValue => {
    const r = rand() % (d > 3 ? 4 : 6);
    if (r === 0) return null;
    if (r === 1) return rand() % 2 === 0;
    if (r === 2 || r === 3) return ['', 'k', 'a b', 'é', '"q"'][rand() % 5]!;
    if (r === 4) return Array.from({ length: rand() % 4 }, () => gen(d + 1));
    const o: Record<string, JsonValue> = {};
    for (let k = rand() % 4; k > 0; k--) o['k' + (rand() % 6)] = gen(d + 1);
    return o;
  };
  for (let n = 0; n < 500; n++) {
    const v = gen(0);
    const pretty = JSON.stringify(v, null, rand() % 3);
    assert.deepEqual(parseJson(pretty), JSON.parse(pretty));
    assert.equal(stringify(v), JSON.stringify(v));
  }
  const o = parseJson('{"__proto__": 1}') as Record<string, unknown>;
  assert.deepEqual(Object.keys(o), ['__proto__']);
  assert.equal(Object.getPrototypeOf(o), Object.prototype);
});

test('errors', () => {
  const bad: [string, RegExp][] = [
    ['', /end of input/], ['[1,]', /unexpected ']'/], ['[1 2]', /expected ',' or ']'/], ['{"a":1,}', /expected a key/],
    ['{"a" 1}', /expected ':'/], ['{"a":1 "b":2}', /expected ',' or '}'/], ['{"a":1,"a":2}', /duplicate key "a"/],
    ['01', /after the value/], ['1.', /after the decimal point/], ['.5', /unexpected '\.'/], ['+1', /unexpected '\+'/],
    ['-', /expected a digit/], ['1e', /exponent/], ['1e400', /out of range/], ['NaN', /unexpected 'N'/],
    ['"abc', /unterminated string/], ['"a\nb"', /control character/], ['"\\x"', /invalid escape/],
    ['"\\u12G4"', /invalid \\u escape/], ['tru', /expected 'true'/], ['[1] x', /after the value/],
    ["'a'", /unexpected/],
  ];
  for (const [text, re] of bad) assert.throws(() => parseJson(text),
    (e) => e instanceof JsonParseError && re.test(e.message), text);
  assert.throws(() => parseJson(Uint8Array.of(0x22, 0xc3, 0x28, 0x22)), /invalid UTF-8/);
  assert.throws(() => parseJson('[1, ]'), (e) => e instanceof JsonParseError && e.offset === 4);
});

test('stringify: kinds, typed arrays, indentation', () => {
  assert.equal(stringify([1, 1n, -0, 'x', null, true, { a: undefined, b: 2n }]), '[1.0,1,-0.0,"x",null,true,{"b":2}]');
  assert.equal(stringify({ f: new Float32Array([0.5, 1]), d: new Float64Array([2]), i: new Int32Array([-1, 2]),
    u: new BigUint64Array([3n]) }),
    '{"f":[0.5,1.0],"d":[2.0],"i":[-1,2],"u":[3]}');
  assert.equal(stringify({ a: [1, [2n]], b: {}, c: [] }, { indent: 2 }),
    '{\n  "a": [\n    1.0,\n    [2]\n  ],\n  "b": {},\n  "c": []\n}');
  const v = { pts: new Float64Array([0, 1.5]), n: [3n, 4n], s: 'é' };
  assert.deepEqual(parseJson(stringify(v, { indent: 1 })), { pts: [0, 1.5], n: [3n, 4n], s: 'é' });
  assert.throws(() => stringify([NaN]), RangeError);
});
