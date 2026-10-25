// Stands in for node:fs/promises in the browser (vite.config.ts): the backends read their modules with it only from
// file: URLs, which a page never has; without this, Vite warns at each build that it put an empty module there.

export function readFile(): never {
  throw new Error('no file system in the browser');
}
