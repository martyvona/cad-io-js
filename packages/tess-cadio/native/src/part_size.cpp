#include "tess_cadio/part_size.h"

#include <algorithm>
#include <cmath>
#include <memory>
#include <utility>
#include <vector>

#include "cad_geom/curve.h"
#include "cad_geom/surface.h"

namespace tesscadio {

using namespace cadgeom;

namespace {

constexpr int kSamples = 9;
/** The grid a face's feet without p-curves are seeded from, per direction. */
constexpr int kSeeds = 17;

struct Box {
  Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
  void add(Vec3 p) {
    if (!std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(p.z)) return;
    lo = {std::min(lo.x, p.x), std::min(lo.y, p.y), std::min(lo.z, p.z)};
    hi = {std::max(hi.x, p.x), std::max(hi.y, p.y), std::max(hi.z, p.z)};
  }
  double diagonal() const { return lo.x <= hi.x ? norm(hi - lo) : 0; }
};

bool finite(Range r) { return std::isfinite(r.lo) && std::isfinite(r.hi); }

/**
 * Edge e's range on its curve c, start to end: as given; else, for an edge from a vertex back to itself or without
 * vertices, the curve's domain; else from its vertices' parameters on the curve, a period added or taken the way
 * the edge runs (a short arc of a large circle sampled whole would be the circle's box). NaN where none.
 */
Range edgeRange(const Model& m, int e, const Curve& c) {
  const Range given = m.edgeRange(e);
  if (finite(given)) return given;
  const CurveDomain dom = c.domain();
  const bool sense = m.edgeSameSense(e);
  const int a = m.edgeStart(e), b = m.edgeEnd(e);
  if (a < 0 || b < 0 || a == b) return sense ? dom.range : Range{dom.range.hi, dom.range.lo};
  if (!finite(dom.range)) return {NAN, NAN};
  double t[2];
  for (int j = 0; j < 2; j++) {
    const double vt = m.f64(CBR_VERTEX_TOLERANCE)[j ? b : a];
    const CurveInversion ci = invertCurve(c, m.vertexPoint(j ? b : a), dom.range, std::isfinite(vt) && vt > 0 ? vt
      : 1e-7);
    if (ci.status != Status::ok) return {NAN, NAN};
    t[j] = ci.t;
  }
  if (dom.period > 0) {
    if (sense && t[1] <= t[0]) t[1] += dom.period;
    if (!sense && t[1] >= t[0]) t[1] -= dom.period;
  }
  return {t[0], t[1]};
}

/**
 * The hull of ranges a (empty where lo > hi) and b, b shifted by whole periods (if `period`) to make it the
 * narrowest.
 */
Range join(Range a, Range b, double period) {
  if (!(a.lo <= a.hi)) return b;
  if (!(period > 0)) return {std::min(a.lo, b.lo), std::max(a.hi, b.hi)};
  const double k0 = std::round((a.lo - b.lo) / period);
  Range best{NAN, NAN};
  for (double k = k0 - 1; k <= k0 + 1; k++) {
    const Range h{std::min(a.lo, b.lo + k * period), std::max(a.hi, b.hi + k * period)};
    if (!(best.hi - best.lo <= h.hi - h.lo)) best = h;
  }
  return best;
}

/** t at sample k of kSamples over r. */
double at(Range r, int k) { return r.lo + (r.hi - r.lo) * k / (kSamples - 1); }

/** `r` clamped to `d` where d isn't periodic, at most one period wide where it is. */
Range within(Range r, Range d, double period) {
  if (period > 0) return r.hi - r.lo > period ? Range{d.lo, d.lo + period} : r;
  return {std::max(r.lo, d.lo), std::min(r.hi, d.hi)};
}

} // namespace

double partSize(const Model& m) {
  Box box;
  for (int i = 0; i < m.vertices(); i++) box.add(m.vertexPoint(i));
  std::vector<std::unique_ptr<Curve>> curves(m.curves());
  auto curve = [&](int row) -> const Curve* {
    if (row < 0 || row >= m.curves()) return nullptr;
    if (!curves[row]) {
      Status st;
      curves[row] = makeCurve(m, row, st);
    }
    return curves[row].get();
  };
  for (int e = 0; e < m.edges(); e++) {
    const Curve* c = curve(m.edgeCurve(e));
    if (!c) continue;
    const Range r = edgeRange(m, e, *c);
    if (!finite(r)) continue;
    CurvePoint q;
    for (int k = 0; k < kSamples; k++)
      if (c->eval(at(r, k), 0, q) == Status::ok) box.add(q.p);
  }
  // (Planes, cylinders, cones and extrusions are unbounded and ruled: their faces' edges bound them.)
  for (int f = 0; f < m.faces(); f++) {
    Status st;
    const std::unique_ptr<Surface> s = makeSurface(m, m.faceSurface(f), st);
    if (!s) continue;
    const SurfaceDomain D = s->domain();
    if (!finite(D.u) || !finite(D.v)) continue;
    Range ru{INFINITY, -INFINITY}, rv{INFINITY, -INFINITY};
    // The surface on a kSeeds x kSeeds grid over its domain, made when first asked: the seeds of the feet found.
    std::vector<std::pair<Vec2, Vec3>> seeds;
    auto nearestNode = [&](Vec3 p) {
      if (seeds.empty()) {
        SurfacePoint g;
        for (int i = 0; i < kSeeds; i++)
          for (int j = 0; j < kSeeds; j++) {
            const Vec2 uv{D.u.lo + (D.u.hi - D.u.lo) * i / (kSeeds - 1), D.v.lo + (D.v.hi - D.v.lo) * j / (kSeeds - 1)};
            if (s->eval(uv.x, uv.y, 0, g) == Status::ok) seeds.push_back({uv, g.p});
          }
      }
      Vec2 best{0.5 * (D.u.lo + D.u.hi), 0.5 * (D.v.lo + D.v.hi)};
      double d = INFINITY;
      for (const auto& [uv, at] : seeds)
        if (norm(at - p) < d) d = norm(at - p), best = uv;
      return best;
    };
    // (The loops' travel round each periodic direction, its steps each taken within half a period.)
    double du = 0, dv = 0;
    bool loops = false;
    // (Each loop's (u, v) box followed continuously, and its own travel round each direction.)
    struct Bound {
      Range u, v;
      double du, dv;
    };
    std::vector<Bound> bounds;
    for (int i = 0; i < m.faceLoopCount(f); i++) {
      const int l = m.faceFirstLoop(f) + i;
      if (m.loopKind(l) != CBR_LOOP_EDGE) continue;
      loops = true;
      std::vector<Vec2> uv;
      for (int j = 0; j < m.loopCount(l); j++) {
        const int c = m.loopFirst(l) + j;
        const size_t first = uv.size();
        // (Samples from the edge's start to its end, as coedge and edge ranges both run.)
        const Curve* p = curve(m.coedgePcurve(c));
        CurvePoint q;
        bool sampled = false;
        if (p && p->dim() == 2) {
          const Range r{m.f64(CBR_COEDGE_RANGE)[2 * c], m.f64(CBR_COEDGE_RANGE)[2 * c + 1]};
          if (finite(r)) {
            sampled = true;
            for (int k = 0; k < kSamples; k++)
              if (p->eval(at(r, k), 0, q) == Status::ok) uv.push_back({q.p.x, q.p.y});
          }
        }
        const int e = m.coedgeEdge(c);
        const Curve* ec = curve(m.edgeCurve(e));
        const Range r = ec ? edgeRange(m, e, *ec) : Range{NAN, NAN};
        if (!sampled && finite(r)) {
          // (Each point's foot continued from the one before, else from the nearest of a coarse grid's nodes: a
          // global inversion costs minutes on a part of large B-spline faces without p-curves, and a box needs no
          // certified foot.)
          bool have = false;
          Vec2 last{};
          for (int k = 0; k < kSamples; k++) {
            if (ec->eval(at(r, k), 0, q) != Status::ok) continue;
            LocalFoot lf;
            if (have) lf = localFoot(*s, q.p, last);
            if (lf.status != Status::ok) lf = localFoot(*s, q.p, nearestNode(q.p));
            if (lf.status == Status::ok) uv.push_back(last = lf.uv), have = true;
          }
        }
        if (m.coedgeOrientation(c) != CBR_ORIENTATION_FORWARD) std::reverse(uv.begin() + first, uv.end());
      }
      if (uv.empty()) continue;
      // (The loop followed continuously in a periodic direction, so one crossing the seam spans its own patch, not
      // the period.)
      Vec2 at = uv[0];
      Range lu{at.x, at.x}, lv{at.y, at.y};
      double ldu = 0, ldv = 0;
      for (size_t k = 0; k < uv.size(); k++) {
        const Vec2 a = uv[k], b = uv[(k + 1) % uv.size()];
        const double su = D.uPeriod > 0 ? std::remainder(b.x - a.x, D.uPeriod) : b.x - a.x;
        const double sv = D.vPeriod > 0 ? std::remainder(b.y - a.y, D.vPeriod) : b.y - a.y;
        ldu += D.uPeriod > 0 ? su : 0, ldv += D.vPeriod > 0 ? sv : 0;
        if (k + 1 == uv.size()) break;
        at = {at.x + su, at.y + sv};
        lu = {std::min(lu.lo, at.x), std::max(lu.hi, at.x)}, lv = {std::min(lv.lo, at.y), std::max(lv.hi, at.y)};
      }
      du += ldu, dv += ldv;
      bounds.push_back({lu, lv, ldu, ldv});
      ru = join(ru, lu, D.uPeriod), rv = join(rv, lv, D.vPeriod);
    }
    if (!loops) ru = D.u, rv = D.v;
    if (!(ru.lo <= ru.hi) || !(rv.lo <= rv.hi)) continue;
    const bool sense = m.faceSameSense(f);
    // Loops winding round one direction, the other not periodic (a sphere's cap round its pole): the face reaches the
    // domain's side to their left in (u, v), seen along its normal (the right where the face runs against its
    // surface), which no loop's samples do.
    if (D.uPeriod > 0 && !(D.vPeriod > 0) && std::fabs(du) > 0.5 * D.uPeriod) {
      if ((du > 0) == sense) rv.hi = D.v.hi;
      else rv.lo = D.v.lo;
    }
    if (D.vPeriod > 0 && !(D.uPeriod > 0) && std::fabs(dv) > 0.5 * D.vPeriod) {
      if ((dv > 0) == sense) ru.lo = D.u.lo;
      else ru.hi = D.u.hi;
    }
    // Loops winding round one direction, the other periodic too (a torus's band between two circles): the face runs
    // from a loop it lies to the left of (as above) to one it lies to the right of, whichever way round that is. (With
    // none of one kind, the loops' own box: a lone loop winding one way can't bound a face on a torus, so its feet
    // are taken as wrong rather than the face as the whole torus.)
    auto across = [&](bool alongU, Range& r) {
      const double P = alongU ? D.uPeriod : D.vPeriod, Q = alongU ? D.vPeriod : D.uPeriod;
      if (!(P > 0) || !(Q > 0)) return;
      double start = NAN, end = NAN;
      for (const Bound& b : bounds) {
        const double t = alongU ? b.du : b.dv;
        if (!(std::fabs(t) > 0.5 * P)) continue;
        // (Toward the other coordinate's increase: left of travel along u, right of travel along v.)
        const bool up = ((t > 0) == sense) == alongU;
        const Range o = alongU ? b.v : b.u;
        if (up && std::isnan(start)) start = o.lo;
        if (!up && std::isnan(end)) end = o.hi;
      }
      if (std::isnan(start) || std::isnan(end)) return;
      end -= std::floor((end - start) / Q) * Q;
      r = {start, end};
    };
    across(true, rv), across(false, ru);
    ru = within(ru, D.u, D.uPeriod), rv = within(rv, D.v, D.vPeriod);
    SurfacePoint q;
    for (int i = 0; i < kSamples; i++)
      for (int j = 0; j < kSamples; j++)
        if (s->eval(at(ru, i), at(rv, j), 0, q) == Status::ok) box.add(q.p);
  }
  return box.diagonal();
}

} // namespace tesscadio
