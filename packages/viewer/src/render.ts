// The rendering style, after the sibling cadrender prototype (docs/viewer.md): Phong faces, ambient occlusion by
// N8AO (with postprocessing, which it imports), SMAA antialiasing, and the faces' edges. Frames are composed by
// three.js's EffectComposer: N8AO's pass renders the scene and darkens it, SMAA smooths it; without AO, a plain render
// pass and the output pass (colour space) stand in.
//
// The AO radius is in screen pixels: CAD models are viewed at every scale. Edges are on a layer of their own (EDGES,
// style.ts), so showing them is the camera's business, apart from each node's own hidden flag. Transparency is
// three.js's own: transparent objects sorted back to front, whole; N8AO works around them when told there are any
// (setTransparent: its own detection looks only at single materials, and every face mesh has an array of them).
//
// Reveal (model.ts): while something is revealed, the frame is composed without what isn't (the ghosts), so N8AO
// darkens only what's drawn as it is; then RevealPass draws the ghosts (the REVEAL layer: their twins, scene-graph.ts)
// over it, in two draws: their nearest depth alone (no colour; depth tested and written against what's there, N8AO's
// depth copied in first), then their colour at Reveal alpha, blended, only where a ghost is that nearest (depth equal),
// so a pixel blends one ghost layer however many lie in front of what's revealed. It works in linear colour, before
// the output pass (N8AO's own gamma correction off meanwhile).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { N8AOPass } from 'n8ao';
import { DEFAULT_RENDER, EDGES, REVEAL, type RenderSettings } from './style.ts';

/** What RevealPass needs of the viewer: placing the ghosts' twins, and setting their materials for each draw. */
export interface Ghosts {
  place(): void;
  pass(depth: boolean): void;
}

/** The ghosts over the frame (the file's comment), into the frame read (no swap). */
export class RevealPass extends Pass {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly ghosts: Ghosts;
  /** The depth the frame was drawn with, where it isn't the frame's own (N8AO's). */
  depth?: () => THREE.Texture | undefined;
  private readonly copy = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { depth: { value: null } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D depth; varying vec2 vUv; ' +
      'void main() { gl_FragDepth = texture2D(depth, vUv).r; gl_FragColor = vec4(0.0); }',
    colorWrite: false, depthWrite: true, depthTest: true, depthFunc: THREE.AlwaysDepth }));

  constructor(scene: THREE.Scene, camera: THREE.Camera, ghosts: Ghosts) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.ghosts = ghosts;
    this.needsSwap = false;
  }

  override render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget):
    void {
    const { scene, camera } = this;
    const autoClear = renderer.autoClear, background = scene.background, mask = camera.layers.mask;
    renderer.setRenderTarget(read);
    renderer.autoClear = false;
    scene.background = null;
    try {
      const d = this.depth?.();
      if (d) {
        (this.copy.material as THREE.ShaderMaterial).uniforms.depth!.value = d;
        this.copy.render(renderer);
      }
      this.ghosts.place();
      camera.layers.set(REVEAL);
      this.ghosts.pass(true);
      renderer.render(scene, camera);
      this.ghosts.pass(false);
      renderer.render(scene, camera);
    } finally {
      camera.layers.mask = mask;
      scene.background = background;
      renderer.autoClear = autoClear;
    }
  }
}

/** The composer and its passes, set from the settings. */
export class Composer {
  private readonly composer: EffectComposer;
  private readonly n8ao: N8AOPass;
  private readonly plain: RenderPass;
  private readonly output: OutputPass;
  private readonly smaa: SMAAPass;
  private settings: RenderSettings = { ...DEFAULT_RENDER };
  private readonly camera: THREE.Camera;
  /** A pass after all the others (the highlights' silhouette: outline.ts), drawn while it's enabled. */
  private final?: Pass;
  /** The ghosts' pass, while something is revealed (`setReveal`). */
  private reveal?: RevealPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number,
    height: number) {
    this.camera = camera;
    // Render targets with a stencil buffer, which the section caps need (N8AO's too).
    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(width, height,
      { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: true }));
    this.n8ao = new N8AOPass(scene, camera, width, height);
    this.n8ao.configuration.stencil = true;
    this.plain = new RenderPass(scene, camera);
    this.output = new OutputPass();
    this.smaa = new SMAAPass();
    this.set(this.settings);
  }

  set(s: RenderSettings): void {
    this.settings = { ...s };
    for (const p of [...this.composer.passes]) this.composer.removePass(p);
    // (With the ghosts, the output pass after them in both cases: N8AO's gamma correction off.)
    this.n8ao.configuration.gammaCorrection = !this.reveal;
    if (this.reveal) this.reveal.depth = s.ao ? () => (this.n8ao as unknown as { beautyRenderTarget:
      THREE.WebGLRenderTarget }).beautyRenderTarget.depthTexture ?? undefined : undefined;
    this.composer.addPass(s.ao ? this.n8ao : this.plain);
    if (this.reveal) this.composer.addPass(this.reveal);
    if (!s.ao || this.reveal) this.composer.addPass(this.output);
    if (s.smaa) this.composer.addPass(this.smaa);
    if (this.final) this.composer.addPass(this.final);
    const c = this.n8ao.configuration;
    this.n8ao.setQualityMode(s.aoQuality);
    c.intensity = s.aoIntensity;
    c.screenSpaceRadius = true;
    c.aoRadius = s.aoRadius;
    c.distanceFalloff = 0.2;
    if (s.edges) this.camera.layers.enable(EDGES);
    else this.camera.layers.disable(EDGES);
  }

  /** The last pass (after SMAA, so its lines are its own antialiasing's). */
  setFinal(pass: Pass): void {
    this.final = pass;
    this.set(this.settings);
  }

  /** The ghosts drawn over the frame (something revealed), or not. */
  setReveal(pass: RevealPass | undefined): void {
    if (pass === this.reveal) return;
    this.reveal = pass;
    this.set(this.settings);
  }

  /** Whether the scene has transparent materials, for N8AO (which then renders them apart). */
  setTransparent(on: boolean): void {
    this.n8ao.configuration.transparencyAware = on;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(): void {
    this.composer.render();
  }
}
