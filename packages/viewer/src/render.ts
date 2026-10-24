// The rendering style, after the sibling cadrender prototype (the user, 2026-10-24; CLAUDE.md, "The viewer"): Phong
// faces, ambient occlusion by N8AO (with postprocessing, which it imports), SMAA antialiasing, and the faces' edges.
// Frames are composed by three.js's EffectComposer: N8AO's pass renders the scene and darkens it, SMAA smooths it;
// without AO, a plain render pass and the output pass (colour space) stand in.
//
// The AO radius is in screen pixels: CAD models are viewed at every scale. Edges are on a layer of their own (EDGES,
// style.ts), so showing them is the camera's business, apart from each node's own hidden flag. Transparency is
// three.js's own: transparent objects sorted back to front, whole; N8AO notices them and works around them itself.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { N8AOPass } from 'n8ao';
import { DEFAULT_RENDER, EDGES, type RenderSettings } from './style.ts';

/** The composer and its passes, set from the settings. */
export class Composer {
  private readonly composer: EffectComposer;
  private readonly n8ao: N8AOPass;
  private readonly plain: RenderPass;
  private readonly output: OutputPass;
  private readonly smaa: SMAAPass;
  private settings: RenderSettings = { ...DEFAULT_RENDER };
  private readonly camera: THREE.Camera;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number,
    height: number) {
    this.camera = camera;
    this.composer = new EffectComposer(renderer);
    this.n8ao = new N8AOPass(scene, camera, width, height);
    this.plain = new RenderPass(scene, camera);
    this.output = new OutputPass();
    this.smaa = new SMAAPass();
    this.set(this.settings);
  }

  set(s: RenderSettings): void {
    this.settings = { ...s };
    for (const p of [...this.composer.passes]) this.composer.removePass(p);
    if (s.ao) this.composer.addPass(this.n8ao);
    else {
      this.composer.addPass(this.plain);
      this.composer.addPass(this.output);
    }
    if (s.smaa) this.composer.addPass(this.smaa);
    const c = this.n8ao.configuration;
    this.n8ao.setQualityMode(s.aoQuality);
    c.intensity = s.aoIntensity;
    c.screenSpaceRadius = true;
    c.aoRadius = s.aoRadius;
    c.distanceFalloff = 0.2;
    if (s.edges) this.camera.layers.enable(EDGES);
    else this.camera.layers.disable(EDGES);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(): void {
    this.composer.render();
  }
}
