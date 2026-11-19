// Reading tess-cadio's "faces failed to mesh, by cause" diagnostic (packages/tess-cadio/src/index.ts writes it), for
// the checks that classify the faces ours fails (cadio_corpus.ts, coverage_corpus.ts).
import type { TessellationResult } from '../packages/cad-scene/src/index.ts';

/** The diagnostic's opening words: "<status>: <cause> <n> (#id, ...)" entries follow, joined by "; ". */
export const CAUSES_HEAD = 'faces failed to mesh, by cause: ';

/** Each failed face's id to its "<status>: <cause>", from the result's diagnostics (empty if it has none). */
export function failedCauses(r: Pick<TessellationResult, 'diagnostics'>): Map<number, string> {
  const out = new Map<number, string>();
  for (const x of r.diagnostics) {
    if (!x.message.startsWith(CAUSES_HEAD)) continue;
    for (const entry of x.message.slice(CAUSES_HEAD.length).split('; ')) {
      const m = /^(.*) \d+ \(((?:#\d+(?:, )?)+)\)$/.exec(entry);
      if (!m) continue;
      for (const id of m[2]!.matchAll(/#(\d+)/g)) out.set(Number(id[1]), m[1]!);
    }
  }
  return out;
}
