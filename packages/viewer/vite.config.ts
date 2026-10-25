// The viewer's Vite config: the content root at /content/ (dev and preview servers), LAN and https by option, and in
// builds a progressive web app: a service worker that precaches everything the app needs, the OCCT and truck
// modules included, so a device that loaded it once can use it offline (the user, 2026-10-24; CLAUDE.md, "The
// viewer"). Options come from the environment (server/options.ts). Decoders need nothing here: three.js's
// DRACOLoader names its files by import.meta.url, which Vite bundles.

import fs from 'node:fs';
import path from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
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

/**
 * Drops `with { type: 'json' }` from dynamic imports (step-schemas loads its dictionaries so, as Node needs): Vite
 * serves a JSON module as JavaScript, which a browser refuses for an import that asks for JSON.
 */
const jsonImports = (): Plugin => ({
  name: 'cad-viewer-json-imports',
  enforce: 'pre',
  transform(code, id) {
    if (!/\.[cm]?[jt]s$/.test(id.split('?')[0]!) || !code.includes('json')) return undefined;
    const attribute = /(import\(\s*'[^']+\.json')\s*,\s*\{\s*with:\s*\{\s*type:\s*'json'\s*\}\s*\}\s*\)/g;
    const out = code.replace(attribute, '$1)');
    return out === code ? undefined : { code: out, map: null };
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
  plugins: [content(), jsonImports(), ...(opts.https === 'self' ? [basicSsl()] : []), VitePWA({
    // A new build replaces the old one at the next load, without asking (a developers' tool).
    registerType: 'autoUpdate',
    injectRegister: 'auto',
    includeAssets: ['icon.svg'],
    manifest: {
      name: 'cad-viewer', short_name: 'cad-viewer', description: 'Views STEP, glTF and three.js models',
      display: 'standalone', background_color: '#404040', theme_color: '#1f1f1f',
      icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    },
    workbox: {
      globPatterns: ['**/*.{js,mjs,css,html,wasm,json,svg}'],
      // OCCT's module is about 7 MB.
      maximumFileSizeToCacheInBytes: 32 * 2 ** 20,
      // Models from the dev or preview server's content root are fetched, not cached.
      navigateFallbackDenylist: [/\/content\//],
      clientsClaim: true,
      skipWaiting: true,
    },
  })],
  server: {
    port: opts.port, strictPort: true, host: opts.lan ? '0.0.0.0' : 'localhost', allowedHosts: true,
    ...(opts.https === 'mkcert' ? { https: mkcert() } : {}),
  },
  preview: { port: opts.port, strictPort: true, host: opts.lan ? '0.0.0.0' : 'localhost', allowedHosts: true },
  // three.js alone is about 700 kB minified, and loads at once anyway.
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2023', chunkSizeWarningLimit: 4000 },
});
