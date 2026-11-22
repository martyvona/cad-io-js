// Point classification on built solids (cad-brep's test models): RayShellSide and the Oracle's classify, shellSide
// and nesting against how each was built. A box with a box-shaped void: the outer shell's faces outside, the void's
// inside (facing into the void), the void nested in the outer; a box built inside out and used as built: inside; one
// built inside out and used reversed: outside; two lumps side by side in one solid: neither holds the other. With
// checkSecondRay a second ray agrees. Skipped where the module isn't built (build.sh module).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BrepBuilder, type BrepData } from 'cad-brep';
import { box, MODELS } from '../../cad-brep/test/models.ts';
import { init, Oracle } from '../src/index.ts';
import { RayShellSide } from '../src/shell-side.ts';

const pkg = path.join(import.meta.dirname, '..');
const built = fs.existsSync(path.join(pkg, 'dist/cad_oracle.wasm'));
const skip = built ? false : 'cad-oracle\'s module not built (run packages/cad-oracle/build.sh module)';

/** Each shell's faces (rows), from the model's shell and face-use tables. */
function shellFaces(d: BrepData): number[][] {
  const out: number[][] = [];
  for (let s = 0; s < d.shell.kind.length; s++) {
    const first = d.shell.first[s]!, count = d.shell.count[s]!;
    out.push(Array.from(d.faceUse.face.subarray(first, first + count)));
  }
  return out;
}

/** Every face's side of its shell, by shell. */
function sides(ss: RayShellSide, d: BrepData, eps: number): string[][] {
  return shellFaces(d).map((faces, s) => faces.map((f) => ss.side(d, s, f, eps).side));
}

test('withVoid: the outer shell faces out, the void into the void, the void nested in the outer', { skip }, async () => {
  const d = MODELS.withVoid().finish();
  using ss = new RayShellSide(await init());
  const s = sides(ss, d, 1e-3);
  assert.deepEqual(s, [Array(6).fill('outside'), Array(6).fill('inside')]);
  using o = new Oracle(await init(), d.buffer);
  assert.deepEqual(o.nesting(0), [-1, 0]);
  // The void's middle is inside the void's shell and inside the outer's; a point between them inside the outer only.
  assert.equal(o.classify(1, [1.5, 1.5, 1.5]).side, 'inside');
  assert.equal(o.classify(0, [1.5, 1.5, 1.5]).side, 'inside');
  assert.equal(o.classify(1, [3, 3, 3]).side, 'outside');
  assert.equal(o.classify(0, [3, 3, 3]).side, 'inside');
  assert.equal(o.classify(0, [9, 9, 9]).side, 'outside');
});

test('a box inside out as built: inside; built inside out and used reversed: outside', { skip }, async () => {
  using ss = new RayShellSide(await init());
  {
    const b = new BrepBuilder();
    const shell = box(b, [1, 2, 3], [0, 0, 0], 0, () => true, true);
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
    assert.deepEqual(sides(ss, b.finish(), 1e-3), [Array(6).fill('inside')]);
  }
  assert.deepEqual(sides(ss, MODELS.reversedUses().finish(), 1e-3), [Array(6).fill('outside'),
    Array(6).fill('outside')]);
});

test('two lumps side by side in one solid: neither holds the other', { skip }, async () => {
  const b = new BrepBuilder();
  const one = box(b, [1, 1, 1]), two = box(b, [1, 1, 1], [3, 0, 0], 100);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: one, sense: true },
    { ref: two, sense: true }] }) });
  using o = new Oracle(await init(), b.finish().buffer);
  assert.deepEqual(o.nesting(0), [-1, -1]);
});

test('checkSecondRay: a second ray agrees; the evidence names the point and the ray', { skip }, async () => {
  const d = MODELS.cube().finish();
  using ss = new RayShellSide(await init(), { checkSecondRay: true });
  const r = ss.side(d, 0, 0, 1e-3);
  assert.equal(r.side, 'outside');
  assert.equal(r.evidence?.classified.checked, true);
  assert.ok(r.evidence?.classified.ray && r.evidence.classified.ray.crossings % 2 === 0);
  assert.ok(Math.abs(r.evidence!.eps - 1e-3) < 1e-15);
  using o = new Oracle(await init(), d.buffer, { checkSecondRay: true });
  const c = o.classify(0, [0.5, 0.5, 0.5]);
  assert.equal(c.side, 'inside');
  assert.ok(c.checked && c.ray!.crossings % 2 === 1);
  // Without a shell: unknown, said why.
  assert.equal(o.classify(7, [0, 0, 0]).side, 'unknown');
});

test('a thin wall: an offset deeper than the wall halved until it stays inside', { skip }, async () => {
  // A box 0.004 thick: moved 0.01 into the material from its top or bottom, the point would come out of the other
  // face; the offset is halved (to 0.0025) so it doesn't.
  const b = new BrepBuilder();
  const shell = box(b, [1, 1, 0.004]);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
  const d = b.finish();
  using ss = new RayShellSide(await init());
  for (const f of shellFaces(d)[0]!) {
    const r = ss.side(d, 0, f, -0.01);
    assert.equal(r.side, 'inside', `face ${f}: ${r.why}`);
    assert.ok(Math.abs(r.evidence!.eps) < 0.004 || f > 1, `face ${f}'s offset ${r.evidence!.eps}`);
  }
});

test('three shells nested: a lump inside a void inside the outer shell', { skip }, async () => {
  const b = new BrepBuilder();
  const outer = box(b, [10, 10, 10]), hole = box(b, [6, 6, 6], [2, 2, 2], 100);
  const lump = box(b, [2, 2, 2], [4, 4, 4], 200);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: outer, sense: true },
    { ref: hole, sense: false }, { ref: lump, sense: true }] }) });
  using o = new Oracle(await init(), b.finish().buffer);
  assert.deepEqual(o.nesting(0), [-1, 0, 1]);
});

test('nesting by the body\'s members, not the shell table\'s rows: the void\'s shell built first', { skip }, async () => {
  const b = new BrepBuilder();
  const hole = box(b, [1, 1, 1], [1, 1, 1], 100), outer = box(b, [4, 4, 4]);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: outer, sense: true },
    { ref: hole, sense: false }] }) });
  using o = new Oracle(await init(), b.finish().buffer);
  assert.deepEqual(o.nesting(0), [-1, 0]);
});
