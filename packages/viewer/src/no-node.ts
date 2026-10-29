// Stands in for node:fs, node:fs/promises and node:path in the browser (vite.config.ts): the backends read their
// modules with them only from file: URLs, which a page never has, glTF-Transform only in its NodeIO, Draco's decoder
// only in Node; without this, Vite warns at each build that it put an empty module there.

export function readFile(): never {
  throw new Error('no file system in the browser');
}

export default { readFile };
