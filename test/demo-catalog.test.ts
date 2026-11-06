import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { catalogText, listModels, writeCatalog } from '../scripts/demo-catalog.ts';

const tree = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-catalog-'));
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  }
  return dir;
};

test('every model below the directory by the viewer\'s extensions, any case, recursively, sorted by code point', () => {
  const dir = tree({
    'b.STEP': 'xx', 'a.stp': 'x', 'Z.stpZ': 'zzz', 'sub/deep/c.glb': '1234', 'sub/d.gltf': '12', 'sub/d.bin': '1',
    'e.json': '{}', 'f.3MF': '', 'g.png': 'p', 'LICENSE.txt': 't', 'catalog.json': '{}', 'sub/catalog.json': '[]',
    '.hidden.stp': 'h', '.dir/h.stp': 'h', 'noext': 'n', 'step': 's', 'x.step.bak': 'b',
  });
  fs.mkdirSync(path.join(dir, 'empty'));
  fs.symlinkSync(path.join(dir, 'a.stp'), path.join(dir, 'link.stp'));
  try {
    assert.deepEqual(listModels(dir), [
      { path: 'Z.stpZ', size: 3 }, { path: 'a.stp', size: 1 }, { path: 'b.STEP', size: 2 }, { path: 'e.json', size: 2 },
      { path: 'f.3MF', size: 0 }, { path: 'sub/catalog.json', size: 2 }, { path: 'sub/d.gltf', size: 2 },
      { path: 'sub/deep/c.glb', size: 4 },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('the catalog text: a model a line, ASCII, the same bytes for the same models', () => {
  const text = catalogText([{ path: 'a.stp', size: 1 }, { path: 'd\u00e9mo/\u{1F600}.glb', size: 22 }]);
  assert.equal(text, '{\n  "models": [\n    {"path":"a.stp","size":1},\n' +
    '    {"path":"d\\u00e9mo/\\ud83d\\ude00.glb","size":22}\n  ]\n}\n');
  assert.deepEqual(JSON.parse(text),
    { models: [{ path: 'a.stp', size: 1 }, { path: 'd\u00e9mo/\u{1F600}.glb', size: 22 }] });
  assert.equal(catalogText([]), '{\n  "models": []\n}\n');
});

test('written only when it changes', () => {
  const dir = tree({ 'a.stp': 'x' });
  try {
    const file = path.join(dir, 'catalog.json');
    assert.equal(writeCatalog(dir), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { models: [{ path: 'a.stp', size: 1 }] });
    const before = fs.statSync(file).mtimeMs;
    fs.utimesSync(file, 0, 0);
    assert.equal(writeCatalog(dir), false);
    assert.equal(fs.statSync(file).mtimeMs, 0, 'rewritten unchanged');
    assert.ok(before > 0);
    fs.writeFileSync(path.join(dir, 'a.stp'), 'xy');
    assert.equal(writeCatalog(dir), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { models: [{ path: 'a.stp', size: 2 }] });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
