// Reading tess-cadio's "faces failed to mesh, by cause" diagnostic, for the checks that classify the faces ours fails
// (cadio_corpus.ts, coverage_corpus.ts): tess-cadio's own reader (its causes.ts), which the viewer shares; and which
// causes say the input is beyond repair (the user's rule, docs/own-tessellator.md), not our failure.
export { CAUSES_HEAD, failedCauses } from '../packages/tess-cadio/src/causes.ts';

/** Causes ("status: cause", as failedCauses gives them) beyond repair as they read. */
export const BEYOND_REPAIR = new Set(["invalidModel: a use of an edge whose curve is far off its face's surface"]);
/** A loop through an edge or vertex whose tolerance healing grew past repair: the id and sizes vary. */
export const PAST_REPAIR =
  /^invalidModel: (an edge|a vertex) \(#\d+\) whose tolerance healing grew from \S+ to \S+ mm, past repair$/;

/** Whether a face's cause says its input is beyond repair. */
export const beyondRepair = (cause: string) => BEYOND_REPAIR.has(cause) || PAST_REPAIR.test(cause);
