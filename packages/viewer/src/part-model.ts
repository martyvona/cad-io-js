// A part's B-rep model and its analysis as they move between the model worker and the page (model-load.ts's handOver
// and takeBack, scene-graph.ts's holdModel and lendModels): their buffers, transferred, never copied. Apart from
// model-load.ts so the page needn't import it.

/** A part's B-rep model's buffer and its analysis's (where it has one: healing's). */
export interface PartModel { model: ArrayBuffer; analysis?: ArrayBuffer }

/** A part model's buffers, to transfer. */
export const partModelBuffers = (m: PartModel): ArrayBuffer[] => [m.model, ...(m.analysis ? [m.analysis] : [])];
