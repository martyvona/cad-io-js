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
      { path: 'as1/bolt', alpha: 1 }], triangleEdges: [{ path: 'as1/a%2Fb:2/nut', on: true },
      { path: 'as1/rod', on: false }], selected: ['as1/rod/face#78'],
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
  // Older links' centring (removed) is passed over.
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
  const tri = fromQuery(new URLSearchParams('tri=on:a:2&tri=yes:a&tri=off:&tri=a'));
  assert.deepEqual([tri.state.triangleEdges, tri.problems.length], [[{ path: 'a:2', on: true }], 3]);
});

test('render changes: only what differs from the defaults', () => {
  assert.deepEqual(renderChanges(DEFAULT_RENDER), {});
  assert.deepEqual(renderChanges({ ...DEFAULT_RENDER, ao: false, shininess: 10 }), { ao: false, shininess: 10 });
  // Caps in part colours by default, so a link to the drawing style says so.
  assert.deepEqual(renderChanges({ ...DEFAULT_RENDER, capStyle: 'drawing' }), { capStyle: 'drawing' });
  assert.equal(DEFAULT_RENDER.capStyle, 'parts');
});

test('backendsFromQuery: backend= and fallback= by name, minAngle= and keepFailing= only where tess-cadio meshes; '
  + 'what\'s malformed said and left out', async () => {
  const { backendsFromQuery } = await import('../src/view-state.ts');
  const occt = { backend: 'occt', fallback: 'smlib' } as const;
  const cadio = { backend: 'cadio', fallback: 'smlib' } as const;
  const q = (s: string, cur: { backend: 'occt' | 'cadio'; fallback: 'smlib' } = occt) =>
    backendsFromQuery(new URLSearchParams(s), cur);
  assert.deepEqual(q(''), { problems: [] });
  assert.deepEqual(q('backend=cadio'), { meshing: { backend: 'cadio' }, problems: [] });
  assert.deepEqual(q('backend=truck&fallback=none'), { meshing: { backend: 'truck', fallback: 'none' }, problems: [] });
  assert.deepEqual(q('backend=cadio&minAngle=0&keepFailing=1'), { meshing: { backend: 'cadio', minAngle: 0,
    keepFailing: true }, problems: [] });
  // The fallback's tess-cadio counts; so do the settings' backends where the address names none.
  assert.deepEqual(q('fallback=cadio&minAngle=20.5'), { meshing: { fallback: 'cadio', minAngle: 20.5 }, problems: [] });
  assert.deepEqual(q('keepFailing=1', cadio), { meshing: { keepFailing: true }, problems: [] });
  assert.deepEqual(q('keepFailing=0'), { meshing: { keepFailing: false }, problems: [] });
  assert.deepEqual(q('minAngle=5&keepFailing=1'), { problems: [
    'minAngle: only tess-cadio (backend=cadio or fallback=cadio) reads it: ignored',
    'keepFailing: only tess-cadio (backend=cadio or fallback=cadio) has it: ignored'] });
  // A backend of the address's own replaces the settings' tess-cadio.
  assert.deepEqual(q('backend=occt&minAngle=5', cadio), { meshing: { backend: 'occt' }, problems: [
    'minAngle: only tess-cadio (backend=cadio or fallback=cadio) reads it: ignored'] });
  for (const v of ['31', '-1', 'x', '']) {
    assert.deepEqual(q(`minAngle=${v}`, cadio), { problems: [`minAngle: not a number of degrees from 0 to 30: ${v}`] });
  }
  assert.deepEqual(q('backend=ours&fallback=cad'), { problems: ['backend: not one of occt, truck, smlib, cadio: ours',
    'fallback: not one of occt, truck, smlib, cadio, none: cad'] });
});

test('deflectionFromQuery: profile= by name, linearDeflection= and angularDeflection= making it custom (the other '
  + 'the settings\'), what\'s malformed said and left out; deflectionQuery writes what it reads back', async () => {
  const { deflectionFromQuery, deflectionQuery } = await import('../src/view-state.ts');
  const { profileSettings } = await import('../src/tessellation.ts');
  const cur = { linearDeflection: 0.1, angularDeflection: 17 };
  const q = (s: string) => deflectionFromQuery(new URLSearchParams(s), cur);
  assert.deepEqual(q(''), { problems: [] });
  assert.deepEqual(q('profile=fine'), { meshing: profileSettings('fine'), problems: [] });
  assert.deepEqual(q('profile=coarse'), { meshing: profileSettings('coarse'), problems: [] });
  assert.deepEqual(q('profile=custom'), { meshing: { profile: 'custom', ...cur }, problems: [] });
  // Below the control's least (0.001 mm): a deflection that fails a face by construction.
  assert.deepEqual(q('linearDeflection=1.2e-6'), { meshing: { profile: 'custom', linearDeflection: 1.2e-6,
    angularDeflection: 17 }, problems: [] });
  assert.deepEqual(q('angularDeflection=90'), { meshing: { profile: 'custom', linearDeflection: 0.1,
    angularDeflection: 90 }, problems: [] });
  assert.deepEqual(q('linearDeflection=0.5&angularDeflection=20&profile=custom'), { meshing: { profile: 'custom',
    linearDeflection: 0.5, angularDeflection: 20 }, problems: [] });
  assert.deepEqual(q('profile=fine&linearDeflection=0.5'), { meshing: { profile: 'custom', linearDeflection: 0.5,
    angularDeflection: 17 }, problems: ['profile=fine with a deflection: custom'] });
  assert.deepEqual(q('profile=best'), { problems: ['profile: not one of coarse, medium, fine, custom: best'] });
  for (const v of ['0', '-1', 'x', '', 'Infinity']) {
    assert.deepEqual(q(`linearDeflection=${v}`), { problems: [
      `linearDeflection: not a positive number of millimetres: ${v}`] });
  }
  for (const v of ['0', '91', 'x']) {
    assert.deepEqual(q(`angularDeflection=${v}`), { problems: [
      `angularDeflection: not a number of degrees above 0, at most 90: ${v}`] });
  }
  // A bad deflection beside a good one: the good one, custom.
  assert.deepEqual(q('linearDeflection=x&angularDeflection=30'), { meshing: { profile: 'custom', linearDeflection: 0.1,
    angularDeflection: 30 }, problems: ['linearDeflection: not a positive number of millimetres: x'] });
  // Written back: the device's profile not at all, another by name, custom by its deflections; each read back.
  assert.deepEqual(deflectionQuery(profileSettings('medium'), 'medium'), []);
  assert.deepEqual(deflectionQuery(profileSettings('medium'), 'coarse'), [['profile', 'medium']]);
  // No device profile (Include device defaults): always written, the device's too.
  assert.deepEqual(deflectionQuery(profileSettings('medium')), [['profile', 'medium']]);
  assert.deepEqual(deflectionQuery({ profile: 'custom', linearDeflection: 0.5, angularDeflection: 20 }),
    [['linearDeflection', '0.5'], ['angularDeflection', '20']]);
  for (const m of [profileSettings('fine'), { profile: 'custom' as const, linearDeflection: 1.2e-6,
    angularDeflection: 22.5 }]) {
    const back = deflectionFromQuery(new URLSearchParams(deflectionQuery(m, 'medium')), cur);
    assert.deepEqual(back, { meshing: m, problems: [] });
  }
});

test('the settings\' tess-cadio: its minAngle asked (radians) only where it meshes and not its own default; the '
  + 'level wanted with it; its debugging switch only where it meshes', async () => {
  const { defaultSettings, keepsFailing, minAngleOf, usesCadio, wantedOf } = await import('../src/tessellation.ts');
  const { DEFAULT_MIN_ANGLE_DEGREES } = await import('tess-cadio/options');
  const d = defaultSettings('medium');
  assert.equal(d.backend, 'occt');
  assert.equal(d.fallback, 'smlib');
  assert.equal(d.minAngle, DEFAULT_MIN_ANGLE_DEGREES);
  assert.equal(d.keepFailing, false);
  const s = (o: object) => ({ ...d, ...o });
  assert.ok(!usesCadio(d) && usesCadio(s({ backend: 'cadio' })) && usesCadio(s({ fallback: 'cadio' })));
  // (A fallback that is the backend is none.)
  assert.ok(!usesCadio(s({ backend: 'occt', fallback: 'none' })));
  assert.equal(minAngleOf(s({ minAngle: 5 })), undefined);
  assert.equal(minAngleOf(s({ backend: 'cadio' })), undefined);
  assert.equal(minAngleOf(s({ backend: 'cadio', minAngle: 0 })), 0);
  assert.equal(minAngleOf(s({ fallback: 'cadio', minAngle: 18 })), Math.PI / 10);
  assert.equal(minAngleOf({ backend: 'cadio', fallback: 'none' }), undefined, 'an older recording\'s settings');
  assert.deepEqual(wantedOf(d), { linearDeflection: 0.1, angularDeflection: Math.PI / 12 });
  assert.deepEqual(wantedOf(s({ backend: 'cadio', minAngle: 0 })), { linearDeflection: 0.1,
    angularDeflection: Math.PI / 12, minAngle: 0 });
  assert.ok(!keepsFailing(s({ keepFailing: true })) && keepsFailing(s({ backend: 'cadio', keepFailing: true }))
    && !keepsFailing(s({ backend: 'cadio' })));
});

test('healingFromQuery: heal=1 or 0, healOn and healOff from the defaults turning healing on, what\'s malformed '
  + 'said and left out', async () => {
  const { healingFromQuery } = await import('../src/view-state.ts');
  const { defaultFixes } = await import('../src/tessellation.ts');
  const q = (s: string) => healingFromQuery(new URLSearchParams(s));
  const d = defaultFixes();
  assert.deepEqual(q(''), { problems: [] });
  assert.deepEqual(q('heal=1'), { meshing: { heal: true, healFixes: d }, problems: [] });
  assert.deepEqual(q('heal=0'), { meshing: { heal: false, healFixes: d }, problems: [] });
  assert.deepEqual(q('healOff=strayPole,pcurveEnds'), { meshing: { heal: true, healFixes: { ...d, strayPole: false,
    pcurveEnds: false } }, problems: [] });
  // pcurveMissing: an alias of elementary and free-form.
  const both = { pcurveMissingOnElementary: true, pcurveMissingOnFreeForm: true };
  assert.deepEqual(q('heal=1&healOn=pcurveMissing'), { meshing: { heal: true, healFixes: { ...d, ...both } },
    problems: [] });
  assert.deepEqual(q('healOn=pcurveMissingOnFreeForm'), { meshing: { heal: true, healFixes: { ...d,
    pcurveMissingOnFreeForm: true } }, problems: [] });
  assert.deepEqual(q('healOn=nope,pcurveMissing'), { meshing: { heal: true, healFixes: { ...d, ...both } },
    problems: [`healOn: not one of strayPole, pcurveMissingOnPlane, pcurveMissingOnElementary, `
      + 'pcurveMissingOnFreeForm, pcurveReparam, pcurveReplace, pcurveEnds, edgeTolerance, vertexTolerance, '
      + 'orientShells: nope'] });
  assert.deepEqual(q('healOn=strayPole,pcurveMissing&healOff=strayPole'), { meshing: { heal: true, healFixes: { ...d,
    ...both } }, problems: ['healOn and healOff: strayPole in both, left as it is'] });
  assert.deepEqual(q('heal=0&healOff=strayPole'), { meshing: { heal: false, healFixes: d },
    problems: ['heal=0 with healOn, healOff or healFit: ignored'] });
  assert.deepEqual(q('healFit=0.01'), { meshing: { heal: true, healFixes: d, healFit: 0.01 }, problems: [] });
  assert.deepEqual(q('heal=1&healFit=0'), { meshing: { heal: true, healFixes: d },
    problems: ['healFit: not a positive number of mm: 0'] });
  assert.deepEqual(q('healFit=x'), { problems: ['healFit: not a positive number of mm: x'] });
  assert.deepEqual(q('heal=0&healFit=1'), { meshing: { heal: false, healFixes: d },
    problems: ['heal=0 with healOn, healOff or healFit: ignored'] });
  assert.deepEqual(q('healOff=nope'), { problems: ['healOff: not one of strayPole, pcurveMissingOnPlane, '
    + 'pcurveMissingOnElementary, pcurveMissingOnFreeForm, pcurveReparam, pcurveReplace, pcurveEnds, edgeTolerance, '
    + 'vertexTolerance, orientShells: nope'] });
});

test('healingOf: the fixes on, and the fit tolerance where it isn\'t cad-heal\'s default (an older recording\'s none)',
  async () => {
  const { defaultFixes, healingOf } = await import('../src/tessellation.ts');
  const { PCURVE_FIT_TOLERANCE } = await import('cad-heal/options');
  const on = { heal: true, healFixes: defaultFixes() };
  assert.equal(healingOf(on), healingOf({ ...on, healFit: PCURVE_FIT_TOLERANCE }), 'the default: no fit said');
  assert.equal(healingOf({ ...on, healFit: 0.01 }), `${healingOf(on)};fit=0.01`);
  assert.equal(healingOf({ heal: false, healFit: 0.01 }), '');
});
