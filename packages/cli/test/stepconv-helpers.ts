// What stepconv's tests (stepconv*.test.ts, split so node --test runs them as parallel processes) share: the corpus
// files, whether the backends are built, a scratch directory per process, and stepconv run in process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as THREE from 'three';
import { stepconv } from '../src/index.ts';

export const root = path.resolve(import.meta.dirname, '../../..');
export const cube = path.join(root,
  'test_corpus/third_party/occt-import-js/test/testfiles/cube-10x10mm/Cube 10x10.stp');
export const assembly = path.join(root,
  'test_corpus/third_party/gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');
export const wireframe = path.join(root,
  'test_corpus/third_party/gkv311-opencascade-dataset/step/trj4_k1_geo-pe-203.stp');
export const occtBuilt = fs.existsSync(path.join(root, 'packages/tess-occt/dist/occt_tess.wasm'));
export const truckBuilt = fs.existsSync(path.join(root, 'packages/tess-truck/dist/tess_truck.wasm'));
export const skip = !occtBuilt ? 'tess-occt not built' : !fs.existsSync(assembly) ? 'corpus not fetched' : false;

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stepconv-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

export function sink() {
  const chunks: Buffer[] = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}
export async function run(args: string[], stdin: Readable = Readable.from([])) {
  const out = sink(), err = sink();
  const code = await stepconv(args, { stdout: out.stream, stderr: err.stream, stdin });
  return { code, stdout: out.text(), stderr: err.text() };
}
export const load = (json: string) => new THREE.ObjectLoader().parse(JSON.parse(json));
export const triangles = (o: THREE.Object3D) => {
  let n = 0;
  o.traverse((x) => { if (x instanceof THREE.Mesh) n += x.geometry.index!.count / 3; });
  return n;
};

export const hidden = path.join(root,
  'test_corpus/third_party/nist-pmi-models/NIST-PMI-STEP-Files/NIST-PMI-STEP-Files/nist_ctc_02_asme1_ap242-e2.stp');
