// Point classification over the corpus (cad-oracle's classify, shellSide and nesting): every solid's closed shells
// oriented two independent ways and nested. By rays: shellSide on up to 3 of the shell's faces (its first, middle and
// last), each a point well inside the face moved eps (1e-3 of the shell's box) along its normal, classified by
// parity with a second ray required to agree (checkSecondRay: a disagreement is a fault in the line's search or the
// faces' classification); the shell's verdict the faces' if they agree. By the exact volume's sign: the oracle's
// degree-1 moments summed over the shell's faces (V = sum (x n_x + y n_y + z n_z) / 3), unknown where |V| is within 4
// x its error or a face's moments failed. The two compared shell by shell (agreeing, disagreeing, one unknown, by
// why), and each solid's shells nested (nesting): a root shell should face out, a void (depth 1) in. Not meshed, so
// not against orientResult's mesh volumes. PLANT=rays inverts the rays' verdict on one shell of about one part in
// 10, PLANT=volume negates its volume: each planted shell must show as a disagreement.
// Usage: node --max-old-space-size=8192 corpus_checks/classify_corpus.ts <list> [max MB]
import fs from 'node:fs';
import { type BrepData, BODY_KIND, rowCount, SHELL_KIND, SURFACE_KIND } from '../packages/cad-brep/src/index.ts';
import { init, Oracle, type OracleModule } from '../packages/cad-oracle/src/index.ts';
import { importStep } from '../packages/step-import/src/index.ts';
import { corpusFiles, plantedPart, shortName } from './corpus.ts';
import { addInto, runFiles, type FileCheck } from './runner.ts';
import { hostLine } from '../scripts/host.ts';

let maxMB = 1000, module: OracleModule;
const plant = process.env.PLANT;
if (plant && !['rays', 'volume'].includes(plant)) throw new Error(`PLANT=${plant}: rays, volume`);
const SKIND = Object.fromEntries(Object.entries(SURFACE_KIND).map(([k, v]) => [v, k])) as Record<number, string>;

/** Counts by key, and up to 5 examples each (EXAMPLES=n: n, to look into a run). */
const examples = Number(process.env.EXAMPLES ?? 5);
type Tally = Record<string, { n: number; ex: string[] }>;
const tally = (t: Tally, key: string, ex?: string) => {
  const e = t[key] ??= { n: 0, ex: [] };
  e.n++;
  if (ex && e.ex.length < examples) e.ex.push(ex);
};
const fresh = () => ({
  files: 0, parts: 0, solids: 0, shells: 0, faces: 0, ms: 0, planted: 0, caught: [] as string[],
  plantedAt: [] as string[], rays: {} as Tally, faceSides: {} as Tally, unknown: {} as Tally, volume: {} as Tally,
  pair: {} as Tally, nesting: {} as Tally, slow: [] as string[],
});
type Result = ReturnType<typeof fresh>;

/** A shell's faces (rows) and a box holding their vertices. */
function shellFaces(d: BrepData, s: number): number[] {
  const first = d.shell.first[s]!, count = d.shell.count[s]!;
  return Array.from(d.faceUse.face.subarray(first, first + count));
}
function verticesBox(d: BrepData, faces: number[]): number {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const f of faces)
    for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++)
      for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
        const e = d.coedge.edge[c]!;
        if (e < 0) continue;
        for (const v of [d.edge.start[e]!, d.edge.end[e]!]) {
          if (v < 0) continue;
          const p = [d.vertex.point[3 * v]!, d.vertex.point[3 * v + 1]!, d.vertex.point[3 * v + 2]!];
          lo = lo.map((x, i) => Math.min(x, p[i]!)), hi = hi.map((x, i) => Math.max(x, p[i]!));
        }
      }
  const diag = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  return Number.isFinite(diag) && diag > 0 ? diag : 1;
}

export const check: FileCheck<undefined, Result> = {
  async setup({ args }) {
    maxMB = Number(args[1] ?? 1000);
    module = await init();
  },
  async file(file, _job, ctx) {
    const R = fresh();
    if (fs.statSync(file).size > maxMB * 1e6) return R;
    R.files++;
    const name = shortName(file);
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(file)));
    for (const part of scene.parts) {
      const d = part.brep?.model;
      if (!d) continue;
      R.parts++;
      const where = `${name} #${part.sources[0]!.id}`;
      ctx.progress(where);
      const t0 = performance.now();
      using o = new Oracle(module, d.buffer, { checkSecondRay: true });
      const pick = !!plant && plantedPart(where);
      let plantedShell = -1;
      for (let b = 0; b < rowCount(d, 'body'); b++) {
        if (d.body.kind[b] !== BODY_KIND.solid) continue;
        R.solids++;
        const members = Array.from(d.member.ref.subarray(d.body.first[b]!, d.body.first[b]! + d.body.count[b]!));
        const nest = members.length > 1 ? o.nesting(b) : members.map(() => -1);
        members.forEach((s, k) => {
          if (d.shell.kind[s] !== SHELL_KIND.closed) return;
          R.shells++;
          const faces = shellFaces(d, s);
          const at = `${where} shell ${k} of body ${b} (${faces.length} faces)`;
          // Depth: a root 0, a void 1, a lump in a void 2; unknown -1.
          let depth = 0;
          for (let p = nest[k]!; p >= 0 && depth < 8; p = nest[p]!) depth++;
          if (nest[k] === -2) depth = -1;
          // By rays: up to 3 faces.
          const eps = 1e-3 * verticesBox(d, faces);
          const picks = [...new Set([0, faces.length >> 1, faces.length - 1])].map((i) => faces[i]!);
          const answers: string[] = [];
          for (const f of picks) {
            R.faces++;
            const r = o.shellSide(s, f, eps);
            answers.push(r.side);
            tally(R.faceSides, `${r.side} (${SKIND[d.surface.kind[d.face.surface[f]!]!] ?? '?'})`);
            if (r.side === 'unknown') {
              tally(R.unknown, r.why || r.classified.why || '(no reason)', `${at} face #${d.face.id[f]}`);
            }
          }
          const known = answers.filter((a) => a !== 'unknown');
          let rays = known.length === 0 ? 'unknown' : known.every((a) => a === known[0]) ? known[0]! : 'mixed';
          // By the volume's sign.
          let V = 0, err = 0, volumeOk = true;
          for (const f of faces) {
            const m = o.faceMoments(f, { degree: 1 });
            for (const mm of m.slice(1)) {
              const j = mm.exponent.indexOf(1), e = mm.n[j]!;
              if (e.status !== 'ok') volumeOk = false;
              V += e.value / 3, err += e.error / 3;
            }
          }
          const pickHere = pick && plantedShell < 0;
          if (pickHere) {
            plantedShell = s, R.planted++, R.plantedAt.push(at);
            if (plant === 'rays') rays = rays === 'outside' ? 'inside' : rays === 'inside' ? 'outside' : rays;
            else V = -V;
          }
          const volume = !volumeOk ? 'unknown (a face\'s moments failed)'
            : !(Math.abs(V) > 4 * err) ? 'unknown (|V| within 4 x its error)' : V > 0 ? 'outside' : 'inside';
          tally(R.rays, `${rays}, depth ${depth}`, at);
          tally(R.volume, `${volume}, depth ${depth}`, at);
          const vKnown = !volume.startsWith('unknown'), rKnown = rays === 'outside' || rays === 'inside';
          const pair = !(vKnown && rKnown) ? `one unknown: rays ${rays}, volume ${volume}`
            : volume === rays ? `agree: ${rays}` : `disagree: rays ${rays}, volume ${volume}`;
          tally(R.pair, `${pair}, depth ${depth}`, `${at}: V ${V.toPrecision(6)} +- ${err.toPrecision(2)}`);
          if (pickHere && pair.startsWith('disagree')) R.caught.push(at);
          // A root should face out, a void in.
          if (depth >= 0 && rKnown) {
            const expected = depth % 2 === 0 ? 'outside' : 'inside';
            const facing = rays === 'outside' ? 'out' : 'in', want = expected === 'outside' ? 'out' : 'in';
            const how = rays === expected ? 'as expected' : `facing ${facing} (want ${want})`;
            tally(R.nesting, `depth ${depth}: ${how}`, at);
          }
        });
      }
      const ms = performance.now() - t0;
      R.ms += ms;
      if (ms > 20000) R.slow.push(`${where}: ${(ms / 1000).toFixed(1)} s`);
    }
    return R;
  },
};

function printTally(title: string, t: Tally) {
  console.log(`\n## ${title}`);
  for (const [k, v] of Object.entries(t).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${v.n}  ${k}`);
    for (const e of v.ex) console.log(`      ${e}`);
  }
}

if (import.meta.main) {
  console.log(await hostLine());
  const started = Date.now();
  maxMB = Number(process.argv[3] ?? 1000);
  const all = fresh();
  await runFiles(import.meta.url, check, corpusFiles(process.argv[2]).map((f) => ({ path: f, job: undefined })),
    process.argv.slice(2), (f, out) => {
      if ('error' in out) process.stderr.write(`${shortName(f)}: failed: ${out.error}\n`);
      else addInto(all, out.result);
    });
  console.log(`${all.files} files, ${all.parts} B-rep parts, ${all.solids} solids, ${all.shells} closed shells, `
    + `${all.faces} faces asked; ${(all.ms / 1000).toFixed(0)} s in the parts, ${((Date.now() - started) / 1000)
      .toFixed(0)} s in all`);
  if (plant) {
    const caught = new Set(all.caught);
    console.log(`PLANT=${plant}: ${all.planted} shells planted, ${caught.size} seen`);
    for (const w of all.plantedAt) if (!caught.has(w)) console.log(`  not seen: ${w}`);
  }
  printTally('Rays and volume, shell by shell, by depth', all.pair);
  printTally('Shells by the rays\' verdict and depth', all.rays);
  printTally('Shells by the volume\'s sign and depth', all.volume);
  printTally('Shells facing as their depth wants (a root out, a void in), by the rays', all.nesting);
  printTally('Faces asked, by side and surface', all.faceSides);
  printTally('Faces unknown, by why', all.unknown);
  if (all.slow.length) console.log(`\n## Parts over 20 s\n${all.slow.map((s) => `  ${s}`).join('\n')}`);
}
