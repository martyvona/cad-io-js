// Every tracked text file is ASCII (CLAUDE.md, "Code conventions"), except CLAUDE.md itself, the corpus checks' logs
// (program output, which quotes file names and data) and binary files. Non-ASCII test data is written as escapes
// ('\u00C4', '\uFEFF'), so nothing invisible or easily mangled hides in the source.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
let files: string[] | undefined;
try {
  files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((f) => f);
} catch {
  files = undefined;
}
const EXEMPT = (f: string) => f === 'CLAUDE.md' || f.endsWith('.log');

test('tracked text files are ASCII', { skip: files ? false : 'not a git checkout' }, () => {
  const problems: string[] = [];
  for (const f of files!) {
    if (EXEMPT(f) || !fs.existsSync(path.join(root, f))) continue;
    const bytes = fs.readFileSync(path.join(root, f));
    if (bytes.includes(0)) continue; // binary
    if (bytes.every((b) => b < 0x80)) continue;
    const lines = bytes.toString('utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      const at = [...line].findIndex((c) => c.codePointAt(0)! > 0x7f);
      if (at >= 0) problems.push(`${f}:${i + 1}:${at + 1}: U+${[...line][at]!.codePointAt(0)!.toString(16)
        .toUpperCase().padStart(4, '0')}`);
    }
  }
  assert.deepEqual(problems, []);
});
