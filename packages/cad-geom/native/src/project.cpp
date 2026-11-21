// project.h's entry point and what its stages share: pieces built from their model form, the 3D error measured
// between samples, the unwrapping onto known ends, seams and the seam rule. Written from Part 42's definitions
// (SURFACE_CURVE, PCURVE: the p-curve's parameter is its 3D curve's) and docs/own-tessellator.md's plan; the
// behavioural summary docs/healing.md ("Missing p-curves") says what the backends do, and the error measure here is
// the difference it names (between samples, not only at them).
#include <algorithm>
#include <cmath>

#include "cad_brep.h"
#include "curve_impl.h"
#include "project_impl.h"

namespace cadgeom {
namespace project {

namespace {

/** A 3D curve's image by a plane's (u, v) map, for kinds no 2D kind of the same parameter holds. */
class Affine final : public Curve {
public:
  Affine(std::shared_ptr<const Curve> basis, const double* a) : basis_(std::move(basis)) {
    for (int i = 0; i < 9; i++) a_[i] = a[i];
  }
  int dim() const override { return 2; }
  CurveDomain domain() const override { return basis_->domain(); }
  Status eval(double t, int order, CurvePoint& out) const override {
    CurvePoint q;
    Status s = basis_->eval(t, order, q);
    const Vec3 o{a_[6], a_[7], a_[8]};
    out.p = map(q.p - o), out.d1 = order >= 1 ? map(q.d1) : Vec3{}, out.d2 = order >= 2 ? map(q.d2) : Vec3{};
    return s;
  }
  void breaks(Range r, std::vector<double>& out) const override { basis_->breaks(r, out); }
  void joints(Range r, int c, std::vector<double>& out) const override { basis_->joints(r, c, out); }
  Status bound(Range r, Box3& out) const override {
    Box3 b;
    Status s = basis_->bound(r, b);
    if (s != Status::ok) return s;
    const Interval x = b.x - Interval::point(a_[6]), y = b.y - Interval::point(a_[7]), z = b.z - Interval::point(a_[8]);
    auto row = [&](int k) {
      return Interval::point(a_[k]) * x + Interval::point(a_[k + 1]) * y + Interval::point(a_[k + 2]) * z;
    };
    out = {row(0), row(3), Interval::point(0)};
    return Status::ok;
  }
  Status derivBound(Range r, int order, double& out) const override {
    Status s = basis_->derivBound(r, order, out);
    // The map's norm is at most its Frobenius norm (1 per orthonormal row: sqrt 2), rounded up.
    double f = 0;
    for (int i = 0; i < 6; i++) f += a_[i] * a_[i];
    out *= std::sqrt(f) * (1 + 1e-15);
    return s;
  }
  void singular(Range r, std::vector<double>& out) const override { basis_->singular(r, out); }

private:
  Vec3 map(Vec3 p) const {
    return {a_[0] * p.x + a_[1] * p.y + a_[2] * p.z, a_[3] * p.x + a_[4] * p.y + a_[5] * p.z, 0};
  }
  std::shared_ptr<const Curve> basis_;
  double a_[9];
};

double reduce(double x, double lo, double period) {
  return period > 0 ? lo + std::fmod(std::fmod(x - lo, period) + period, period) : x;
}

} // namespace

bool build(PcurvePiece& p, std::shared_ptr<const Curve> basis) {
  using namespace curves;
  const double* r = p.reals.data();
  const size_t nr = p.reals.size();
  Status st = Status::ok;
  p.curve.reset();
  switch (p.kind) {
  case 0:
    if (basis) p.curve = std::make_unique<Affine>(std::move(basis), p.affine);
    break;
  case CBR_CURVE_LINE:
    if (nr >= 5) p.curve = makeLine(r, 2);
    break;
  case CBR_CURVE_CIRCLE:
    if (nr >= 5) p.curve = makeEllipse(r, 2, r[4], r[4]);
    break;
  case CBR_CURVE_ELLIPSE:
    if (nr >= 6) p.curve = makeEllipse(r, 2, r[4], r[5]);
    break;
  case CBR_CURVE_HYPERBOLA:
    if (nr >= 6) p.curve = makeHyperbola(r, 2);
    break;
  case CBR_CURVE_PARABOLA:
    if (nr >= 5) p.curve = makeParabola(r, 2);
    break;
  case CBR_CURVE_BSPLINE:
    if (p.ints.size() >= 7) p.curve = makeBSpline(r, p.ints.data(), 2, st);
    break;
  case CBR_CURVE_POLYLINE:
    if (!p.ints.empty() && nr >= 2 * static_cast<size_t>(p.ints[0])) p.curve = makePolyline(r, p.ints[0], 2);
    break;
  }
  return p.curve != nullptr && st == Status::ok;
}

PcurvePiece linePiece(Range t, Vec2 uv0, Vec2 vel) {
  PcurvePiece p;
  p.t = t;
  p.kind = CBR_CURVE_LINE;
  const double m = norm(vel);
  // C(t) = point + t m dir: the point is uv at t = 0, which can be far from uv0 where t.lo is large; the line keeps
  // it exactly as given, so uv(t.lo) is uv0 to within t.lo's rounding.
  const Vec2 point = uv0 - t.lo * vel;
  p.reals = {point.x, point.y, vel.x / m, vel.y / m, m};
  build(p);
  return p;
}

void shift(PcurvePiece& p, double du, double dv) {
  if (du == 0 && dv == 0) return;
  p.from = p.from + Vec2{du, dv}, p.to = p.to + Vec2{du, dv};
  if (p.poleLine) return;
  auto move = [&](size_t first, size_t count) {
    for (size_t i = 0; i < count; i++) p.reals[first + 2 * i] += du, p.reals[first + 2 * i + 1] += dv;
  };
  switch (p.kind) {
  case CBR_CURVE_LINE:
  case CBR_CURVE_CIRCLE:
  case CBR_CURVE_ELLIPSE:
  case CBR_CURVE_HYPERBOLA:
  case CBR_CURVE_PARABOLA: move(0, 1); break;
  case CBR_CURVE_BSPLINE: move(static_cast<size_t>(p.ints[2]), static_cast<size_t>(p.ints[1])); break;
  case CBR_CURVE_POLYLINE: move(0, static_cast<size_t>(p.ints[0])); break;
  default: return;  // kind 0 is on a plane, which has no period
  }
  build(p);
}

Vec2 at(const PcurvePiece& p, double t) {
  if (p.poleLine || !p.curve) return p.from;
  CurvePoint q;
  p.curve->eval(t, 0, q);
  return {q.p.x, q.p.y};
}

double uvTol(const Surface& s, Vec2 uv, double tol) {
  SurfacePoint sp;
  s.eval(uv.x, uv.y, 1, sp);
  const double a = dot(sp.du, sp.du), b = dot(sp.du, sp.dv), c = dot(sp.dv, sp.dv);
  const double lmax = 0.5 * (a + c) + std::hypot(0.5 * (a - c), b);
  return lmax > 0 && std::isfinite(lmax) ? tol / std::sqrt(lmax) : tol;
}

double footFrom(const Surface& s, const SurfaceDomain& dom, Vec3 p, Vec2& uv, int iters) {
  auto clampIn = [&](Vec2 q) {
    if (!(dom.uPeriod > 0)) q.x = std::clamp(q.x, dom.u.lo, dom.u.hi);
    if (!(dom.vPeriod > 0)) q.y = std::clamp(q.y, dom.v.lo, dom.v.hi);
    return q;
  };
  uv = clampIn(uv);
  const Vec2 start = uv;
  SurfacePoint sp;
  s.eval(uv.x, uv.y, 2, sp);
  double best = norm(sp.p - p);
  for (int it = 0; it < iters && best > 0; it++) {
    const Vec3 d = sp.p - p;
    const double gu = dot(d, sp.du), gv = dot(d, sp.dv);
    double a = dot(sp.du, sp.du) + dot(d, sp.duu), b = dot(sp.du, sp.dv) + dot(d, sp.duv),
           c = dot(sp.dv, sp.dv) + dot(d, sp.dvv);
    if (!(a > 0 && a * c - b * b > 0)) a = dot(sp.du, sp.du), b = dot(sp.du, sp.dv), c = dot(sp.dv, sp.dv);
    // Levenberg's damping keeps the step finite where the form degenerates (a pole, an apex).
    const double mu = 1e-14 * (a + c) + 1e-300;
    a += mu, c += mu;
    const double det = a * c - b * b;
    if (!(det > 0)) break;
    Vec2 step{-(c * gu - b * gv) / det, -(a * gv - b * gu) / det};
    // A step that doesn't come nearer is halved only while it is more than rounding in 3D (a few ulps of p's
    // coordinates) or 1e-7 of the distance (where the curve is off the surface the distance is flat at its foot, and
    // a fit there is to a quarter of it at least): past that, halving only re-evaluates.
    const double s3 = norm(step.x * sp.du + step.y * sp.dv), floor = 1e-15 * (1 + norm(p)) + 1e-7 * best;
    bool moved = false;
    for (int h = 0; h < 30 && (h == 0 || std::ldexp(s3, -h) > floor); h++) {
      const Vec2 q = clampIn(uv + step);
      SurfacePoint sq;
      s.eval(q.x, q.y, 2, sq);
      const double dq = norm(sq.p - p);
      if (dq < best || (dq == best && h == 0)) {
        moved = q.x != uv.x || q.y != uv.y;
        uv = q, sp = sq, best = dq;
        break;
      }
      step = 0.5 * step;
    }
    if (!moved) break;
    if (std::fabs(step.x) <= 1e-15 * (1 + std::fabs(uv.x)) && std::fabs(step.y) <= 1e-15 * (1 + std::fabs(uv.y))) break;
  }
  // The foot within half a period of the start: on a seam, Newton's steps can land whole periods away (the same
  // point), which would make a traced branch jump between copies.
  if (dom.uPeriod > 0) uv.x -= dom.uPeriod * std::round((uv.x - start.x) / dom.uPeriod);
  if (dom.vPeriod > 0) uv.y -= dom.vPeriod * std::round((uv.y - start.y) / dom.vPeriod);
  return best;
}

double measure(const Job& job, const PcurvePiece& p, double* worstT) {
  if (p.poleLine || !p.curve) return 0;
  std::vector<double> br, pb;
  for (double b : job.breaks)
    if (b > p.t.lo && b < p.t.hi) br.push_back(b);
  p.curve->breaks(p.t, pb);
  br.insert(br.end(), pb.begin(), pb.end());
  br.push_back(p.t.lo), br.push_back(p.t.hi);
  std::sort(br.begin(), br.end());
  br.erase(std::unique(br.begin(), br.end()), br.end());
  auto err = [&](double t) {
    CurvePoint q, c;
    SurfacePoint sp;
    p.curve->eval(t, 0, q);
    job.c.eval(t, 0, c);
    job.s.eval(q.p.x, q.p.y, 0, sp);
    const double e = norm(sp.p - c.p);
    return std::isfinite(e) ? e : kInf;
  };
  // 64 samples a smooth span (a deviation that oscillates, a line's against a curve's wiggle, has bumps a few
  // hundredths of the span wide), then a golden-section search for the largest error around every sample that is a
  // local maximum within half of the worst, between its neighbours (the worst sample's bump needn't be the
  // highest).
  constexpr int N = 64;
  double worst = 0, at = p.t.lo;
  auto keep = [&](double e, double t) {
    if (e > worst) worst = e, at = t;
  };
  for (size_t k = 0; k + 1 < br.size(); k++) {
    const double a = br[k], b = br[k + 1];
    if (!(b > a)) continue;
    double e[N + 1];
    int w = 0;
    for (int i = 0; i <= N; i++) {
      e[i] = err(a + (b - a) * i / N);
      if (e[i] > e[w]) w = i;
    }
    keep(e[w], a + (b - a) * w / N);
    for (int c = 0; c <= N; c++) {
      if (!(e[c] >= 0.5 * e[w]) || (c > 0 && e[c - 1] > e[c]) || (c < N && e[c + 1] > e[c])) continue;
      double lo = a + (b - a) * std::max(0, c - 1) / N, hi = a + (b - a) * std::min(N, c + 1) / N;
      const double g = 0.6180339887498949;
      double x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = err(x1), f2 = err(x2);
      for (int it = 0; it < 40 && hi - lo > 1e-14 * (std::fabs(lo) + std::fabs(hi) + 1e-300); it++) {
        if (f1 > f2) hi = x2, x2 = x1, f2 = f1, x1 = hi - g * (hi - lo), f1 = err(x1);
        else lo = x1, x1 = x2, f1 = f2, x2 = lo + g * (hi - lo), f2 = err(x2);
      }
      keep(f1, x1), keep(f2, x2);
    }
  }
  if (worstT) *worstT = at;
  return worst;
}

namespace {

/** The singularity (pole or apex) S(uv) is within tol of, or null. */
const Singularity* poleAt(const Job& job, Vec2 uv) {
  SurfacePoint sp;
  job.s.eval(uv.x, uv.y, 0, sp);
  for (const Singularity& g : job.sing)
    if (g.kind != Singularity::normalVanishes && norm(sp.p - g.point) <= job.tol) return &g;
  return nullptr;
}

/** a and b differ by whole periods (and by less than the tolerance besides): the periods, else false. */
bool samePlace(const Job& job, Vec2 a, Vec2 b, double& du, double& dv) {
  du = dv = 0;
  if (job.dom.uPeriod > 0) du = job.dom.uPeriod * std::round((b.x - a.x) / job.dom.uPeriod);
  if (job.dom.vPeriod > 0) dv = job.dom.vPeriod * std::round((b.y - a.y) / job.dom.vPeriod);
  SurfacePoint pa, pb;
  job.s.eval(a.x, a.y, 0, pa), job.s.eval(b.x, b.y, 0, pb);
  const double t = uvTol(job.s, a, job.tol);
  return norm(pa.p - pb.p) <= job.tol && std::fabs(a.x + du - b.x) <= 10 * t && std::fabs(a.y + dv - b.y) <= 10 * t;
}

PcurvePiece poleJump(double t, Vec2 from, Vec2 to) {
  PcurvePiece p;
  p.t = {t, t};
  p.poleLine = true, p.from = from, p.to = to;
  p.certainty = Certainty::unique;
  return p;
}

} // namespace

void align(const Job& job, Pcurve& out) {
  if (out.pieces.empty()) return;
  const Vec2 first = at(out.pieces.front(), job.r.lo);
  double du = 0, dv = 0;
  Vec2 target = first;
  if (job.ends && job.ends->hasStart) {
    target = job.ends->start;
  } else {
    target.x = reduce(first.x, job.dom.u.lo, job.dom.uPeriod);
    target.y = reduce(first.y, job.dom.v.lo, job.dom.vPeriod);
    // A start a rounding below the domain's end is its start, a period on.
    if (job.dom.uPeriod > 0 && job.dom.u.lo + job.dom.uPeriod - target.x <= 1e-12 * job.dom.uPeriod)
      target.x -= job.dom.uPeriod;
    if (job.dom.vPeriod > 0 && job.dom.v.lo + job.dom.vPeriod - target.y <= 1e-12 * job.dom.vPeriod)
      target.y -= job.dom.vPeriod;
  }
  if (job.dom.uPeriod > 0) du = job.dom.uPeriod * std::round((target.x - first.x) / job.dom.uPeriod);
  if (job.dom.vPeriod > 0) dv = job.dom.vPeriod * std::round((target.y - first.y) / job.dom.vPeriod);
  for (PcurvePiece& p : out.pieces) shift(p, du, dv);
  auto mark = [&](double t) {
    out.certainty = Certainty::ambiguous;
    out.tAmbiguous.push_back(t);
  };
  // Known ends at a pole whose free parameter differs from the p-curve's: a jump along the pole line to them.
  if (job.ends && job.ends->hasStart) {
    const Vec2 a = at(out.pieces.front(), job.r.lo), want = job.ends->start;
    double pu, pv;
    if (const Singularity* g = poleAt(job, want)) {
      const bool freeU = !g->isoU;
      if (freeU ? std::fabs(a.x - want.x) > 0 : std::fabs(a.y - want.y) > 0) {
        if (poleAt(job, a)) out.pieces.insert(out.pieces.begin(), poleJump(job.r.lo, want, a));
        else mark(job.r.lo);
      }
    } else if (!samePlace(job, a, want, pu, pv) || pu != 0 || pv != 0) {
      mark(job.r.lo);
    }
  }
  if (job.ends && job.ends->hasEnd) {
    const Vec2 b = at(out.pieces.back(), job.r.hi), want = job.ends->end;
    double pu, pv;
    if (const Singularity* g = poleAt(job, want)) {
      const bool freeU = !g->isoU;
      if (freeU ? std::fabs(b.x - want.x) > 0 : std::fabs(b.y - want.y) > 0) {
        const double fixedOff = freeU ? std::fabs(b.y - want.y) : std::fabs(b.x - want.x);
        if (poleAt(job, b) && fixedOff <= 10 * uvTol(job.s, b, job.tol))
          out.pieces.push_back(poleJump(job.r.hi, b, want));
        else mark(job.r.hi);
      }
    } else if (!samePlace(job, b, want, pu, pv) || pu != 0 || pv != 0) {
      // Off by whole periods: the curve winds otherwise than the ends say (its p-curve is continuous, they aren't).
      mark(job.r.hi);
    }
  }
}

void seams(const Job& job, Pcurve& out) {
  for (int dir = 0; dir < 2; dir++) {
    const double period = dir == 0 ? job.dom.uPeriod : job.dom.vPeriod, lo = dir == 0 ? job.dom.u.lo : job.dom.v.lo;
    if (!(period > 0)) continue;
    bool on = false, all = true;
    for (const PcurvePiece& p : out.pieces) {
      if (p.poleLine) continue;
      for (int i = 0; i <= 8 && all; i++) {
        const Vec2 q = at(p, p.t.lo + (p.t.hi - p.t.lo) * i / 8);
        Vec2 snap = q;
        double& x = dir == 0 ? snap.x : snap.y;
        x = lo + period * std::round((x - lo) / period);
        SurfacePoint a, b;
        job.s.eval(q.x, q.y, 0, a), job.s.eval(snap.x, snap.y, 0, b);
        // At the seam in 3D, and in (u, v) (a pole's points are at every u, the seam's among them).
        const double off = std::fabs(dir == 0 ? q.x - snap.x : q.y - snap.y);
        all = norm(a.p - b.p) <= job.tol && off <= 10 * uvTol(job.s, q, job.tol) + 1e-12 * period;
        on = true;
      }
    }
    if (!(on && all)) continue;
    (dir == 0 ? out.seamU : out.seamV) = true;
    out.seamTwin.clear();
    for (const PcurvePiece& p : out.pieces) {
      PcurvePiece q;
      q.t = p.t, q.kind = p.kind, q.reals = p.reals, q.ints = p.ints, q.poleLine = p.poleLine, q.from = p.from,
      q.to = p.to, q.certainty = p.certainty, q.error = p.error;
      std::copy(p.affine, p.affine + 9, q.affine);
      if (!q.poleLine) build(q);
      shift(q, dir == 0 ? period : 0, dir == 0 ? 0 : period);
      out.seamTwin.push_back(std::move(q));
    }
    return;  // a curve on both seams is at their crossing: a point, not a curve
  }
}

namespace {

/**
 * How far the curve leaves the surface's box over r, found from its spans' control hulls (bound()): its samples can
 * all lie on the surface while it leaves it within a span narrower than their spacing (a stray pole in a knot span a
 * millionth of the range wide). The box (bound() over the domain) holds every point of the surface, so a point's
 * distance from it is a lower bound on its distance from the surface; branch and bound on the spans' hulls finds the
 * largest. 0 where every hull is within tol of the box, or the domain is unbounded; `span` the break-to-break span
 * holding the farthest point found.
 */
double beyondSurface(const Job& job, Range& span) {
  span = {NAN, NAN};
  const SurfaceDomain& d = job.dom;
  Box3 sb;
  if (!(std::isfinite(d.u.lo) && std::isfinite(d.u.hi) && std::isfinite(d.v.lo) && std::isfinite(d.v.hi))
    || job.s.bound(d.u, d.v, sb) != Status::ok)
    return 0;
  auto excess = [](Interval a, Interval b) { return std::max({0.0, a.hi - b.hi, b.lo - a.lo}); };
  auto boxOff = [&](const Box3& b) { return std::hypot(excess(b.x, sb.x), excess(b.y, sb.y), excess(b.z, sb.z)); };
  auto pointOff = [&](double t) {
    CurvePoint q;
    if (job.c.eval(t, 0, q) != Status::ok) return 0.0;
    return boxOff({Interval::point(q.p.x), Interval::point(q.p.y), Interval::point(q.p.z)});
  };
  struct Node {
    double ub;
    Range t;
    bool operator<(const Node& o) const { return ub < o.ub; }
  };
  double best = 0;
  for (size_t k = 1; k < job.breaks.size(); k++) {
    const Range r{std::max(job.breaks[k - 1], job.r.lo), std::min(job.breaks[k], job.r.hi)};
    Box3 cb;
    if (!(r.lo < r.hi) || job.c.bound(r, cb) != Status::ok) continue;
    const double ub0 = boxOff(cb);
    if (!(ub0 > job.tol && ub0 > best)) continue;
    // Largest upper bound first; done once the largest is within 1% of the best found, or within tol.
    std::vector<Node> heap{{ub0, r}};
    double here = std::max(pointOff(r.lo), pointOff(r.hi));
    for (int nodes = 0; !heap.empty() && nodes < 200; nodes++) {
      std::pop_heap(heap.begin(), heap.end());
      const Node n = heap.back();
      heap.pop_back();
      if (n.ub <= std::max(job.tol, 1.01 * std::max(here, best))) break;
      const double m = 0.5 * (n.t.lo + n.t.hi);
      here = std::max(here, pointOff(m));
      for (Range h : {Range{n.t.lo, m}, Range{m, n.t.hi}}) {
        if (!(h.lo < h.hi) || job.c.bound(h, cb) != Status::ok) continue;
        heap.push_back({boxOff(cb), h});
        std::push_heap(heap.begin(), heap.end());
      }
    }
    if (here > best) best = here, span = r;
  }
  if (best > job.tol) return best;
  span = {NAN, NAN};
  return 0;
}

} // namespace

Form curveForm(const Model& m, int row) {
  for (int depth = 0; depth < 8 && row >= 0 && row < m.curves(); depth++) {
    if (m.curveKind(row) != CBR_CURVE_TRIMMED || m.curveInts(row)[1] == 0)
      return {m.curveKind(row), m.curveDim(row), m.curveReals(row), m.curveInts(row)};
    row = m.curveInts(row)[0];
  }
  return {};
}

Form surfaceForm(const Model& m, int row) {
  if (row < 0 || row >= m.surfaces()) return {};
  return {m.surfaceKind(row), 3, m.surfaceReals(row), m.surfaceInts(row)};
}

/**
 * A traced result's ends against the end search's feet (PcurveEnds' cache): a vertex farther than tol from the
 * curve's end isn't its end (vertexOff, the feet given); else the nearest foot in 3D, if the end is that one, then by
 * (u, v) the same, a whole number of periods over, or a seam pair's other copy; else different, the end ambiguous with
 * the feet as its alternatives.
 */
void checkEnds(const Job& job, Pcurve& out) {
  const PcurveEnds* e = job.ends;
  if (!e || !e->cache || out.pieces.empty()) return;
  auto point = [&](Vec2 uv) {
    SurfacePoint q;
    job.s.eval(uv.x, uv.y, 0, q);
    return q.p;
  };
  // Whether a and b, one place in 3D, are whole periods apart (rounded: the feet are only that accurate).
  auto shifted = [&](Vec2 a, Vec2 b) {
    const double pu = job.dom.uPeriod, pv = job.dom.vPeriod;
    return (pu > 0 && std::round((a.x - b.x) / pu) != 0) || (pv > 0 && std::round((a.y - b.y) / pv) != 0);
  };
  for (int side = 0; side < 2; side++) {
    if (!(side ? e->checkEnd : e->checkStart)) continue;
    const double t = side ? job.r.hi : job.r.lo;
    const PcurvePiece& q = side ? out.pieces.back() : out.pieces.front();
    const Vec2 uv = q.poleLine ? (side ? q.to : q.from) : at(q, t);
    const Vec3 vp = side ? e->endPoint : e->startPoint;
    CurvePoint cp;
    job.c.eval(t, 0, cp);
    const std::vector<EndFoot>& feet = e->cache->feet(side ? e->endKey : e->startKey, job.s, vp, job.tol);
    if (feet.empty()) continue;
    const Vec3 here = point(uv);
    // The nearest foot, if the end is that one: the end within tol of the curve's point, the feet within tol of the
    // vertex's, which is within tol of it (else vertexOff), so 3 tol (feet more than tol apart are separate ones).
    const EndFoot* k = nullptr;
    double best = kInf;
    for (const EndFoot& f : feet)
      if (const double d = norm(here - point(f.uv)); d < best) best = d, k = &f;
    EndCheck c = norm(vp - cp.p) > job.tol ? EndCheck::vertexOff : EndCheck::different;
    if (c == EndCheck::different && best <= 3 * job.tol) {
      if (k->kind == EndFoot::Kind::pole || !shifted(uv, k->uv)) c = EndCheck::same;
      else if (k->kind == EndFoot::Kind::seamPair && !shifted(uv, k->twin)) c = EndCheck::seamOther;
      else c = EndCheck::periods;
    }
    out.endCheck[side] = c;
    if (c == EndCheck::different || c == EndCheck::vertexOff)
      for (const EndFoot& k : feet) out.endAlternatives[side].push_back(k.uv);
    if (c == EndCheck::different) {
      out.certainty = Certainty::ambiguous;
      out.tAmbiguous.push_back(t);
    }
  }
}

Pcurve projectForms(const Curve& c, Range r, const Surface& s, double tol, const PcurveEnds* ends, Form curve,
  Form surface) {
  Pcurve out;
  if (!(r.lo < r.hi) || !std::isfinite(r.lo) || !std::isfinite(r.hi) || !(tol > 0) || c.dim() != 3) {
    out.status = Status::invalidModel;
    return out;
  }
  Job job{c, r, s, tol, ends, curve, surface, s.domain(), {}, {}};
  s.singularities(job.sing);
  c.breaks(r, job.breaks);
  {
    std::vector<double> us, vs;
    s.breaks(job.dom.u, job.dom.v, us, vs);
    // (A periodic direction's seam is one too: a closed profile's corner can be there.)
    if (job.dom.uPeriod > 0) job.uBreaks.push_back(job.dom.u.lo);
    for (double x : us)
      if (x > job.dom.u.lo && x < job.dom.u.hi) job.uBreaks.push_back(x);
    if (job.dom.vPeriod > 0) job.vBreaks.push_back(job.dom.v.lo);
    for (double x : vs)
      if (x > job.dom.v.lo && x < job.dom.v.hi) job.vBreaks.push_back(x);
  }
  if (!exact(job, out)) trace(job, out);
  // A curve leaving the surface within a span its samples miss: no p-curve is within tol, whatever the trace found.
  const double beyond = beyondSurface(job, out.offSpan);
  out.offSurface = std::max(out.offSurface, beyond);
  if (out.pieces.empty()) return out;
  align(job, out);
  seams(job, out);
  if (out.method == PcurveMethod::traced || out.method == PcurveMethod::affineFeet) checkEnds(job, out);
  // The result's error and certainty from its pieces'.
  out.error = 0;
  bool allUnique = true;
  const PcurvePiece* worstPiece = nullptr;
  double worstT = NAN;
  for (PcurvePiece& p : out.pieces) {
    double t = NAN;
    if (!p.poleLine) p.error = measure(job, p, &t);
    if (p.error > out.error || !worstPiece) out.error = std::max(out.error, p.error), worstPiece = &p, worstT = t;
    allUnique = allUnique && p.certainty == Certainty::unique;
  }
  if (out.certainty != Certainty::ambiguous) out.certainty = allUnique ? Certainty::unique : Certainty::ambiguous;
  if (out.status == Status::ok && !(out.error <= tol) && !(out.offSurface > tol) && worstPiece
    && !worstPiece->poleLine) {
    // offSurface is the farthest the feet the result was made from are; where the error is worst they may not be
    // (the nodes fall where they do): the curve's distance there from its foot on the result's branch (a local foot
    // from the result's (u, v), else the nearest anywhere), so whether the curve is off the surface (invalidModel) or
    // the p-curve misses it (noConvergence) doesn't hang on where the nodes fell.
    CurvePoint c;
    job.c.eval(worstT, 0, c);
    const LocalFoot f = localFoot(job.s, c.p, at(*worstPiece, worstT));
    double d = f.status == Status::ok ? f.distance : NAN;
    if (!(d >= 0)) d = invertSurface(job.s, c.p, job.dom.u, job.dom.v, tol).distance;
    if (d >= 0) out.offSurface = std::max(out.offSurface, d);
  }
  if (out.status == Status::ok && !(out.error <= tol))
    out.status = out.offSurface > tol ? Status::invalidModel : Status::noConvergence;
  // Whatever the trace or the fit said (where the trace gave up, noConvergence; measure samples each of the curve's
  // spans, so the error has the spike).
  if (beyond > 0) out.status = Status::invalidModel;
  return out;
}

} // namespace project

Pcurve projectCurve(const Curve& c, Range r, const Surface& s, double tol, const PcurveEnds* ends,
  const PcurveSource* source) {
  project::Form cf, sf;
  if (source && source->model) cf = project::curveForm(*source->model, source->curve),
    sf = project::surfaceForm(*source->model, source->surface);
  return project::projectForms(c, r, s, tol, ends, cf, sf);
}

const std::vector<EndFoot>& EndSearchCache::feet(uint64_t key, const Surface& s, Vec3 p, double tol) {
  Entry& e = entries_[key];
  if (!(tol <= e.searched)) {
    const SurfaceDomain dom = s.domain();
    invertSurface(s, p, dom.u, dom.v, tol, nullptr, &e.raw);
    e.searched = tol, e.clustered = -1, searches_++;
  }
  if (e.clustered == tol) return e.feet;
  e.feet.clear(), e.clustered = tol;
  if (e.raw.empty()) return e.feet;
  const SurfaceDomain dom = s.domain();
  std::vector<Singularity> sing;
  s.singularities(sing);
  auto at = [&](double u, double v) {
    SurfacePoint q;
    s.eval(u, v, 0, q);
    return q.p;
  };
  const double best = e.raw.front().distance;
  for (const SurfaceFoot& f : e.raw) {
    if (f.distance - best > tol) break;
    bool same = false;
    for (const EndFoot& k : e.feet) same = same || norm(at(k.uv.x, k.uv.y) - f.foot) <= tol;
    if (same) continue;
    EndFoot k;
    k.uv = f.uv, k.distance = f.distance;
    for (const Singularity& g : sing) {
      if (g.kind == Singularity::normalVanishes || norm(g.point - f.foot) > tol) continue;
      // A pole line u = at runs along v: v is free there.
      k.kind = EndFoot::Kind::pole, k.poleU = !g.isoU;
      k.freeLo = g.isoU ? dom.v.lo : dom.u.lo, k.freeHi = g.isoU ? dom.v.hi : dom.u.hi;
      break;
    }
    if (k.kind == EndFoot::Kind::point) {
      if (dom.uPeriod > 0) {
        const double lo = dom.u.lo, hi = lo + dom.uPeriod;
        if (norm(at(lo, f.uv.y) - f.foot) <= tol || norm(at(hi, f.uv.y) - f.foot) <= tol)
          k.kind = EndFoot::Kind::seamPair, k.twin = {f.uv.x - lo < hi - f.uv.x ? f.uv.x + dom.uPeriod
            : f.uv.x - dom.uPeriod, f.uv.y};
      }
      if (k.kind == EndFoot::Kind::point && dom.vPeriod > 0) {
        const double lo = dom.v.lo, hi = lo + dom.vPeriod;
        if (norm(at(f.uv.x, lo) - f.foot) <= tol || norm(at(f.uv.x, hi) - f.foot) <= tol)
          k.kind = EndFoot::Kind::seamPair, k.twin = {f.uv.x, f.uv.y - lo < hi - f.uv.y ? f.uv.y + dom.vPeriod
            : f.uv.y - dom.vPeriod};
      }
    }
    e.feet.push_back(k);
  }
  const Certainty c = e.feet.size() == 1 ? Certainty::unique : Certainty::ambiguous;
  for (EndFoot& k : e.feet) k.certainty = c;
  return e.feet;
}

bool seamUseTakesTwin(const Pcurve& p, bool useForward, bool faceSameSense) {
  for (const PcurvePiece& q : p.pieces) {
    if (q.poleLine || !q.curve) continue;
    CurvePoint e;
    q.curve->eval(0.5 * (q.t.lo + q.t.hi), 1, e);
    Vec2 d{e.d1.x, e.d1.y};
    if (!useForward) d = -d;
    Vec2 left{-d.y, d.x};
    if (!faceSameSense) left = -left;
    // The material above the use takes the lower copy (pieces); below it, the higher (the twin).
    return p.seamU ? !(left.x > 0) : !(left.y > 0);
  }
  return false;
}

} // namespace cadgeom
