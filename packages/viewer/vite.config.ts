// The viewer's Vite config: the content root at /content/ (dev and preview servers), LAN and https by option (the
// user, 2026-10-24; CLAUDE.md, "The viewer"). Options come from the environment (server/options.ts). Decoders need
// nothing here: three.js's DRACOLoader names its files by import.meta.url, which Vite bundles.

import fs from 'node:fs';
import path from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';
import { contentMiddleware } from './server/content.ts';
import { optionsFromEnv } from './server/options.ts';

const opts = optionsFromEnv(process.env);

const content = (): Plugin => ({
  name: 'cad-viewer-content',
  configureServer(server) {
    server.middlewares.use(contentMiddleware(opts.contentRoot));
  },
  configurePreviewServer(server) {
    server.middlewares.use(contentMiddleware(opts.contentRoot));
  },
});

function mkcert(): { cert: Buffer; key: Buffer } {
  const cert = path.join(opts.certDir, 'cert.pem');
  const key = path.join(opts.certDir, 'key.pem');
  if (!fs.existsSync(cert) || !fs.existsSync(key)) throw new Error(
    `no mkcert certificate in ${opts.certDir} (cert.pem, key.pem): see README.md, "Phones, Tablets and https"`);
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [content(), ...(opts.https === 'self' ? [basicSsl()] : [])],
  server: {
    port: opts.port, strictPort: true, host: opts.lan ? '0.0.0.0' : 'localhost', allowedHosts: true,
    ...(opts.https === 'mkcert' ? { https: mkcert() } : {}),
  },
  preview: { port: opts.port, strictPort: true, host: opts.lan ? '0.0.0.0' : 'localhost', allowedHosts: true },
  // three.js alone is about 700 kB minified, and loads at once anyway.
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2023', chunkSizeWarningLimit: 4000 },
});
