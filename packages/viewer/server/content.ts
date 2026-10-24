// The dev server's content root: every file below one directory (default test_corpus/) served at /content/, for
// `cad-viewer open` and for loading models by URL in development (the user, 2026-10-24; CLAUDE.md, "The viewer").
// Nothing outside the root is served, symbolic links included.

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const CONTENT_PREFIX = '/content/';

const TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json', '.bin':
    'application/octet-stream', '.stp': 'model/step', '.step': 'model/step', '.stpz': 'model/step+zip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ktx2': 'image/ktx2',
};

/**
 * The file a request path names below the content root (its real path), or undefined if it names nothing there:
 * outside the prefix, not a file, outside the root once `..` and symbolic links are resolved, or malformed.
 */
export function contentFile(root: string, urlPath: string): string | undefined {
  if (!urlPath.startsWith(CONTENT_PREFIX)) return undefined;
  let rel: string;
  try { rel = decodeURIComponent(urlPath.slice(CONTENT_PREFIX.length)); } catch { return undefined; }
  let real: string;
  let top: string;
  try {
    top = fs.realpathSync(root);
    real = fs.realpathSync(path.resolve(top, rel));
  } catch { return undefined; }
  if (!real.startsWith(top + path.sep) || !fs.statSync(real).isFile()) return undefined;
  return real;
}

/** The URL path that serves a file below the content root, or undefined if the file isn't below it. */
export function contentUrl(root: string, file: string): string | undefined {
  let top: string;
  let real: string;
  try { top = fs.realpathSync(root); real = fs.realpathSync(file); } catch { return undefined; }
  if (!real.startsWith(top + path.sep)) return undefined;
  return CONTENT_PREFIX + path.relative(top, real).split(path.sep).map(encodeURIComponent).join('/');
}

/** Connect-style middleware serving the content root (GET and HEAD); other paths go to `next`. */
export function contentMiddleware(root: string) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const urlPath = new URL(req.url ?? '/', 'http://x').pathname;
    if (!urlPath.startsWith(CONTENT_PREFIX)) return next();
    const file = req.method === 'GET' || req.method === 'HEAD' ? contentFile(root, urlPath) : undefined;
    if (!file) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': fs.statSync(file).size, 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file).pipe(res);
  };
}
