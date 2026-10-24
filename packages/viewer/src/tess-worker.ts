// The viewer's tessellation worker: tess-workers' Web Worker side with the backends imported here, statically, so
// that Vite bundles them (and their WebAssembly) into the build; the pool names them by these keys.

import * as occt from 'tess-occt';
import * as truck from 'tess-truck';
import { serveWebWorker } from 'tess-workers/web-worker';

serveWebWorker({ 'tess-occt': occt, 'tess-truck': truck });
