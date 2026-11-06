// Writes test_corpus/demo/catalog.json, which the viewer's Load demo model... (About) offers: every model below the
// demo directory, recursively (a file the viewer reads by its extension, packages/viewer/src/formats.ts; not the
// catalog itself, nor dot files or symbolic links), its path relative to the directory ('/'-separated) and its size in
// bytes, sorted by path. Rewritten only when it changes; prints whether it did. Run by deploy-viewer.sh and
// deploy-demo.sh, which commit it.
//   node scripts/demo-catalog.ts [dir]   (dir: test_corpus/demo by default)

import fs from 'node:fs';
import path from 'node:path';
import { formatOf } from '../packages/viewer/src/formats.ts';

export const CATALOG = 'catalog.json';

export interface DemoEntry {
  path: string;
  size: number;
}

/** The models below `dir`, sorted by path (code points, so the order doesn't depend on a locale). */
export function listModels(dir: string): DemoEntry[] {
  const out: DemoEntry[] = [];
  const walk = (rel: string) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(p);
      else if (d.isFile() && p !== CATALOG && formatOf(d.name)) {
        out.push({ path: p, size: fs.statSync(path.join(dir, p)).size });
      }
    }
  };
  walk('');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The catalog's text: one model per line, non-ASCII escaped (the repository's text files are ASCII). */
export function catalogText(models: readonly DemoEntry[]): string {
  const lines = models.map((m) => '    ' + JSON.stringify({ path: m.path, size: m.size }));
  const body = lines.length ? `[\n${lines.join(',\n')}\n  ]` : '[]';
  return `{\n  "models": ${body}\n}\n`.replace(/[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Writes `dir`'s catalog if it differs from what's there; whether it did. */
export function writeCatalog(dir: string): boolean {
  const file = path.join(dir, CATALOG);
  const text = catalogText(listModels(dir));
  let old: string | undefined;
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch {
    old = undefined;
  }
  if (old === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? path.join(import.meta.dirname, '..', 'test_corpus', 'demo');
  const changed = writeCatalog(dir);
  console.log(`${path.relative(process.cwd(), path.join(dir, CATALOG))}: ${changed ? 'updated' : 'unchanged'}`);
}
