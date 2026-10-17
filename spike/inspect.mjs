import { load, typeOf, byType } from './p21.mjs';
const idx = load(process.argv[2]);
const counts = {};
for (const e of idx.ents.values()) { const t = typeOf(e); counts[t] = (counts[t] || 0) + 1; }
const interesting = /SHAPE_REPRESENTATION|BREP|SHELL|PRODUCT_DEFINITION\b|SHAPE_DEFINITION_REPRESENTATION|NEXT_ASSEMBLY|CONTEXT|SURFACE_MODEL|ITEM_DEFINED_TRANSFORMATION/;
for (const [t, c] of Object.entries(counts).sort()) if (interesting.test(t)) console.log(c, t);
console.log('entities', idx.ents.size);
