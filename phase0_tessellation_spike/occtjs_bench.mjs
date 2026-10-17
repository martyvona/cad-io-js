// occt-import-js on wrapped subsets (it needs the wrapper), absolute deflection 0.05 mm, idle-CPU timing
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const occt = await require('occt-import-js')();
for (const dir of process.argv.slice(2)) {
  let total = 0, n = 0, worst = [0, ''];
  for (const f of fs.readdirSync(dir).filter((f) => f.includes('.absr+wrap.')).sort()) {
    const buf = fs.readFileSync(path.join(dir, f));
    const t = performance.now(); occt.ReadStepFile(buf, { linearDeflectionType: 'absolute_value', linearDeflection: 0.05, angularDeflection: 0.5 }); const ms = performance.now() - t;
    total += ms; n++; if (ms > worst[0]) worst = [ms, f];
  }
  console.log(`${dir}: ${n} parts, total ${total.toFixed(0)} ms, worst ${worst[0].toFixed(0)} ms ${worst[1]}`);
}
