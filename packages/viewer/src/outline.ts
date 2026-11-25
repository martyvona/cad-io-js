// Highlights (docs/viewer.md), apart from the selection's tints (selection.ts): what the pointer is over, at the pick
// level. A face, a part or an assembly gets a silhouette: a thin antialiased line just outside everything it draws
// (faces, edges, vertices), dim where something else is in front of it (an x-ray). Edges, curves, vertices and points
// get marks: their lines drawn fatter, their dots larger, in the highlight's colour.
//
// The silhouette is two passes. The mask: the highlighted pieces drawn into a multisampled target (so its edge has
// partial coverage) with neither depth test nor write, red their coverage and green the coverage of what's in sight,
// blended by maximum: a fragment is in sight if it's no farther than the id pass's depth there (pick-ids.ts: the faces'
// and caps' depth, drawn with the same offsets and bias), or the id drawn there is one of the highlight's own (its cap,
// its lines over its faces). Then the distance from each pixel outside the mask to the nearest covered pixel (less
// its coverage, so the line follows the antialiased edge), in two passes so a wide line costs its width, not its
// square: along each row (the nearest covered pixel's offset and coverage, in sight and hidden apart), then down each
// column in the composite, after the frame's last pass. The line is `thickness` device pixels wide, smoothed over a
// pixel, in sight or hidden by which coverage is nearer.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { Wireframe } from 'three/examples/jsm/lines/Wireframe.js';
import { biasTowardCamera, depthBias } from './depth-bias.ts';
import { coverRuns } from './pick-ids.ts';
import type { Piece } from './selection.ts';
import { DiscMaterial } from './vertex-points.ts';

/** How strongly the silhouette shows where it's hidden (its colour's weight over what's in front). */
export const XRAY = 0.4;
/** The id runs the mask's shader takes (more are covered by fewer: coverRuns). */
const RUNS = 8;

/** What to highlight: pieces to outline, pieces to mark. */
export interface Highlight { outline: readonly Piece[]; marks: readonly Piece[] }

const MASK_VERTEX = `
uniform float depthBias;
uniform float pointSize;
#include <common>
#include <clipping_planes_pars_vertex>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #ifdef DEPTH_BIAS
  gl_Position.z += projectionMatrix[2][2] * depthBias * gl_Position.w;
  #endif
  #ifdef POINTS
  gl_PointSize = pointSize;
  #endif
  #include <clipping_planes_vertex>
}`;

const MASK_FRAGMENT = `
uniform sampler2D idColour;
uniform sampler2D idDepth;
uniform uint lo[${RUNS}];
uniform uint hi[${RUNS}];
uniform float epsilon;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  #ifdef POINTS
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  #endif
  ivec2 p = ivec2(gl_FragCoord.xy);
  bool seen = gl_FragCoord.z <= texelFetch(idDepth, p, 0).r + epsilon;
  if (!seen) {
    uvec4 b = uvec4(texelFetch(idColour, p, 0) * 255.0 + 0.5);
    uint id = b.r | (b.g << 8) | (b.b << 16) | (b.a << 24);
    for (int i = 0; i < ${RUNS}; i++) if (id >= lo[i] && id < hi[i]) seen = true;
  }
  gl_FragColor = vec4(1.0, seen ? 1.0 : 0.0, 0.0, 1.0);
}`;

const FULL_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// (Per pixel, the covered pixel along its row nearest by offset plus (1 - coverage): that offset and that, for what's
// in sight (rg) and what's hidden (ba); none, a distance beyond any line.)
const ROW_FRAGMENT = `
uniform sampler2D tMask;
uniform vec2 texel;
uniform int reach;
varying vec2 vUv;
void main() {
  vec2 near = vec2(1e4, 0.0), far = vec2(1e4, 0.0);
  for (int x = -reach; x <= reach; x++) {
    float d = abs(float(x));
    vec2 m = texture2D(tMask, vUv + vec2(float(x), 0.0) * texel).rg;
    float h = m.r - m.g;
    if (m.g > 0.01 && d + 1.0 - m.g < near.x + near.y) near = vec2(d, 1.0 - m.g);
    if (h > 0.01 && d + 1.0 - h < far.x + far.y) far = vec2(d, 1.0 - h);
  }
  gl_FragColor = vec4(near, far);
}`;

const COMPOSITE = {
  uniforms: {
    tDiffuse: { value: null }, tMask: { value: null }, tRows: { value: null }, texel: { value: new THREE.Vector2() },
    thickness: { value: 1.25 }, reach: { value: 3 }, seen: { value: new THREE.Color() }, hidden: { value: XRAY },
  },
  vertexShader: FULL_VERTEX,
  fragmentShader: `
uniform sampler2D tDiffuse;
uniform sampler2D tMask;
uniform sampler2D tRows;
uniform vec2 texel;
uniform float thickness;
uniform int reach;
uniform vec3 seen;
uniform float hidden;
varying vec2 vUv;
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  float inside = texture2D(tMask, vUv).r;
  if (inside >= 0.999) {
    gl_FragColor = base;
    return;
  }
  float near = 1e5, far = 1e5;
  for (int y = -reach; y <= reach; y++) {
    float dy = float(y);
    vec4 r = texture2D(tRows, vUv + vec2(0.0, dy) * texel);
    near = min(near, sqrt(r.x * r.x + dy * dy) + r.y);
    far = min(far, sqrt(r.z * r.z + dy * dy) + r.w);
  }
  float outside = 1.0 - inside;
  float a = (1.0 - smoothstep(thickness - 0.5, thickness + 0.5, near)) * outside;
  float b = (1.0 - smoothstep(thickness - 0.5, thickness + 0.5, far)) * outside * hidden * (1.0 - a);
  vec3 c = mix(base.rgb, seen, b);
  gl_FragColor = vec4(mix(c, seen, a), base.a);
}`,
};

/** sRGB as it is (the composite works on the frame's sRGB values). */
const raw = (hex: number) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);

type Drawable = THREE.Mesh | THREE.LineSegments | THREE.Points;

/** Drawn: it and every ancestor visible, up to the scene. */
function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** A geometry of some of an object's index (the same attributes), kept per geometry and ranges. */
const subGeometries = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>();
function subGeometry(g: THREE.BufferGeometry, ranges: readonly { start: number; count: number }[]):
  THREE.BufferGeometry {
  const key = ranges.map((r) => `${r.start}+${r.count}`).join(',');
  let byKey = subGeometries.get(g);
  if (!byKey) subGeometries.set(g, (byKey = new Map()));
  let sub = byKey.get(key);
  if (!sub) {
    sub = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(g.attributes)) sub.setAttribute(name, a);
    const index = g.index!;
    const out: number[] = [];
    for (const r of ranges) for (let i = r.start; i < r.start + r.count; i++) out.push(index.getX(i));
    sub.setIndex(out);
    byKey.set(key, sub);
  }
  return sub;
}

export class Highlights {
  /** The marks (edges' fat lines, vertices' larger dots): a group in the scene, apart from the model. */
  readonly group = new THREE.Group();
  readonly pass: ShaderPass;
  private readonly maskTarget: THREE.WebGLRenderTarget;
  private readonly rowTarget: THREE.WebGLRenderTarget;
  private readonly rows: FullScreenQuad;
  private readonly maskScene = new THREE.Scene();
  private readonly hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private readonly lo = new Uint32Array(RUNS);
  private readonly hi = new Uint32Array(RUNS);
  private readonly shared: Record<string, THREE.IUniform>;
  private readonly maskMaterials: Record<'mesh' | 'line' | 'biased' | 'points', THREE.ShaderMaterial>;
  private highlight: Highlight = { outline: [], marks: [] };
  private readonly markLine = biasTowardCamera(new LineMaterial({ linewidth: 3 }));
  private readonly markDots = new DiscMaterial();
  private readonly lineGeometries = new WeakMap<THREE.BufferGeometry, LineSegmentsGeometry>();
  private marks: { source: Drawable; mark: THREE.Object3D }[] = [];

  constructor() {
    this.group.name = 'highlights';
    this.maskTarget = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.UnsignedByteType,
      depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    this.rowTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    this.rows = new FullScreenQuad(new THREE.ShaderMaterial({ vertexShader: FULL_VERTEX, fragmentShader: ROW_FRAGMENT,
      uniforms: { tMask: { value: this.maskTarget.texture }, texel: { value: new THREE.Vector2() },
        reach: { value: 3 } }, depthTest: false, depthWrite: false }));
    this.shared = { idColour: { value: null }, idDepth: { value: null }, lo: { value: this.lo },
      hi: { value: this.hi }, epsilon: { value: 1e-5 }, depthBias, pointSize: { value: 1 } };
    const make = (defines: Record<string, number>, extra: THREE.ShaderMaterialParameters = {}) =>
      new THREE.ShaderMaterial({ vertexShader: MASK_VERTEX, fragmentShader: MASK_FRAGMENT, uniforms: this.shared,
        defines, clipping: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor, ...extra });
    // (Faces with the offset the id pass gives them, so in sight they're at its depth exactly.)
    this.maskMaterials = { mesh: make({}, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      line: make({}), biased: make({ DEPTH_BIAS: 1 }), points: make({ POINTS: 1, DEPTH_BIAS: 1 }) };
    this.pass = new ShaderPass(COMPOSITE);
    this.pass.enabled = false;
    this.pass.uniforms.tMask!.value = this.maskTarget.texture;
    this.pass.uniforms.tRows!.value = this.rowTarget.texture;
    this.markDots.uniforms.grow!.value = 2;
    this.setColor(0xffe100);
  }

  /** The highlight's colour (sRGB), the silhouette's and the marks'. */
  setColor(hex: number): void {
    this.pass.uniforms.seen!.value = raw(hex);
    this.markLine.color.setHex(hex);
    this.markDots.color.setHex(hex);
  }

  /** Whether anything is highlighted. */
  get active(): boolean {
    return this.highlight.outline.length > 0 || this.highlight.marks.length > 0;
  }

  /** The pieces outlined. */
  get outlinePieces(): readonly Piece[] {
    return this.highlight.outline;
  }

  /** Whether a silhouette is drawn (it wants the id pass each frame). */
  get outlined(): boolean {
    return this.highlight.outline.length > 0;
  }

  /** Highlights these (in place of the last). */
  set(h: Highlight): void {
    this.highlight = h;
    for (const { mark } of this.marks) {
      mark.removeFromParent();
      if (mark instanceof THREE.Points) mark.geometry.dispose();
    }
    this.marks = [];
    for (const { object, ranges } of h.marks) {
      const source = object as Drawable;
      let g = source.geometry;
      if (ranges) g = subGeometry(g, ranges);
      let mark: THREE.Object3D;
      if ((source as THREE.Points).isPoints) {
        mark = new THREE.Points(g, this.markDots);
      } else {
        let fat = this.lineGeometries.get(g);
        if (!fat) this.lineGeometries.set(g, (fat = segmentsOf(g)));
        mark = new Wireframe(fat, this.markLine);
      }
      mark.matrixAutoUpdate = false;
      mark.matrixWorldAutoUpdate = false;
      mark.raycast = () => {};
      this.group.add(mark);
      this.marks.push({ source, mark });
    }
    this.pass.enabled = h.outline.length > 0;
  }

  /**
   * Before a frame: the drawing buffer's size (device pixels), the pixel ratio, the silhouette's width and the edges'
   * marks' (CSS pixels).
   */
  setSize(width: number, height: number, pixelRatio: number, silhouette: number, markWidth: number): void {
    if (this.maskTarget.width !== width || this.maskTarget.height !== height) {
      this.maskTarget.setSize(width, height);
      this.rowTarget.setSize(width, height);
    }
    const thickness = silhouette * pixelRatio;
    // (As far as a pixel can be from a covered one and still be on the line: its width, a pixel's smoothing, and
    // the coverage's pixel.)
    const reach = Math.ceil(thickness + 1.5);
    for (const u of [this.pass.uniforms, (this.rows.material as THREE.ShaderMaterial).uniforms]) {
      u.texel!.value.set(1 / width, 1 / height);
      u.reach!.value = reach;
    }
    this.pass.uniforms.thickness!.value = thickness;
    this.markLine.linewidth = markWidth;
  }

  /**
   * Before a frame: the marks follow their sources (placement, visibility); the mask drawn, from the id pass's target
   * (its ids and depth) and the highlight's ids (`runs`, pick-ids.ts's idsOf), `pointSize` the dots' device pixels.
   */
  update(renderer: THREE.WebGLRenderer, camera: THREE.Camera, ids: THREE.WebGLRenderTarget | undefined,
    runs: readonly [number, number][], pointSize: (m: THREE.Material) => number): void {
    for (const { source, mark } of this.marks) {
      mark.visible = shown(source) && !!source.parent;
      mark.matrixWorld.copy(source.matrixWorld);
    }
    if (!this.pass.enabled || !ids) return;
    const cover = coverRuns(runs, RUNS);
    this.lo.fill(0);
    this.hi.fill(0);
    cover.forEach(([a, b], i) => {
      this.lo[i] = a;
      this.hi[i] = b;
    });
    this.shared.idColour!.value = ids.texture;
    this.shared.idDepth!.value = ids.depthTexture;
    const proxies: THREE.Object3D[] = [];
    for (const { object, ranges } of this.highlight.outline) {
      const d = object as Drawable;
      if (!d.parent || !shown(d)) continue;
      const g = ranges ? subGeometry(d.geometry, ranges) : d.geometry;
      const first = [d.material].flat()[0]!;
      let proxy: THREE.Object3D;
      if ((d as THREE.Mesh).isMesh) {
        const m = this.maskMaterials.mesh;
        proxy = new THREE.Mesh(g, Array.isArray(d.material) && !ranges ? d.material.map((x) => x.visible ? m
          : this.hiddenMaterial) : m);
      } else if ((d as THREE.Points).isPoints) {
        // (Points of one size: the first's.)
        this.shared.pointSize!.value = pointSize(first);
        proxy = new THREE.Points(g, this.maskMaterials.points);
      } else {
        proxy = new THREE.LineSegments(g, first.userData.depthBias ? this.maskMaterials.biased
          : this.maskMaterials.line);
      }
      proxy.matrixAutoUpdate = false;
      proxy.matrixWorldAutoUpdate = false;
      proxy.matrixWorld.copy(d.matrixWorld);
      // (Every layer, whatever the camera shows: the camera's own layers decide what was drawn.)
      proxy.layers.mask = d.layers.mask;
      proxies.push(proxy);
    }
    this.maskScene.add(...proxies);
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    const was = renderer.getRenderTarget();
    try {
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.maskTarget);
      renderer.clear(true, false, false);
      renderer.render(this.maskScene, camera);
      renderer.setRenderTarget(this.rowTarget);
      this.rows.render(renderer);
    } finally {
      renderer.setRenderTarget(was);
      renderer.setClearColor(clear, alpha);
      if (proxies.length) this.maskScene.remove(...proxies);
    }
  }
}

/** A line geometry's segments as LineSegmentsGeometry wants them: each segment's two ends, not indexed. */
function segmentsOf(g: THREE.BufferGeometry): LineSegmentsGeometry {
  const pos = g.getAttribute('position');
  const index = g.index;
  const n = index ? index.count : pos.count;
  const m = n - (n % 2);
  const out = new Float32Array(m * 3);
  for (let i = 0; i < m; i++) {
    const v = index ? index.getX(i) : i;
    out[3 * i] = pos.getX(v);
    out[3 * i + 1] = pos.getY(v);
    out[3 * i + 2] = pos.getZ(v);
  }
  return new LineSegmentsGeometry().setPositions(out);
}
