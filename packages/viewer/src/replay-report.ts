// What a replay acts on, and its outcome in words (the page's status line, `cad-viewer replay`): steps rather than
// events, as most events are kept only for reading (the user, 2026-10-30: "replayed 342 of 1340 events" read as a
// replay cut short). No imports but types, so the command line can use it.

import type { RecordedEvent } from './recorder.ts';

/** Controls replay leaves alone. (Select by ID's dialog: the selection it made is replayed, as a select event.) */
export const NOT_REPLAYED = new RegExp('^(File/|View/Copy link|View/(Enter|Exit) full screen|' +
  'B-Rep Meshing/Clear cache|Selection/Select by ID)');

/**
 * Whether replay acts on an event (ReplayReport's `steps`): loads, controls but those above, calls, selections in
 * the tree or by id, cameras, picks, states. The rest are kept for reading: pointer moves, the wheel, statuses, and
 * the selections a pick or a control made, which replay makes again.
 */
export const isStep = (e: RecordedEvent) => (e.type === 'control' ? !NOT_REPLAYED.test(e.path) : e.type === 'select'
  ? e.source === 'tree' || e.source === 'id' : ['load', 'api', 'camera', 'pick', 'state'].includes(e.type));

/** A replay's outcome in words. */
export function replayed(r: { steps: number; applied: number; aborted?: string }): string {
  if (r.aborted === 'stopped') return `replay stopped after ${r.applied} of ${r.steps} steps`;
  return r.applied === r.steps ? `replayed all ${r.steps} steps` : `replayed ${r.applied} of ${r.steps} steps`;
}
