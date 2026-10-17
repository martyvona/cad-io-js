// step2json: STEP (Part 21, or gzipped .stpZ) to JSON. See docs/architecture.md, "`step2json` output".
//
//   raw mode (default): the lossless raw JSON of every instance (step-parser's json.ts), or NDJSON with --ndjson;
//     streamed, so output size isn't limited by memory or string length. --names annotates attribute names.
//   semantic mode: the product structure, units, styles, validation properties and diagnostics (Layer 3), as
//     standard JSON.

import fs from 'node:fs';
import { Readable, type Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import {
  extractSemantics, fileDocument, jsonChunks, jsonLinesChunks, openModel, ParseError, readStep, semanticJson,
  type Diagnostic, type StepFile,
} from 'step-parser';

export interface Io {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable;
}

const USAGE = `Usage: step2json [options] <file.stp | file.stpZ | ->

Converts a STEP file to JSON. '-' reads standard input.

Options:
  -o, --output <file>    write here instead of standard output
  -m, --mode <mode>      raw (default): every instance, losslessly
                         semantic: product structure, units, styles, validation properties
      --ndjson           raw mode: one JSON value per line
      --names            raw mode: annotate each record with its attribute names
      --instances        semantic mode: list every product instance with its transform
      --check            semantic mode: check every instance against the schema; adds diagnostics
      --pretty           semantic mode: indent the output
  -q, --quiet            no summary on standard error
  -h, --help             show this help
`;

/** Run step2json with these arguments; returns the exit code (0 success, 1 usage error, 2 failure). */
export async function step2json(argv: string[], io: Io): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        output: { type: 'string', short: 'o' },
        mode: { type: 'string', short: 'm', default: 'raw' },
        ndjson: { type: 'boolean', default: false },
        names: { type: 'boolean', default: false },
        instances: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        pretty: { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    io.stderr.write(`step2json: ${(e as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const o = args.values;
  if (o.help) { io.stdout.write(USAGE); return 0; }
  const usage = (msg: string) => { io.stderr.write(`step2json: ${msg}\n\n${USAGE}`); return 1; };
  if (args.positionals.length !== 1) return usage('expected one input file');
  if (o.mode !== 'raw' && o.mode !== 'semantic') return usage(`unknown mode '${o.mode}'`);
  if (o.mode === 'raw' && (o.instances || o.check || o.pretty)) return usage('--instances, --check and --pretty are for semantic mode');
  if (o.mode === 'semantic' && (o.ndjson || o.names)) return usage('--ndjson and --names are for raw mode');

  const input = args.positionals[0]!;
  let file: StepFile;
  try {
    file = await readStep(input === '-' ? (Readable.toWeb(io.stdin) as ReadableStream<Uint8Array>) : fs.readFileSync(input));
  } catch (e) {
    io.stderr.write(`step2json: can't read ${input}: ${(e as Error).message}\n`);
    return 2;
  }

  const diagnostics: Diagnostic[] = [...file.diagnostics];
  const out = o.output === undefined ? io.stdout : fs.createWriteStream(o.output);
  try {
    if (o.mode === 'raw') {
      const model = o.names ? await openModel(file) : undefined;
      if (model) diagnostics.push(...model.diagnostics);
      const doc = fileDocument(file, (p: number, e: ParseError) => {
        diagnostics.push({ severity: 'error', message: `malformed instance, left out: ${e.message}`, offset: e.offset, id: file.index.ids[p] });
      });
      const opts = { names: model && ((inst: Parameters<typeof model.attributeNames>[0]) => model.attributeNames(inst)) };
      await pump(o.ndjson ? jsonLinesChunks(doc, opts) : jsonChunks(doc, opts), out);
    } else {
      const model = await openModel(file);
      diagnostics.push(...model.diagnostics);
      if (o.check) {
        for (let p = 0; p < file.count; p++) {
          try {
            diagnostics.push(...model.bind(p, { check: true, warnings: diagnostics }).diagnostics);
          } catch (e) {
            if (!(e instanceof ParseError)) throw e;
            diagnostics.push({ severity: 'error', message: `malformed instance: ${e.message}`, offset: e.offset, id: file.index.ids[p] });
          }
        }
      }
      const sem = extractSemantics(model);
      const doc = semanticJson(model, sem, { instances: o.instances, diagnostics });
      diagnostics.push(...sem.diagnostics);
      await pump([new TextEncoder().encode(JSON.stringify(doc, null, o.pretty ? 2 : undefined) + '\n')], out);
    }
  } catch (e) {
    io.stderr.write(`step2json: ${(e as Error).message}\n`);
    return 2;
  } finally {
    if (out !== io.stdout) await new Promise((resolve) => (out as fs.WriteStream).end(resolve));
  }

  if (!o.quiet) io.stderr.write(summary(file, diagnostics));
  return 0;
}

/** Write chunks with backpressure. */
async function pump(chunks: Iterable<Uint8Array>, out: Writable): Promise<void> {
  for (const c of chunks) {
    if (!out.write(c)) await new Promise((resolve) => out.once('drain', resolve));
  }
}

function summary(file: StepFile, diagnostics: readonly Diagnostic[]): string {
  const count = (s: Diagnostic['severity']) => diagnostics.filter((d) => d.severity === s).length;
  let text = `${file.count} instances; ${count('error')} errors, ${count('warning')} warnings, ${count('info')} notes\n`;
  const shown = diagnostics.filter((d) => d.severity !== 'info').slice(0, 20);
  for (const d of shown) text += `  ${d.severity}: ${d.id !== undefined ? `#${d.id}: ` : ''}${d.message}\n`;
  if (shown.length < count('error') + count('warning')) text += `  ...\n`;
  return text;
}
