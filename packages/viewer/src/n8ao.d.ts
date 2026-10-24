// Types for what the viewer uses of n8ao (2.0.1), which ships none.
declare module 'n8ao' {
  import type { Camera, Scene } from 'three';
  import { Pass } from 'three/addons/postprocessing/Pass.js';

  export class N8AOPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: {
      intensity: number;
      aoRadius: number;
      distanceFalloff: number;
      screenSpaceRadius: boolean;
      transparencyAware: boolean;
      halfRes: boolean;
      stencil: boolean;
      gammaCorrection: boolean;
    };
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
    setDisplayMode(mode: 'Combined' | 'AO' | 'No AO' | 'Split' | 'Split AO'): void;
  }
}
