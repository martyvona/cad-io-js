// The errors of loading or meshing a model again (the importer's and the meshing's: parts that failed to build or mesh,
// or timed out), shown in a modal once meshing is done; warnings (faces that failed to mesh among them: outlined in
// the view) only in the status line's count and the console.

import type { Diagnostic } from 'cad-scene';
import { showDialog } from './dialog.ts';
import { formatIds } from './step-ids.ts';

/** At most this many listed in the dialog (all of them in the console). */
export const MAX_LISTED = 500;

const errorsOf = (diagnostics: readonly Diagnostic[]) => diagnostics.filter((d) => d.severity === 'error');

/** The errors among diagnostics, in the order met, as rows: where, and the message. */
export function problemRows(diagnostics: readonly Diagnostic[], max = MAX_LISTED):
  { rows: [string, string][]; errors: number; more: number } {
  const errors = errorsOf(diagnostics);
  const rows = errors.slice(0, max).map((d): [string, string] =>
    [`${d.severity}${d.source ? ` #${d.source.id}` : ''}`, d.message]);
  return { rows, errors: errors.length, more: Math.max(0, errors.length - max) };
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
    body: ['From reading the file and meshing it; #n is the STEP instance (the part\'s shape representation, or ' +
      'the entity itself) it came from; Copy IDs copies them, for Selection\'s Select by ID. They are in the ' +
      'console, with any warnings.', rows,
      ...(more ? [`And ${more} more, in the console.`] : [])],
    buttons: [{ label: 'OK', value: 'ok', primary: true }, { label: 'Copy IDs', value: 'copy', disabled: !ids.length,
      // The ids, as Selection's Select by ID reads them; the dialog stays open.
      action: (b) => void copyText(formatIds(ids), 'The STEP ids:').then((copied) => {
        if (!copied) return;
        b.textContent = `Copied ${count(ids.length, 'ID')}`;
        setTimeout(() => { b.textContent = 'Copy IDs'; }, 2000);
      }) }] });
}
