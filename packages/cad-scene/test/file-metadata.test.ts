import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorOf, propertiesFrom, sceneJson, standardMetadata, type Scene } from '../src/index.ts';

test('the author: placeholders left out whatever their case and spaces, real names trimmed and joined', () => {
  for (const p of ['', ' ', 'Author', 'AUTHOR NAME', ' a designer ', 'Designer', 'none', 'Unknown', 'unspecified',
    'User', 'user', 'Konstrukteur', '--- Datakit Converter ---', '---']) {
    assert.equal(authorOf([p]), undefined, JSON.stringify(p));
  }
  assert.equal(authorOf([]), undefined);
  assert.equal(authorOf(['Christian Stark']), 'Christian Stark');
  assert.equal(authorOf([' SD Yates ']), 'SD Yates');
  assert.equal(authorOf(['none', 'Ann B', '', 'csmetana']), 'Ann B, csmetana');
  // (Only whole names: a name holding a placeholder is a name.)
  assert.equal(authorOf(['Usern']), 'Usern');
  assert.equal(authorOf(['Author of it']), 'Author of it');
  assert.equal(authorOf(['x---']), 'x---');
});

test('standard fields from each format\'s properties', () => {
  assert.deepEqual(standardMetadata({ format: 'step', author: 'Ann', timeStamp: '2026-01-02T03:04:05',
    name: 'n', description: ['d'] }), { Designer: 'Ann', CreationDate: '2026-01-02T03:04:05' });
  // (A blank time stamp, or another format's, is no date.)
  assert.deepEqual(standardMetadata({ format: 'step', timeStamp: ' ' }), {});
  assert.deepEqual(standardMetadata({ format: 'glb', timeStamp: '2026' }), {});
  assert.deepEqual(standardMetadata({ format: '3mf', author: 'Bo', metadata: { Title: 'T', Designer: 'ignored',
    Description: 'D', Copyright: 'C', LicenseTerms: 'L', Rating: 'R', CreationDate: '2020-01-01',
    ModificationDate: '2021-01-01', Application: 'theirs', Other: 'o', Blank: ' ' } }),
  { Designer: 'Bo', Title: 'T', Description: 'D', Copyright: 'C', LicenseTerms: 'L', Rating: 'R',
    CreationDate: '2020-01-01' });
  // (Metadata named so in another format isn't 3MF's.)
  assert.deepEqual(standardMetadata({ format: 'step', metadata: { Title: 'T' } }), {});
  assert.deepEqual(standardMetadata({ format: 'gltf', asset: { copyright: '(c) X', generator: 'g' } }),
    { Copyright: '(c) X' });
  // (3MF's own copyright first.)
  assert.deepEqual(standardMetadata({ format: '3mf', metadata: { Copyright: 'mine' }, asset: { copyright: 'x' } }),
    { Copyright: 'mine' });
  assert.deepEqual(standardMetadata({ author: 3, asset: 'x', metadata: [] }), {});
  assert.deepEqual(standardMetadata({}), {});
});

test('read back: the source\'s properties with the file\'s own as their container; else the file\'s own', () => {
  const own = { format: 'glb', asset: { generator: 'g' } };
  assert.deepEqual(propertiesFrom({ format: 'step', author: 'Ann' }, own),
    { format: 'step', author: 'Ann', container: own });
  assert.deepEqual(propertiesFrom({}, own), own);
  assert.deepEqual(propertiesFrom({ format: 'step' }, {}), { format: 'step' });
  // (A container of the source's, from a file before, is replaced by this file's.)
  assert.deepEqual(propertiesFrom({ format: 'step', container: { format: '3mf' } }, own),
    { format: 'step', container: own });
});

test('our extras carry the scene\'s properties on, not the container they were read from', () => {
  const scene = (properties: Scene['properties']): Scene => ({ unit: 'millimetre', components: [], roots: [],
    parts: [], materials: [], layers: [], overrides: [], properties, diagnostics: [] });
  assert.deepEqual(sceneJson(scene({ format: 'step', author: 'Ann', container: { format: 'glb' } })).properties,
    { format: 'step', author: 'Ann' });
  assert.equal(sceneJson(scene({ container: { format: 'glb' } })).properties, undefined);
  assert.equal(sceneJson(scene({})).properties, undefined);
});
