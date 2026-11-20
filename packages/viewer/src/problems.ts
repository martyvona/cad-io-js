// The errors of loading or meshing a model again (the importer's and the meshing's: parts that failed to build or mesh,
// or timed out, and faces that failed to mesh), shown in a modal once meshing is done, with each failed face's cause
// where its backend said one (tess-cadio's by-cause diagnostic, an info: tess-cadio/causes); warnings only in the
// status line's count and the console.

import type { Diagnostic } from 'cad-scene';
import { CAUSES_HEAD, failedCauses } from 'tess-cadio/causes';
import { showDialog } from './dialog.ts';
import { formatIds } from './step-ids.ts';

/** At most this many listed in the dialog (all of them in the console). */
export const MAX_LISTED = 500;

const errorsOf = (diagnostics: readonly Diagnostic[]) => diagnostics.filter((d) => d.severity === 'error');

/**
 * The errors among diagnostics, in the order met, as rows: where, the message, and where any listed has one, a
 * third column: a failed-faces error's causes (faceCausesOf), each with its faces, else empty.
 */
export function problemRows(diagnostics: readonly Diagnostic[], max = MAX_LISTED):
  { rows: string[][]; errors: number; more: number } {
  const errors = errorsOf(diagnostics);
  const listed = errors.slice(0, max);
  const causes = listed.map((d) => causesText(diagnostics, d));
  const rows = listed.map((d, i) => [`${d.severity}${d.source ? ` #${d.source.id}` : ''}`, d.message,
    ...(causes.some(Boolean) ? [causes[i]!] : [])]);
  return { rows, errors: errors.length, more: Math.max(0, errors.length - max) };
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

/** The STEP ids the errors came from, each once, in the rows' order (what Copy IDs copies). */
export function problemIds(diagnostics: readonly Diagnostic[]): number[] {
  return [...new Set(errorsOf(diagnostics).flatMap((d) => d.source ? [d.source.id] : []))];
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

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** Shows a model's errors in a modal, if it has any; resolves when it's closed (at once if none). */
export async function showProblems(name: string, diagnostics: readonly Diagnostic[]): Promise<void> {
  const { rows, errors, more } = problemRows(diagnostics);
  const ids = problemIds(diagnostics);
  if (!rows.length) return;
  await showDialog({ title: `${name}: ${count(errors, 'error')}`, error: true,
    body: ['From reading the file, healing it and meshing it; #n is the STEP instance (the part\'s shape ' +
      'representation, or the entity itself) it came from; Copy IDs copies them, for Selection\'s Select by ID. They ' +
      'are in the console, with any warnings.', rows,
      ...(more ? [`And ${more} more, in the console.`] : [])],
    buttons: [{ label: 'OK', value: 'ok', primary: true }, { label: 'Copy IDs', value: 'copy', disabled: !ids.length,
      // The ids, as Selection's Select by ID reads them; the dialog stays open.
      action: (b) => void copyText(formatIds(ids), 'The STEP ids:').then((copied) => {
        if (!copied) return;
        b.textContent = `Copied ${count(ids.length, 'ID')}`;
        setTimeout(() => { b.textContent = 'Copy IDs'; }, 2000);
      }) }] });
}
