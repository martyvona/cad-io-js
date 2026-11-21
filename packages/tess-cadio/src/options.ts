// tess-cadio's options by name, without the module: what a host's settings (the viewer's page, a CLI's flags) need,
// importable without loading the WebAssembly.

/** The smallest angle refinement aims for by default, and the most it takes (more is clamped), in degrees (part.h). */
export const DEFAULT_MIN_ANGLE_DEGREES = 10;
export const MAX_MIN_ANGLE_DEGREES = 30;

/**
 * Init options (CadioInitOptions) that keep the faces tess-cadio would fail, for debugging: a face meshed past its
 * deflection, stopped at its point cap, or with triangles turned against its surface is kept as meshed instead of
 * failing (so no fallback meshes it, and its triangles can be seen). The faces failed for other causes (invalid input,
 * unsupported geometry) still fail. Meshes made so aren't to be cached beside normal ones: the cache keys on the
 * request, not on init options.
 */
export const KEEP_FAILING = { failCapped: false, failTurnedOver: false, maxDeviationFactor: 0 } as const;
