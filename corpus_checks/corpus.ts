// The test corpus: test_corpus/files.txt lists Part 21 files by path relative to test_corpus/third_party, where
// test_corpus/third_party/pull.sh checks out the third-party repositories (see test_corpus/README.md).
import fs from 'node:fs';
import path from 'node:path';

export const repoDir = path.resolve(import.meta.dirname, '..');
export const corpusDir = path.join(repoDir, 'test_corpus/third_party');
export const defaultList = path.join(repoDir, 'test_corpus/files.txt');

/** Absolute paths of the files in a corpus list (default test_corpus/files.txt). */
export function corpusFiles(list = defaultList): string[] {
  const files = fs.readFileSync(list, 'utf8').trim().split('\n').filter((l) => l).map((l) => path.join(corpusDir, l));
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`${missing.length} corpus files missing (first: ${missing[0]}); run test_corpus/third_party/pull.sh`);
    process.exit(1);
  }
  return files;
}

/** A corpus file's path relative to the corpus root, for reports. */
export const shortName = (f: string) => path.relative(corpusDir, f);
