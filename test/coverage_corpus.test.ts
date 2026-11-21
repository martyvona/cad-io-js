// corpus_checks/coverage_corpus.ts: a run in which no file was checked fails, saying so, rather than printing an
// empty report and exiting 0. (A backend that won't start fails it too: runner.ts, test/runner.test.ts.)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPT = new URL('../corpus_checks/coverage_corpus.ts', import.meta.url).pathname;

test('coverage_corpus: no file to check is an error, a nonzero exit naming the lists', { timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-empty-'));
  try {
    const list = path.join(dir, 'none.txt');
    fs.writeFileSync(list, '');
    const r = spawnSync(process.execPath, [SCRIPT, list], { encoding: 'utf8',
      env: { ...process.env, CHILDREN: '1' } });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(`Error: coverage: no file ran: 0 listed (${list}), 0 over 1000 MB, 0 failed`),
      r.stderr);
    assert.doesNotMatch(r.stdout, /^## /m, 'no report');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
