// Reading input: bytes, Blobs or streams, with gzip (.stpZ) detected by its magic number.

import { parseStep, type StepFile } from './file.ts';

export type StepSource = Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

/** Collect a source into bytes, decompressing gzip input. */
export async function readBytes(source: StepSource): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (source instanceof Uint8Array) bytes = source;
  else if (source instanceof ArrayBuffer) bytes = new Uint8Array(source);
  else if (typeof Blob !== 'undefined' && source instanceof Blob) bytes = new Uint8Array(await source.arrayBuffer());
  else bytes = await collect(source as ReadableStream<Uint8Array>);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = await collect(stream);
  }
  return bytes;
}

/** Read and parse a Part 21 file (plain or gzip-compressed). */
export async function readStep(source: StepSource): Promise<StepFile> {
  return parseStep(await readBytes(source));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
