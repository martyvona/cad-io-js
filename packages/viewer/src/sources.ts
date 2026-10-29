// Where models come from: a URL (the dev server's /content/, the same server, or another that allows CORS), or local
// files, picked with the File System Access API where the browser has it (desktop Chrome, in a secure context) and
// an <input type="file"> elsewhere, or dropped on the page (the user, 2026-10-24; CLAUDE.md, "The viewer"). No
// handles or files are stored. Models below the content root (content/ beside the page: the dev server's /content/,
// and the demo models in a deployment) can be named by their path within it (the user, 2026-10-26): a relative path
// in `?model=` and in Load URL..., which read what they're given alike (typedUrl).

import { formatOf, type Format } from './formats.ts';
import type { ModelInput } from './model-load.ts';

/** A model as it was read: its bytes, and where the files it names (a .gltf's .bin) are found. */
export interface Source {
  /** The file's name (for messages and its format). */
  name: string;
  bytes: ArrayBuffer;
  /** Where relative references resolve: the file's URL, or undefined for a local file. */
  url?: string;
  /** Local files given with it, by name (a .gltf's .bin). */
  siblings?: Map<string, Blob>;
}

/** The content root's URL: content/ beside the page. */
export const contentRoot = (): string => new URL('content/', document.baseURI).href;

/**
 * The URL of a path within the content root (`demo/part.step`, a plain path, not URL-encoded), or undefined if it
 * isn't one: empty, absolute (`/...`, `//host/...`), or with empty, `.` or `..` segments. Each segment is encoded, so
 * `:` (a scheme), `\`, `?`, `#` and `%` are characters of a name.
 */
export function contentUrl(p: string): string | undefined {
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return undefined;
  const url = new URL(segments.map(encodeURIComponent).join('/'), contentRoot()).href;
  // Always below the root, given the above: a guard.
  return url.startsWith(contentRoot()) ? url : undefined;
}

/** A URL's path within the content root, or undefined if it isn't below it (for links: `?model=`). */
export function contentPath(url: string): string | undefined {
  const root = contentRoot();
  if (!url.startsWith(root) || /[?#]/.test(url)) return undefined;
  try {
    return url.slice(root.length).split('/').map(decodeURIComponent).join('/');
  } catch {
    return undefined;
  }
}

/**
 * What `?model=` and Load URL... load for what they're given: a URL (`https://...`, `//host/...`) or a path on the
 * page's server (`/content/...`) as it is, a relative path within the content root; undefined if it's neither.
 */
export function typedUrl(typed: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(typed) || typed.startsWith('/')) return typed;
  return contentUrl(typed);
}

export async function fromUrl(url: string): Promise<Source> {
  const abs = new URL(url, document.baseURI).href;
  let r: Response;
  try {
    r = await fetch(abs);
  } catch (e) {
    // (The browser says only "Failed to fetch": the server unreachable, or not letting this page read it.)
    throw new Error(`could not fetch ${abs} (${(e as Error).message}): the server can't be reached, or doesn't let ` +
      'this page read it (CORS)');
  }
  if (!r.ok) throw new Error(`${r.status === 404 ? 'not found' : 'the server refused it'} (${r.status} ` +
    `${r.statusText}): ${abs}`);
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
  const siblings = new Map(files.filter((f) => f !== model).map((f) => [f.name, f as Blob] as const));
  return { name: model.name, bytes: await model.arrayBuffer(), siblings };
}

/**
 * What the import worker is given for a model: a copy of its bytes (the source keeps its own, to be meshed again),
 * and for a .gltf the buffers it names by URI (not data URIs, which it holds), from the local files given with it
 * (by the URI's last segment) or beside its URL. Images aren't fetched: textures aren't read. Throws if a buffer
 * can't be found.
 */
export async function modelInput(src: Source, format: Format): Promise<ModelInput> {
  const bytes = new Uint8Array(src.bytes.slice(0));
  if (format !== 'gltf') return { format, bytes };
  let json: { buffers?: { uri?: string }[] };
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // (The importer says it isn't glTF.)
    return { format, bytes };
  }
  const resources: Record<string, Uint8Array> = {};
  for (const uri of (json.buffers ?? []).flatMap((b) => (b.uri && !b.uri.startsWith('data:') ? [b.uri] : []))) {
    const local = src.siblings?.get(decodeURIComponent(uri.split('/').pop() ?? ''));
    if (local) resources[uri] = new Uint8Array(await local.arrayBuffer());
    else if (src.url) resources[uri] = new Uint8Array((await fromUrl(new URL(uri, src.url).href)).bytes);
    else throw new Error(`${src.name} needs ${uri}: open it together with the .gltf`);
  }
  return { format, bytes, resources };
}

interface SaverWindow {
  showSaveFilePicker?(o: { suggestedName?: string }): Promise<{ createWritable(): Promise<{
    write(data: ArrayBuffer): Promise<void>; close(): Promise<void> }> }>;
}

/**
 * Saves a file's bytes where the user chooses (the user, 2026-10-28: File's Save...): the browser's save dialog
 * (File System Access, as Open file uses: desktop Chrome in a secure context), its name suggested; elsewhere a
 * download by that name (the browser's downloads folder, or its asking, as its settings say). Throws if writing
 * fails.
 */
export async function saveFile(name: string, bytes: ArrayBuffer): Promise<'saved' | 'downloaded' | 'cancelled'> {
  const w = window as SaverWindow;
  if (w.showSaveFilePicker && window.isSecureContext) {
    let handle;
    try {
      handle = await w.showSaveFilePicker({ suggestedName: name });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
      throw e;
    }
    const out = await handle.createWritable();
    await out.write(bytes);
    await out.close();
    return 'saved';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes]));
  a.download = name;
  a.click();
  // (Revoked once the download has surely begun.)
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return 'downloaded';
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
