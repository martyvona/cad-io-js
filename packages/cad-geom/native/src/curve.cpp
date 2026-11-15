// curve.h: makeCurve (each kind in curve_conic.cpp, curve_spline.cpp, curve_compound.cpp), point inversion, arc length
// and its inverse.
// Inversion: branch and bound on the parameter range (the general method of Patrikalakis, Maekawa and Cho, "Shape
// Interrogation for Computer Aided Design and Manufacturing", sections 4.6 and 6.3: subdivide, discard by bounds,
// solve where isolated). A range is discarded when its box is farther from p than the best distance found plus tol;
// it is solved when g(t) = |C(t) - p|^2 is convex on it (g''/2 = |C'|^2 + (C - p) . C'' > 0, its lower bound from the
// boxes of C - p, C' and C'' by interval arithmetic), since a convex g has one minimum there, found by Newton on g'
// guarded by bisection; else it is split. Feet within tol of the best are the same foot (a seam's two parameters) or
// alternatives (other places, one per cluster). Circles take their feet in closed form (footCandidates).
// Arc length: closed forms where they exist (curve_impl.h's exactLength), else quadrature span by span, the spans
// split at the speed's zeros; the parameter at a length by Newton on the length (its derivative the speed), bracketed
// and guarded by bisection.
#include "cad_geom/curve.h"

#include <algorithm>
#include <cmath>
#include <queue>

#include "cad_geom/numerics.h"
#include "curve_impl.h"

namespace cadgeom {

namespace curves {

Status CurveImpl::eval(double t, int order, CurvePoint& out) const {
  if (order < 0 || order > 2) return Status::unsupported;
  Vec3 d[3];
  Status s = derivs(t, order, d);
  out = {d[0], order >= 1 ? d[1] : Vec3{}, order >= 2 ? d[2] : Vec3{}};
  return s;
}

Status CurveImpl::derivBound(Range r, int order, double& out) const {
  if (order != 1 && order != 2) return Status::unsupported;
  return derivBoundN(r, order, out);
}

Status centredBox(const CurveImpl& c, Range r, int order, Box3& out) {
  if (order + 1 > kMaxOrder || !finite(r)) return Status::unsupported;
  double b;
  Status s = c.derivBoundN(r, order + 1, b);
  if (s != Status::ok) return s;
  Vec3 d[kMaxOrder + 1];
  double m = 0.5 * r.lo + 0.5 * r.hi;
  s = c.derivs(m, order, d);
  if (s != Status::ok && s != Status::outOfDomain) return s;
  // Widened by the evaluation's own error, which differs between paths (bspline::eval to order 2, the hodographs
  // beyond): relative to the derivative, and for a point relative to the curve's local size, not its position.
  double h = std::fmax(m - r.lo, r.hi - m);
  double e = order == 0 ? 4 * kEps * maxAbs(d[0]) + 1e-13 * b * std::fmax(h, 1.0) : 1e-12 * maxAbs(d[order]);
  out = ballBox(d[order], b * h * (1 + 4 * kEps) + e);
  return Status::ok;
}

void speedZeros(const CurveImpl& c, Range r, std::vector<double>& out) {
  out.clear();
  double b;
  if (c.derivBoundN(r, 1, b) == Status::ok && b == 0) {
    out.push_back(r.lo);
    return;
  }
  double wmin = std::fmax(1e-12 * (r.hi - r.lo), 4 * kEps * std::fmax(std::fabs(r.lo), std::fabs(r.hi)));
  std::vector<Range> stack{r}, leaves;
  int budget = 20000;
  while (!stack.empty()) {
    Range g = stack.back();
    stack.pop_back();
    Box3 box;
    Status s = c.derivBox(g, 1, box);
    if (s == Status::ok && boxMinNorm(box) > 0) continue;
    if (g.hi - g.lo <= wmin || --budget <= 0) {
      leaves.push_back(g);
      if (budget <= 0) break;
      continue;
    }
    double m = 0.5 * g.lo + 0.5 * g.hi;
    stack.push_back({m, g.hi});
    stack.push_back({g.lo, m});
  }
  // Leaves come in order; touching ones are one zero.
  for (size_t i = 0; i < leaves.size();) {
    size_t j = i;
    while (j + 1 < leaves.size() && leaves[j + 1].lo <= leaves[j].hi) j++;
    double t = budget <= 0 ? leaves[i].lo : 0.5 * leaves[i].lo + 0.5 * leaves[j].hi;
    out.push_back(t);
    i = j + 1;
  }
}

std::unique_ptr<CurveImpl> make(const Model& m, int row, int depth, Status& status) {
  status = Status::invalidModel;
  if (row < 0 || row >= m.curves() || depth > 32) return nullptr;
  int dim = m.curveDim(row);
  if (dim != 2 && dim != 3) return nullptr;
  int ro = m.i32(CBR_CURVE_REAL)[row], io = m.i32(CBR_CURVE_INT)[row];
  long nr = static_cast<long>(m.count(CBR_POOL_CURVE_REAL)) - ro;
  long ni = static_cast<long>(m.count(CBR_POOL_CURVE_INT)) - io;
  if (ro < 0 || io < 0 || nr < 0 || ni < 0) return nullptr;
  const double* r = m.curveReals(row);
  const int32_t* in = m.curveInts(row);
  int P = dim == 3 ? 9 : 4;  // a placement's reals
  auto child = [&](int c) {
    std::unique_ptr<CurveImpl> b = make(m, c, depth + 1, status);
    if (b && b->dim() != dim) status = Status::invalidModel, b.reset();
    return b;
  };
  switch (m.curveKind(row)) {
  case CBR_CURVE_LINE:
    if (nr < 2 * dim + 1 || !(r[2 * dim] > 0)) return nullptr;
    status = Status::ok;
    return makeLine(r, dim);
  case CBR_CURVE_CIRCLE:
    if (nr < P + 1 || !(r[P] > 0)) return nullptr;
    status = Status::ok;
    return makeEllipse(r, dim, r[P], r[P]);
  case CBR_CURVE_ELLIPSE:
    if (nr < P + 2 || !(r[P] > 0) || !(r[P + 1] > 0)) return nullptr;
    status = Status::ok;
    return makeEllipse(r, dim, r[P], r[P + 1]);
  case CBR_CURVE_HYPERBOLA:
    if (nr < P + 2 || !(r[P] > 0) || !(r[P + 1] > 0)) return nullptr;
    status = Status::ok;
    return makeHyperbola(r, dim);
  case CBR_CURVE_PARABOLA:
    if (nr < P + 1 || !(r[P] != 0) || !std::isfinite(r[P])) return nullptr;
    status = Status::ok;
    return makeParabola(r, dim);
  case CBR_CURVE_BSPLINE: {
    if (ni < 7 || in[2] < 0 || ni < 7 + in[2] || in[1] < 0) return nullptr;
    long need = in[2] + static_cast<long>(in[1]) * dim + (in[3] ? in[1] : 0);
    if (nr < need) return nullptr;
    return makeBSpline(r, in, dim, status);
  }
  case CBR_CURVE_POLYLINE:
    if (ni < 1 || in[0] < 2 || nr < static_cast<long>(in[0]) * dim) return nullptr;
    status = Status::ok;
    return makePolyline(r, in[0], dim);
  case CBR_CURVE_TRIMMED: {
    if (ni < 3 || nr < 2 + 2 * dim) return nullptr;
    std::unique_ptr<CurveImpl> b = child(in[0]);
    if (!b) return nullptr;
    return makeTrimmed(std::move(b), r, in[1], in[2], status);
  }
  case CBR_CURVE_COMPOSITE: {
    if (ni < 2 || in[0] < 1 || ni < 2 + 3L * in[0]) return nullptr;
    std::vector<Segment> segs;
    for (int k = 0; k < in[0]; k++) {
      std::unique_ptr<CurveImpl> b = child(in[2 + 3 * k]);
      if (!b) return nullptr;
      segs.push_back({std::move(b), in[3 + 3 * k] != 0});
    }
    return makeComposite(std::move(segs), status);
  }
  case CBR_CURVE_OFFSET: {
    if (ni < 2 || nr < 1 + (dim == 3 ? 3 : 0) || !std::isfinite(r[0])) return nullptr;
    std::unique_ptr<CurveImpl> b = child(in[0]);
    if (!b) return nullptr;
    status = Status::ok;
    return makeOffset(std::move(b), r[0], dim == 3 ? readVec(r + 1, 3) : Vec3{});
  }
  default: status = Status::unsupported; return nullptr;
  }
}

} // namespace curves

using namespace curves;

std::unique_ptr<Curve> makeCurve(const Model& model, int row, Status& status) {
  return make(model, row, 0, status);
}

namespace {

/** Boxes of a curve's derivatives: a CurveImpl's own, else from Curve's interface (looser, still holding). */
struct Boxes {
  const Curve& c;
  const CurveImpl* impl;
  Status box(Range r, int order, Box3& out) const {
    if (impl) return impl->derivBox(r, order, out);
    if (order == 0) return c.bound(r, out);
    double b;
    Status s = c.derivBound(r, order, b);
    out = ballBox({}, b);
    return s;
  }
  Status eval(double t, int order, CurvePoint& out) const { return c.eval(t, order, out); }
};

/** t moved into r by a few ulps where it's r's upper end, so a piecewise curve evaluates the piece r is on. */
double inside(Range r, double t) {
  if (t < r.hi) return t;
  double u = r.hi - 4 * kEps * std::fmax(1.0, std::fabs(r.hi));
  return u > r.lo ? u : t;
}

struct Node {
  Range r;
  double lb;
  bool operator<(const Node& o) const { return lb > o.lb; }  // a min-heap on the lower bound
};
struct Candidate {
  double t, d;
  Vec3 foot;
};

Interval dotBox(const Box3& a, const Box3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
Box3 minus(const Box3& a, Vec3 p) {
  return {a.x - Interval::point(p.x), a.y - Interval::point(p.y), a.z - Interval::point(p.z)};
}

/**
 * The minimum of g = |C - p|^2 on r where g is convex there: an end where g' doesn't change sign inside, else g'
 * = 0 by Newton (g'' its derivative) inside a bracket kept by bisection.
 */
double convexMinimum(const Boxes& b, Vec3 p, Range r) {
  auto gp = [&](double t, double* g2) {
    CurvePoint q;
    b.eval(t, 2, q);
    Vec3 e = q.p - p;
    if (g2) *g2 = dot(q.d1, q.d1) + dot(e, q.d2);
    return dot(e, q.d1);
  };
  // At r's end, the left limit: a piecewise curve's next piece starts there.
  double fa = gp(r.lo, nullptr), fb = gp(inside(r, r.hi), nullptr);
  if (fa >= 0) return r.lo;
  if (fb <= 0) return inside(r, r.hi);  // where a composite jumps at r.hi, the piece r is on
  double lo = r.lo, hi = r.hi, t = 0.5 * lo + 0.5 * hi;
  for (int it = 0; it < 100; it++) {
    double g2, f = gp(t, &g2);
    if (f == 0) return t;
    (f < 0 ? lo : hi) = t;
    double nt = g2 > 0 ? t - f / g2 : 0.5 * lo + 0.5 * hi;
    if (!(nt > lo && nt < hi)) nt = 0.5 * lo + 0.5 * hi;
    if (std::fabs(nt - t) <= 2 * kEps * std::fmax(1.0, std::fabs(t)) || hi - lo <= 2 * kEps * std::fabs(t)) {
      t = nt;
      break;
    }
    t = nt;
  }
  return t;
}

} // namespace

CurveInversion invertCurve(const Curve& c, Vec3 p, Range r, double tol) {
  CurveInversion out;
  const CurveImpl* impl = dynamic_cast<const CurveImpl*>(&c);
  Boxes B{c, impl};
  CurveDomain dom = c.domain();
  tol = std::fmax(tol, 0.0);
  if (!(r.lo <= r.hi)) {
    out.status = Status::outOfDomain;
    return out;
  }
  auto at = [&](double t) {
    CurvePoint q;
    B.eval(t, 0, q);
    return q.p;
  };
  // A periodic curve searched over one period from r.lo, its results reduced into it.
  bool wrap = dom.period > 0 && r.hi - r.lo >= dom.period;
  if (wrap) r.hi = r.lo + dom.period;
  if (dom.period == 0) r = {std::fmax(r.lo, dom.range.lo), std::fmin(r.hi, dom.range.hi)};
  if (!finite(r)) {
    if (!impl) {
      out.status = Status::unsupported;
      return out;
    }
    double t0 = std::clamp(0.0, r.lo, r.hi);
    Range w = impl->within(p, norm(at(t0) - p) * (1 + 1e-9) + tol);
    r = {std::fmax(r.lo, w.lo), std::fmin(r.hi, w.hi)};
    if (!finite(r)) {
      out.status = Status::unsupported;
      return out;
    }
  }

  std::vector<double> br;
  c.breaks(r, br);
  std::priority_queue<Node> queue;
  double ub = kInf;
  std::vector<Candidate> cands;
  auto bound = [&](Range g) {
    Box3 box;
    B.box(g, 0, box);
    return boxDistance(box, p);
  };
  auto sample = [&](double t) {
    double d = norm(at(t) - p);
    ub = std::fmin(ub, d);
    return d;
  };
  std::vector<double> known;
  if (impl && impl->footCandidates(p, r, tol, known)) {
    for (double t : known) cands.push_back({t, sample(t), at(t)});
  } else {
    for (size_t i = 0; i + 1 < br.size(); i++) {
      Range g{br[i], br[i + 1]};
      sample(g.lo), sample(g.hi);
      queue.push({g, bound(g)});
    }
    if (br.size() == 2 && br[0] == br[1]) queue.push({{br[0], br[0]}, 0});
  }
  int budget = 20000;
  bool exhausted = false;
  double leftLb = kInf;
  while (!queue.empty()) {
    Node n = queue.top();
    queue.pop();
    if (n.lb > ub + tol) continue;
    Range g = n.r;
    if (--budget < 0) {
      // A continuum of feet (a point at an arc's centre) or a search too fine: what's left sampled at its middles,
      // the least bound left saying whether a better foot could remain.
      exhausted = true;
      leftLb = std::fmin(leftLb, n.lb);
      double t = 0.5 * g.lo + 0.5 * g.hi;
      cands.push_back({t, sample(t), at(t)});
      continue;
    }
    // Convex on g? g''/2 >= |C'|^2_min + min (C - p) . C''.
    Box3 b0 = entireBox(), b1, b2;
    bool convex = B.box(g, 0, b0) == Status::ok && B.box(g, 1, b1) == Status::ok && B.box(g, 2, b2) == Status::ok;
    if (convex) {
      double s = boxMinNorm(b1);
      convex = s * s + dotBox(minus(b0, p), b2).lo > 0;
    }
    // A range whose points are all within tol of each other is one foot wherever its minimum is (a zero-length
    // segment, a cusp's neighbourhood): the best of its ends and middle. Far from the origin a box can't be
    // narrower than its coordinates' rounding, so tol is floored there.
    double w = g.hi - g.lo, diam = std::hypot(b0.x.width(), std::hypot(b0.y.width(), b0.z.width()));
    bool tiny = diam <= std::fmax(tol, 24 * kEps * boxMag(b0));
    if (convex || tiny || w <= 4 * kEps * std::fmax(std::fabs(g.lo), std::fabs(g.hi)) || w == 0) {
      if (convex) {
        double t = convexMinimum(B, p, g);
        cands.push_back({t, sample(t), at(t)});
        continue;
      }
      Candidate k{0, kInf, {}};
      for (double t : {g.lo, 0.5 * g.lo + 0.5 * g.hi, inside(g, g.hi)}) {
        double d = sample(t);
        if (d < k.d) k = {t, d, at(t)};
      }
      cands.push_back(k);
      continue;
    }
    double m = 0.5 * g.lo + 0.5 * g.hi;
    sample(m);
    for (Range h : {Range{g.lo, m}, Range{m, g.hi}}) {
      double lb = bound(h);
      if (lb <= ub + tol) queue.push({h, lb});
    }
  }
  out.status = Status::ok;
  if (cands.empty()) return out;
  std::sort(cands.begin(), cands.end(), [](const Candidate& a, const Candidate& b) {
    return a.d < b.d || (a.d == b.d && a.t < b.t);
  });
  const Candidate& best = cands[0];
  out.t = best.t, out.distance = best.d, out.foot = best.foot;
  if (exhausted && leftLb < best.d - tol) out.status = Status::noConvergence;
  out.certainty = Certainty::unique;
  // Closed over r: its ends one point (a period, or a closed curve searched over its whole domain).
  Vec3 e0 = at(r.lo), e1 = at(r.hi);
  bool whole = wrap || (dom.period == 0 && r.lo <= dom.range.lo && r.hi >= dom.range.hi);
  bool closed = whole && norm(e1 - e0) <= tol;
  if (closed && (norm(out.foot - e0) <= tol || norm(out.foot - e1) <= tol)) out.onSeam = true, out.t = r.lo;
  if (wrap && out.t >= r.hi) out.t -= dom.period;
  // Other feet: within tol of the best distance and more than tol from the best foot and from each other.
  std::vector<Vec3> feet{best.foot};
  for (size_t i = 1; i < cands.size(); i++) {
    const Candidate& k = cands[i];
    if (k.d - best.d > tol) break;
    bool same = false;
    for (Vec3 f : feet) same = same || norm(k.foot - f) <= tol;
    if (same) continue;
    feet.push_back(k.foot);
    double t = k.t;
    if (wrap && t >= r.hi) t -= dom.period;
    out.alternatives.push_back(t);
  }
  if (!out.alternatives.empty()) out.certainty = Certainty::ambiguous;
  // A continuum sampled: a few alternatives spread over it are enough to say so.
  if (exhausted && out.alternatives.size() > 8) {
    std::vector<double> few;
    for (size_t i = 0; i < 8; i++) few.push_back(out.alternatives[i * out.alternatives.size() / 8]);
    out.alternatives = few;
  }
  std::sort(out.alternatives.begin(), out.alternatives.end());
  return out;
}

namespace {

double speed(const Curve& c, double t) {
  CurvePoint q;
  c.eval(t, 1, q);
  return norm(q.d1);
}

} // namespace

Estimate arcLength(const Curve& c, double t0, double t1, double relTol) {
  if (!(t0 <= t1)) return {NAN, kInf, Status::outOfDomain};
  CurveDomain dom = c.domain();
  Status status = Status::ok;
  if (dom.period == 0 && (t0 < dom.range.lo || t1 > dom.range.hi)) {
    status = Status::outOfDomain;
    t0 = std::clamp(t0, dom.range.lo, dom.range.hi), t1 = std::clamp(t1, dom.range.lo, dom.range.hi);
  }
  if (!std::isfinite(t0) || !std::isfinite(t1)) return {kInf, kInf, Status::outOfDomain};
  const CurveImpl* impl = dynamic_cast<const CurveImpl*>(&c);
  double exact;
  if (impl && impl->exactLength(t0, t1, exact)) return {exact, 4 * kEps * std::fabs(exact), status};
  // Spans between breaks and the speed's zeros.
  std::vector<double> br, z, cuts;
  c.breaks({t0, t1}, br);
  for (size_t i = 0; i + 1 < br.size(); i++) {
    cuts.push_back(br[i]);
    c.singular({br[i], br[i + 1]}, z);
    for (double t : z)
      if (t > cuts.back() && t < br[i + 1]) cuts.push_back(t);
  }
  cuts.push_back(t1);
  Estimate total{0, 0, status};
  for (size_t i = 0; i + 1 < cuts.size(); i++) {
    if (cuts[i + 1] <= cuts[i]) continue;
    Range g{cuts[i], cuts[i + 1]};
    Estimate e = quadrature::integrate([&](double t) { return speed(c, inside(g, t)); }, g.lo, g.hi, 0, relTol);
    total.value += e.value;
    total.error += e.error;
    if (e.status != Status::ok) total.status = e.status;
  }
  return total;
}

Estimate paramAtLength(const Curve& c, double t0, double length, double relTol) {
  if (!(length >= 0) || !std::isfinite(t0)) return {NAN, kInf, Status::outOfDomain};
  if (length == 0) return {t0, 0, Status::ok};
  CurveDomain dom = c.domain();
  bool bounded = dom.period == 0 && std::isfinite(dom.range.hi);
  double acc = 0, a = t0, step = dom.period > 0 ? dom.period : 1;
  if (bounded && t0 > dom.range.hi) return {NAN, kInf, Status::outOfDomain};
  // Forward span by span (breaks, or chunks on a periodic or infinite curve) to the one the length ends in.
  for (int chunk = 0; chunk < 200; chunk++) {
    double end = bounded ? dom.range.hi : a + step;
    std::vector<double> br;
    c.breaks({a, end}, br);
    for (size_t i = 0; i + 1 < br.size(); i++) {
      double lo = br[i], hi = br[i + 1];
      if (hi <= lo) continue;
      Estimate L = arcLength(c, lo, hi, relTol / 4);
      if (acc + L.value < length) {
        acc += L.value;
        continue;
      }
      // F(t) = acc + length(lo, t) - length: F(lo) < 0 <= F(hi), F' the speed.
      double tlo = lo, thi = hi, t = lo + (length - acc) / L.value * (hi - lo), F = 0, err = 0;
      Status st = Status::noConvergence;
      for (int it = 0; it < 200; it++) {
        Estimate l = arcLength(c, lo, t, relTol / 4);
        F = acc + l.value - length, err = l.error;
        if (std::fabs(F) <= 0.25 * relTol * length) {
          st = Status::ok;
          break;
        }
        (F < 0 ? tlo : thi) = t;
        double v = speed(c, t), nt = v > 0 ? t - F / v : 0.5 * tlo + 0.5 * thi;
        if (!(nt > tlo && nt < thi)) nt = 0.5 * tlo + 0.5 * thi;
        if (thi - tlo <= 4 * kEps * std::fmax(1.0, std::fabs(t))) {
          t = nt, st = Status::ok;
          break;
        }
        t = nt;
      }
      double v = speed(c, t);
      double e = v > 0 ? (std::fabs(F) + err) / v : thi - tlo;
      return {t, e, st};
    }
    if (bounded) return {dom.range.hi, kInf, Status::outOfDomain};
    a = end;
    if (dom.period == 0) step *= 2;
  }
  return {a, kInf, Status::noConvergence};
}

} // namespace cadgeom
