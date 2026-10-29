// The viewer's look, apart from how frames are composed (render.ts): edges on a layer of their own, and the
// rendering settings (the user, 2026-10-24; CLAUDE.md, "The viewer"). Kept apart from render.ts, which imports N8AO
// and postprocessing, so the rest can run in Node's tests.

import type { EdgeStyle } from './fat-edges.ts';
import { HATCH_WIDTH, type CapStyle } from './section.ts';
import type { TriangleEdgesMode } from './triangle-edges.ts';

/** The layer edges are drawn on (and only on). */
export const EDGES = 1;

export interface RenderSettings {
  /** Ambient occlusion. */
  ao: boolean;
  /** How dark, 0 to 10. */
  aoIntensity: number;
  /** Pixels. */
  aoRadius: number;
  aoQuality: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra';
  smaa: boolean;
  edges: boolean;
  /** Triangles' edges over the faces (triangle-edges.ts), to inspect the tessellation: none, the selection's, all. */
  triangleEdges: TriangleEdgesMode;
  /** Edges as WebGL lines (one device pixel), or fat lines (fat-edges.ts) `edgeWidth` CSS pixels wide. */
  edgeStyle: EdgeStyle;
  edgeWidth: number;
  /** Phong shininess of faces. */
  shininess: number;
  /** Phong specular colour of faces, a grey from 0 (none) to 1 (white). */
  specular: number;
  /** The ambient light's intensity, and the headlight's. */
  ambient: number;
  light: number;
  /** How section caps are drawn (section.ts). */
  capStyle: CapStyle;
  /** The caps' hatching lines' width, CSS pixels at half their ink. */
  hatchWidth: number;
}

export const DEFAULT_RENDER: RenderSettings = { ao: true, aoIntensity: 5, aoRadius: 32, aoQuality: 'High',
  smaa: true, edges: true, edgeStyle: 'fat', edgeWidth: 1.5, triangleEdges: 'off', shininess: 30, specular: 0.4,
  ambient: 1, light: 2.5, capStyle: 'parts', hatchWidth: HATCH_WIDTH };
