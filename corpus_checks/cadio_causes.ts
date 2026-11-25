// Reading tess-cadio's "faces failed to mesh, by cause" diagnostic, for the checks that classify the faces ours fails
// (cadio_corpus.ts, coverage_corpus.ts): tess-cadio's own reader (its causes.ts), which the viewer shares; and which
// causes say the input is beyond repair (the user's rule, docs/own-tessellator.md), not our failure.
export { CAUSES_HEAD, failedCauses, KEPT_HEAD, keptDefects } from '../packages/tess-cadio/src/causes.ts';

/** Causes ("status: cause", as failedCauses gives them) beyond repair as they read. */
export const BEYOND_REPAIR = new Set(["invalidModel: a use of an edge whose curve is far off its face's surface"]);
/** Whether a face's cause says its input is beyond repair. */
export const beyondRepair = (cause: string) => BEYOND_REPAIR.has(cause);
