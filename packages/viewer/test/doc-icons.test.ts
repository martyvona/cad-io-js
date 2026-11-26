// The tree's surface and curve icons as SVG files for docs/brep-reference.md (docs/icons/), made from
// tree-panel.ts's: a file differing from the icon, missing, or not an icon's fails. `UPDATE_DOC_ICONS=1` writes
// them. In a fixed colour, legible on light and dark pages (an image has no text colour to follow).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { GEOMETRY_ICONS, ICONS } from '../src/tree-panel.ts';

const DIR = new URL('../../../docs/icons/', import.meta.url);
const COLOUR = '#5b85b0';

/** An icon as a file: a standalone SVG, 16 pixels, in COLOUR. */
function iconFile(svg: string): string {
  return svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ').replace('width="14" height="14"',
    'width="16" height="16"').replace(' aria-hidden="true"', '').replaceAll('currentColor', COLOUR) + '\n';
}

function files(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [kind, svg] of Object.entries(GEOMETRY_ICONS)) {
    out.set(`${kind.startsWith('curve:') ? kind.replace(':', '-') : `surface-${kind}`}.svg`, iconFile(svg!));
  }
  // (The swept surfaces' icon: a face's.)
  out.set('node-face.svg', iconFile(ICONS.face));
  return out;
}

test('docs/icons: the tree icons as files, current', () => {
  const want = files();
  if (process.env.UPDATE_DOC_ICONS) for (const [name, text] of want) writeFileSync(new URL(name, DIR), text);
  const have = readdirSync(DIR).filter((f) => f.endsWith('.svg')).sort();
  assert.deepEqual(have, [...want.keys()].sort(), 'docs/icons: files without an icon, or icons without a file');
  for (const [name, text] of want) {
    assert.equal(readFileSync(new URL(name, DIR), 'utf8'), text, `docs/icons/${name}: run with UPDATE_DOC_ICONS=1`);
  }
});
