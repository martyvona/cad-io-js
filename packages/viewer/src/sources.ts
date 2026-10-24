// Where models come from: a URL (the dev server's /content/, the same server, or another that allows CORS), or local
// files, picked with the File System Access API where the browser has it (desktop Chrome, in a secure context) and
// an <input type="file"> elsewhere, or dropped on the page (the user, 2026-10-24; CLAUDE.md, "The viewer"). No
// handles or files are stored.

import { formatOf } from './formats.ts';
import type { Source } from './load.ts';

export async function fromUrl(url: string): Promise<Source> {
  const abs = new URL(url, document.baseURI).href;
  const r = await fetch(abs);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${abs}`);
  const name = decodeURIComponent(new URL(abs).pathname.split('/').pop() || abs);
  return { name, bytes: await r.arrayBuffer(), url: abs };
}

/**
 * The model among local files (the first whose format is known: .bin and images are only referred to) with the
 * others as its siblings, or undefined if none is a model.
 */
export async function fromFiles(files: readonly File[]): Promise<Source | undefined> {
  const model = files.find((f) => formatOf(f.name) !== undefined);
  if (!model) return undefined;
  const siblings = new Map(files.filter((f) => f !== model).map((f) => [f.name, URL.createObjectURL(f)] as const));
  return { name: model.name, bytes: await model.arrayBuffer(), siblings };
}

interface PickerWindow { showOpenFilePicker?(o: { multiple: boolean }): Promise<{ getFile(): Promise<File> }[]> }

/** Asks for local files: the browser's file picker, several allowed (a .gltf with its .bin). Empty if cancelled. */
export async function pickFiles(): Promise<File[]> {
  const w = window as PickerWindow;
  if (w.showOpenFilePicker && window.isSecureContext) {
    try {
      return await Promise.all((await w.showOpenFilePicker({ multiple: true })).map((h) => h.getFile()));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return [];
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => resolve([...input.files ?? []]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}
