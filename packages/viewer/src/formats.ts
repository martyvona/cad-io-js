// Which importer a file goes to, by its extension; each importer gives the scene in millimetres, Z up (CLAUDE.md,
// "Decisions": importers for every format, phase 5).

export type Format = 'step' | 'gltf' | 'glb' | 'threejs' | '3mf';

export const EXTENSIONS: Record<string, Format> = {
  '.stp': 'step', '.step': 'step', '.stpz': 'step', '.glb': 'glb', '.gltf': 'gltf', '.json': 'threejs',
  '.3mf': '3mf',
};

/** The format a file name's extension says, or undefined. */
export function formatOf(name: string): Format | undefined {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : EXTENSIONS[name.slice(dot).toLowerCase()];
}

