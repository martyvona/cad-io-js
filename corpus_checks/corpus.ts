// The test corpus: test_corpus/files.txt lists Part 21 files by path relative to test_corpus/third_party, where
// test_corpus/third_party/pull.sh checks out the third-party repositories (see test_corpus/README.md).
import fs from 'node:fs';
import path from 'node:path';
import { buildSubset, Reader, type StepModel } from '../packages/step-parser/src/index.ts';

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

/**
 * A part's STEP subset of its file (its shape representation and what it reaches, the representation's mapped items
 * left out), as the importer gave backends before the B-rep model: for checks comparing with the file's own geometry.
 */
export function partSubset(model: StepModel, repId: number): Uint8Array {
  const root = model.resolve(repId);
  const exclude = new Set(new Reader(model).refs(root, 'items').filter((q) => q >= 0
    && model.isInstanceOf(q, 'MAPPED_ITEM')));
  return buildSubset(model.file, [root], { exclude }).bytes;
}

/**
 * Whether a part gets a check's planted bug: about one in `every`, by a hash (FNV-1a) of where it is (its file and
 * id), so a file's planting doesn't depend on the files before it (they run at once: runner.ts).
 */
export function plantedPart(where: string, every = 10): boolean {
  let h = 0x811c9dc5;
  for (let i = 0; i < where.length; i++) h = Math.imul(h ^ where.charCodeAt(i), 0x01000193) >>> 0;
  return h % every === 0;
}
