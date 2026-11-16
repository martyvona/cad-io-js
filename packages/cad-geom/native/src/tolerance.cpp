// tolerance.h's Tolerances.
#include "cad_geom/tolerance.h"

#include <algorithm>

namespace cadgeom {

namespace {
constexpr double kFloor = 1e-9;   // of the part's size
constexpr double kNone = 1e-5;    // mm: the part's where it gives no uncertainty
} // namespace

Tolerances::Tolerances(const Model& m) : m_(m) {
  Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
  bool any = false;
  for (int v = 0; v < m.vertices(); v++) {
    const Vec3 p = m.vertexPoint(v);
    if (!std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(p.z)) continue;
    lo = {std::min(lo.x, p.x), std::min(lo.y, p.y), std::min(lo.z, p.z)};
    hi = {std::max(hi.x, p.x), std::max(hi.y, p.y), std::max(hi.z, p.z)};
    any = true;
  }
  floor_ = any ? kFloor * norm(hi - lo) : 0;
  const double u = m.uncertainty();
  part_ = std::max(std::isfinite(u) && u > 0 ? u : kNone, floor_);
}

} // namespace cadgeom
