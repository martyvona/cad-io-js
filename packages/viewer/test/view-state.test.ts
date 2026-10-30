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
    hidden: ['as1/plate', 'as1/a%2Fb:2/nut'], selected: ['as1/rod/face#78'],
  };
  const { state, problems } = roundTrip(s);
  assert.deepEqual(problems, []);
  assert.deepEqual(state, { ...s, camera: { ...s.camera!, position: [1.234568, -2, 3] } });
  // Through a real address and back (paths with %, /, : survive the URL's own encoding).
  const url = new URL('http://h/?model=as1.stp');
  for (const [k, v] of toQuery(s)) url.searchParams.append(k, v);
  assert.deepEqual(fromQuery(new URL(url.href).searchParams).state.hidden, s.hidden);
  // Absent fields stay absent; an empty cut list says every plane is off.
  assert.deepEqual(roundTrip({}).state, {});
  assert.deepEqual(roundTrip({ cut: {} }).state, { cut: {} });
  // Older links' centring (removed, the user, 2026-10-30) is passed over.
  assert.deepEqual(fromQuery(new URLSearchParams('centered=1&caps=0')), { state: { caps: false }, problems: [] });
});

test('view state: malformed values left out, each with a message', () => {
  const { state, problems } = fromQuery(new URLSearchParams('view=sideways&camera=1,2,3&cut=w:1&cut=x:a&cut=y:1:up'
    + '&aoQuality=Best&shininess=-1&pick=face&tree=0&edgeStyle=bold&capStyle=onshape&specular=-1&hatchWidth=x'));
  assert.deepEqual(state, { cut: {}, tree: { open: false } });
  assert.equal(problems.length, 12, problems.join('\n'));
  assert.deepEqual(fromQuery(new URLSearchParams('camera=0,0,1,0,0,0,0,1,0,0')).problems.length, 1);
});

test('render changes: only what differs from the defaults', () => {
  assert.deepEqual(renderChanges(DEFAULT_RENDER), {});
  assert.deepEqual(renderChanges({ ...DEFAULT_RENDER, ao: false, shininess: 10 }), { ao: false, shininess: 10 });
  // Caps in part colours by default (the user, 2026-10-27), so a link to the drawing style says so.
  assert.deepEqual(renderChanges({ ...DEFAULT_RENDER, capStyle: 'drawing' }), { capStyle: 'drawing' });
  assert.equal(DEFAULT_RENDER.capStyle, 'parts');
});
