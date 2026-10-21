// stepconv: STEP (Part 21, or gzipped .stpZ) to a tessellated format. See docs/architecture.md, "Stage 4", and
// docs/phase4_progress.md, step 3.
//
//   import (step-import) → tessellate each part (a backend, in a tess-workers pool unless --workers 0, cached with
//   tess-cache when --cache names a directory) → the export view (cad-scene) → an exporter, chosen by the output's
//   extension or --format. A summary and the diagnostics go to standard error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { exportView, tessellateScene, type Diagnostic, type ExportView, type Scene, type Tessellator } from 'cad-scene';
import { threejsChunks } from 'export-threejs';
import { importStep } from 'step-import';
import { readStep } from 'step-parser';
import { CachedTessellator, FileStore, DEFAULT_FILE_BYTES } from 'tess-cache';
import { WorkerTessellator } from 'tess-workers';
import type { Io } from './step2json.ts';

interface Format {
  extensions: string[];
  description: string;
  write(scene: Scene, view: ExportView, opts: FormatOptions): Iterable<string | Uint8Array>;
}

interface FormatOptions {
  name: string;
  doubleSided: boolean;
}

const FORMATS: Record<string, Format> = {
  threejs: {
    extensions: ['.json'],
    description: 'three.js JSON Object Scene format 4 (THREE.ObjectLoader)',
    write: (scene, view, o) => threejsChunks(scene, view, { name: o.name, doubleSided: o.doubleSided }),
  },
};

const BACKENDS: Record<string, { module: string; export: string }> = {
  occt: { module: 'tess-occt', export: 'OcctTessellator' },
  truck: { module: 'tess-truck', export: 'TruckTessellator' },
};

const defaultWorkers = () => Math.max(1, os.availableParallelism() - 1);
/** The library's angular deflection, 0.5 rad, used exactly when --angular isn't given. */
const DEFAULT_ANGULAR = 0.5;
const degrees = (rad: number) => (rad * 180) / Math.PI;

const USAGE = `Usage: stepconv [options] <file.stp | file.stpZ | -> -o <output>

Converts a STEP file to a tessellated format, chosen by the output's extension or --format. '-' reads standard
input; '-o -' writes standard output (with --format).

Formats:
${Object.entries(FORMATS).map(([k, f]) => `  ${k.padEnd(10)} ${f.extensions.join(', ').padEnd(12)} ${f.description}`).join('\n')}

Options:
  -o, --output <file>      the output file
  -f, --format <format>    the output format, whatever the extension
  -b, --backend <name>     occt (default) or truck
  -d, --deflection <mm>    maximum distance between mesh and surface, in millimetres (default 0.1)
      --angular <deg>      maximum angle between adjacent mesh normals, in degrees (default ${degrees(DEFAULT_ANGULAR).toFixed(1)},
                           0.5 rad; truck ignores it)
      --edges              write B-rep edges
      --curves             write wireframe curves and points
      --double-sided       render faces from both sides (three.js)
  -j, --workers <n>        parts tessellated at once, each in a worker (default ${defaultWorkers()}); 0: one at a time
                           on the main thread, without a timeout
      --timeout <s>        per part, in a worker (default 120); 0: none
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
        angular: { type: 'string' },
        edges: { type: 'boolean', default: false },
        curves: { type: 'boolean', default: false },
        'double-sided': { type: 'boolean', default: false },
        workers: { type: 'string', short: 'j' },
        timeout: { type: 'string', default: '120' },
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
  const backend = BACKENDS[o.backend];
  if (!backend) return usage(`unknown backend '${o.backend}'`);
  let bad: string | undefined;
  const number = (name: string, text: string | undefined, fallback: number, positive: boolean) => {
    const v = text === undefined ? fallback : Number(text);
    if (!(Number.isFinite(v) && (positive ? v > 0 : v >= 0))) bad ??= `--${name} must be a ${positive ? 'positive' : 'non-negative'} number`;
    return v;
  };
  const deflection = number('deflection', o.deflection, 0.1, true);
  const angularDegrees = number('angular', o.angular, degrees(DEFAULT_ANGULAR), true);
  if (angularDegrees > 180) bad ??= '--angular must be at most 180 degrees';
  const angular = o.angular === undefined ? DEFAULT_ANGULAR : (angularDegrees * Math.PI) / 180;
  const workers = number('workers', o.workers, defaultWorkers(), false);
  const timeout = number('timeout', o.timeout, 120, false);
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
    const file = await readStep(input === '-' ? (Readable.toWeb(io.stdin) as ReadableStream<Uint8Array>) : fs.readFileSync(input));
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
  // On a failure after this, no partial file is left.
  const abandon = () => {
    if (out === io.stdout) return;
    out.destroy();
    fs.rmSync(o.output!, { force: true });
  };

  let tess: Tessellator;
  let cached: CachedTessellator | undefined;
  try {
    if (workers > 0) {
      tess = new WorkerTessellator({ backend: { module: import.meta.resolve(backend.module), export: backend.export }, workers, timeoutMs: timeout * 1000 });
    } else {
      const mod = (await import(backend.module)) as Record<string, new () => Tessellator>;
      tess = new mod[backend.export]!();
    }
    if (o.cache !== undefined) tess = cached = new CachedTessellator(tess, new FileStore({ dir: o.cache, maxBytes: cacheMb * 2 ** 20 }));
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
      linearDeflection: deflection, angularDeflection: angular, edges: o.edges, concurrency: Math.max(1, workers),
      onPart: progress ? (_p, _m, done, total) => io.stderr.write(`\rtessellating ${done}/${total}`) : undefined,
    });
    if (progress) io.stderr.write('\r\x1b[K');
    meshes = r.meshes;
    diagnostics.push(...r.diagnostics);
  } finally {
    tess.dispose();
  }
  lap('tessellate');

  const view = exportView(scene, meshes, { edges: o.edges, curves: o.curves });
  let written = 0;
  try {
    for (const c of format.write(scene, view, { name, doubleSided: o['double-sided'] })) {
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

function summary(scene: Scene, meshed: number, view: ExportView, diagnostics: readonly Diagnostic[], times: Record<string, number>,
  written: number, cached: CachedTessellator | undefined): string {
  const brep = scene.parts.filter((p) => p.kind === 'brep').length;
  let placed = 0, triangles = 0;
  const walk = (n: ExportView['roots'][number]) => {
    for (const p of n.parts) { placed++; triangles += view.looks[p.look]!.indices.length / 3; }
    n.children.forEach(walk);
  };
  view.roots.forEach(walk);
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  let text = `${scene.parts.length} parts (${meshed} of ${brep} brep parts tessellated), ${placed} placed; ${triangles} triangles; `
    + `${(written / 1e6).toFixed(1)} MB written\n`;
  text += `import ${s(times.import!)}, tessellation ${s(times.tessellate!)}, export ${s(times.export!)}\n`;
  if (cached) {
    const c = cached.stats();
    text += `cache: ${c.hits} hits (${c.failureHits} failures), ${c.misses} misses${c.errors ? `, ${c.errors} errors` : ''}\n`;
  }
  const count = (sev: Diagnostic['severity']) => diagnostics.filter((d) => d.severity === sev).length;
  text += `${count('error')} errors, ${count('warning')} warnings, ${count('info')} notes\n`;
  const shown = diagnostics.filter((d) => d.severity !== 'info').slice(0, 20);
  for (const d of shown) text += `  ${d.severity}: ${d.source ? `#${d.source.id}: ` : ''}${d.message}\n`;
  if (shown.length < count('error') + count('warning')) text += '  ...\n';
  return text;
}
