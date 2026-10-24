// stepconv: STEP (Part 21, or gzipped .stpZ) to a tessellated format. See README.md,
// "`stepconv`: STEP to three.js, glTF or 3MF", and CLAUDE.md, "Decisions".
//
//   import (step-import) -> tessellate each part (a backend, in a tess-workers pool unless --workers 0, cached with
//   tess-cache when --cache names a directory) -> the export view (cad-scene) -> an exporter, chosen by the output's
//   extension or --format. A summary and the diagnostics go to standard error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { exportView, tessellateScene, type Diagnostic, type ExportView, type Scene, type Tessellator } from 'cad-scene';
import { threemf } from 'export-3mf';
import { glb, gltfJson, type GltfOptions } from 'export-gltf';
import { threejsChunks } from 'export-threejs';
import { importStep } from 'step-import';
import { readStep } from 'step-parser';
import { CachedTessellator, FileStore, DEFAULT_FILE_BYTES } from 'tess-cache';
import { DEFAULT_TIMEOUT_MS, WorkerTessellator } from 'tess-workers';
import type { Io } from './step2json.ts';

interface Format {
  extensions: string[];
  description: string;
  /** Needs a file beside the output (so can't write standard output), unless --gltf-embed. */
  sidecar?: string;
  /** Takes the --gltf-* options. */
  gltf?: boolean;
  /** Takes the --3mf-* options; has no lines (no --with-edges, --with-curves, --unlit-lines), no double-sided faces. */
  threemf?: boolean;
  write(scene: Scene, view: ExportView, opts: FormatOptions): Promise<Written> | Written;
}

interface FormatOptions {
  name: string;
  doubleSided: boolean;
  keepHidden: boolean;
  /** The sidecar's file name, beside the output, for formats with one; empty: embedded. */
  sidecar: string;
  unlitLines: boolean;
  colorgroup: boolean;
  assembly: boolean;
  surfaces: boolean;
}

interface Written {
  chunks: Iterable<string | Uint8Array>;
  /** The sidecar's contents, for formats with one. */
  sidecar?: Uint8Array;
  diagnostics?: Diagnostic[];
}

const FORMATS: Record<string, Format> = {
  threejs: {
    extensions: ['.json'],
    description: 'three.js JSON Object Scene format 4 (THREE.ObjectLoader)',
    write: (scene, view, o) => ({ chunks: threejsChunks(scene, view, { name: o.name, doubleSided: o.doubleSided }) }),
  },
  glb: {
    extensions: ['.glb'],
    description: 'glTF 2.0, binary',
    gltf: true,
    write: async (scene, view, o) => {
      const r = await glb(scene, view, gltfOptions(o));
      return { chunks: [r.bytes], diagnostics: r.diagnostics };
    },
  },
  gltf: {
    extensions: ['.gltf'],
    description: 'glTF 2.0, JSON with its buffer in a .bin beside it (or embedded: --gltf-embed)',
    sidecar: '.bin',
    gltf: true,
    write: async (scene, view, o) => {
      const r = await gltfJson(scene, view, o.sidecar || undefined, gltfOptions(o));
      return { chunks: [r.json], sidecar: r.bin, diagnostics: r.diagnostics };
    },
  },
  '3mf': {
    extensions: ['.3mf'],
    description: '3MF core, closed meshes (an item per placed part; colours as basematerials)',
    threemf: true,
    write: (scene, view, o) => {
      const r = threemf(scene, view, {
        name: o.name, colors: o.colorgroup ? 'colorgroup' : 'basematerials', build: o.assembly ? 'assembly' : 'parts',
        nonManifold: o.surfaces ? 'surface' : 'omit', hidden: o.keepHidden ? 'keep' : 'omit',
      });
      return { chunks: r.chunks, diagnostics: r.diagnostics };
    },
  },
};

function gltfOptions(o: FormatOptions): GltfOptions {
  return { name: o.name, doubleSided: o.doubleSided, hidden: o.keepHidden ? 'extension' : 'omit',
    unlitLines: o.unlitLines };
}

const BACKENDS: Record<string, { module: string; export: string }> = {
  occt: { module: 'tess-occt', export: 'OcctTessellator' },
  truck: { module: 'tess-truck', export: 'TruckTessellator' },
};

const defaultWorkers = () => Math.max(1, os.availableParallelism() - 1);
/** The library's angular deflection, 0.5 rad, used exactly when --angular-deflection isn't given. */
const DEFAULT_ANGULAR = 0.5;
const degrees = (rad: number) => (rad * 180) / Math.PI;

const FORMAT_LINES = Object.entries(FORMATS)
  .map(([k, f]) => `  ${k.padEnd(10)} ${f.extensions.join(', ').padEnd(12)} ${f.description}`).join('\n');
const DEFAULT_DEGREES = degrees(DEFAULT_ANGULAR).toFixed(1);

const USAGE = `Usage: stepconv [options] <file.stp | file.stpZ | -> -o <output>

Converts a STEP file to a tessellated format, chosen by the output's extension or --format. '-' reads standard
input; '-o -' writes standard output (with --format).

Formats:
${FORMAT_LINES}

Options:
  -o, --output <file>      the output file
  -f, --format <format>    the output format, whatever the extension
  -b, --backend <name>     occt (default) or truck
  -d, --deflection <mm>    maximum distance between mesh and surface, in millimetres (default 0.1)
      --angular-deflection <deg>
                           maximum angle between adjacent mesh normals, in degrees (default ${DEFAULT_DEGREES},
                           0.5 rad; truck ignores it)
      --with-edges         write B-rep edges (not 3MF, which has no lines)
      --with-curves        write wireframe curves and points (not 3MF)
      --unlit-lines        edges, curves and points in a flat colour: glTF with KHR_materials_unlit (three.js
                           lines are always unlit; not 3MF)
      --double-sided       render faces from both sides (not 3MF)
      --keep-hidden        glTF: write hidden instances with KHR_node_visibility; 3MF: as ordinary parts
                           (default: left out); three.js always writes them hidden
      --gltf-embed         .gltf: the buffer embedded as base64 instead of a .bin beside it (a third bigger)
      --3mf-colorgroup     3MF: colours as the Materials extension's colorgroup (print colours, opaque) instead
                           of basematerials (display colours)
      --3mf-assembly       3MF: one build item, the assembly as components, instead of an item per placed part
      --3mf-surfaces       3MF: meshes that aren't closed manifolds as surface objects instead of left out
  -j, --workers <n>        parts tessellated at once, each in a worker (default ${defaultWorkers()}); 0: one at a time
                           on the main thread, without a timeout
      --timeout <s>        per part, in a worker (default ${DEFAULT_TIMEOUT_MS / 1000}); 0: none
      --cache <dir>        cache tessellations in this directory
      --cache-size <MB>    the cache's maximum size (default ${DEFAULT_FILE_BYTES / 2 ** 20})
      --strict             exit 3 if a part fails to tessellate (the output is written all the same)
  -q, --quiet              no summary on standard error
  -h, --help               show this help
`;

/**
 * Run stepconv with these arguments; returns the exit code: 0 success, 1 usage error, 2 failure (nothing written), 3
 * with --strict, parts that failed to tessellate.
 */
export async function stepconv(argv: string[], io: Io): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        output: { type: 'string', short: 'o' },
        format: { type: 'string', short: 'f' },
        backend: { type: 'string', short: 'b', default: 'occt' },
        deflection: { type: 'string', short: 'd', default: '0.1' },
        'angular-deflection': { type: 'string' },
        'with-edges': { type: 'boolean', default: false },
        'with-curves': { type: 'boolean', default: false },
        'unlit-lines': { type: 'boolean', default: false },
        'double-sided': { type: 'boolean', default: false },
        'keep-hidden': { type: 'boolean', default: false },
        'gltf-embed': { type: 'boolean', default: false },
        '3mf-colorgroup': { type: 'boolean', default: false },
        '3mf-assembly': { type: 'boolean', default: false },
        '3mf-surfaces': { type: 'boolean', default: false },
        workers: { type: 'string', short: 'j' },
        timeout: { type: 'string' },
        cache: { type: 'string' },
        'cache-size': { type: 'string' },
        strict: { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.stderr.write(`stepconv: ${(e as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const o = args.values;
  if (o.help) { io.stdout.write(USAGE); return 0; }
  const usage = (msg: string) => { io.stderr.write(`stepconv: ${msg}\n\n${USAGE}`); return 1; };
  if (args.positionals.length !== 1) return usage('expected one input file');
  if (o.output === undefined) return usage('expected an output file (-o)');
  let formatName = o.format;
  if (formatName === undefined) {
    if (o.output === '-') return usage('writing standard output needs --format');
    const ext = path.extname(o.output).toLowerCase();
    formatName = Object.keys(FORMATS).find((k) => FORMATS[k]!.extensions.includes(ext));
    if (!formatName) return usage(`can't tell the format from '${ext || o.output}'; use --format`);
  }
  const format = FORMATS[formatName];
  if (!format) return usage(`unknown format '${formatName}'`);
  if (o['gltf-embed'] && !format.gltf) return usage('--gltf-embed applies to glb and gltf output');
  const threemfGiven = (['3mf-colorgroup', '3mf-assembly', '3mf-surfaces'] as const).find((f) => o[f]);
  if (threemfGiven && !format.threemf) return usage(`--${threemfGiven} applies to 3mf output`);
  const notThreemf = (['with-edges', 'with-curves', 'unlit-lines', 'double-sided'] as const).find((f) => o[f]);
  if (notThreemf && format.threemf) return usage(`--${notThreemf} doesn't apply to 3mf output`);
  if (o['gltf-embed'] && !format.sidecar) return usage('--gltf-embed applies to gltf output (GLB holds its buffer)');
  const embed = o['gltf-embed'];
  if (format.sidecar && !embed && o.output === '-') return usage(
    `${formatName} writes a ${format.sidecar} file beside the output, so not to standard output`);
  const backend = BACKENDS[o.backend];
  if (!backend) return usage(`unknown backend '${o.backend}'`);
  let bad: string | undefined;
  const number = (name: string, text: string | undefined, fallback: number, positive: boolean) => {
    const v = text === undefined ? fallback : Number(text);
    if (!(Number.isFinite(v) && (
      positive ? v > 0 : v >= 0))) bad ??= `--${name} must be a ${positive ? 'positive' : 'non-negative'} number`;
    return v;
  };
  const deflection = number('deflection', o.deflection, 0.1, true);
  const angularText = o['angular-deflection'];
  const angularDegrees = number('angular-deflection', angularText, degrees(DEFAULT_ANGULAR), true);
  if (angularDegrees > 180) bad ??= '--angular-deflection must be at most 180 degrees';
  const angular = angularText === undefined ? DEFAULT_ANGULAR : (angularDegrees * Math.PI) / 180;
  const workers = number('workers', o.workers, defaultWorkers(), false);
  const timeout = number('timeout', o.timeout, DEFAULT_TIMEOUT_MS / 1000, false);
  const cacheMb = number('cache-size', o['cache-size'], DEFAULT_FILE_BYTES / 2 ** 20, false);
  if (bad) return usage(bad);
  if (!Number.isInteger(workers)) return usage('--workers must be a whole number');
  if (o['cache-size'] !== undefined && o.cache === undefined) return usage('--cache-size needs --cache');

  const input = args.positionals[0]!;
  const name = input === '-' ? 'stdin' : path.basename(input).replace(/\.(stp|step|p21|stpz)$/i, '');
  const times = { import: 0, tessellate: 0, export: 0 };
  let t = performance.now();
  const lap = (k: keyof typeof times) => { const now = performance.now(); times[k] = now - t; t = now; };

  let scene: Scene;
  try {
    const file = await readStep(
      input === '-' ? (Readable.toWeb(io.stdin) as ReadableStream<Uint8Array>) : fs.readFileSync(input));
    scene = (await importStep(file)).scene;
  } catch (e) {
    io.stderr.write(`stepconv: can't read ${input}: ${(e as Error).message}\n`);
    return 2;
  }
  lap('import');

  // The output is opened before the long part, so a bad path fails at once.
  let out: Writable;
  let outError: Error | undefined;
  try {
    out = o.output === '-' ? io.stdout : fs.createWriteStream(o.output, { fd: fs.openSync(o.output, 'w') });
  } catch (e) {
    io.stderr.write(`stepconv: can't write ${o.output}: ${(e as Error).message}\n`);
    return 2;
  }
  if (out !== io.stdout) out.on('error', (e: Error) => { outError = e; out.emit('drain'); });
  // The sidecar (glTF's .bin): beside the output, named after it.
  const sidecar = format.sidecar && !embed ? `${path.basename(o.output, path.extname(o.output))}${format.sidecar}` : '';
  const sidecarPath = path.join(path.dirname(o.output), sidecar);
  let sidecarWritten = false;
  // On a failure after this, no partial file is left (and nothing removed that this run didn't write).
  const abandon = () => {
    if (out === io.stdout) return;
    out.destroy();
    fs.rmSync(o.output!, { force: true });
    if (sidecarWritten) fs.rmSync(sidecarPath, { force: true });
  };

  let tess: Tessellator;
  let cached: CachedTessellator | undefined;
  try {
    if (workers > 0) {
      tess = new WorkerTessellator(
        { backend: { module: import.meta.resolve(backend.module), export: backend.export }, workers,
        ...(o.timeout === undefined ? {} : { timeoutMs: timeout * 1000 }) });  // else the pool's default
    } else {
      const mod = (await import(backend.module)) as Record<string, new () => Tessellator>;
      tess = new mod[backend.export]!();
    }
    if (o.cache !== undefined) tess = cached = new CachedTessellator(tess,
      new FileStore({ dir: o.cache, maxBytes: cacheMb * 2 ** 20 }));
    await tess.init();
  } catch (e) {
    io.stderr.write(`stepconv: can't start the ${o.backend} backend: ${(e as Error).message}\n`);
    abandon();
    return 2;
  }

  const diagnostics: Diagnostic[] = [...scene.diagnostics];
  const progress = !o.quiet && (io.stderr as { isTTY?: boolean }).isTTY === true;
  let meshes;
  try {
    const r = await tessellateScene(scene, tess, {
      linearDeflection: deflection, angularDeflection: angular, edges: o['with-edges'],
      concurrency: Math.max(1, workers),
      onPart: progress ? (_p, _m, done, total) => io.stderr.write(`\rtessellating ${done}/${total}`) : undefined,
    });
    if (progress) io.stderr.write('\r\x1b[K');
    meshes = r.meshes;
    diagnostics.push(...r.diagnostics);
  } finally {
    tess.dispose();
  }
  lap('tessellate');

  const view = exportView(scene, meshes, { edges: o['with-edges'], curves: o['with-curves'] });
  let written = 0;
  try {
    const w = await format.write(scene, view, {
      name, doubleSided: o['double-sided'], keepHidden: o['keep-hidden'], sidecar, unlitLines: o['unlit-lines'],
      colorgroup: o['3mf-colorgroup'], assembly: o['3mf-assembly'], surfaces: o['3mf-surfaces'],
    });
    diagnostics.push(...(w.diagnostics ?? []));
    // (None when embedded, or when there's no buffer: a scene with nothing to draw.)
    if (sidecar && w.sidecar?.length) {
      fs.writeFileSync(sidecarPath, w.sidecar);
      sidecarWritten = true;
      written += w.sidecar.length;
    }
    for (const c of w.chunks) {
      written += typeof c === 'string' ? Buffer.byteLength(c) : c.length;
      if (!out.write(c)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      if (outError) throw outError;
    }
    if (out !== io.stdout) await new Promise<void>((resolve) => out.end(() => resolve()));
    if (outError) throw outError;
  } catch (e) {
    io.stderr.write(`stepconv: can't write ${o.output}: ${(e as Error).message}\n`);
    abandon();
    return 2;
  }
  lap('export');

  if (!o.quiet) io.stderr.write(summary(scene, meshes.size, view, diagnostics, times, written, cached));
  const failed = scene.parts.filter((p, i) => p.kind === 'brep' && !meshes.has(i)).length;
  return o.strict && failed ? 3 : 0;
}

function summary(scene: Scene, meshed: number, view: ExportView, diagnostics: readonly Diagnostic[],
  times: Record<string, number>,
  written: number, cached: CachedTessellator | undefined): string {
  const brep = scene.parts.filter((p) => p.kind === 'brep').length;
  let placed = 0, triangles = 0;
  const walk = (n: ExportView['roots'][number]) => {
    for (const p of n.parts) { placed++; triangles += view.looks[p.look]!.indices.length / 3; }
    n.children.forEach(walk);
  };
  view.roots.forEach(walk);
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  let text = `${scene.parts.length} parts (${meshed} of ${brep} brep parts tessellated), ${placed} placed; `
    + `${triangles} triangles; `
    + `${(written / 1e6).toFixed(1)} MB written\n`;
  text += `import ${s(times.import!)}, tessellation ${s(times.tessellate!)}, export ${s(times.export!)}\n`;
  if (cached) {
    const c = cached.stats();
    text += `cache: ${c.hits} hits (${c.failureHits} failures), ${c.misses} `
      + `misses${c.errors ? `, ${c.errors} errors` : ''}\n`;
  }
  const count = (sev: Diagnostic['severity']) => diagnostics.filter((d) => d.severity === sev).length;
  text += `${count('error')} errors, ${count('warning')} warnings, ${count('info')} notes\n`;
  const shown = diagnostics.filter((d) => d.severity !== 'info').slice(0, 20);
  for (const d of shown) text += `  ${d.severity}: ${d.source ? `#${d.source.id}: ` : ''}${d.message}\n`;
  if (shown.length < count('error') + count('warning')) text += '  ...\n';
  return text;
}
