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
| QIF (ISO 23952, `.qif`) | pure JS: XML (3MF's streaming tokenizer), the MBD sections: `FileUnits`, `GeometrySet`, `TopologySet`, `Product` (parts, assemblies, components, transforms), per-entity `color`/`transparency`/`hidden`; QIF files can also carry face meshes (`FaceMesh`, `SurfaceMeshSet`) | OCCT, the B-rep written as a STEP subset (see "QIF" below); its meshes, where present, as source levels | free schemas and permissive NIST samples; one-to-one with STEP's B-rep; no assembly samples found; evaluated 2026-11-06, not started |
| FreeCAD (`.FCStd`) | pure JS: unzip, `Document.xml` (tree, placements), `GuiDocument.xml` (colours) | OCCT, each `.brp` as a `brep` payload | the hard part is which objects are the final visible shapes; assemblies differ by version and workbench |

Suggested order: JT, then IGES, then `.FCStd` (with `.brep` and `.xbf` nearly free once `format: 'brep'` exists).

P-curves in other formats: OCCT `.brep` edges carry p-curves in practice; JT's XT B-rep gives a fin an SP-curve only for a tolerant edge (JT v10.6, Annex F); IGES type 142 carries parameter-space and model-space curves with a preference, type 508 loops' parameter curves optional (from memory, unchecked).

## QIF

Evaluated 2026-11-06 for part geometry, appearance and assembly structure (no PMI, plans or results); nothing built.

- **Documents:** the ANSI QIF 3.0 standard (2018; ISO 23952:2020 is the same version, paywalled at ISO) is free from qifstandards.org, behind a sign-up form on the site but also as a direct download (the PDF and its XSDs, in `third_party/qif/standard/` with a text version; `qif-community` in `third_party/qif/qif-community/`, both fetched by `third_party/pull.sh`); the schemas alone (22 XSD files: `Geometry`, `Topology`, `QIFProduct`, `Visualization`, `Units`, `PrimitivesPD`, ...) are in `github.com/QualityInformationFramework/qif-community` (`bindings/CPP-Kramer/schema/`, Boost Software License for the repository; the XSDs' own header claims no rights), browsable at `qualityinformationframework.github.io/qif3-browser`. The XSDs document every type, which is enough for geometry, topology and product structure; the standard's text would still help for parameterizations the XSDs only name.
- **Samples:** six NIST PMI test models in QIF (`samples/NISTmodels/`, CTC 1, 3, 5, FTC 6, 8, 9, written by Capvidia's MBDVidia; Boost licence), three more in `bindings/CPP-Kramer/data/` and small test blocks; all single parts. The corpus has the same NIST models as STEP, a ready cross-check: `nist_ctc_01` has 117 faces, 318 edges, 140 loops, 90 circular arcs and 57 cylinders in both. No assembly sample was found; assemblies would need a commercial exporter (MBDVidia, CAD systems' QIF export).
- **No reader to lean on:** OCCT has none; nothing permissively licensed tessellates QIF B-rep.
- **B-rep, entity for entity like STEP's:** `Vertex` (point) -> `VERTEX_POINT`; `Edge` (3D curve, `VertexBeg`/`VertexEnd` in the curve's parameter order) -> `EDGE_CURVE` with same sense true; `CoEdge` (`EdgeOriented` with `turned`, optional `Curve12` p-curve) -> `ORIENTED_EDGE`; `Loop` -> `EDGE_LOOP`; `Face` (surface, loops, `hasOuter`, `turned`) -> `ADVANCED_FACE` (same sense = not turned, the outer loop first as `FACE_OUTER_BOUND`); `Shell`, `Body` -> shells and `MANIFOLD_SOLID_BREP` (or a shell-based surface model). So each QIF body can be written as a STEP subset and meshed by the OCCT backend unchanged, with QIF ids as the `#` ids (face ids for picking, measures, failures).
- **Curves** (`Curve13`): `Segment13` -> `LINE`; `ArcCircular13` (centre, `DirBeg`, normal, radius) -> `CIRCLE`; `ArcConic13` -> `ELLIPSE`/`PARABOLA`/`HYPERBOLA`; `Nurbs13` (order, full knot vector, optional weights) -> `B_SPLINE_CURVE_WITH_KNOTS` (knots folded into distinct values and multiplicities; rational as the complex entity); `Polyline13` -> `POLYLINE`; `Spline13` (piecewise polynomials: breakpoints, per-segment orders and coefficients) and `Aggregate13` (a chain of curves) -> an exact B-spline (basis conversion, joining), or `COMPOSITE_CURVE`.
- **Surfaces** (`Surface`): `Plane23` (origin, `DirU`, `DirV`), `Cylinder23`, `Cone23` (diameters at bottom and top, length, axis, sweep), `Sphere23`, `Torus23` -> the STEP elementary surfaces (the cone's semi-angle from its diameters and length; signs to be checked on real files); `Nurbs23` -> `B_SPLINE_SURFACE_WITH_KNOTS`; `Extrude23` -> `SURFACE_OF_LINEAR_EXTRUSION`; `Revolution23` -> `SURFACE_OF_REVOLUTION`; `Offset23` -> `OFFSET_SURFACE`; `Spline23` -> an exact B-spline; `Ruled23` (two curves) -> a B-spline surface of degree 1 across (curves made compatible: degree elevation, knot merging; AP242 has no ruled face surface, only `RULED_SURFACE_SWEPT_AREA_SOLID`). The B-spline algorithms are textbook (Piegl and Tiller), not OCCT's.
- **Parameterizations differ:** QIF curves carry an explicit `domain`, surfaces their own (`scaleU`, `scaleV`, `turnedV`, a cone's swept angle), so QIF p-curves aren't STEP's. Drop them and let OCCT project (as it does for STEP files without p-curves), or keep them only where the parameterizations match (planes, some elementary surfaces).
- **Risks:** faces without an explicit outer loop (`hasOuter` false: the surface's natural boundary), which STEP can't write as such: boundary edges built from the surface's domain (seams, poles); `Spline` and `Ruled` conversions; tolerant bodies (per-vertex and per-edge `tolerance`) where STEP has one uncertainty; the arc's sweep direction against its normal and the cone's conventions, to verify on real files; no assemblies to test.
- **Product structure and appearance:** `Part` (bodies), `Assembly` (component ids), `Component` (an instance of a part or assembly, a `Transform` reference, a UUID), a root part or assembly, `AsmPath` for instance paths; maps onto components, occurrences and placed parts. Colours are RGB attributes on drawables (bodies, faces, edges, ...), with `transparency` and `hidden`: per-face materials as STEP's styles become. Units from `FileUnits`.

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
