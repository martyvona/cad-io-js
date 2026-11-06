// Load demo model... (About): the demo models' catalog (content/demo/catalog.json, written by scripts/demo-catalog.ts
// and deployed with them) fetched each time the dialog opens, past the browser's cache (asked for, so not traffic of
// the page's own; the service worker never caches content/), and offered as a list.

import { showDialog } from './dialog.ts';
import { contentUrl } from './sources.ts';

export interface DemoModel {
  /** Relative to the demo directory, '/'-separated. */
  path: string;
  size: number;
}

/** The catalog's models (malformed entries left out); throws if it isn't a catalog at all. */
export function parseCatalog(json: unknown): DemoModel[] {
  const models = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) throw new Error('not a catalog of demo models');
  return models.filter((m): m is DemoModel => typeof m?.path === 'string' && m.path !== '' &&
    typeof m.size === 'number' && Number.isFinite(m.size) && m.size >= 0);
}

/** A size as 512B, 8.2k, 23.4M or 8.2G (powers of 1000, as macOS and most file managers count). */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${Math.round(bytes)}B`;
  const units = ['k', 'M', 'G', 'T'];
  let v = bytes / 1000, u = 0;
  // (Rounded first, so 999,960 bytes is 1.0M, not 1000.0k.)
  while (Number(v.toFixed(1)) >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v.toFixed(1)}${units[u]}`;
}

/** The catalog, fetched now; throws with what went wrong. */
async function fetchCatalog(): Promise<DemoModel[]> {
  const url = contentUrl('demo/catalog.json')!;
  let r: Response;
  try {
    r = await fetch(url, { cache: 'no-store' });
  } catch (e) {
    throw new Error(`the server can't be reached (${(e as Error).message})`);
  }
  if (!r.ok) throw new Error(`${r.status === 404 ? 'there is no catalog' : 'the server refused it'} (${r.status})`);
  let json: unknown;
  try {
    json = await r.json();
  } catch {
    throw new Error('the catalog is not JSON');
  }
  return parseCatalog(json);
}

// The model last loaded from here, chosen again next time.
let last = '';

/** Asks for a demo model; its path within the content root (demo/...), or undefined if cancelled. */
export async function askDemo(): Promise<string | undefined> {
  const box = document.createElement('div');
  const said = document.createElement('p');
  said.textContent = 'Fetching the list of demo models...';
  const label = document.createElement('label');
  label.textContent = 'Model';
  const select = document.createElement('select');
  select.className = 'wide';
  select.disabled = true;
  label.append(select);
  box.append(said, label);
  const shown = showDialog({ title: 'Load Demo Model', body: [], content: box,
    buttons: [{ label: 'Load', value: 'load', primary: true, disabled: true }, { label: 'Cancel', value: 'cancel' }] });
  // (The dialog is in the page once showDialog returns.)
  const load = box.closest('form')!.querySelector<HTMLButtonElement>('button.primary')!;
  void fetchCatalog().then((models) => {
    if (!models.length) {
      said.textContent = 'There are no demo models.';
      return;
    }
    for (const m of models) select.add(new Option(`${m.path} (${formatSize(m.size)})`, m.path));
    if (models.some((m) => m.path === last)) select.value = last;
    said.textContent = `${models.length} demo model${models.length === 1 ? '' : 's'}:`;
    select.disabled = load.disabled = false;
    select.focus();
  }, (e: Error) => {
    said.textContent = `Could not fetch the list of demo models: ${e.message}.`;
    said.className = 'failed';
  });
  const r = await shown;
  if (r.button !== 'load' || !select.value) return undefined;
  last = select.value;
  return `demo/${select.value}`;
}
