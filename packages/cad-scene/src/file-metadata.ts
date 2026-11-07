// File-level metadata (Scene.properties; docs/scene-formats.md): the author a file names, placeholders left
// out, as the importers set `author`; and the fields formats have a standard place for (3MF's metadata, glTF's
// asset.copyright), from a scene's properties whatever format they came from, which the exporters write with or
// without our extras.

import type { Properties } from './scene.ts';

/**
 * Names writers put where an author goes when there's none (seen across the corpus's STEP files), compared trimmed and
 * lowercased; anything starting with `---` (converters' stamps) too.
 */
export const AUTHOR_PLACEHOLDERS: ReadonlySet<string> = new Set(['', 'author', 'author name', 'a designer',
  'designer', 'none', 'unknown', 'unspecified', 'user', 'konstrukteur']);

const placeholder = (name: string) => {
  const n = name.trim().toLowerCase();
  return AUTHOR_PLACEHOLDERS.has(n) || n.startsWith('---');
};

/** The author named, placeholders left out, several joined by `, `; undefined if none is left. */
export function authorOf(names: readonly string[]): string | undefined {
  const real = names.filter((n) => !placeholder(n)).map((n) => n.trim());
  return real.length ? real.join(', ') : undefined;
}

/** The fields formats have a place for, by 3MF's names for them. */
export interface StandardMetadata {
  Title?: string;
  Designer?: string;
  Description?: string;
  Copyright?: string;
  LicenseTerms?: string;
  Rating?: string;
  CreationDate?: string;
}

/** The 3MF metadata names carried from a 3MF source (its others, Application and dates of change, are the writer's). */
const CARRIED = ['Title', 'Description', 'Copyright', 'LicenseTerms', 'Rating', 'CreationDate'] as const;

const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const object = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown>
  : undefined);

/**
 * A scene's standard fields: the author (`author`, any format); a 3MF source's metadata by its names; a glTF source's
 * `asset.copyright`; a STEP source's time stamp as the creation date.
 */
export function standardMetadata(p: Properties): StandardMetadata {
  const out: StandardMetadata = {};
  const author = text(p.author);
  if (author) out.Designer = author;
  const meta = object(p.metadata);
  if (p.format === '3mf' && meta) {
    for (const k of CARRIED) {
      const v = text(meta[k]);
      if (v) out[k] = v;
    }
  }
  const copyright = text(object(p.asset)?.copyright);
  if (copyright && !out.Copyright) out.Copyright = copyright;
  const stamp = text(p.timeStamp);
  if (p.format === 'step' && stamp) out.CreationDate = stamp;
  return out;
}
