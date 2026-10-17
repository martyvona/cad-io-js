# STEP AP242 parser in pure JavaScript: initial analysis

*Paths in this document are relative to this `docs/` directory.*

Scope: extract B-rep geometry and assembly hierarchy only (no PMI, kinematics, etc.).

Reference repositories reviewed (siblings in `/Users/vona/src/others/` at the time; since 2026-10-17 the ones the project builds against are checked out at pinned versions in `../third_party/`, and `../third_party/README.md` lists every repository and its role):

- **SFA**: NIST STEP File Analyzer and Viewer (Tcl)
- **stepcode**: STEP/EXPRESS toolkit (C/C++)
- **STP2X3D**: STEP to X3D translator (C++, built on OCCT)
- **OCCT**: Open CASCADE Technology 8.1.0 (Aug 2026 head)

The short answer is yes. The four repos give you a complete, self-contained reference for everything in your scope, and nothing critical depends on code you don't already have. The gaps are in documents and test data, not code.

## Dependencies, repo by repo

**STP2X3D** depends only on OCCT and the C++ standard library. Even its AP242 XML reader (`AP242XML_Reader.cpp`) is hand-written and uses no XML library. Several OCCT toolkits it links are irrelevant to you: `TKV3d`, `TKService` and `TKVCAF` are visualization, and the GD&T and view parts of `XCAFDoc_*` are PMI.

**OCCT** (version 8.1.0, the Aug 2026 head). I traced each toolkit's `EXTERNLIB.cmake`. The pipeline you'd port needs nothing outside OCCT except optional TBB, which is only for parallelism. That pipeline is:

- **Parsing:** `TKXSBase`, plus `StepFile`, the Part 21 lexer/parser. Its grammar files (`step.lex`, `step.yacc`) and the generated C++ are all checked in.
- **AP242 → topology:** `TKDESTEP`. This covers the `StepGeom`, `StepShape` and `StepToGeom`/`StepToTopoDS` entity classes.
- **Geometry kernel:** `TKernel`, `TKMath`, `TKG2d`, `TKG3d`, `TKGeomBase`, `TKBRep`, `TKGeomAlgo`, `TKTopAlgo`. This includes NURBS evaluation (`BSplCLib`/`BSplSLib`).
- **Healing:** `TKShHealing`.
- **Meshing:** `TKMesh` (`BRepMesh`), fully self-contained.
- **Assembly hierarchy:** `STEPCAFControl_Reader` → `XCAFDoc_ShapeTool`, in `TKXCAF`/`TKLCAF`/`TKCAF`.

The real third-party dependencies (FreeType, FreeImage, OpenGL, Tcl/Tk, Draco, RapidJSON, VTK, FFmpeg) are all in Visualization, Draw or the glTF exporter. `TKXCAF` does link `TKService`/`TKV3d`, but only for color and visualization attributes, and you can skip that.

**stepcode:** the only external tools are LEMON, PERPLEX and RE2C, and those are needed only to regenerate the EXPRESS parser. The generated output is already checked in under `src/express/generated`. It also includes the AP242 MIM long-form EXPRESS schema (`data/ap242/242_mim_lf.exp`, 2,404 entities and 528 types). That is the authoritative entity and attribute definition list, and you could use it to code-generate your JS entity classes.

**SFA** contributes no geometry code. It is still a useful reference for how a real tool walks assembly and product structure entities and copes with how different CAD exporters vary.

## What's missing

1. **Assembly structure conventions.** The AP242 schema defines many legal ways to encode an assembly, so the schema alone won't tell you which ones to handle. The details are in the CAx-IF Recommended Practices. These are free PDFs from mbx-if.org, but they aren't in any of these repos. Reading OCCT's `STEPCAFControl_Reader` and `STEPControl_ActorRead` effectively shows you how they get implemented. Expect to handle `NEXT_ASSEMBLY_USAGE_OCCURRENCE`, `CONTEXT_DEPENDENT_SHAPE_REPRESENTATION`, `REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION`, `MAPPED_ITEM` and external references.
2. **The ISO standards themselves:** Part 21 (file format), Part 42 (geometry/topology) and Part 41. These are paywalled. The EXPRESS schema plus OCCT's implementation mostly substitutes for them, though the Part 21 edge cases (encoding, complex entity instances, Part 21 ed3 anchors and references) are worth having the real spec for.
3. **Test data, which is thin in the four code repos.** There are about 48 STEP files across them, but only two are OCCT geometry samples (`OCCT/data/step/linkrods.step`, `screw.step`). OCCT's regression suite under `tests/` expects an external data set that isn't checked in. This has since been addressed by downloading the gkv311 OCCT dataset and the NIST models (see "Downloaded reference material" below). The CAx-IF round-robin files are members-only and remain unavailable.
4. **The AP242 XML (.stpx) path,** if you care about it. STP2X3D has the only reader here, and it's a minimal hand-rolled one.

## Scoping notes

- **Decide early whether you need tessellation.** Extracting exact B-rep entities plus the assembly tree is a moderate project: a Part 21 parser, an entity model generated from the EXPRESS schema, and a graph walk. If you need triangles, you'd be porting curve/surface evaluation, p-curve handling, trimming, healing and `BRepMesh`. That is a very large piece of OCCT, and most of the risk lives there because real-world files are dirty.
- **Licensing:** a line-by-line JS translation of OCCT would be a derivative work under its LGPL 2.1. Writing an independent implementation that uses OCCT only as a reference avoids that. See the "Licensing" section below.
- **Prior art to benchmark against:** `opencascade.js` and `occt-import-js` are OCCT compiled to WASM. They aren't pure JS, but they're useful as correctness oracles for your parser's output.

## Licensing

*Not legal advice. If this matters commercially, have counsel confirm.*

### What the OCCT license actually says

OCCT is LGPL 2.1 plus a small "Open CASCADE exception" (`OCCT/OCCT_LGPL_EXCEPTION.txt`). The exception only lets compiled code that pulls in material from OCCT's C++ header files ship under any license, as long as OCCT is credited. It doesn't apply to a JS reimplementation, so in practice this is plain LGPL 2.1. OCCT is also sold under a commercial license, which is a way out if one is ever needed.

### Using OCCT as a reference, not translating it

Copyright covers the way code is written, not the ideas, algorithms, facts or file formats behind it. If we read OCCT to understand what it does and then write our own implementation, our code generally isn't a derivative work, and the LGPL doesn't reach it. We'd be free to use MIT, BSD, Apache or anything else.

How close we stay to OCCT's code determines the risk:

| Approach | Risk |
|---|---|
| Line-by-line translation, including "port this function to JS" with an AI assistant | A derivative work. LGPL applies. |
| Close paraphrase: same decomposition into functions, same helper structure, same sequence of special cases, same distinctive constants and comments | Gray zone. A court could find substantial similarity. |
| Reading to understand behavior, then designing and writing our own code | Generally fine. |
| Clean room: one person reads OCCT and writes a behavioral spec; someone else implements from the spec | The strongest position. |

**Specific to this project:**

- **Mirroring the entity model is fine.** OCCT's `StepGeom_*` / `StepShape_*` classes follow the ISO EXPRESS schema, so that structure is ISO's, not OCCT's. Generating our entity classes from `stepcode/data/ap242/242_mim_lf.exp` gives that whole layer a clean origin.
- **The core math is public.** NURBS evaluation, de Boor, knot insertion and the like are textbook algorithms (Piegl & Tiller, *The NURBS Book*). Implement them from the literature, not from `BSplCLib`.
- **The riskiest areas are shape healing, p-curve and tolerance handling, and meshing.** They're full of OCCT-specific heuristics and special cases. Copying enough of those choices in the same order starts to look like copying expression, even without matching any lines.
- **Using OCCT as a black-box oracle is fine.** Running OCCT (or `occt-import-js`) and comparing its output to ours carries no licensing obligation.
- **AI tools:** asking an AI assistant to "port `StepToTopoDS_TranslateFace`" is translation. A cleaner pattern is to have it describe what an OCCT function handles (the edge cases and the reasons for them), then write fresh code from that description and the specs.

**Good habits:**

- Keep a short provenance log that says which spec, paper or recommended practice each module came from.
- Don't copy comments or OCCT identifiers, other than EXPRESS entity names.
- Be able to justify every magic constant independently.

### Obligations if the LGPL 2.1 does apply

If our code turns out to be a derivative of OCCT, it's legally a modified version of the Library. That has consequences for us, and also for anyone who uses our library.

**For our library:**

1. **License:** the derived code must itself be released under LGPL 2.1 (§2). It can't go under MIT. It may be upgraded to GPL (§3), but not the other way.
2. **Notices:** keep OCCT's copyright notices, the license text and the warranty disclaimer. Modified files need prominent notices saying we changed them and when (§2a).
3. **Library form:** the result must remain a library (§2a). A JS parser library satisfies that.
4. **Source:** distribute or offer the complete corresponding source (§4). For JS, a minified or bundled build counts as object code, so the readable source has to accompany it. That's easy if the project is open source on GitHub/npm anyway.
5. **No added restrictions:** we can't place extra restrictions on recipients (§10).

**For applications that use our library** (§5–6). This is the real cost:

- An application that merely uses the library can have any license. But if it's distributed combined with our library, the application's terms must:
  - let users modify the library for their own use, and reverse-engineer the application to debug those modifications;
  - include a notice that the library is used and is under LGPL, plus a copy of the license;
  - provide the library's source, and make it possible to swap in a modified version of the library.
- §6 was written with C linking in mind. Its "relinking" requirement maps awkwardly onto JS bundlers, which merge everything into one minified file. The common way to comply is to load the library as a separate, replaceable file, or to ship enough build materials to rebuild the bundle with a modified library. Many commercial JS teams simply avoid LGPL dependencies for this reason, so LGPL would limit who adopts our library.

**Mixing sources:** if only some modules derive from OCCT, those modules carry the LGPL, and the rest of the code can stay permissive as long as it's separable. In practice, keeping that boundary clean is a headache.

### Licenses of the other sources

| Source | License | Obligation |
|---|---|---|
| stepcode | BSD-3 | Keep the copyright notice and license if we copy its code |
| STP2X3D, SFA | NIST public domain in the US; possibly copyrighted abroad | Include the NIST notice if we redistribute. STP2X3D v2 contributions from Pusan National University may carry their own terms. |
| MBx-IF recommended practices | Freely published documents | Implementing what they describe carries no obligation |
| ISO EXPRESS schema (via stepcode) | ISO copyright | To verify: I believe ISO TC184/SC4 permits free use of EXPRESS listings for implementations, but haven't confirmed it. Check the schema's header and SC4's policy before shipping generated code with schema text embedded. |

### Recommendation

Aim for an independently written implementation under a permissive license. Build from sources that are clean to use:

- the EXPRESS schema, via stepcode
- NIST code (STP2X3D, SFA)
- the MBx-IF recommended practices
- the published geometry literature

Treat OCCT as a behavioral reference and a test oracle, with a provenance log. Save clean-room discipline for the riskiest areas, if the project gets into healing or meshing.

## Related open-source projects

### What OCCT has that stepcode lacks

stepcode only handles the file and schema layer. It parses EXPRESS, generates C++/Python entity classes, and reads and writes Part 21 into a schema-aware instance store, with lazy loading. It has no idea what any of those entities mean. Everything below exists only in OCCT among the four original reference repos:

| Capability | OCCT location | Needed for our scope? |
|---|---|---|
| **Entity semantics to geometry:** turning `B_SPLINE_SURFACE_WITH_KNOTS`, `CYLINDRICAL_SURFACE`, placements, units and contexts into evaluable curve and surface objects | `StepToGeom`, `StepData` | Yes |
| **Curve and surface evaluation:** analytic surfaces, B-spline/NURBS, offset curves and surfaces, extrusion and revolution surfaces, trimmed curves | `Geom`, `Geom2d`, `BSplCLib`, `BSplSLib` | Yes, if we output anything beyond raw entities |
| **B-rep topology construction:** solids, shells, faces, wires, edges and vertices, with orientation, shared sub-shapes and tolerances | `StepToTopoDS`, `TopoDS`, `BRep` | Yes |
| **P-curves:** the 2D parameter-space curves on each face, computed by projection when the file doesn't supply them (often) | `StepToTopoDS`, `ShapeFix_Edge`, `ProjLib` | Yes for tessellation |
| **Shape healing:** gaps, wrong tolerances, wire ordering, degenerate and seam edges, small edges, bad orientation | `ShapeFix`, `ShapeAnalysis`, `ShapeUpgrade` | For robust tessellation |
| **Tessellation of trimmed surfaces, of every surface type, not just NURBS:** triangulating each face's trimmed parameter domain, with deflection control and edges discretized once and shared between faces so meshes are watertight | `BRepMesh` | If we want triangles |
| **Assembly and product structure interpretation:** NAUO, `CONTEXT_DEPENDENT_SHAPE_REPRESENTATION`, transforms, `MAPPED_ITEM` instancing, names, colors, layers, external references | `STEPCAFControl`, `STEPConstruct`, `XCAF` | Yes |
| **Mass properties** (volume, area, centroid), useful for checking against the validation properties in the files | `GProp`, `BRepGProp` | Nice to have, for testing |

### Other codebases covering parts of that

Licenses were checked on 2026-10-16 against GitHub's license detection and the repos' own license files or headers. "Cloned" means a shallow clone was made in `/Users/vona/src/others/` (for OCCT, stepcode, truck and monstertruck, now in `../third_party/`).

| Project | Language | License | Covers | Status / notes | Cloned |
|---|---|---|---|---|---|
| **truck** (ricosjp/truck) | Rust → WASM | Apache-2.0 | Full independent pipeline: STEP import (`truck-stepio`, built on ruststep), B-rep topology, NURBS, meshing (`truck-meshalgo`, CDT via the `spade` crate, Apache-2.0), assemblies (`truck-assembly`), JS/WASM bindings with STEP input (`truck-js/src/step_in.rs`) | Active (last push 2026-09-28, ~1.6k stars). The importer handles B-spline/rational curves and surfaces, p-curves, toroidal / revolution / extrusion surfaces, `MANIFOLD_SOLID_BREP`, and assembly entities (NAUO, CDSR, `REPRESENTATION_RELATIONSHIP`). **The most relevant permissively licensed reference for the whole pipeline.** | `truck/` |
| **ruststep** (ricosjp/ruststep) | Rust | Apache-2.0 | Part 21 parser; `espr`, an EXPRESS → Rust code generator. Explicitly aims to replace stepcode. | README: "experimental stage, DO NOT USE FOR PRODUCT". Last push 2025-03. Good design reference for schema-driven code generation. | `ruststep/` |
| **web-ifc** (ThatOpen/engine_web-ifc) | C++ → WASM, JS/TS API | MPL-2.0 (copyleft per file only) | A fast, browser-oriented Part 21 tokenizer and parser (`src/cpp/web-ifc/parsing`). IFC files use the same Part 21 format. Also geometry processing, including trimmed NURBS surfaces (`geometry/nurbs.cpp`). | Very active (pushed 2026-10-16). Fetches its dependencies at build time, so they aren't in the clone: tinynurbs (BSD-3), artem-ogre/CDT (MPL-2.0), earcut.hpp (ISC), glm, fast_float. **The closest architectural analog to a browser STEP parser.** | `engine_web-ifc/` |
| **verb** (pboyer/verb) | Haxe → JS (prebuilt `build/js/verb.js`) | MIT | NURBS curve and surface evaluation, tessellation, intersection | Low activity (last commit 2025-04, a docs change). **No trimmed-surface support**: no trim code in the source, so it can't tessellate B-rep faces on its own. Useful for untrimmed NURBS math. | `verb/` |
| **BRL-CAD `step-g`** | C++ | LGPL-2.1 (confirmed from the `step-g.cpp` header; the project overall is mostly LGPL, with some BSD and public-domain files) | STEP B-rep → openNURBS B-rep mapping without OCCT, built on stepcode, which grew out of BRL-CAD | Copyleft, so use for reference only. The official `BRL-CAD/brlcad` GitHub repo wasn't reachable from here; the license was read from the fork `Mu-L/brlcad`, whose parent is listed as `BRL-CAD/brlcad`. | No: large repo, LGPL |
| **openNURBS** (mcneel/opennurbs) | C++ | **Unclear.** GitHub reports NOASSERTION, and the LICENSE file has a copyright notice and warranty disclaimer but no explicit grant of rights. Generally understood to be permissive, but read McNeel's terms before using it. | NURBS curves and surfaces, trimmed B-rep data structures | **No B-rep mesher:** `ON_Brep::CreateMesh` is declared but not implemented, so meshing stays in Rhino. Its JS/WASM wrapper `rhino3dm` is MIT. | No |
| **tinyspline** (msteinbeck/tinyspline) | C | MIT | B-spline/NURBS curve evaluation, with no B-rep | Last push 2024-09 | No |
| **tinynurbs** (pradeep-pyro/tinynurbs) | C++ header-only | BSD-3 | NURBS curve and surface evaluation; web-ifc uses a fork | Last push 2024-06 | No |
| **SISL / GoTools** (SINTEF) | C / C++ | **AGPL-3.0** | Mature spline and B-rep geometry | Strong copyleft, so use for reference only | No |
| **SolveSpace** | C++ | GPL-3.0 | Its own trimmed NURBS surfaces and tessellation; exports STEP but doesn't import it | Copyleft, so use for reference only | No |
| **cdt2d** (mikolalysenko) | JS | MIT | Constrained Delaunay triangulation, for triangulating trimmed parameter domains | Unmaintained (2019) | No |
| **poly2tri.js** | JS | BSD-3 (GitHub reports NOASSERTION; the LICENSE file is BSD) | Constrained Delaunay triangulation | Unmaintained (2018) | No |
| **earcut** (mapbox) | JS | ISC | Fast polygon triangulation (ear clipping, not Delaunay, so lower-quality triangles) | Active | No |

**Gaps:**

- **Shape healing:** no open-source equivalent of OCCT's `ShapeFix` was found. This is where the most original work, or acceptance of lower robustness on dirty files, will be needed.
- **Assembly structure:** besides OCCT, the readable references are SFA's Tcl, truck (`truck-stepio` + `truck-assembly`), and BRL-CAD `step-g`.

**Most promising permissive references**, all compatible with an MIT/Apache-licensed result as long as attribution requirements are met:

- truck, for the whole pipeline and assemblies
- ruststep, for EXPRESS code generation
- web-ifc's parser design (MPL-2.0 covers only the files themselves)
- tinynurbs, verb and the published literature, for NURBS math

## Downloaded reference material

These were downloaded 2026-10-16 into further sibling directories of `/Users/vona/src/others/`. On 2026-10-17, `gkv311-opencascade-dataset/` and `nist-pmi-models/` moved into this repository's `../test_corpus/third_party/` (git-ignored), along with an `occt-import-js` checkout; `../test_corpus/third_party/pull.sh` fetches or updates them. STEP counts include `.stp` and `.step`, case-insensitive; "AP242" means the file header names the `AP242_MANAGED_MODEL_BASED_3D_ENGINEERING` schema.

| Directory | Source | Contents | Size | STEP / AP242 |
|---|---|---|---|---|
| `mbx-if-recpractices/` | https://www.mbx-if.org/home/cax/recpractices/ | All 19 CAx-IF/MBx-IF recommended-practice PDFs, plus two trace-information sample zips (Test Cases 7 and 8) | 31 MB | n/a |
| `gkv311-opencascade-dataset/` | https://github.com/gkv311/opencascade-dataset (shallow clone, commit `ead84b5`, 2026-10-06) | Third-party collection of OCCT test data: the official dataset plus files from public OCCT bug reports. Under active maintenance. | 1.2 GB | 470 / 28 |
| `truck/`, `ruststep/`, `engine_web-ifc/`, `verb/` | GitHub shallow clones (see "Related open-source projects"); commits `88ed005`, `cd89e5a`, `e408b65`, `f3ba23c` | Related open-source codebases | 4 MB, 28 MB, 631 MB, 9 MB | n/a |
| `nist-pmi-models/` | https://www.nist.gov/ctl/smart-connected-systems-division/smart-connected-manufacturing-systems-group/mbe-pmi-0 | 8 NIST MBE PMI packages, unzipped: FTC/CTC definitions, PMI STEP files, STC v4, FTC/CTC CAD models, HTC v2, MTC assembly, D2MI models | ~310 MB | 60 / 18 |

The official OCCT dataset (`opencascade-dataset-7.9.0.tar.xz` from the OCCT GitHub release `V7_9_0_beta2`, 360 MB, 368 STEP / 7 AP242) was also downloaded and then deleted as redundant. Every STEP file in it is present in the gkv311 clone with identical content, though some sit in different subdirectories (e.g. `step/nist/`). Only 6 files in it don't appear anywhere in gkv311: one TrueType font and five Java XML-validator jars (`msv.jar`, `xerces.jar`, etc.), none of which are relevant to this project.

**Most relevant to this project:**

- **Assembly structure:**
  - `rec_prac_ap242xml_assy_struct_v4.0.pdf`
  - `pdmug_release4_3.pdf`, the PDM Schema Usage Guide. Despite its name, it covers the Part 21 product and assembly structure.
  - `rec_prac_ext_ref_v31.pdf`, for external references.
- **Geometry verification:** `rec_prac_gvp_v46.pdf` defines validation properties (volume, area, centroid) that can serve as correctness checks.
- **Multi-part assemblies:** `nist-pmi-models/NIST-MTC-Assembly`.
- **Non-AP242 files:** most of the OCCT dataset files are AP203/AP214. They use the same B-rep and assembly entities, so they are still useful parser test data.
- **Unneeded native CAD files:** the NIST packages also contain native CATIA, NX, Creo and SolidWorks models that this project doesn't need.

**Not obtained:**

- **CAx-IF round-robin test files:** available only to MBx-IF members through their members-only area. The public round test-suite PDFs (e.g. https://www.mbx-if.org/home/wp-content/uploads/2025/08/test_suite_56j_v1.pdf) describe what each round covers.
- **ISO 10303 standard documents:** paywalled.

## Background: SFA's own dependencies

SFA (NIST STEP File Analyzer and Viewer) is about 30,700 lines of Tcl and does not use OpenCascade directly. It relies on two external components:

- **IFCsvr**, from SECOM, parses STEP files through ActiveX. It is closed source, and NIST modified it to add STEP schemas.
- **stp2x3d** handles B-rep tessellation. SFA runs `stp2x3d-part.exe` as a subprocess (`source/sfa-part.tcl:98`). Its source is at https://github.com/usnistgov/STP2X3D, and it uses OCCT.
