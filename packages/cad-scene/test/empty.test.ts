// Empty assemblies dropped: components with nothing drawn beneath them removed with their occurrences, the rest
// renumbered, overrides' paths renumbered or (inside a removed one) dropped; an external component kept; a cycle not
// taken for empty.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropEmptyAssemblies, dropEmptyComponents } from '../src/empty.ts';
import { identity, partInstances, validate } from '../src/walk.ts';
import type { Component, Occurrence, Scene } from '../src/scene.ts';

const occ = (component: number, name: string): Occurrence => ({ component, transform: identity(), sources: [],
  properties: {}, name });
const comp = (name: string, parts: number[], children: Occurrence[], extra: Partial<Component> = {}): Component => ({
  name, sources: [], properties: {}, parts: parts.map((part) => ({ part, transform: identity() })), children,
  ...extra });

/**
 * top (0): [empty (1), sub (2), shell (3)], shell: [empty]; sub: part 0, [empty, deep (4)]; deep: [empty]; far (5): an
 * external reference, nothing else; loop (6) <-> (7) a cycle; a second root, empty.
 */
function scene(): Scene {
  return {
    unit: 'millimetre',
    components: [
      comp('top', [], [occ(1, 'e0'), occ(2, 's'), occ(3, 'sh'), occ(5, 'f'), occ(6, 'l')]),
      comp('empty', [], []),
      comp('sub', [0], [occ(1, 'e1'), occ(4, 'd')]),
      comp('shell', [], [occ(1, 'e2')]),
      comp('deep', [], [occ(1, 'e3')]),
      comp('far', [], [], { external: { uri: 'other.stp' } }),
      comp('loop', [], [occ(7, 'm')]),
      comp('loop2', [], [occ(6, 'n')]),
    ],
    roots: [occ(0, 'r'), occ(1, 'r2')],
    parts: [{ name: 'p', sources: [], properties: {}, origin: [0, 0, 0], lods: [] }],
    materials: [{ color: [1, 0, 0], opacity: 1, sources: [] }],
    layers: [],
    // On sub's part (path r/s), inside the removed empties (r/e0, r/s/e1), on far (r/f), on the empty root, on
    // loop2 (r/l/m).
    overrides: [{ path: [0, 1], material: 0, sources: [] }, { path: [0, 0], visible: false, sources: [] },
      { path: [0, 1, 0], visible: false, sources: [] }, { path: [0, 3], material: 0, sources: [] },
      { path: [1], visible: false, sources: [] }, { path: [0, 4, 0], material: 0, sources: [] }],
    properties: {},
    diagnostics: [],
  };
}

test('empty components removed with their occurrences, the rest renumbered; overrides kept where they still lead',
  () => {
  const s = scene();
  const before = [...partInstances(s)].map((p) => [p.part, p.material]);
  assert.equal(dropEmptyComponents(s), 3);
  // (The cycle kept, as it was: the one problem.)
  assert.deepEqual(validate(s), ['component 3 contains itself']);
  assert.deepEqual(s.components.map((c) => [c.name, c.children.map((o) => [o.name, s.components[o.component]!.name])]),
    [['top', [['s', 'sub'], ['f', 'far'], ['l', 'loop']]], ['sub', []], ['far', []], ['loop', [['m', 'loop2']]],
      ['loop2', [['n', 'loop']]]]);
  assert.deepEqual(s.roots.map((o) => [o.name, o.component]), [['r', 0]]);
  // r/s now r/0, r/f now r/1, r/l/m now r/2/0; those through removed occurrences gone.
  assert.deepEqual(s.overrides.map((o) => o.path), [[0, 0], [0, 1], [0, 2, 0]]);
  // What's drawn the same.
  assert.deepEqual([...partInstances(s)].map((p) => [p.part, p.material]), before);
  // Again: nothing more.
  assert.equal(dropEmptyComponents(s), 0);
});

test('dropEmptyAssemblies says how many; nothing to drop, nothing said', () => {
  const s = scene();
  dropEmptyAssemblies(s);
  assert.deepEqual(s.diagnostics, [{ severity: 'info',
    message: '3 empty assemblies (nothing drawn beneath) left out' }]);
  dropEmptyAssemblies(s);
  assert.equal(s.diagnostics.length, 1);
  const one = scene();
  one.components = [comp('top', [0], [occ(1, 'e')]), comp('empty', [], [])];
  one.roots = [occ(0, 'r')];
  one.overrides = [];
  dropEmptyAssemblies(one);
  assert.deepEqual(one.diagnostics.map((d) => d.message), ['an empty assembly (nothing drawn beneath) left out']);
});
