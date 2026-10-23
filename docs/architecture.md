# cad-io-js: architecture

*Paths in this document are relative to this `docs/` directory.*

Status: draft, 2026-10-16. Phase 0 is done (`phase0/phase0_results.md`). Phase 1 is under way; progress is in `phase1_progress.md`. The schema generator (`../packages/step-schemas`), Layer 1 (`../packages/step-parser`: parser and writer), the raw JSON form (`../packages/lexical-json`), Layer 2 schema binding, the Layer 3 extractors and the `step2json` CLI are done: phase 1 is complete. Phases 2 and 3 are complete (`phase2_progress.md`, `phase3_progress.md`); phase 4's plan is in `phase4_progress.md`. See `initial_analysis.md` for background research, reference repositories and licensing analysis.

## Goals

- A pure TypeScript/JavaScript STEP parser for AP242, AP203 and AP214. It runs in both browsers and Node.js and has no runtime dependencies.
- A pluggable tessellation backend interface, with two implementations: OCCT (WASM) and truck (WASM).
- CLI tools for Node.js:
  - `step2json`: STEP → JSON with as much of the source data represented as possible.
  - `stepconv`: STEP → tessellated output in three.js JSON, glTF/GLB or 3MF.
- Later: a browser-based CAD viewer with a hierarchy tree and interactive geometry view, built on the same pieces.

## Decisions

| Topic | Decision |
|---|---|
| Language | TypeScript, compiled to plain ESM JavaScript |
| Platforms | Browser and Node.js from day one |
| License | Apache-2.0 for every package except the OCCT backend, which keeps OCCT's LGPL-2.1 isolated |
| AP242 XML (`.stpx`) | Out of scope for now |

## Package layout

This is a monorepo using npm workspaces (`../packages/*`). TypeScript runs directly on Node 24 via type stripping; see `phase1_progress.md`, "Repo setup".

| Package | Purpose | Runtime dependencies | License |
|---|---|---|---|
| `step-parser` | Part 21 parsing, schema binding, semantic extraction, and the Part 21 writer | None | Apache-2.0 |
| `lexical-json` | JSON that keeps integers and reals apart by lexical form (`5` vs. `5.0`); used by raw JSON, and meant for other formats' raw JSON too | None | Apache-2.0 |
| `step-schemas` | Schema dictionaries for AP203, AP214 and AP242, generated from EXPRESS | None | Apache-2.0 (to verify: ISO EXPRESS redistribution terms) |
| `cad-scene` | The intermediate scene model and the tessellator interface definition | None | Apache-2.0 |
| `tess-occt` | OCCT WASM tessellation backend | OCCT WASM | LGPL-2.1 (isolated here) |
| `tess-truck` | truck WASM tessellation backend | truck WASM | Apache-2.0 |
| `tess-workers` | Runs any backend in a pool of workers (`worker_threads` in Node, Web Workers in browsers), with a per-request timeout and instance recycling (phase 3, step 1) | None | Apache-2.0 |
| `tess-cache` | Caches any backend's results per part, failures included, keyed by payload, backend version and options: in memory, in a directory (Node) or in IndexedDB (browsers), each with a maximum size, 0 disabling it; a backend's other versions deleted (phase 3, step 4) | None | Apache-2.0 |
| `export-threejs` | Scene model → three.js JSON Object Scene format 4 | None | Apache-2.0 |
| `export-gltf` | Scene model → glTF/GLB | glTF-Transform (MIT) | Apache-2.0 |
| `export-3mf` | Scene model → 3MF | fflate (MIT) | Apache-2.0 |
| `cli` (npm name `cad-io-cli`) | `step2json` (done, phase 1 step 7) and `stepconv` | All of the above | Apache-2.0 |

## Stage 1: the parser

### Layer 1: Part 21 lexer, parser and writer (schema-agnostic)

- **Input:** works on raw bytes (`Uint8Array`), not one giant string, so large files work.
- **Two passes:**
  1. A fast first pass builds an index from each entity ID to its byte range.
  2. Individual entities are decoded lazily on demand. This enables showing the assembly tree instantly and loading geometry later.
- **Value types**, preserved exactly:
  - integer vs. real
  - enumeration (`.T.`), reference (`#12`), unset (`$`), derived (`*`)
  - string and binary
  - typed parameters such as `LENGTH_MEASURE(5.)`
  - nested lists
  - complex instances such as `(A() B() C())`
- **String decoding:** Part 21 escapes (`\X2\…\X0\`, `\X4\…\X0\`, `\X\hh`, `\S\`, `\P\`) are decoded to Unicode.
- **Other inputs:** gzip-compressed `.stpZ`, via `DecompressionStream`.
- **Editions:** targets Part 21 edition 2, and tolerates edition 3 features (anchor and reference sections, multiple data sections) without failing.
- **Writer:** serializes the instance model back to Part 21. It is used both for round-trip testing and for building the per-part subset files sent to tessellators. See "Part 21 writer" below.
- **Status:** done (`../packages/step-parser`), including the writer. Pass 1 scans at about 230 MB/s into a typed-array index (ids, byte ranges, type names, references); pass 2 decodes at about 140 MB/s. The lexical tolerances it adopted (lone apostrophes, OCCT's escape leniencies, empty parameters and out-of-range references read as `$`) are listed in `phase1_progress.md`, step 2. The writer round-trips the whole corpus (4.9 M instances) with no differences; see step 3. So does raw JSON (A ≡ B ≡ C); see step 4.

### The raw instance model

Layer 1 produces, and the writer consumes, this model:

```ts
type Value =
  | { k: 'int';     v: number | bigint }
  | { k: 'real';    v: number }
  | { k: 'str';     v: string }          // decoded Unicode
  | { k: 'enum';    v: string }          // includes booleans/logicals: T, F, U
  | { k: 'ref';     v: number }          // #12
  | { k: 'bin';     v: string }          // hex digits, first digit = unused-bit count
  | { k: 'unset' } | { k: 'derived' }    // $  *
  | { k: 'list';    v: Value[] }             // anything not covered by the next three, including ()
  | { k: 'reals';   v: number[] | Float64Array }               // non-empty, reals only
  | { k: 'ints';    v: number[] | Int32Array | Float64Array }  // non-empty, ints only, no bigint
  | { k: 'refs';    v: number[] | Uint32Array }                // non-empty, references only
  | { k: 'typed';   type: string; v: Value };   // LENGTH_MEASURE(5.)

type Instance =
  | { id: number; type: string; attrs: Value[] }                    // simple
  | { id: number; parts: { type: string; attrs: Value[] }[] };      // complex
```

- **Homogeneous lists** (added in phase 1 step 4): a list of only reals, only ints or only references has its own kind, so its elements are bare numbers instead of one object each. The kind is canonical (`makeList`), so equal data gives deeply equal models. Lists of 16 or more elements are stored in typed arrays, shorter ones in plain arrays. This cut the memory of fully decoded files by a third, at the same decoding speed. Reals stay doubles, since the model is lossless; `Float32Array` vertex attributes belong to the scene model (see "The intermediate scene model").
- **Positional attributes:** attributes are stored in file order, not by name. Names come from schema binding (Layer 2) and are an annotation only. This keeps Layer 1 and the writer schema-independent, and lets unknown entities round-trip.
- **File order:** the model records the original instance order, and the writer preserves it.
- **Edition 3 extensions:** Part 21 edition 3 adds constant references and anchors. Their representation is still to be decided.

### Part 21 writer

A recursive serializer over the raw instance model. It doesn't use the schema. Expected size is around 150–200 lines of TypeScript.

**Status:** done (`../packages/step-parser/src/write.ts`). The API is a generator of byte chunks over a `StepDocument` (`{header, data: [{name?, schemas?, instances}]}`), with instances pulled lazily and `Uint8Array` items copied verbatim for the subset fast path. Differences from the sketch below: characters beyond the BMP form `\X4\` runs within the same string as `\X2\` runs; exponents are written without `+`; `-0` is written `-0.`; unrepresentable values throw a `WriteError` instead of producing a diagnostic. Details in `phase1_progress.md`, step 3.

**File structure:**

```
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(...); FILE_NAME(...); FILE_SCHEMA(...);   // same value syntax, no #id=
ENDSEC;
DATA;
#12=TYPE(...);              // simple instance
#13=(A(...)B(...));         // complex instance
ENDSEC;
END-ISO-10303-21;
```

**Value serialization:**

```ts
function writeValue(v: Value): string {
  switch (v.k) {
    case 'int':     return v.v.toString();
    case 'real':    return writeReal(v.v);
    case 'str':     return writeString(v.v);
    case 'enum':    return `.${v.v}.`;
    case 'ref':     return `#${v.v}`;
    case 'bin':     return `"${v.v}"`;
    case 'unset':   return '$';
    case 'derived': return '*';
    case 'list':    return `(${v.v.map(writeValue).join(',')})`;
    case 'typed':   return `${v.type}(${writeValue(v.v)})`;
  }
}
```

- **Reals (`writeReal`):** Part 21 requires a decimal point, as in `5.` or `1.E-07`. `String(x)` gives the shortest text that parses back to exactly the same double, but its format doesn't always match Part 21. So `writeReal` splits off the exponent, adds `.` to the mantissa if it has none, and uppercases `E`:
  - `5` → `5.`
  - `1e-7` → `1.E-7`
  - `0.25` → `0.25`

  NaN and Infinity can't be represented in Part 21 and produce a diagnostic.
- **Strings (`writeString`):**
  - Wrap in single quotes, and double any embedded `'` and `\`.
  - Printable ASCII (0x20–0x7E) is written as-is.
  - Runs of other characters are written as `\X2\` plus four uppercase hex digits per character, closed with `\X0\`. Characters outside the Basic Multilingual Plane use `\X4\` with eight hex digits.
- **Output:** the escaping makes the whole output pure ASCII, so it's written in chunks as bytes to a stream (a `WritableStream` in browsers, a Node stream in the CLI) and never built as one giant string.
- **Line wrapping:** one instance per line. Optional wrapping of long lines for readability.

### Layer 2: schema binding

**Status:** done (`../packages/step-parser/src/bind.ts`; details, corpus results and tests in `phase1_progress.md`, step 5). `openModel(file)` picks the dictionary from FILE_SCHEMA, with AP242 as the fallback for other schemas' entities and for files with no known schema. A `StepModel` answers type queries through subtypes and complex instances, and keeps a reverse-reference index in typed arrays. `bind(p)` gives each attribute its name and declared type under the tolerance policy below, with optional checks of every value against its type. 99.56% of the corpus's 4.93 M instances bind with names; the rest are entities no shipped dictionary defines, mostly from AP209 and AP227 files, and a few from other editions.

- **Generated dictionary:** each schema's dictionary supplies attribute names, the supertype/subtype hierarchy, select and enumeration definitions, and the attribute order within complex instances.
- **Reverse-reference index:** a generic index answers questions like "which NAUOs reference this product definition?".
- **Schema identification:** `FILE_SCHEMA` is mapped to the right dictionary. Examples:
  - `CONFIG_CONTROL_DESIGN` → AP203 edition 1
  - `AP203_CONFIGURATION_CONTROLLED_3D_DESIGN_OF_MECHANICAL_PARTS_AND_ASSEMBLIES_MIM_LF` → AP203 edition 2
  - `AUTOMOTIVE_DESIGN` → AP214
  - `AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF` → AP242, with an edition object identifier
- **Tolerance policy:** never fail the whole file over an unknown entity or a schema violation. Keep the entity as untyped raw data and record a diagnostic. The phase 1 corpus check (`phase1_progress.md`) showed what this has to absorb:
  - **Unknown entities:** files use entities from other schemas or editions. Fall back to the AP242 dictionary before giving up; that resolved 33 of the 47 unknown names in the corpus.
  - **Derived slots:** accept a value where the schema says derived (`CONVERSION_BASED_UNIT` in AP214, `CHARACTERIZED_REPRESENTATION` in AP242), and `*` where it doesn't (`NAMED_UNIT(*)` next to `CONVERSION_BASED_UNIT`).
  - **Attribute counts** that match another edition or a broken writer: keep the instance positional, without names.
  - **Complex instances** whose partials aren't in alphabetical order.
  - **Value checks** (step 5): SELECT values without their type name, or doubly typed (10.8 k in the corpus, mostly `TRIMMED_CURVE` trims); reals in INTEGER slots (1.4 k); `$` in mandatory attributes (7.8 k, an `info`); references to the wrong entity type and dangling references. All bind by position, with a diagnostic.

### Layer 3: semantic extractors

**Status:** done for the items below (`../packages/step-parser/src/extract/`; details, the corpus checks against OCCT and the open decisions in `phase1_progress.md`, step 6). `extractSemantics(model)` gives the product structure (products, occurrences with placement matrices including unit conversion, roots, shape representations and their relations), styles and layers, and validation properties in SI units. Placements were checked against OCCT's assembly reader on the corpus: every B-rep vertex of every instance lands on OCCT's mesh in 495 of 512 files, and the rest are explained (three deliberate differences from OCCT, recorded with the evidence, plus broken files). Not yet extracted: PMI, user-defined attributes, materials, SHUO, AP242 tessellated geometry as meshes; per-instance style resolution waits for the scene model.

- the product and assembly tree (NAUO, `CONTEXT_DEPENDENT_SHAPE_REPRESENTATION`, `REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION`, `MAPPED_ITEM`), with transforms and instancing
- units per representation context
- names and product metadata
- colors and styles (`STYLED_ITEM`, presentation layers)
- the validation properties stored in the file (volume, area, centroid)
- the shape representations each product uses, ready for tessellation

### Schema generator (build time)

Done: `../packages/step-schemas`. Details, the dictionary format and the corpus check are in `phase1_progress.md`.

A build-time generator, written in TypeScript, converts EXPRESS into JSON dictionaries.
- **Scope:** it only needs EXPRESS declarations (entities, types, selects, enumerations, supertypes, attributes, inverse attributes) and skips rules, functions and `WHERE` clauses.
- **Output:** committed to the repo, so the library itself has no build-time dependency.
- **References:** stepcode's EXPRESS parser and ruststep's `espr`.
- **Inputs:** `stepcode/data/ap203`, `ap203e2`, `ap214e3`, `ap242`.
- **AP242 edition:** stepcode's schema is WG12 N11521, later than edition 1; whether it is edition 2 or 3 is unconfirmed. It bound corpus files labelled editions 1 to 4 with 14 mismatches in 675k instances.

### `step2json` output

- **Raw mode:** a lossless dump of the header plus every instance of the raw instance model.
  - **Value types:** must be explicit, because JSON can't distinguish integer `5` from real `5.`, or a string from an enumeration.
  - **Positional attributes:** stored as arrays, in file order. When the schema is known, attribute names are added as an annotation, but loading never depends on them. Loading the JSON back into the model therefore needs no schema, and unknown entities round-trip.
  - **Encoding** (done in phase 1 step 4, `../packages/step-parser/src/json.ts`; format and measurements in `phase1_progress.md`, step 4): clarity and extensibility come before size, because raw JSON is for testing, debugging and validation, not production. Numbers are **lexical**: an int is written `5`, a real always `5.0` or `1e-7`, read by our own parser (`../packages/lexical-json`), since `JSON.parse` merges the two. Strings are JSON strings, lists arrays, `$` is `null`, and the other kinds are one-key objects: `{"ref":12}`, `{"refs":[1,2]}`, `{"enum":"T"}`, `{"derived":true}`, `{"bin":"0F"}`, `{"type":"LENGTH_MEASURE","value":5.0}`. The document names its format, version and source format (`{"format":"cad-io-js raw","version":1,"source":"step",…}`), so IGES or JT raw JSON can follow. Instances are objects (`{"id":1,"type":"…","attrs":[…]}`), one per line. Typing numbers by schema context instead was considered and rejected for raw mode: context decides only 98.6% of the corpus's numbers, and the loader would need the schema.
  - **Completeness:** enough to reconstruct the raw instance model exactly (see "Testing").
- **Semantic mode** (done, phase 1 step 7): the product tree, units, styles, validation properties and diagnostics, as **standard JSON** with plain numbers (`semanticJson` in `../packages/step-parser/src/extract/json.ts`). The format fixes what each field is, so the integer/real question of raw mode doesn't arise, and any JSON tool can read it.
- **Streaming output:** required, because a large STEP file can produce JSON that exceeds V8's maximum string length. Raw output is written in byte chunks with backpressure. Semantic output is small (1.5 MB for the largest corpus file) and is written in one piece.
- **NDJSON option** (done): one JSON value per line: an envelope with the header, a `{"data":…}` line opening each DATA section, then one line per instance; `readJsonLines` reads it a line at a time.
- **The tool:** `step2json [options] <file.stp | file.stpZ | ->` in `../packages/cli`; details in `phase1_progress.md`, step 7.

## Stage 2: the scene model and the tessellator interface

### The intermediate scene model (`cad-scene`)

**Status:** done in phase 2 (`../packages/cad-scene`, with the STEP importer `../packages/step-import` and the OCCT backend `../packages/tess-occt` brought forward from stage 3). Design decisions, deviations from this sketch (components and occurrences instead of a stored tree; millimetres) and the end-to-end checks against OCCT are in `phase2_progress.md`.

All exporters, and later the viewer, consume one scene model instead of reaching back into the parser and backend:

- **Nodes:** a tree of occurrences (product occurrences for STEP), each with a local transform, a name, a property map and source IDs. Flat files are just a single-level tree.
- **Parts:** each part is defined once and referenced by every occurrence (instancing). A part's geometry is one of these source types:
  - `brep`: exact geometry, tessellated lazily by a backend. It carries the format (`'step' | 'iges' | 'brep'`), the per-part payload and the root ID. Used for STEP, IGES, BREP, `.xbf` and `.FCStd`.
  - `mesh`: already tessellated in the source file. Vertex positions, normals and colours are always `Float32Array`, as glTF/GLB/3MF need them, after recentering on a part-local origin carried by the node transform. Backends deliver tessellations of `brep` parts the same way. It supports multiple levels of detail. Used for future JT import, and potentially STL, OBJ and glTF input.
  - `curves`: wireframe or edge-only geometry already discretized in the source. STEP wireframes are `brep` parts instead, whose tessellations carry curves and points beside any triangles (`phase3_progress.md`, step 6).
- **Source IDs:** `{format, id}` pairs, used on nodes, parts and faces. Picking and face highlighting then work the same way whatever the source format.
- **Materials:** derived from source colors, per part or per face.
- **Instances and styles:** Layer 3 provides the instance walk (`productInstances`: path and transform per use of a product) and styles as stated in the file; resolving a face's appearance per instance (context-dependent overrides, assembly-level styles) happens here, where instance paths exist.
- **Layers:** an optional grouping independent of the tree (STEP presentation layers, IGES levels, OCCT/XCAF layers).
- **External references:** a node can reference an external file or a lazily loaded subtree (STEP external references; future JT shattered assemblies).
- **Units:** normalized to a single unit for the whole scene. STEP can use different units in different parts.
- **Metadata:** a generic property map on nodes and parts, filled in by each importer, with no format-specific fields built into the model. It is carried through to the exporters.

### The tessellator interface

The interface is **per part**: each request carries one part's geometry (one node of the assembly hierarchy), and the response is that part's mesh. The backends parse the payload themselves, and the `format` field says what kind of payload it is:

- **`step`:** a Part 21 subset extracted by the JS side, as described below.
- **`iges`** (future, OCCT only): an IGES subset extracted by the JS side. IGES entities point to each other by line number, so the subset's pointers must be renumbered.
- **`brep`** (future, OCCT only): a single OCCT BREP shape, which is already one part. It comes from bare `.brep` files, from `.brp` files inside `.FCStd` archives, or from shapes an OCCT importer extracts from `.xbf` documents.

For STEP, the interface uses **per-part subsets**:

- **Subset construction:** the JS side computes the closure of one shape representation, meaning every entity it transitively references, including units and context. It keeps the original `#` IDs and emits a small, valid Part 21 file.
  - **Synthetic product wrapper (optional):** for backends that need a product structure, such as `occt-import-js`, the JS side can append 8 entities (`APPLICATION_CONTEXT` … `SHAPE_DEFINITION_REPRESENTATION(#pds, #root)`) with fresh IDs above the file's maximum. The custom OCCT backend reads bare subsets with `read.step.product.mode` OFF (phase 0: 188/188 parts, identical output to wrapped), and truck reads them as-is. See `phase0/phase0_results.md`.
  - **Fast path:** copy each entity's original byte range from the source file instead of re-serializing it.
- **Benefits:**
  - **Correlation by construction:** each result belongs to a known representation.
  - **Lazy tessellation:** only tessellate parts that are visible.
  - **Instancing:** each part is tessellated once, and the JS side places every occurrence.
  - **Parallelism:** web workers or `worker_threads` can tessellate different parts at once.
  - **Caching:** results can be stored per part.
- **The JS side owns** colors, transforms, units and instancing, so the backends stay small and interchangeable.

```ts
interface Tessellator {
  readonly info: { name: string; version: string; license: string;
                   formats: ('step' | 'iges' | 'brep')[];
                   supportsFaceIds: boolean; supportsEdges: boolean; supportsCurves: boolean };
  init(opts?: TessellatorInitOptions): Promise<void>;   // load/compile WASM
  tessellate(req: {
    format: 'step' | 'iges' | 'brep';
    data: Uint8Array;            // one part's payload; STEP subsets keep original #ids
    rootId?: number;             // root entity within the payload (STEP: shape representation; unused for brep)
    linearDeflection: number;    // in file units
    angularDeflection: number;   // radians
    edges?: boolean;
  }): Promise<{
    positions: Float32Array;
    normals?: Float32Array;
    indices: Uint32Array;
    // index ranges per source face (STEP: ADVANCED_FACE); ranges partition `indices`. An entityId may repeat
    // (backends can split one source face, e.g. OCCT ShapeFix), and is null for ranges with no known source.
    faces: { entityId: number | null; start: number; count: number }[];
    // B-rep edges (STEP: EDGE_CURVE) as polylines, when requested. Points coincide exactly with mesh vertices.
    edgePositions?: Float32Array;  // all polylines concatenated
    edges?: { entityId: number | null;   // null for backend-made edges (OCCT seams, pole edges); may repeat if split
              start: number; count: number;   // in points, into edgePositions
              kind: 'shared' | 'seam' | 'free' | 'degenerate';
              dihedral?: number }[];          // max angle (rad) between the two faces' normals along the edge; shared only
    // Wireframe curves (STEP: a geometric set's or wireframe model's curves, not faces' edges) and isolated points,
    // whenever the part has them, with or without `edges`.
    curvePositions?: Float32Array;   // all polylines concatenated
    curves?: { entityId: number | null; start: number; count: number }[];   // the set's element; may repeat if split
    points?: Float32Array;
    pointIds?: (number | null)[];
    diagnostics: Diagnostic[];
  }>;
  dispose(): void;
}
```

- **Edges:** backends return every edge of the final shape, `seam` and `degenerate` ones included, and never filter. Filtering is the renderer's choice. Typical choices:
  - draw `shared` and `free` edges
  - hide `seam` edges and `degenerate` ones (a degenerate edge is a point, e.g. at a sphere pole)
  - use `dihedral` to hide or soften tangent edges; phase 0 found the values bimodal (most under 1° or over 30°)

- **Typed arrays** can be transferred between workers without copying, and map directly onto three.js `BufferGeometry` and glTF buffers.
- **Face entity IDs** enable per-face colors (STEP often styles individual faces), picking and highlighting.
- **Importers:** a second plugin type, distinct from tessellators. An importer turns a file into a scene model, and its `brep` parts carry per-part payloads ready for a tessellator. The STEP parser is the first importer. Future importers are listed under "Future input formats".

## Stage 3: the backends

- **OCCT:**
  - **Prototype:** `occt-import-js` accepts only wrapped subsets and doesn't report face entity IDs.
  - **Real backend:** our own Emscripten build of OCCT 8.1, prototyped in phase 0 (the spike's `occt_tess/`, at tag `V0.1.0`), now `../packages/tess-occt`.
    - It reads bare subsets (product mode OFF) and outputs file units.
    - It maps faces to STEP entities through the transfer bindings, including split faces.
    - It returns flat typed arrays.
    - It must be built with `-UOCC_CONVERT_SIGNALS` (see `phase0/phase0_results.md`).
    - Build with `-Os`; `-O2`/`-O3`/LTO buy no speed. An optional header overlay that computes OCCT's `VBernstein` table instead of storing it cuts the download from 2.18 to 1.71 MB brotli. The user decided (2026-10-17, `phase3_progress.md` decision 6) to ship `-Os` without that patch, which isn't worth maintaining for now (see "Build variants" in `phase0/phase0_results.md`; the overlay is in `../packages/tess-occt/occt_overlay/`).
- **truck:** needs a small Rust wrapper (not a fork) to report face IDs; phase 0 has a working prototype. It is about 1/6 the size of OCCT, but less robust: it panics, hangs and produces wrong or empty faces on some real files, so the host needs a watchdog. The monstertruck fork was also evaluated in phase 0; it fixes some of these cases, regresses others and is not a clear improvement.
- **Order:** OCCT first, as the more robust reference, then truck, tested against OCCT.

## Stage 4: `stepconv` and the exporters

| | (a) three.js JSON | (b) glTF/GLB | (c) 3MF |
|---|---|---|---|
| Form | three.js "JSON Object Scene format 4", so the file loads directly with `THREE.ObjectLoader` | Standard glTF 2.0, with meshes reused across nodes for instancing | 3MF core spec, plus the materials extension for color |
| Hierarchy | `Object3D` tree, with STEP metadata in `userData` | Node tree, with metadata in `extras` | Nested component objects; build items reference the top-level assembly (see notes below) |
| Units and axes | Keep file units, reported in metadata | Meters and Y-up are mandatory, so add a root conversion from STEP's typical mm and Z-up | `unit` attribute set to match the source (default millimeter) |
| Notes | Format 4 uses plain number arrays, so files are large | Optional later: Draco or meshopt compression, `EXT_mesh_gpu_instancing` | Requires watertight, manifold meshes, so per-face vertices must be welded into closed solids |
| Library | None | glTF-Transform (MIT) | fflate (MIT) |

**3MF hierarchy notes:**

- **Nesting:** a 3MF object contains *either* a mesh *or* components. A component references another object with a transform, and that object may itself contain components, so multi-level assemblies with instancing map directly.
- **Node splitting:** an assembly node that has both its own geometry and children must be split into a mesh object plus a component object.
- **Metadata:** limited to object names, part numbers and metadata groups. Check whether the Production extension is worth using for stable UUIDs.
- **Downstream flattening:** many slicers flatten the hierarchy on import, but that's their choice, not a limitation of the format.

## Future input formats

None of these is planned for the initial stages. The scene model and tessellator interface above are designed so they can be added later without a redesign.

| Format | Value | Importer | Tessellation | Notes |
|---|---|---|---|---|
| **IGES** | Moderate: legacy supply chains, CAM, archives | Pure JS. Simpler than STEP: fixed 80-column ASCII, numbered entity types, no schema layer. | OCCT backend (`format: 'iges'`), with per-part subsets whose pointers are renumbered | Much IGES is a "surface soup" of trimmed surfaces (type 144) without topology, so sewing and healing are needed. OCCT has these (`TKDEIGES`, including `IGESCAFControl` for names, colors and layers); truck has no IGES support. Hierarchy is weak: subfigures (308/408) and levels. |
| **BREP** (`.brep`) | Low on its own | Trivial: the file is a single part | OCCT backend (`format: 'brep'`) | OCCT's native shape serialization: exact geometry, topology and optional triangulations, but no assembly, names, colors or units. Specification: `OCCT/dox/specification/brep_format.md`. |
| **OCCT documents** (`.xbf`) | Moderate, for users of OCCT-based tools | An OCCT WASM importer, since the binary document format is realistically readable only by OCCT | OCCT backend, with each part's shape extracted as a `brep` payload | Adds assembly structure, names, colors and layers on top of BREP shapes. |
| **FreeCAD** (`.FCStd`) | High, since FreeCAD is the most widely used open-source CAD tool | Pure JS: unzip, parse `Document.xml` (object tree, placements) and `GuiDocument.xml` (colors) | OCCT backend, sending each embedded `.brp` file as a `brep` payload | The hard part is semantic. Documents contain every intermediate modeling feature, not just final parts, and FreeCAD versions and assembly workbenches represent assemblies differently. Determining which objects are the visible final shapes, and how they nest, is the main work. |
| **JT** (ISO 14306) | High for automotive and aerospace visualization (Siemens Teamcenter) | Pure JS: binary segments with zlib or LZMA compression, compressed mesh encodings, logical scene graph, properties. A large project. | **Usually not needed:** JT files normally contain tessellated meshes at several levels of detail, so parts use the `mesh` source type. | Open-source OCCT has no JT reader, and Siemens' JT Open Toolkit is a licensed SDK. "Shattered" assemblies reference separate JT files, so external references are needed. See "JT notes" below for the specification, exact geometry and license terms. |

### JT notes

**Specifications in hand** (in this directory, each with a `.txt` text extraction of the same name):

| Document | Date | Pages | Source |
|---|---|---|---|
| `Siemens JT V10.6 Format Description Rev D 10 Feb 2026.pdf`, plus `PMIPropertiesStrings_alphabetic_list-JT_V10_6.xlsx` (PMI property strings) | 2026-02-10 | 493 | Official, free, no registration: Siemens JT Open Program page, https://www.siemens.com/en-us/products/plm-components/jt/jt-open-program/ (zip: https://static.sw.cdn.siemens.com/media/published/4Zc4NsBnmaFlEd0mtssp7f/siemens-jt-v-10-6-file-format-reference-rev-d-10-feb-2026.zip) |
| `JT-v10-file-format-reference-rev-B_tcm1023-233786.pdf` | 2015 | 523 | Official: https://www.plm.automation.siemens.com/en_us/Images/JT-v10-file-format-reference-rev-B_tcm1023-233786.pdf |
| `JT_v95_File_Format_Reference_Rev-A_tcm73-111987.pdf` | 2010 | 452 | Third-party copy; there is no current official download: https://ww3.cad.de/foren/ubb/uploads/Rainer+Schulze/JT_v95_File_Format_Reference_Rev-A_tcm73-111987.pdf |

**v10.6 is the primary reference.** It is the current JT version, kept up to date (Rev-D, February 2026). It covers:

- **Core file structure:** the file header, table of contents and data segments, plus the logical scene graph (assemblies, instances, partitions, properties, attributes).
- **Tessellated meshes:** shape levels of detail, including the TopoMesh topologically compressed meshes, plus per-face group attributes (Annex E).
- **Every compression scheme:** Int32/Int64 compressed data packets, quantizers, the bit-length and arithmetic codecs, Deering normal compression and LZMA, with reference decoder code (Annex B), hashing (Annex C) and the mesh topology decoder (Annex D).
- **Exact geometry:**
  - the XT B-rep format (Annex F), including hybrid XT B-rep/facet bodies added in 10.6
  - the ULP (Annex G), Smart Topology Table (Annex H) and LWPA (Annex I) segments
  - wireframe (Annex J)
- **Procedural geometry evaluation** (Annex M): guidance on evaluating and approximating XT's procedural geometry (intersection curves, blends), which is the hardest part of exact-geometry support.
- **Deprecated content:** the old JT B-Rep segment (Annex K) and PMI data segment (Annex L), still documented for reading older files.

**Gaps:**

- **STEP B-rep segment:** segment type 33 is listed but "not defined in this document". It is presumably specified in ISO 14306, which is paywalled.
- **v8.x files:** no specification is available. v9.5 describes itself as "a completely new, standalone document" relative to v8.1. v10.6 still documents the deprecated v8-era PMI Data Segment, which v8 files migrated to v10.6 may carry. Native v8.x files are probably rare enough to leave unsupported.
- **Real-world use:** sample files from current writers would show which features matter in practice.

**Version coverage: v9.x and v10.x use different compression.** Reading the v9.5 reference turned up one real surprise. The scene graph, mesh topology coder and overall file structure are recognizably the same across versions, but the compression layer was replaced between v9 and v10:

| | v9.5 | v10.0 / v10.6 |
|---|---|---|
| Compressed data packets | Int32 CDP (first generation), Int32 CDP Mk. 2, Float64 CDP | A third-generation Int32 CDP, which "supersedes the two similarly-named ones from the Version 9 JT Specification", plus a new Int64 CDP |
| General compression applied to segment data | ZLIB (v1.1.2) | LZMA |
| XT B-rep documentation | A 2-page segment description only, with no XT schema | Full XT schema (v10.6 Annex F), plus procedural geometry guidance (Annex M) |
| Other | Wire harness support (dropped in v10) | ULP, STT and LWPA segments, hybrid XT bodies (10.6), STEP B-rep segment ID (undefined in the document) |

**Consequences for a JT importer:**

- **Both codec families are needed.** Supporting v9.x files, which remain common since ISO 14306:2012 is v9.5, requires implementing the v9 decoders as well as the v10 ones. So the v9.5 reference is a required source, not an optional supplement.
- **The rest can be shared.** The LSG node and attribute model, the TopoMesh mesh coder and the arithmetic and bit-length codecs are close enough to share most code, with version checks at the element level.
- **The license is identical** in v9.5, v10.0 and v10.6, and the patent notice explicitly covers "version 9.5 and later".

**Recommended JT sources for implementation:** v10.6 as primary, v9.5 for the v9 compression layer, and v10.0 only as a cross-check.

**Exact geometry is possible, but not needed for viewing:**

- **Parseable:** the XT B-rep, ULP, STT and LWPA formats are all documented, and Annex M addresses procedural geometry evaluation.
- **Path into the pipeline:** a JS importer could translate parsed B-rep data into a payload our per-part tessellator interface accepts.
- **Scope:** this would be a large, optional extension. For a viewer, the embedded meshes are what matter, and those are fully documented.

**License terms** (front matter of both specifications, identical text):

- **Permitted:** Siemens allows anyone to write and distribute software that reads JT data and displays or otherwise interprets it, with an appropriate copyright notice.
- **Not permitted:** redistributing the document itself.
- **To review, combining formats:** the permission excludes "incorporating, integrating, or combining" the JT format into another data format. Converting JT content to glTF most plausibly counts as "interpreting", but review this (or ask counsel) before shipping a JT→glTF converter, as distinct from a viewer.
- **Patents: resolved.** Siemens' "JT Data Format Reference Patent Clarification Notice" (https://www.plm.automation.siemens.com/media/global/en/Siemens-PLM-JT-Data-Format-Reference-Patent-Clarification-Notice-mi-X1_tcm27-58013.pdf) grants a royalty-free, non-exclusive license to the relevant patents (US 8019788 and US 2011/0199382, plus foreign equivalents). The license covers developing, distributing and using software that produces, consumes and interprets specification-compliant JT files, for JT 9.5 and later. It covers only techniques disclosed in the specification.

**Suggested priority:**
1. **JT:** highest user value for a viewer, and largely independent of the backends.
2. **IGES:** a cheap JS parser plus the OCCT backend.
3. **`.FCStd`:** valuable but semantically tricky. `.brep` and `.xbf` come almost free once the OCCT backend supports `format: 'brep'`.

## Testing

- **Test files:**
  - the NIST MBE PMI models and the gkv311 OCCT dataset, in `../test_corpus/third_party/` (fetched by `../test_corpus/third_party/pull.sh`; see `../test_corpus/README.md`)
  - golden output files for regression tests
- **Round trip** (see the next section).
- **Volume check:** many CAx-IF-conformant files carry their own validation properties. Compare the tessellated mesh's volume, area and centroid against the file's declared values, for every backend.
- **Cross-checks:** product counts and tree structure compared against OCCT's own assembly reading.

### Round-trip testing

The Part 21 writer (Layer 1) is a production component, not test-only, because the tessellator subsets need it. Round-trip testing uses it as follows:

1. Parse the STEP file → instance model **A**.
2. Write A as raw JSON, then load that JSON back → instance model **B**. Checking **A ≡ B** tests JSON fidelity.
3. Write B as Part 21 text, then parse that text → instance model **C**. Checking **A ≡ C** tests writer fidelity.

**Equivalence rules:**

- **Comparison level:** equivalence is structural, not byte-for-byte. Instances must have the same IDs, types and attribute values, with value kinds included (integer vs. real, enumeration vs. string, typed parameters, `$` vs. `*`), and the same complex-instance partial entities, in the same order. The header must match too.
- **What differs legitimately:** whitespace, line breaks, comments, number formatting (`1.E-05` vs. `1.0E-5`) and the choice of string escapes.
- **Reals:** compared as exact doubles. JavaScript's shortest round-trip number formatting guarantees the written value parses back to the same double. The writer must always emit a decimal point, so reals stay reals.
- **Strings:** compared as decoded Unicode. The writer re-encodes non-ASCII text with `\X2\…\X0\` (or `\X4\` for characters outside the BMP).
- **Comments:** dropped; they aren't part of the model.

**An additional lexer-level check:** tokenize the original and the written files and compare the token streams. Whitespace and comments are ignored, and number and string tokens are compared by their decoded values. This catches problems that are invisible at the model level, such as wrong list nesting.

**The subset fast path** (copying original byte ranges) is checked by parsing each subset and comparing it with the corresponding slice of model A.

## Phasing

0. **Feasibility spike**, which determines the tessellator interface:
   - Do OCCT and truck accept per-part subset files? Possibly a bare shape representation without a product wrapper, or with a minimal synthetic wrapper.
   - Can each backend report face entity IDs?
   - What are the realistic WASM payload sizes and load times?
1. **The parser:** the schema generator first, then the lexer/parser/writer, schema binding, semantic extractors, and the `step2json` CLI with round-trip tests.
2. **The scene model and the tessellator interface**, designed together.
3. **Backends:** OCCT first, then truck.
4. **Exporters and `stepconv`:** three.js JSON, then glTF/GLB, then 3MF.

## Open items to verify

- the AP242 edition of stepcode's schema (later than ed1, ed2 or ed3 unconfirmed). Our test files use editions 1–4, and one dictionary binds them all (`phase1_progress.md`)
- the ISO EXPRESS schema's redistribution terms, for the generated dictionaries
- ~~whether OCCT can transfer a bare shape representation subset~~: resolved in phase 0 (`phase0/phase0_results.md`). Yes with `read.step.product.mode` OFF, verified with a custom OCCT 8.1 build; `occt-import-js` needs the synthetic wrapper
- ~~whether truck can report face IDs~~: resolved in phase 0. Yes, with a ~30-line wrapper
- whether to use the 3MF Production extension
- ~~the compact value encoding for raw JSON~~: resolved in phase 1 step 4, lexical numbers (`phase1_progress.md`)
- how to represent Part 21 edition 3 constant references and anchors in the raw model
- future: FreeCAD assembly representations across versions and workbenches
- future: the JT "combining formats" license clause, as it applies to JT→glTF/3MF conversion; sample JT files (v9.x and v10.x) from current writers; the distribution of JT versions in real-world files
