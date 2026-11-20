// C0 creases inside a face: its surface's iso-lines where the surface is only C0 by its form (SurfaceImpl::c0Lines: a
// B-spline's knots of multiplicity at least its degree, an extrusion's or revolution's profile breaks) and its normal
// jumps there, as the pieces inside the face, for a mesher to meet as constraints. An iso-line is straight in (u, v),
// so a piece is its line and the range of the other parameter it spans.
#pragma once

#include <functional>
#include <vector>

#include "surface.h"

namespace cadgeom {

/**
 * A crease: u = at for v in [lo, hi] (isoU), else v = at for u in [lo, hi]; jump its largest normal jump (rad). An
 * end on the boundary (loOnBoundary, hiOnBoundary) lies past the face's loop by one to two of its (u, v) tolerances,
 * so the line crosses it; any other end is inside the face, where the jump falls to minAngle.
 */
struct Crease {
  bool isoU = true;
  double at = 0, lo = 0, hi = 0, jump = 0;
  bool loOnBoundary = false, hiOnBoundary = false;
};

/**
 * The creases of s over ru x rv (finite: a face's (u, v) box; a periodic direction's lines once each, shifted into
 * it). Each candidate line is sampled at 65 points across the range, a point kept where `inside` (n points' sides: 0
 * in, 1 out, 2 on the boundary within the face's tolerance) says it's inside the face and the unit normals just
 * either side of the line (1e-7 of the narrower neighbouring span off) differ by more than minAngle. Each run of kept
 * points is a crease, its ends moved by bisection to where that stops holding, to within uvTol (the face's (u, v)
 * tolerance at a point), and on the boundary three tolerances further. A line along the face's own edge is on its
 * boundary, so not kept. Sampled, not certain: a stretch out of the face narrower than the spacing can be
 * missed. Ordered by isoU (u lines first), at, lo. Surfaces without C0 lines (closed forms) give none.
 */
std::vector<Crease> findCreases(const Surface& s, Range ru, Range rv, double minAngle,
  const std::function<void(const Vec2*, int, int*)>& inside, const std::function<double(Vec2)>& uvTol);

} // namespace cadgeom
