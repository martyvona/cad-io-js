// grid.h: an elementary face's interior grid of seed points.
#include "grid.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace tesscadio {

using namespace cadgeom;

namespace {

/** The share of each closed-form bound a step takes (grid.h). */
constexpr double kShare = 0.9;

/** The 3D step along an iso-line of normal curvature k (grid.h). */
double step3d(double k, const Deflections& D, double hmax) {
  double h = hmax;
  k = std::fabs(k);
  if (k > 0) {
    h = std::min(h, kShare * 2 * std::sqrt(D.linear / k));
    if (D.angular > 0) h = std::min(h, kShare * D.angular / (std::sqrt(2.0) * k));
  }
  return h;
}

/** |S_u|^2, |S_v|^2 and the normal curvatures along u and v at (u, v); false where they aren't defined. */
bool curvatures(const Surface& s, double u, double v, double& E, double& G, double& ku, double& kv) {
  SurfacePoint q;
  if (s.eval(u, v, 2, q) != Status::ok) return false;
  E = dot(q.du, q.du), G = dot(q.dv, q.dv);
  const Vec3 nn = cross(q.du, q.dv);
  const double nl = norm(nn);
  if (!(nl > 0) || !(E > 0) || !(G > 0)) return false;
  const Vec3 n = (1 / nl) * nn;
  ku = dot(n, q.duu) / E, kv = dot(n, q.dvv) / G;
  return std::isfinite(ku) && std::isfinite(kv) && std::isfinite(E) && std::isfinite(G);
}

} // namespace

std::vector<Vec2> elementaryGrid(const Surface& s, const Domain2& d, const Deflections& defl, double maxEdge,
  size_t maxPoints) {
  std::vector<Vec2> out;
  if (d.points.empty()) return out;
  double ulo = INFINITY, uhi = -INFINITY, vlo = INFINITY, vhi = -INFINITY;
  for (Vec2 p : d.points) ulo = std::min(ulo, p.x), uhi = std::max(uhi, p.x), vlo = std::min(vlo, p.y),
    vhi = std::max(vhi, p.y);
  if (!(uhi > ulo) || !(vhi > vlo)) return out;
  // The face's 3D extent: its box's 5 x 5 points'.
  Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
  for (int i = 0; i <= 4; i++)
    for (int j = 0; j <= 4; j++) {
      SurfacePoint q;
      if (s.eval(ulo + i * (uhi - ulo) / 4, vlo + j * (vhi - vlo) / 4, 0, q) != Status::ok) continue;
      lo = {std::min(lo.x, q.p.x), std::min(lo.y, q.p.y), std::min(lo.z, q.p.z)};
      hi = {std::max(hi.x, q.p.x), std::max(hi.y, q.p.y), std::max(hi.z, q.p.z)};
    }
  const double extent = norm(hi - lo);
  if (!(extent > 0) || !std::isfinite(extent)) return out;
  const double hmax = maxEdge > 0 ? std::min(extent, maxEdge / std::sqrt(2.0)) : extent;
  const double um = 0.5 * (ulo + uhi), vm = 0.5 * (vlo + vhi);
  double E, G, ku, kv;
  if (!curvatures(s, um, vm, E, G, ku, kv)) return out;
  // Rows: |S_v| and the curvature along v are the same along every u-line of these surfaces.
  const double dv0 = step3d(kv, defl, hmax) / std::sqrt(G);
  const double nrows = std::ceil((vhi - vlo) / dv0);
  if (!(nrows >= 2) || nrows > static_cast<double>(maxPoints)) return out;
  const int nr = static_cast<int>(nrows);
  const double dv = (vhi - vlo) / nr;
  struct Row {
    double v, du = 0;
    int n = 0;  // cells across u (n - 1 interior points); 0: no points (a pole's row)
    std::vector<double> crossings;
    std::vector<std::pair<double, double>> near;
  };
  std::vector<Row> rows(nr);
  size_t total = 0;
  for (int j = 1; j < nr; j++) {
    Row& R = rows[j];
    R.v = vlo + j * dv;
    double Ej, Gj, kuj, kvj;
    if (!curvatures(s, um, R.v, Ej, Gj, kuj, kvj) || !(Ej > 1e-12 * Gj)) continue;
    const double du0 = step3d(kuj, defl, hmax) / std::sqrt(Ej);
    const double n = std::ceil((uhi - ulo) / du0);
    if (!(n >= 2)) continue;
    if (n > static_cast<double>(maxPoints)) return {};
    R.n = static_cast<int>(n), R.du = (uhi - ulo) / R.n;
    total += R.n - 1;
    if (total > maxPoints) return {};
  }
  // Each segment's crossings of the rows (the loops' only: inside by parity) and the cells it meets, each row's.
  auto segment = [&](Vec2 a, Vec2 b, bool loop) {
    const double smin = std::min(a.y, b.y), smax = std::max(a.y, b.y);
    const int jlo = std::max(1, static_cast<int>(std::ceil((smin - 0.5 * dv - vlo) / dv)));
    const int jhi = std::min(nr - 1, static_cast<int>(std::floor((smax + 0.5 * dv - vlo) / dv)));
    for (int j = jlo; j <= jhi; j++) {
      Row& R = rows[j];
      if (loop && (a.y <= R.v) != (b.y <= R.v)) R.crossings.push_back(a.x + (R.v - a.y) * (b.x - a.x) / (b.y - a.y));
      if (R.n == 0) continue;
      // The segment's part within the row's band [v - dv / 2, v + dv / 2], as parameters t in [0, 1].
      double t0 = 0, t1 = 1;
      const double y0 = R.v - 0.5 * dv, y1 = R.v + 0.5 * dv, dy = b.y - a.y;
      if (dy == 0) {
        if (a.y < y0 || a.y > y1) continue;
      } else {
        double ta = (y0 - a.y) / dy, tb = (y1 - a.y) / dy;
        if (ta > tb) std::swap(ta, tb);
        t0 = std::max(t0, ta), t1 = std::min(t1, tb);
        if (t0 > t1) continue;
      }
      const double ua = a.x + t0 * (b.x - a.x), ub = a.x + t1 * (b.x - a.x);
      R.near.push_back({std::min(ua, ub) - 0.5 * R.du, std::max(ua, ub) + 0.5 * R.du});
    }
  };
  for (const auto& L : d.loops)
    for (size_t k = 0; k < L.size(); k++) segment(d.points[L[k]], d.points[L[(k + 1) % L.size()]], true);
  for (size_t k = 0; k + 1 < d.segments.size(); k += 2)
    segment(d.points[d.segments[k]], d.points[d.segments[k + 1]], false);
  for (Vec2 p : d.points) segment(p, p, false);
  for (int j = 1; j < nr; j++) {
    Row& R = rows[j];
    if (R.n == 0) continue;
    std::sort(R.crossings.begin(), R.crossings.end());
    std::sort(R.near.begin(), R.near.end());
    size_t c = 0, k = 0;
    double reach = -INFINITY;  // the furthest end of the near intervals starting at or before u
    for (int i = 1; i < R.n; i++) {
      const double u = ulo + i * R.du;
      while (c < R.crossings.size() && R.crossings[c] < u) c++;
      while (k < R.near.size() && R.near[k].first <= u) reach = std::max(reach, R.near[k++].second);
      if (c % 2 == 1 && !(u <= reach)) out.push_back({u, R.v});
    }
  }
  return out;
}

} // namespace tesscadio
