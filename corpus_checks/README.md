# Corpus checks

Scripts that run this repository's code against the real-world test corpus: 517 Part 21 files, 421 MB, 4.9 M
instances (see `../test_corpus/README.md`). They complement the package tests (`npm test`), which use small inline
fixtures and don't need the corpus. Each step added the check that verified it; the results and what they
found are recorded in `../docs/phase1_progress.md` through `../docs/phase4_progress.md`.

## Setup

Fetch the corpus once with `../test_corpus/third_party/pull.sh`. The scripts find it relative to the repository, so
they run from any directory; a check stops with a hint to run `pull.sh` if listed files are missing. The checks that
read the whole corpus take an optional list file in place of `../test_corpus/files.txt`, one path per line relative to
`../test_corpus/third_party/`.

## The checks

| Script | Step | What it does | Time |
|---|---|---|---|
| `threejs_corpus.ts` | phase 4, 2 | Every file imported, tessellated with our OCCT backend (pool, 0.1 mm, edges) and exported to three.js JSON with edges and curves; the JSON loaded with `THREE.ObjectLoader` and compared with the export view: part objects in tree order, world matrices, index counts, every triangle's material colour and opacity. Prints JSON sizes and export and load times. Second argument: maximum MB (default 2; the log used 1000; run with `--max-old-space-size=8192`). | ~3.5 min |
| `export_view.ts` | phase 4, 1 | Every file imported and tessellated with our OCCT backend (a `tess-workers` pool, 0.1 mm, edges), and `cad-scene`'s export view checked against `partInstances`: each drawable part instance once at its path, world transforms with the mesh's origin, visibility, default materials, every triangle with the material the scene resolves for its face, equal instances sharing a look. Second argument: maximum MB (default 2; the log used 1000). | ~3 min |
| `gltf_corpus.ts` | phase 4, 4 | Every file imported, tessellated with our OCCT backend (a `tess-workers` pool, 0.1 mm, edges) and exported as GLB with edges, curves and hidden instances (`KHR_node_visibility`); each GLB checked with the Khronos glTF-Validator (errors are problems; other issues tallied by code), read back with glTF-Transform and compared with the export view: a node per placed part in tree order, visibility, world matrices from the TRS written, triangles and per-triangle base colour and alpha per group, one mesh per look. Second argument: maximum MB (default 2; the log used 1000). Run with `--max-old-space-size=8192`. | ~7 min |
| `dangling_refs.ts` | phase 4, 3a | Imports every file and lists the importer's warnings of dangling references (per part: references to instances the file doesn't define) and the scan's of references beyond the largest instance id, to compare with OCCT's `Unresolved Reference` messages. | ~16 s |
| `truck_occt.ts` | phase 3, 3 and 3b | Every brep part through the truck backend and our OCCT backend (each in a `tess-workers` pool, so hangs time out): truck's status (panic, timeout, error, empty), missing faces, edge kinds, edge points off the mesh, area against OCCT's, faces facing opposite to OCCT's, faces whose normals contradict their loops (as the file orients the faces in their solids), its workaround diagnostics; and both backends' placed surface area against the file's validation property. Needs both backends built. Second argument: maximum MB (default 30). `DUMP=<dir>` writes each problem part's subset (the log used `DUMP=corpus_checks/truck_repros`, git-ignored); `WORKERS=<n>` per backend (default 4). OCCT's reader printed `*** ERR StepReaderData ...` lines on standard output when the log was made, so the log has them filtered out (`grep -v '^\*\*\*\*\? ERR '`); since phase 4 step 3 they are the part's warnings instead. | see `../docs/phase3_progress.md` |
| `truck_bench.ts` | phase 3, 3 | Single-threaded speed of truck module variants (arguments: `.wasm` files; default the built one) and our OCCT backend over phase 0's subsets (`../phase0_tessellation_spike/out`, `out_bike`), as phase 0 timed them. Run with the CPU idle, not on battery in low power mode. | ~1 min per variant |
| `cache_check.ts` | phase 3, 4 | `tess-cache` over phase 0's subsets with each backend: every result read back from a new file store, and from a memory store, equals the backend's own; times of the backend alone and of a first and second cached run; then truck's hang (`trj2_as1-id-203` #891) in a pool with a 10 s timeout, the timeout cached and answered from the store. Run with the CPU idle, not on battery in low power mode. | ~2 min |
| `subset_corpus.ts` | phase 2, 2 | Builds a subset for every shape representation the product structure reaches, as the importer does, and checks it parses cleanly, matches the source instance for instance, and lacks only references dangling in the source. | ~10 s |
| `import_corpus.ts` | phase 2, 3 | Imports every file into the scene model: `validate`, agreement with the semantic layer, every part payload parsed; tallies parts, materials, layers. Second argument `none` skips the payload checks. | ~10 s |
| `scene_occt.ts` | phase 2, 5 | The whole path (import, our OCCT backend, placement) against `occt-import-js`'s import: sampled vertices on OCCT's surface, and colours of sampled triangles. Needs `packages/tess-occt` built. Second argument: maximum MB (the log used 5). Progress per file on standard error. | ~4 min |
| `semantic_corpus.ts` | 6 | Runs every Layer 3 extractor on every file and tallies products, occurrences (and whether each got a placement), styles, layers, validation properties and diagnostics. | ~5 s |
| `products_occt.ts` | 6 | Checks product structure and placements against OCCT through `occt-import-js` (prebuilt in `../test_corpus/third_party/occt-import-js/dist`): every B-rep vertex of every product instance, moved to world millimetres with our transforms, must be among OCCT's mesh vertices. Takes a maximum file size in MB as a second argument (the log used 30). | many minutes: OCCT tessellates every file |
| `validation_occt.ts` | 6 | Compares the volume, area and centroid validation properties we extract (in SI units) with those computed from OCCT's meshes, for files with one root. Second argument: maximum MB (the log used 5). | minutes |
| `bind_corpus.ts` | 5 | Binds every instance with value checks (Layer 2) and tallies how instances bind and every diagnostic; cross-checks each file's reverse-reference index against the forward references, and `instancesOf` against `isInstanceOf`. | ~20 s |
| `json_corpus.ts` | 4 | Parse (A) → raw JSON → load (B) → Part 21 → parse (C), comparing every instance, the header and the DATA sections (A ≡ B and A ≡ C); also checks that `JSON.parse` accepts the JSON, that writing B again gives the same bytes, and (since step 7) that the NDJSON form loads back to B. Expect 0 instances differing. | ~1 min |
| `number_kinds.ts` | 4 | Binds every int and real to its schema slot and tallies what the schema says the slot holds (INTEGER, REAL, NUMBER, SELECT, no context). Shows that context alone can't tell ints from reals, and lists the number-kind violations Layer 2 must tolerate. | ~1 min |
| `writer_corpus.ts` | 3 | Parse (A) → write → parse (C), comparing every instance, the header and the DATA sections (A ≡ C); then writes C again, which must be byte-identical, and checks the verbatim fast path (source bytes copied) the same way. Expect 0 instances differing. | ~1.5 min |
| `parser_corpus.ts` | 2 | Parses and decodes every instance, tallies diagnostics and decode errors, and checks each instance's attributes against the schema dictionaries (slot counts, derived slots, unknown entities). | ~12 s |
| `parser_lenient_quotes.ts` | 2 | Lists the files and strings where the lenient end-of-string rule (a lone `'` ends a string only before `,` or `)`) reads differently from the strict one. | ~4 s |
| `parser_bench.ts` | 2 | Scan and decode speed and index memory for the files named on the command line (paths relative to `../test_corpus/third_party/`). | seconds |
| `schema_corpus_check.ts` | 1 | The original dictionary check, with a crude tokenizer written before the parser existed. Superseded by `parser_corpus.ts`; kept because `schema_xdict.ts` reads its log. | ~7 s |
| `schema_xdict.ts` | 1 | Compares the four dictionaries' attribute layouts with AP242's, and looks up in AP242 the entities that `schema_corpus_check.log` reports as unknown to a file's own schema. Takes that log as its argument. | < 1 s |

`corpus.ts` is the shared helper: the repository and corpus locations, the file list, and short names for reports.

## Reference outputs

The `.log` files are the outputs the progress document cites. To compare a fresh run with one, diff everything but the
lines with timings (line 2 of the writer and JSON logs, line 1 of the parser, binding and semantic logs; the OCCT checks print no timings), for example:

```sh
node corpus_checks/semantic_corpus.ts > /tmp/s6.log && diff <(sed 1d corpus_checks/semantic_corpus.log) <(sed 1d /tmp/s6.log)
node corpus_checks/bind_corpus.ts > /tmp/b.log && diff <(sed 1d corpus_checks/bind_corpus.log) <(sed 1d /tmp/b.log)
node corpus_checks/json_corpus.ts > /tmp/j.log && diff <(sed 2d corpus_checks/json_corpus.log) <(sed 2d /tmp/j.log)
node corpus_checks/number_kinds.ts > /tmp/n.log && diff corpus_checks/number_kinds.log /tmp/n.log
node corpus_checks/writer_corpus.ts > /tmp/w.log && diff <(sed 2d corpus_checks/writer_corpus.log) <(sed 2d /tmp/w.log)
node corpus_checks/parser_corpus.ts > /tmp/p.log && diff <(sed 1d corpus_checks/parser_corpus.log) <(sed 1d /tmp/p.log)
node corpus_checks/schema_corpus_check.ts > /tmp/s.log && diff corpus_checks/schema_corpus_check.log /tmp/s.log
node corpus_checks/schema_xdict.ts corpus_checks/schema_corpus_check.log
node corpus_checks/parser_bench.ts gkv311-opencascade-dataset/step/bug31711.stp gkv311-opencascade-dataset/step/Median_cx-fs01_bicycle.stp
```

A difference means either a code change or a corpus update; `../test_corpus/README.md` records the corpus versions the
logs were made with.
