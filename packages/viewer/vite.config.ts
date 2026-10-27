// The viewer's Vite config: the content root at /content/ (dev and preview servers), LAN and https by option, and in
// builds a progressive web app: a service worker that precaches everything the app needs, the OCCT and truck
// modules included, so a device that loaded it once can use it offline (the user, 2026-10-24; CLAUDE.md, "The
// viewer"). Options come from the environment (server/options.ts). Decoders need nothing here: three.js's
// DRACOLoader names its files by import.meta.url, which Vite bundles.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { contentMiddleware } from './server/content.ts';
import { optionsFromEnv } from './server/options.ts';

const opts = optionsFromEnv(process.env);
const VITE_LICENSES = '.vite/licenses.md';

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

/**
 * Leaves out of a build the Draco decoders three.js's DRACOLoader names but the viewer never loads (it uses the
 * glTF-only one, src/load.ts): the general WebAssembly decoder and the JavaScript one for browsers without
 * WebAssembly, about 1 MB that the service worker would otherwise cache.
 */
const unusedDecoders = (): Plugin => ({
  name: 'cad-viewer-unused-decoders',
  apply: 'build',
  generateBundle(_, bundle) {
    const unused = /three\/examples\/jsm\/libs\/draco\/draco_(decoder\.js|decoder\.wasm|wasm_wrapper\.js)$/;
    for (const [name, out] of Object.entries(bundle)) {
      if (out.type === 'asset' && out.originalFileNames.some((f) => unused.test(f))) delete bundle[name];
    }
  },
});

/**
 * licenses.md beside index.html: what a build bundles and under which licenses, then Vite's list of the npm packages
 * (their own license texts), then ours in full (OCCT's LGPL among them). Vite's list misses what isn't an npm package
 * in node_modules (our workspace packages, the WebAssembly modules), hence the first part.
 */
const licenses = (): Plugin => ({
  name: 'cad-viewer-licenses',
  apply: 'build',
  // After the files are written: Vite's list is made last.
  writeBundle(out) {
    const dir = out.dir!;
    const file = path.join(dir, VITE_LICENSES);
    if (!fs.existsSync(file)) throw new Error(`no ${VITE_LICENSES} from Vite`);
    const vite = fs.readFileSync(file, 'utf8');
    fs.rmSync(path.dirname(file), { recursive: true });
    const repo = path.resolve(import.meta.dirname, '../..');
    const text = (f: string) => fs.readFileSync(path.join(repo, f), 'utf8').trim();
    const packages = vite.replace(/^# Licenses\s*\n/, '').replace(/^(#+) /gm, '#$1 ');
    const bundles = [
      '- cad-io-js itself: Apache-2.0, below;',
      '- the OCCT tessellation backend (`assets/occt_tess-*.wasm` and `occt_tess-*.mjs`), which contains ' +
        'Open CASCADE Technology: LGPL-2.1 with the Open CASCADE exception, below (its source, the build scripts ' +
        'included, in cad-io-js\'s `packages/tess-occt`; OCCT\'s at https://github.com/Open-Cascade-SAS/OCCT);',
      '- the truck tessellation backend (`assets/tess_truck-*.wasm`): cad-io-js\'s wrapper and truck ' +
        '(https://github.com/ricosjp/truck), Apache-2.0, with the Rust crates ' +
        '`packages/tess-truck/native/Cargo.lock` lists, each under its own license (MIT or Apache-2.0 for the most ' +
        'part);',
      '- Draco\'s glTF decoder (`assets/draco_*`, from three.js): Apache-2.0 (https://github.com/google/draco);',
      '- meshoptimizer\'s decoder (in three.js): MIT;',
      '- the npm packages Vite lists below.',
    ];
    fs.writeFileSync(path.join(dir, 'licenses.md'), [
      '# Licenses',
      'cad-viewer, part of cad-io-js (https://github.com/martyvona/cad-io-js), bundles:',
      bundles.join('\n'),
      '## npm packages',
      packages.trim(),
      '## cad-io-js (Apache-2.0)',
      text('LICENSE.txt'),
      '## The OCCT tessellation backend (LGPL-2.1 with the Open CASCADE exception)',
      text('packages/tess-occt/LICENSE.txt'),
    ].join('\n\n') + '\n');
  },
});

function mkcert(): { cert: Buffer; key: Buffer } {
  const cert = path.join(opts.certDir, 'cert.pem');
  const key = path.join(opts.certDir, 'key.pem');
  if (!fs.existsSync(cert) || !fs.existsSync(key)) throw new Error(
    `no mkcert certificate in ${opts.certDir} (cert.pem, key.pem): see README.md, "Phones, Tablets and https"`);
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

const pwa = VitePWA({
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
});

/**
 * The viewer's version, shown in its title (the user, 2026-10-27): the repository's, its root package.json's, and in
 * a build the commit it's built from, its first 7 hex digits (-dirty with uncommitted changes, which deploy-viewer.sh
 * refuses), so a deployment says what it is without a release for it. Without git, the version alone.
 */
function version(build: boolean): string {
  const repo = path.resolve(import.meta.dirname, '../..');
  const git = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return undefined;
    }
  };
  const release = (JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { version: string }).version;
  const hash = build ? git('rev-parse', '--short=7', 'HEAD') : undefined;
  if (!hash) return release;
  const dirty = git('status', '--porcelain', '--untracked-files=no') ? '-dirty' : '';
  return `${release}-${hash}${dirty}`;
}

export default defineConfig(({ command }) => ({
  root: import.meta.dirname,
  define: { __CAD_IO_VERSION__: JSON.stringify(version(command === 'build')) },
  base: './',
  resolve: { alias: { 'node:fs/promises': path.join(import.meta.dirname, 'src/no-fs.ts') } },
  plugins: [content(), jsonImports(), unusedDecoders(), licenses(), ...(opts.https === 'self' ? [basicSsl()] : []),
    pwa],
  server: {
    port: opts.port, strictPort: true, host: opts.lan ? '0.0.0.0' : 'localhost', allowedHosts: true,
    ...(opts.https === 'mkcert' ? { https: mkcert() } : {}),
  },
  preview: { port: opts.port, strictPort: true, host: opts.lan ? '0.0.0.0' : 'localhost', allowedHosts: true },
  // three.js alone is about 700 kB minified, and loads at once anyway. Vite's list of the bundled npm packages'
  // licenses goes into licenses.md (licenses()).
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2023', chunkSizeWarningLimit: 4000,
    license: { fileName: VITE_LICENSES } },
  // Module workers, split into chunks: the import worker loads the schema dictionaries on demand.
  worker: { format: 'es' },
}));
