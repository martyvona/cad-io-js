import assert from 'node:assert/strict';
import { test } from 'node:test';
import { details } from '../src/details.ts';
import { NodeModel } from '../src/model.ts';
import { problemIds } from '../src/problems.ts';
import { StepGraph } from '../src/step.ts';
import { formatIds, nodesWithIds, parseIds, partsWithFaces, stepIdsOf } from '../src/step-ids.ts';
import { plate, scene } from './fixtures.ts';

test('parse ids: whitespace or commas, # or not, #a#b as two; anything else not understood; each once', () => {
  assert.deepEqual(parseIds(' #12 345\n#6,7\t#12#34 '), { ids: [12, 345, 6, 7, 34], bad: [] });
  assert.deepEqual(parseIds('#12 abc 3x #  ##4 5'), { ids: [12, 5], bad: ['abc', '3x', '#', '##4'] });
  assert.deepEqual(parseIds(''), { ids: [], bad: [] });
});

test('format ids: #-prefixed, space-separated; cut at a space with ... past the limit; read back by parseIds', () => {
  assert.equal(formatIds([1, 22, 333]), '#1 #22 #333');
  const many = Array.from({ length: 30 }, (_, i) => 1000 + i);
  const short = formatIds(many, 50);
  assert.ok(short.length <= 50 && short.endsWith(' ...') && short.startsWith('#1000 #1001 '), short);
  assert.equal(formatIds(many, 1000).length, formatIds(many).length);
  assert.deepEqual(parseIds(formatIds(many)).ids, many);
  // Only whole ids, as many as fit, the ... right after the last (the user, 2026-10-28), whatever their lengths.
  for (let seed = 1; seed < 200; seed++) {
    const ids = Array.from({ length: 20 }, (_, i) => (seed * 7919 + i * 104729) % 10 ** (1 + (seed + i) % 9));
    const shown = formatIds(ids, 50);
    const full = formatIds(ids);
    if (full.length <= 50) {
      assert.equal(shown, full);
      continue;
    }
    assert.ok(shown.length <= 50 && shown.endsWith(' ...'), shown);
    const kept = shown.slice(0, -4).split(' ');
    assert.deepEqual(kept, full.split(' ').slice(0, kept.length), shown);
    // The next id wouldn't have fit.
    assert.ok(shown.length + 1 + full.split(' ')[kept.length]!.length > 50, shown);
  }
  // An id longer than the room: shown whole all the same.
  assert.equal(formatIds([12345678901, 2], 10), '#12345678901 ...');
});

test('problem ids: warnings and errors only, errors first, each once', () => {
  const src = (id: number) => ({ format: 'step', id });
  assert.deepEqual(problemIds([{ severity: 'warning', message: 'a', source: src(3) },
    { severity: 'info', message: 'b', source: src(9) }, { severity: 'error', message: 'c', source: src(5) },
    { severity: 'warning', message: 'd', source: src(3) }, { severity: 'warning', message: 'e' }]), [5, 3]);
});

test('step ids: assemblies (occurrence, then component), parts (representation), faces; selected and found', () => {
  const s = scene();
  s.roots[0]!.sources = [{ format: 'step', id: 50 }];
  s.components[0]!.sources = [{ format: 'step', id: 51 }];
  s.components[0]!.children[0]!.sources = [{ format: 'step', id: 60 }];
  s.parts[0]!.sources = [{ format: 'step', id: 70 }];
  const graph = new StepGraph(s, 'model');
  graph.addMesh(0, plate());
  const model = new NodeModel(graph.root, graph);
  const byName = (name: string) => model.nodes.filter((n) => n.name === name).map((n) => n.id);
  const asm = byName('asm')[0]!;
  assert.deepEqual(stepIdsOf(model, [asm]), [50, 51]);
  const plates = byName('plate');
  assert.equal(plates.length, 3);
  assert.deepEqual(stepIdsOf(model, plates), [70]);
  assert.deepEqual(stepIdsOf(model, byName('wire')), []);
  // Every placement of the part; faces only once their nodes exist.
  assert.deepEqual(nodesWithIds(model, new Set([70])), plates);
  assert.deepEqual(nodesWithIds(model, new Set([7])), []);
  model.setDetail(true);
  assert.deepEqual(partsWithFaces(model, new Set([7])), plates);
  for (const p of plates) model.children(p);
  const faces = nodesWithIds(model, new Set([7]));
  assert.ok(faces.length > 0 && faces.every((id) => model.nodes[id]!.kind === 'face'));
  assert.deepEqual(stepIdsOf(model, faces), [7]);
  // The details' line.
  assert.ok(details(model, [asm, plates[0]!]).includes('STEP IDs: #50 #51 #70'));
  assert.ok(!details(model, byName('wire')).some((l) => l.startsWith('STEP IDs')));
});
