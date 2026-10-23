// Throwaway (phase 1, step 1): check step-schemas dictionary layouts against real Part 21 files, with a crude
// tokenizer. Usage: node corpus_checks/schema_corpus_check.ts [file-list.txt]. Replace with the real parser once it
// exists.
import fs from 'node:fs';
import { Schema, dictionaryForFileSchema, type SchemaDictionary } from '../packages/step-schemas/src/index.ts';
import { corpusDir, corpusFiles, repoDir } from './corpus.ts';

const schemas: Record<string, Schema> = {};
for (const id of ['ap203', 'ap203e2', 'ap214e3', 'ap242'])
  schemas[id] = new Schema(JSON.parse(
    fs.readFileSync(`${repoDir}/packages/step-schemas/dict/${id}.json`, 'utf8')) as SchemaDictionary);

type V = string | V[]; // atoms as raw text
function parseArgs(s: string, i: number): [V[], number] { // s[i] === '('
  const out: V[] = []; i++;
  let cur = '';
  const flush = () => { const t = cur.trim(); if (t !== '') out.push(t); cur = ''; };
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") { let j = i + 1;
      for (;;) { if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } break; } j++; } cur += s.slice(i,
      j + 1); i = j + 1; continue; }
    if (c === '(') { const prefix = cur.trim(); const [sub, j] = parseArgs(s, i);
      out.push(prefix ? [prefix, sub] as any : sub); cur = ''; i = j; while (s[i] === ' ') i++;
      if (s[i] === ',') i++; continue; }
    if (c === ')') { flush(); return [out, i + 1]; }
    if (c === ',') { flush(); i++; continue; }
    cur += c; i++;
  }
  throw new Error('eof');
}

const stats: Record<string, any> = {};
const problems = new Map<string, { n: number; ex: string }>();
const note = (k: string, ex: string) => { const p = problems.get(k); if (p) p.n++;
  else problems.set(k, { n: 1, ex }); };

const files = corpusFiles(process.argv[2]);
for (const f of files) { try { checkFile(f); } catch (e) { note('PARSE FAILURE ' + (e as Error).message, f); } }
function checkFile(f: string) {
  let s = fs.readFileSync(f).toString('latin1');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const hdr = /FILE_SCHEMA\s*\(\s*\(([^;]*?)\)\s*\)\s*;/.exec(s);
  const names = hdr ? [...hdr[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!) : [];
  const id = dictionaryForFileSchema(names);
  const st = (stats[id ?? `none:${names.join('+')}`] ??= { files: 0, simple: 0, complex: 0, ok: 0, bad: 0 });
  st.files++;
  if (!id) return;
  const sch = schemas[id]!;
  const data = s.indexOf('DATA;');
  const re = /#(\d+)\s*=\s*/g; re.lastIndex = data;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    let i = re.lastIndex;
    const parts: [string, V[]][] = [];
    if (s[i] === '(') { // complex
      i++;
      for (;;) {
        while (/\s/.test(s[i]!)) i++;
        if (s[i] === ')') { i++; break; }
        const nm = /[A-Za-z0-9_]+/y; nm.lastIndex = i; const mm = nm.exec(s)!; i = nm.lastIndex;
        while (/\s/.test(s[i]!)) i++;
        const [args, j] = parseArgs(s, i); i = j; parts.push([mm[0].toUpperCase(), args]);
      }
      st.complex++;
    } else {
      const nm = /[A-Za-z0-9_]+/y; nm.lastIndex = i; const mm = nm.exec(s); if (!mm) continue; i = nm.lastIndex;
      while (/\s/.test(s[i]!)) i++;
      const [args, j] = parseArgs(s, i); i = j; parts.push([mm[0].toUpperCase(), args]);
      st.simple++;
    }
    re.lastIndex = i;
    const members = parts.map((p) => p[0]);
    let good = true;
    for (const [t, args] of parts) {
      if (!sch.entity(t)) { note(`${id} unknown entity ${t}`, f); good = false; continue; }
      if (parts.length > 1 && members.some((x) => !sch.entity(x))) { good = false; continue; }
      const slots = parts.length === 1 ? sch.instanceAttributes(t) : sch.partialAttributes(t, members);
      if (slots.length !== args.length) {
        note(`${id} ${parts.length > 1 ? 'partial ' : ''}${t}: expected ${slots.length} attrs, got ${args.length}`,
        `${f} #${m[1]}`); good = false; continue; }
      slots.forEach((sl, k) => {
        const v = args[k];
        if (sl.derived && v !== '*') { note(`${id} ${t}.${sl.name} derived but not *`, `${f} #${m![1]}`);
          good = false; }
        if (!sl.derived && v === '*') { note(`${id} ${t}.${sl.name} is * but not derived`, `${f} #${m![1]}`);
          good = false; }
        if (!sl.optional && !sl.derived && v === '$') note(`(info) ${id} ${t}.${sl.name} $ in mandatory slot`,
          `${f} #${m![1]}`);
      });
    }
    if (parts.length > 1) {
      const sorted = [...members].sort();
      if (sorted.join() !== members.join()) note(`(info) ${id} complex instance not in alphabetical order`,
        `${f} #${m[1]}`);
    }
    good ? st.ok++ : st.bad++;
  }
}
console.table(stats);
for (const [k, v] of [...problems].sort((a, b) => b[1].n - a[1].n)) console.log(String(v.n).padStart(7), k, ' e.g.',
  v.ex.replace(corpusDir + '/', ''));
