// Lines and dots drawn in front of the faces they lie on: failed faces' red outlines over the black edges along the
// same B-rep edges, and the B-rep vertices' dots (vertex-points.ts), flat discs the faces beside them would otherwise
// cut into at a concave corner. WebGL's polygon offset moves only filled triangles (the faces are pushed back by it),
// never lines or points, and the two lines are discretized apart (the file's curves against the mesh's edges), so
// they cross in depth; a bias in the vertex shader moves them toward the camera instead, by the Rendering setting's
// pixels of the view in world units (depthOffset, set each frame: the Viewer), so it holds at any zoom. The price:
// what lies behind a face by less than that shows through it, as a zoomed-out view's thin walls. Thin lines
// (LineBasicMaterial) and fat ones (LineMaterial) alike.

import type * as THREE from 'three';

/**
 * While there's a bias at all, at least this many linear deflections: an outline follows the file's exact curve, which
 * can lie up to a deflection behind the meshed faces beside it (the black edges lie on those faces).
 */
export const DEPTH_BIAS_DEFLECTIONS = 2;

/**
 * The bias in world millimetres: `pixels` of the view (`pixelSize` millimetres each), toward the camera in depth (not
 * on the screen), at least DEPTH_BIAS_DEFLECTIONS deflections; none at 0 pixels.
 */
export function biasFor(pixels: number, pixelSize: number, deflection: number): number {
  return pixels > 0 ? Math.max(pixels * pixelSize, DEPTH_BIAS_DEFLECTIONS * deflection) : 0;
}

/** The bias in world millimetres, shared by every marked material; the Viewer sets it before each frame. */
export const depthBias = { value: 0 };

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
