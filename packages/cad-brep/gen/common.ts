// What gen/header.ts and gen/rust.ts share: names, comment wrapping, and the two languages' text for a column layout
// (the columns, the reader that checks a buffer's header), so the model's and the analysis's headers read alike.

import type { ColumnOf } from '../src/columns.ts';

export const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2');

/** Text word-wrapped to lines of at most 120 characters, each starting with `lead`. */
export function wrap(text: string, lead: string): string[] {
  const lines: string[] = [];
  let line = lead;
  for (const w of text.split(/\s+/)) {
    if (line.length + 1 + w.length > 120 && line.trim() !== lead.trim()) {
      lines.push(line);
      line = lead;
    }
    line += (line === lead ? '' : ' ') + w;
  }
  lines.push(line);
  return lines;
}

/** A layout's text for a generator: its magic, its columns in buffer order and its header's size. */
export interface Format {
  magic: string;
  columns: readonly ColumnOf<string>[];
  headerBytes: number;
}

const C_TYPES = { u8: 'uint8_t', i32: 'int32_t', u32: 'uint32_t', f64: 'double' } as const;

export function cEnum(name: string, prefix: string, table: Record<string, number>): string[] {
  return [`enum ${name} {`, ...Object.entries(table).map(([k, v]) => `  ${prefix}_${snake(k).toUpperCase()} = ${v},`),
    '};', ''];
}

export const named = (names: readonly string[]) => Object.fromEntries(names.map((n, k) => [n, k]));

/**
 * A C header: `intro` (its leading comment), the guard, the magic and header size, the column enum, `body` (enums,
 * notes), the view type, `<p>_open` and the typed accessors, every name prefixed by `p` (CBR_, cbr_ for `cbr`).
 */
export function cHeader(p: string, guard: string, f: Format, intro: string[], body: string[]): string {
  const P = p.toUpperCase();
  const out = [
    ...intro,
    `#ifndef ${guard}`,
    `#define ${guard}`,
    '',
    '#include <stddef.h>',
    '#include <stdint.h>',
    '#include <string.h>',
    '',
    `#define ${P}_MAGIC "${f.magic}"`,
    `#define ${P}_HEADER_BYTES ${f.headerBytes}`,
    '',
    '/* The columns in buffer order: table, column, element type and values per row. */',
    `enum ${p}_column {`,
    ...f.columns.map((c) => `  ${P}_${snake(c.table).toUpperCase()}_${snake(c.column).toUpperCase()}, `
      + `/* ${C_TYPES[c.type]} x ${c.width} */`),
    `  ${P}_COLUMN_COUNT`,
    '};',
    '',
    ...body,
    '/* One column: its values and their count (rows times its width). */',
    'typedef struct {',
    '  const void* data;',
    '  uint32_t count;',
    `} ${p}_view;`,
    '',
    `/* The columns of a buffer of \`size\` bytes into \`views\` (${P}_COLUMN_COUNT of them): 0, or -1 if it `
      + 'isn\'t one. */',
    `static inline int ${p}_open(const uint8_t* buf, size_t size, ${p}_view* views) {`,
    `  static const uint8_t bytes[${P}_COLUMN_COUNT] = {`,
    ...wrap(f.columns.map((c) => `${({ u8: 1, i32: 4, u32: 4, f64: 8 })[c.type]},`).join(' '), '    '),
    '  };',
    '  uint32_t n, k;',
    `  if (((uintptr_t)buf & 7) != 0 || size < ${P}_HEADER_BYTES || memcmp(buf, ${P}_MAGIC, 4) != 0) return -1;`,
    '  memcpy(&n, buf + 4, 4);',
    `  if (n != ${P}_COLUMN_COUNT) return -1;`,
    '  for (k = 0; k < n; k++) {',
    '    uint32_t offset, count;',
    '    memcpy(&offset, buf + 8 + 8 * k, 4);',
    '    memcpy(&count, buf + 12 + 8 * k, 4);',
    `    if ((offset & 7) != 0 || offset < ${P}_HEADER_BYTES || offset > size`,
    '      || (uint64_t)count * bytes[k] > size - offset) return -1;',
    '    views[k].data = buf + offset;',
    '    views[k].count = count;',
    '  }',
    '  return 0;',
    '}',
    '',
    `#define ${P}_U8(v) ((const uint8_t*)(v).data)`,
    `#define ${P}_I32(v) ((const int32_t*)(v).data)`,
    `#define ${P}_U32(v) ((const uint32_t*)(v).data)`,
    `#define ${P}_F64(v) ((const double*)(v).data)`,
    '',
    '#endif',
    '',
  ];
  return out.join('\n');
}

const RUST_TYPES = { u8: 'u8', i32: 'i32', u32: 'u32', f64: 'f64' } as const;
const LETTERS = { u8: 'b', i32: 'i', u32: 'u', f64: 'f' } as const;

/** A Rust module of constants, `type` their type. */
export function rustConsts(name: string, type: string, table: Record<string, number>, doc: string): string[] {
  return [`/// ${doc}`, `pub mod ${name} {`,
    ...Object.entries(table).map(([k, v]) => `    pub const ${snake(k).toUpperCase()}: ${type} = ${v};`), '}', ''];
}

/**
 * A Rust module: `intro` (its `//!` lines), the magic, header size and column types, `body` (constant modules), then
 * `struct S` with `S::open` (`what` names the buffer in its error), `values` and an accessor per column.
 */
export function rustModule(S: string, what: string, f: Format, intro: string[], body: string[]): string {
  const out = [
    ...intro,
    '',
    '#![allow(dead_code)]',
    '',
    '#[cfg(not(target_endian = "little"))]',
    'compile_error!("cad-brep buffers are little-endian");',
    '',
    `pub const MAGIC: &[u8; 4] = b"${f.magic}";`,
    `pub const HEADER_BYTES: usize = ${f.headerBytes};`,
    `pub const COLUMN_COUNT: usize = ${f.columns.length};`,
    '',
    '/// Each column\'s element type, in buffer order: b u8, i i32, u u32, f f64.',
    `const TYPES: &[u8; COLUMN_COUNT] = b"${f.columns.map((c) => LETTERS[c.type]).join('')}";`,
    '',
    'const fn bytes(k: usize) -> usize {',
    '    match TYPES[k] {',
    '        b\'b\' => 1,',
    '        b\'f\' => 8,',
    '        _ => 4,',
    '    }',
    '}',
    '',
    ...body,
    '/// A buffer\'s columns: a copy of it in 8-byte words, and each column\'s byte offset and element count.',
    `pub struct ${S} {`,
    '    words: Vec<u64>,',
    '    columns: [(usize, usize); COLUMN_COUNT],',
    '}',
    '',
    `impl ${S} {`,
    '    /// The columns of a buffer, or why it isn\'t one (the magic, the column count, a column that doesn\'t fit).',
    `    pub fn open(buf: &[u8]) -> Result<${S}, String> {`,
    '        let u32_at = |k: usize| u32::from_le_bytes([buf[k], buf[k + 1], buf[k + 2], buf[k + 3]]) as usize;',
    '        if buf.len() < HEADER_BYTES || &buf[0..4] != MAGIC {',
    `            return Err(format!("not a ${what} of this format ({})", String::from_utf8_lossy(MAGIC)));`,
    '        }',
    '        if u32_at(4) != COLUMN_COUNT {',
    '            return Err(format!("{} columns, not {COLUMN_COUNT}", u32_at(4)));',
    '        }',
    '        let mut columns = [(0, 0); COLUMN_COUNT];',
    '        for (k, c) in columns.iter_mut().enumerate() {',
    '            let (offset, count) = (u32_at(8 + 8 * k), u32_at(12 + 8 * k));',
    '            if offset % 8 != 0 || offset < HEADER_BYTES || offset > buf.len()',
    '                || count.checked_mul(bytes(k)).map_or(true, |n| n > buf.len() - offset)',
    '            {',
    '                return Err(format!("column {k}: {count} values at byte {offset} don\'t fit"));',
    '            }',
    '            *c = (offset, count);',
    '        }',
    '        let mut words = vec![0u64; buf.len().div_ceil(8)];',
    '        for (w, chunk) in words.iter_mut().zip(buf.chunks(8)) {',
    '            let mut b = [0u8; 8];',
    '            b[..chunk.len()].copy_from_slice(chunk);',
    '            *w = u64::from_le_bytes(b);',
    '        }',
    `        Ok(${S} { words, columns })`,
    '    }',
    '',
    '    fn slice<T>(&self, k: usize) -> &[T] {',
    '        let (offset, count) = self.columns[k];',
    '        // (Sound: the words are 8-byte aligned, every column starts on an 8-byte offset and fits, checked by',
    '        // `open`, and every bit pattern is a value of these types.)',
    '        unsafe { std::slice::from_raw_parts((self.words.as_ptr() as *const u8).add(offset) as *const T, count) }',
    '    }',
    '',
    '    /// Any column\'s values as f64 (for readers that walk every column).',
    '    pub fn values(&self, k: usize) -> Vec<f64> {',
    '        match TYPES[k] {',
    '            b\'b\' => self.slice::<u8>(k).iter().map(|&x| x as f64).collect(),',
    '            b\'i\' => self.slice::<i32>(k).iter().map(|&x| x as f64).collect(),',
    '            b\'u\' => self.slice::<u32>(k).iter().map(|&x| x as f64).collect(),',
    '            _ => self.slice::<f64>(k).to_vec(),',
    '        }',
    '    }',
    ...f.columns.flatMap((c, k) => ['', `    /// \`${c.table}.${c.column}\`: ${c.width} per row.`,
      `    pub fn ${snake(c.table).toLowerCase()}_${snake(c.column).toLowerCase()}(&self) -> `
        + `&[${RUST_TYPES[c.type]}] { self.slice(${k}) }`]),
    '}',
    '',
  ];
  return out.join('\n');
}
