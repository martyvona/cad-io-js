# Mesh triage

How a tessellation's meshes are judged and chosen when no backend meshes every face to all the requirements: the criteria every face's mesh is measured by, the targets (triage profiles) that say what each consumer tolerates, and how a mesh is picked between a primary and a fallback backend. This is a design, decided with the user (2026-11-24), not yet built; what exists today is in `docs/backends.md` (the fallback, the judge, the area oracle) and `docs/own-tessellator.md` (tess-cadio's own checks and keepDefects).

## Principles

- **Generic:** triage knows nothing of any backend or pair of backends. It compares records of meshes, whoever made them.
- **Triage only selects:** it picks among the meshes the backends deliver and never asks for another meshing. What a backend knows about its own failures (tess-cadio's lantern retry, its point-cap freeze, its repairs of turned triangles) it does inside itself, before it reports.
- **Backends are told the true limits:** the meshing profile's deflections, and where a target sets them the smallest angle and the longest edge, so a backend's own retries aim at what the consumer needs. A backend that can't aim at a limit (OCCT and SMLib have no longest edge) is only judged by it.
- **A backend reports, it doesn't refuse:** tess-cadio delivers its best manifold mesh of every face it can mesh manifold, with its record; triage decides whether it's used. A face no backend meshes manifold is a hole.
- **A fallback mesh that meets every true limit is used.** Triage's rules below only matter where neither backend's mesh does.

## The criteria

Each face's mesh is measured by these, in this order (the order is also the tie-break's, below). The true limit is what a mesh should meet; the target sets, per criterion, the multiple of it past which a mesh is warned of and the multiple past which it is an error.

| | Criterion | True limit | Measured for foreign backends |
|---|---|---|---|
| k | Complete: the face has triangles | | always |
| a | Manifold: (a.1) within the face, its boundary edges aside; (a.2) sewn into its shell, every edge's polyline shared exactly with its other uses after the exact join (a seam's within the face) | | always |
| j | Oriented: a closed shell's mesh faces out | | always |
| b | Area against the area oracle's exact area, where it trusts one | the judge's: short by more than max(3 % of A, d x P), over by more than max(10 % of A, d x P) | always |
| c | Distance from the surface | the linear deflection d (max(d, the face's tolerance)) | off by default |
| d | Angle between normals | the angular deflection | off by default |
| e | Turned triangles: a facet against the mean of its corners' normals, as shipped | none | always |
| f | Smallest triangle angle | tess-cadio's minAngle (10 degrees by default) | always |
| g | Longest edge | off by default; 5 % of the part's size (its bounding box diagonal) in the analysis target | always |
| h | Triangle count, per face | min(ceiling, max(200,000, 64 x the face's expected count)); the ceiling 10M on desktops, 2M on phones and tablets | always |
| l | Degenerate triangles (two corners at one position) | none | always |
| i | Geometric self-intersection | not checked | |

- **The expected count (h)** is tess-cadio's: the integral over the face's (u, v) domain of sqrt(det M) of its size metric, over sqrt(3) / 4. It needs only the face's surface, domain and the deflections, so it is computed for any backend's face (cheaply: the metric's grid, no meshing). tess-cadio caps its refinement at the same number, so its faces can't pass (h).
- **Foreign backends' distance and angle (c, d)** are unchecked by default: their contract is trusted, and the record says "unchecked", never "passed". An option turns on our own sampled verification (points of each triangle inverted onto the surface with cad-geom). It is to be revisited once tess-cadio is the primary backend and a foreign backend meshes only the few faces it falls back for. tess-cadio's own (c), (d), (e) and (f) come from its meshing, at no cost.
- **Unverified:** where the oracle trusts no area, (b) is unverified, not passed.

## Targets

What users see of triage is its profile, called the **target** (the word "triage" is internal only): the viewer's pulldown is labelled Target, the CLI's options say target.


Each criterion's warn and error levels, as multiples (at least 1) of its true limit. A warning keeps the face's mesh; an error withholds it (and fails an export, below).

| Criterion | Rendering | Manifold | Analysis |
|---|---|---|---|
| a, manifold | warn | error | error |
| b, area | warn past the true limit; error past 25 % | warn past the true limit; error past 15 % | error past the true limit |
| c, distance | warn past 1 x; error past 10 x | warn past 1 x; error past 2 x | warn past 1 x; error past 2 x |
| d, angle | warn past 1 x | warn past 1 x; error past 2 x | warn past 1 x; error past 2 x |
| e, turned | warn | warn | warn |
| f, smallest angle | warn | warn | warn past 1 x; error past 1.5 x |
| g, longest edge | warn | warn | warn past 1 x; error past 1.5 x (true limit 5 % of the part's size) |
| h, triangles | error past 1 x | error past 1 x | error past 1 x |
| i, self-intersection | allowed | allowed | allowed |

- **Rendering:** interactive viewing (the viewer's default), and also collision meshes for robotics and game engines, and offline rendering (path tracing).
- **Manifold:** 3D printer slicers (3MF) and mesh boolean kernels (such as manifold).
- **Analysis:** simulation (CFD, FEA), where the smallest angle and the longest edge matter.
- Every level is configurable on its own; a target only sets them all at once.
- Complete (k) missing is always an error; oriented (j) is fixed where it can be (tessellateScene's orientResult turns a shell's mesh over, warning of it) and warned of; degenerate triangles (l) are dropped and counted.

## Choosing a mesh

Per face, between the primary's mesh and the fallback's (the fallback asked only where the primary's isn't acceptable), composed into the part's mesh by the exact join:

1. A mesh that meets every true limit: used (the primary's if both do).
2. Else a mesh with warnings but no errors under the target: used, with its warnings.
3. Else, if both have warnings only: each criterion in the order above is classed pass, warn or error, and the meshes compared criterion by criterion, first by class, then by the measured value within the class; the first criterion that differs decides; the primary's on a full tie.
4. Else (every mesh has an error): the face's mesh is withheld, with the error.

## What errors and warnings do

- **The viewer:** an error withholds the face's mesh and shows the error modal (the problems dialog); a warning keeps the face, with no modal, the message reachable later through the About box.
- **Exports** (stepconv, and the viewer's export): an error fails the export by default; an option excludes the failing parts, exports the rest, and still reports the error.
- **The CLI:** each level a named option, the target `--target <rendering|manifold|analysis>`, and `--describe-target` printing the effective settings with each true limit's formula. Its default by output format: 3MF the manifold profile, glTF and three.js rendering.
- **The viewer's settings:** a dedicated modal listing each criterion with its true limit's formula and its warn and error levels.

## Open

- **The stretch cap per target (to be measured):** a mesher's size metric is unbounded along a direction without curvature (a cylinder's axis), so a face gets as few, long triangles as its boundary allows, and long thin triangles are where lantern bands, narrow strips' tilted triangles and slivers along the boundary come from. So every target is to cap the metric's stretch (long size over short) from the start, not only in tess-cadio's retry after a bad mesh: rendering at about 16, manifold about 8, analysis near 1 with its longest edge (g) also capping the long size, so a plain cylinder there gets rows along its axis at about its circumferential spacing. The cap means a 3D ratio only once the metric's sizes are real distances on every surface (the developed (u, v) scale, being built), so it is measured after that: the cap from the start at 16 and 8 against none, on a9's 654 parts and the user's models (failed and kept faces, retries, triangles, CPU, oracle areas), the values then the user's. A grid of interior points is not the way (`docs/own-tessellator.md`'s structured-grid spike: the band along the boundary keeps the metric's shapes).
- Building it: the record per face in cad-scene (measured in the workers, with tess-cadio's own values taken as reported); triage replacing `judgeResult`'s and `compareVerdicts`' rules and `FallbackTessellator`'s choice per face; tess-cadio's keepDefects thresholds folded into the profiles; the longest edge (g) in tess-cadio's size metric; the CLI's options and the viewer's modal (the viewer's agent).
