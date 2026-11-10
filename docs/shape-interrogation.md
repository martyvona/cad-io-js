# Shape interrogation

Shape interrogation is computing things about exact curves and surfaces rather than meshes: points and derivatives (evaluation), the parameters of a point (inversion), the nearest point of a curve or surface to a point (projection), distances and intersections between curves and surfaces, and manipulations such as knot insertion and subdivision. Doing it robustly and fast is hard, even for a single Bezier patch, and for meshing we rely on the backends (OCCT, truck) to do it. This note records what our own code does today, what a rigorous implementation would need, the third-party libraries surveyed, and where it stands (README backlog, Geometry).

## What our code does today

Our own code, not dependencies; mesh algorithms (welding, manifold checks, edges, section caps, picking, the corpus checks' point-to-triangle distances) aren't shape interrogation and aren't listed.

At runtime:

- **`cad-brep`, `geometry.ts`:** evaluators for every curve and surface kind by Part 42's parameterizations, B-splines by Piegl and Tiller's basis functions (*The NURBS Book*; not Bernstein form), rational ones through weights; closed-form inverses (`param`, `params`) for lines, conics and the elementary surfaces, with their second branches (past a cone's apex, inside a spindle torus, a sphere's (u + pi, pi - v)); `normalAt`.
- **`nearestParam`** (`geometry.ts`): a point's parameter on a curve without a closed-form inverse (B-splines and the other kinds without a formula): 256 samples over the range, then bisection on the derivative of the squared distance around the best 4 sampled minima. Used at runtime through the curve evaluators' `param`: `edgeParams` (a vertex's parameter on its edge's curve, closed curves' periods fixed) and trimmed curves' trims given as points, so by `faceOutlines` whenever a face fails to mesh (the importer's scene: the viewer and `stepconv`).
- **`nearestParams`** (`geometry.ts`): a point's parameters on a surface: a grid of samples (8 a knot span each way on B-splines, at least 24), then Gauss-Newton steps, clamped to the ranges, from the best 4 local minima on the grid. Used only by the `brep_geometry` corpus check (a vertex's (u, v) on a B-spline face), though `cad-brep` exports it.
- **`cad-brep`, `outlines.ts`:** curves subdivided until their chords are within the deflections, p-curves mapped through their surfaces: sampling, no inversion beyond `edgeParams`.
- **`step-import`, `brep.ts`:** two judgements from evaluations: which of a seam's two p-curves each use takes (a side test at the p-curves' middle parameter), and whether two p-curves on one surface coincide (compared at 5 points of a bounded range, 3 of an unbounded one).
- **`tess-truck`'s Rust wrapper** (`lib.rs`, `clamp_bspline`): unclamped B-spline curves and surfaces clamped by knot insertion, in ordinary floating point.

In the corpus checks:

- **`area_oracle.ts`:** its own evaluators and its own `nearestParam`, and face areas by Green's theorem over each face's boundary.
- **`brep_geometry.ts`:** vertices on their curves and surfaces, p-curves along their edges, through `cad-brep`'s evaluators, `nearestParam` and `nearestParams`.

None of these is guaranteed: a sampling stage can miss the global minimum between samples, Newton and bisection can converge to the wrong local minimum or not at all, near-singular systems aren't detected, and everything is ordinary floating point.

## What a rigorous implementation needs

- **Branch and bound on conservative bounds.** A B-spline patch lies in the convex hull of its control points (for rational ones, with positive weights), so each knot span's control points bound its patch; a span whose bound is farther than the best distance found can be pruned. Many spans call for a bounding-volume tree over them for the broad phase; a single span of large extent can be split further by knot insertion until its bound is tight.
- **The objective in Bernstein form.** Polynomials, including the objective whose zeros or minima are sought, in Bernstein (B-spline) form where possible: the squared distance from a point to a surface is itself a scalar spline of twice the degree, whose coefficients bound it, so subdivision can prune by sign or by value ([Patrikalakis, Maekawa and Cho, Shape Interrogation for Computer Aided Design and Manufacturing, the Bernstein basis](https://web.mit.edu/hyperbook/Patrikalakis-Maekawa-Cho/node13w.html)).
- **Arithmetic.** Manipulations such as knot insertion may need rounded interval or exact rational arithmetic, which suggests C++ (user-defined numeric types and operator overloading) rather than TypeScript.
- **Guarded local methods.** Newton's method can fall into the wrong local minimum, fail to converge, or become ill conditioned. More robust methods such as the interval projected polyhedron algorithm ([IPP](https://web.mit.edu/hyperbook/Patrikalakis-Maekawa-Cho/node35.html)) applied judiciously, combined with Gauss-Newton for speed once a root is isolated.
- **Caching.** Bounds, trees and sample points (Newton's seeds) computed once per curve or surface, not per query.

## Delegating: libraries surveyed

A corpus check should be independent of the backend it checks, and a cross-check through another backend would commit us to always having two backends with reliable interrogation, so OCCT, truck and SMLib (a likely backend) were left out. Surveyed (2026-11-09):

- **[SISL](https://github.com/SINTEF-Geometry/SISL)** (SINTEF; C; AGPL-3.0-or-later, plus a Section 7(b) term that every data file created or manipulated using SISL keep SINTEF's producer line): its point-surface closest point, `s1954`, is global: it substitutes the surface into the equation of a sphere of radius zero about the point, giving the squared distance as a scalar spline, and finds its extrema (`s1921`, `s1161`: the boundary edges recursively, the interior by recursive subdivision `s1162` with box tests `s1190`); rational surfaces handled (`s1921` projects the spatial coefficients and keeps the weights). Its point-curve `s1774` is local Newton from a guess, its header warning of local minima; a global curve routine not yet confirmed. It would build to WebAssembly with our Emscripten toolchain for the Node checks. The strongest candidate, for the checks at least; its parent GoTools may also be considered as a backend.
- **[GoTools](https://www.sintef.no/globalassets/upload/ikt/9011/geometri/gotools_core/gotools_core_doc/closest_pt_curve_surf_8h-source.html)** (SINTEF; C++; AGPL): closest points by Newton iteration from seeds.
- **[openNURBS](https://developer.rhino3d.com/guides/opennurbs/what-is-opennurbs/)**: no closest-point calculations (they're in the Rhino SDK, not the open toolkit).
- **[LNLib](https://github.com/BIMCoderLiang/LNLib)** (C++, GPL-3.0), **[libnurbs](https://github.com/cyanray/libnurbs)**, **[light_NURBS](https://github.com/xuehy/light_NURBS)**: *The NURBS Book*'s point inversion by Newton's method, no global stage: no more robust than ours.
- **[verb](https://npmjs.com/package/verb-nurbs)** (JavaScript, MIT): its closest-point method not confirmed.
- **[IRIT](https://gershon.cs.technion.ac.il/irit/)** (Gershon Elber; C): subdivision solvers in Bernstein form, but documented as free for non-commercial use only.

Not searched yet: G+Smo and academic libraries. Delegation suits the corpus checks (an oracle independent of the backends, and of an implementation of our own to come); for runtime code (`nearestParam` in `cad-brep`, a core package without dependencies) an implementation of our own, as above, is the likelier answer.

## The brep_geometry check's run time

`brep_geometry.ts` takes 79 min over the corpus, before and after the B-rep model's phase 5 alike, 65 of them on `OCC5157.stp`: its B-spline surface of 146 x 118 knot spans makes `nearestParams` sample about 1.1 M points per lookup, for each of the 579 coedges on its faces (about 7e8 evaluations; the rest of the corpus takes about 14 min). Profiled, nearly all the time is in `nearestParams` through the B-spline evaluator and its basis functions. A localized fix first (the B-rep model's plan, before its phase 6): each knot span's control-point box, the spans searched nearest box first and pruned once the best distance found is below a box's, a tree over the boxes when there are many, and each span's samples cached per surface. The rigorous implementation above stays in the backlog.
