// The errors and warnings of loading or meshing a model again (the importer's and the meshing's: parts that failed to
// build or mesh, or timed out, faces that failed to mesh; OCCT's messages, shells turned over, ...), in a modal with a
// list of each: shown once meshing is done when there are errors, and from About at any time; each failed face's cause
// where its backend said one (tess-cadio's by-cause diagnostic, an info: tess-cadio/causes). Never in the console.

import type { Diagnostic } from 'cad-scene';
import { CAUSES_HEAD, failedCauses } from 'tess-cadio/causes';
import { showDialog } from './dialog.ts';
import { formatIds } from './step-ids.ts';

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
 * The diagnostics of one kind, in the order met, as rows: where, the message, and where any listed has one, a third
 * column: a failed-faces error's causes (faceCausesOf), each with its faces, else empty.
 */
export function problemRows(diagnostics: readonly Diagnostic[], kind: Problem = 'error'): string[][] {
  const listed = ofKind(diagnostics, kind);
  const causes = listed.map((d) => causesText(diagnostics, d));
  return listed.map((d, i) => [`${d.severity}${d.source ? ` #${d.source.id}` : ''}`, d.message,
    ...(causes.some(Boolean) ? [causes[i]!] : [])]);
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
 * Shows a model's errors and warnings in a modal (a load's once meshed, when it has errors; About's link at any time):
 * a list of each, scrolling on its own, or "None."; a Copy button for each kind's ids. Resolves when it's closed.
 */
export async function showProblems(name: string, diagnostics: readonly Diagnostic[]): Promise<void> {
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
    body: ['From reading the file, healing it and meshing it; #n is the STEP instance (the part\'s shape ' +
      'representation, or the entity itself) it came from; the Copy buttons copy them, for Selection\'s Select by ID.',
    section('error', 'Errors'), section('warning', 'Warnings')],
    // (Drawn right to left from the primary: Copy error IDs, Copy warning IDs, OK.)
    buttons: [{ label: 'OK', value: 'ok', primary: true }, copy('warning', 'Copy warning IDs'),
      copy('error', 'Copy error IDs')] });
}

