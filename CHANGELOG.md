# Changelog

## 0.1.0 (2026-10-23)

The first release, tagged `V0.1.0`; not published to npm (the packages run as TypeScript sources under Node 24).

- **STEP reading and writing** (`step-parser`, `step-schemas`, `lexical-json`): a two-pass Part 21 parser over bytes (a typed-array index, lazy decoding) tolerant of real-world files; a lossless raw instance model; a Part 21 writer that round-trips the 517-file test corpus with no differences; raw JSON and NDJSON with integers and reals kept apart; schema binding against AP203 (editions 1 and 2), AP214 and AP242 dictionaries generated from EXPRESS, with value checks; semantic extraction of the product structure and placements, units, styles, layers and validation properties; per-part subsets.
- **The scene model** (`cad-scene`) and the **STEP importer** (`step-import`): components and occurrences with instancing, parts per shape representation, millimetres, materials resolved from styles (per face, per instance), layers, external references; names recovered from generic ones; diagnostics for dangling references.
- **Tessellation:** the per-part `Tessellator` interface with face, edge, curve and point ids; backends on our own WebAssembly build of OCCT 8.1 (`tess-occt`, LGPL-2.1) and on truck (`tess-truck`, with workarounds for its failures on real files); a worker pool with timeouts and recycling (`tess-workers`); a cache in memory, a directory or IndexedDB (`tess-cache`); meshes repaired in memory (degenerate triangles dropped, inside-out shells turned over).
- **Export:** the export view (looks, material groups, instance transforms), and exporters to three.js JSON (`export-threejs`), glTF and GLB (`export-gltf`, with glTF-Transform) and 3MF (`export-3mf`, with fflate).
- **Command-line tools** (`cad-io-cli`): `step2json` (raw, NDJSON or semantic JSON) and `stepconv` (three.js, GLB, glTF or 3MF, with OCCT or truck, workers and an optional cache).
- **Tests:** 193 package tests, and 25 corpus checks over 517 files against OCCT and against each output format's own reader or validator.
