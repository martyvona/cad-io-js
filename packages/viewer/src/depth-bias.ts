// Lines and dots drawn in front of what they lie on: the selection's and the highlight's lines over the edges they
// tint (selection.ts, marks.ts), at the same depth otherwise, and the B-rep vertices' dots (vertex-points.ts), flat
// discs the faces beside them would cut into at a concave corner. WebGL's polygon offset moves only filled triangles
// (the faces are pushed back by it), never lines or points, so a bias in the vertex shader moves them toward the
// camera instead, by pixels of the view in world units (set each frame: the Viewer), so it holds at any zoom. Lines
// by EDGE_BIAS_PIXELS (`depthBias`); dots by Rendering's depthOffset (`dotBias`), 0 by default: what lies behind a
// face by less than the bias shows through it, as a zoomed-out view's thin walls, which dots made conspicuous. Thin
// lines (LineBasicMaterial) and fat ones (LineMaterial) alike.

import type * as THREE from 'three';

/**
 * While there's a bias at all, at least this many linear deflections: the faces beside a line or a dot are meshed
 * within a deflection of the exact surface, so may lie that far in front of it.
 */
export const DEPTH_BIAS_DEFLECTIONS = 2;

/**
 * The bias in world millimetres: `pixels` of the view (`pixelSize` millimetres each), toward the camera in depth (not
 * on the screen), at least DEPTH_BIAS_DEFLECTIONS deflections; none at 0 pixels.
 */
export function biasFor(pixels: number, pixelSize: number, deflection: number): number {
  return pixels > 0 ? Math.max(pixels * pixelSize, DEPTH_BIAS_DEFLECTIONS * deflection) : 0;
}

/** The lines' bias, pixels: enough for a tint over its edge. */
export const EDGE_BIAS_PIXELS = 2;

/** The lines' bias in world millimetres, shared by every marked material; the Viewer sets it before each frame. */
export const depthBias = { value: 0 };
/** The dots' bias in world millimetres (vertex-points.ts, and the dots' ids and masks); as depthBias. */
export const dotBias = { value: 0 };

/** Marks a line material to be drawn biased toward the camera; its copies (clone) keep the mark. */
export function biasTowardCamera<M extends THREE.Material>(m: M): M {
  m.userData.depthBias = true;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.depthBias = depthBias;
    // (An orthographic camera's view-space z to clip space: projectionMatrix[2][2]; w is 1.)
    shader.vertexShader = 'uniform float depthBias;\n' + shader.vertexShader.replace('#include <logdepthbuf_vertex>',
      'gl_Position.z += projectionMatrix[2][2] * depthBias * gl_Position.w;\n#include <logdepthbuf_vertex>');
  };
  m.customProgramCacheKey = () => 'depth-bias';
  return m;
}

/** A material's copy keeps the bias (Material.clone copies userData but not onBeforeCompile). */
export function keepBias<M extends THREE.Material>(from: THREE.Material, to: M): M {
  return from.userData.depthBias ? biasTowardCamera(to) : to;
}
