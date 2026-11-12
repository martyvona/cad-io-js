# The B-rep model: a reference

What a part's B-rep model (`cad-brep`'s `BrepData`) can hold and what every row means: each geometry and topology kind with its definition, parameterization, orientation and the values a source may leave out, then what a tessellation backend must do with a model and what code that creates or edits models must keep true. Written so that a backend or an editor can be built from this note and `packages/cad-brep` alone, without reading an existing backend. Why the model is as it is (its decisions, phases and alternatives) is in [`brep-model.md`](brep-model.md); OCCT's native builder (`packages/tess-occt/native/occt_build.cpp`) is one complete consumer, cited here only as a reference for how a kernel can take each kind.

The format itself is `packages/cad-brep/src/layout.ts` (tables, columns, kinds, pool layouts), mirrored for C and C++ by the generated `packages/cad-brep/include/cad_brep.h`. The rows as TypeScript objects are `packages/cad-brep/src/types.ts`; the evaluators that define the parameterizations in code are `packages/cad-brep/src/geometry.ts`. Where this note and those files disagree, the files are the format and this note is wrong.

## Where models live

- **One model per part.** A scene part (`cad-scene`'s `Part`) with exact geometry has `part.brep`: `{ model: BrepData, format, vertexBox?, outline? }`. `model` is the part's whole B-rep; `format` the source format (`'step'`, `'iges'`, `'brep'`); `vertexBox` the box of its vertices (an estimate of where the part is before meshing, not a bound); `outline` a function giving faces' outlines for display when meshing fails (`cad-brep`'s `faceOutlines`).
- **Coordinates:** the part's own, in its length unit (`part.unit`, millimetres per unit, also in the model's `part` row). Placements of the part in the assembly are the scene's, outside the model. `part.origin` is a point near the geometry that backends subtract (in double precision) before converting positions to `Float32`.
- **Ids:** every row may carry its source's id (STEP: the `#` number), `NaN` for none. Faces' ids are what meshes, face colours (`part.faceMaterials`), measures (`part.measures`), picking and failure reports are keyed by, and edges' ids what meshing results name edge polylines and wireframe curves by, so they matter beyond the model.
- **Immutable by convention.** A `BrepData` is views over one `ArrayBuffer`; nothing writes into it after it's built. Caches key on its bytes (`tess-cache`), and pools copy it to workers. Editing means building a new buffer (see "Creating and editing models").

## The buffer

- **Layout:** `MAGIC` (`'CBR2'`, the digit the format's version), a column count, then per column its byte offset and element count, then the columns, each 8-byte aligned, in `TABLES` order (`packages/cad-brep/src/data.ts`). Little-endian; the builder refuses big-endian platforms. `openBrep(buffer)` checks the header and gives typed-array views (`d.edge.curve[i]`); `rowCount(d, table)` the rows.
- **Tables** (one row per entity): `part` (exactly one row: `unit`, `uncertainty`), `curve`, `surface`, `vertex`, `edge`, `coedge`, `loop`, `face`, `shell`, `body`, `faceUse`, `member`, `item`, and `pool`: independent arrays of variable-length data, a pair per owning table (`curveReal`, `curveInt`, `surfaceReal`, `surfaceInt`), `loopInt` (poly loops' corners, vertex rows) and `itemReal` (points and transforms).
- **Column types:** `u8` (kinds, flags, booleans 0/1), `i32` (references, offsets, counts), `f64` (everything numeric, ids included so that `NaN` can mean none).
- **References** are row indices into a named table, -1 for none. Curves refer only to earlier curves, surfaces to earlier surfaces and to any curve, an instance item to an earlier item: no cycles, and a reader can build rows in order. Topology refers to rows that exist; the builder requires them added first.
- **Ranges owned by one row:** a face's loops (`firstLoop`, `loopCount` in `loop`), an edge loop's coedges (`first`, `count` in `coedge`), a shell's face uses (`first`, `count` in `faceUse`), a body's members (`first`, `count` in `member`) are contiguous and belong to exactly one owner. A face, an edge, a vertex or a curve can be shared by many users; a coedge, a loop, a face use or a member can't.
- **Absent values:** `NaN` for a number the source doesn't give (tolerances, ranges, ids, a trim's parameter or point), -1 for a reference. Nothing is computed at import that a consumer might compute differently (rule 7 below), so absence is common and backends must derive what they need.
- **Pools:** a curve or surface row's `real` and `int` are offsets into its table's pools; what follows is laid out by kind (`CURVE_LAYOUTS`, `SURFACE_LAYOUTS` in `layout.ts`; the same as text in `cad_brep.h`). Readers walk them through the decoders (`decode.curve(d, i)` etc.) or directly.
- **Deterministic:** the same rows give the same bytes; rows come in the order the source's structure was walked.

## Rules every model keeps

From [`brep-model.md`](brep-model.md), "Rules the model fixes"; every importer must produce them and every consumer may rely on them:

1. **Part 42's parameterizations, angles in radians.** Each curve and surface kind is parameterized as ISO 10303-42 defines it (given per kind below), whatever the source format used; trim parameters, p-curve coordinates and ranges are in those parameters. A consumer whose kernel parameterizes differently converts (see "Parameterizations other kernels use").
2. **Placements complete:** origin, axis and x direction orthonormal and right-handed, Part 42's defaults filled in; directions of unit length, with a magnitude kept where it parameterizes (lines, extrusions).
3. **Geometry in the part's length unit**; the part's uncertainty (the distance below which points are the same, STEP's context uncertainty) beside it, `NaN` if the source has none.
4. **Specialized B-spline forms explicit:** uniform, quasi-uniform, Bezier and piecewise Bezier knots are written out (as OCCT's STEP reader derives them), so every B-spline has knots and multiplicities.
5. **P-curves on coedges:** a curve in a face's surface's (u, v) belongs to the edge's use by that face, a seam's two p-curves to its two uses.
6. **Ids:** every face, edge and vertex has its source's id where the source has one, unique within the part (duplicates are kept and warned of by validation).
7. **What a source leaves out stays absent:** 3D curves, p-curves, edge ranges, tolerances.
8. **Deterministic.**

## Geometry

### Conventions

- **A curve's `dim`** is 3 (a space curve: an edge's curve, a loose curve, a swept or revolved profile) or 2 (a p-curve's geometry, in a surface's (u, v)). Both use the same kinds and layouts with 2 or 3 numbers per point; a 2D curve refers only to 2D curves, a 3D one to 3D ones.
- **A 3D placement** is 9 reals: origin $o$, axis $z$, x direction $x$, orthonormal, with $y = z \times x$. **A 2D placement** is 4 reals: origin and $x$; $y$ is $x$ turned +90 degrees, $(-x_2, x_1)$.
- **LOGICAL** values (closed, self-intersecting) are 0 false, 1 true, 2 unknown: a source's claim, never computed.
- **Forms** (`CURVE_FORMS`, `SURFACE_FORMS`): Part 42's descriptive enumeration for a B-spline (`circular_arc`, `cylindrical_surf`, ...): a hint from the source, not a guarantee.
- **Natural range:** the parameter interval a curve or surface is defined on: infinite for lines, hyperbolas, parabolas, planes, a cylinder's or cone's v; $[0, 2\pi)$ periodic for circles, ellipses and angular coordinates; the knot interval for B-splines. `curveEvaluator(d, i)` and `surfaceEvaluator(d, i)` give it as `range` (curves) and `u`, `v` (surfaces), with `period`, `uPeriod`, `vPeriod` where periodic.
- **Direction:** a curve's direction is that of increasing parameter, except where a trimmed or composite curve says otherwise (below). A surface's normal is $S_u \times S_v$ (`normalAt`); a face's side is that normal turned by the face's `sameSense` (see "Orientation").
- **Evaluation:** `curveEvaluator` gives `point(t)`, `d1(t)` and `param(p)` (a point's parameter: closed form for lines and conics, nearest-point search otherwise); `surfaceEvaluator` gives `point(u, v)`, `d1(u, v)` (both partials) and, for elementary surfaces and trims and offsets of them, `params(p)`. These are the reference definitions; a backend may evaluate with its own kernel but must agree with them.

### Curves

Each kind with its pool layout (reals; ints), its definition $C(t)$, natural range and notes. Validation's value checks (`validateBrep`) are noted where they constrain a source.

- **`line`** (reals: point $p$ ($d$), unit direction $u$ ($d$), magnitude $m > 0$). $C(t) = p + t\,m\,u$: the parameter is distance along the line divided by the magnitude (Part 42's `LINE` with its `VECTOR`). Range infinite. A line used as an edge's curve is bounded by the edge's vertices or range.
- **`circle`** (placement, radius $r > 0$). $C(t) = o + r\cos t\,x + r\sin t\,y$; range $[0, 2\pi)$, period $2\pi$; $t$ is the angle from the placement's $x$.
- **`ellipse`** (placement, semi-axes $a$ along $x$, $b$ along $y$, both $> 0$). $C(t) = o + a\cos t\,x + b\sin t\,y$; period $2\pi$. Either semi-axis may be the longer (Part 42 allows it); kernels that need $x$ along the major axis must turn the frame and shift $t$ by $\pi/2$ (see "Parameterizations other kernels use").
- **`hyperbola`** (placement, semi-axis $a > 0$, imaginary semi-axis $b > 0$). $C(t) = o + a\cosh t\,x + b\sinh t\,y$ (one branch); range infinite.
- **`parabola`** (placement, focal distance $f \neq 0$). $C(t) = o + f(t^2 x + 2t\,y)$; range infinite. Part 42 and validation allow a negative $f$, the parabola opening along $-x$; some kernels require $f > 0$ (OCCT's `Geom_Parabola`), and a negative one can be made positive by turning the frame half a turn about $z$ ($x, y \to -x, -y$), which keeps $t$.
- **`bspline`** (ints: degree $p \geq 1$, pole count $n$, knot count $k$, rational 0/1, closed (LOGICAL), self-intersecting (LOGICAL), form, then $k$ multiplicities; reals: $k$ knots, $n$ poles of $d$ numbers, then $n$ weights if rational). Knots are distinct and strictly increasing with multiplicities $m_i$; the full knot vector $U$ repeats each knot by its multiplicity and has $n + p + 1$ entries. $C(t) = \sum_i N_{i,p}(t)\,w_i P_i / \sum_i N_{i,p}(t)\,w_i$ (all $w_i = 1$ if not rational; Piegl and Tiller's definitions, `geometry.ts`). Range $[U_p, U_n]$ (zero-based: the $(p+1)$-th knot to the $(n+1)$-th of the full vector). Interior multiplicities are at most $p$, the end ones at most $p + 1$: Part 42 allows **unclamped** ends (end multiplicity below $p + 1$; the uniform form has every multiplicity 1), where the curve doesn't start at its first pole; kernels that need clamped curves must clamp them, keeping the range. Weights are positive. There is no periodic flag: a source's periodic B-spline arrives as a closed curve with its knots written out; whether to treat it as periodic (OCCT does when its knots are in periodic form, or when said closed, of degree 2 or more, and closed in fact) is the consumer's choice.
- **`polyline`** (ints: point count $n \geq 2$; reals: the points). Segment $k$ runs from point $k$ to point $k+1$ over $t \in [k, k+1]$; range $[0, n-1]$. (Part 42 doesn't define a polyline's parameterization; this one is OCCT's, and the library's.)
- **`trimmed`** (ints: basis curve, sense agreement 0/1, master representation (`TRIM_PREFERENCES`: unspecified, parameter, cartesian); reals: trim 1 parameter, trim 2 parameter, trim 1 point ($d$), trim 2 point ($d$), each `NaN` if not given). A piece of the basis curve from trim 1 to trim 2. Each trim may be given by a parameter on the basis, a point on it, or both; where both are given they should agree, and the master representation says which to believe (unspecified: either; OCCT's reader takes the parameter where given). A point is turned into a parameter by projection onto the basis. With sense agreement true the trimmed curve runs from trim 1 to trim 2 in the basis's direction (on a closed basis, the arc reached by increasing parameter, $t_2$ taken one period on if $t_2 \leq t_1$); with false it runs from trim 1 to trim 2 against the basis's direction (the other arc on a closed basis), and the trimmed curve's own direction is the basis's reversed. Parameters on a trimmed curve (an edge's range) are the basis's: `geometry.ts`'s evaluator keeps the basis's parameter and gives the range sorted, $[\min(t_1, t_2), \max(t_1, t_2)]$, so its `d1` points along the basis even when the trimmed curve runs against it. Equal trims on a closed basis mean the whole curve once round. Trims on circles and ellipses are in radians.
- **`composite`** (ints: segment count $n \geq 1$, self-intersecting (LOGICAL), then per segment: curve, same sense 0/1, transition (`TRANSITIONS`: discontinuous, continuous, same gradient, same curvature)). Segments joined end to end, each run with or against its own direction as `same sense` says; the segments must be bounded curves (trimmed curves, B-splines, polylines). The library parameterizes segment $k$ over $[k, k+1]$, mapped linearly onto the segment's own range (reversed where it runs against itself); range $[0, n]$. (The library's choice, `geometry.ts`, not taken from Part 42; it is not affine in any segment's parameter, so p-curves and trims can't refer to a composite through a fixed parameter map.) Transitions are the source's claims. In the corpus, composites occur as loose curves and as the boundaries of curve-bounded surfaces, never as an edge's curve.
- **`offset`** (ints: basis curve, self-intersecting (LOGICAL); reals: distance $\delta$, then in 3D a unit reference direction $V$). 3D: $C(t) = B(t) + \delta\,\widehat{B'(t) \times V}$; 2D: $C(t) = B(t) + \delta\,\widehat{(B'_2(t), -B'_1(t))}$ (the tangent turned -90 degrees, to the right). Parameter and range the basis's; the library's derivative is numerical. (Part 42's `OFFSET_CURVE_3D` and `OFFSET_CURVE_2D`; the formulas are OCCT's, which the library follows.)

### Surfaces

Each kind with its pool layout, its definition $S(u, v)$, natural ranges and normal $N = S_u \times S_v$ (before a face's sense turns it). All placements are 3D.

- **`plane`** (placement). $S(u, v) = o + u\,x + v\,y$; ranges infinite; normal $z$. A plane face always has loops (no natural bounds).
- **`cylinder`** (placement, radius $r > 0$). $S(u, v) = o + r(\cos u\,x + \sin u\,y) + v\,z$; $u \in [0, 2\pi)$ periodic, $v$ infinite; normal outward from the axis.
- **`cone`** (placement, radius $r \geq 0$ at $v = 0$, semi-angle $\alpha$, $0 < |\alpha| < \pi/2$ in radians). $S(u, v) = o + (r + v\tan\alpha)(\cos u\,x + \sin u\,y) + v\,z$: $v$ runs along the axis (not along the slant), the apex at $v = -r/\tan\alpha$. $u$ periodic, $v$ infinite; normal outward where $r + v\tan\alpha > 0$. Faces with an apex usually reach it by a degenerate edge or a vertex loop (see "Poles and apexes").
- **`sphere`** (placement, radius $R > 0$). $S(u, v) = o + R\cos v(\cos u\,x + \sin u\,y) + R\sin v\,z$; $u \in [0, 2\pi)$ periodic, $v \in [-\pi/2, \pi/2]$ (latitude); poles at $v = \pm\pi/2$; normal outward.
- **`torus`** (placement, major radius $R > 0$, minor radius $r > 0$; ints: degenerate 0/1, select outer 0/1). $S(u, v) = o + (R + r\cos v)(\cos u\,x + \sin u\,y) + r\sin v\,z$; both periodic, $[0, 2\pi)$; normal outward from the tube. **Degenerate** (Part 42's `DEGENERATE_TOROIDAL_SURFACE`): $R < r$, the tube crossing the axis (a spindle torus), with `select outer` choosing the outer or inner part; validation requires $R < r$ when degenerate and select outer 0 when not. OCCT's reader ignores `select outer` and reads a degenerate torus as a plain one (its builder warns).
- **`bspline`** (ints: u degree $p$, v degree $q$, pole counts $n_u$, $n_v$, knot counts $k_u$, $k_v$, rational 0/1, u closed, v closed, self-intersecting (LOGICAL each), form, then $k_u$ u multiplicities, $k_v$ v multiplicities; reals: $k_u$ u knots, $k_v$ v knots, poles $n_u \times n_v \times 3$ u-major (pole $(i, j)$ at $i\,n_v + j$), then weights $n_u \times n_v$ if rational). $S(u, v) = \sum_{i,j} N_{i,p}(u)N_{j,q}(v)\,w_{ij}P_{ij} / \sum_{i,j} N_{i,p}(u)N_{j,q}(v)\,w_{ij}$; ranges the knot intervals as for curves; the same multiplicity rules (unclamped allowed), positive weights, no periodic flag. A surface closed in u or v (said so, or in fact) has a seam there; some kernels need it in periodic form to treat the seam as one (OCCT does: `ConvertToPeriodic`).
- **`extrusion`** (ints: swept curve (3D); reals: unit direction $D$, magnitude $m$). $S(u, v) = C(u) + v\,m\,D$: $u$ the curve's parameter (its range and period), $v$ in units of the magnitude; normal $C'(u) \times m D$.
- **`revolution`** (ints: swept curve (3D); reals: axis point $A$, unit axis direction $a$). $S(u, v)$ is $C(v)$ turned by angle $u$ about the axis through $A$ along $a$ (right-handed about $a$, Rodrigues' formula in `geometry.ts`): $u \in [0, 2\pi)$ periodic, $v$ the curve's parameter. Note the roles: u is the angle, v the profile's parameter.
- **`offset`** (ints: basis surface, self-intersecting (LOGICAL); reals: distance $\delta$). $S(u, v) = B(u, v) + \delta\,\widehat{B_u \times B_v}$: the basis's parameters and ranges, moved along its unit normal. The basis's parameter map (if a kernel needs one) carries over unchanged. Where the basis's normal vanishes (a pole) the offset is undefined.
- **`rectangularTrimmed`** (ints: basis surface, u sense 0/1, v sense 0/1; reals: $u_1, u_2, v_1, v_2$, with $u_1 \neq u_2$, $v_1 \neq v_2$). The basis restricted to $[u_1, u_2] \times [v_1, v_2]$ in its own parameters (angles in radians); `u sense` and `v sense` say whether the trimmed surface's parameters run with the basis's (Part 42's `RECTANGULAR_TRIMMED_SURFACE`; the library's evaluator keeps the basis's parameters and sorts the bounds). A face on one may have loops or none (then the rectangle bounds it).
- **`curveSwept`** (ints: swept curve, directrix curve, reference surface) and **`fixedReferenceSwept`** (ints: swept curve, directrix curve; reals: fixed reference direction): Part 42's `SURFACE_CURVE_SWEPT_SURFACE` and `FIXED_REFERENCE_SWEPT_SURFACE`, a profile moved along a directrix with a frame from a reference surface or direction. Held but **not evaluated** by the library (their evaluators are undefined); OCCT has no counterpart, and OCCT's STEP reader and our native builder drop faces on them (the builder with a warning). None in the corpus. A backend may support them from Part 42's definitions or drop their faces with a warning.

### Parameterizations other kernels use

A kernel whose curves and surfaces are parameterized otherwise must convert every parameter that refers to one: trim parameters, edge ranges, coedge ranges, p-curves (2D points in (u, v)) and rectangular trims. For the kinds below the conversion is affine, $t' = f\,t + s$ per coordinate; OCCT's, as the native builder converts them (`curveParam`, `surfaceParams` in `occt_build.cpp`):

| Kind | Part 42 | OCCT | Map |
|---|---|---|---|
| line | distance / magnitude | distance | $t' = m\,t$ |
| ellipse with $a < b$ | $x$ along $a$ | $x$ along the major axis | frame turned ($x' = x \times z$), $t' = t + \pi/2$ |
| parabola | $o + f(t^2x + 2ty)$ | $o + \frac{u^2}{4f}x + u\,y$ | $u = 2f\,t$ |
| cone | $v$ along the axis | $v$ along the slant | $v' = v / \cos\alpha$ |
| extrusion | $v$ in units of $m$ | $v$ distance | $u$ as the curve's map, $v' = m\,v$ |
| revolution | | | $u$ unchanged, $v$ as the profile curve's map |
| offset, rectangular trimmed | | | the basis's map |
| trimmed curve | | | the basis's map |
| composite | not affine | | no fixed map: a kernel needs the segment |

The other kinds (circle, hyperbola, B-splines, polyline, plane, cylinder, sphere, torus) agree with OCCT. A negative factor (a parabola with negative $f$) would reverse a coordinate, turning normals and the sides of p-curves over; a kernel that takes such a case must account for it (open: OCCT's builder passes a negative focal distance to `Geom_Parabola`, which documents a construction error for it, and OCCT is built with exceptions compiled out; untested).

## Topology

### The entities

- **`vertex`** (point (3), tolerance, id): a point. Its tolerance (`NaN` if not given) is the radius within which the edges meeting there may miss it. A vertex is an edge's end, a vertex loop's point or a poly loop's corner, or several of these; from STEP its id is the `VERTEX_POINT`'s, or for a corner of no `VERTEX_POINT` the `CARTESIAN_POINT`'s.
- **`edge`** (curve, start, end, sameSense, flags, range (2), tolerance, id): a bounded piece of a 3D curve, from its start vertex to its end vertex.
  - `curve`: a 3D curve row, or -1 where the source gives trims in parameter space only (the edge is then defined by its coedges' p-curves).
  - `start`, `end`: vertex rows, or both -1 (a curve-bounded surface's boundary segment, which the curve bounds itself); a closed edge (a full circle) has `start == end`. One without the other is warned of.
  - `sameSense`: whether start to end runs with the curve's direction (as Part 42 orients it: a trimmed curve's own sense included).
  - `flags`: `EDGE_FLAGS.degenerate` for an edge of no length (a pole or apex) from sources that mark them; STEP has no such mark.
  - `range`: the curve's parameters at start and at end (in that order, so decreasing where `sameSense` is false), `NaN` both where the source doesn't give them. STEP never does: its edges are bounded by vertices only. `edgeParams(d, e, evaluator)` derives a range from the vertices by projection, handling closed and periodic curves; a backend needs one before it can sample an edge.
  - `tolerance`: how far the edge's curve may be from the true boundary (`NaN`: none given).
  - An edge with neither a curve nor vertices must have uses, each with a p-curve (validation).
- **`coedge`** (edge, orientation, pcurve, range (2), id): an edge's use by one loop of one face.
  - `orientation` (`ORIENTATION`): `forward` (the loop runs the edge from start to end), `reversed` (end to start), `internal` (an edge inside the face, bounding nothing: a slit or a curve embedded in it), `external` (an edge outside the face, touching it). Internal and external uses needn't join their neighbours in the loop.
  - `pcurve`: a 2D curve in the face's surface's (u, v), or -1. Its parameter is the 3D curve's: a point at parameter $t$ on the p-curve maps through the surface onto the edge's curve at $t$ (Part 42's `SURFACE_CURVE`), so the edge's range applies to it. Usually absent on planes; often absent elsewhere (a backend must then compute p-curves by projecting the edge onto the surface).
  - `range`: the p-curve's parameters at the use's two ends, in the edge's start-to-end order, `NaN` if not given.
- **`loop`** (kind, bound, sense, first, count, id): one boundary of a face. `kind` (`LOOP_KIND`):
  - `edge`: `count` coedges from `first`, in order round the loop, each ending where the next starts (where both vertices are known and both uses are forward or reversed: validation checks it), the last back to the first.
  - `vertex`: a single vertex (`first`; `count` 1): a loop degenerated to a point, as at a cone's apex or a sphere's pole bounding a face that reaches it.
  - `poly`: a polygon of `count` $\geq 3$ corners, vertex rows listed from `first` in `pool.loopInt` (STEP's `POLY_LOOP`, faceted B-reps); its sides are straight, and there are no edge rows for them: faces whose poly loops have two consecutive corners in common (the same vertex rows, either order) share that side, as a source's shared points join them; coinciding but distinct vertices don't. A corner may also be an edge's vertex. A backend makes one edge per pair of corner rows, shared among the poly loops that use it.
  - `bound` (`BOUND`): `outer`, `inner` (a hole) or `unknown`. Sources mark at most one outer bound (Part 42 allows one; validation warns of more); where a face has an outer bound the importer marks the others inner; where it has none, every bound is `unknown` and the consumer must find which loop is outer, if any (by containment in (u, v), or area).
  - `sense`: whether the loop runs as listed (STEP's `FACE_BOUND.orientation`); false means the loop runs backwards: its coedges in reverse order, each reversed.
- **`face`** (surface, sameSense, firstLoop, loopCount, tolerance, id): a bounded region of a surface. `sameSense`: whether the face's normal is the surface's ($S_u \times S_v$) or its opposite. `loopCount` 0: no loops, the face is bounded by the surface's own extent (natural bounds: a whole sphere or torus, a closed B-spline surface, a rectangular trimmed surface; meaningless on an unbounded surface such as a plane).
- **`shell`** (kind, first, count, id): faces used together, `count` face uses from `first` in `faceUse`. `kind` (`SHELL_KIND`): `closed` (bounds a volume: every edge used twice, the faces' normals consistently outward), `open` (a connected sheet with free edges) or `faceSet` (faces with no claim of connection: STEP's `CONNECTED_FACE_SET`). Closed is the source's claim; real shells have gaps.
- **`faceUse`** (face, sense): a face in a shell, `sense` false for a face used reversed (STEP's `ORIENTED_FACE`). A face may appear in several shells (AP209 models share faces between solids).
- **`body`** (kind, first, count, id): `count` members from `first` in `member`. `kind` (`BODY_KIND`): `solid` (shells: the outer first, then voids; validation warns of non-closed shells in a solid), `sheet` (shells: a surface model), `wire` (edges: a wireframe model).
- **`member`** (ref, sense): a body's shell (solids and sheets) or edge (wires), `sense` false for one used reversed (STEP's `ORIENTED_CLOSED_SHELL`, a void's shell usually).
- **`item`** (kind, ref, transform, id): the part's roots; see "Items".

### Orientation

How the flags combine; everything a backend needs to put each face on the right side and its loops the right way round.

- **An edge's direction** is from its start vertex to its end vertex. On its curve that is the curve's direction if `sameSense`, else against it.
- **A coedge's direction** (its direction of travel round its loop) is the edge's if `forward`, the opposite if `reversed`. If the loop's `sense` is false, every coedge's direction is reversed again and the loop runs in reverse order.
- **A face's normal** is the surface's normal $S_u \times S_v$ if the face's `sameSense`, else its opposite. Used in a shell, a face use with `sense` false turns it over again, and a body member with `sense` false turns the whole shell over again. In a solid, the composed normals point out of the material: outward on the outer shell, into the void on a void's shell.
- **Loops and sides (Part 42):** travelling a loop in its direction (coedges' directions, after the loop's sense), with the face's normal pointing at the viewer, the face lies to the left: an outer loop runs counter-clockwise about the face's normal, holes clockwise. In (u, v), where $S_u \times S_v$ points at the viewer: the face lies to the left of each coedge's direction when the face's `sameSense` and the loop's `sense` agree, to the right when they don't.
- **Seams:** an edge used twice in one loop of a face (once forward, once reversed) is a seam: the face's boundary along a closed surface's period line (a cylinder's $u = 0$). Each use has its own p-curve (one at $u = 0$, one at $u = 2\pi$ on a cylinder), the face lying to the left of each in (u, v) as above. Where the source gives the seam's two p-curves but they can't be told apart, the importer gives neither use one (`step-import`, with an info diagnostic). An example: `packages/cad-brep/test/models.ts`'s `seamCylinder` (two circles, a seam line used forward with $u = 2\pi$ and reversed with $u = 0$).
- **Real data breaks these rules.** Loops wound against Part 42's rule, faces whose `sameSense` disagrees with their shell, shells turned inside out: the corpus has all of them (the area oracle flags loops wound the wrong way, `orientation`, `backends.md`). A backend shouldn't trust loop direction alone to tell a face's inside on a closed surface; OCCT's healing reorients wires and faces. After meshing, the host turns over closed shells whose meshes are inside out (`tessellateScene`'s `orient`), so a backend may leave that to it.

### Poles, apexes and degenerate edges

- A face reaching a sphere's pole or a cone's apex has, in (u, v), a boundary segment along $v = \pm\pi/2$ (sphere) or the apex's $v$ (cone) that is a single point in space. Sources show it three ways: a **degenerate edge** (an edge flagged degenerate, start and end at the pole, with a p-curve along the pole line: formats that have them), a **vertex loop** at the pole (STEP's `VERTEX_LOOP`), or nothing (the loop jumps along the pole line between two edges' ends, which in space is no jump). A backend must close the (u, v) boundary along the pole line itself in the last case. Our OCCT backend leaves the model's degenerate edges out and lets OCCT's healing make its own, and the STEP writer leaves them out of loops (a loop of nothing else a `VERTEX_LOOP` at the pole): STEP has no degenerate edges, and OCCT's analysis of a face fails with one built from the model's p-curve and range (`brep-model.md`, decision 25). So a degenerate edge's id doesn't survive OCCT.
- A vertex loop on its own (the face's only loop) on a sphere or B-spline surface means the face is the surface's natural extent with the point marked (OCCT takes natural bounds); on a plane or torus it bounds nothing and OCCT leaves it out with a warning.
- `models.ts`'s `spheres` builds a whole sphere with no loops and a hemisphere bounded by its equator and a vertex loop at the pole.

### Edges without curves or vertices

- **No 3D curve** (`curve` -1): the edge exists only in parameter space (sources with 2D trims; IGES and JT). Its geometry is any of its coedges' p-curve mapped through that face's surface; validation requires every use to have a p-curve when there are also no vertices.
- **No vertices** (`start`, `end` -1): the boundary segments of a **curve-bounded face** (STEP's `CURVE_BOUNDED_SURFACE`: a surface with boundary curves rather than edge loops). The importer makes a face on the basis surface with one loop per boundary, one edge per segment (its 3D curve and its p-curve where the source has them, `sameSense` true, the coedge `forward` or `reversed` by the segment's sense), segments in order but not joined by shared vertices; the consumer joins consecutive segments by their end points (OCCT: `ShapeFix_Wire`). With STEP's `implicit_outer` every boundary is an inner loop and the surface's own extent is the outer bound; otherwise the outer boundary is marked `outer`. The edges carry the segments' ids, so a backend that keeps them can name every boundary segment.

### Tolerances and gaps

The model keeps the source's coordinates: vertices are not projected onto their curves, nor curves trimmed to their vertices. Over the corpus, vertices sit off their edges' curves and loops fail to close by up to the part's uncertainty and sometimes more; p-curves map onto their 3D curves only within some distance; edges' curves stop short of or run past their vertices. A backend must tolerate it: OCCT's builder raises each vertex's tolerance to its distance from its edges' curves before healing, and its healing then fixes the rest. The part's uncertainty (`part.uncertainty`, in the part's unit) is the scale to work at; where absent, a backend picks its own (OCCT's builder takes its STEP reader's default precision, `DESTEP_Parameters().ReadPrecisionVal`).

## Items

The `item` table is what the part contains; each row is drawn (and meshed) once, at its transform:

- **`body`**: a solid, sheet or wire body (`ref`: a body row). A wire body's edges are wireframe curves.
- **`curve`**: a loose 3D curve (a geometric set's or wireframe's element), drawn over its natural range: unbounded curves (lines, hyperbolas, parabolas and offsets of them) can't be drawn and are left out by OCCT with a warning. A composite curve is drawn as its segments, each with the composite's id.
- **`surface`**: a loose bounded surface (a geometric set's), as a face over its natural bounds; unbounded ones can't be drawn.
- **`face`**: a face in no shell (a geometric set's `FACE_SURFACE` or `CURVE_BOUNDED_SURFACE`).
- **`point`**: a loose point; `ref` is the offset of its 3 reals in `pool.itemReal`.
- **`instance`**: another item, earlier in the table (`ref`), drawn again at this item's transform; the referenced item is also drawn on its own. An instance must have a transform. No importer makes instances yet (STEP's mapped items are placed by the scene instead); the format has them for sources that instance within a part.
- **`transform`**: the offset of 12 reals in `pool.itemReal`, or -1 for none: an affine map, column-major ($x$, $y$, $z$ columns, then the translation $t$): $p' = [x\;y\;z]\,p + t$, non-singular. Mirrors and scales are allowed by the format; a kernel that holds only similarities (OCCT: rotations, mirrors, uniform scales) must refuse others with an error. An instance of an item that has its own transform composes them: the referenced item's transform first, then the instance's.
- Items in parts that have face or surface items (geometric sets) are surface models without a solid's guarantees: OCCT's builder turns off healing's natural-bounds fix for them, as OCCT's STEP reader does.

## What real data looks like

From the corpus (517 STEP files, 3,258 parts; `brep-model.md`, "Coverage"): faces on planes, cylinders, cones, spheres, tori (a few degenerate), B-splines (plain, rational, quasi-uniform), extrusions, revolutions, rectangular trims and curve-bounded surfaces; edge curves lines, circles, ellipses, hyperbolas, parabolas, B-splines, polylines, trimmed curves, and edges with p-curves only; p-curves as 2D lines, B-splines and trimmed curves; loose curves (composites among them) and points; solids, voids, sheets, wire bodies, faceted B-reps with poly loops. Not in the corpus but in the format: offset curves and surfaces, Bezier and uniform B-splines, swept surfaces, oriented faces and shells in use, internal and external coedges, per-entity tolerances, instances. Points a backend will meet:

- Edge ranges are absent in every STEP model; p-curves are absent on planes and on many other faces.
- Seams with one p-curve or none; seams whose two p-curves coincide (CATIA writes an edge between two faces on one closed surface so).
- Closed B-spline curves and surfaces whose seam a kernel must recognize (closed but not periodic in form).
- Loops with no outer bound marked; faces with several outer bounds.
- Faces of no area, edges shorter than the uncertainty, vertices off their curves.
- A few parts that defeat OCCT entirely (`bug24024_slow_import.stp` #76247 runs out of WebAssembly's memory at the medium profile).

## Implementing a tessellation backend

### The contract

A backend implements `cad-scene`'s `Tessellator` (`packages/cad-scene/src/tessellator.ts`): `info` (name, version, license, `formats` including `'cad-brep'`, and whether it supports face ids, edges and curves), `init`, `tessellate(request)`, `dispose`, optionally `memoryBytes` and `timeoutMs`. One request is one part:

- **Request:** `format: 'cad-brep'`, `data` (the model's bytes: `openBrep(data)` reads them; copy if you keep them), `origin` (subtract it from every position in double precision before converting to `Float32`), `linearDeflection` (maximum distance between mesh and surface) and `angularDeflection` (radians, maximum angle between adjacent normals), both in the part's units; `edges` (also return the faces' edges as polylines), `measures` (also return each face's area, perimeter and soundness on the exact geometry, if the backend can).
- **Result:** `positions` (minus origin) and `indices`, optional `normals`; `faces`: index ranges that partition `indices`, each with `entityId` the face row's id (null where it has none; a face split into pieces may have several ranges); `edges` and `edgePositions` when asked (each edge's id or null, its kind: `shared`, `seam`, `free` or `degenerate`, and for shared edges the largest dihedral angle along it; points on mesh vertices); `curves` and `curvePositions` for wireframe curves (curve items and wire bodies' edges: edges in no face) with their ids; `points` and `pointIds` for loose points (point items: vertices in no edge); `measures` if asked; `outlines` for faces that produced no triangles, if the backend can; `diagnostics` (warnings for what it left out, errors for a part it couldn't mesh). Problems in the model are diagnostics, never throws; throw only for caller bugs (a format the backend doesn't take).
- **What the host does** (`tessellateScene`, `packages/cad-scene/src/tessellate.ts`): sends each part (deflections converted from millimetres to the part's unit), caches results by the model's bytes and the backend's version (so `info.version` must change whenever output could), drops degenerate triangles, turns over inside-out closed shells, judges each face's triangles against its measures (`faceFailures`; a face several shells use against its area times its uses, since a backend meshes it once in each under its one id) and draws outlines from the model (`faceOutlines`) for faces and parts that fail. A pool (`tess-workers`) runs backends in workers with a timeout.

### What a backend must handle

For each face: its surface (every kind above, or the face dropped with a warning naming the kind), its loops (edge, vertex and poly, `bound` unknown included, no loops), each coedge with or without a p-curve and a range, edges with or without a 3D curve or vertices, degenerate edges, seams, poles, the orientation rules, and the tolerances of real data. In practice, per face:

1. Evaluate the surface (`surfaceEvaluator`'s definitions) and, for each coedge, get the boundary in (u, v): the p-curve where given (over the coedge's range, else the edge's range), else the 3D edge (its range from `edgeParams` if absent) projected onto the surface (`params` for elementary surfaces, nearest-point search otherwise: `nearestParams`). Handle periodic coordinates: on a cylinder, a p-curve may cross $u = 2\pi$; keep the boundary continuous across the period, and use seams' two p-curves for the two sides.
2. Close the loop in (u, v): join consecutive coedges' ends within tolerance, add the pole line where a loop jumps along one, and orient each loop by the rules above (or by its area in (u, v) where the data is wrong).
3. Triangulate the region in (u, v) and refine until the deflections hold in space; shared edges must be sampled identically by both faces (sample each edge once, in space, and map the samples into each face's (u, v)), so the mesh is watertight where the B-rep is.
4. Emit triangles wound so their normals point along the face's normal (surface normal times `sameSense`; face use and member senses are the shell's business, and the host's orientation pass fixes inside-out shells).

A kernel with its own B-rep (as OCCT) instead builds its shapes from the rows and lets its own healing and mesher do this; `occt_build.cpp` shows one complete mapping.

### Checking a new backend

- Unit tests on `packages/cad-brep/test/models.ts`'s models (a cube, a box with a void, the seam cylinder, the spheres) and every curve and surface kind.
- Over the corpus, against OCCT face by face, as `corpus_checks/native_route.ts` compares OCCT's two routes and `corpus_checks/truck_occt.ts` compares truck with OCCT (ids, triangles, areas, orientation, edge points on the other's mesh); and against the area oracle (`corpus_checks/area_oracle.ts`: exact face areas on elementary surfaces by Green's theorem in (u, v), independent of any backend).
- Planted bugs (a semi-angle converted twice, a surface nudged, a face turned over) that the comparison must see.

## Creating and editing models

### The API

- **`BrepBuilder`** (`packages/cad-brep/src/builder.ts`): `new BrepBuilder({ unit, uncertainty? })`, then `addCurve`, `addSurface`, `addVertex`, `addEdge`, `addFace` (a face with its loops and their coedges inline), `addShell`, `addBody`, `addItem`, each taking a row as the plain object of `types.ts` and returning its row index; `finish()` gives the `BrepData` (deterministic; the builder can go on after it). It throws on what would make the buffer unreadable (a reference to a row not added yet, wrong dimensions, missing values): those are the caller's bugs. Values a source can get wrong (radii, knot vectors, loops that don't join) it accepts; `validateBrep` reports them.
- **`decode`** (`decode.curve(d, i)`, `decode.face(d, i)`, ...): rows back as the objects the builder took, so `builder.addX(decode.x(d, i))` copies a row (references then need remapping if rows move).
- **`brepToJson` / `brepFromJson`**: every row as JSON and back, for tests and debugging (not an exchange format).
- **`validateBrep(d)`**: the format's rules and Part 42's value constraints as diagnostics (errors and warnings, at most `MAX_DIAGNOSTICS`): references and pool ranges, ownership of every range, placements orthonormal, directions of unit length, positive radii and magnitudes, cone semi-angles in $(0, \pi/2)$ in absolute value, torus degeneracy, knot vectors fitting their poles and degrees, positive weights, trims given, loops joined, at most one outer bound, solids' shells closed, transforms non-singular, duplicate source ids. It doesn't evaluate: vertices on curves and p-curves on their edges are checked by `corpus_checks/brep_geometry.ts`, not here.

### Building a model

Add rows in dependency order: curves (a curve before any curve that refers to it), surfaces (after their curves and basis surfaces), vertices, edges, faces (each with its loops and coedges), shells, bodies, items (an instance after the item it places). Then:

- **Keep the rules:** Part 42's parameterizations, radians, the part's unit, complete orthonormal placements, unit directions; knots explicit and distinct with multiplicities; orientation as above (an outer loop counter-clockwise about the face's normal, holes clockwise; closed shells' normals outward); shared edges shared (one edge row used by both faces, once each way), not duplicated.
- **Give what you know:** edge ranges, p-curves and tolerances where the creator has them exactly (a modeller usually does); a consumer then needn't derive them. Leave them `NaN` or absent rather than guessing.
- **Ids:** face, edge and vertex ids unique within the part. Keep source ids on rows that survive an edit (meshes, colours, measures and picks are keyed by face id, edge polylines and wireframe curves by edge id); give new rows new ids (above the part's largest, as the STEP writer numbers new entities), or none (`NaN`: such faces mesh but can't be coloured, measured or picked by id).
- **Validate** the result (`validateBrep`) and treat errors as bugs.

`packages/cad-brep/test/models.ts` builds a box shell (8 vertices, 12 line edges with ranges, 6 plane faces with outer loops counter-clockwise from outside, one closed shell), a solid with a void (the void's shell as a member with `sense` false), the seam cylinder and the spheres: the patterns to copy.

### Editing a part in a scene

A model can't be changed in place. To edit: decode the rows, change them, build a new buffer with `BrepBuilder` (remapping row references where rows are added or removed; geometry must still come before what refers to it), validate it, then update the part:

- `part.brep.model` the new buffer; `part.brep.vertexBox` recomputed from the vertices; `part.brep.outline` rebuilt over the new model (a closure over `faceOutlines`; build it in a function that holds nothing else large, see `CLAUDE.md`, "What keeps a large object").
- The part's tessellated levels (`lods` with `from: 'tessellated'`) and `measures` are stale: drop them and mesh the part again (`tessellateScene` with `parts`). The mesh cache keys on the model's bytes, so it can't return stale meshes.
- `faceMaterials` and anything else keyed by face or edge id (the viewer's overrides, edge picks) follow the ids: keep ids stable across edits, and drop entries for faces and edges that are gone.
- `part.closed` (whether the faces bound solids) if the edit changes it; `part.unit` and `part.origin` if the geometry moved far.
- Exporters (`step-export` writes Part 42 entities from the model) and backends read the new model as they read an imported one; nothing refers to the source file.

A creator making a part from nothing does the same with a new `Part`: a name, `unit`, an `origin` near the geometry, `brep` with the model, and empty `lods` for `tessellateScene` to fill. `Brep.format` names an import format today (`'step'`, `'iges'`, `'brep'`); a model made by an editor has none of its own yet (open).
