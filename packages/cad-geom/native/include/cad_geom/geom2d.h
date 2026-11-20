// 2D geometry in a face's (u, v): curve-curve and self-intersection, a point against loops, loops' orientation and
// nesting, for exact 2D curves (Curve with dim() 2). Results say "on", "tangent" and "overlapping" where the geometry
// does, within the tolerance given, in the curves' own (u, v) units (docs/own-tessellator.md, "Degenerate and
// ambiguous cases"). Periodic directions: a loop on a cylinder or torus may wind around a period, so classification
// takes the periods and unwraps.
#pragma once

#include <vector>

#include "curve.h"
#include "result.h"
#include "vec.h"

namespace cadgeom {

/** A piece of a loop: a 2D curve over a parameter range, run forward or reversed. */
struct LoopPiece {
  const Curve* curve = nullptr;
  Range range;
  bool reversed = false;
};

/** A closed loop in (u, v): pieces end to end (each one's end at the next one's start, within the tolerance). */
struct Loop2 {
  std::vector<LoopPiece> pieces;
};

/**
 * What the loops' (u, v) domain needs from the surface they're on: its periods (0: not periodic), and its pole
 * lines, the iso-lines u = c (poleU) or v = c (poleV) where the surface collapses to a point (a cone's apex, a
 * sphere's poles, a revolution's profile meeting the axis; Surface::singularities' poles and apexes). A loop that
 * jumps along a pole line (a degenerate edge the canonical model leaves out) is closed by that line's segment, and a
 * point on it within the face is "on". Without them a cone's apex jump and a band's loop closing around the period
 * look the same.
 */
struct Periods {
  double u = 0, v = 0;
  std::vector<double> poleU, poleV;
};

/** Two curves meeting at a point: parameters on each, the point, whether they touch without crossing there. */
struct Crossing {
  double ta = 0, tb = 0;
  Vec2 p;
  bool tangent = false;
};

/** Two curves coinciding within the tolerance over a stretch: the ranges on each, and whether they run the same way. */
struct Overlap {
  Range a, b;
  bool sameDirection = true;
};

struct Intersections2 {
  Status status = Status::unsupported;
  std::vector<Crossing> crossings;
  std::vector<Overlap> overlaps;
};

/**
 * Where a over ra and b over rb meet, within tol: isolated crossings and tangencies, and overlap intervals. Within tol
 * points are one, so every contact is a stretch; it's a crossing or tangency when the curves' own angle and curvature
 * difference where they're nearest would separate them by tol / 2 at one of its ends (the stretch only the
 * tolerance's blur of a point), and an overlap when they don't (they coincide there; longer than tol on both).
 */
Intersections2 intersect2(const Curve& a, Range ra, const Curve& b, Range rb, double tol);

/** Where a loop meets itself away from its pieces' shared ends (ta, tb as piece index + parameter fraction). */
Intersections2 selfIntersect2(const Loop2& loop, double tol);

/** The signed area a loop encloses (positive counterclockwise), with its error estimate. */
Estimate signedArea2(const Loop2& loop);

/** A point against the region the loops bound (outer counterclockwise, holes clockwise, as a face's in (u, v)). */
Side classify2(const std::vector<Loop2>& loops, Vec2 p, Periods periods, double tol, Status& status);
/**
 * The polylines classify2 and nest2 have made of loops' pieces for their boxes and on tests (not intersect2's own),
 * counted for tests; never reset.
 */
extern long boundaryPolylines;

/**
 * classify2 of n points, each at its own tolerance (tol[i]), what doesn't depend on the point made once for them all
 * (the pieces' boxes, and their polylines at each tolerance asked).
 */
void classify2(const std::vector<Loop2>& loops, const Vec2* p, const double* tol, int n, Periods periods, Side* sides,
  Status* statuses);

/**
 * Each loop's parent: the index of the smallest loop that contains it, or -1 (outermost); where the loops wind
 * around a period instead of enclosing (a band's two boundaries) both are -1 and `status` is Status::ok.
 */
std::vector<int> nest2(const std::vector<Loop2>& loops, Periods periods, double tol, Status& status);

} // namespace cadgeom
