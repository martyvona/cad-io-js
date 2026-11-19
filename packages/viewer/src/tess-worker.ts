// The viewer's tessellation worker: tess-workers' Web Worker side with the backends imported here, statically, so
// that Vite bundles them (and their WebAssembly) into the build; the pool names them by these keys. cad-heal too, for
// its healJob (model-load.ts heals parts in these workers).

import * as occt from 'tess-occt';
import * as truck from 'tess-truck';
import * as smlib from 'tess-smlib';
import * as heal from 'cad-heal';
import { serveWebWorker } from 'tess-workers/web-worker';

serveWebWorker({ 'tess-occt': occt, 'tess-truck': truck, 'tess-smlib': smlib, 'cad-heal': heal });
