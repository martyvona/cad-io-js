// The model's file-level metadata (Scene.properties: a STEP file's header, a glTF file's asset, three.js's metadata,
// 3MF's; for our files with extras, the source's, ours as `container`: cad-scene's file-metadata.ts), shown over About
// as rows, read-only: its text can be selected and copied, nothing changed.

import { describeTransforms, type Properties, type PropertyValue, type TransformUse } from 'cad-scene';
import { showDialog } from './dialog.ts';

/** A key as a label: `originatingSystem` as Originating system; a name with capitals or other marks as it is. */
export function label(key: string): string {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) return key;
  const words = key.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words[0]!.toUpperCase() + words.slice(1);
}

/** A value as text: a list a line each; blank text, and lists of nothing else, as nothing. */
function text(v: PropertyValue): string | undefined {
  if (v === null) return undefined;
  if (Array.isArray(v)) {
    const lines = v.flatMap((x) => {
      const t = x !== null && typeof x === 'object' ? JSON.stringify(x) : text(x);
      return t === undefined ? [] : [t];
    });
    return lines.length ? lines.join('\n') : undefined;
  }
  if (typeof v === 'string') return v.trim() === '' ? undefined : v;
  return String(v);
}

/** The rows to show: each value with its label, an object's within it (`Container / Format`), blanks left out. */
export function propertyRows(p: Properties, prefix = ''): [string, string][] {
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(p)) {
    const name = prefix + label(k);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) rows.push(...propertyRows(v, `${name} / `));
    else {
      const t = text(v);
      if (t !== undefined) rows.push([name, t]);
    }
  }
  return rows;
}

/** What the transforms do, if anything: the tree's own, and the placed parts' where composition makes them differ. */
export function transformRows(t: TransformUse): [string, string][] {
  const own = describeTransforms(t.own), placed = describeTransforms(t.placed);
  return [...own ? [['Transforms', own] as [string, string]] : [],
    ...placed && placed !== own ? [['Placed parts', placed] as [string, string]] : []];
}

/**
 * Shows the model's metadata, over whatever is open, and with `transforms` what they do beyond turning, moving and
 * scaling evenly (its own, and its placed parts', which composition can shear); saying when there's nothing but its
 * format (which every importer records). Resolves when it's closed.
 */
export async function showFileDetails(p: Properties, transforms?: TransformUse): Promise<void> {
  const rows = [...propertyRows(p), ...transforms ? transformRows(transforms) : []];
  const more = rows.some(([l]) => l !== 'Format');
  await showDialog({ title: 'Model Details', body: [...(rows.length ? [rows] : []),
    ...(more ? [] : ['No additional details available.'])], buttons: [], closeButton: true });
}
