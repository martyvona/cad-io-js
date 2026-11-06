# Future formats and prior art notes

Notes for planning new input formats, and the projects reviewed as references. The full record is in `git show V0.2.0:CLAUDE.md` under "Notes for future work".

## Future input formats

None is started; the scene (parts with a `brep` of a given format, levels from the source or ours, or both; external references) and the tessellator interface (`format: 'step' | 'iges' | 'brep'`) were designed for them.

| Format | Importer | Tessellation | Notes |
|---|---|---|---|
| JT (ISO 14306) | pure JS: binary segments, zlib or LZMA, compressed mesh coding, logical scene graph, properties; a large project | none needed: JT carries meshes at several levels of detail (a part's `lods`, `from: 'source'`; its XT B-rep could be its `brep`) | high value for automotive and aerospace; OCCT has no reader; "shattered" assemblies need external references |
| IGES | pure JS: fixed 80-column ASCII, numbered types, no schema | OCCT (`TKDEIGES`, `IGESCAFControl`), subsets with renumbered pointers | much IGES is a surface soup (type 144) needing sewing; weak hierarchy (subfigures 308/408, levels); truck has none |
| BREP (`.brep`) | trivial: one part | OCCT (`format: 'brep'`) | no assembly, names, colours or units; spec `OCCT/dox/specification/brep_format.md` |
| OCCT documents (`.xbf`) | an OCCT WASM importer | OCCT, shapes as `brep` payloads | assembly, names, colours, layers |
| FreeCAD (`.FCStd`) | pure JS: unzip, `Document.xml` (tree, placements), `GuiDocument.xml` (colours) | OCCT, each `.brp` as a `brep` payload | the hard part is which objects are the final visible shapes; assemblies differ by version and workbench |

Suggested order: JT, then IGES, then `.FCStd` (with `.brep` and `.xbf` nearly free once `format: 'brep'` exists).

P-curves in other formats: OCCT `.brep` edges carry p-curves in practice; JT's XT B-rep gives a fin an SP-curve only for a tolerant edge (JT v10.6, Annex F); IGES type 142 carries parameter-space and model-space curves with a preference, type 508 loops' parameter curves optional (from memory, unchecked).

## JT specifications

In `third_party/jt/`, fetched by `third_party/pull.sh`, with text versions.

- **v10.6** (Rev D, 2026-02-10, 493 pages, plus the PMI property strings list) is the primary reference: file structure, the logical scene graph, levels of detail including TopoMesh, every compression scheme with reference decoder code (Annexes B-D), the XT B-rep (Annex F), ULP, Smart Topology Table and LWPA segments, wireframe, procedural geometry (Annex M), deprecated B-rep and PMI segments (Annexes K, L).
- **v9.5** (Rev A, 2010) is required too: v9 and v10 share the scene graph, TopoMesh coder and arithmetic/bit-length codecs, but v10 replaced the compression layer (new Int32 and Int64 CDPs, LZMA against zlib), and ISO 14306:2012 is v9.5, so v9 files are common. **v10.0** (Rev B, 2015) is a cross-check.
- **Gaps:** the STEP B-rep segment (type 33) is undefined; no v8 specification exists; real files from current writers are needed.
- **License terms:** anyone may write and distribute software that reads and interprets JT data, with a copyright notice; the documents may not be redistributed (hence fetched). The permission excludes "incorporating, integrating, or combining" JT into another format: converting JT to glTF most plausibly counts as interpreting, but review it before shipping a converter rather than a viewer. Siemens' patent clarification notice grants a royalty-free license to US 8019788 and US 2011/0199382 for compliant JT 9.5+ software.

## Reference projects and prior art

Reviewed 2026-10-16 (commits in `third_party/README.md`); none is a dependency except OCCT, stepcode and truck.

- **truck** (Rust, Apache-2.0): a full independent pipeline (ruststep, B-rep, NURBS, `spade` CDT meshing, assemblies). **ruststep**: Part 21 parser and `espr`; experimental.
- **web-ifc** (C++ -> WASM, MPL-2.0): fast browser Part 21 parser for IFC and trimmed NURBS; the closest architectural analogue.
- **verb** (MIT): NURBS, no trimmed surfaces. **tinyspline** (MIT), **tinynurbs** (BSD-3): NURBS evaluation. **BRL-CAD `step-g`** (LGPL), **SISL/GoTools** (AGPL), **SolveSpace** (GPL): reference only. **cdt2d**, **poly2tri.js**, **earcut**: 2D triangulation.
- **No open-source equivalent of OCCT's `ShapeFix`** exists: healing is where a pure-JS tessellator would need original work or accept lower robustness.
- **SFA** (NIST, Tcl) walks product structure through closed IFCsvr and tessellates through STP2X3D (OCCT).
- Other OCCT WASM packages: `occt-wasm`, `@bitbybit-dev/occt`, `opencascade.js` (last published 2023).
- Not obtainable: the CAx-IF round-robin files (members only) and the ISO standards; the corpus stands in for the first, the EXPRESS schemas and OCCT's behaviour for the second.

## Open questions

- How to represent Part 21 edition 3 constant references and anchors.
- FreeCAD's assembly representations across versions and workbenches; JT's combining-formats clause; sample JT files (v9 and v10) and the versions in real use.
