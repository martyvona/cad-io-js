# Phase 1 (the parser): plan and progress

*Paths in this document are relative to this `docs/` directory.*

Phase 1 of `architecture.md` ("Phasing"). The design is in `architecture.md`, "Stage 1: the parser". This file tracks the order of work and what each step found.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | Schema generator: EXPRESS → JSON dictionaries (`../packages/step-schemas`) | **Done** 2026-10-17 |
| 2 | Layer 1 lexer and parser: byte-range index pass, lazy entity decode, string decoding, `.stpZ` (`../packages/step-parser`) | **Done** 2026-10-17 |
| 3 | Part 21 writer | **Done** 2026-10-17 |
| 4 | Raw JSON encoding (lexical numbers, `../packages/lexical-json`), list kinds in the raw model, and round-trip tests A ≡ B ≡ C | **Done** 2026-10-17 |
| 5 | Layer 2 schema binding: names, reverse-reference index, `FILE_SCHEMA` mapping, tolerance policy, value checks | **Done** 2026-10-17 |
| 6 | Layer 3 semantic extractors: product tree, units, names, styles, validation properties | Next |
| 7 | `step2json` CLI: raw and semantic modes, streaming, NDJSON | |

## Repo setup (done with step 1)

- npm workspaces at the root (`../packages/*`). pnpm isn't installed; npm does the job so far.
- TypeScript runs directly on Node 24 with type stripping (`node file.ts`), so the code uses only erasable syntax (`erasableSyntaxOnly`: no enums, namespaces or parameter properties) and imports with `.ts` extensions. `tsc` (TypeScript 7.0.2) is a dev dependency for type-checking only. Emitting plain JS for publishing comes later (`rewriteRelativeImportExtensions` is already on).
- Tests use `node:test`: `npm test` from the root, and `npm run typecheck`.
- `../env.sh` at the root (committed; `source env.sh` from bash or zsh) checks the system tools: Node ≥ 24, npm, git, curl, unzip, CMake ≥ 3.10, make, Emscripten ≥ 6.0.12, Rust ≥ 1.85 with the wasm32 target, wasm-pack ≥ 0.15.0, and optionally python3 and a C++ compiler. It sources `~/.cargo/env` and the emsdk's `emsdk_env.sh` (from `$EMSDK`, else `~/emsdk`) when they aren't set up yet, notes a missing `npm install`, `../third_party/` or test corpus, and prints macOS or Linux (apt or dnf) commands to install or update whatever is missing or too old.
- Git repo initialized 2026-10-17; initial commit `b5a1794` (phase 0, steps 1–2). `../.gitignore` excludes `node_modules`, the multi-GB phase 0 build outputs and generated subsets, and the Siemens JT reference documents.
- Repo tidy-up (2026-10-17): `spike/` was renamed `../phase0_tessellation_spike/` and now holds only phase 0 work. The phase 1 corpus scripts moved to `../corpus_checks/` (renamed from `.mts` to `.ts`, since `.mts` was only needed under the spike's CommonJS `../package.json`), and the corpus list to `../test_corpus/files.txt`. The third-party corpus repositories live in `../test_corpus/third_party/` (git-ignored), where `../test_corpus/third_party/pull.sh` clones or updates them, and the list's paths are relative to that directory; `../test_corpus/README.md` describes the corpus, setup and the versions used. The 19 occt-import-js files now come from a git checkout (LF line endings) instead of the npm package (CRLF); otherwise identical. After the move, the writer, parser and schema corpus checks reproduced their logs exactly. The phase 0 documents (`phase0_results.md`, `phase0_spike_plan.md`, `phase0_subset_method.md`) moved into `../phase0_tessellation_spike/`, next to a new `README.md` there that tours the committed files and gives the commands to reproduce the builds and results. Non-npm dependencies (OCCT, stepcode, truck, monstertruck, the MBx-IF recommended practices) are checked out at pinned versions in a git-ignored `../third_party/` by `../third_party/pull.sh`; `../third_party/README.md` lists them and the reference-only repositories. Scripts now use paths relative to the repo instead of `/Users/vona/src/others`, and the `STEPCODE_DIR` override is gone. The Siemens JT documents moved to `third_party/` (git-ignored), with a `pull.sh` that downloads them and recreates their `.txt` versions byte for byte using pinned pypdf in a local venv. The phase 0 OCCT build was redone from `../third_party/OCCT` (`occt-build-Os`, verified against the logs) and the old build directories, including the overlay variant, were deleted. The remaining root documents (`architecture.md`, `initial_analysis.md`, this file) moved into `docs/`, and the three phase 0 build scripts were converted from zsh to bash (same link output) so they run on Linux too. Finally the project was renamed from `step_js` to **cad-io-js** (npm name and scope checked free on 2026-10-17), since JT and IGES support is planned; the repository directory moved from `/Users/vona/src/mine/step_js` to `/Users/vona/src/mine/cad-io-js`. The STEP-specific packages keep their names.

## Step 1: schema generator

### What was built

- `../packages/step-schemas/gen/`: an EXPRESS lexer and a recursive-descent parser for the declaration subset (entities, defined types, selects, enumerations, including EXTENSIBLE and BASED_ON forms; supertype expressions; explicit and derived redeclarations with RENAMED; inverses). Rules, functions, procedures, constants, subtype constraints, WHERE/UNIQUE clauses and derive expressions are skipped. About 500 lines; it parses all four target schemas, and also AP209, AP210e3 and IFC4, in 10–125 ms each.
- `gen/generate.ts` writes `dict/{ap203,ap203e2,ap214e3,ap242}.json`. The output is committed, one entity or type per line so schema changes diff cleanly. Each file records the source path and its SHA-256. `npm run gen -w step-schemas` regenerates, from the stepcode checkout in `../third_party/stepcode` (fetched by `../third_party/pull.sh`; before 2026-10-17 it was a sibling checkout overridable with `STEPCODE_DIR`).
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

`../packages/step-schemas/test/`, 19 tests:
- parser unit tests on EXPRESS snippets covering every construct above
- `Schema` slot tests, both synthetic (diamond inheritance, same-named attributes from different declarers, chained redeclarations) and on the real AP242 dictionary (`B_SPLINE_CURVE_WITH_KNOTS`, unit complex instances)
- FILE_SCHEMA mapping, using the names seen in the corpus
- a freshness test: the committed JSON must equal what the generator produces now (skipped without the stepcode checkout)
- a consistency test: every referenced type, supertype, inverse target and redeclaration resolves, and every entity flattens

### Corpus check (throwaway, `../corpus_checks/schema_corpus_check.ts`)

(Superseded by the step 2 rerun with the real parser, `../corpus_checks/parser_corpus.ts`, which confirmed these numbers; see step 2.) A crude Part 21 tokenizer counted the attributes of every instance in 517 corpus files: 438 from the gkv311 OCCT data set (including the bicycle file), 60 NIST PMI models and 19 occt-import-js test files. The list is `../test_corpus/files.txt` (see `../test_corpus/README.md`); the log is `../corpus_checks/schema_corpus_check.log`. For each instance it compared the count against the dictionary's slots and checked that derived slots hold `*` and only derived slots do.

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

### Cross-dictionary comparison (`../corpus_checks/schema_xdict.ts`)

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

`../packages/step-parser`, about 1,100 lines:

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
- **A reference beyond 2^32 − 1** (the largest id the index holds) is read as `$`, with a warning, and isn't recorded in the index. Found by the step 3 writer check: OCCT's `bug31292.stp` ("references to invalid entities") has `#18446744073709551615`, which the decoder had read as an imprecise double and the index had wrapped to `#0`; a reference like `#4294967297` would have wrapped to `#1`, a real instance. This matches OCCT, which keeps the entity and treats the reference as unresolved (its fix for issue 31292, commit `ef59b5e064`). Decided by the user 2026-10-17, over the strict alternative (failing the instance's decode). Part 21 sets no maximum as far as known; OCCT and stepcode read ids into a signed 32-bit `int` (limit 2^31 − 1), and the corpus's largest id is 821,290.
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

- **Corpus** (`../corpus_checks/parser_corpus.ts`, log in `../corpus_checks/parser_corpus.log`): 517 files, 421 MB, 4.93 M instances, all decoded. Only 3 instances fail, all in two files OCCT ships deliberately broken (`bug32314_corrupted.stp`, and `bug29633…`, which is missing a parenthesis). The step 1 schema slot check, re-run on the real parser's output, gives the same picture as the crude tokenizer, minus the `EDGE_CURVE` and `bug25171` mismatches that are now parsed correctly.
- **Phase 0 subsets:** all 492 files in `../phase0_tessellation_spike/out*` load with no diagnostics.
- **Counts:** per-file instance counts agree with a line-based count of `#n=` in every file except those two broken ones.
- **Speed** (`../corpus_checks/parser_bench.ts`, Node 24, M-series Mac):

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

## Step 3: Part 21 writer

### What was built

`../packages/step-parser/src/write.ts`, about 250 lines, schema-independent, as designed in `architecture.md`:

- **`writeChunks(doc, {chunkSize})`**, a generator of byte chunks (64 KiB by default). The caller pulls, so any sink gets backpressure for free, and instances are pulled lazily from their iterables, so a whole file is never one string or one array of instances. `writeStep(doc)` concatenates into one `Uint8Array`.
- **`StepDocument`** is `{header, data: [{name?, schemas?, instances}]}`. Several DATA sections, or a named one, write edition 3 `DATA('name',('SCHEMA'));`. No sections writes an empty `DATA;`.
- **Verbatim instances:** an item that is a `Uint8Array` is copied as is: the subset fast path. `StepFile.sourceBytesAt(p)` gives an instance's source bytes.
- **`fileDocument(file, onError?)`** re-writes a parsed file lazily: its header, its DATA sections, its instances in file order. Malformed instances are reported and skipped; without `onError` they throw.
- **`makeHeader({name, schemas, …})`** builds the three mandatory header entities, for subset files.
- **`formatInstance`, `formatRecord`, `formatValue`, `formatReal`, `formatString`** are exported for one-off use.

### Formatting rules

- **Reals:** the shortest text that reads back as the same double (`String(x)`), with `.` added to the mantissa and the exponent written `E` without `+`: `5.`, `1.E-7`, `1.E21`, `0.25`. `-0` is written `-0.`.
- **Strings:** `'` and `\` doubled; printable ASCII as is; other BMP characters, including control characters and lone surrogates, as `\X2\hhhh…\X0\` runs; characters beyond the BMP as `\X4\hhhhhhhh…\X0\` runs, so a run switches between the two as needed. The output is pure ASCII, except bytes copied verbatim.
- **Integers:** `bigint` and unsafe-but-integral numbers through `BigInt`.
- **One instance per line**, no spaces, no line wrapping.
- **Values Part 21 can't hold throw a `WriteError`** naming the instance: NaN and infinities, a non-integer `int`, malformed names, enumerations or binaries, negative or unsafe ids and references. The parser never produces these, so they mean a caller bug. (`architecture.md` had said "a diagnostic"; a throw is simpler and can't be ignored.) Entity names are checked once each and cached.

### What the writer brings back from tolerated input

The parser's tolerances (step 2) mean the model can hold values from non-conformant text. The writer always writes them conformantly, so the output differs from the source text but parses to the same model:
- An out-of-range reference (read as `$`) is written `$`.
- A lone apostrophe is written doubled (`'Bob''s part'`); an unknown escape's backslash is written `\\`.
- An empty parameter is written `$`.
- `\N\`, `\T\` and `\X\hh` become `\X2\` runs; `\S\` with a code page becomes the Unicode character in an `\X2\` run.
- Line breaks that were dropped from inside strings stay dropped.

### Tests

6 new tests (36 in the repo):
- `formatReal` cases, plus 20,000 random doubles over the whole range (by bit pattern) written and read back exactly
- `formatString` cases, plus 5,000 random strings from a pool of awkward characters (quotes, backslashes, `,`, `)`, CR/LF, NUL, DEL, Latin-1, Cyrillic, U+FFFF, astral, lone surrogates), checked to be pure ASCII and to decode back exactly
- every value kind and the `WriteError` cases
- parse → write → parse on a file with every kind and every string tolerance (A ≡ C), and the second write byte-identical to the first
- chunked output equal to whole output; verbatim copies with comments and spacing; malformed instances skipped or thrown
- edition 3 sections; `makeHeader`; an empty document

Mutation check: six deliberate bugs in `write.ts` (no `.` on integral reals, `-0` lost, mixed `\X2\`/`\X4\` runs, an undoubled quote on either string path, chunk buffer reuse) each fail at least one test.

### Corpus round trip (`../corpus_checks/writer_corpus.ts`, log in `../corpus_checks/writer_corpus.log`)

Every corpus file: parse (A) → write → parse (C), compared instance by instance with `isDeepStrictEqual` (which distinguishes `-0`, int vs. real, and so on), plus the header and DATA section names; then C written again must be byte-identical; then the verbatim fast path (all source bytes copied) parsed and compared with A.

- **517 files, 4,925,008 instances: 0 differ**, headers and sections all equal, every second write byte-identical, the fast path equal everywhere, all output pure ASCII.
- 3 malformed instances skipped, the known ones from step 2. `bug31292.stp`'s out-of-range reference is read as `$` (see the step 2 tolerances) and written back as `$`.
- `bug25013_25013faces.stp` has two duplicated instances (identical copies, `#794080`/`#794081`) in its source; the writer reproduces both, so the rewritten file has the same duplicate-id diagnostics.
- Output is 381 MB for 421 MB of input: mostly the dropped spacing, offset by longer reals in some files.

### Speed

About 65–70 MB/s of output (Node 24, M-series Mac), for example 45 MB written in 0.65 s for `bug29979_firetherm_12.step`, not counting decoding. A quarter of the time is in `formatReal`, i.e. `String(x)` producing the shortest round-trip text; garbage collection and `encodeInto` are next. That's about half the decode speed, and enough for subset files, which are small. A faster real formatter (or reusing the source text of each real) is possible if a full-file rewrite ever matters.

### Open from step 3

- **Line wrapping** for readability isn't implemented; neither OCCT nor truck needs it.
- **Edition 3 anchors and references** can't be written, since the model doesn't hold them (see step 2).

## Step 4: raw JSON and the A ≡ B ≡ C round trip

### Design discussion and decisions

The architecture had left the "compact value encoding" open. The measurements below were made first, then the user set the priorities and chose the design (2026-10-17):

- **Clarity and extensibility over size.** Raw JSON is for testing, debugging and validation, and is expected to be rare in production. Production outputs are glTF, GLB and 3MF, and possibly tessellated JT and STEP. The format should also extend to other source formats (IGES, JT).
- **Lexical numbers** (the user's choice): an int is written `5`, a real always with a point or an exponent (`5.0`, `1e-7`), with our own reader and writer, since `JSON.parse` merges the two.
- **In memory, typed arrays for long numeric lists**, plain arrays for short ones (no experiment needed: V8 already stores short double arrays unboxed, and small typed arrays cost more to create). Serialized, they're plain JSON arrays of lexical numbers.
- **Float32 belongs in the scene model, not the raw model.** Tessellated vertex positions, normals and colours always use `Float32Array` in the scene model and the backends, which feed glTF/GLB/3MF directly; the raw model keeps doubles, since it must be lossless (AP242 `COORDINATES_LIST` and friends are REALs), Layer 1 can't tell which lists are vertex attributes, and narrowing should follow recentering on a part-local origin. If doubles in the raw model use too much memory, revisit later; not optimized now.

**Value kinds in the corpus** (517 files, 4.93 M instances): 12.5 M reals, 5.7 M references, 5.5 M lists, 4.9 M strings (3.4 M of them empty), 3.1 M ints (95% inside lists: knot multiplicities, tessellation indices), 1.3 M enumerations, 0.8 M `*`, 52 k typed parameters, 43 k `$`. No int needs more than 53 bits.

**Size of the candidate encodings** over the corpus, for the record (instances only, one per line):

| Encoding | Raw | gzip |
|---|---|---|
| Part 21 source | 421 MB | 99.9 MB |
| Part 21 rewritten by our writer | 381 MB | 95.1 MB |
| Tagged `{"k":…,"v":…}` values, object framing | 1,052 MB | 112.9 MB |
| Sigil strings (`"#12"`, `".T."`), int `{"i":n}`, object framing | 532 MB | 100.0 MB |
| Sigil strings, int `{"i":n}`, array framing | 419 MB | 96.7 MB |
| Sigil strings, int `"=n"`, array framing | 409 MB | 96.4 MB |
| **Chosen: lexical numbers, one-key tags, object framing** (whole document) | 554 MB | not measured |

**Could the int/real distinction come from the schema instead?** The user asked whether plain JSON numbers could be typed by context (knot multiplicities and indices are always ints). `../corpus_checks/number_kinds.ts` (log `../corpus_checks/number_kinds.log`) bound every number in the corpus to its schema slot:

| Number in the file | Count |
|---|---|
| real where the schema says REAL | 12,283,985 |
| int where the schema says INTEGER | 3,113,547 |
| no usable context (unknown entity, attribute count mismatch, no dictionary) | 198,022 (187 k reals, 11 k ints) |
| real in an untyped SELECT slot (e.g. `CURVE_STYLE.curve_width` without its `POSITIVE_LENGTH_MEASURE(...)` wrapper) | 10,668 |
| real where the schema says INTEGER (`INTEGER_REPRESENTATION_ITEM.the_value`) | 1,435 |
| int or real where the schema says NUMBER | 444 |
| int where the schema says REAL | 1 |

Context decides 98.6% of numbers, but not the rest, so context typing would still need a rule plus tagged exceptions, and loading raw JSON would then need the same dictionary and binding logic as the writer (a regenerated dictionary could silently change how an old file loads). Lexical numbers keep raw JSON schema-free. Context-typed plain numbers remain the natural choice for semantic mode, where the schema has already been applied, and for spec-driven formats like JT. The violations in the table also feed step 5's tolerance policy: reals in INTEGER slots and untyped values in SELECT slots must bind with a diagnostic.

### The list kinds in the raw model

`../packages/step-parser/src/model.ts` gains three list kinds besides `list`:

```ts
| { k: 'reals'; v: number[] | Float64Array }              // a non-empty list of reals only
| { k: 'ints';  v: number[] | Int32Array | Float64Array } // a non-empty list of ints only, no bigints
| { k: 'refs';  v: number[] | Uint32Array }               // a non-empty list of references only
```

- **Canonical:** `makeList(values)` picks the kind, and the parser and the JSON loader produce only canonical lists, so two models of the same data are deeply equal. `list` holds everything else: mixed lists, lists with `$`, nested lists, empty lists, lists with a bigint. `listItems(v)` turns any list back into values.
- **Storage:** lists of `TYPED_ARRAY_MIN` (16) or more elements use typed arrays; shorter ones plain arrays. Ints use `Int32Array` when they all fit, else `Float64Array` (exact to 2^53); references use `Uint32Array`, or `Float64Array` above 2^32 − 1 (possible from JSON or the API, not from the parser). Storage isn't part of a value's meaning; `isDeepStrictEqual` distinguishes it, but it is a function of the contents, so equal data always gets equal storage.
- **Effect** (Node 24, AC power): decoding speed is unchanged within noise, measured back to back against the old code. Memory with every instance of a file decoded and held drops by a third: `bug29979_firetherm_12.step` 392 → 261 MiB, the bicycle 177 → 121 MiB, `bug31711.stp` 284 → 175 MiB.

### What was built

- **`../packages/lexical-json`**, a new format-agnostic package (about 340 lines): `parseJson(bytes | string)` is an RFC 8259 parser over UTF-8 bytes that returns integers as `bigint` and reals as `number`. A real beyond the double range, duplicate keys and invalid UTF-8 are errors; a `"__proto__"` key is an ordinary property, as with `JSON.parse`; a leading BOM is skipped. `formatReal` writes the shortest round-trip text plus `.0` when it is integral (`-0` → `-0.0`); `formatInt`, `formatString` (`JSON.stringify`, so lone surrogates come out as `\u` escapes), and a generic `stringify` (bigints as ints, numbers as reals, float typed arrays as reals, integer typed arrays as ints, optional indentation). Our output is also standard JSON: `JSON.parse` reads it, merging ints and reals; so does any tool that re-serializes it with `JSON.stringify`, which turns `4.0` into `4`.
- **`../packages/step-parser/src/json.ts`**: `jsonChunks(doc)` / `writeJson(doc)` write a `StepDocument` as raw JSON in byte chunks (the writer's chunking moved to a shared `src/chunks.ts`, which now also handles multi-byte UTF-8 at chunk boundaries); verbatim byte instances are decoded first. `readJson(bytes)` returns a `RawJsonDocument`, which is itself a `StepDocument`, so it can be written as Part 21 directly. `valueJson`/`valueFromJson` and `instanceJson`/`instanceFromJson` work on single items. Errors: `WriteError` for values JSON can't hold (NaN, a non-integer int, a negative reference), `JsonParseError` for invalid JSON, `RawJsonError` with a path (`data[0].instances[12] (#34).attrs[2]`) for valid JSON that isn't a raw document.

**The format** (version 1):

```
{"format":"cad-io-js raw","version":1,"source":"step",
"header":[
{"type":"FILE_DESCRIPTION","attrs":[["a test"],"2;1"]},
…
],
"data":[
{"name":"…","schemas":["…"],"instances":[
{"id":1,"type":"CARTESIAN_POINT","attrs":["origin",[0.0,-1.5,1e-7]]},
{"id":3,"type":"AXIS2_PLACEMENT_3D","attrs":["",{"ref":1},{"ref":2},null]},
{"id":10,"parts":[{"type":"LENGTH_UNIT","attrs":[]},{"type":"NAMED_UNIT","attrs":[{"derived":true}]},{"type":"SI_UNIT","attrs":[{"enum":"MILLI"},{"enum":"METRE"}]}]},
…
]}
]}
```

| Value | JSON |
|---|---|
| real | `5.0`, `1e-7`, `-0.0` |
| int | `5` |
| string | `"x"` (decoded Unicode, UTF-8) |
| `$` | `null` |
| list, `reals`, `ints` | `[…]` |
| `refs` | `{"refs":[1,2]}` |
| reference | `{"ref":12}` |
| enumeration | `{"enum":"T"}` |
| `*` | `{"derived":true}` |
| binary | `{"bin":"0FF"}` |
| typed parameter | `{"type":"LENGTH_MEASURE","value":5.0}` |

- One instance per line; DATA section `name` and `schemas` only when the file has them (edition 3).
- `format`, `version` and `source` are checked on load, so other source formats can get raw JSON of their own.
- Unknown keys in the document, sections, instances and records are ignored, leaving room for annotations (attribute names, in step 5). Value objects must match one shape exactly. Booleans are rejected, since logicals are enumerations.

### Tests

13 new tests (49 in the repo): 7 in `lexical-json` (number kinds, 20,000 random doubles through `formatReal`, read by both parsers; escapes, raw UTF-8, BOMs and 5,000 random awkward strings; random documents against `JSON.parse`; 22 error cases; `stringify`), 5 in `step-parser/test/json.test.ts` (A ≡ B ≡ C on a file with every kind and tolerance, plus 16-element lists in each storage; the exact document layout; every value kind both ways; the error cases; chunking at every size from 1 to 256 bytes, verbatim instances, edition 3 sections, empty documents), and one parser test for canonical lists and their storage. The writer's chunk test now also runs every size from 1 to 256.

Mutation check: 16 deliberate bugs, in `formatReal`, escapes, duplicate keys, the BOM, int/real parsing, the loader's kinds and canonical lists, the `refs` key, section schemas, chunk handling (three), the typed-array threshold, wrapped references and the Part 21 `refs` format. 15 fail at least one test; the 16th only changes where chunks break, not the bytes written. One of the 15, text duplicated after a chunk flush, at first survived because chunk sizes 7 and 64 never reached that path; the 1–256 sweeps were added for it.

### Corpus round trip (`../corpus_checks/json_corpus.ts`, log in `../corpus_checks/json_corpus.log`)

Every corpus file: parse (A) → raw JSON → `JSON.parse` must accept it → load (B) → Part 21 → parse (C), comparing A with B and with C instance by instance (`isDeepStrictEqual`, which also checks typed-array storage), plus the header and DATA sections; writing B again must give the same bytes.

- **517 files, 4,925,008 instances: A ≢ B for 0, A ≢ C for 0.** Every JSON output is standard JSON, and every second write is byte-identical.
- The 3 malformed instances are skipped, as in steps 2 and 3, and `bug25013_25013faces.stp`'s two duplicated instances come back as duplicates in C, as in step 3.
- 554 MB of JSON for 421 MB of Part 21.
- The check detects what it should: with enumerations deliberately written as plain strings, 3 files gave 1,006 instances differing in both B and C.
- The other corpus checks reproduce their logs exactly after the model change (`writer_corpus.ts`, `parser_corpus.ts`).

### Speed

On AC power (Node 24, M-series Mac), decoding and writing JSON run at about 80 MB/s of JSON, and reading it back (`parseJson` plus model building) at about 80 MB/s. That is ample for a test and debug format. The timing line in the committed log was taken in low power mode, at about half that speed.

### Open from step 4

- **Streaming load:** `readJson` builds the whole JSON tree, then the model. Fine for testing; a streaming reader (or NDJSON, step 7) is needed for very large files.
- **Attribute-name annotations** in raw JSON wait for step 5 (Layer 2).
- **The lexer-level token comparison** described in `architecture.md`, "Round-trip testing", isn't implemented. The model-level checks have found nothing it would add so far.
- **Float32 vertex attributes and recentering** are scene-model work (stage 2).

## Step 5: Layer 2 schema binding

### What was built

`../packages/step-parser/src/bind.ts` (about 440 lines), which makes `step-parser` depend on `step-schemas`:

- **`openModel(file, {fallback})`** loads the dictionary that FILE_SCHEMA names (the first entry we have one for) and a **fallback dictionary**, AP242 by default, for entities the file's schema doesn't define. A file with no known schema binds entirely with the fallback, with a model-level warning. `new StepModel(file, schema, fallback)` takes `Schema` objects directly (the tests use a synthetic dictionary).
- **Type queries:** `types(p)` (the type, or a complex instance's partials, decoded once and cached), `isInstanceOf(p, entity)` through supertypes and partials, in whichever dictionary defines each type, and `instancesOf(entity)`, every instance of an entity and its subtypes in either dictionary, in file order, from a type index built on first use.
- **Reverse references:** `referrers(p)`, the distinct instances that reference p, in file order: one `Uint32Array` in compressed-row form built on first use from the pass-1 reference index (4 bytes per distinct reference plus 4 per instance). Dangling references are left out; `resolve(id)` gives a reference's position or -1.
- **Binding:** `bind(p, {check})` decodes an instance and returns a `BoundInstance`: its types, the dictionary that bound it, every attribute with its slot (name, declaring entity, declared type, optionality, derived), and `get('name')` or `get('ENTITY.name')`, which throws if an unqualified name is ambiguous (two supertypes declaring the same name). `bindInstance(inst)` binds an instance decoded elsewhere. `attributeNames(inst)` gives the names per record for annotating raw JSON.
- **Raw JSON names:** `writeJson(doc, {names: (inst) => model.attributeNames(inst)})` writes `"names":[...]` before each record's `"attrs"`. The loader ignores it, so annotated and plain JSON load the same.
- **`Schema.selectLeaves(t)` and `Schema.enumValues(t)`** in `step-schemas`: what a SELECT admits, flattened through nested selects and BASED_ON extensions, and an enumeration's values with its extensions. The long-form dictionaries have no BASED_ON types, but they're handled anyway.

### The tolerance policy as implemented

Nothing fails the file or the instance; every problem is a diagnostic on the `BoundInstance` (`warning` unless noted):

- **Which dictionary:** all of an instance's entities must be in one dictionary. The file's own is tried first, then the fallback (`info`: "X not in AUTOMOTIVE_DESIGN; bound with AP242…"). Otherwise the instance stays positional: "unknown entity X".
- **Attribute count** differing from the schema (another edition, a broken writer): positional, with a warning.
- **Derived slots:** a value where the schema derives the attribute, or `*` where it doesn't, binds by position with a warning.
- **Complex instances** with partials out of alphabetical order bind normally (`info`).
- **With `check: true`**, each value is checked against its declared type:
  - simple types: INTEGER, REAL, NUMBER, STRING, BINARY, BOOLEAN, LOGICAL
  - enumeration values
  - aggregate kinds and bounds, and `$` in an aggregate that isn't `OPTIONAL`
  - entity references, against the target's type through supertypes and partials, and dangling references
  - SELECT values: references to an allowed entity; typed parameters naming an allowed type or a specialization of one (`POSITIVE_LENGTH_MEASURE(…)` where `LENGTH_MEASURE` is listed); untyped values; typed parameters where a plain value is expected (the doubly wrapped `BOX_HEIGHT(POSITIVE_RATIO_MEASURE(…))`)
  - `$` in a mandatory attribute (`info`: it is very common for names and descriptions)

  Each distinct problem is reported once per attribute. Checks are opt-in, because extraction doesn't need them and they add about 45% to the binding time (see Speed).

### Tests

5 new tests (54 in the repo) in `test/bind.test.ts`:
- dictionary choice, the fallback and the no-dictionary cases
- names, qualified names and ambiguity
- complex units, with SI_UNIT making `NAMED_UNIT.dimensions` derived
- the AP214 derived-value and AP242 `*` cases, partial order, fallback binding, unknown entities, too many and too few attributes
- `types`, `isInstanceOf`, `instancesOf` (subtypes, complex instances, entities through the fallback, unknown entities), and `referrers` (file order, dedupe, dangling references)
- every check against a synthetic dictionary, in 9 variations of one instance
- raw JSON names

The real-dictionary tests caught three mistakes in the tests' own expectations, all confirmed against the dictionaries: `COORDINATES_LIST` and `EDGE_CURVE` are geometric representation items, and an `EDGE_CURVE` in the test data pointed at a point where a vertex belongs.

Mutation check: 18 deliberate bugs, covering:
- dictionary choice and the default fallback
- attribute counts, derived slots and mandatory `$`
- reverse-index dedupe
- subtype and exact type queries
- REAL accepting ints, defined-type specialization, enumeration values, aggregate bounds, `$` in aggregates
- SELECT references, nested SELECT flattening, dangling references
- partial order and name ambiguity

All 18 fail at least one test. Two of them (a weakened attribute-count check, and the dedupe) at first survived and needed new test cases: an instance with too few attributes, and a `POLYLINE` that repeats a point.

Before the corpus run was trusted, instrumenting the checker on 30 corpus files confirmed that it reaches every branch the files exercise: simple types, defined types, enumerations, entity references, SELECT references, typed and untyped values, and aggregates of every list kind. BINARY and NUMBER were not reached there; the synthetic tests cover them.

### Corpus (`../corpus_checks/bind_corpus.ts`, log in `../corpus_checks/bind_corpus.log`)

Every corpus instance bound with checks. The reverse index and type index of each file were cross-checked: every resolved forward reference appears exactly once among its target's referrers, and `instancesOf('REPRESENTATION_ITEM')` agrees with `isInstanceOf` on every instance.

| FILE_SCHEMA dictionary | Files | Instances | Bound by it | By the AP242 fallback | Positional |
|---|---|---|---|---|---|
| `ap203` | 62 | 467,679 | 466,136 | 1,536 | 7 |
| `ap203e2` | 45 | 361,660 | 361,627 | 33 | 0 |
| `ap214e3` | 345 | 3,320,556 | 3,320,259 | 157 | 140 |
| `ap242` | 46 | 674,749 | 674,749 | (none) | 0 |
| none (AP209, AP227, …), bound with AP242 | 19 | 100,364 | (none) | 78,572 | 21,792 |

So 99.56% of the 4.93 M instances bind with names. The cross-checks found no problems.

**Diagnostics** by kind:

| Kind | Count | Notes |
|---|---|---|
| Unknown entity | 21,924 | 80 distinct names: 66 from the two AP209 and one AP227 files, which have no dictionary; the other 14 are AP214 edition 1 (`PRODUCT_TYPE`, `AUTO_DESIGN_*`), AP203 construction history and a corrupted file. As step 1 predicted, the fallback resolved the rest. |
| SELECT values | 10,787 | `TRIMMED_CURVE` trims as bare reals instead of `PARAMETER_VALUE(…)` (10,648, 11 files); bare strings in `SOURCE_ITEM`; bare reals in `SIZE_SELECT` and `MEASURE_VALUE`; doubly wrapped typed parameters. |
| `$` in a mandatory attribute (`info`) | 7,775 | Mostly names, descriptions and ids. |
| Reference to the wrong type | 5,240 | Mostly the AP227 file, whose plant entities bind by AP242 supertypes only. Elsewhere `CC_DESIGN_APPROVAL` items (AP203 edition 1 meets AP242 selects), `STYLED_ITEM` styling whole representations (`ADVANCED_BREP_SHAPE_REPRESENTATION`, 170 in 8 files), an `OPEN_SHELL` as `MANIFOLD_SOLID_BREP.outer`. |
| Derived slots | 1,979 | `NAMED_UNIT.dimensions` given a value (1,880 in 189 files) or `*` (75); `CHARACTERIZED_OBJECT` name and description (22). |
| Bound by the fallback (`info`) | 1,726 | AP203 edition 1 files with presentation entities, AP214 files with `MECHANICAL_CONTEXT`, AP242 tessellation. |
| INTEGER/REAL mismatch | 1,436 | `INTEGER_REPRESENTATION_ITEM` with a real (1,435, 24 files), as `number_kinds.ts` found. |
| Aggregate bounds, `$` in a SET | 347 | Empty `REPRESENTATION.items` (289). |
| Partials out of order (`info`) | 125 | |
| Dangling reference | 74 | |
| Attribute count | 15 | `DOCUMENT_FILE` 5 vs 6, `DESCRIPTIVE_REPRESENTATION_ITEM` 1 vs 2. |

The picture matches steps 1 and 4: the schema mismatches the crude tokenizer found are all here, now with exact locations, plus what only full type checking can see.

**Speed** (Node 24, on battery in low power mode, so only comparable among themselves; measured back to back, twice, over the whole corpus held in memory):

| Pass over every instance | Time |
|---|---|
| decode | 6.0 s |
| decode and bind | 7.8 s |
| decode, bind and check | 11.0–11.5 s |

Building the reverse indexes took 0.2 s for the whole corpus, and the type indexes 1.1 s.

### Open from step 5

- **WHERE rules, UNIQUE clauses and derived values** aren't checked; the dictionaries don't carry them (step 1).
- **Complex instance validity** (whether a set of partials is a legal combination under the SUPERTYPE OF constraints) isn't checked.
- **INVERSE attributes** aren't exposed by name; `referrers` plus a type filter answers the same questions.
- **The AP227 and AP209 files** bind with AP242 supertypes only. Whether to ship further dictionaries (AP209, AP214 edition 1) is still undecided (step 1).
