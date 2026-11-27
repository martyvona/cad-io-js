// Folds inside a face: curves where its surface's S_u x S_v passes through zero and the normal turns back, the
// parameterization smooth across them. A knife edge (S_u and S_v parallel, both nonzero: two sheets meeting at a
// narrow wedge) or a collapse (one of them vanishing: the sheet running back on itself, often in pairs bounding a
// doubled strip). Unlike creases.h's C0 lines they follow no iso-line, so each is a polyline in (u, v).
#pragma once

#include <functional>
#include <vector>

#include "surface.h"

namespace cadgeom {

/**
 * A fold: its crossings in (u, v), in order along it (each where the signed Jacobian (S_u x S_v) . n changes sign
 * on a grid edge, to within uvTol); `knife` where most of them have S_u and S_v parallel (sin of their angle under
 * 1e-2) with neither under a tenth of the other, else a collapse; `turn` the largest angle (rad) between the unit
 * normals at a crossing's grid edge's ends; `length` its polyline's length in 3D; `depth` how far the sheet runs back
 * past it: the largest, over its crossings, of the 3D distance to the nearest other crossing along the same grid line
 * (the reversed stretch's far side, on this fold or another), 0 where none has one (a single fold, the sheet never
 * coming back).
 */
struct Fold {
  std::vector<Vec2> uv;
  bool knife = false;
  double turn = 0, length = 0, depth = 0;
};

/**
 * The folds of s over ru x rv (finite: a face's (u, v) box). A grid over the box, its lines the surface's breaks
 * and each span cut evenly (at least 64 and at most 512 intervals a direction); a grid edge whose ends' unit normals
 * are more than 90 degrees apart is crossed where the signed Jacobian against the first end's normal changes sign,
 * found by bisection to within uvTol, and kept where S_u x S_v there is under 1e-2 of the larger of |S_u|^2 and
 * |S_v|^2 (a C0 crease's normal jumps with neither vanishing: creases.h's, not a fold) and not on a pole or apex line
 * the surface reports (singularities(): a sphere's pole, a cone's apex, a spindle torus's). The crossings are joined
 * across the grid's cells into polylines (a cell crossed on four edges paired the shorter way), and cut to the runs
 * `inside` (n points' sides: 0 in, 1 out, 2 on the boundary) puts in the face. Sampled, not certain: a fold that
 * crosses a grid edge twice (a band narrower than the spacing) or none is missed.
 */
std::vector<Fold> findFolds(const Surface& s, Range ru, Range rv,
  const std::function<void(const Vec2*, int, int*)>& inside, const std::function<double(Vec2)>& uvTol);

} // namespace cadgeom
