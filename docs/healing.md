# Shape healing in OCCT and SMLib

What the two backends' healers do to a B-rep before it's meshed: when they run, each operation in order, how they set and grow tolerances, how they decide which side of a shell is outside, how they (and truck) make the p-curves a model lacks, and what our wrappers do around them. It's for deciding what healing of our own (a pass on the B-rep model, on by default with one switch to turn it off: `own-tessellator.md`) should do, and for reading the two backends' results. It describes behaviour, from reading OCCT 8.1's source (`third_party/OCCT`) and SMLib's (usd-brep 1.0.1, `third_party/usd-brep/source/SMLib`); it holds none of their code, and nothing here is to be translated from them (`docs/licensing.md`). Paths are relative to those trees: OCCT's healing toolkit is `src/ModelingAlgorithms/TKShHealing/` (`ShapeFix`, `ShapeAnalysis`, `ShapeUpgrade`, `ShapeCustom`, `ShapeBuild`, `ShapeProcess`), its STEP side `src/DataExchange/TKDESTEP/` and `src/DataExchange/TKXSBase/`; SMLib's healer is `src/SmHealData.cpp` with `src/SmBrep.cpp`. What was inferred rather than read is marked *(inferred)*.

## In short

| | OCCT | SMLib |
|---|---|---|
| When | every STEP import, and our native route: one operator, FixShape | inside `MakeTopologyFromData` when asked (our builder asks by default); all or nothing |
| Structure | analysers (`ShapeAnalysis_*`) and fixers (`ShapeFix_*`) nested shape, solid, shell, face, wire, edge; changes recorded in a reshape context and applied to parents | a fixed sequence of cache and fix steps over every vertex, edge and face, re-entered for topology a fix adds |
| Tolerances | a working precision (the file's uncertainty) and a maximum (1 mm by default); wire fixes capped by the maximum, same-parameter and vertex fixes not | replaced: the B-rep's from its longest edge (a band of 1e-7 to 1e-3), every face's, edge's and vertex's reset from measured gaps, raised again when trims are made |
| Topology | reorders and connects wires, adds missing p-curves, 3D curves, seams, degenerate edges, natural bounds; splits faces by outer wire; splits shells by connectivity; no sewing | merges coincident vertices (the only sewing), squeezes degenerate faces and edges, moves seams and splits faces at them; never merges edges or closes gaps; loop repair disabled |
| Geometry | p-curves projected, 3D curves rebuilt, edges split at poles | seams moved; no surface turned |
| Orientation | faces in a shell follow the first face; each closed shell oriented by classifying the infinite point (one ray from a face), voids nested by vertex classification and made to face into the void | the enclosed side of a closed shell is a solid region, found by one ray from outside the box; normals untouched, so a shell given inward has its faces' upward side in the solid |
| Failure | status bits per fixer; a failure leaves that part as it was | a failing step skips the rest, silently |

## OCCT

### Architecture

- **Analysis apart from fixing.** `ShapeAnalysis_*` classes only detect (a wire's order, connection and small edges, an edge's same-parameter deviation and vertex tolerances, free boundaries, a shell's orientation); `ShapeFix_*` classes call them and then change a tolerance, the topology or the geometry (`ShapeFix_Wire.hxx` describes the three).
- **The fixers are nested.** `ShapeFix_Shape::Perform` dispatches by type: compounds child by child, a solid to `ShapeFix_Solid`, which owns a `ShapeFix_Shell`, which owns a `ShapeFix_Face`, which owns a `ShapeFix_Wire`, which owns a `ShapeFix_Edge`; a lone edge gets only its vertex tolerances fixed. After the type's fix, same-parameter (`ShapeFix::SameParameter`) runs over the whole result, then the vertex-tolerance fix on every edge of every face (where there's more than one face).
- **The shared state** (`ShapeFix_Root`): a reshape context (`ShapeBuild_ReShape`) where fixers record replacements and removals instead of editing shared sub-shapes, applied to rebuild the parents (the STEP reader maps its entities to the healed shapes through it); a working precision, a minimum and a maximum tolerance (all 1e-7 unless set); a message registry.
- **Modes and statuses.** Each fix has a mode: -1 decide by the situation (each call site its own default), 0 never, 1 always. Each fixer reports status bits, DONE1-8 and FAIL1-8, their meanings its own (`ShapeFix_Face`: wires fixed, wires reoriented, seam added, small wire removed, natural bounds added, face split).
- **A loose face is fixed harder.** A bare face (one reached through a compound included) gets topology changes and small-area wire removal turned on; a face in a shell doesn't.

### How STEP import calls it

- **One operator.** The import's shape processing is FixShape alone. The resource file (`resources/XSTEPResource/STEP`) says so, but the library doesn't read it (only the DRAW commands do): the reader's defaults (`DESTEP_Parameters`, `DE_ShapeFixParameters`) give the same, FixShape only. The other operators (DirectFaces, SameParameter, SplitAngle, BSplineRestriction, ElementaryToRevolution, SplitContinuity, DropSmallEdges, DropSmallSolids, SplitClosedFaces, ...) don't run on import; two of them (splitting common vertices, direct faces) run when writing STEP.
- **Per item.** `STEPControl_ActorRead` heals each translated representation item with the reader's precision and maximum tolerance. A non-manifold representation is healed as one compound, shells allowed non-manifold, and then every shell marked closed is made a solid with no orientation check.
- **The FixShape operator's settings** (`ShapeProcess_OperLibrary.cxx`): every mode "decide" but these: open solids not created, topology changes off (so small edges in shells stay), geometry changes on, wires closed, p-curves preferred, edge same-parameter in the wire fix off, vertex positions not fixed, tails not fixed.
- **No sewing.** Neither `BRepBuilderAPI_Sewing` nor shell sewing is used on the STEP path: faces that don't share edges in the file stay apart.

### Precision and tolerance growth

- **The reader's precision** is the file's `UNCERTAINTY_MEASURE_WITH_UNIT` (in the model's unit), else 1e-4 with a warning, unless the user mode sets it; the maximum is the larger of that and 1 (`read.maxprecision.val`). Only the forced maximum mode limits tolerances, and it does so after translation and before healing, so healing can raise them past it again *(inferred from the call order)*.
- **Before healing, the translator checks p-curves** (`StepToTopoDS_TranslateEdgeLoop`, `XSAlgo_ShapeProcessor::CheckPCurve`): one with an empty range, one spanning most of a closed surface's period, or one whose ends are off the 3D curve's by more than the precision is dropped; otherwise the edge is made same-parameter on a copy, and where that tolerance exceeds twice the precision (at most 1) the 3D curve is projected again and the better p-curve kept.
- **Where tolerances grow:**
  - connecting a wire's edges merges consecutive end vertices up to the *maximum* tolerance apart (1 mm by default), the merged vertex's tolerance the sphere enclosing both;
  - lacking edges, self-intersections and intersecting edges raise vertex tolerances to cover the gap or crossing while under the maximum, else add an edge or fail;
  - the edge same-parameter fix raises an edge's tolerance to its p-curves' deviation from its 3D curve, with **no cap**; the whole-shape same-parameter pass does the same;
  - the vertex-tolerance fix grows each vertex to cover the ends of its edges' curves and p-curves, no cap;
  - one exception lowers: a face's fix works at half its shortest edge's length where that is less than the precision.
- **So** tolerances can grow without bound to cover deviations, vertices up to a millimetre apart are merged, p-curves replaced by projections, 3D curves rebuilt from p-curves, edges and faces split, and edges left with no geometry removed.

### The wire fix, in order

1. Reorder edges where they're out of order (both directions on a doubly periodic surface); whether the order is right decides which fixes follow.
2. Small edges (zero length at the minimum tolerance) removed: only where topology may change, so not in shells on STEP import.
3. Connect consecutive edges (the last to the first in closed-wire mode).
4. Edge curves: a p-curve against its 3D curve turned; a missing p-curve added by projection (split at a pole it passes through); a missing 3D curve built; an edge with neither removed; p-curves a period off on closed surfaces shifted.
5. Degenerate edges added at a surface's singular points, or edges made degenerate.
6. Notched edges (or tails, when that mode is on).
7. Self-intersections and intersecting adjacent edges, loops removed if asked; then reordered again.
8. Lacking edges: where adjacent edges meet in 3D but not in 2D, a vertex tolerance raised or a straight 2D edge added.
9. Vertex tolerances on every edge.

Gap closing in 3D and 2D isn't part of it (only the wireframe fix, not run).

### The face fix, in order

- Its wires fixed once (lacking edges and self-intersections off), empty ones dropped.
- A cone face belting the cone gets its apex's degenerate edge.
- A missing seam: two wires on a closed surface, closed in 3D but not in 2D, joined with the seam added (possibly several faces).
- Its wires fixed again with the later fixes; looping wires split; wires with two coincident edges and intersecting wires fixed.
- **Wire orientation:** each wire classified in 2D, as a face of its own, against the infinite point and the other wires' edge midpoints: a lone wire that isn't an outer bound is reversed (unless natural bounds are coming), a wire outside the others whose infinite point classifies inside is reversed, wires nested in none are outer wires with their holes; tiny one-edge wires dropped.
- **Natural bounds:** a face without wires on a bounded surface always gets them; a sphere or torus face whose wires are all holes gets them unless turned off.
- **Split:** a face with more than one outer wire becomes a face per outer wire with its holes.
- Small-area wires (and faces left empty) removed only where that mode is on: loose faces.

### The shell fix

- Each face fixed; duplicate faces removed; the shell's closed flag corrected from its free edges.
- **Face orientation by propagation:** faces grouped by shared edges, the largest group first; the first face keeps its orientation, each next face compared with the edge uses already placed: used the other way, kept; the same way, reversed; both, an error face put in a shell of its own (a Moebius-like case) and the shell split. Nothing at this level knows inside from outside: a shell's orientation is its first face's.
- Edges shared by more than two faces: shells split where they close, open leftovers tried against each other, or merged into one non-manifold shell when that is allowed.
- More than one shell out: a compound of shells (status "split into parts").

### The solid fix, and orientation

- **One shell:** closed if it has no free edges. Closed: the infinite point classified against it, and the shell reversed where that says inside. Open (and open solids not allowed, the STEP default): **the solid replaced by its bare shell**.
- **Several shells:** each closed shell classified against the infinite point; a shell inside another if up to 10 of its vertices classify against that shell otherwise than the infinite point (three "on" in a row read as outside; parity for shells within holes); outer shells reversed if the infinite point is inside them, holes reversed if it is outside them, so voids face into the void; open shells passed through; unnested lumps a compound of solids.
- **No signed volume anywhere.** The classification is `BRepClass3d_SolidClassifier`'s infinite-point test: a point inside a face (parameters drawn from its middle 80% by a generator with a fixed seed, so deterministic *(inferred)*), a line along the face's reversed normal, the nearest intersection over all faces; a clean crossing inside a face decides, else up to 10 more points.
- **Voids from STEP:** the translator reverses a void used with `.F.`, then the solid fix decides every shell's orientation again by classification, so the file's senses are overridden. That's why OCCT meshes `bug24055_8MTF-75LS05.step`'s voids right though the file gives them facing into the material (`docs/backends.md`, "Solids' shells facing into the material").

### Not run by default

Small faces (spots and strips) and small solids removed or merged, the wireframe fixes (gaps, small edges merged), and the upgrade and customisation operators (splitting by angle or continuity, B-spline restriction to degree and segments, conversions between elementary, swept and B-spline surfaces, closed faces and edges split).

### What our OCCT wrapper does

- **The STEP route** (`packages/tess-occt/native/occt_tess.cpp`): the standard reader, so FixShape with the file's precision; for a geometrically bounded surface representation, natural bounds turned off (OCCT 7.6's reading of lone curve-bounded wires on spheres and tori).
- **The native route:** the model built (`occt_build.cpp`) then FixShape with the reader's defaults, the part's uncertainty as precision; natural bounds off for geometric sets; the non-manifold flag not set. Face and edge ids followed through the reshape context (a split face's id to every piece).
- **The builder** itself heals a little: a curve-bounded face's loops reordered and connected by the wire fix, and the translator's p-curve checks repeated (ranges set or the p-curve dropped where projection fails, ranges clamped, periodic parameters shifted).
- **Patches:** none touch healing (`occt_patches/` patches the mesher's cone seams).

## SMLib

### Entry and control

- **Where:** at the end of `SmBrep::MakeTopologyFromData`, once the topology is linked, when the healer is enabled and either "always heal" is set or the data's healer version is older than the current one (10); also `SmApiHealBrep`. Nothing else heals: stitching a bag of faces into a shell (`SmStitch`) isn't part of it.
- **All or nothing:** the only options are where to stop in the sequence, whether to make (u, v) trims, and optional target lists; no per-operation switches, no tolerance arguments.
- **Silent failure:** a step that fails ends the sequence there (the later ones, trims and regions among them, skipped), and the callers ignore the status *(inferred: a caller can't tell a healed B-rep from a partly healed one)*.
- **The B-rep's tolerance before healing:** with "force same tolerance" the data's own; otherwise the data's clamped to 1e-8 to 1e-4 of the largest vertex coordinate, or 1e-5 of it without one.
- **The tolerance model** compiled is the old one: the newer model's scaling for "small topology" by a large-to-small ratio is compiled out, so setting that ratio does nothing.

### The steps, in order

1. **Edge properties cached:** each edge use's gap to the next, each edge's gap to its faces, lengths (from 5 samples), degenerate edges (by an absolute approximation tolerance, about 5e-6 *(inferred)*), edges whose interval leaves their curve's.
2. **Vertex and face gaps cached.**
3. **Tolerances set** (from the longest non-degenerate edge, the model size, snapped to bands: up to 0.005 gives 1e-7, to 0.5 1e-6, to 500 1e-5, to 5e4 1e-4, to 5e6 1e-3, beyond a formula). The B-rep's model size estimate is set to match, and that **writes the shared context's estimate and zone tolerance too**, so it persists for the next B-rep built in the context. The B-rep's tolerance is replaced by the band's and every face, edge and vertex below it raised; then every object whose tolerance differs from one computed from its measured gaps (times a gain of 1.1, against the context's zone tolerance) is reset to that, shrinking allowed: faces to the B-rep's, edges to cover their end gaps and face gaps, vertices to cover their edge and face gaps *(inferred: tolerances the input carried are replaced; our builder's vertex tolerances of 1.01 times a gap come back about half)*.
4. **Coincident vertices merged:** vertices binned in a voxel grid by their tolerances, pairs within tolerance merged one at a time (an edge between them squeezed away). The only sewing: coincident edges are never merged (those steps are stubs).
5. **Degenerate faces squeezed:** a face whose edges are all degenerate, or whose every non-degenerate edge point is within tolerance of another of its edges (slivers), collapsed, with the wire edges and isolated vertices it leaves deleted; whole closed surfaces bounded by vertex loops exempt. This is how a sliver vanishes from its shell (`VW.step`'s faces, `docs/backends.md`).
6. **Degenerate edges squeezed** into their start vertex, or deleted if from a vertex to itself (pole and apex edges without length *(inferred)*).
7. Stubs: missed edge intersections, bad gaps; uncontained edges clamped only in the cached copy *(inferred: no effect)*.
8. **Face properties:** sheet state, closedness, poles, flat corners, seam problems (missing, crossed, nearly missed, an edge across a pole).
9. **Seams moved** out of a face, or to its middle, so a later split leaves no slivers.
10. **Edges split** where they cross a pole or a seam.
11. **Closed sheets made solids:** for each face both of whose uses are in one region, closure traversed from each use; where both sides close separately in one shell, the closed set moved into a new shell and region, and the infinite region found again by ray casting. Faces of open shells stay sheets in the infinite region.
12. **Loops classified** (orientation, outer-loop order, several outer loops, nesting, loops of no area, missing pole vertices, loops not closed); faces with problems it can't handle set aside.
13. **Faces split at seams** where a seam edge is missing: one model face can come back as two SMLib faces (`bug31685_1.stp`'s cones).
14. **Loop repair disabled** (its comment: classification and repair of broken loops aren't reliable): what step 12 finds isn't fixed (no loop reversed or reordered, no face with several outer loops split, no pole vertex added). Our builder works around two of these: it puts the farthest-reaching loop first, and adds a cone's apex as a vertex loop.
15. **Trims made** where asked: every edge use's (u, v) trim, growing edge and vertex tolerances to cover the gaps found; a failure only warns. (Unhealed, the tessellator makes them as it needs them.)
16. **The infinite region set:** one region, void; two, the infinite one found again by ray casting, it void and the other solid; more, acted on only if the infinite one isn't void.

Whenever a fix adds topology, the sequence runs again on the new objects up to the step reached. Never done: a surface turned over, 3D gaps closed by editing geometry (only tolerances grow), non-manifold edges handled.

### Orientation and regions

- **The structure** is radial-edge: each face has an upward use (its normal's side) and a mate, uses in shells, shells in regions, one region infinite.
- **Outside is found by ray casting, not volume:** from a point beyond the bounding box at the nearest of a few samples on the split shell's edges (non-seam ones preferred), the nearest hit's local sector giving the region on the ray's side; fallbacks other samples, the opposite corner, the whole B-rep.
- **So** the enclosed side of a closed shell becomes the solid region whichever way its faces point; normals are never changed, only which region each use is in records it. Nested solids and voids are handled by a flag routine *(inferred: never reached for us, whose builder gives each closed shell a B-rep of its own)*.
- **The tessellator** winds polygons about the surface normal and reverses a face's where its upward use's region isn't the infinite one, so SMLib's own mesh of a healed closed shell faces out of the enclosed volume, whatever the input's orientation *(inferred)*. Unhealed, every face is a sheet in the infinite region and polygons follow the surface normals.

### Limits

- **Scale:** absolute constants (1e-12 for tolerance flags and ray errors, 1e-6 for ray ties, the approximation tolerance for degenerate edges) and the band from the longest edge make results depend on size: a face retried alone takes its band from its own longest edge, and 1,024 times larger falls in another band *(inferred: one reason the scaled retries change outcomes)*.
- **Order:** the cache steps compare against the context's zone tolerance, which the last healed B-rep set, the fixes against the B-rep's (results depended on build order in the corpus runs' pools: our builder resets the context).
- **Missing:** edge merging, gap closing, loop repair; a circle of tiny edges can fool the degenerate test (its own comment); one ray decides a whole shell, so a self-touching shell can be misclassified *(inferred)*.

### What our SMLib wrapper does

- **The builder** (`packages/tess-smlib/native/smlib_build.cpp`) gives each shell (or group of open shells) its own B-rep, as one void region and one shell holding both uses of every face, tolerances the part's uncertainty (1e-5 mm without one) and vertices 1.01 times their gaps, and heals by default. Before each build and each B-rep it puts the shared context's model size estimate and zone tolerance back to their defaults, so what the healer wrote for one B-rep doesn't carry into the next (without the reset a part's mesh could depend on what its worker built before it: no difference in 48 orderings of pairs tried by hand, but in the corpus runs' pools `bug24383_224013.stp` #11's face #12431 meshed or not, and `stepconv_corpus` placed 47,133 triangles more or fewer; with it, every part of the 26 files SMLib meshes in the end-to-end run comes out as in a fresh module). After the build it turns each SMLib face whose sense is against the model's, and again where the tessellator will turn it (its upward use not in the infinite region), so the mesh follows the model's orientation rather than SMLib's outward one: that's why sources' inward voids come out as the model has them and `cad-scene`'s `orientResult` turns them (`docs/backends.md`).
- **The wrapper** (`smlib_tess.cpp`) meshes each B-rep, measures and judges its faces by model face (pieces of a seam split summed), and rebuilds a face judged bad, without a mesh, or squeezed away by the healer, alone: unhealed, healed, then both at 1,024 times the size (lengths scaled before building; smaller scales trap), first passing mesh kept.

## Missing p-curves: how each backend makes them

When an edge's use by a face has no p-curve (the model's `coedge.pcurve` -1: usual on planes, common elsewhere; `brep-reference.md`), the backend makes its boundary in the face's (u, v) from the edge's 3D curve. Analytic results are the exception: a plane's, and an iso-parameter line's; the rest is approximated from sampled points. (From reading the sources; not measured.)

### OCCT

- **Planes, always exact, never stored.** The STEP translator discards a file's p-curves on planes (it recomputes them), and our native builder gives none there (`occt_build.cpp`, as the translator does). Whoever asks for one (`BRep_Tool::CurveOnSurface`, its plane fallback) gets it computed again each time: the 3D curve projected along the plane's normal (`GeomProjLib::ProjectOnPlane`) and mapped into the plane's (u, v) (`ProjLib_Plane`, `ProjLib_ComputeApprox`): lines and conics stay lines and conics, B-splines and Beziers are mapped by their poles (parallel projection is affine), so exact; only rarities (offset curves, conics it can't rebuild) are fitted (at 1e-6). The mesher reads them the same way, so a plane's boundary in (u, v) is exact.
- **Other surfaces: the model's p-curve where it has one** (converted to OCCT's parameterization: a 2D line or conic stays one; `occt_build.cpp`), its range set from the vertices' projections (`ShapeFix_EdgeProjAux`), dropped if that fails.
- **Else built by healing** (`ShapeFix_Edge::FixAddPCurve`, `ShapeConstruct_ProjectCurveOnSurface`), at the healing precision (the part's uncertainty):
  - a trimmed or offset plane, and B-splines whose speed varies over 1500 times between knot spans, go through the projection library (below);
  - otherwise the 3D curve is **sampled**: 23 points evenly spaced in its parameter (for a B-spline, raised in steps of 22 to at least its spans times degree + 1), each projected onto the surface, period jumps unwrapped, poles and degenerate ends handled;
  - **a 2D line where the samples fit one:** where (u, v) linear in the curve's parameter puts every sample within the precision of the surface's normal at it, the result is an exact 2D line (or a two-pole linear B-spline where the 2D speed isn't 1). That covers a circle coaxial with a cylinder, cone, sphere or torus, a sphere's or torus's meridian, a cylinder's or cone's generatrix *(inferred from the parameterizations)*. It's checked at the samples only, so a nearly straight curve passes as a line within the precision;
  - **otherwise a cubic interpolant** (`Geom2dAPI_Interpolate`, C2) through the projected samples at their 3D parameters: exact at them, unchecked between them. A tolerance-driven fit (`approximatePCurve`) is in the file but not called in this version. The deviation is left to the edge's tolerance, which same-parameter then raises to cover it *(inferred)*.
- **The projection library** (`ProjLib`) has exact cases, all 2D lines but the plane's: on a cylinder a line along the axis and a circle about it, on a cone a generatrix and a coaxial circle, on a sphere a meridian and a parallel, on a torus a parallel and a meridian; conics on a plane stay conics. Otherwise it fits B-splines: on elementary surfaces from their closed-form inverse (degree 5 to 10, up to 1000 segments), on B-spline and Bezier surfaces always approximated (trimmed at poles), on other surfaces approximated within the tolerance. From healing it's reached only in the cases above.

### SMLib

- **The model's p-curves are never passed:** the builder gives SMLib 3D curves, vertices and surfaces (`smlib_build.cpp`), and SMLib makes every trim: in the healer's last step (`SmFace::CreateUVTrimCurves`), or unhealed, in the tessellator as needed.
- **Per edge use** (`SmEdgeuse::CreateUVTrimCurve`), three tries: (1) an edge whose curve is already a curve on this surface has its 2D curve copied (our builder never makes one); (2) the curve dropped onto the surface (`SmSurface::DropCurve`, falling back to dropping and trimming) at the edge's tolerance, in up to 4 rounds, later ones at twice the measured edge-to-face gap, with recoveries for reversed curves, singular ends and seams; (3) as a last resort 101 evenly spaced samples inverted onto the surface and a B-spline interpolated through them, with a warning.
- **Exact cases:** on a **plane** (`SmPlane::DropCurve`, the only override) a line is an exact 2D line, and any B-spline (SMLib's lines and conics are B-splines) has its control points mapped by the plane's affine (u, v) map, degree, knots and weights kept, so exact; it falls back to the general drop where a mapped control point would leave the domain by more than the tolerance. On **any surface**, a curve along an iso-parameter line (start tangent within 1 degree of the surface's u or v derivative, samples agreeing) is an exact 2D line (`SmSurface::DropIsoCurve`). That needs the curve's parameterization to match the surface's, and SMLib holds cylinders, cones, spheres and tori as rational B-splines: whether our circles and generatrices pass it isn't known *(not checked)*.
- **Otherwise approximated:** along each span of the curve, points inverted onto the surface (closed form on planes, surfaces of revolution and extrusions, iterative on B-splines), each span a cubic Hermite segment from its ends' (u, v) and (u, v) tangents, tested at 3 interior points against the edge's tolerance (measured in 3D) and bisected until it passes (spans under 1/1000 of the interval accepted as they are); the segments one piecewise cubic B-spline on the edge's interval; seams and poles handled. Gaps between trims at loop corners are then closed by moving end control points, and vertex tolerances widened to twice the 3D gap where asked.

### truck

- **No p-curves in meshing** (`truck-meshalgo`'s triangulation): each edge's 3D curve sampled into a polyline within the linear deflection (recursive bisection while a point is farther than the deflection from its chord: a line gives 2 points), each vertex inverted onto the surface (searched from the previous point's (u, v), then without a hint, then by nearest point), periods unwrapped, a point added at poles, loops round a seam closed along the domain's edges. So its boundaries in (u, v) are always polylines.
- **The inversion per point:** closed form on planes, spheres and tori, and *(inferred)* on cylinders and cones (revolved lines in our crate); a search with Newton steps on extrusions and B-splines.
- **The model's p-curves** are used only for an edge without a 3D curve: its first p-curve composed with its surface is its 3D curve (`packages/tess-truck/native/src/model.rs`), then sampled like any other.

### So

The model's own p-curves are used as given only by OCCT, on faces other than planes. OCCT recomputes p-curves on planes, exactly; SMLib recomputes them on every face, exactly only on planes and iso-lines; truck works from sampled points. P-curves of our own (for an exporter, a kernel, or meshing in (u, v)) could be exact by a table: every kind on a plane (an affine map), the iso-lines of elementary surfaces (coaxial circles, generatrices, meridians: 2D lines), and the curves whose image is itself a conic or line in (u, v) where the parameterizations agree; the rest a fit checked against the 3D curve between samples, not only at them (`docs/shape-interrogation.md`).

## What this means for our own healing

- **Orientation.** Both decide by one ray, OCCT per shell from inside a face, SMLib from outside the box; neither uses volume. A ray is exact geometry (curve and surface intersection), so a healer of ours on the B-rep model needs the shape interrogation `docs/shape-interrogation.md` describes; on meshes, the signed volume (`orientResult`) is sure where the mesh is closed. OCCT's nesting test for voids (vertices of one shell classified against another) is the part a model-level pass would also need.
- **Tolerances.** OCCT grows tolerances, uncapped in places; SMLib replaces them from measured gaps and its longest-edge band. Neither keeps the source's tolerances, so their measures and meshes reflect healed models: a healer of ours should say where it grows a tolerance and by how much.
- **Topology.** Neither sews (OCCT doesn't on STEP import, SMLib merges only vertices); both drop or squeeze small things (OCCT small wires on loose faces, SMLib degenerate faces and edges), which is how faces go missing from their meshes. OCCT fixes wire order and orientation where SMLib's loop repair is off, which is why our SMLib builder does those itself. Ours changes topology in one fix, `coincidentEdges` (`docs/own-tessellator.md`, "Edges coincident within their tolerance"): two consecutive edges of a loop leaving their vertex together and within their tolerance of each other are merged up to where they part, and a face left with no area (a sliver between two such edges) removed, said per part; the analysis then keeps the source model whole, so healing again, or with the fix off, starts from it. Another, `trimOvershoot` ("Edges overshooting their crossing" there), moves a vertex: two consecutive edges whose curves cross near it and run on past the crossing are trimmed there, the vertex moved to it; the analysis keeps the source model then too. And `vertexOnEdge` ("Loops meeting at a point" there) gives two loops of a face that meet at a point to rounding, without a shared vertex, one there: an edge split at the other loop's vertex, or two coincident vertices merged.
