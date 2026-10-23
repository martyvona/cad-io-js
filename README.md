# cad-io-js

Reading CAD files into memory, and converting them, in TypeScript for Node.js and browsers. Today that means STEP (ISO 10303-21 files of AP203, AP214 and AP242):

- **a STEP parser and writer** in pure TypeScript with no runtime dependencies: lossless, schema-aware, tolerant of real-world files, and fast (about 230 MB/s to index, 140 MB/s to decode);
- **a scene model**: the assembly tree with transforms and instancing, names, part numbers, units, colours and layers, as the file states them and as well as they can be recovered from imperfect files;
- **tessellation by WebAssembly backends** behind one per-part interface: our own build of OCCT 8.1 (robust, the default) and truck (Apache-2.0, a fifth of the size), run in a pool of workers with timeouts and an optional cache;
- **exporters** to three.js JSON, glTF/GLB and 3MF;
- **two command-line tools**, `step2json` (STEP to JSON, lossless or semantic) and `stepconv` (STEP to three.js, glTF or 3MF).

Version 0.1.0, not yet published to npm: the packages run as TypeScript sources under Node 24 (see [Building from source](#building-from-source)). A browser-based viewer and more input formats are on the [roadmap](#roadmap).

```sh
stepconv bracket.step -o bracket.glb          # STEP → GLB, OCCT, 0.1 mm, all cores
stepconv assembly.stp -o assembly.3mf --3mf-assembly
step2json -m semantic --instances --pretty part.stp -o part.json
```

```ts
import fs from 'node:fs';
import { exportView, tessellateScene } from 'cad-scene';
import { glb } from 'export-gltf';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';

const { scene } = await importStep(fs.readFileSync('bracket.step'));   // the assembly, parts, colours, …
const occt = new OcctTessellator();
await occt.init();
const { meshes, diagnostics } = await tessellateScene(scene, occt, { linearDeflection: 0.1, angularDeflection: 0.5 });
occt.dispose();
const { bytes } = await glb(scene, exportView(scene, meshes));
fs.writeFileSync('bracket.glb', bytes);
```

(Until the packages are on npm, code like this runs inside the repository, where the workspace resolves the package names.)

Contents: [building from source](#building-from-source) · [installing](#installing) · [command-line tools](#command-line-tools) · [architecture](#architecture) · [packages and their APIs](#packages-and-their-apis) · [the test corpus](#the-test-corpus) · [the tests](#the-tests) · [roadmap](#roadmap) · [backlog](#backlog) · [license](#license). The history of the work so far, the decisions behind the design and the lessons learned are in [`CLAUDE.md`](CLAUDE.md); [`CHANGELOG.md`](CHANGELOG.md) lists the releases; [`step_tutorial.md`](step_tutorial.md) is a tutorial on STEP AP203/214/242 in practice.

## Building from source

On macOS or Linux (the build scripts are bash; Windows is untested).

### What you need first

None of these comes with the repository. `source env.sh` (below) checks every one of them and prints the commands to install or update what's missing, for macOS (Homebrew) or Linux (apt or dnf).

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 24 or later | everything: the sources run as TypeScript through Node's type stripping |
| npm | (with Node) | the workspace and the dev dependencies |
| git | 2.25+ | the fetch scripts |
| curl, unzip | any | the fetch scripts (the NIST corpus packages are zips) |
| CMake | 3.10+ | configuring the OCCT build |
| make | any | building OCCT |
| Emscripten (emsdk) | 6.0.12 | compiling OCCT and our wrapper to WebAssembly (`~/emsdk`, or `$EMSDK`) |
| Rust, cargo | 1.85+ (edition 2024), with the `wasm32-unknown-unknown` target | the truck backend |
| wasm-pack | 0.15.0 | its `wasm-opt` optimizes the truck module |
| python3 with `venv` | 3.8+, optional | extracting the JT specifications' text; the `VBernstein` overlay tests |
| a C++ compiler | optional | the overlay's native table test |
| pandoc and LaTeX | optional | `scripts/md2pdf.sh` (the tutorial's PDF) |

The project was built and tested with Node 24.5, Emscripten 6.0.12, Rust 1.99.1 and wasm-pack 0.15.0 on an M-series Mac.

### Steps

```sh
git clone https://github.com/martyvona/cad-io-js.git
cd cad-io-js
source env.sh                        # checks the tools; sets up Rust's and Emscripten's environment in this shell
npm install                          # dev dependencies (TypeScript, three, the validators) and the workspace links
third_party/pull.sh                  # OCCT, stepcode, truck and reference documents, at pinned versions (~400 MB)
packages/tess-occt/build-occt.sh     # OCCT's static libraries for WebAssembly (~6–12 minutes, ~850 MB)
packages/tess-occt/build.sh          # our OCCT wrapper, linked: packages/tess-occt/dist/occt_tess.{mjs,wasm}
packages/tess-truck/build.sh         # the truck backend: packages/tess-truck/dist/tess_truck.wasm
npm test                             # the package tests
npm run typecheck
```

Then the tools run directly, for example `node packages/cli/bin/stepconv.ts model.step -o model.glb` (or put `packages/cli/bin` on your `PATH`). The parser, importer, scene and exporters need none of the native builds; only tessellation does (one backend is enough: `stepconv -b truck` without OCCT, the default otherwise).

For the corpus checks, also fetch the test corpus (about 1.5 GB) and make phase 0's subsets:

```sh
test_corpus/third_party/pull.sh
# the subsets: the loop in corpus_checks/make_subsets.ts's header
```

Details: [`third_party/README.md`](third_party/README.md) (the pinned dependencies), [`test_corpus/README.md`](test_corpus/README.md), [`corpus_checks/README.md`](corpus_checks/README.md).

**OCCT build notes:** `build-occt.sh` builds only the `TKDESTEP` and `TKMesh` toolkits and their dependencies, with `-Os` (`-O2`, `-O3` and LTO buy no speed), `-fwasm-exceptions` and `-UOCC_CONVERT_SIGNALS` (without it the link produces invalid WebAssembly), into `packages/tess-occt/build/occt-Os/`. A build directory can't be moved (CMake keeps absolute paths); delete it and build again. The module is 7.2 MB (2.18 MB brotli). An optional patch, `packages/tess-occt/occt_overlay/`, computes a table OCCT stores and brings it to 1.71 MB brotli; it isn't used (see its README).

## Installing

The packages aren't on npm yet. When they are, this section will say how to install and use them, and the build above will only be needed to work on cad-io-js itself.

## Command-line tools

Both are in `packages/cli` (npm name `cad-io-cli`), as `bin/step2json.ts` and `bin/stepconv.ts`. Both read a file or standard input (`-`), plain or gzipped (`.stpZ`, detected by content), write a summary and the diagnostics to standard error (`-q` silences it), and exit with 0 on success, 1 for a usage error, 2 when the input can't be read or the output can't be written. Problems in the file are diagnostics, not failures.

### `step2json`: STEP to JSON

```
Usage: step2json [options] <file.stp | file.stpZ | ->

  -o, --output <file>    write here instead of standard output
  -m, --mode <mode>      raw (default): every instance, losslessly
                         semantic: product structure, units, styles, validation properties
      --ndjson           raw mode: one JSON value per line
      --names            raw mode: annotate each record with its attribute names
      --instances        semantic mode: list every product instance with its transform
      --check            semantic mode: check every instance against the schema; adds diagnostics
      --pretty           semantic mode: indent the output
  -q, --quiet            no summary on standard error
  -h, --help             show this help
```

```sh
step2json part.stp -o part.json                       # raw: every instance, losslessly, streamed
step2json --ndjson --names part.stp > part.ndjson      # one instance per line, attribute names added
gunzip -c part.stpZ | step2json - -o part.json         # standard input (gzipped input is also read directly)
step2json -m semantic --instances --check --pretty assembly.stp -o assembly.json
```

**Raw mode** is the lossless form: the header and every instance, attributes in file order, numbers keeping their integer or real form (`5` against `5.0`), references, enumerations, `$` and `*` explicit. It loads back into exactly the parsed model and writes back to equivalent Part 21; the whole corpus round-trips with no differences. Format:

```
{"format":"cad-io-js raw","version":1,"source":"step",
"header":[{"type":"FILE_DESCRIPTION","attrs":[["a test"],"2;1"]}, …],
"data":[{"instances":[
{"id":1,"type":"CARTESIAN_POINT","attrs":["origin",[0.0,-1.5,1e-7]]},
{"id":3,"type":"AXIS2_PLACEMENT_3D","attrs":["",{"ref":1},{"ref":2},null]},
{"id":10,"parts":[{"type":"LENGTH_UNIT","attrs":[]},{"type":"NAMED_UNIT","attrs":[{"derived":true}]},{"type":"SI_UNIT","attrs":[{"enum":"MILLI"},{"enum":"METRE"}]}]},
…]}]}
```

| Part 21 | JSON | | Part 21 | JSON |
|---|---|---|---|---|
| real `5.` | `5.0` | | reference `#12` | `{"ref":12}` |
| integer `5` | `5` | | list of references | `{"refs":[1,2]}` |
| string | `"x"` (decoded Unicode) | | enumeration `.T.` | `{"enum":"T"}` |
| `$` | `null` | | `*` | `{"derived":true}` |
| list | `[…]` | | binary | `{"bin":"0FF"}` |
| typed `LENGTH_MEASURE(5.)` | `{"type":"LENGTH_MEASURE","value":5.0}` | | | |

It is standard JSON (any parser reads it, though `JSON.parse` merges ints and reals); `lexical-json` reads it keeping the distinction. NDJSON: an envelope line with the header, a `{"data":{…}}` line opening each DATA section, then one instance per line. `--names` adds `"names":[…]` before each record's `"attrs"`; loading ignores it.

**Semantic mode** is what the file means, as standard JSON: `{"format":"cad-io-js semantic","version":1, file, roots, products, occurrences, representations, instances?, styles, validation, diagnostics}`. Products carry part number, name, description, version, life-cycle stage, shape representations and documents; occurrences their placement matrices (16 numbers, column-major, units converted); representations their contexts and units; styles the styled items with colours, transparency, overrides and layers; validation the CAx-IF validation properties in SI units. `--check` binds every instance with value checks and adds what it finds to the diagnostics.

On the largest corpus file (59 MB, 537k instances), raw output takes 1.2 s and semantic 0.4 s.

### `stepconv`: STEP to three.js, glTF or 3MF

```
Usage: stepconv [options] <file.stp | file.stpZ | -> -o <output>

Formats:
  threejs    .json        three.js JSON Object Scene format 4 (THREE.ObjectLoader)
  glb        .glb         glTF 2.0, binary
  gltf       .gltf        glTF 2.0, JSON with its buffer in a .bin beside it (or embedded: --gltf-embed)
  3mf        .3mf         3MF core, closed meshes (an item per placed part; colours as basematerials)

Options:
  -o, --output <file>      the output file
  -f, --format <format>    the output format, whatever the extension
  -b, --backend <name>     occt (default) or truck
  -d, --deflection <mm>    maximum distance between mesh and surface, in millimetres (default 0.1)
      --angular <deg>      maximum angle between adjacent mesh normals, in degrees (default 28.6,
                           0.5 rad; truck ignores it)
      --edges              write B-rep edges (not 3MF, which has no lines)
      --curves             write wireframe curves and points (not 3MF)
      --double-sided       render faces from both sides (not 3MF)
      --keep-hidden        glTF: write hidden instances with KHR_node_visibility; 3MF: as ordinary parts
                           (default: left out); three.js always writes them hidden
      --gltf-no-edges      glTF: leave out B-rep edges (as without --edges)
      --gltf-no-curves     glTF: leave out wireframe curves
      --gltf-no-points     glTF: leave out isolated points
      --gltf-faces-only    glTF: all three
      --gltf-unlit-lines   glTF: edges, curves and points with KHR_materials_unlit (flat colour)
      --gltf-embed         .gltf: the buffer embedded as base64 instead of a .bin beside it (a third bigger)
      --3mf-colorgroup     3MF: colours as the Materials extension's colorgroup (print colours, opaque) instead
                           of basematerials (display colours)
      --3mf-assembly       3MF: one build item, the assembly as components, instead of an item per placed part
      --3mf-surfaces       3MF: meshes that aren't closed manifolds as surface objects instead of left out
  -j, --workers <n>        parts tessellated at once, each in a worker (default: cores − 1); 0: one at a time
                           on the main thread, without a timeout
      --timeout <s>        per part, in a worker (default 120); 0: none
      --cache <dir>        cache tessellations in this directory
      --cache-size <MB>    the cache's maximum size (default 1024)
      --strict             exit 3 if a part fails to tessellate (the output is written all the same)
  -q, --quiet              no summary on standard error
  -h, --help               show this help
```

```sh
stepconv motor.step -o motor.glb                                  # OCCT, 0.1 mm, faces only
stepconv motor.step -o motor.json --edges --curves                # three.js with B-rep edges and wireframes
stepconv motor.step -o motor.gltf --edges --gltf-unlit-lines      # motor.gltf + motor.bin
stepconv motor.step -o motor.3mf --3mf-assembly --3mf-colorgroup  # one item, components following the tree
stepconv -b truck -d 0.05 --angular 15 part.stp -o part.glb       # truck, finer
stepconv --cache ~/.cache/cad-io-js big.stp -o big.glb            # a second run reads the meshes from the cache
cat part.stp | stepconv - -f glb -o - > part.glb                  # standard input to standard output
stepconv --strict part.stp -o part.glb || echo "some part failed" # exit 3 if a part has no mesh
```

The summary, for example:

```
1 parts (1 of 1 brep parts tessellated), 1 placed; 5628 triangles; 0.1 MB written
import 0.0 s, tessellation 0.5 s, export 0.0 s
0 errors, 0 warnings, 1 notes
```

What each format holds:

| | three.js JSON | glTF / GLB | 3MF |
|---|---|---|---|
| Tree | an `Object3D` tree following the assembly; a `Mesh` per placed part | a node tree following the assembly; a node per placed part | by default a build item per placed part at its world transform (slicers may rearrange them), the instance path in its metadata; `--3mf-assembly`: one item, nested component objects |
| Sharing | geometries shared by the instances of a part (and look) | a mesh per look, shared across nodes | a mesh object per look |
| Units, axes | millimetres, Z up, as the source | metres and Y up, by one root node | `unit="millimeter"` |
| Colours | `MeshStandardMaterial`, sRGB | `pbrMetallicRoughness`, linear base colour, alpha blending | `basematerials` with alpha; `--3mf-colorgroup` the Materials extension (opaque) |
| Metadata | names, STEP ids, properties, per-face ranges in `userData` | the same in `extras` | names, part numbers, the instance path |
| Hidden instances | `visible: false` | left out (or `KHR_node_visibility` with `--keep-hidden`) | left out (or kept) |
| Edges, curves, points | `LineSegments`, `Points` children, on request | `LINES`, `POINTS` child nodes, on request | none (3MF has no lines) |
| Not closed | written | written | left out with a warning (or `surface` objects with `--3mf-surfaces`) |

Parts that fail to tessellate don't fail the run; they are in the summary (with `--strict`, exit 3). OCCT's own messages are kept as warnings on their parts, not printed. Over the 517 corpus files, a run with the defaults takes about 200 s in all with 9 workers, nearly all of it tessellation; exporting is under 1 s for glTF, 15 s for three.js and 33 s for 3MF.

## Architecture

### Packages and what talks to what

An npm workspace of 13 packages. Arrows point from a package to what it uses.

```
┌──────────────────────────────────── cli (cad-io-cli) ─────────────────────────────────────┐
│      step2json                                                   stepconv                 │
└───────┬───────────────────────────────┬─────────────────────┬──────────────────┬──────────┘
        │                               │                     │                  │
        ▼                               ▼                     ▼                  ▼
┌──────────────┐            ┌──────────────┐  ┌──────────────────────────┐  ┌─────────────────┐
│ step-parser  │◄───────────┤ step-import  │  │ tess-cache  tess-workers │  │ export-threejs  │
│ Layers 1–3,  │            └──────┬───────┘  │ tess-occt   tess-truck   │  │ export-gltf ────┼──► glTF-Transform
│ writer, JSON │                   │          └────┬────────────┬────────┘  │ export-3mf ─────┼──► fflate
└──┬────────┬──┘                   │               │            │           └────────┬────────┘
   ▼        ▼                      ▼               ▼            ▼                    ▼
┌──────┐ ┌────────┐     ┌───────────────────────────────────────────────────────────────────┐
│step- │ │lexical-│     │ cad-scene: the scene model, the tessellator interface,            │
│schem-│ │json    │     │            tessellateScene, exportView, mesh helpers              │
│as    │ └────────┘     └───────────────────────────────────────────────────────────────────┘
└──────┘
 EXPRESS dictionaries          tess-occt  ──► OCCT 8.1, WebAssembly (our build of third_party/OCCT)
 (from stepcode)               tess-truck ──► truck, WebAssembly (our Rust wrapper over third_party/truck)
```

- **No runtime dependencies** in `step-schemas`, `lexical-json`, `step-parser`, `cad-scene`, `step-import`, the tessellation packages and `export-threejs`. `export-gltf` uses glTF-Transform (MIT) and `export-3mf` fflate (MIT).
- **`cad-scene` is the hub:** the scene model, the tessellator interface, the tessellation driver and the export view. Importers produce scenes, backends implement its interface, exporters consume scenes; none of them knows the others.
- **Licenses:** everything is Apache-2.0 except `tess-occt`, which keeps OCCT's LGPL-2.1 (with the Open CASCADE exception) isolated in one package.

### The path from a STEP file to a mesh file

```
  file.stp / .stpZ ──readBytes (gunzip)──► bytes
        │
        ▼  step-parser
  Layer 1  scan: one pass over the bytes → InstanceIndex (ids, byte ranges, types, references; typed arrays)
           decode: one instance's bytes → Instance (lazily, on demand)          ──► writer (Part 21), raw JSON
  Layer 2  openModel: the FILE_SCHEMA's dictionary (+ AP242 fallback) → names, types, reverse references, checks
  Layer 3  extractSemantics: products, occurrences + placements, units, styles, layers, validation properties
        │                                                                       ──► semantic JSON (step2json)
        ▼  step-import
  Scene: components placed by occurrences, parts (one per shape representation, each with a STEP subset payload
         and an origin), materials resolved from styles, layers, overrides, names, properties
        │
        ▼  cad-scene: tessellateScene (one request per brep part, deflection in the part's unit)
  CachedTessellator (tess-cache) → WorkerTessellator (tess-workers) → OcctTessellator | TruckTessellator
        │ meshes: Float32 positions minus the part's origin, face ranges with STEP face ids, edges, curves, points
        │ input fixes: degenerate triangles dropped, inside-out shells turned over
        ▼  cad-scene: exportView
  looks (a part and its materials), groups by material, the instance tree with transforms
        │
        ▼  export-threejs | export-gltf | export-3mf
  .json | .glb / .gltf + .bin | .3mf                                                   (stepconv)
```

### step-parser

```
 bytes ─► scan.ts (pass 1, ~230 MB/s) ─► InstanceIndex: per instance id, start, end, type; all references in one
           sections, header, instances     Uint32Array; id lookup by dense table or binary search
              │
              ├─► decode.ts / strings.ts (pass 2, ~140 MB/s): Instance = {id, type, attrs: Value[]}
              │     Value: int | real | str | enum | ref | bin | unset | derived | list | reals | ints | refs | typed
              │     (lists of one kind of number or of references are typed arrays from 16 elements)
              │
              ├─► file.ts: StepFile (header, schemas, data sections, instance(id), sourceBytesAt(p))
              ├─► write.ts: StepDocument → Part 21 byte chunks (verbatim byte copies for subsets)
              ├─► json.ts: raw JSON / NDJSON both ways (numbers by lexical-json)
              ├─► subset.ts: closure(roots), buildSubset (bytes copied, original #ids), danglingRefs
              ├─► bind.ts: StepModel (step-schemas dictionaries): types, isInstanceOf, instancesOf, referrers,
              │            bind(p) → named, typed attributes; optional value checks
              └─► extract/: Reader over the model ─► units, placement (ISO 10303-42), products (tree, placements,
                            representations, instances), styles (effectiveStyle), properties ─► semanticJson
```

Every problem is a diagnostic: lexical tolerances in Layer 1 (lone apostrophes, OCCT's escape leniencies, empty parameters), unknown entities and schema violations in Layer 2 (bound by position), odd placements and units in Layer 3. Nothing fails a whole file but unreadable input.

### The scene model (cad-scene)

```
 Scene (millimetres)
  ├─ roots: Occurrence[] ───────────────► Component (one per product definition)
  │   (component, transform, name)         ├─ parts: PartRef[] (part, transform, material, visible)
  │                                        ├─ children: Occurrence[] ──► Component …  (stored once, placed often)
  │                                        └─ external?, material?, name, sources, properties
  ├─ parts: Part[]   brep:  payload() (a STEP subset), format, rootId     ─┐ each in its own unit, with
  │                  mesh:  levels of detail                               ├ an origin near its geometry,
  │                  curves: polylines                                    ─┘ a material and per-face materials
  ├─ materials (sRGB, opacity), layers (parts, faces), overrides (by occurrence path: material, visibility)
  └─ properties, diagnostics

 instances(scene) / partInstances(scene): the expanded tree; each placed part's world transform, material, per-face
 materials and visibility, resolved top down as the CAx-IF practice has it
```

A part is one shape representation with geometry, the unit of tessellation and caching; a product spanning several representations has several part references. Lengths are millimetres; each part's geometry stays in its own unit and the transforms convert. Meshes (`Mesh`) are `Float32` positions minus the part's origin, chosen from the part's own points so that parts far from their origin keep their precision.

### Tessellation

```
 tessellateScene(scene, tessellator, {linearDeflection, angularDeflection, edges, concurrency, …})
   for each brep part: TessellationRequest {format, data (subset), rootId, origin, deflections in the part's unit}
        │
        ▼
 CachedTessellator (tess-cache)    key: SHA-256 of backend name + version (with the module's hash) + request + payload
        │ miss                     store: memory / directory (Node) / IndexedDB (browser), LRU, max size, 0 = off;
        ▼                          failures and timeouts cached too
 WorkerTessellator (tess-workers)  a pool of worker_threads / Web Workers, one request each; per-request timeout
        │                          terminates a stuck worker; a worker replaced after a trap or above 256 MiB
        ▼
 OcctTessellator (tess-occt) | TruckTessellator (tess-truck)   in each worker; results' buffers transferred
        │
        ▼
 TessellationResult: positions, normals, indices, faces (index ranges with STEP face ids), edges (polylines with ids,
                     kinds shared/seam/free/degenerate, dihedral angles), curves and points (wireframes, with ids)
```

Each layer is itself a `Tessellator`, so they compose, and each can be used alone (a backend on the main thread, a pool without a cache).

**The OCCT backend** (`native/occt_tess.cpp`, C ABI, Emscripten): reads the subset from memory with product mode off (a bare shape representation is a root), sets the system length unit from the root's context so output is in file units, transfers, maps every resulting face back to its `ADVANCED_FACE` through the transfer bindings (faces ShapeFix split included), meshes with `BRepMesh_IncrementalMesh`, subtracts the origin in double precision, and returns faces, edges (each with its polyline on the face triangulation, so edge points are mesh vertices), wireframe curves and points, plus OCCT's printed messages as warnings.

**The truck backend** (`native/src/lib.rs`, plain C ABI, `wasm32-unknown-unknown`): over truck unchanged, it builds the shells itself so every face and edge keeps its STEP id, meshes them, welds truck's per-corner attributes into an indexed mesh, and carries a dozen workarounds for truck's failures on real files (see `CLAUDE.md`). A panic costs only its part: the instance is re-instantiated.

### The exporters

`exportView(scene, meshes, {edges, curves})` computes what every format needs once: **looks** (a part plus the material of each of its faces, so instances that look alike share one mesh), each look's triangles **grouped** by material, and the **instance tree** with each placed part's transform including its mesh's origin. Each exporter then only writes its format, in chunks, so a model's output never has to fit in one string.

## Packages and their APIs

All packages are ES modules with TypeScript types. Matrices are column-major `Float64Array`s (as three.js and glTF).

### `step-parser` (Part 21)

```ts
readBytes(input: Uint8Array | ArrayBuffer | Blob | ReadableStream): Promise<Uint8Array>  // gunzips .stpZ
readStep(input): Promise<StepFile>               // readBytes, then parseStep
parseStep(bytes): StepFile                       // pass 1; .header, .schemaNames, .dataSections, .diagnostics
file.instance(id) / file.instanceAt(p) / file.instances() / file.sourceBytesAt(p)   // pass 2, on demand
writeChunks(doc) / writeStep(doc) / fileDocument(file) / makeHeader({...})          // the Part 21 writer
jsonChunks(doc) / writeJson(doc, {names}) / readJson(bytes)                          // raw JSON
jsonLinesChunks(doc) / writeJsonLines(doc) / readJsonLines(bytes)                    // raw NDJSON
openModel(file, {fallback}): StepModel           // Layer 2: types(p), isInstanceOf(p, e), instancesOf(e),
                                                 // referrers(p), resolve(id), bind(p, {check}) → BoundInstance
extractSemantics(model): {structure, styles, validation, diagnostics}               // Layer 3
productInstances(structure) / productRepresentations(structure, product)
effectiveStyle(reader, styles, item) / semanticJson(model, semantics, opts)
closure(file, roots, exclude?) / buildSubset(file, roots, {exclude, wrapper}) / danglingRefs(file, positions)
```

The raw model (`model.ts`): `Instance` is `{id, type, attrs: Value[]}` or, for a complex instance, `{id, parts: [{type, attrs}]}`; `Value` is one of `int` (number or bigint), `real`, `str`, `enum`, `ref`, `bin`, `unset`, `derived`, `list`, `typed`, and the homogeneous lists `reals`, `ints`, `refs` (canonical: `makeList` picks the kind).

### `step-schemas`

`Schema` dictionaries generated from the EXPRESS long forms in stepcode (AP203 ed1 and ed2, AP214 ed3, AP242), committed as JSON (`dict/*.json`, 1.1 MB, 143 kB gzipped): entities with their attribute slots in Part 21 order (supertypes first, redeclarations and derived attributes applied), types, selects and enumerations. `dictionaryForFileSchema(fileSchemaNames)` picks a dictionary, `loadSchema(id)` loads it as a `Schema`: `instanceAttributes(entity)`, `partialAttributes(entity, members)` (a complex instance's partial), `ancestors`, `subtypes`, `isSubtypeOf(a, b)`, `selectLeaves(t)`, `enumValues(t)`. `npm run gen -w step-schemas` regenerates them from `third_party/stepcode`.

### `lexical-json`

JSON that keeps integers and reals apart by their written form: `parseJson(bytes | string)` returns integers as `bigint` and reals as `number`; `formatReal` (shortest round-trip, always with `.0` or an exponent), `formatInt`, `formatString`, `stringify` (bigints as ints, numbers as reals, typed arrays). Format-agnostic, for raw JSON of other CAD formats later.

### `cad-scene`

```ts
// the model: Scene, Component, Occurrence, PartRef, Part (BrepPart | MeshPart | CurvesPart), Mesh, Material, Layer,
// InstanceOverride, Diagnostic, SourceId; the interface: Tessellator, TessellationRequest, TessellationResult
instances(scene) / partInstances(scene) / validate(scene) / identity() / multiply(a, b) / scaling(s)
tessellateScene(scene, tessellator, {linearDeflection, angularDeflection, edges, parts, concurrency,
                                     orient = true, dropDegenerate = true, onPart}): {meshes, diagnostics}
exportView(scene, meshes, {edges, curves}): {looks, roots}          // for exporters
weld(positions) / manifoldProblems(positions, triangles) / orientShells(mesh) / dropDegenerate(mesh)
TessellationError                                                    // a failure that is the part's, not the host's
```

`tessellateScene` repairs what it can in every mesh, with a diagnostic each time, so every consumer of the scene gets the repaired mesh: triangles with two corners at one position are dropped, and closed shells that are inside out and enclosed by nothing else (so can't be voids) are turned over. `orient: false` and `dropDegenerate: false` keep the backend's meshes as they are.

### `step-import`

`importStep(input): Promise<{scene, model, semantics, partOf}>` (or `sceneFromStep(model, semantics)`; `partOf` maps shape representation ids to part indices): STEP to a scene. Components from product definitions (name, part number, version, description as properties), parts from shape representations with geometry (annotations and 2D drawings are skipped), part references and occurrences with their placements in millimetres, materials from styles (per part when every face agrees, else per face; boundary colours when nothing else colours a face; context-dependent overrides per instance), layers, external references. Generic part names (`NONE`, `#123`, blank) take their product's; blank product names their part number. Parts with references to instances the file doesn't define get a warning naming them.

### `tess-occt`, `tess-truck`

`new OcctTessellator()`, `new TruckTessellator()`: `Tessellator`s. `init()` loads and compiles the module (from the file system in Node, by `fetch` elsewhere; truck also takes `init({wasm})` with bytes or a URL); `info` names the backend, its version (with the module's hash), license and abilities; `memoryBytes()` reports the WebAssembly heap. OCCT returns face and edge ids, edges, curves and points; truck face and edge ids and edges (no curves), and ignores the angular deflection.

### `tess-workers`

`new WorkerTessellator({backend: {module, export, options}, workers, timeoutMs, maxPartsPerWorker, maxMemoryBytes})`: any backend in a pool of workers (`worker_threads` in Node, module Web Workers in browsers, chosen by export conditions). Defaults: cores − 1 workers, 120 s timeout, recycling above 256 MiB.

### `tess-cache`

`new CachedTessellator(inner, store, {retryFailures, keepOtherVersions})` with `new MemoryStore(maxBytes)`, `new FileStore({dir, maxBytes})` (Node) or `new IndexedDbStore({name, maxBytes})` (browsers): results cached per part, a miss costing nothing measurable and a hit about 0.4 ms. A backend's other versions are deleted on first use; failures and timeouts are cached (a timeout answers only under a limit no longer than its own).

### `export-threejs`, `export-gltf`, `export-3mf`

```ts
threejsChunks(scene, view, {doubleSided, edgeKinds, edgeColor, defaultColor}): Generator<string>  // or threejsJson
glb(scene, view, {hidden: 'omit' | 'extension', exclude, unlitLines, doubleSided, …}): Promise<{bytes, diagnostics}>
gltfJson(scene, view, binName | undefined, opts): Promise<{json, bin, diagnostics}>   // undefined: embedded base64
gltfDocument(scene, view, opts)                                    // the glTF-Transform Document, to process further
threemf(scene, view, {colors: 'basematerials' | 'colorgroup', build: 'parts' | 'assembly',
                      nonManifold: 'omit' | 'surface', hidden: 'omit' | 'keep'}): {chunks, diagnostics}
```

Output is deterministic: the same scene gives the same bytes.

### `cli` (`cad-io-cli`)

`step2json(argv, io)` and `stepconv(argv, io)`, the tools as functions over streams (`{stdin, stdout, stderr}`), returning the exit code; `bin/` runs them.

## The test corpus

517 real-world Part 21 files, 421 MB, 4.9 M instances, listed in `test_corpus/files.txt` and fetched by `test_corpus/third_party/pull.sh` (not in the repository):

| Files | Source |
|---|---|
| 438 | the gkv311 OCCT dataset (https://github.com/gkv311/opencascade-dataset): OCCT's test data plus files from public OCCT bug reports, including the CAx-IF and ProSTEP test rallies' models from many CAD systems (`trj*`, `tr8_*`, `tr9_*`) and the bicycle assembly (`Median_cx-fs01_bicycle.stp`, 25 MB, 802 occurrences) |
| 60 | NIST's MBE PMI models (CTC, FTC, STC, D2MI; AP203 and AP242 editions 1–4) |
| 19 | the test files of `occt-import-js` |

By schema: 62 files AP203 ed1, 45 AP203 ed2, 345 AP214, 46 AP242, 19 others (AP209, AP227, …, bound with AP242). They include deliberately broken files (unbalanced quotes, dangling and out-of-range references), files from writers with known quirks, wireframes, surface models, tessellated geometry, voids, external references and files over 50 MB. `test_corpus/subsets/` holds phase 0's per-part subsets of 30 of them (188 parts), made by `corpus_checks/make_subsets.ts`. See [`test_corpus/README.md`](test_corpus/README.md) for versions.

## The tests

- **`npm test`**: the package tests, 193 of them (`node:test`, in each package's `test/`), on small inline fixtures and a few corpus files. Tests that need a built backend or the corpus skip when it's missing; with everything built, they take about 20 s.
- **`npm run typecheck`**: `tsc` over the packages (no output; the sources run as they are).
- **`cargo test`** in `packages/tess-truck/native`: 3 native tests of the truck wrapper (B-spline clamping, the volume sign guard).
- **Browser checks**, run by hand: `node packages/tess-workers/test/browser-check.ts` and `node packages/tess-cache/test/browser-check.ts` serve the sources and run the pool's and IndexedDB's scenarios in headless Chrome.
- **Corpus checks** (`corpus_checks/`, 25 scripts, each with its log committed): every corpus file through each stage, against OCCT (through `occt-import-js`) and against each format's own validator: the writer and raw JSON round trips (0 differences in 4.9 M instances), binding, placements against OCCT's assembly reader, the scene end to end against OCCT (99.1% of sampled vertices on OCCT's surfaces, 97.8% of colours equal), truck against OCCT part by part and face by face, and each exporter read back with three.js's `ObjectLoader`, the Khronos glTF-Validator and lib3mf, and all of it through `stepconv`. They take from seconds to 20 minutes each; see [`corpus_checks/README.md`](corpus_checks/README.md). Timing runs need AC power (macOS's low power mode halves the speed).

Each piece of work so far was also checked by deliberately breaking the code (a few dozen mutations per step) and confirming the tests fail; gaps found that way became tests.

## Roadmap

Done (0.1.0): the parser and writer, schema binding and semantic extraction, `step2json`; the scene model and STEP importer; the OCCT and truck backends with workers and caching; the three.js, glTF and 3MF exporters and `stepconv`.

Next, roughly in order:

1. **Publishing to npm:** emit JavaScript (`rewriteRelativeImportExtensions` is already on), package names and scope, per-package READMEs and licenses, the prebuilt WebAssembly modules in their packages.
2. **A browser viewer:** the assembly tree and an interactive 3D view on the same packages (parsing in the page, tessellation in Web Workers, the IndexedDB cache), with picking by face id.
3. **Large files in the browser:** reading instance bytes on demand instead of holding the file, 64-bit offsets.
4. **More of STEP:** PMI (semantic and graphical), AP242 tessellated geometry as meshes, user-defined attributes, materials, SHUO, per-curve colours, named coordinate systems.
5. **More formats** (the scene and tessellator interface were designed for them), by value to a viewer:
   - **JT** (ISO 14306; Siemens Teamcenter): a pure-TypeScript importer of its meshes (levels of detail, so no tessellation needed), scene graph and properties; v9 and v10 compression both needed; specifications in `third_party/jt/`, free to implement against (the terms are summarized in `CLAUDE.md`);
   - **IGES**: a small parser plus the OCCT backend (`format: 'iges'`, subsets with renumbered pointers);
   - **OCCT BREP** (`.brep`), OCCT documents (`.xbf`) and **FreeCAD** (`.FCStd`, whose `.brp` shapes OCCT reads);
   - exporting STEP (the writer exists) and JT.

Not planned for now: AP242 XML (`.stpx`); monstertruck (evaluated in phase 0, no clear improvement over truck).

## Backlog

Known work not yet scheduled; the detail behind each is in `CLAUDE.md`.

**Parser and extraction**

- PMI, semantic and graphical (`rec_pracs_pmi_v41.pdf` in `third_party/mbx-if-recpractices/`); 2D drawings (`GEOMETRICALLY_BOUNDED_2D_WIREFRAME`, skipped today) go with it.
- User-defined attributes; materials and densities; SHUO; kinematics.
- AP242 tessellated geometry as scene meshes (OCCT meshes it today as brep parts).
- Per-instance style resolution beyond what the importer does; per-curve colours in mixed parts.
- Named coordinate systems: placements among a representation's items that nothing uses (shown, not applied).
- Part 21 edition 3 constant references and anchors (sections skipped with a warning today; no corpus file has any).
- Files over 4 GiB (64-bit offsets); on-demand range reading; streaming raw conversion.
- More dictionaries (AP209, AP214 ed1); WHERE rules and complex-instance validity not checked.

**Tessellation**

- A deflection relative to each part's size (absolute 0.1 mm gives a 32 m torus 3.9 M triangles).
- OCCT: ShapeFix's split of a face whose hole touches its seam (bicycle #23723, left as is); Delabella for faces with thousands of holes (6× faster on `bug24024_slow_import.stp`); size cuts (CJK code-page tables, writer code).
- truck: wireframe curves (`TRIMMED_CURVE`, `COMPOSITE_CURVE`); geometric sets' surfaces; cones, surfaces of revolution and rational B-splines it meshes badly (no workaround short of patching truck).

**Export**

- Draco or meshopt compression and `EXT_mesh_gpu_instancing` for glTF; the 3MF Production extension.
- Exporting STL and OBJ (the mesh helpers are there).

**Open questions**

- Which AP242 edition stepcode's schema is (later than edition 1; it binds files of editions 1–4 alike).
- The ISO EXPRESS schemas' redistribution terms, for the generated dictionaries (names and structure only).
- JT's "combining formats" clause, as it applies to converting JT to glTF or 3MF.

## License

Apache-2.0 ([`LICENSE.txt`](LICENSE.txt)), except `packages/tess-occt`, which is LGPL-2.1 with the Open CASCADE exception, as OCCT is ([`packages/tess-occt/LICENSE.txt`](packages/tess-occt/LICENSE.txt)). The other code we build against keeps its own license: OCCT LGPL-2.1, stepcode BSD-3-Clause, truck Apache-2.0, glTF-Transform and fflate MIT. The code here is written independently, using OCCT as a reference and test oracle only, not translated from it.
