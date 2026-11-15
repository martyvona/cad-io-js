// The provisional criteria (criteria.h): one size h for the whole face, from its largest normal curvature k over its
// (u, v) box, h = min(sqrt(8 d / k), angle / k): a chord of length h on a curve of curvature k strays h^2 k / 8, and
// the normal turns by h k along it. k is the second fundamental form over the first, sampled on a grid: at each point
// max(|L| / E, |N| / G) + |M| / sqrt(E G) (L = n . S_uu, M = n . S_uv, N = n . S_vv; E, G = |S_u|^2, |S_v|^2), at
// least the largest principal curvature where S_u and S_v are orthogonal; points where S_u or S_v vanish (a pole)
// skipped. Not a bound (between grid points it can miss), though accept() holds the deflection on every triangle;
// and one h per face is too coarse wherever curvature varies (a B-spline's): the surfaces' lane makes it local and
// rigorous (per point, anisotropic: the principal curvatures and directions, from bounds), and replaces this file.
#include "tess_cadio/criteria.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace tesscadio {

using namespace cadgeom;

namespace {

class Provisional : public SurfaceCriteria {
public:
  Provisional(const Surface& s, double h, const Deflections& d) : s_(s), h_(h), d_(d) {}
  double edgeSpacing() const override { return h_; }
  Metric2 metric(Vec2 p) const override {
    SurfacePoint q;
    s_.eval(p.x, p.y, 1, q);
    double a = dot(q.du, q.du), b = dot(q.du, q.dv), c = dot(q.dv, q.dv), floor = 1e-2 * std::max(a, c);
    // (Towards a pole S_u vanishes: floored at a tenth of the other's length, so the metric stays positive definite
    // and refinement doesn't chase the pole line's degenerate lengths; the surfaces' lane meshes poles as fans.)
    a = std::max(a, floor), c = std::max(c, floor);
    if (a * c - b * b <= 0) b = 0;
    double w = 1 / (h_ * h_);
    return {a * w, b * w, c * w};
  }
  bool accept(const Vec2 t[3]) const override {
    Vec3 p[3];
    for (int i = 0; i < 3; i++) p[i] = at(t[i]);
    // The surface at the centroid and the edges' middles against the flat triangle's points there.
    const double w[4][3] = {{1. / 3, 1. / 3, 1. / 3}, {0.5, 0.5, 0}, {0, 0.5, 0.5}, {0.5, 0, 0.5}};
    for (const auto& b : w) {
      Vec2 uv{b[0] * t[0].x + b[1] * t[1].x + b[2] * t[2].x, b[0] * t[0].y + b[1] * t[1].y + b[2] * t[2].y};
      Vec3 flat = b[0] * p[0] + b[1] * p[1] + b[2] * p[2];
      if (norm(at(uv) - flat) > d_.linear) return false;
    }
    // The normals at the corners (where the surface has one) within the angle of one another and of the flat
    // triangle's own (which a triangle turned over in 3D, as one wide in u near a pole can be, fails).
    Vec3 n[3], g = cross(p[1] - p[0], p[2] - p[0]);
    bool has[3];
    for (int i = 0; i < 3; i++) has[i] = s_.normal(t[i].x, t[i].y, n[i]) == Status::ok;
    // (A facet with two corners on a pole line has rounding for a normal: no direction to judge.)
    double gl = norm(g), c = d_.angular > 0 ? std::cos(d_.angular) : 0;
    double longest = std::max({norm(p[1] - p[0]), norm(p[2] - p[1]), norm(p[0] - p[2])});
    bool facet = gl > 1e-9 * longest * longest;
    for (int i = 0; i < 3; i++) {
      if (!has[i]) continue;
      if (facet && dot(g, n[i]) < c * gl) return false;
      for (int j = i + 1; j < 3; j++)
        if (d_.angular > 0 && has[j] && dot(n[i], n[j]) < c) return false;
    }
    return true;
  }

private:
  Vec3 at(Vec2 p) const {
    SurfacePoint q;
    s_.eval(p.x, p.y, 0, q);
    return q.p;
  }
  const Surface& s_;
  double h_;
  Deflections d_;
};

} // namespace

std::unique_ptr<SurfaceCriteria> makeCriteria(const Model&, int, const Surface& s, Box2 uv, const Deflections& d,
  Status& status) {
  Range ru{uv.x.lo, uv.x.hi}, rv{uv.y.lo, uv.y.hi};
  status = Status::unsupported;
  if (!(d.linear > 0) || !std::isfinite(ru.lo) || !std::isfinite(ru.hi) || !std::isfinite(rv.lo) ||
    !std::isfinite(rv.hi))
    return nullptr;
  // The normal curvature's largest on a grid over the box, and the box's 3D extent.
  std::vector<SurfacePoint> grid;
  double maxU = 0, maxV = 0;
  const int N = 8;
  for (int i = 0; i <= N; i++)
    for (int j = 0; j <= N; j++) {
      SurfacePoint q;
      s.eval(ru.lo + (ru.hi - ru.lo) * i / N, rv.lo + (rv.hi - rv.lo) * j / N, 2, q);
      grid.push_back(q);
      maxU = std::max(maxU, norm(q.du)), maxV = std::max(maxV, norm(q.dv));
    }
  double k = 0;
  Box3 box{{grid[0].p.x, grid[0].p.x}, {grid[0].p.y, grid[0].p.y}, {grid[0].p.z, grid[0].p.z}};
  for (const SurfacePoint& q : grid) {
    box.x.lo = std::min(box.x.lo, q.p.x), box.x.hi = std::max(box.x.hi, q.p.x);
    box.y.lo = std::min(box.y.lo, q.p.y), box.y.hi = std::max(box.y.hi, q.p.y);
    box.z.lo = std::min(box.z.lo, q.p.z), box.z.hi = std::max(box.z.hi, q.p.z);
    double E = dot(q.du, q.du), G = dot(q.dv, q.dv);
    Vec3 n = cross(q.du, q.dv);
    double nn = norm(n);
    if (!(E > 1e-12 * maxU * maxU) || !(G > 1e-12 * maxV * maxV) || !(nn > 0)) continue;
    n = (1 / nn) * n;
    double L = dot(n, q.duu), M = dot(n, q.duv), Nn = dot(n, q.dvv);
    k = std::max(k, std::max(std::fabs(L) / E, std::fabs(Nn) / G) + std::fabs(M) / std::sqrt(E * G));
  }
  double extent = std::hypot(box.x.hi - box.x.lo, box.y.hi - box.y.lo, box.z.hi - box.z.lo);
  double h = extent > 0 ? extent : 1;
  if (k > 0 && std::isfinite(k)) {
    h = std::min(h, std::sqrt(8 * d.linear / k));
    if (d.angular > 0) h = std::min(h, d.angular / k);
  }
  status = Status::ok;
  return std::make_unique<Provisional>(s, h, d);
}

} // namespace tesscadio
