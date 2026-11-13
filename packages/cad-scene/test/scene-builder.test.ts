// SceneBuilder and the rigid-placement checks: a scene built a row at a time, every placement a rotation and a
// translation or a throw; references only to what was added before; finish a snapshot.

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRigid, isRigid, SceneBuilder } from '../src/scene-builder.ts';
import { partInstances, validate } from '../src/walk.ts';
import type { Mat4, Part } from '../src/scene.ts';

const M = (l: number[], t = [0, 0, 0], bottom = [0, 0, 0, 1]): Mat4 => Float64Array.of(l[0]!, l[1]!, l[2]!,
  bottom[0]!, l[3]!, l[4]!, l[5]!, bottom[1]!, l[6]!, l[7]!, l[8]!, bottom[2]!, t[0]!, t[1]!, t[2]!, bottom[3]!);
const rot = (a: number) => [Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const part = (name: string): Part => ({ name, sources: [], properties: {}, origin: [0, 0, 0], lods: [] });

test('a scene built: components, parts placed, materials, valid and walked', () => {
  const b = new SceneBuilder({ properties: { title: 't' }, sourceUnit: 25.4 });
  const red = b.addMaterial({ color: [1, 0, 0], opacity: 1, sources: [] });
  const p = b.addPart({ ...part('p'), material: red });
  const sub = b.addComponent({ name: 'sub', sources: [], properties: {} });
  b.addPartRef(sub, { part: p, transform: M(rot(0.3), [1, 2, 3]) });
  const top = b.addComponent({ name: 'top', sources: [], properties: {} });
  b.addOccurrence(top, { component: sub, transform: M(rot(1), [5, 0, 0]), sources: [], properties: {} });
  b.addOccurrence(top, { component: sub, transform: M(rot(-1), [0, 5, 0]), sources: [], properties: {} });
  b.addOccurrence('root', { component: top, transform: M(rot(0)), sources: [], properties: {} });
  b.addPartRef('root', { part: p, transform: M(rot(2), [9, 9, 9]) });
  const s = b.finish();
  assert.deepEqual(validate(s), []);
  assert.equal([...partInstances(s)].length, 3);
  assert.equal(s.sourceUnit, 25.4);
  assert.deepEqual(s.properties, { title: 't' });
  // A snapshot: what's added after it isn't in it.
  b.addPartRef('root', { part: p, transform: M(rot(0)) });
  b.addPartRef(sub, { part: p, transform: M(rot(0)) });
  b.addOccurrence(top, { component: sub, transform: M(rot(0)), sources: [], properties: {} });
  assert.deepEqual([s.rootParts!.length, s.components[0]!.parts.length, s.components[1]!.children.length], [1, 1, 2]);
  const t = b.finish();
  assert.deepEqual([t.rootParts!.length, t.components[0]!.parts.length, t.components[1]!.children.length], [2, 2, 3]);
});

test('a placement that isn\'t a rotation and a translation: a throw, nothing added', () => {
  const cases: [string, Mat4][] = [['a mirror', M([-1, 0, 0, 0, 1, 0, 0, 0, 1])],
    ['an even scale', M([2, 0, 0, 0, 2, 0, 0, 0, 2])], ['an uneven scale', M([1, 0, 0, 0, 3, 0, 0, 0, 1])],
    ['a shear', M([1, 0, 0, 0.6, 0.8, 0, 0, 0, 1])],
    ...[[0.5, 0, 0, 1], [0, 0.5, 0, 1], [0, 0, 0.5, 1], [0, 0, 0, 2]].map((b) => [`projective ${b}`, M(rot(0),
      [0, 0, 0], b)] as [string, Mat4]),
    ['not finite', M([NaN, 0, 0, 0, 1, 0, 0, 0, 1])], ['a translation not finite', M(rot(0), [0, Infinity, 0])],
    ['short', Float64Array.of(1, 0, 0)]];
  for (const [what, m] of cases) {
    const b = new SceneBuilder();
    const p = b.addPart(part('p')), c = b.addComponent({ name: 'c', sources: [], properties: {} });
    assert.throws(() => b.addPartRef(c, { part: p, transform: m }), /isn't a rotation and a translation/, what);
    assert.throws(() => b.addOccurrence('root', { component: c, transform: m, sources: [], properties: {} }),
      /isn't a rotation and a translation/, what);
    assert.equal(b.finish().components[0]!.parts.length + b.finish().roots.length, 0, what);
    assert.equal(isRigid(m), false, what);
  }
  // A rotation to the data's precision (float32 rounding) is one.
  assert.equal(isRigid(M(rot(0.4).map((x, i) => x + (i === 0 ? 3e-7 : 0)), [1, 2, 3])), true);
});

test('references to what wasn\'t added: a throw', () => {
  const b = new SceneBuilder();
  const c = b.addComponent({ name: 'c', sources: [], properties: {} });
  assert.throws(() => b.addPartRef(c, { part: 0, transform: M(rot(0)) }), /part 0 not added yet/);
  assert.throws(() => b.addOccurrence('root', { component: 3, transform: M(rot(0)), sources: [], properties: {} }),
    /component 3 not added yet/);
  assert.throws(() => b.addOccurrence(5, { component: c, transform: M(rot(0)), sources: [], properties: {} }),
    /component 5 not added yet/);
  assert.throws(() => b.addPart({ ...part('p'), material: 2 }), /material 2 not added yet/);
  assert.throws(() => b.addOverride({ path: [0], material: 0, sources: [] }), /material 0 not added yet/);
});

test('assertRigid: every placement checked, the first not rigid named', () => {
  const b = new SceneBuilder();
  const p = b.addPart(part('p')), c = b.addComponent({ name: 'c', sources: [], properties: {} });
  b.addPartRef(c, { part: p, transform: M(rot(0.2)) });
  b.addOccurrence('root', { component: c, transform: M(rot(0.5), [1, 0, 0]), sources: [], properties: {} });
  const s = b.finish();
  assertRigid(s);
  s.components[0]!.parts[0]!.transform = M([-1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.throws(() => assertRigid(s), /component 0 \(c\), part 0: a transform that isn't a rotation/);
  s.components[0]!.parts[0]!.transform = M(rot(0));
  s.rootParts = [{ part: p, transform: M([1, 0, 0, 0, 2, 0, 0, 0, 1]) }];
  assert.throws(() => assertRigid(s), /root part 0/);
  s.rootParts = [];
  s.roots[0]!.transform = M(rot(0), [0, 0, 0], [0, 0, 1, 1]);
  assert.throws(() => assertRigid(s), /root 0:/);
});
