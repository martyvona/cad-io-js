// Export... (the user, 2026-10-31): a modal with the format and its options, stepconv's (export-model.ts), shown for
// the format chosen, and whether to apply the viewer's hiding and opacity (export-shown.ts); the choices remembered in
// this browser (`cad-viewer.export`) for next time.

import { showDialog } from './dialog.ts';
import { DEFAULT_EXPORT, EXPORT_FORMATS, type ExportFormat, type ExportRequest } from './export-formats.ts';

/** The dialog's choices: the request's options, and the viewer's hiding and opacity applied or not. */
export type ExportChoice = Omit<ExportRequest, 'name' | 'bin' | 'shown'> & { shown: boolean };

const STORE = 'cad-viewer.export';

/** The last choices made (stepconv's defaults the first time, or whatever can't be read). */
export function rememberedExport(): ExportChoice {
  const base: ExportChoice = { ...DEFAULT_EXPORT, shown: false };
  try {
    const kept = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<ExportChoice>;
    for (const k of Object.keys(base) as (keyof ExportChoice)[]) {
      if (typeof kept[k] === typeof base[k]) (base as Record<string, unknown>)[k] = kept[k];
    }
    if (!(base.format in EXPORT_FORMATS)) base.format = DEFAULT_EXPORT.format;
    if (!['draco', 'meshopt', 'none'].includes(base.compression)) base.compression = DEFAULT_EXPORT.compression;
  } catch {
    // (Storage unavailable or unreadable: the defaults.)
  }
  return base;
}

/** The options the dialog shows, each with the formats it applies to (`lines`: those with lines; gltf; 3mf). */
const BOXES: [keyof ExportChoice, string, 'all' | 'lines' | 'gltf' | 'gltfFile' | 'threemf'][] = [
  ['edges', 'B-rep edges', 'lines'],
  ['curves', 'Curves and points', 'lines'],
  ['doubleSided', 'Double-sided faces', 'lines'],
  ['unlitLines', 'Unlit lines', 'gltf'],
  ['instancing', 'GPU instancing (EXT_mesh_gpu_instancing)', 'gltf'],
  ['embed', 'Embed the buffer (else a .bin saved beside it)', 'gltfFile'],
  ['colorgroup', 'Colours as colorgroup (else basematerials)', 'threemf'],
  ['assembly', 'The assembly as components (else an item per placed part)', 'threemf'],
  ['surfaces', 'Open meshes as surfaces (else left out)', 'threemf'],
  ['keepHidden', 'Keep hidden instances (written hidden)', 'all'],
  ['keepEmpty', 'Keep empty nodes', 'lines'],
  ['extras', "Our extras (cad-io-js's metadata)", 'all'],
  ['shown', "Apply the viewer's hiding and opacity", 'all'],
];

/** Asks for a format and its options, starting from `start`; undefined if cancelled. */
export async function askExport(start: ExportChoice): Promise<ExportChoice | undefined> {
  const c: ExportChoice = { ...start };
  const box = document.createElement('div');
  const format = document.createElement('select');
  for (const [k, f] of Object.entries(EXPORT_FORMATS)) format.add(new Option(f.label, k));
  format.value = c.format;
  const fl = document.createElement('label');
  fl.textContent = 'Format';
  fl.append(format);
  box.append(fl);
  const rows: { row: HTMLElement; when: (typeof BOXES)[number][2] }[] = [];
  for (const [key, text, when] of BOXES) {
    const row = document.createElement('label');
    row.className = 'check';
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!c[key] });
    input.dataset.key = key;
    input.addEventListener('change', () => { (c as Record<string, unknown>)[key] = input.checked; });
    row.append(input, text);
    box.append(row);
    rows.push({ row, when });
  }
  // glTF's compression and Draco's bits.
  const comp = document.createElement('label');
  comp.textContent = 'Compression';
  const compression = document.createElement('select');
  for (const [v, t] of [['draco', 'Draco (KHR_draco_mesh_compression)'], ['meshopt', 'meshopt (EXT_meshopt_compression)'],
    ['none', 'None']]) compression.add(new Option(t, v));
  compression.value = c.compression;
  comp.append(compression);
  const bitsRow = document.createElement('label');
  bitsRow.textContent = "Draco's position bits (1 to 30)";
  const bits = Object.assign(document.createElement('input'), { type: 'number', min: '1', max: '30', step: '1',
    value: String(c.dracoBits) });
  bitsRow.append(bits);
  box.append(comp, bitsRow);
  const show = () => {
    const f = EXPORT_FORMATS[c.format];
    for (const { row, when } of rows) row.hidden = !(when === 'all' || (when === 'lines' && f.lines) ||
      (when === 'gltf' && f.gltf) || (when === 'gltfFile' && c.format === 'gltf') || (when === 'threemf' && f.threemf));
    comp.hidden = !f.gltf;
    bitsRow.hidden = !f.gltf || c.compression !== 'draco';
  };
  format.addEventListener('change', () => {
    c.format = format.value as ExportFormat;
    show();
  });
  compression.addEventListener('change', () => {
    c.compression = compression.value as ExportChoice['compression'];
    show();
  });
  bits.addEventListener('change', () => {
    const v = Math.round(Number(bits.value));
    c.dracoBits = Number.isFinite(v) ? Math.min(30, Math.max(1, v)) : DEFAULT_EXPORT.dracoBits;
    bits.value = String(c.dracoBits);
  });
  show();
  const r = await showDialog({ title: 'Export', body: [], content: box,
    buttons: [{ label: 'Export...', value: 'export', primary: true }, { label: 'Cancel', value: 'cancel' }] });
  if (r.button !== 'export') return undefined;
  try {
    localStorage.setItem(STORE, JSON.stringify(c));
  } catch {
    // (Not remembered.)
  }
  return c;
}
