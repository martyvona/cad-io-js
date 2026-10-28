// Where models come from: a URL (the dev server's /content/, the same server, or another that allows CORS), or local
// files, picked with the File System Access API where the browser has it (desktop Chrome, in a secure context) and
// an <input type="file"> elsewhere, or dropped on the page (the user, 2026-10-24; CLAUDE.md, "The viewer"). No
// handles or files are stored. Models below the content root (content/ beside the page: the dev server's /content/,
// and the demo models in a deployment) can be named by their path within it (the user, 2026-10-26): a relative path
// in `?model=` and in Load URL..., which read what they're given alike (typedUrl).

import { formatOf } from './formats.ts';
import type { Source } from './load.ts';

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
