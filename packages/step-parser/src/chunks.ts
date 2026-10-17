// Output buffering shared by the Part 21 and JSON writers: text and bytes are appended to fixed-size chunks, and a
// chunk is yielded when the next piece doesn't fit. A piece larger than a chunk is yielded on its own.

const encoder = new TextEncoder();

export class Chunker {
  private readonly size: number;
  private buf: Uint8Array;
  private pos = 0;

  constructor(size = 65536) {
    this.size = size;
    this.buf = new Uint8Array(size);
  }

  /** Append text as UTF-8. */
  *text(s: string): Generator<Uint8Array> {
    const r = encoder.encodeInto(s, this.buf.subarray(this.pos));
    if (r.read === s.length) { this.pos += r.written; return; }
    if (this.pos > 0) {
      yield* this.flush();
      const r = encoder.encodeInto(s, this.buf);
      if (r.read === s.length) { this.pos = r.written; return; }
    }
    yield encoder.encode(s);
  }

  /** Append bytes. The caller must not change them afterwards: a large piece is yielded as is. */
  *bytes(b: Uint8Array): Generator<Uint8Array> {
    if (b.length > this.size - this.pos) {
      yield* this.flush();
      if (b.length > this.size) { yield b; return; }
    }
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  /** Yield the current chunk, if it isn't empty, and start a new one. */
  *flush(): Generator<Uint8Array> {
    if (this.pos === 0) return;
    yield this.buf.subarray(0, this.pos);
    this.buf = new Uint8Array(this.size);
    this.pos = 0;
  }
}

/** Concatenate chunks into one array. */
export function concatChunks(chunks: Iterable<Uint8Array>): Uint8Array {
  const all = [...chunks];
  if (all.length === 1) return all[0]!;
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of all) { out.set(c, o); o += c.length; }
  return out;
}
