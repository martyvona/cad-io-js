import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RENDER } from '../src/style.ts';
import { fromQuery, renderChanges, toQuery, type ViewState } from '../src/view-state.ts';

const roundTrip = (s: ViewState) => fromQuery(new URLSearchParams(toQuery(s)));

test('view state: every field through the query and back; numbers to 6 decimals; repeated paths kept in order', () => {
  const s: ViewState = {
    view: 'top',
    camera: { position: [1.23456789, -2, 3], target: [0, 0, 0.5], up: [0, 0, 1], height: 125.5 },
    cut: { x: { at: 12.5, flip: false }, z: { at: -3, flip: true } }, caps: false,
    render: { ao: false, smaa: true, edges: false, shininess: 50, aoIntensity: 2.5,
      aoRadius: 16, aoQuality: 'Low', edgeStyle: 'thin', edgeWidth: 2.5, specular: 0.25, ambient: 0.8, light: 3,
      capStyle: 'parts', hatchWidth: 2.25 },
    tree: { open: false, detail: true }, pick: 'detail', instances: true,
    hidden: ['as1/plate', 'as1/a%2Fb:2/nut'], shown: ['as1/plate/edges'],
    opacity: [{ path: 'as1/a%2Fb:2/nut', alpha: 0.3 }, { path: 'as1/rod', alpha: 'default' },
      { path: 'as1/bolt', alpha: 1 }], selected: ['as1/rod/face#78'],
  };
  const { state, problems } = roundTrip(s);
  assert.deepEqual(problems, []);
  assert.deepEqual(state, { ...s, camera: { ...s.camera!, position: [1.234568, -2, 3] } });
  // Through a real address and back (paths with %, /, : survive the URL's own encoding).
  const url = new URL('http://h/?model=as1.stp');
  for (const [k, v] of toQuery(s)) url.searchParams.append(k, v);
  assert.deepEqual(fromQuery(new URL(url.href).searchParams).state.hidden, s.hidden);
  assert.deepEqual(fromQuery(new URL(url.href).searchParams).state.opacity, s.opacity);
  // Absent fields stay absent; an empty cut list says every plane is off.
  assert.deepEqual(roundTrip({}).state, {});
  assert.deepEqual(roundTrip({ cut: {} }).state, { cut: {} });
  // The camera's pan: two more numbers, read back; ten still read (no pan).
  const panned = roundTrip({ camera: { ...s.camera!, pan: [12.5, -3] } }).state.camera!;
  assert.deepEqual(panned.pan, [12.5, -3]);
  assert.equal(roundTrip({ camera: s.camera! }).state.camera!.pan, undefined);
  assert.equal(fromQuery(new URLSearchParams('camera=1,2,3,4,5,6,7,8,9,10,11')).problems.length, 1);
  // Older links' centring (removed, the user, 2026-10-30) is passed over.
  assert.deepEqual(fromQuery(new URLSearchParams('centered=1&caps=0')), { state: { caps: false }, problems: [] });
});

test('view state: malformed values left out, each with a message', () => {
  const { state, problems } = fromQuery(new URLSearchParams('view=sideways&camera=1,2,3&cut=w:1&cut=x:a&cut=y:1:up'
    + '&aoQuality=Best&shininess=-1&pick=face&tree=0&edgeStyle=bold&capStyle=onshape&specular=-1&hatchWidth=x'));
  assert.deepEqual(state, { cut: {}, tree: { open: false } });
  assert.equal(problems.length, 12, problems.join('\n'));
  assert.deepEqual(fromQuery(new URLSearchParams('camera=0,0,1,0,0,0,0,1,0,0')).problems.length, 1);
  // Opacities: a number from 0 to 1, or default (the file's), then a path.
  const alpha = fromQuery(new URLSearchParams('alpha=2:a&alpha=x:a&alpha=0.5:&alpha=a&alpha=-0.1:a&alpha=0:a:2' +
    '&alpha=default:b&alpha=Default:b'));
  assert.deepEqual([alpha.state.opacity, alpha.problems.length], [[{ path: 'a:2', alpha: 0 },
    { path: 'b', alpha: 'default' }], 6]);
});

test('render changes: only what differs from the defaults', () => {
  assert.deepEqual(renderChanges(DEFAULT_RENDER), {});
  assert.deepEqual(renderChanges({ ...DEFAULT_RENDER, ao: false, shininess: 10 }), { ao: false, shininess: 10 });
  // Caps in part colours by default (the user, 2026-10-27), so a link to the drawing style says so.
  assert.deepEqual(renderChanges({ ...DEFAULT_RENDER, capStyle: 'drawing' }), { capStyle: 'drawing' });
  assert.equal(DEFAULT_RENDER.capStyle, 'parts');
});
