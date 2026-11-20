// surface.h: makeSurface (each kind in surface_elementary.cpp, surface_spline.cpp, surface_compound.cpp), the shared
// parts of SurfaceImpl, and point inversion.
// Inversion: branch and bound on parameter rectangles (Patrikalakis, Maekawa and Cho, "Shape Interrogation for
// Computer Aided Design and Manufacturing", sections 4.6 and 6.3, as curve.cpp on intervals): a rectangle is
// discarded when its box is farther from p than the best distance found plus tol; it is solved when g = |S - p|^2 / 2
// is convex on it (its Hessian [S_u.S_u + (S - p).S_uu, S_u.S_v + (S - p).S_uv; ...] positive definite over the
// rectangle, by interval arithmetic on the partials' boxes), since a convex g has one minimum there, found by Newton
// projected onto the rectangle; else it is split across its longer side (in 3D). Infinite ranges are first cut to a
// box holding every point as near as one already found (the kinds' within()); elementary kinds take their feet in
// closed form (footCandidates). A hint seeds the best distance and breaks ties among equally near feet; it never
// replaces the search. A rectangle whose box is within tol all over (or as narrow as its coordinates' rounding) is
// one foot wherever it is in there, and singular iso-lines' points are candidates from the start (no rectangle beside
// a pole is convex, S_u vanishing there). A convex rectangle's minimum pushed against a side inside the search range
// is not a foot (the rectangle beyond holds the minimum). Feet within tol of the best are the same foot (a seam's or
// pole's other parameters: flags) or alternatives (other places, one per cluster). The search is budgeted: where it
// runs out with a better foot still possible, it says noConvergence.
#include "cad_geom/surface.h"

#include <algorithm>
#include <cmath>
#include <queue>

#include "surface_impl.h"

namespace cadgeom {

namespace surfaces {

Status SurfaceImpl::eval(double u, double v, int order, SurfacePoint& out) const {
  if (order < 0 || order > 2) return Status::unsupported;
  Vec3 d[kPartials];
  Status s = derivs(u, v, order, d);
  out = {d[0], order >= 1 ? d[pidx(1, 0)] : Vec3{}, order >= 1 ? d[pidx(0, 1)] : Vec3{},
    order >= 2 ? d[pidx(2, 0)] : Vec3{}, order >= 2 ? d[pidx(1, 1)] : Vec3{}, order >= 2 ? d[pidx(0, 2)] : Vec3{}};
  return s;
}

Status SurfaceImpl::normal(double u, double v, Vec3& out) const {
  Vec3 d[kPartials];
  Status s = derivs(u, v, 2, d);
  if (s != Status::ok && s != Status::outOfDomain) return s;
  Vec3 su = d[pidx(1, 0)], sv = d[pidx(0, 1)], n = cross(su, sv);
  double big = std::fmax(norm(su), norm(sv));
  if (big > 0 && norm(n) > 1e-12 * big * big) {
    out = (1 / norm(n)) * n;
    return s;
  }
  // Vanishing: where one partial is zero (a pole: S_u = 0) the limit of S_uv x S_v along the other, else none.
  Vec3 lim = norm(su) <= norm(sv) ? cross(d[pidx(1, 1)], sv) : cross(su, d[pidx(1, 1)]);
  out = norm(lim) > 0 ? (1 / norm(lim)) * lim : Vec3{};
  return Status::singular;
}

Status SurfaceImpl::derivBound(Range ru, Range rv, int order, double out[3]) const {
  if (order != 1 && order != 2) return Status::unsupported;
  out[0] = out[1] = out[2] = 0;
  for (int l = 0; l <= order; l++) {
    Box3 b;
    Status s = derivBox(ru, rv, order - l, l, b);
    if (s != Status::ok) {
      out[0] = out[1] = out[2] = kInf;
      return s;
    }
    out[l] = boxNorm(b);
  }
  return Status::ok;
}

Status centredBox(const SurfaceImpl& s, Range ru, Range rv, int k, int l, Box3& out) {
  if (k + l + 1 >= kMaxOrder || !finite(ru) || !finite(rv)) return Status::unsupported;
  Box3 bu, bv;
  Status a = s.derivBox(ru, rv, k + 1, l, bu), b = s.derivBox(ru, rv, k, l + 1, bv);
  if (a != Status::ok) return a;
  if (b != Status::ok) return b;
  double mu = 0.5 * ru.lo + 0.5 * ru.hi, mv = 0.5 * rv.lo + 0.5 * rv.hi;
  Vec3 d[kPartials];
  Status e = s.derivs(mu, mv, k + l, d);
  if (e != Status::ok && e != Status::outOfDomain) return e;
  double hu = std::fmax(mu - ru.lo, ru.hi - mu), hv = std::fmax(mv - rv.lo, rv.hi - mv);
  Vec3 c = d[pidx(k, l)];
  // Widened by the evaluation's own rounding: relative to the partial, and for a point to its local size.
  double r = (boxNorm(bu) * hu + boxNorm(bv) * hv) * (1 + 8 * kEps);
  double err = (k + l == 0 ? 8 * kEps : 1e-12) * maxAbs(c) + 1e-13 * r;
  out = ballBox(c, r + err);
  return Status::ok;
}

bool nearSingularity(const Surface& s, Vec3 q, double tol) {
  std::vector<Singularity> sing;
  s.singularities(sing);
  for (const Singularity& g : sing)
    if (g.kind != Singularity::normalVanishes && norm(g.point - q) <= tol) return true;
  return false;
}

std::unique_ptr<SurfaceImpl> make(const Model& m, int row, int depth, Status& status) {
  status = Status::invalidModel;
  if (row < 0 || row >= m.surfaces() || depth > 32) return nullptr;
  int ro = m.i32(CBR_SURFACE_REAL)[row], io = m.i32(CBR_SURFACE_INT)[row];
  long nr = static_cast<long>(m.count(CBR_POOL_SURFACE_REAL)) - ro;
  long ni = static_cast<long>(m.count(CBR_POOL_SURFACE_INT)) - io;
  if (ro < 0 || io < 0 || nr < 0 || ni < 0) return nullptr;
  const double* r = m.surfaceReals(row);
  const int32_t* in = m.surfaceInts(row);
  auto basis = [&](int b) { return make(m, b, depth + 1, status); };
  switch (m.surfaceKind(row)) {
  case CBR_SURFACE_PLANE:
    if (nr < 9) return nullptr;
    status = Status::ok;
    return makePlane(r);
  case CBR_SURFACE_CYLINDER:
    if (nr < 10 || !(r[9] > 0)) return nullptr;
    status = Status::ok;
    return makeCone(r, r[9], 0);
  case CBR_SURFACE_CONE:
    if (nr < 11 || !(r[9] >= 0) || !(std::fabs(r[10]) > 0 && std::fabs(r[10]) < kHalfPi)) return nullptr;
    status = Status::ok;
    return makeCone(r, r[9], std::tan(r[10]));
  case CBR_SURFACE_SPHERE:
    if (nr < 10 || !(r[9] > 0)) return nullptr;
    status = Status::ok;
    return makeSphere(r);
  case CBR_SURFACE_TORUS:
    if (nr < 11 || !(r[9] > 0) || !(r[10] > 0)) return nullptr;
    status = Status::ok;
    return makeTorus(r);
  case CBR_SURFACE_BSPLINE: {
    if (ni < 11) return nullptr;
    long ku = in[4], kv = in[5], nu = in[2], nv = in[3];
    if (ku < 2 || kv < 2 || nu < 1 || nv < 1 || ni < 11 + ku + kv) return nullptr;
    if (nr < ku + kv + 3 * nu * nv + (in[6] ? nu * nv : 0)) return nullptr;
    return makeBSpline(r, in, status);
  }
  case CBR_SURFACE_EXTRUSION:
    if (nr < 4 || ni < 1 || !(r[3] > 0)) return nullptr;
    return makeExtrusion(m, in[0], r, depth, status);
  case CBR_SURFACE_REVOLUTION:
    if (nr < 6 || ni < 1) return nullptr;
    return makeRevolution(m, in[0], r, depth, status);
  case CBR_SURFACE_OFFSET: {
    if (nr < 1 || ni < 1 || !std::isfinite(r[0])) return nullptr;
    std::unique_ptr<SurfaceImpl> b = basis(in[0]);
    if (!b) return nullptr;
    status = Status::ok;
    return makeOffset(std::move(b), r[0]);
  }
  case CBR_SURFACE_RECTANGULAR_TRIMMED: {
    if (nr < 4 || ni < 3) return nullptr;
    std::unique_ptr<SurfaceImpl> b = basis(in[0]);
    if (!b) return nullptr;
    return makeTrimmed(std::move(b), r, status);
  }
  default: status = Status::unsupported; return nullptr;
  }
}

} // namespace surfaces

using namespace surfaces;

std::unique_ptr<Surface> makeSurface(const Model& model, int row, Status& status) {
  return make(model, row, 0, status);
}

namespace {

struct Node {
  Range u, v;
  double lb;
  bool operator<(const Node& o) const { return lb > o.lb; }  // a min-heap on the lower bound
};
struct Candidate {
  Vec2 uv;
  double d;
  Vec3 foot;
};

/**
 * The minimum of g = |S - p|^2 / 2 over a rectangle where g is convex there: Newton steps projected onto it, a
 * coordinate the gradient pushes out of it held at its bound while the other is minimized alone (convex in it too).
 */
Vec2 convexMinimum(const SurfaceImpl& s, Vec3 p, Range ru, Range rv, Vec2 start, bool* pushedOut = nullptr) {
  Vec2 x{std::clamp(start.x, ru.lo, ru.hi), std::clamp(start.y, rv.lo, rv.hi)};
  bool pushU = false, pushV = false;
  for (int it = 0; it < 100; it++) {
    Vec3 d[kPartials];
    s.derivs(x.x, x.y, 2, d);
    Vec3 e = d[0] - p, su = d[pidx(1, 0)], sv = d[pidx(0, 1)];
    double gu = dot(e, su), gv = dot(e, sv);
    double huu = dot(su, su) + dot(e, d[pidx(2, 0)]), huv = dot(su, sv) + dot(e, d[pidx(1, 1)]);
    double hvv = dot(sv, sv) + dot(e, d[pidx(0, 2)]);
    bool fu = (x.x <= ru.lo && gu > 0) || (x.x >= ru.hi && gu < 0);
    bool fv = (x.y <= rv.lo && gv > 0) || (x.y >= rv.hi && gv < 0);
    // Pushed out by more than the gradient's rounding: the minimum over the plane is past that side. The rounding of
    // S - p is the coordinates' (|p| eps), not only the distance's: for a point on the surface S - p is rounding alone,
    // its direction anything, and a foot on a side two rectangles share (their halving's middles) would count as
    // pushed past it from both and be lost.
    double slack = 64 * kEps * (norm(e) + norm(p)) + 1e-300;
    pushU = fu && std::fabs(gu) > slack * norm(su), pushV = fv && std::fabs(gv) > slack * norm(sv);
    Vec2 n = x;
    if (!fu && !fv) {
      double det = huu * hvv - huv * huv;
      if (det > 0 && huu > 0) n = {x.x - (hvv * gu - huv * gv) / det, x.y - (huu * gv - huv * gu) / det};
      else n = {x.x - (huu > 0 ? gu / huu : 0), x.y - (hvv > 0 ? gv / hvv : 0)};
    } else if (!fu) {
      n.x = x.x - (huu > 0 ? gu / huu : 0);
    } else if (!fv) {
      n.y = x.y - (hvv > 0 ? gv / hvv : 0);
    }
    n = {std::clamp(n.x, ru.lo, ru.hi), std::clamp(n.y, rv.lo, rv.hi)};
    double step = std::fabs(n.x - x.x) + std::fabs(n.y - x.y);
    x = n;
    if (step <= 4 * kEps * (1 + std::fabs(x.x) + std::fabs(x.y))) break;
  }
  if (pushedOut) {
    // Which sides: (u at ru's lo or hi, v at rv's lo or hi), encoded for the caller as pushes on each.
    pushedOut[0] = pushU && x.x <= ru.lo, pushedOut[1] = pushU && x.x >= ru.hi;
    pushedOut[2] = pushV && x.y <= rv.lo, pushedOut[3] = pushV && x.y >= rv.hi;
  }
  return x;
}

/**
 * The point of the rectangle nearest p from `start`: Gauss-Newton steps on |S - p|^2 / 2 clamped to it, each taken
 * only where it comes nearer (so never farther than start; where the normal matrix is singular, as beside a pole,
 * each coordinate alone).
 */
Vec2 nearestInBox(const SurfaceImpl& s, Vec3 p, Range ru, Range rv, Vec2 start) {
  Vec2 x = start;
  Vec3 d[kPartials];
  s.derivs(x.x, x.y, 1, d);
  double best = norm(d[0] - p);
  for (int it = 0; it < 32; it++) {
    Vec3 e = d[0] - p, su = d[pidx(1, 0)], sv = d[pidx(0, 1)];
    double gu = dot(e, su), gv = dot(e, sv), a = dot(su, su), b = dot(su, sv), c = dot(sv, sv);
    double det = a * c - b * b;
    Vec2 n = x;
    if (det > 1e-12 * a * c && a > 0) n = {x.x - (c * gu - b * gv) / det, x.y - (a * gv - b * gu) / det};
    else n = {x.x - (a > 0 ? gu / a : 0), x.y - (c > 0 ? gv / c : 0)};
    n = {std::clamp(n.x, ru.lo, ru.hi), std::clamp(n.y, rv.lo, rv.hi)};
    Vec3 dn[kPartials];
    s.derivs(n.x, n.y, 1, dn);
    double dist = norm(dn[0] - p);
    if (!(dist < best)) break;
    double step = std::fabs(n.x - x.x) + std::fabs(n.y - x.y);
    x = n, best = dist;
    std::copy(dn, dn + kPartials, d);
    if (step <= 4 * kEps * (1 + std::fabs(x.x) + std::fabs(x.y))) break;
  }
  return x;
}

/** Whether u is closed over the whole of ru: a period, or S equal at the domain's two ends at v (within tol). */
bool closedU(const SurfaceImpl& s, Range ru, double v, double tol) {
  SurfaceDomain dom = s.domain();
  if (dom.uPeriod > 0) return ru.hi - ru.lo >= dom.uPeriod * (1 - 8 * kEps);
  if (!finite(dom.u) || !(ru.lo <= dom.u.lo && ru.hi >= dom.u.hi)) return false;
  SurfacePoint a, b;
  s.eval(dom.u.lo, v, 0, a), s.eval(dom.u.hi, v, 0, b);
  return norm(a.p - b.p) <= tol;
}
bool closedV(const SurfaceImpl& s, Range rv, double u, double tol) {
  SurfaceDomain dom = s.domain();
  if (dom.vPeriod > 0) return rv.hi - rv.lo >= dom.vPeriod * (1 - 8 * kEps);
  if (!finite(dom.v) || !(rv.lo <= dom.v.lo && rv.hi >= dom.v.hi)) return false;
  SurfacePoint a, b;
  s.eval(u, dom.v.lo, 0, a), s.eval(u, dom.v.hi, 0, b);
  return norm(a.p - b.p) <= tol;
}

/** The distance in (u, v) between two parameter pairs, periods taken the short way. */
double uvDistance(Vec2 a, Vec2 b, const SurfaceDomain& dom) {
  auto d = [](double x, double period) {
    if (!(period > 0)) return x;
    double r = std::fmod(x, period);
    return std::fmin(r, period - r);
  };
  return std::hypot(d(std::fabs(a.x - b.x), dom.uPeriod), d(std::fabs(a.y - b.y), dom.vPeriod));
}

} // namespace

long surfaces::inversionRects = 0;

const SurfaceImpl::SpanGrid& SurfaceImpl::spanGrid(Range ru, Range rv) const {
  if (grid_ && grid_->u.lo == ru.lo && grid_->u.hi == ru.hi && grid_->v.lo == rv.lo && grid_->v.hi == rv.hi)
    return *grid_;
  auto g = std::make_unique<SpanGrid>();
  g->u = ru, g->v = rv;
  breaks(ru, rv, g->us, g->vs);
  for (size_t i = 0; i + 1 < g->us.size(); i++)
    for (size_t j = 0; j + 1 < g->vs.size(); j++) {
      const Range a{g->us[i], g->us[i + 1]}, b{g->vs[j], g->vs[j + 1]};
      Box3 box;
      g->ok.push_back(derivBox(a, b, 0, 0, box) == Status::ok);
      g->box.push_back(box);
      Vec3 d[kPartials];
      derivs(0.5 * a.lo + 0.5 * a.hi, 0.5 * b.lo + 0.5 * b.hi, 0, d);
      g->mid.push_back(d[0]);
    }
  grid_ = std::move(g);
  return *grid_;
}

// Moved from tess-cadio's edges.cpp (localTrace), its thresholds as tuned there on the 406-part subset.
LocalFoot localFoot(const Surface& s, Vec3 p, Vec2 start) {
  LocalFoot out;
  const SurfaceDomain dom = s.domain();
  const bool perU = dom.uPeriod > 0, perV = dom.vPeriod > 0;
  Vec2 x = start;
  SurfacePoint q;
  if (Status st = s.eval(x.x, x.y, 1, q); st != Status::ok) {
    out.status = st;
    return out;
  }
  double best = norm(q.p - p);
  bool converged = false;
  int it = 0;
  // The surface's breaks inside its domain (knots, a profile's) and a periodic direction's seam: on a C0 one (a
  // crease) the partials jump, and the evaluation gives one side's.
  std::vector<double> bu, bv;
  s.breaks(dom.u, dom.v, bu, bv);
  auto interior = [](std::vector<double>& b, Range r) {
    b.erase(std::remove_if(b.begin(), b.end(), [&](double x) { return !(x > r.lo && x < r.hi); }), b.end());
  };
  interior(bu, dom.u), interior(bv, dom.v);
  // (A periodic direction's seam is one too: a closed profile's corner can be there.)
  if (perU) bu.insert(bu.begin(), dom.u.lo);
  if (perV) bv.insert(bv.begin(), dom.v.lo);
  // The Newton step from x with the partials sq; false where the normal matrix degenerates. Held against a side of
  // the domain (a direction that isn't periodic): along that side instead, the other coordinate's Newton step alone;
  // in a corner, held there.
  auto newton = [&](const SurfacePoint& sq, Vec2 x, Vec2& n) {
    const Vec3 e = sq.p - p;
    const double gu = dot(e, sq.du), gv = dot(e, sq.dv), a = dot(sq.du, sq.du), b = dot(sq.du, sq.dv),
                 c = dot(sq.dv, sq.dv);
    const double det = a * c - b * b;
    // (A collapsed direction, a pole row's, too: there the relative test alone passes on S_u's rounding.)
    if (!(det > 1e-12 * a * c && a > 0) || std::fmin(a, c) <= 1e-24 * std::fmax(a, c)) return false;
    n = {x.x - (c * gu - b * gv) / det, x.y - (a * gv - b * gu) / det};
    const bool heldU = !perU && (n.x < dom.u.lo || n.x > dom.u.hi);
    const bool heldV = !perV && (n.y < dom.v.lo || n.y > dom.v.hi);
    if (heldU && !heldV) n = {std::clamp(n.x, dom.u.lo, dom.u.hi), x.y - gv / c};
    if (heldV && !heldU) n = {x.x - gu / a, std::clamp(n.y, dom.v.lo, dom.v.hi)};
    if (!perU) n.x = std::clamp(n.x, dom.u.lo, dom.u.hi);
    if (!perV) n.y = std::clamp(n.y, dom.v.lo, dom.v.hi);
    return true;
  };
  for (; it < 32 && !converged; it++) {
    Vec2 n;
    if (!newton(q, x, n)) {
      out.status = Status::singular, out.uv = x, out.point = q.p, out.distance = best, out.iterations = it;
      return out;
    }
    // On a break, the step of the side it heads into: each side's partials (just below and just above it), the
    // evaluation's own step kept where it heads into a side whose step agrees, else the one side's whose step
    // heads into it (a polyline extrusion's corner: the other leg's S_u is across the first, its step there 0).
    SurfacePoint used = q;
    for (int k = 0; k < 2; k++) {
      const std::vector<double>& bs = k ? bv : bu;
      if (bs.empty()) continue;
      const Range r = k ? dom.v : dom.u;
      const double period = k ? dom.vPeriod : dom.uPeriod, xk = k ? x.y : x.x;
      double xr = period > 0 ? r.lo + std::fmod(std::fmod(xk - r.lo, period) + period, period) : xk;
      if (period > 0 && xr >= r.hi - 1e-12 * (1 + std::fabs(r.hi))) xr -= period;  // just below the seam
      auto at = std::lower_bound(bs.begin(), bs.end(), xr - 1e-12 * (1 + std::fabs(xr)));
      if (at == bs.end() || std::fabs(*at - xr) > 1e-12 * (1 + std::fabs(xr))) continue;
      const double lo = at != bs.begin() ? *(at - 1) : period > 0 ? (bs.size() > 1 ? bs.back() : *at) - period : r.lo;
      const double hi = at + 1 != bs.end() ? *(at + 1) : period > 0 ? bs.front() + period : r.hi;
      const double step = std::fmin(1e-9 * (r.hi - r.lo), 0.25 * std::fmin(*at - lo, hi - *at));
      Vec2 xb = x, xa = x;
      (k ? xb.y : xb.x) = xk + (*at - xr) - step, (k ? xa.y : xa.x) = xk + (*at - xr) + step;
      SurfacePoint qb, qa;
      Vec2 nb, na;
      const bool okB = s.eval(xb.x, xb.y, 1, qb) == Status::ok && newton(qb, x, nb);
      const bool okA = s.eval(xa.x, xa.y, 1, qa) == Status::ok && newton(qa, x, na);
      const double tiny = 1e-12 * (r.hi - r.lo);
      const double own = k ? n.y - x.y : n.x - x.x;
      const bool intoBelow = okB && (k ? nb.y - x.y : nb.x - x.x) < -tiny;
      const bool intoAbove = okA && (k ? na.y - x.y : na.x - x.x) > tiny;
      if ((own > tiny && intoAbove) || (own < -tiny && intoBelow)) continue;
      if (intoBelow && !intoAbove) n = nb, used = qb;
      else if (intoAbove && !intoBelow) n = na, used = qa;
    }
    // At a foot the step it takes is nothing: in 3D within rounding of p or a millionth of its distance.
    if (norm((n.x - x.x) * used.du + (n.y - x.y) * used.dv) <= std::max(1e-12 * (1 + norm(p)), 1e-6 * best)) {
      converged = true;
      break;
    }
    SurfacePoint qn;
    if (s.eval(n.x, n.y, 1, qn) != Status::ok) break;
    const double d = norm(qn.p - p);
    if (!(d < best)) {
      // (No nearer: the surface's own rounding, where the step left is that small, or a stall away from a foot.)
      converged = norm((n.x - x.x) * used.du + (n.y - x.y) * used.dv) <= std::max(1e-9 * (1 + norm(p)), 1e-4 * best);
      break;
    }
    x = n, q = qn, best = d;
  }
  out.uv = x, out.point = q.p, out.distance = best, out.iterations = it;
  out.status = converged ? Status::ok : Status::noConvergence;
  if (converged) {
    if (!perU && x.x == dom.u.lo) out.side = 0;
    else if (!perU && x.x == dom.u.hi) out.side = 1;
    else if (!perV && x.y == dom.v.lo) out.side = 2;
    else if (!perV && x.y == dom.v.hi) out.side = 3;
  }
  return out;
}

SurfaceInversion invertSurface(const Surface& s0, Vec3 p, Range ru, Range rv, double tol, const Vec2* hint,
  std::vector<SurfaceFoot>* all, bool distanceOnly) {
  SurfaceInversion out;
  const SurfaceImpl* impl = dynamic_cast<const SurfaceImpl*>(&s0);
  if (!impl) return out;
  const SurfaceImpl& s = *impl;
  SurfaceDomain dom = s.domain();
  tol = std::fmax(tol, 0.0);
  if (!(ru.lo <= ru.hi) || !(rv.lo <= rv.hi)) {
    out.status = Status::outOfDomain;
    return out;
  }
  auto at = [&](Vec2 uv) {
    Vec3 d[kPartials];
    s.derivs(uv.x, uv.y, 0, d);
    return d[0];
  };
  // Periodic directions searched over one period from the range's start; others cut to the domain.
  bool wrapU = dom.uPeriod > 0 && ru.hi - ru.lo >= dom.uPeriod * (1 - 8 * kEps);
  bool wrapV = dom.vPeriod > 0 && rv.hi - rv.lo >= dom.vPeriod * (1 - 8 * kEps);
  if (wrapU) ru.hi = ru.lo + dom.uPeriod;
  if (wrapV) rv.hi = rv.lo + dom.vPeriod;
  if (dom.uPeriod == 0) ru = {std::fmax(ru.lo, dom.u.lo), std::fmin(ru.hi, dom.u.hi)};
  if (dom.vPeriod == 0) rv = {std::fmax(rv.lo, dom.v.lo), std::fmin(rv.hi, dom.v.hi)};
  if (!(ru.lo <= ru.hi) || !(rv.lo <= rv.hi)) {
    out.status = Status::outOfDomain;
    return out;
  }
  // A seed: the hint, else the range's (u, v) nearest (0, 0); infinite ranges cut by its distance.
  auto clampUV = [&](Vec2 x) { return Vec2{std::clamp(x.x, ru.lo, ru.hi), std::clamp(x.y, rv.lo, rv.hi)}; };
  Vec2 seed = clampUV(hint ? *hint : Vec2{0, 0});
  if (!finite(ru) || !finite(rv)) {
    Range wu, wv;
    s.within(p, norm(at(seed) - p) * (1 + 1e-9) + tol, wu, wv);
    ru = {std::fmax(ru.lo, wu.lo), std::fmin(ru.hi, wu.hi)};
    rv = {std::fmax(rv.lo, wv.lo), std::fmin(rv.hi, wv.hi)};
    if (!finite(ru) || !finite(rv) || !(ru.lo <= ru.hi) || !(rv.lo <= rv.hi)) {
      out.status = Status::unsupported;
      return out;
    }
    seed = clampUV(seed);
  }

  std::vector<Candidate> cands;
  double ub = kInf;
  auto add = [&](Vec2 uv) {
    Vec3 f = at(uv);
    double d = norm(f - p);
    ub = std::fmin(ub, d);
    cands.push_back({uv, d, f});
  };
  // What a rectangle's lower bound must not pass to be searched: the nearest found plus tol (every foot within tol
  // of it, for the alternatives), or for a distance alone less eps. A point that lowers the bound is then a
  // candidate too, so the distance returned is the bound.
  const double eps = 1e-3 * tol, slack = distanceOnly ? -eps : tol;
  auto bound = [&](Vec2 uv, Vec3 f) {
    const double d = norm(f - p);
    if (d < ub && distanceOnly) cands.push_back({uv, d, f});
    ub = std::fmin(ub, d);
  };
  int budget = 40000;
  bool exhausted = false;
  double leftLb = kInf;
  std::vector<Vec2> known;
  if (s.footCandidates(p, ru, rv, tol, known)) {
    for (Vec2 uv : known) add(uv);
  } else {
    const SurfaceImpl::SpanGrid& grid = s.spanGrid(ru, rv);
    std::priority_queue<Node> queue;
    auto lower = [&](Range a, Range b) {
      Box3 box;
      return s.derivBox(a, b, 0, 0, box) == Status::ok ? boxDistance(box, p) : 0.0;
    };
    if (hint) add(convexMinimum(s, p, ru, rv, seed));
    // The singular iso-lines' points: a pole is a foot no rectangle beside it can prove convex.
    std::vector<Singularity> sing;
    s.singularities(sing);
    for (const Singularity& g : sing) {
      if (g.kind == Singularity::normalVanishes) continue;
      Range r = g.isoU ? ru : rv;
      if (g.at >= r.lo && g.at <= r.hi) add(g.isoU ? Vec2{g.at, seed.y} : Vec2{seed.x, g.at});
    }
    // The grid's rectangles, their lower bounds from its boxes and the upper bound from its middles.
    const std::vector<double>& us = grid.us;
    const std::vector<double>& vs = grid.vs;
    for (size_t i = 0, k = 0; i + 1 < us.size(); i++)
      for (size_t j = 0; j + 1 < vs.size(); j++, k++) {
        bound({0.5 * us[i] + 0.5 * us[i + 1], 0.5 * vs[j] + 0.5 * vs[j + 1]}, grid.mid[k]);
        queue.push({{us[i], us[i + 1]}, {vs[j], vs[j + 1]}, grid.ok[k] ? boxDistance(grid.box[k], p) : 0.0});
      }
    while (!queue.empty()) {
      Node n = queue.top();
      queue.pop();
      if (n.lb > ub + slack) continue;
      inversionRects++;
      Range a = n.u, b = n.v;
      Vec2 mid{0.5 * a.lo + 0.5 * a.hi, 0.5 * b.lo + 0.5 * b.hi};
      if (--budget < 0) {
        // A continuum of feet (a centre of curvature) or a search too fine: what's left sampled at its middles.
        exhausted = true;
        leftLb = std::fmin(leftLb, n.lb);
        add(mid);
        continue;
      }
      Box3 b0, bu, bv, buu, buv, bvv;
      bool ok = s.derivBox(a, b, 0, 0, b0) == Status::ok && s.derivBox(a, b, 1, 0, bu) == Status::ok
        && s.derivBox(a, b, 0, 1, bv) == Status::ok && s.derivBox(a, b, 2, 0, buu) == Status::ok
        && s.derivBox(a, b, 1, 1, buv) == Status::ok && s.derivBox(a, b, 0, 2, bvv) == Status::ok;
      bool convex = false;
      if (ok) {
        Box3 e = b0 - pointBox(p);
        double mu = boxMinNorm(bu), mv = boxMinNorm(bv);
        double h11 = mu * mu + dotBox(e, buu).lo, h22 = mv * mv + dotBox(e, bvv).lo;
        Interval h12 = dotBox(bu, bv) + dotBox(e, buv);
        convex = h11 > 0 && h22 > 0 && h11 * h22 > h12.mag() * h12.mag() * (1 + 16 * kEps);
      }
      double diam = ok ? std::hypot(b0.x.width(), std::hypot(b0.y.width(), b0.z.width())) : kInf;
      // As narrow as its coordinates' rounding, or within tol all over: one foot wherever it is in there.
      if (!ok && s.derivBox(a, b, 0, 0, b0) == Status::ok)
        diam = std::hypot(b0.x.width(), std::hypot(b0.y.width(), b0.z.width()));
      bool tiny = diam <= tol || (ok && diam <= 24 * kEps * boxMag(b0));
      double wu = a.hi - a.lo, wv = b.hi - b.lo;
      bool thin = wu <= 4 * kEps * std::fmax(std::fabs(a.lo), std::fabs(a.hi))
        && wv <= 4 * kEps * std::fmax(std::fabs(b.lo), std::fabs(b.hi));
      if (convex) {
        // A minimum pushed against a side inside the search range isn't one of S's: the rectangle beyond holds it.
        bool push[4];
        Vec2 x = convexMinimum(s, p, a, b, mid, push);
        bool inner = (push[0] && a.lo > ru.lo) || (push[1] && a.hi < ru.hi) || (push[2] && b.lo > rv.lo)
          || (push[3] && b.hi < rv.hi);
        if (inner) bound(x, at(x));
        else add(x);
        continue;
      }
      if (tiny || thin) {
        Vec2 best = mid;
        double bd = kInf;
        for (Vec2 x : {mid, Vec2{a.lo, b.lo}, Vec2{a.hi, b.lo}, Vec2{a.lo, b.hi}, Vec2{a.hi, b.hi}}) {
          double d = norm(at(x) - p);
          if (d < bd) bd = d, best = x;
        }
        // Within tol all over, its foot is anywhere in it: polished (nearestInBox) so that points nearer each other
        // than tol keep apart in (u, v) (LMP1's vertices 0.003 apart under a tolerance of 0.13 took one (u, v)).
        if (tiny && !thin) best = nearestInBox(s, p, a, b, best);
        add(best);
        continue;
      }
      // Split across the side longer in 3D, as sampled along its three iso-lines, each the two chords through its
      // middle (a whole period's ends are one point; a rational partial's box is too loose to judge by: beside a pole
      // it would keep halving the side that has collapsed); by the partials' boxes where the kind says
      // (splitByBoxes).
      double lu = 0, lv = 0;
      if (s.splitByBoxes()) lu = ok ? boxNorm(bu) * wu : wu, lv = ok ? boxNorm(bv) * wv : wv;
      else for (double f : {0.0, 0.5, 1.0}) {
        double v = b.lo + f * wv, u = a.lo + f * wu;
        Vec3 um = at({mid.x, v}), vm = at({u, mid.y});
        lu = std::fmax(lu, norm(um - at({a.lo, v})) + norm(at({a.hi, v}) - um));
        lv = std::fmax(lv, norm(vm - at({u, b.lo})) + norm(at({u, b.hi}) - vm));
      }
      if (!(lu > 0 || lv > 0)) lu = wu, lv = wv;
      bound(mid, at(mid));
      Range h[2][2];
      if (lu >= lv) h[0][0] = {a.lo, mid.x}, h[0][1] = b, h[1][0] = {mid.x, a.hi}, h[1][1] = b;
      else h[0][0] = a, h[0][1] = {b.lo, mid.y}, h[1][0] = a, h[1][1] = {mid.y, b.hi};
      for (auto& c : h) {
        double lb = lower(c[0], c[1]);
        if (lb <= ub + slack) queue.push({c[0], c[1], lb});
      }
    }
  }
  out.status = Status::ok;
  if (cands.empty()) return out;
  std::sort(cands.begin(), cands.end(), [](const Candidate& x, const Candidate& y) {
    return x.d < y.d || (x.d == y.d && (x.uv.x < y.uv.x || (x.uv.x == y.uv.x && x.uv.y < y.uv.y)));
  });
  if (exhausted && leftLb < cands[0].d - (distanceOnly ? eps : tol)) out.status = Status::noConvergence;
  if (distanceOnly) {
    const Candidate& best = cands[0];
    out.uv = best.uv, out.foot = best.foot, out.distance = best.d, out.certainty = Certainty::none;
    if (wrapU && out.uv.x >= ru.hi) out.uv.x -= dom.uPeriod;
    if (wrapV && out.uv.y >= rv.hi) out.uv.y -= dom.vPeriod;
    return out;
  }
  if (all) {
    all->clear();
    for (const Candidate& k : cands) {
      if (k.d - cands[0].d > tol) break;
      Vec2 uv = k.uv;
      if (wrapU && uv.x >= ru.hi) uv.x -= dom.uPeriod;
      if (wrapV && uv.y >= rv.hi) uv.y -= dom.vPeriod;
      all->push_back({uv, k.foot, k.d});
    }
  }
  // The feet within tol of the best distance, one per place (feet within tol of each other are one).
  std::vector<Candidate> feet;
  for (const Candidate& k : cands) {
    if (k.d - cands[0].d > tol) break;
    bool same = false;
    for (const Candidate& f : feet) same = same || norm(k.foot - f.foot) <= tol;
    if (!same) feet.push_back(k);
  }
  // The hint picks among equally near feet; else the nearest (then the least (u, v)).
  size_t pick = 0;
  if (hint)
    for (size_t i = 1; i < feet.size(); i++)
      if (uvDistance(feet[i].uv, *hint, dom) < uvDistance(feet[pick].uv, *hint, dom)) pick = i;
  const Candidate best = feet[pick];
  out.uv = best.uv, out.foot = best.foot, out.distance = best.d;
  out.certainty = feet.size() > 1 ? Certainty::ambiguous : Certainty::unique;
  for (size_t i = 0; i < feet.size(); i++)
    if (i != pick) out.alternatives.push_back(feet[i].uv);
  // A continuum sampled: a few alternatives spread over it say so.
  if (out.alternatives.size() > 8) {
    std::vector<Vec2> few;
    for (size_t i = 0; i < 8; i++) few.push_back(out.alternatives[i * out.alternatives.size() / 8]);
    out.alternatives = few;
  }
  // A curve of feet in closed form: its direction, over the range searched, at the foot's other parameter.
  if (out.certainty == Certainty::ambiguous) {
    char f = s.footFamily(p);
    if (f) {
      out.hasFamily = true, out.familyU = f == 'u';
      out.familyLo = f == 'u' ? ru.lo : rv.lo, out.familyHi = f == 'u' ? ru.hi : rv.hi;
      out.familyAt = f == 'u' ? out.uv.y : out.uv.x;
    }
  }
  // Flags, the foot's own parameters kept: a singularity's, else a seam's where the foot is within tol of it.
  out.atSingularity = nearSingularity(s, out.foot, tol);
  if (!out.atSingularity) {
    if (closedU(s, ru, out.uv.y, tol)) {
      double lo = wrapU ? ru.lo : dom.u.lo, hi = wrapU ? ru.hi : dom.u.hi;
      out.onSeamU = norm(at({lo, out.uv.y}) - out.foot) <= tol || norm(at({hi, out.uv.y}) - out.foot) <= tol;
    }
    if (closedV(s, rv, out.uv.x, tol)) {
      double lo = wrapV ? rv.lo : dom.v.lo, hi = wrapV ? rv.hi : dom.v.hi;
      out.onSeamV = norm(at({out.uv.x, lo}) - out.foot) <= tol || norm(at({out.uv.x, hi}) - out.foot) <= tol;
    }
  }
  // Periodic results in [lo, lo + period).
  auto red = [](double x, Range r, double P) { return x >= r.hi ? x - P : x; };
  if (wrapU) {
    out.uv.x = red(out.uv.x, ru, dom.uPeriod);
    for (Vec2& a : out.alternatives) a.x = red(a.x, ru, dom.uPeriod);
  }
  if (wrapV) {
    out.uv.y = red(out.uv.y, rv, dom.vPeriod);
    for (Vec2& a : out.alternatives) a.y = red(a.y, rv, dom.vPeriod);
  }
  return out;
}

} // namespace cadgeom
