// scripts/check-dist.ts on a throwaway checkout: a module is stale when a tracked input changes, is deleted or is
// added, or when it has no record; untracked files and other paths aren't inputs; a module not built is skipped.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inputsHash, MODULES, stale } from '../scripts/check-dist.ts';

const truck = MODULES.find(m => m.module.endsWith('/tess_truck.wasm'))!;

function checkout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-dist-'));
  const write = (f: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), s);
  };
  write('packages/tess-truck/native/src/lib.rs', 'fn a() {}\n');
  write('packages/tess-truck/build.sh', 'cargo build\n');
  write('Cargo.lock', 'lock\n');
  write('README.md', 'not an input\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  write(truck.module, 'wasm');
  write(`${truck.module}.inputs`, `${inputsHash(truck.inputs, dir)}\n`);
  return dir;
}

test('check-dist: a module whose recorded inputs are the working tree\'s passes; one not built is skipped', () => {
  const dir = checkout();
  try {
    assert.deepEqual(stale(dir), []);
    fs.writeFileSync(path.join(dir, 'README.md'), 'changed, not an input\n');
    fs.writeFileSync(path.join(dir, 'packages/tess-truck/native/src/untracked.rs'), 'fn b() {}\n');
    assert.deepEqual(stale(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('check-dist: a tracked input changed, deleted or added, or no record, names the package to rebuild', () => {
  const cases: [string, (dir: string) => void, RegExp][] = [
    ['changed', d => fs.appendFileSync(path.join(d, 'packages/tess-truck/native/src/lib.rs'), '// x\n'), /other/],
    ['deleted', d => fs.rmSync(path.join(d, 'Cargo.lock')), /other/],
    ['added', d => {
      fs.writeFileSync(path.join(d, 'packages/tess-truck/native/src/new.rs'), '\n');
      execFileSync('git', ['add', '-A'], { cwd: d });
    }, /other/],
    ['no record', d => fs.rmSync(path.join(d, `${truck.module}.inputs`)), /no record/],
  ];
  for (const [name, change, why] of cases) {
    const dir = checkout();
    try {
      change(dir);
      const s = stale(dir);
      assert.equal(s.length, 1, name);
      assert.match(s[0]!.why, why, name);
      assert.match(s[0]!.rebuild, /^tess-truck /, name);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  }
});

test('check-dist: every module\'s inputs are paths the repository tracks, its build script among them', () => {
  const root = path.join(import.meta.dirname, '..');
  for (const m of MODULES) {
    for (const p of m.inputs) {
      const listed = execFileSync('git', ['ls-files', '--', p], { cwd: root, encoding: 'utf8' });
      assert.ok(listed.trim(), `${m.module}: ${p} tracks nothing`);
    }
    const pkg = m.module.split('/dist/')[0]!;
    assert.ok(m.inputs.some(p => p.startsWith(`${pkg}/build`)), `${m.module}: its build script`);
  }
});
