# Phase 1 (the parser): plan and progress

Phase 1 of `architecture.md` ("Phasing"). The design is in `architecture.md`, "Stage 1: the parser". This file tracks the order of work and what each step found.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | Schema generator: EXPRESS → JSON dictionaries (`packages/step-schemas`) | **Done** 2026-10-17 |
| 2 | Layer 1 lexer and parser: byte-range index pass, lazy entity decode, string decoding, `.stpZ` (`packages/step-parser`) | **Done** 2026-10-17 |
| 3 | Part 21 writer | Next |
| 4 | Raw JSON encoding (compact value encoding, still open) and round-trip tests A ≡ B ≡ C | |
| 5 | Layer 2 schema binding: names, reverse-reference index, `FILE_SCHEMA` mapping, tolerance policy | |
| 6 | Layer 3 semantic extractors: product tree, units, names, styles, validation properties | |
| 7 | `step2json` CLI: raw and semantic modes, streaming, NDJSON | |

## Repo setup (done with step 1)

- npm workspaces at the root (`packages/*`). pnpm isn't installed; npm does the job so far.
- TypeScript runs directly on Node 24 with type stripping (`node file.ts`), so the code uses only erasable syntax (`erasableSyntaxOnly`: no enums, namespaces or parameter properties) and imports with `.ts` extensions. `tsc` (TypeScript 7.0.2) is a dev dependency for type-checking only. Emitting plain JS for publishing comes later (`rewriteRelativeImportExtensions` is already on).
- Tests use `node:test`: `npm test` from the root, and `npm run typecheck`.
- Git repo initialized 2026-10-17 (no commits yet). `.gitignore` excludes `node_modules`, the multi-GB spike build outputs and generated subsets, and the Siemens JT reference documents.
- Spike scripts written in TypeScript use `.mts`, because `spike/package.json` is CommonJS.

## Step 1: schema generator

### What was built

- `packages/step-schemas/gen/`: an EXPRESS lexer and a recursive-descent parser for the declaration subset (entities, defined types, selects, enumerations, including EXTENSIBLE and BASED_ON forms; supertype expressions; explicit and derived redeclarations with RENAMED; inverses). Rules, functions, procedures, constants, subtype constraints, WHERE/UNIQUE clauses and derive expressions are skipped. About 500 lines; it parses all four target schemas, and also AP209, AP210e3 and IFC4, in 10–125 ms each.
- `gen/generate.ts` writes `dict/{ap203,ap203e2,ap214e3,ap242}.json`. The output is committed, one entity or type per line so schema changes diff cleanly. Each file records the source path and its SHA-256. `npm run gen -w step-schemas` regenerates; `STEPCODE_DIR` overrides the checkout location (default `../others/stepcode` beside this repo's parent).
- `src/`: the dictionary types (`types.ts`), the FILE_SCHEMA → dictionary mapping (`catalog.ts`), lazy dictionary loading via dynamic JSON import (`load.ts`), and a `Schema` class (`schema.ts`) that answers ancestors/subtypes queries and computes **attribute slots**:
  - `instanceAttributes(entity)`: the Part 21 layout of a simple instance. Supertypes come first, in SUBTYPE OF order, depth first, each supertype once. Each slot carries its declaring entity, its type narrowed by redeclarations, optionality, and whether a subtype redeclared it as DERIVE (so the file holds `*`).
  - `partialAttributes(entity, members)`: one partial of a complex instance. Redeclarations from every member apply, e.g. `SI_UNIT` makes `NAMED_UNIT.dimensions` derived in `(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(...))`.
- The generator rewrites each redeclaration's `from` to the entity that actually declares the attribute, since `SELF\x.attr` may name any supertype `x` that inherits it.

| Dictionary | Entities | Types | JSON | gzip |
|---|---|---|---|---|
| `ap203` (ed1 + amd 1, `CONFIG_CONTROL_DESIGN`) | 254 | 69 | 51 kB | 8 kB |
| `ap203e2` | 1,006 | 240 | 205 kB | 28 kB |
| `ap214e3` (`AUTOMOTIVE_DESIGN`) | 915 | 192 | 187 kB | 25 kB |
| `ap242` | 2,407 | 528 | 672 kB | 82 kB |

The AP242 file header claims 2,404 entities; the file actually declares 2,407.

### Tests

`packages/step-schemas/test/`, 19 tests:
- parser unit tests on EXPRESS snippets covering every construct above
- `Schema` slot tests, both synthetic (diamond inheritance, same-named attributes from different declarers, chained redeclarations) and on the real AP242 dictionary (`B_SPLINE_CURVE_WITH_KNOTS`, unit complex instances)
- FILE_SCHEMA mapping, using the names seen in the corpus
- a freshness test: the committed JSON must equal what the generator produces now (skipped without the stepcode checkout)
- a consistency test: every referenced type, supertype, inverse target and redeclaration resolves, and every entity flattens

### Corpus check (throwaway, `spike/schema_corpus_check.mts`)

(Superseded by the step 2 rerun with the real parser, `spike/parser_corpus.mts`, which confirmed these numbers; see step 2.) A crude Part 21 tokenizer counted the attributes of every instance in 517 corpus files (NIST, gkv311 and the bicycle file; list in `spike/schema_corpus_files.txt`, log in `spike/schema_corpus_check.log`). For each instance it compared the count against the dictionary's slots and checked that derived slots hold `*` and only derived slots do.

| Dictionary | Files | Instances | Match | Mismatch |
|---|---|---|---|---|
| `ap203` | 62 | 467,679 | 466,099 | 1,580 |
| `ap203e2` | 45 | 361,660 | 361,585 | 75 |
| `ap214e3` | 345 | 3,317,892 | 3,316,197 | 1,695 |
| `ap242` | 46 | 674,749 | 674,735 | 14 |

That is 99.93% of 4.82 M instances. 19 files name schemas we have no dictionary for (`CCD_CLA_GVP_AST`, `STRUCTURAL_ANALYSIS_DESIGN`, `CONSTRUCTION_HISTORY_SCHEMA`, `PLANT_SPATIAL_CONFIGURATION`). The crude tokenizer failed on one file (`nist/bug29633_nist_ctc_05_asme1_ap242-1.stp`); the real parser should be checked on it.

**Every mismatch traced to the file or to an edition difference, not to the generator:**

- **Entities from other schemas (1,858 instances).** AP203e1 files carry presentation entities (`STYLED_ITEM`, `COLOUR_RGB`, `PRESENTATION_LAYER_ASSIGNMENT`, …), often with a second FILE_SCHEMA entry such as `SHAPE_APPEARANCE_LAYER_MIM`. AP214 files carry AP242 tessellation entities (OCCT writes them), AP203 `CC_DESIGN_*` entities, and AP214 ed1 entities dropped in ed3 (`PRODUCT_TYPE`, `MECHANICAL_CONTEXT`, `AUTO_DESIGN_*`). Of the 47 distinct unknown names, **33 exist in the AP242 dictionary**. The rest are AP214 ed1, AP203 construction-history entities, and garbage from a deliberately corrupted file.
- **A value where the schema says derived.** AP214e3 redeclares `CONVERSION_BASED_UNIT.dimensions` as derived, but writers emit `NAMED_UNIT(#568)` (1,357 instances, all in AP214 files). AP242 derives `name`/`description` for `CHARACTERIZED_REPRESENTATION`, but files write `CHARACTERIZED_OBJECT('','')` (22). Six instances in AP203 files also write a value for `NAMED_UNIT.dimensions` next to `SI_UNIT`.
- **`*` where the schema has no derivation.** `NAMED_UNIT(*)` alongside `CONVERSION_BASED_UNIT` in AP203/AP203e2/AP242 files (75), and `REPRESENTATION(*)` (2).
- **Attribute counts from other editions or broken writers.** `EDGE_CURVE` with 4 attributes (40, one file), `DOCUMENT_FILE` 5 vs 6, `DESCRIPTIVE_REPRESENTATION_ITEM` 1 vs 2, plus single instances of `PRODUCT`, `POSITION_TOLERANCE` and an empty `REPRESENTATION_ITEM()` partial.
- **Informational:** `$` in mandatory slots is common (names and descriptions mostly), and 125 complex instances list their partials out of alphabetical order.

### Cross-dictionary comparison (`spike/schema_xdict.mts`)

Entities in both an older dictionary and AP242, compared by slot layout:
- `ap203`: 250 of 253 identical. `AREA_UNIT`/`VOLUME_UNIT` (`dimensions` vs `elements`) and `DATED_EFFECTIVITY` (start/end order) differ.
- `ap203e2`: 997 of 998 identical (`INSTANCED_FEATURE`, supertype order).
- `ap214e3`: 818 of 870 identical. Almost all 52 differences are the kinematics model, which AP242 replaced; also `APPLIED_NAME_ASSIGNMENT`, `VECTOR_STYLE`, `CONVERSION_BASED_UNIT`.

So for geometry, topology, product structure, units and presentation, the dictionaries agree, and AP242 is a near-superset.

### Consequences for later steps

These go into step 5 (Layer 2), as additions to the tolerance policy in `architecture.md`:
1. **Fallback lookup:** when an entity isn't in the file's dictionary, try AP242 before giving up. That would have resolved 33 of the 47 unknown names in the corpus. A file with no known schema could bind against AP242 outright. Whether to ship further dictionaries (AP214 ed1, AP209) isn't decided.
2. **Accept a value in a derived slot and `*` in an explicit slot.** Bind by position, with a diagnostic, never an error.
3. **An attribute count mismatch** keeps the instance raw and typed by name, with a diagnostic. Positional access still works; only names are missing.
4. **Complex instances** must not assume alphabetical partial order.

### Open from step 1

- **AP242 edition:** stepcode's schema is WG12 N11521. It replaced the edition 1 schema (N8324) in February 2026, so it's later than edition 1, but which edition (2 or 3) is unconfirmed. In practice it bound files labelled editions 1–4 with only 14 mismatches.
- **ISO EXPRESS redistribution terms:** still to verify. The dictionaries contain names and structure only, no schema text, rules or remarks.

## Step 2: Layer 1 lexer and parser

### What was built

`packages/step-parser`, about 1,100 lines:

- `model.ts`: the raw instance model from `architecture.md` (`Value`, `Instance`, `EntityRecord`) plus `Diagnostic` and `ParseError`.
- `scan.ts`, **pass 1**: one byte loop over the input, with no value decoding. It finds the sections (HEADER, DATA, and edition 3 ANCHOR/REFERENCE/SIGNATURE, which are skipped with a warning), the header entity ranges and every instance. The `InstanceIndex` is parallel typed arrays in file order:
  - per instance: id, byte start and end, and an interned type name (-1 for complex instances)
  - every instance's outgoing references, in one flat `Uint32Array` with per-instance offsets
  - id lookup by a dense table when ids are reasonably dense (`maxId ≤ 4n + 1024`), else binary search, with a sort permutation when ids aren't increasing. Duplicate ids get a diagnostic, and the first one wins.
- `decode.ts`, **pass 2**: decodes one instance's byte range on demand. Integers versus reals (`1E5` without a point counts as real), with `bigint` above 2^53; enumerations, binaries, typed parameters, nested lists, `$`, `*`, comments between any tokens, and lowercase keywords (uppercased).
- `strings.ts`: string literals and escapes (`''`, `\\`, `\S\`, `\Pa\` pages 8859-1…9, `\X\hh`, `\X2\`, `\X4\`).
- `file.ts`: `parseStep(bytes)` → `StepFile` with `header`, `schemaNames`, `dataSections` (edition 3 names and schemas), `instance(id)`, `instanceAt(p)`, `instances()` and `sourceAt(p)`. Decoding isn't cached; callers that revisit instances cache them themselves.
- `input.ts`: `readStep(Uint8Array | ArrayBuffer | Blob | ReadableStream)`, which gunzips `.stpZ` input by its magic number through `DecompressionStream`.

### Tolerances (beyond Part 21)

All of these are recorded so the next steps (writer, binding) know the model can hold values that came from non-conformant text:

- **Lone apostrophes:** a `'` ends a string only if followed by `,` or `)`. Conformant files parse identically. In the corpus this recovered `bug25171.stp`, whose product names contain an unescaped apostrophe: `'l'bracket-assembly'`. The strict rule had desynchronized the rest of the file and lost 2,669 instances. If no such `'` exists, the first lone `'` ends the string.
- **OCCT's string-escape tolerances:** `\X2\` in 3-digit groups, an unclosed `\X2\`/`\X4\` run at the end of the string, a stray `\X0\` dropped, and `\N\`/`\T\`. These follow OCCT's reader. Its test `bugs/step/bug28454_2` provides 15 cases, all reproduced in `test/strings.test.ts`. That test's printed comment for case 13 has a typo (`\S\D` where the data file has `\S\B`).
- **Strings in general:** unknown escapes keep their backslash, line breaks inside strings are dropped, and raw non-ASCII bytes decode as UTF-8 when valid and as ISO 8859-1 otherwise.
- **An empty parameter** (`EDGE_CURVE('',#1,#1,#0, )`) is read as `$`, with a warning. OCCT also keeps such instances (its test for issue 31756).
- **Header decoding** problems and section-structure problems (missing `ENDSEC`, missing `END-ISO-10303-21;`, unterminated strings or comments) become diagnostics; the file still loads.

### Tests

11 new tests (30 in the repo), covering:
- every value kind
- the index (types, references excluding strings and comments, byte ranges)
- the dense, sorted and permutation lookup paths
- lenient lexical forms (lowercase, BOM, CRLF, wrapped strings, comments between tokens)
- edition 3 sections
- duplicates, malformed instances and truncation
- gzip and stream input
- the 15 OCCT string cases, plus extra escape and tolerance cases

### Corpus and speed

- **Corpus** (`spike/parser_corpus.mts`, log in `spike/parser_corpus.log`): 517 files, 421 MB, 4.93 M instances, all decoded. Only 3 instances fail, all in two files OCCT ships deliberately broken (`bug32314_corrupted.stp`, and `bug29633…`, which is missing a parenthesis). The step 1 schema slot check, re-run on the real parser's output, gives the same picture as the crude tokenizer, minus the `EDGE_CURVE` and `bug25171` mismatches that are now parsed correctly.
- **Phase 0 subsets:** all 492 files in `spike/out*` load with no diagnostics.
- **Counts:** per-file instance counts agree with a line-based count of `#n=` in every file except those two broken ones.
- **Speed** (`spike/parser_bench.mts`, Node 24, M-series Mac):

| File | Size | Instances | Pass 1 (scan) | Pass 2 (decode all) |
|---|---|---|---|---|
| `bug29979_firetherm_12.step` | 59.4 MB | 537k | 239 ms (249 MB/s) | 414 ms (143 MB/s) |
| `bug31711.stp` | 30.7 MB | 413k | 145 ms (211 MB/s) | 225 ms (136 MB/s) |
| `Median_cx-fs01_bicycle.stp` | 24.6 MB | 302k | 112 ms (221 MB/s) | 170 ms (145 MB/s) |
| `bug30790.step` | 22.4 MB | 199k | 98 ms (228 MB/s) | 157 ms (143 MB/s) |

Pass 1 matches the phase 0 spike indexer (250–290 MB/s), which collected the same information into per-entity objects. The typed-array index, by contrast, costs about 20 bytes per instance plus 4 per reference: about 7 MB for the bicycle, against the spike's 480–700 MiB heap.

### Open from step 2

- **Edition 3 constant references and anchors** are still unrepresented. ANCHOR/REFERENCE/SIGNATURE sections are skipped with a warning, and a value that uses edition 3 syntax (`@name`, `<uri>`) fails that instance's decode. No corpus file has any.
- **Decode caching** is left to callers. Revisit when Layer 3 traversals show whether they need it.
- **Unterminated strings:** scan-level recovery isn't attempted. The rest of the file is lost, with a diagnostic; this never happened in the corpus.
