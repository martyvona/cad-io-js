// creases.h: C0 creases inside a face, its surface's C0 lines tested by the normals either side, clipped to the face.
#include "cad_geom/creases.h"

#include <algorithm>
#include <cmath>

#include "surface_impl.h"

namespace cadgeom {

std::vector<Crease> findCreases(const Surface& s0, Range ru, Range rv, double minAngle,
  const std::function<void(const Vec2*, int, int*)>& inside, const std::function<double(Vec2)>& uvTol) {
  using surfaces::IsoLine, surfaces::SurfaceImpl, surfaces::finite;
  std::vector<Crease> out;
  const SurfaceImpl* s = dynamic_cast<const SurfaceImpl*>(&s0);
  if (!s || !finite(ru) || !finite(rv) || !(ru.lo < ru.hi) || !(rv.lo < rv.hi)) return out;
  std::vector<IsoLine> lines;
  // A periodic direction's lines over its base period, shifted into the box (once each: the face's loops are
  // classified modulo the period, so two copies of a line are the same line).
  const SurfaceDomain dom = s->domain();
  {
    std::vector<IsoLine> base;
    s->c0Lines(dom.uPeriod > 0 ? dom.u : ru, dom.vPeriod > 0 ? dom.v : rv, base);
    for (const IsoLine& L : base) {
      const double P = L.isoU ? dom.uPeriod : dom.vPeriod;
      const Range r = L.isoU ? ru : rv;
      if (!(P > 0)) {
        if (L.at > r.lo && L.at < r.hi) lines.push_back(L);
        continue;
      }
      double x = L.at + std::ceil((r.lo - L.at) / P) * P;
      if (!(x > r.lo)) x += P;
      if (x < r.hi) lines.push_back({L.isoU, x});
    }
  }
  if (lines.empty()) return out;
  std::vector<double> us, vs;
  s->breaks(ru, rv, us, vs);
  for (const IsoLine& L : lines) {
    // Either side of the line by a little of the narrower neighbouring span (the breaks across it).
    const std::vector<double>& bs = L.isoU ? us : vs;
    const Range across = L.isoU ? ru : rv, along = L.isoU ? rv : ru;
    double lo = across.lo, hi = across.hi;
    for (double b : bs) {
      if (b < L.at && b > lo) lo = b;
      if (b > L.at && b < hi) hi = b;
    }
    const double d = 1e-7 * minNum(L.at - lo, hi - L.at);
    if (!(d > 0)) continue;
    auto at = [&](double t) { return L.isoU ? Vec2{L.at, t} : Vec2{t, L.at}; };
    // The normals' angle across the line at t (negative where either is singular: not a crease there).
    auto jump = [&](double t) {
      Vec3 a, b;
      const Vec2 p = at(t), da = L.isoU ? Vec2{-d, 0} : Vec2{0, -d}, db = L.isoU ? Vec2{d, 0} : Vec2{0, d};
      if (s->normal(p.x + da.x, p.y + da.y, a) != Status::ok || s->normal(p.x + db.x, p.y + db.y, b) != Status::ok)
        return -1.0;
      return std::acos(std::clamp(dot(a, b), -1.0, 1.0));
    };
    // On the crease: the jump past minAngle and the point inside the face, not on its boundary within its
    // tolerance (where the line runs along the face's own edge, that edge is the constraint).
    auto kept = [&](double t, double& j, int& side) {
      j = jump(t);
      const Vec2 p = at(t);
      inside(&p, 1, &side);
      return j > minAngle && side == 0;
    };
    // Between a kept t and one not, to within uvTol: an end of a crease. On the boundary where the point beyond is
    // on or outside it (the face, not the jump, ends it there); such an end, a tolerance or two inside the loop, is
    // moved three tolerances on, so the line surely crosses the loop.
    auto edge = [&](double in, double beyond, int beyondSide, bool& onBoundary) {
      for (int it = 0; it < 60 && std::fabs(beyond - in) > uvTol(at(in)); it++) {
        const double m = 0.5 * in + 0.5 * beyond;
        double j;
        int side;
        if (kept(m, j, side)) in = m;
        else beyond = m, beyondSide = side;
      }
      onBoundary = beyondSide != 0;
      return onBoundary ? in + std::copysign(3 * uvTol(at(in)), beyond - in) : in;
    };
    constexpr int N = 64;
    double t[N + 1], j[N + 1];
    bool k[N + 1];
    // The samples' sides in one call (classifying a batch costs little more than one point).
    Vec2 p[N + 1];
    int side[N + 1];
    for (int i = 0; i <= N; i++) t[i] = along.lo + (along.hi - along.lo) * i / N, j[i] = jump(t[i]), p[i] = at(t[i]);
    inside(p, N + 1, side);
    for (int i = 0; i <= N; i++) k[i] = j[i] > minAngle && side[i] == 0;
    for (int i = 0; i <= N;) {
      if (!k[i]) {
        i++;
        continue;
      }
      int e = i;
      double worst = j[i];
      while (e + 1 <= N && k[e + 1]) worst = maxNum(worst, j[++e]);
      Crease c;
      c.isoU = L.isoU, c.at = L.at, c.jump = worst;
      // At the box's ends the face ends too.
      if (i > 0) c.lo = edge(t[i], t[i - 1], side[i - 1], c.loOnBoundary);
      else c.lo = t[0] - 3 * uvTol(at(t[0])), c.loOnBoundary = true;
      if (e < N) c.hi = edge(t[e], t[e + 1], side[e + 1], c.hiOnBoundary);
      else c.hi = t[N] + 3 * uvTol(at(t[N])), c.hiOnBoundary = true;
      out.push_back(c);
      i = e + 1;
    }
  }
  std::sort(out.begin(), out.end(), [](const Crease& a, const Crease& b) {
    return a.isoU != b.isoU ? a.isoU > b.isoU : a.at != b.at ? a.at < b.at : a.lo < b.lo;
  });
  return out;
}

} // namespace cadgeom
