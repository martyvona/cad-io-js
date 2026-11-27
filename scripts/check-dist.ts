// The built WebAssembly modules (each package's dist/, not committed) against the sources they're built from: a test
// run on a module older than its sources tests old code, and can hang where the sources have since been fixed.
//
//   node scripts/check-dist.ts            every module present: fails, naming the packages to rebuild, if any
//                                         module's recorded inputs differ from the working tree's
//   node scripts/check-dist.ts --hash <module>
//                                         prints a module's inputs hash (its build script records it beside the
//                                         module as <module>.inputs, hashed before it compiles)
//
// A module that isn't built is skipped (its tests skip too). The inputs are the tracked files under each module's
// paths, as they are in the working tree, so a build from uncommitted sources records them as built.
// SKIP_DIST_CHECK=1 skips the check.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');

/** What every module's toolchain and pinned third-party sources come from. */
const toolchain = ['scripts/emsdk-env.sh', 'scripts/fetch-emsdk.sh', 'third_party/pull.sh'];
const brep = ['packages/cad-brep/include'];
const geom = ['packages/cad-geom/native/include', 'packages/cad-geom/native/src',
  'packages/cad-geom/native/third_party', 'packages/cad-geom/build.sh'];
const occt = ['packages/tess-occt/native', 'packages/tess-occt/build-occt.sh', 'packages/tess-occt/occt_patches',
  'packages/tess-occt/occt_overlay'];
const smlib = ['packages/tess-smlib/native', 'packages/tess-smlib/build.sh', 'packages/tess-smlib/build-smlib.sh'];

/** Each module (its path from the root), the package to rebuild, and the paths its build reads. */
export const MODULES: { module: string; rebuild: string; inputs: string[] }[] = [
  { module: 'packages/cad-geom/dist/cad_geom.wasm', rebuild: 'cad-geom (build.sh module)',
    inputs: [...geom, ...brep, ...toolchain] },
  { module: 'packages/cad-oracle/dist/cad_oracle.wasm', rebuild: 'cad-oracle (build.sh module)',
    inputs: ['packages/cad-oracle/native/include', 'packages/cad-oracle/native/src', 'packages/cad-oracle/build.sh',
      ...geom, ...brep, ...toolchain] },
  { module: 'packages/tess-cadio/dist/tess_cadio.wasm', rebuild: 'tess-cadio (build.sh module)',
    inputs: ['packages/tess-cadio/native/include', 'packages/tess-cadio/native/src', 'packages/tess-cadio/build.sh',
      ...geom, ...brep, ...toolchain] },
  { module: 'packages/tess-occt/dist/occt_tess.wasm', rebuild: 'tess-occt (build.sh; build-occt.sh first if OCCT '
    + 'or its patches changed)', inputs: [...occt, 'packages/tess-occt/build.sh', ...brep, ...toolchain] },
  { module: 'packages/tess-occt/dist/occt_probe.wasm', rebuild: 'tess-occt (build-probe.sh; build-occt.sh first if '
    + 'OCCT or its patches changed)', inputs: [...occt, 'packages/tess-occt/build-probe.sh', ...brep, ...toolchain] },
  { module: 'packages/tess-smlib/dist/smlib_tess.wasm', rebuild: 'tess-smlib (build.sh; build-smlib.sh first if '
    + 'SMLib or its build changed)', inputs: [...smlib, ...brep, ...toolchain] },
  { module: 'packages/tess-truck/dist/tess_truck.wasm', rebuild: 'tess-truck (build.sh)',
    inputs: ['packages/tess-truck/native', 'packages/tess-truck/build.sh', 'Cargo.toml', 'Cargo.lock',
      'rust-toolchain.toml', 'third_party/pull.sh', 'scripts/emsdk-env.sh', 'scripts/fetch-emsdk.sh'] },
];

/** The hash of the tracked files under paths, by their paths and their contents in the working tree. */
export function inputsHash(paths: string[], dir = root): string {
  const listed = execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: dir, encoding: 'utf8' });
  const files = [...new Set(listed.split('\0').filter(f => f))].sort();
  const h = createHash('sha256');
  for (const f of files) {
    const p = path.join(dir, f);
    // A tracked file deleted in the working tree is left out, which changes the hash as any change does.
    if (!fs.existsSync(p)) continue;
    h.update(`${f}\0${createHash('sha256').update(fs.readFileSync(p)).digest('hex')}\n`);
  }
  return h.digest('hex');
}

/** The modules present in the checkout at dir whose recorded inputs differ from its working tree's, each with why. */
export function stale(dir = root): { rebuild: string; why: string }[] {
  const out: { rebuild: string; why: string }[] = [];
  for (const m of MODULES) {
    const mod = path.join(dir, m.module);
    if (!fs.existsSync(mod)) continue;
    const record = `${mod}.inputs`;
    if (!fs.existsSync(record)) {
      out.push({ rebuild: m.rebuild, why: `${m.module} has no record of its inputs` });
      continue;
    }
    if (fs.readFileSync(record, 'utf8').trim() !== inputsHash(m.inputs, dir)) {
      out.push({ rebuild: m.rebuild, why: `${m.module} was built from other sources` });
    }
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === '--hash') {
    const m = MODULES.find(x => x.module.endsWith(`/dist/${args[1]}`));
    if (!m) {
      console.error(`check-dist: no module ${args[1]} (${MODULES.map(x => path.basename(x.module)).join(', ')})`);
      process.exit(2);
    }
    console.log(inputsHash(m.inputs));
  } else if (args.length) {
    console.error('usage: node scripts/check-dist.ts [--hash <module>]');
    process.exit(2);
  } else if (process.env.SKIP_DIST_CHECK !== '1') {
    const s = stale();
    for (const x of s) console.error(`check-dist: ${x.why}: rebuild ${x.rebuild}`);
    if (s.length) {
      console.error('check-dist: a test run would test old code (SKIP_DIST_CHECK=1 to run it anyway). Without the '
        + 'build tree, copy the package\'s dist/, records included, from a checkout where --hash <module> prints '
        + 'the same as here.');
      process.exit(1);
    }
  }
}
