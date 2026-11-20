// tess-cadio's "faces failed to mesh, by cause" diagnostic (index.ts writes it): its form, and reading it back, for
// what shows or classifies the faces it fails (the viewer's Details and problems dialog, the corpus checks), without
// the module.
import type { Diagnostic } from 'cad-scene';

/** The diagnostic's opening words: "<status>: <cause> <n> (#id, ...)" entries follow, joined by "; ". */
export const CAUSES_HEAD = 'faces failed to mesh, by cause: ';

/** Each failed face's id to its "<status>: <cause>", from these diagnostics (empty if none says). */
export function failedCauses(r: { readonly diagnostics: readonly Pick<Diagnostic, 'message'>[] }): Map<number, string> {
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
