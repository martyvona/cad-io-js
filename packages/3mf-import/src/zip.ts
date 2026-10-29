// A zip archive's entries, read from its central directory, each inflated in pieces on demand (fflate's streaming
// Inflate): a 3MF package's model part can be hundreds of megabytes, and is never held whole, as text or bytes (the
// user, 2026-10-29; CLAUDE.md, "Decisions": 3MF import, our own reader). Zip64 sizes and offsets are read; encrypted
// entries and compression other than stored and deflate are not.

import { Inflate } from 'fflate';

export interface ZipEntry {
  /** The name as stored (an OPC part name without its leading slash). */
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  /** Where its local header starts. */
  offset: number;
}

/** Compressed bytes are given to the inflater this many at a time. */
const PIECE = 1 << 20;

const u16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const u64 = (b: Uint8Array, i: number) => u32(b, i) + u32(b, i + 4) * 2 ** 32;

/** OPC part names compare without case, percent-decoded, without a leading slash. */
export function partKey(name: string): string {
  let s = name.replace(/^\/+/, '');
  try { s = decodeURIComponent(s); } catch { /* kept as it is */ }
  return s.toLowerCase();
}

/** The archive's entries by partKey; throws a message (for a diagnostic) if it isn't a zip we can read. */
export function readZip(bytes: Uint8Array): Map<string, ZipEntry> {
  // The end of central directory record: the last signature within its 22 bytes plus a comment of up to 65535.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end of central directory)');
  let count = u16(bytes, eocd + 10), offset = u32(bytes, eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(bytes, locator) !== 0x07064b50) throw new Error('a zip64 archive without its locator');
    const record = u64(bytes, locator + 8);
    if (u32(bytes, record) !== 0x06064b50) throw new Error('a zip64 archive without its end record');
    count = u64(bytes, record + 32);
    offset = u64(bytes, record + 48);
  }
  const entries = new Map<string, ZipEntry>();
  const names = new TextDecoder();
  let at = offset;
  for (let k = 0; k < count; k++) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) throw new Error('a broken zip central directory');
    const nameLength = u16(bytes, at + 28), extraLength = u16(bytes, at + 30), commentLength = u16(bytes, at + 32);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    let size = u32(bytes, at + 24), compressedSize = u32(bytes, at + 20), local = u32(bytes, at + 42);
    // Zip64's extra field holds, in this order, those of the three that don't fit in 32 bits.
    for (let e = at + 46 + nameLength; e + 4 <= at + 46 + nameLength + extraLength;) {
      const id = u16(bytes, e), length = u16(bytes, e + 2);
      if (id === 1) {
        let f = e + 4;
        if (size === 0xffffffff) { size = u64(bytes, f); f += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(bytes, f); f += 8; }
        if (local === 0xffffffff) local = u64(bytes, f);
      }
      e += 4 + length;
    }
    entries.set(partKey(name), { name, method: u16(bytes, at + 10), flags: u16(bytes, at + 8), compressedSize, size,
      offset: local });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** An entry's bytes, given in pieces to `each`; throws a message if it can't be read. */
export function inflateEntry(bytes: Uint8Array, e: ZipEntry, each: (piece: Uint8Array) => void): void {
  if (e.flags & 1) throw new Error(`${e.name} is encrypted`);
  if (u32(bytes, e.offset) !== 0x04034b50) throw new Error(`${e.name}: no local header where the directory says`);
  const start = e.offset + 30 + u16(bytes, e.offset + 26) + u16(bytes, e.offset + 28);
  const data = bytes.subarray(start, start + e.compressedSize);
  if (data.length < e.compressedSize) throw new Error(`${e.name} is cut short`);
  if (e.method === 0) {
    for (let i = 0; i < data.length; i += PIECE) each(data.subarray(i, i + PIECE));
    return;
  }
  if (e.method !== 8) throw new Error(`${e.name}: compression method ${e.method} isn't supported`);
  const inflate = new Inflate((piece) => each(piece));
  if (!data.length) inflate.push(data, true);
  for (let i = 0; i < data.length; i += PIECE) inflate.push(data.subarray(i, i + PIECE), i + PIECE >= data.length);
}

/** A small entry's text, whole (relationships, content types). */
export function entryText(bytes: Uint8Array, e: ZipEntry): string {
  const decoder = new TextDecoder();
  let text = '';
  inflateEntry(bytes, e, (piece) => { text += decoder.decode(piece, { stream: true }); });
  return text + decoder.decode();
}
