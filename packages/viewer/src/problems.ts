// The warnings and errors of loading a model (the user, 2026-10-28): the importer's and the meshing's (OCCT's
// messages, faces that failed to mesh, shells turned over, parts that failed), shown in a modal once meshing is done,
// besides the status line's count and the console.

import type { Diagnostic } from 'cad-scene';
import { showDialog } from './dialog.ts';

/** At most this many listed in the dialog (all of them in the console). */
export const MAX_LISTED = 500;

/** The warnings and errors among diagnostics (not info), errors first, as rows: where, and the message. */
export function problemRows(diagnostics: readonly Diagnostic[], max = MAX_LISTED):
  { rows: [string, string][]; errors: number; warnings: number; more: number } {
  const problems = diagnostics.filter((d) => d.severity !== 'info');
  // (A stable sort: each severity in the order met.)
  problems.sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'));
  const errors = problems.filter((d) => d.severity === 'error').length;
  const rows = problems.slice(0, max).map((d): [string, string] =>
    [`${d.severity}${d.source ? ` #${d.source.id}` : ''}`, d.message]);
  return { rows, errors, warnings: problems.length - errors, more: Math.max(0, problems.length - max) };
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** Shows a model's warnings and errors in a modal, if it has any; resolves when it's closed. */
export async function showProblems(name: string, diagnostics: readonly Diagnostic[]): Promise<void> {
  const { rows, errors, warnings, more } = problemRows(diagnostics);
  if (!rows.length) return;
  const counts = [errors ? count(errors, 'error') : '', warnings ? count(warnings, 'warning') : ''].filter((s) => s);
  await showDialog({ title: `${name}: ${counts.join(' and ')}`, error: errors > 0,
    body: ['From reading the file and meshing it; #n is the STEP instance (the part\'s shape representation, or ' +
      'the entity itself) it came from. They are in the console too.', rows,
      ...(more ? [`And ${more} more, in the console.`] : [])],
    buttons: [{ label: 'OK', value: 'ok', primary: true }] });
}
