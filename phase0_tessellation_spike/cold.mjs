import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const t0 = performance.now();
const bytes = fs.readFileSync(require.resolve('occt-import-js/dist/occt-import-js.wasm'));
const t1 = performance.now();
const mod = await WebAssembly.compile(bytes);
const t2 = performance.now();
const occt = await require('occt-import-js')();
const t3 = performance.now();
let tt = 0;
if (process.argv[2]) { const b = fs.readFileSync(process.argv[2]); const s = performance.now(); const r = occt.ReadStepFile(b, { linearDeflectionType: 'absolute_value', linearDeflection: 0.05 }); tt = performance.now() - s; if (!r.success) console.log('FAIL'); }
const mu = process.memoryUsage();
console.log(JSON.stringify({ read: +(t1 - t0).toFixed(1), compile: +(t2 - t1).toFixed(1), factoryInit: +(t3 - t2).toFixed(1), tess: +tt.toFixed(0), wasmHeapMiB: +(occt.HEAP8.length / 2 ** 20).toFixed(0), rssMiB: +(mu.rss / 2 ** 20).toFixed(0), file: process.argv[2]?.split('/').pop() }));
