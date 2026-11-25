// Vertices (Rendering's Vertices): the model's B-rep vertices as dots, each a disc drawn by a shader of our own,
// antialiased at its rim, in the edges' colour, as wide as vertexDiameter says. Each placement's are a Points of the
// model (scene-graph.ts's `vertices`, its items each vertex: items.ts) on the VERTICES layer, which the Viewer's camera
// shows only while Vertices is on; a selected vertex's highlight (selection.ts) is a copy of this material on the
// default layer, so it shows whatever Vertices is. The dots' size and the depth bias are uniforms every copy shares
// (a selection's tint is a clone: copy below), set before each frame (setDotSize). They test depth but don't write it
// (a nearer disc's rim, written, would cut into a farther one beside it), and are drawn toward the camera by the
// outlines' depth bias (depth-bias.ts), so the faces they lie on don't cut into them; clipped by the section planes as
// everything is. Blended at the rim, so transparent, which the Viewer's search for transparent materials passes over
// (`userData.dots`): they'd otherwise turn on the composer's transparency handling.

import * as THREE from 'three';
import { depthBias } from './depth-bias.ts';
import type { EdgeStyle } from './fat-edges.ts';

/**
 * A disc's diameter in CSS pixels: thin edges are one device pixel, so 2 CSS pixels more than that; fat ones
 * `width` CSS pixels, so half as wide again, but at least 3 CSS pixels more (at narrow widths, half as wide again
 * hardly shows beside the line).
 */
export function vertexDiameter(style: EdgeStyle, width: number, pixelRatio: number): number {
  return style === 'thin' ? 1 / pixelRatio + 2 : Math.max(1.5 * width, width + 3);
}

/**
 * Device pixels: the point's square, a pixel's rim beyond the disc each side; and the disc's radius. And the pixel
 * ratio.
 */
const size = { value: 5 };
const radius = { value: 1.5 };
const ratio = { value: 1 };

/** Every dot `diameter` CSS pixels wide at `pixelRatio` device pixels to one (before a frame). */
export function setDotSize(diameter: number, pixelRatio: number): void {
  radius.value = diameter * pixelRatio / 2;
  size.value = Math.ceil(2 * radius.value + 2);
  ratio.value = pixelRatio;
}

/** A dots material's square in device pixels, as drawn (its `grow` with it). */
export function dotPixels(m: DiscMaterial): number {
  return size.value + 2 * Math.ceil((m.uniforms.grow!.value as number) * ratio.value);
}

const VERTEX = `
uniform float size;
uniform float grow;
uniform float ratio;
uniform float depthBias;
#include <common>
#include <clipping_planes_pars_vertex>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  gl_Position.z += projectionMatrix[2][2] * depthBias * gl_Position.w;
  gl_PointSize = size + 2.0 * ceil(grow * ratio);
  #include <clipping_planes_vertex>
}`;

// (The rim's coverage: the disc's radius less the fragment's distance from its centre, both device pixels, over a
// pixel.)
const FRAGMENT = `
uniform vec3 color;
uniform float opacity;
uniform float size;
uniform float radius;
uniform float grow;
uniform float ratio;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  float d = length((gl_PointCoord - 0.5) * (size + 2.0 * ceil(grow * ratio)));
  float a = clamp(radius + grow * ratio + 0.5 - d, 0.0, 1.0);
  if (a <= 0.0) discard;
  gl_FragColor = vec4(color, opacity * a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * The dots' material; `color` its colour, as a line material's (a selection's tint sets it); `grow`, CSS pixels added
 * to the radius (a highlight's mark: outline.ts), its own.
 */
export class DiscMaterial extends THREE.ShaderMaterial {
  constructor(color: THREE.ColorRepresentation = 0x000000) {
    super({ vertexShader: VERTEX, fragmentShader: FRAGMENT, clipping: true, transparent: true, depthWrite: false,
      uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: 1 }, size, radius, ratio, depthBias,
        grow: { value: 0 } } });
    this.userData.dots = true;
  }

  get color(): THREE.Color {
    return this.uniforms.color!.value as THREE.Color;
  }

  /** As ShaderMaterial's, the size and depth bias kept shared (it clones uniforms). */
  override copy(source: DiscMaterial): this {
    super.copy(source);
    this.uniforms.size = size;
    this.uniforms.radius = radius;
    this.uniforms.ratio = ratio;
    this.uniforms.depthBias = depthBias;
    return this;
  }
}
