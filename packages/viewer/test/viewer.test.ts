import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as THREE from 'three';
import { Y_UP_METRES } from 'cad-scene';
import { main, parseArgs } from '../bin/viewer.ts';
import { contentFile, contentMiddleware, contentUrl } from '../server/content.ts';
import { DEFAULTS, envFromOptions, optionsFromEnv } from '../server/options.ts';
import { clipTo, fit, MARGIN, setView, VIEWS, type ViewName } from '../src/camera.ts';
import { formatOf, FROM_Y_UP_METRES, nativeFrame } from '../src/formats.ts';
import { Frames } from '../src/frames.ts';
import { stats, visibleBox } from '../src/viewer.ts';

/** A stand-in for animation frames at `hz`, with a clock. */
function fakeClock(hz = 60) {
  let now = 0;
  let queue: (() => void)[] = [];
  return {
    clock: { now: () => now, next: (f: () => void) => void queue.push(f) },
    /** Runs one display frame. */
    tick() { now += 1000 / hz; const q = queue; queue = []; for (const f of q) f(); },
    pending: () => queue.length,
  };
}

test('frames: drawn only when requested, once per request burst, and not after the draw says it is done', () => {
  const c = fakeClock();
  let draws = 0;
  const frames = new Frames(() => { draws++; return false; }, 1000 / 30, c.clock);
  for (let i = 0; i < 10; i++) c.tick();
  assert.equal(draws, 0);
  frames.request();
  frames.request();
  frames.request();
  for (let i = 0; i < 10; i++) c.tick();
  assert.equal(draws, 1);
  assert.equal(c.pending(), 0);
});

test('frames: idle at once when nothing is scheduled, else just after the last frame the draw wants', async () => {
  const c = fakeClock();
  let more = 2;
  let draws = 0;
  const frames = new Frames(() => { draws++; return more-- > 0; }, 1000 / 30, c.clock);
  let idle = false;
  await frames.whenIdle();
  frames.request();
  void frames.whenIdle().then(() => { idle = true; });
  const at: number[] = [];
  for (let i = 0; i < 12; i++) {
    c.tick();
    await Promise.resolve();
    if (idle && !at.length) at.push(draws);
  }
  // Three draws (the first, then two more wanted): idle after the third, not before.
  assert.deepEqual(at, [3]);
});

test('frames: at most 30 a second however fast the display, while the draw wants more', () => {
  for (const hz of [60, 120, 144]) {
    const c = fakeClock(hz);
    let draws = 0;
    let more = true;
    const frames = new Frames(() => { draws++; return more; }, 1000 / 30, c.clock);
    frames.request();
    for (let i = 0; i < hz; i++) c.tick();
    assert.ok(draws >= 28 && draws <= 31, `${hz} Hz: ${draws} draws in a second`);
    more = false;
    c.tick(); c.tick(); c.tick();
    const after = draws;
    for (let i = 0; i < hz; i++) c.tick();
    assert.equal(draws, after, `${hz} Hz: drawn after done`);
  }
  // At 60 Hz, every second display frame: exactly 30.
  const c = fakeClock(60);
  let draws = 0;
  new Frames(() => { draws++; return true; }, 1000 / 30, c.clock).request();
  for (let i = 0; i < 60; i++) c.tick();
  assert.equal(draws, 30);
});

const camera = (aspect = 2) => {
  const cam = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, -1, 1);
  cam.up.set(0, 0, 1);
  cam.position.set(1, -1, 1);
  return cam;
};
const corners = (b: THREE.Box3) => Array.from({ length: 8 }, (_, i) => new THREE.Vector3(
  i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
const ndc = (cam: THREE.OrthographicCamera, p: THREE.Vector3) => {
  cam.updateMatrixWorld();
  return p.clone().project(cam);
};

test('views: each looks along its axis with its up; front, back, left and right have Z up, top +Y, bottom -Y', () => {
  const box = new THREE.Box3(new THREE.Vector3(-10, -20, -30), new THREE.Vector3(50, 40, 30));
  const c = new THREE.Vector3(20, 10, 0);
  // [view, the world axis that points right on screen, the one that points up]
  const expected: [ViewName, number[], number[]][] = [
    ['front', [1, 0, 0], [0, 0, 1]], ['back', [-1, 0, 0], [0, 0, 1]], ['left', [0, -1, 0], [0, 0, 1]],
    ['right', [0, 1, 0], [0, 0, 1]], ['top', [1, 0, 0], [0, 1, 0]], ['bottom', [1, 0, 0], [0, -1, 0]],
  ];
  for (const [v, right, up] of expected) {
    const cam = camera();
    const target = new THREE.Vector3();
    setView(cam, target, v, box, 2);
    assert.ok(target.equals(c), `${v}: target ${target.toArray()}`);
    const d = cam.getWorldDirection(new THREE.Vector3());
    assert.ok(d.distanceTo(new THREE.Vector3(...VIEWS[v].dir).negate()) < 1e-12, `${v}: looks along ${d.toArray()}`);
    const r = ndc(cam, c.clone().add(new THREE.Vector3(...right)));
    const u = ndc(cam, c.clone().add(new THREE.Vector3(...up)));
    assert.ok(r.x > 0 && Math.abs(r.y) < 1e-9, `${v}: right is ${right}`);
    assert.ok(u.y > 0 && Math.abs(u.x) < 1e-9, `${v}: up is ${up}`);
  }
});

test('fit: the box fills the viewport less the margin, in its limiting direction, from any direction', () => {
  const box = new THREE.Box3(new THREE.Vector3(100, 200, -5), new THREE.Vector3(400, 260, 95));
  for (const aspect of [0.5, 1, 2.5]) {
    for (const v of Object.keys(VIEWS) as ViewName[]) {
      const cam = camera(aspect);
      const target = new THREE.Vector3();
      setView(cam, target, v, box, aspect);
      cam.zoom = 3;
      // Turned a little, then fitted again from there.
      cam.position.applyAxisAngle(new THREE.Vector3(0.3, 0.2, 1).normalize(), 0.7);
      assert.ok(fit(cam, target, box, aspect));
      assert.equal(cam.zoom, 1);
      const ps = corners(box).map((p) => ndc(cam, p));
      const mx = Math.max(...ps.map((p) => Math.abs(p.x)));
      const my = Math.max(...ps.map((p) => Math.abs(p.y)));
      assert.ok(mx <= 1 / (1 + 2 * MARGIN) + 1e-9 && my <= 1 / (1 + 2 * MARGIN) + 1e-9, `${v} ${aspect}: ${mx} ${my}`);
      assert.ok(Math.abs(Math.max(mx, my) - 1 / (1 + 2 * MARGIN)) < 1e-9, `${v} ${aspect}: not filled, ${mx} ${my}`);
      assert.ok(Math.abs(cam.right / cam.top - aspect) < 1e-12);
    }
  }
  // Up along the view (looking straight down with Z up): any right will do, but the frustum must match it.
  const down = camera(2);
  down.position.set(0, 0, 10);
  const t = new THREE.Vector3();
  assert.ok(fit(down, t, box, 2));
  const ps = corners(box).map((p) => ndc(down, p));
  const m = Math.max(...ps.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
  assert.ok(Math.abs(m - 1 / (1 + 2 * MARGIN)) < 1e-9, `looking down: ${m}`);
  // An empty box changes nothing.
  const cam = camera();
  const before = cam.position.clone();
  assert.equal(fit(cam, new THREE.Vector3(), new THREE.Box3(), 2), false);
  assert.ok(cam.position.equals(before));
});

test('clipTo: near and far around the bounding sphere wherever the camera is, behind it included', () => {
  const sphere = new THREE.Sphere(new THREE.Vector3(10, 20, 30), 50);
  const cam = camera();
  for (const [pos, look] of [[[200, 0, 0], [0, 0, 0]], [[10, 20, 30], [10, 20, 0]], [[10, 20, 60], [10, 20, 100]]]) {
    cam.position.set(...pos as [number, number, number]);
    cam.lookAt(...look as [number, number, number]);
    cam.updateMatrixWorld();
    clipTo(cam, sphere);
    const d = new THREE.Vector3();
    cam.getWorldDirection(d);
    for (const s of [-1, 1]) {
      const p = sphere.center.clone().addScaledVector(d, s * sphere.radius);
      const z = p.project(cam).z;
      assert.ok(z > -1 && z < 1, `${pos}: depth ${z} outside`);
    }
  }
});

test('formats: by extension, any case', () => {
  assert.equal(formatOf('a.STP'), 'step');
  assert.equal(formatOf('dir.x/a.step'), 'step');
  assert.equal(formatOf('a.stpZ'), 'step');
  assert.equal(formatOf('a.glb'), 'glb');
  assert.equal(formatOf('a.gltf'), 'gltf');
  assert.equal(formatOf('a.json'), 'threejs');
  assert.equal(formatOf('a.bin'), undefined);
  assert.equal(formatOf('README'), undefined);
});

test("formats: frames to the world's millimetres, Z up; ours read back where they were", () => {
  // (x, y, z) m, Y up -> (x, -z, y) mm, Z up; written out, not taken from cad-scene.
  const p = new THREE.Vector3(1, 2, 3).applyMatrix4(FROM_Y_UP_METRES);
  assert.ok(p.distanceTo(new THREE.Vector3(1000, -3000, 2000)) < 1e-9, `${p.toArray()}`);
  const group = (userData: object) => Object.assign(new THREE.Group(), { userData });
  const isFromYUp = (m: THREE.Matrix4) => m.elements.every(
    (x, i) => Math.abs(x - FROM_Y_UP_METRES.elements[i]!) < 1e-12);
  assert.ok(isFromYUp(nativeFrame('glb', group({}))));
  assert.ok(isFromYUp(nativeFrame('gltf', group({ unit: 'millimetre', up: 'z' }))));
  assert.ok(isFromYUp(nativeFrame('threejs', group({}))));
  assert.ok(isFromYUp(nativeFrame('threejs', group({ unit: 'millimetre', up: 'z' }))));
  assert.ok(nativeFrame('threejs', group({ unit: 'millimetre' })).equals(new THREE.Matrix4()));
  assert.ok(nativeFrame('step', group({})).equals(new THREE.Matrix4()));
  // Our exporters' root (Y_UP_METRES) undone: the identity.
  const back = new THREE.Matrix4().fromArray(Y_UP_METRES).premultiply(FROM_Y_UP_METRES);
  assert.ok(back.elements.every((x, i) => Math.abs(x - new THREE.Matrix4().elements[i]!) < 1e-12));
});

test('visibleBox and stats: hidden objects and their descendants left out of the box, counted in stats', () => {
  const root = new THREE.Group();
  const box = (x: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    m.position.x = x;
    return m;
  };
  const shown = box(0);
  const hiddenParent = new THREE.Group();
  hiddenParent.visible = false;
  hiddenParent.add(box(100));
  const hidden = box(-100);
  hidden.visible = false;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(
    [v(0, 0, 0), v(0, 0, 10), v(0, 0, 10), v(0, 5, 10)]));
  root.add(shown, hiddenParent, hidden, lines);
  root.position.set(0, 0, 1);
  const b = visibleBox(root);
  assert.deepEqual([b.min.toArray(), b.max.toArray()], [[-1, -1, 0], [1, 5, 11]]);
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), undefined, 3);
  inst.setMatrixAt(2, new THREE.Matrix4().makeTranslation(0, 0, 50));
  root.add(inst);
  assert.equal(visibleBox(root).max.z, 51.5);
  assert.deepEqual(stats(root), { objects: 7, meshes: 4, triangles: 3 * 12 + 3 * 12, segments: 2, points: 0 });
});

test('options: from the environment and back; defaults; bad values refused', () => {
  assert.deepEqual(optionsFromEnv({}), DEFAULTS);
  const o = { port: 6000, lan: true, https: 'mkcert' as const, contentRoot: '/tmp/x', certDir: '/tmp/c' };
  assert.deepEqual(optionsFromEnv(envFromOptions(o)), o);
  assert.equal(optionsFromEnv({ VIEWER_LAN: '0' }).lan, false);
  assert.throws(() => optionsFromEnv({ VIEWER_PORT: '70000' }), /VIEWER_PORT/);
  assert.throws(() => optionsFromEnv({ VIEWER_HTTPS: 'yes' }), /VIEWER_HTTPS/);
});

test('content root: files below it, nothing above or beside it, symbolic links resolved', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cad-viewer-content-')));
  const root = path.join(tmp, 'root');
  fs.mkdirSync(path.join(root, 'sub dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub dir', 'a #1.glb'), 'glb');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(tmp, 'root2.txt'), 'beside');
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(root, 'out.txt'));
  fs.symlinkSync(path.join(root, 'sub dir', 'a #1.glb'), path.join(root, 'in.glb'));
  try {
    const url = contentUrl(root, path.join(root, 'sub dir', 'a #1.glb'))!;
    assert.equal(url, '/content/sub%20dir/a%20%231.glb');
    assert.equal(contentFile(root, url), path.join(root, 'sub dir', 'a #1.glb'));
    assert.equal(contentFile(root, '/content/in.glb'), path.join(root, 'sub dir', 'a #1.glb'));
    for (const bad of ['/content/out.txt', '/content/../secret.txt', '/content/..%2Fsecret.txt',
      '/content/%2e%2e/secret.txt', '/content/sub%20dir', '/content/', '/content/nothing', '/content/a%00b',
      '/content/%E0%A4%A', '/other/x',
      '/content/../root2.txt', '/content//etc/hosts']) {
      assert.equal(contentFile(root, bad), undefined, bad);
    }
    assert.equal(contentUrl(root, path.join(tmp, 'secret.txt')), undefined);
    assert.equal(contentUrl(root, path.join(root, 'out.txt')), undefined);
    assert.equal(contentUrl(root, path.join(root, 'missing.glb')), undefined);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('content middleware: GET and HEAD with a type and length, 404 otherwise, other paths passed on', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-viewer-mw-'));
  fs.writeFileSync(path.join(tmp, 'm.glb'), 'twelve bytes');
  const mw = contentMiddleware(tmp);
  const server = http.createServer((q, s) => mw(q, s, () => void s.writeHead(299).end()));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  try {
    const get = await fetch(`${base}/content/m.glb`);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(await get.text(), 'twelve bytes');
    const head = await fetch(`${base}/content/m.glb`, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), '12');
    assert.equal((await fetch(`${base}/content/m.glb`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/content/none.glb`)).status, 404);
    assert.equal((await fetch(`${base}/index.html`)).status, 299);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cad-viewer: arguments', () => {
  const a = parseArgs(['open', 'x.glb', '--port', '6001', '--lan', '--https', 'self', '--content-root', '/tmp']);
  assert.ok(typeof a === 'object');
  assert.equal(a.command, 'open');
  assert.equal(a.file, path.resolve('x.glb'));
  assert.deepEqual(a.opts, { ...DEFAULTS, port: 6001, lan: true, https: 'self', contentRoot: path.resolve('/tmp') });
  assert.deepEqual(a.given.sort(), ['contentRoot', 'https', 'lan', 'port']);
  const s = parseArgs(['start']);
  assert.ok(typeof s === 'object' && s.given.length === 0 && s.file === undefined);
  assert.equal(parseArgs(['-h']), 'help');
  const shot = parseArgs(['shot', 'm.stp', '-o', 'out.png', '--size', '640x480', '--view', 'top', '--state',
    '?cut=x:1&ao=0', '--json', '-', '--chrome', '/c', '--theme', 'light', '--background',
    '#FFfFff']);
  assert.ok(typeof shot === 'object');
  assert.deepEqual(shot.shot, { out: path.resolve('out.png'), width: 640, height: 480, view: 'top',
    state: 'cut=x:1&ao=0', json: '-', chrome: '/c', theme: 'light', background: 0xffffff });
  const rep = parseArgs(['replay', 'r.json', '-o', 'end.png', '--json', 'out.json']);
  assert.ok(typeof rep === 'object' && rep.command === 'replay' && rep.file === path.resolve('r.json') &&
    rep.shot.out === path.resolve('end.png') && rep.shot.json === 'out.json');
  const plainShot = parseArgs(['shot', 'm.stp']);
  assert.ok(typeof plainShot === 'object' && plainShot.shot.width === 1200 && plainShot.shot.height === 800);
  for (const [argv, err] of [[[], /no command/], [['serve'], /unknown command/], [['open'], /one file/],
    [['shot'], /one file/], [['replay'], /one file/], [['replay', 'a', 'b'], /one file/],
    [['shot', 'a', '--size', '640'], /--size/], [['shot', 'a', '--size', '8x8'], /--size/],
    [['shot', 'a', '--size', '9000x10'], /--size/], [['shot', 'a', '--theme', 'grey'], /--theme/],
    [['shot', 'a', '--background', 'white'], /--background/],
    [['open', 'a', 'b'], /one file/], [['stop', 'a'], /takes no file/], [['start', '--port', 'x'], /bad port/],
    [['start', '--port'], /needs a value/], [['start', '--https', 'yes'], /self or mkcert/],
    [['start', '--frob'], /unknown option/]] as [string[], RegExp][]) {
    assert.match(String(parseArgs(argv)), err, argv.join(' '));
  }
});

test('cad-viewer: start, status, open, conflicting options, stop', { timeout: 60_000 }, async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cad-viewer-cli-')));
  const content = path.join(tmp, 'content');
  fs.mkdirSync(content);
  fs.writeFileSync(path.join(content, 'm.glb'), 'x');
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  let out = '';
  let err = '';
  const io = { out: (s: string) => void (out += s), err: (s: string) => void (err += s), runDir: path.join(tmp, 'run'),
    noBrowser: true };
  const run = async (...argv: string[]) => { out = ''; err = ''; return main(argv, io); };
  try {
    assert.equal(await run('status'), 0);
    assert.match(out, /not running/);
    // A state file left by a server that died: not running, and the file goes.
    fs.mkdirSync(io.runDir, { recursive: true });
    const stale = path.join(io.runDir, 'server.json');
    fs.writeFileSync(stale, JSON.stringify({ ...DEFAULTS, port, pid: 2 ** 22 + 1, url: 'http://localhost:1/' }));
    assert.equal(await run('status'), 0);
    assert.match(out, /not running/);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(await run('start', '--content-root', content, '--port', String(port)), 0);
    assert.match(out, new RegExp(`started http://localhost:${port}/`));
    assert.equal((await fetch(`http://localhost:${port}/content/m.glb`)).status, 200);
    assert.equal(await run('status'), 0);
    assert.match(out, new RegExp(`running http://localhost:${port}/ \\(content root ${content}`));
    // Running: open uses it (no options needed), and refuses files outside its root.
    assert.equal(await run('open', path.join(content, 'm.glb')), 0);
    assert.equal(out, `http://localhost:${port}/?model=m.glb\n`);
    assert.equal(await run('open', path.join(tmp, 'elsewhere.glb')), 1);
    assert.match(err, /isn't below the content root/);
    assert.equal(await run('start', '--port', String(port + 1)), 1);
    assert.match(err, new RegExp(`running with another port: ${port}`));
    assert.equal(await run('stop'), 0);
    assert.match(out, /stopped/);
    assert.equal(await run('stop'), 0);
    assert.match(out, /not running/);
    assert.equal(await run('start', '--content-root', path.join(tmp, 'none'), '--port', String(port)), 1);
    assert.match(err, /no content root/);
  } finally {
    await run('stop');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
