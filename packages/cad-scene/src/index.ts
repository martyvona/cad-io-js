export type * from './scene.ts';
export type * from './tessellator.ts';
export { TessellationError } from './errors.ts';
export { identity, multiply, scaling, instances, partInstances, validate, type ComponentInstance, type PartInstance } from './walk.ts';
export { tessellateScene, toMesh, type TessellateOptions, type TessellateResult } from './tessellate.ts';
export { exportView, partMesh, type ExportNode, type ExportView, type ExportViewOptions, type Look } from './export.ts';
