// predicates.h and geom2d.h, the reference version: predicates in plain floating point (NOT exact: signs near zero
// may be wrong), a loop's signed area by quadrature of Green's theorem; intersection, classification and nesting
// unsupported. For the lanes that call them until the 2D geometry lane replaces them.
#include "cad_geom/geom2d.h"

#include "cad_geom/numerics.h"
#include "cad_geom/predicates.h"

namespace cadgeom {

double orient2d(Vec2 a, Vec2 b, Vec2 c) { return cross(b - a, c - a); }

double incircle(Vec2 a, Vec2 b, Vec2 c, Vec2 d) {
  Vec2 ad = a - d, bd = b - d, cd = c - d;
  double al = dot(ad, ad), bl = dot(bd, bd), cl = dot(cd, cd);
  return al * cross(bd, cd) + bl * cross(cd, ad) + cl * cross(ad, bd);
}

Intersections2 intersect2(const Curve&, Range, const Curve&, Range, double) { return {}; }

Intersections2 selfIntersect2(const Loop2&, double) { return {}; }

Estimate signedArea2(const Loop2& loop) {
  // Green: A = 1/2 * integral of (x dy - y dx) around the loop.
  Estimate total{0, 0, Status::ok};
  for (const LoopPiece& piece : loop.pieces) {
    Estimate e = quadrature::integrate(
      [&](double t) {
        CurvePoint q;
        piece.curve->eval(t, 1, q);
        return 0.5 * (q.p.x * q.d1.y - q.p.y * q.d1.x);
      },
      piece.range.lo, piece.range.hi, 1e-300, 1e-12);
    total.value += piece.reversed ? -e.value : e.value;
    total.error += e.error;
    if (e.status != Status::ok) total.status = e.status;
  }
  return total;
}

Side classify2(const std::vector<Loop2>&, Vec2, Periods, double, Status& status) {
  status = Status::unsupported;
  return Side::out;
}

std::vector<int> nest2(const std::vector<Loop2>&, Periods, double, Status& status) {
  status = Status::unsupported;
  return {};
}

} // namespace cadgeom
