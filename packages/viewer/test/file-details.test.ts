import assert from 'node:assert/strict';
import { test } from 'node:test';
import { label, propertyRows } from '../src/file-details.ts';

test('labels: camel case as words, other names as they are', () => {
  assert.equal(label('originatingSystem'), 'Originating system');
  assert.equal(label('timeStamp'), 'Time stamp');
  assert.equal(label('format'), 'Format');
  assert.equal(label('a1B2'), 'A1 b2');
  for (const k of ['Title', 'LicenseTerms', 'cadio:x', 'x_y', 'x-y', 'a b', '']) assert.equal(label(k), k);
});

test('rows: values as text, lists a line each (a list or object in one as JSON), objects within their label, ' +
  'blanks left out, in order', () => {
  assert.deepEqual(propertyRows({ format: 'step', authors: ['Ann', ' ', 'Bo'], organizations: ['', ' '],
    authorization: '  ', count: 3, ok: false, none: null, empty: [],
    container: { format: 'glb', asset: { generator: 'g', extras: {} } },
    metadata: { Title: 'T' }, mixed: [1, null, { a: 1 }, [2, 'x']] }), [
    ['Format', 'step'], ['Authors', 'Ann\nBo'], ['Count', '3'], ['Ok', 'false'],
    ['Container / Format', 'glb'], ['Container / Asset / Generator', 'g'], ['Metadata / Title', 'T'],
    ['Mixed', '1\n{"a":1}\n[2,"x"]']]);
  assert.deepEqual(propertyRows({}), []);
});
