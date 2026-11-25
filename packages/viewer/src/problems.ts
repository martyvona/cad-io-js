// The errors and warnings of loading or meshing a model again (the importer's and the meshing's: parts that failed to
// build or mesh, or timed out, faces that failed to mesh; OCCT's messages, shells turned over, ...), in a modal with a
// list of each: shown once meshing is done when there are errors, and from About at any time; each failed face's cause
// where its backend said one (tess-cadio's by-cause diagnostic, an info: tess-cadio/causes). Never in the console.

import type { Diagnostic } from 'cad-scene';
import { CAUSES_HEAD, failedCauses } from 'tess-cadio/causes';
import { showDialog } from './dialog.ts';
import type { NodeModel } from './model.ts';
import { formatIds, nodeStepIds } from './step-ids.ts';

/** `n` of a thing, plural unless one: `3 warnings`, `1 error`. */
export const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** What the dialog lists, each kind in a list of its own. */
export type Problem = 'error' | 'warning';

const ofKind = (diagnostics: readonly Diagnostic[], kind: Problem) => diagnostics.filter((d) => d.severity === kind);

/** How many errors and warnings, as the status line and the dialog's title say them: '' for none. */
export function problemCounts(diagnostics: readonly Diagnostic[]): string {
  const e = ofKind(diagnostics, 'error').length, w = ofKind(diagnostics, 'warning').length;
  return [e ? count(e, 'error') : '', w ? count(w, 'warning') : ''].filter(Boolean).join(', ');
}

/**
 * The diagnostics of one kind, in the order met, as rows: where, and the message, a failed-faces error's causes
 * (faceCausesOf), each with its faces, on a line after it (the cell keeps line breaks), as a warning names its faces'
 * defects in its message: errors and warnings alike two columns.
 */
export function problemRows(diagnostics: readonly Diagnostic[], kind: Problem = 'error'): [string, string][] {
  return ofKind(diagnostics, kind).map((d) => {
    const causes = causesText(diagnostics, d);
    return [`${d.severity}${d.source ? ` #${d.source.id}` : ''}`, causes ? `${d.message}\n${causes}` : d.message];
  });
}

/** Whether a sorted array holds a value. */
function holds(sorted: Uint32Array, v: number): boolean {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return sorted[lo] === v;
}

/**
 * The diagnostics pertaining to a node (its context menu's errors and warnings), in order, infos among them (a failed
 * face's cause): an assembly's own (its occurrence's and component's STEP ids) and those of everything below it; a
 * part's own (its placement's, product's and shape representation's) and those of everything in its B-rep model (its
 * faces', edges', vertices', curves', ... ids: `idsOf`, by part index, sorted: step-ids.ts's modelIds, where the page
 * holds the model) or its mesh's faces; a face's, edge's, curve's, vertex's or point's own, and its part's that name
 * it (`#id`: failed faces); the faces, edges and vertices groups none. A top node's include the file's own too: those
 * no node covers (no STEP source, or one outside every part and assembly: a unit, a style, a reference beyond the
 * file).
 */
export function itemDiagnostics(model: NodeModel, id: number, diagnostics: readonly Diagnostic[],
  idsOf: (part: number) => Uint32Array | undefined): Diagnostic[] {
  const n = model.nodes[id]!;
  const step = (d: Diagnostic) => d.source?.format === 'step' ? d.source.id : undefined;
  const item = n.face?.source ?? n.item?.source;
  if (item !== undefined) {
    if (item === null) return [];
    const face = item, own = new Set(nodeStepIds(model, model.partOf(id)));
    if (!nodeStepIds(model, id).length) return [];
    const named = new RegExp(`#${face}(?!\\d)`);
    return diagnostics.filter((d) => {
      const s = step(d);
      return s === face || s !== undefined && own.has(s) && named.test(d.message);
    });
  }
  if (n.kind !== 'assembly' && n.kind !== 'part') return [];
  // Whether an id is under a node: its own and its descendants', its parts' models' and meshes' faces'.
  const covers = (top: number) => {
    const ids = new Set<number>(), parts = new Set<number>();
    const walk = (k: number) => {
      const m = model.nodes[k]!;
      for (const i of nodeStepIds(model, k)) ids.add(i);
      if (m.kind !== 'part') {
        for (const c of m.children ?? []) walk(c);
        return;
      }
      parts.add(m.object!.userData.part as number);
      if (!m.object!.userData.stepFaces) return;
      m.object!.traverse((o) => {
        for (const key of ['faces', 'failedFaces']) {
          for (const f of (o.userData[key] as number[] | undefined) ?? []) ids.add(f);
        }
      });
    };
    walk(top);
    return (i: number) => ids.has(i) || [...parts].some((p) => {
      const a = idsOf(p);
      return !!a && holds(a, i);
    });
  };
  const inside = covers(id);
  const top = n.parent < 0;
  const anywhere = top ? model.roots.map(covers) : [];
  return diagnostics.filter((d) => {
    const s = step(d);
    return s === undefined ? top : inside(s) || top && !anywhere.some((f) => f(s));
  });
}

/** Each failed face's cause, by its STEP id, as its backend said them (tess-cadio's; none for other backends). */
export const faceCausesOf = (diagnostics: readonly Diagnostic[]) => failedCauses({ diagnostics });

/**
 * A failed-faces error's causes, as "<status>: <cause> (#id, ...)" joined by "; ": its part's by-cause diagnostic
 * (the same source), which names every face the error does (the error at most 10); '' for another error or where
 * none was said.
 */
function causesText(diagnostics: readonly Diagnostic[], error: Diagnostic): string {
  if (!error.source || !/faces failed to mesh/.test(error.message)) return '';
  const by = new Map<string, number[]>();
  for (const d of diagnostics) {
    if (d.source?.id !== error.source.id || !d.message.startsWith(CAUSES_HEAD)) continue;
    for (const [id, cause] of failedCauses({ diagnostics: [d] })) by.set(cause, [...(by.get(cause) ?? []), id]);
  }
  return [...by].map(([cause, ids]) => `${cause} (${ids.map((i) => `#${i}`).join(', ')})`).join('; ');
}

/** The STEP ids diagnostics of one kind came from, each once, in the rows' order (what its Copy button copies). */
export function problemIds(diagnostics: readonly Diagnostic[], kind: Problem = 'error'): number[] {
  return [...new Set(ofKind(diagnostics, kind).flatMap((d) => d.source ? [d.source.id] : []))];
}

/** Text to the clipboard where the page may write it (a secure context), else shown in a prompt to copy. */
export async function copyText(text: string, what: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* shown instead */ }
  }
  window.prompt(what, text);
  return false;
}

/**
 * Shows a model's errors and warnings in a modal (a load's once meshed, when it has errors; About's link at any time),
 * or with `item` (a node in words, `nut_1 and everything in it`: its context menu) those pertaining to it
 * (itemDiagnostics):
 * a list of each, scrolling on its own, or "None."; a Copy button for each kind's ids. Resolves when it's closed.
 */
export async function showProblems(name: string, diagnostics: readonly Diagnostic[], item?: string): Promise<void> {
  const section = (kind: Problem, heading: string) => {
    const rows = problemRows(diagnostics, kind);
    const h = document.createElement('h3');
    h.textContent = `${heading} (${rows.length})`;
    const box = document.createElement('div');
    box.className = `table ${kind}s`;
    if (rows.length) {
      const table = document.createElement('table');
      for (const cells of rows) {
        const row = table.insertRow();
        for (const c of cells) row.insertCell().textContent = c;
      }
      box.append(table);
    } else {
      const p = document.createElement('p');
      p.className = 'none';
      p.textContent = 'None.';
      box.append(p);
    }
    const div = document.createElement('div');
    div.append(h, box);
    return div;
  };
  const copy = (kind: Problem, label: string) => {
    const ids = problemIds(diagnostics, kind);
    return { label, value: `copy-${kind}s`, disabled: !ids.length,
      // The ids, as Selection's Select by ID reads them; the dialog stays open.
      action: (b: HTMLButtonElement) => void copyText(formatIds(ids), 'The STEP ids:').then((copied) => {
        if (!copied) return;
        b.textContent = `Copied ${count(ids.length, 'ID')}`;
        setTimeout(() => { b.textContent = label; }, 2000);
      }) };
  };
  const errors = ofKind(diagnostics, 'error').length;
  await showDialog({ title: `${name}: ${problemCounts(diagnostics) || 'no errors or warnings'}`, error: errors > 0,
    body: [`${item ? `Those of ${item}, f` : 'F'}rom reading the file, healing it and meshing ` +
      'it; #n is the STEP instance (the part\'s shape ' +
      'representation, or the entity itself) it came from; the Copy buttons copy them, for Selection\'s Select by ID.',
    section('error', 'Errors'), section('warning', 'Warnings')],
    // (Drawn right to left from the primary: Copy error IDs, Copy warning IDs, OK.)
    buttons: [{ label: 'OK', value: 'ok', primary: true }, copy('warning', 'Copy warning IDs'),
      copy('error', 'Copy error IDs')] });
}

