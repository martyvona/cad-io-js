// surface.h's intersectLine: a line against a surface, by branch and bound on parameter rectangles (as invertSurface
// searches). With e1, e2 an orthonormal pair normal to the line's direction u_d, the line meets S where
// g(u, v) = (e1 . (S - o), e2 . (S - o)) = 0, at t = u_d . (S - o) / |d|; g's Jacobian has the determinant
// u_d . (S_u x S_v), so where the surface is transversal to the line (|u_d . N| at least kLineMargin |N| over the
// rectangle, from the partials' boxes) interval Newton is well posed there: Krawczyk's operator
// K = c - Y g(c) + (I - Y J)(X - c), Y the inverse of J at the middle c and J the Jacobian's box over X, has every
// root in X inside it, so K missing X leaves none and K inside X proves exactly one (found by Newton from c). A
// rectangle not transversal all over is split until its box is within a contact size (1e-6 of the range's 3D size, or
// tol), a contact; neighbouring contacts are one, a tangency. Planes, and cylinders and cones where the line runs along
// a generator, answer in closed form (SurfaceImpl::lineClosedForm); a line lying in another kind of surface is a run
// of contacts that can take the budget.
#include "cad_geom/surface.h"

#include <algorithm>
#include <cmath>
#include <queue>

#include "surface_impl.h"

namespace cadgeom {

using namespace surfaces;

namespace {

struct Rect {
  Range u, v;
  double size;  // the 3D box's diameter, for the order of the search (largest first, so contacts settle late)
  bool operator<(const Rect& o) const { return size < o.size; }
};

/** A contact: a rectangle within tol of the line that couldn't be resolved, its point nearest the line. */
struct Contact {
  double t;
  Vec2 uv;
  Vec3 p;
};

} // namespace

LineIntersection intersectLine(const Surface& s0, Vec3 o, Vec3 d, Range tr, Range ru, Range rv, double tol) {
  LineIntersection out;
  const SurfaceImpl* impl = dynamic_cast<const SurfaceImpl*>(&s0);
  const double dl = norm(d);
  if (!impl || !(dl > 0) || !finite(tr) || !(tr.lo <= tr.hi) || !(ru.lo <= ru.hi) || !(rv.lo <= rv.hi)) return out;
  const SurfaceImpl& s = *impl;
  tol = maxNum(tol, 0.0);
  const Vec3 ud = (1 / dl) * d;
  // e1, e2 normal to ud: e1 along the coordinate axis least aligned with it, made orthogonal.
  Vec3 a = std::fabs(ud.x) <= std::fabs(ud.y) && std::fabs(ud.x) <= std::fabs(ud.z) ? Vec3{1, 0, 0}
    : std::fabs(ud.y) <= std::fabs(ud.z) ? Vec3{0, 1, 0} : Vec3{0, 0, 1};
  Vec3 e1 = a - dot(a, ud) * ud;
  e1 = (1 / norm(e1)) * e1;
  const Vec3 e2 = cross(ud, e1);
  const Box3 E1 = pointBox(e1), E2 = pointBox(e2), UD = pointBox(ud), O = pointBox(o);
  // The segment along ud, in lengths from o.
  const double sLo = tr.lo * dl, sHi = tr.hi * dl;

  // Ranges as invertSurface takes them: periodic directions over one period from the start, others cut to the
  // domain, infinite ones cut to where the surface comes within tol of the segment.
  SurfaceDomain dom = s.domain();
  const bool wrapU = dom.uPeriod > 0 && ru.hi - ru.lo >= dom.uPeriod * (1 - 8 * kEps);
  const bool wrapV = dom.vPeriod > 0 && rv.hi - rv.lo >= dom.vPeriod * (1 - 8 * kEps);
  if (wrapU) ru.hi = ru.lo + dom.uPeriod;
  if (wrapV) rv.hi = rv.lo + dom.vPeriod;
  if (dom.uPeriod == 0) ru = {maxNum(ru.lo, dom.u.lo), minNum(ru.hi, dom.u.hi)};
  if (dom.vPeriod == 0) rv = {maxNum(rv.lo, dom.v.lo), minNum(rv.hi, dom.v.hi)};
  if (!(ru.lo <= ru.hi) || !(rv.lo <= rv.hi)) {
    out.status = Status::ok;
    return out;
  }
  if (!finite(ru) || !finite(rv)) {
    Range wu, wv;
    const Vec3 mid = o + (0.5 * sLo + 0.5 * sHi) * ud;
    s.within(mid, 0.5 * (sHi - sLo) * (1 + 1e-12) + tol, wu, wv);
    ru = {maxNum(ru.lo, wu.lo), minNum(ru.hi, wu.hi)};
    rv = {maxNum(rv.lo, wv.lo), minNum(rv.hi, wv.hi)};
    if (!finite(ru) || !finite(rv)) return out;
    if (!(ru.lo <= ru.hi) || !(rv.lo <= rv.hi)) {
      out.status = Status::ok;
      return out;
    }
  }

  // In closed form where the kind has one for this segment (its hits in lengths along ud).
  if (s.lineClosedForm(o, ud, sLo, sHi, ru, rv, tol, out)) {
    for (LineHit& h : out.crossings) h.t /= dl, h.span = {h.span.lo / dl, h.span.hi / dl};
    for (LineHit& h : out.tangencies) h.t /= dl, h.span = {h.span.lo / dl, h.span.hi / dl};
    for (Range& r : out.overlaps) r = {r.lo / dl, r.hi / dl};
    return out;
  }
  auto point = [&](Vec2 uv, int order, Vec3* p) { s.derivs(uv.x, uv.y, order, p); };
  // A partial's box over a rectangle as the hull of its pieces' between the surface's breaks: across a knot a
  // B-spline's box is its spans' hulls, loose, and a root on a knot line (where the rectangles either side meet) would
  // never be proven. The hull bounds every one-sided derivative, which is what Krawczyk's mean value form needs of g
  // (continuous, smooth on each piece).
  std::vector<double> bu_, bv_;
  auto pieceBox = [&](Range A, Range B, int k, int l, Box3& out) {
    s.breaks(A, B, bu_, bv_);
    out = emptyBox();
    for (size_t i = 0; i + 1 < bu_.size(); i++)
      for (size_t j = 0; j + 1 < bv_.size(); j++) {
        Box3 b;
        if (s.derivBox({bu_[i], bu_[i + 1]}, {bv_[j], bv_[j + 1]}, k, l, b) != Status::ok) return false;
        out = hull(out, b);
      }
    return true;
  };
  // Whether a box widened by tol can meet the segment: its projections on e1, e2 within tol of 0, on ud within tol
  // of the segment's lengths. (The projections of S - o, rounding of o's subtraction included.)
  const double oRound = 4 * kEps * maxAbs(o);
  auto meets = [&](const Box3& b) {
    const Box3 q = widen(b - O, tol + oRound);
    const Interval g1 = dotBox(E1, q), g2 = dotBox(E2, q), t = dotBox(UD, q);
    return g1.lo <= 0 && g1.hi >= 0 && g2.lo <= 0 && g2.hi >= 0 && t.hi >= sLo && t.lo <= sHi;
  };
  auto diameter = [](const Box3& b) { return std::hypot(b.x.width(), std::hypot(b.y.width(), b.z.width())); };

  std::vector<LineHit> crossings;
  std::vector<Contact> contacts;
  std::priority_queue<Rect> queue;
  {
    const SurfaceImpl::SpanGrid& grid = s.spanGrid(ru, rv);
    for (size_t i = 0, k = 0; i + 1 < grid.us.size(); i++)
      for (size_t j = 0; j + 1 < grid.vs.size(); j++, k++) {
        const Box3 b = grid.ok[k] ? grid.box[k] : entireBox();
        if (grid.ok[k] && !meets(b)) continue;
        queue.push({{grid.us[i], grid.us[i + 1]}, {grid.vs[j], grid.vs[j + 1]}, grid.ok[k] ? diameter(b) : kInf});
      }
  }
  // A rectangle not transversal all over stops splitting at this size, a contact: where the line touches the surface
  // or passes within the boxes' reach of it, the region within tol runs about sqrt(R tol) along the line, and
  // rectangles of tol would take tens of thousands to cover it. Its contacts are then conservative: within tol, or
  // too near to tell at this size.
  double contactSize = tol;
  {
    Box3 whole;
    if (s.derivBox(ru, rv, 0, 0, whole) == Status::ok) contactSize = maxNum(tol, 1e-6 * diameter(whole));
  }
  int budget = 40000;
  bool exhausted = false;
  while (!queue.empty()) {
    const Rect r = queue.top();
    queue.pop();
    if (--budget < 0) {
      exhausted = true;
      break;
    }
    const Range A = r.u, B = r.v;
    const Vec2 c{0.5 * A.lo + 0.5 * A.hi, 0.5 * B.lo + 0.5 * B.hi};
    const double wu = A.hi - A.lo, wv = B.hi - B.lo;
    // Krawczyk's test runs on X widened by a small fraction (within the search range, but past it across a periodic
    // direction's seam, which a root can lie on), so a root on a side two rectangles share is inside both test
    // regions: kept by each, once after the merge.
    const Range Ai{wrapU ? A.lo - 1e-3 * wu : maxNum(ru.lo, A.lo - 1e-3 * wu),
      wrapU ? A.hi + 1e-3 * wu : minNum(ru.hi, A.hi + 1e-3 * wu)};
    const Range Bi{wrapV ? B.lo - 1e-3 * wv : maxNum(rv.lo, B.lo - 1e-3 * wv),
      wrapV ? B.hi + 1e-3 * wv : minNum(rv.hi, B.hi + 1e-3 * wv)};
    Box3 b0, bu, bv;
    const bool ok = s.derivBox(A, B, 0, 0, b0) == Status::ok && pieceBox(Ai, Bi, 1, 0, bu)
      && pieceBox(Ai, Bi, 0, 1, bv);
    if (ok && !meets(b0)) continue;
    if (ok) {
      // Transversal all over: |ud . N| >= kLineMargin |N| for every N in the normal's box.
      const Box3 N = crossBox(bu, bv);
      const Interval dn = dotBox(UD, N);
      const double nMax = boxNorm(N);
      const bool transversal = (dn.lo > 0 || dn.hi < 0)
        && minNum(std::fabs(dn.lo), std::fabs(dn.hi)) >= kLineMargin * nMax;
      if (transversal) {
        // Krawczyk: J's box over X, Y = J(c)^-1, K = c - Y g(c) + (I - Y J)(X - c).
        Vec3 p[kPartials];
        point(c, 1, p);
        const Vec3 su = p[pidx(1, 0)], sv = p[pidx(0, 1)], q = p[0] - o;
        const double j11 = dot(e1, su), j12 = dot(e1, sv), j21 = dot(e2, su), j22 = dot(e2, sv);
        const double det = j11 * j22 - j12 * j21;
        if (det != 0 && std::isfinite(det)) {
          const double y11 = j22 / det, y12 = -j12 / det, y21 = -j21 / det, y22 = j11 / det;
          // g(c) as an interval: the evaluation's rounding, relative to the point and o.
          const double gr = 16 * kEps * (maxAbs(p[0]) + maxAbs(o));
          const Interval g1{dot(e1, q) - gr, dot(e1, q) + gr}, g2{dot(e2, q) - gr, dot(e2, q) + gr};
          const Interval J11 = dotBox(E1, bu), J12 = dotBox(E1, bv), J21 = dotBox(E2, bu), J22 = dotBox(E2, bv);
          const Interval Y11 = Interval::point(y11), Y12 = Interval::point(y12), Y21 = Interval::point(y21),
                         Y22 = Interval::point(y22);
          // M = I - Y J.
          const Interval M11 = Interval::point(1) - (Y11 * J11 + Y12 * J21), M12 = -(Y11 * J12 + Y12 * J22);
          const Interval M21 = -(Y21 * J11 + Y22 * J21), M22 = Interval::point(1) - (Y21 * J12 + Y22 * J22);
          const Interval Xu{Ai.lo - c.x, Ai.hi - c.x}, Xv{Bi.lo - c.y, Bi.hi - c.y};
          const Interval Ku = Interval::point(c.x) - (Y11 * g1 + Y12 * g2) + (M11 * Xu + M12 * Xv);
          const Interval Kv = Interval::point(c.y) - (Y21 * g1 + Y22 * g2) + (M21 * Xu + M22 * Xv);
          if (Ku.hi < Ai.lo || Ku.lo > Ai.hi || Kv.hi < Bi.lo || Kv.lo > Bi.hi) continue;  // no root in X
          if (Ku.lo > Ai.lo && Ku.hi < Ai.hi && Kv.lo > Bi.lo && Kv.hi < Bi.hi) {
            // Exactly one root, in K: Newton from c, kept in K.
            Vec2 x = c;
            for (int it = 0; it < 64; it++) {
              point(x, 1, p);
              const Vec3 e = p[0] - o, du = p[pidx(1, 0)], dv = p[pidx(0, 1)];
              const double a11 = dot(e1, du), a12 = dot(e1, dv), a21 = dot(e2, du), a22 = dot(e2, dv);
              const double dt = a11 * a22 - a12 * a21;
              if (!(dt != 0)) break;
              const double r1 = dot(e1, e), r2 = dot(e2, e);
              const Vec2 n{std::clamp(x.x - (a22 * r1 - a12 * r2) / dt, Ku.lo, Ku.hi),
                std::clamp(x.y - (a11 * r2 - a21 * r1) / dt, Kv.lo, Kv.hi)};
              const bool done = std::fabs(n.x - x.x) <= 4 * kEps * (1 + std::fabs(x.x))
                && std::fabs(n.y - x.y) <= 4 * kEps * (1 + std::fabs(x.y));
              x = n;
              if (done) break;
            }
            point(x, 1, p);
            const double t = dot(ud, p[0] - o);
            // (Kept wherever it is in the widened rectangle: a root on a side, Newton's rounding a hair either side of
            // it, would otherwise be each neighbour's and neither's. Found twice, it's merged below.)
            if (t >= sLo - tol && t <= sHi + tol) {
              const Vec3 n = cross(p[pidx(1, 0)], p[pidx(0, 1)]);
              crossings.push_back({t / dl, x, p[0], dot(ud, n) / norm(n), false, {t / dl, t / dl}});
            }
            continue;
          }
        }
      }
    }
    // Unresolved: a contact where the box is within tol (or as narrow as its coordinates' rounding), else split.
    const double diam = ok ? diameter(b0) : kInf;
    const bool thin = wu <= 4 * kEps * maxNum(std::fabs(A.lo), std::fabs(A.hi))
      && wv <= 4 * kEps * maxNum(std::fabs(B.lo), std::fabs(B.hi));
    if ((ok && diam <= contactSize) || thin) {
      // Its point nearest the line, of the middle and corners.
      Contact best{0, c, {}};
      double bd = kInf;
      for (Vec2 x : {c, Vec2{A.lo, B.lo}, Vec2{A.hi, B.lo}, Vec2{A.lo, B.hi}, Vec2{A.hi, B.hi}}) {
        Vec3 p[kPartials];
        point(x, 0, p);
        const Vec3 e = p[0] - o;
        const double t = dot(ud, e), dist = norm(e - t * ud);
        if (dist < bd) bd = dist, best = {t, x, p[0]};
      }
      contacts.push_back(best);
      continue;
    }
    // Split across the side longer in 3D (by the partials' boxes where known).
    const double lu = ok ? boxNorm(bu) * wu : wu, lv = ok ? boxNorm(bv) * wv : wv;
    Range h[2][2];
    if (lu >= lv) h[0][0] = {A.lo, c.x}, h[0][1] = B, h[1][0] = {c.x, A.hi}, h[1][1] = B;
    else h[0][0] = A, h[0][1] = {B.lo, c.y}, h[1][0] = A, h[1][1] = {c.y, B.hi};
    for (auto& k : h) {
      Box3 b;
      const bool okk = s.derivBox(k[0], k[1], 0, 0, b) == Status::ok;
      if (okk && !meets(b)) continue;
      queue.push({k[0], k[1], okk ? diameter(b) : kInf});
    }
  }

  // Crossings within tol of each other in 3D are one (a root on the side two rectangles share, a seam's two copies).
  std::sort(crossings.begin(), crossings.end(), [](const LineHit& x, const LineHit& y) { return x.t < y.t; });
  for (const LineHit& h : crossings) {
    bool same = false;
    for (const LineHit& k : out.crossings) same = same || norm(k.point - h.point) <= tol;
    if (!same) out.crossings.push_back(h);
  }
  // Contacts: clustered (single linkage within twice the contact size in 3D, neighbouring rectangles' points), each
  // cluster a tangency at its point nearest the line. (Points that near in 3D are as near in t: each one linked to
  // the next ones along t within that, by union-find.)
  const double link = 2 * contactSize + 2 * tol;
  std::sort(contacts.begin(), contacts.end(), [](const Contact& x, const Contact& y) { return x.t < y.t; });
  std::vector<size_t> parent(contacts.size());
  for (size_t i = 0; i < parent.size(); i++) parent[i] = i;
  auto root = [&](size_t i) {
    while (parent[i] != i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (size_t i = 0; i < contacts.size(); i++)
    for (size_t j = i + 1; j < contacts.size() && contacts[j].t - contacts[i].t <= link; j++)
      if (norm(contacts[j].p - contacts[i].p) <= link) parent[root(j)] = root(i);
  std::vector<int> cluster(contacts.size(), -1), id(contacts.size(), -1);
  int nc = 0;
  for (size_t i = 0; i < contacts.size(); i++) {
    const size_t r = root(i);
    if (id[r] < 0) id[r] = nc++;
    cluster[i] = id[r];
  }
  std::vector<Singularity> sing;
  s.singularities(sing);
  for (int k = 0; k < nc; k++) {
    double bd = kInf, lo = kInf, hi = -kInf;
    const Contact* best = nullptr;
    for (size_t i = 0; i < contacts.size(); i++) {
      if (cluster[i] != k) continue;
      const Contact& q = contacts[i];
      const double dist = norm((q.p - o) - q.t * ud);
      lo = minNum(lo, q.t), hi = maxNum(hi, q.t);
      if (dist < bd) bd = dist, best = &q;
    }
    LineHit h;
    h.t = best->t / dl, h.uv = best->uv, h.point = best->p;
    // (Widened by a contact rectangle's size, which each contact's point stands for.)
    h.span = {(lo - contactSize) / dl, (hi + contactSize) / dl};
    Vec3 n;
    if (s.normal(best->uv.x, best->uv.y, n) == Status::ok) h.cosine = dot(ud, n);
    for (const Singularity& g : sing)
      if (g.kind != Singularity::normalVanishes && norm(g.point - best->p) <= tol) h.atSingularity = true;
    out.tangencies.push_back(h);
  }
  // A crossing inside a tangency's or an overlap's reach is part of that contact, not a separate crossing.
  std::vector<LineHit> kept;
  for (const LineHit& h : out.crossings) {
    bool near = false;
    for (const LineHit& g : out.tangencies) near = near || norm(g.point - h.point) <= link;
    for (const Range& r : out.overlaps) near = near || (h.t >= r.lo - 2 * tol / dl && h.t <= r.hi + 2 * tol / dl);
    if (!near) kept.push_back(h);
  }
  out.crossings = std::move(kept);
  auto reduce = [&](Vec2& uv) {
    if (wrapU) uv.x = uv.x >= ru.hi ? uv.x - dom.uPeriod : uv.x < ru.lo ? uv.x + dom.uPeriod : uv.x;
    if (wrapV) uv.y = uv.y >= rv.hi ? uv.y - dom.vPeriod : uv.y < rv.lo ? uv.y + dom.vPeriod : uv.y;
    // (A hair under lo, plus the period, rounds to lo + period: lo then.)
    if (wrapU && uv.x >= ru.hi) uv.x = ru.lo;
    if (wrapV && uv.y >= rv.hi) uv.y = rv.lo;
  };
  for (LineHit& h : out.crossings) reduce(h.uv);
  for (LineHit& h : out.tangencies) reduce(h.uv);
  out.status = exhausted ? Status::noConvergence : Status::ok;
  return out;
}

} // namespace cadgeom
