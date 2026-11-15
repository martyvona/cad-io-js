// curve.h on every curve kind: the reference shapes' facts at every variant (points and derivatives, lengths,
// inverses), the catalogue's curve cases (an ambiguous parabola foot, a cusp), and checks against independent
// oracles on curves built here from raw rows (2D and 3D, every kind): bounds against dense samples over random
// subranges, derivatives against central differences of the order below, inversion against dense sampling,
// lengths against chord sums, and the parameter at a length against the length.
#include <cad_geom/curve.h>

#include <cmath>
#include <cstdio>
#include <functional>
#include <random>
#include <string>

#include "../src/curve_impl.h"
#include "brep_models.h"
#include "check.h"

using namespace cadgeom;
using cadgeom::curves::CurveImpl;
using cadgeom::curves::maxAbs;

namespace {

Vec3 V(const fixtures::Vec& v) { return {v.x, v.y, v.z}; }
bool nearVec(Vec3 got, Vec3 want, double tol, double abs) {
  return norm(got - want) <= std::fmax(tol * norm(want), abs);
}
std::string show(Vec3 v) {
  char b[128];
  std::snprintf(b, sizeof b, "(%.17g, %.17g, %.17g)", v.x, v.y, v.z);
  return b;
}
bool inBox(const Box3& b, Vec3 p) { return b.x.contains(p.x) && b.y.contains(p.y) && b.z.contains(p.z); }

// -- Curves from raw rows, for the oracle checks.

struct Made {
  std::string name;
  std::unique_ptr<CurveImpl> c;
  /** Where to sample an unbounded curve. */
  Range sample;
};

/** A 3D placement: origin, axis (1, 2, 2) / 3, x (2, -1, 0) / sqrt 5 (orthonormal), as reals. */
void frame3(double* r, Vec3 o) {
  double s = std::sqrt(5.0);
  double v[9] = {o.x, o.y, o.z, 1 / 3.0, 2 / 3.0, 2 / 3.0, 2 / s, -1 / s, 0};
  for (int i = 0; i < 9; i++) r[i] = v[i];
}
void frame2(double* r, Vec3 o) {
  double v[4] = {o.x, o.y, 0.6, 0.8};
  for (int i = 0; i < 4; i++) r[i] = v[i];
}

std::unique_ptr<CurveImpl> conic(int kind, int dim, Vec3 o, double a, double b) {
  double r[11];
  dim == 3 ? frame3(r, o) : frame2(r, o);
  int P = dim == 3 ? 9 : 4;
  r[P] = a, r[P + 1] = b;
  switch (kind) {
  case CBR_CURVE_CIRCLE: return curves::makeEllipse(r, dim, a, a);
  case CBR_CURVE_ELLIPSE: return curves::makeEllipse(r, dim, a, b);
  case CBR_CURVE_HYPERBOLA: return curves::makeHyperbola(r, dim);
  default: return curves::makeParabola(r, dim);
  }
}

std::unique_ptr<CurveImpl> bspline(int dim, int degree, std::vector<double> knots, std::vector<int> mults,
  std::vector<double> poles, std::vector<double> weights = {}) {
  int n = static_cast<int>(poles.size()) / dim, k = static_cast<int>(knots.size());
  std::vector<int32_t> in = {degree, n, k, weights.empty() ? 0 : 1, 2, 2, 0};
  for (int m : mults) in.push_back(m);
  std::vector<double> r = knots;
  r.insert(r.end(), poles.begin(), poles.end());
  r.insert(r.end(), weights.begin(), weights.end());
  Status s;
  auto c = curves::makeBSpline(r.data(), in.data(), dim, s);
  REQUIRE(s == Status::ok && c);
  return c;
}

/** The rational quarter-circle arcs of radius 3 about o (the exact circle, knots 0, 1/4, ..., 1), 3D or 2D. */
std::unique_ptr<CurveImpl> nurbsCircle(int dim, Vec3 o) {
  double h = std::sqrt(0.5);
  double P[9][2] = {{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}, {1, 0}};
  std::vector<double> poles, w;
  for (int i = 0; i < 9; i++) {
    poles.push_back(o.x + 3 * P[i][0]), poles.push_back(o.y + 3 * P[i][1]);
    if (dim == 3) poles.push_back(o.z + P[i][0]);  // tilted out of its plane: still a conic arc
    w.push_back(i % 2 ? h : 1);
  }
  return bspline(dim, 2, {0, 0.25, 0.5, 0.75, 1}, {3, 2, 2, 2, 3}, poles, w);
}

std::vector<Made> zoo(Vec3 o) {
  std::vector<Made> z;
  const double inf = curves::kInf;
  for (int dim : {3, 2}) {
    std::string d = dim == 3 ? " 3D" : " 2D";
    Vec3 q = dim == 3 ? o : Vec3{o.x, o.y, 0};
    double line[7];
    int k = 0;
    for (double v : {q.x, q.y, q.z}) if (k < dim) line[k++] = v;
    double dir3[3] = {0.48, 0.6, 0.64}, dir2[2] = {0.6, -0.8};
    for (int i = 0; i < dim; i++) line[dim + i] = dim == 3 ? dir3[i] : dir2[i];
    line[2 * dim] = 2.5;
    z.push_back({"line" + d, curves::makeLine(line, dim), {-3, 4}});
    z.push_back({"circle" + d, conic(CBR_CURVE_CIRCLE, dim, q, 2, 2), {0, 0}});
    z.push_back({"ellipse" + d, conic(CBR_CURVE_ELLIPSE, dim, q, 3, 1.25), {0, 0}});
    z.push_back({"ellipse b > a" + d, conic(CBR_CURVE_ELLIPSE, dim, q, 0.5, 4), {0, 0}});
    z.push_back({"hyperbola" + d, conic(CBR_CURVE_HYPERBOLA, dim, q, 1, 2), {-2, 1.5}});
    z.push_back({"parabola" + d, conic(CBR_CURVE_PARABOLA, dim, q, 0.75, 0), {-2, 3}});
    z.push_back({"parabola f < 0" + d, conic(CBR_CURVE_PARABOLA, dim, q, -0.5, 0), {-3, 2}});
    // A cubic with an interior double knot and an unclamped quadratic.
    std::vector<double> cp, up;
    double pts[7][3] = {{0, 0, 0}, {1, 2, 0.5}, {2, -1, 1}, {3, 0, -1}, {4, 2, 0}, {5, 1, 2}, {6, 0, 1}};
    for (auto& p : pts)
      for (int i = 0; i < dim; i++) cp.push_back((i == 0 ? q.x : i == 1 ? q.y : q.z) + p[i]);
    z.push_back({"cubic" + d, bspline(dim, 3, {0, 1, 2, 3.5}, {4, 1, 2, 4}, cp), {0, 0}});
    up = cp;
    z.push_back({"unclamped quadratic" + d, bspline(dim, 2, {0, 1, 2, 3, 4, 5, 6, 7, 8, 9},
      {1, 1, 1, 1, 1, 1, 1, 1, 1, 1}, up), {0, 0}});
    z.push_back({"rational cubic" + d, bspline(dim, 3, {0, 1, 2, 3.5}, {4, 1, 2, 4}, cp,
      {1, 2, 0.5, 1, 3, 1, 0.7}), {0, 0}});
    z.push_back({"nurbs circle" + d, nurbsCircle(dim, q), {0, 0}});
    double poly[15];
    double pp[5][3] = {{0, 0, 0}, {1, 0, 0}, {1, 2, 0}, {1, 2, 3}, {-1, 0, 1}};
    for (int j = 0; j < 5; j++)
      for (int i = 0; i < dim; i++) poly[j * dim + i] = (i == 0 ? q.x : i == 1 ? q.y : q.z) + pp[j][i];
    z.push_back({"polyline" + d, curves::makePolyline(poly, 5, dim), {0, 0}});
    // Trimmed: an arc both ways, a piece of the cubic, a line segment.
    Status s;
    double tr[8] = {1, 2.5, NAN, NAN, NAN, NAN, NAN, NAN};
    z.push_back({"arc" + d, curves::makeTrimmed(conic(CBR_CURVE_CIRCLE, dim, q, 2, 2), tr, 1, 1, s), {0, 0}});
    z.push_back({"arc against" + d, curves::makeTrimmed(conic(CBR_CURVE_ELLIPSE, dim, q, 3, 1.25), tr, 0, 1, s),
      {0, 0}});
    double tc[8] = {0.5, 3, NAN, NAN, NAN, NAN, NAN, NAN};
    z.push_back({"trimmed cubic" + d, curves::makeTrimmed(bspline(dim, 3, {0, 1, 2, 3.5}, {4, 1, 2, 4}, cp), tc, 1,
      1, s), {0, 0}});
    // A composite: a line segment, the arc against itself, the cubic piece.
    std::vector<curves::Segment> segs;
    double tl[8] = {-1, 0.5, NAN, NAN, NAN, NAN, NAN, NAN};
    segs.push_back({curves::makeTrimmed(curves::makeLine(line, dim), tl, 1, 1, s), true});
    segs.push_back({curves::makeTrimmed(conic(CBR_CURVE_CIRCLE, dim, q, 2, 2), tr, 1, 1, s), false});
    segs.push_back({bspline(dim, 3, {0, 1, 2, 3.5}, {4, 1, 2, 4}, cp), true});
    z.push_back({"composite" + d, curves::makeComposite(std::move(segs), s), {0, 0}});
    // Offsets: of an ellipse (away from its centres of curvature), of the cubic, of an offset.
    Vec3 ref = dim == 3 ? Vec3{1 / 3.0, 2 / 3.0, 2 / 3.0} : Vec3{};
    z.push_back({"offset ellipse" + d, curves::makeOffset(conic(CBR_CURVE_ELLIPSE, dim, q, 3, 2), 0.4, ref), {0, 0}});
    z.push_back({"offset ellipse inward" + d, curves::makeOffset(conic(CBR_CURVE_ELLIPSE, dim, q, 3, 2), -1, ref),
      {0, 0}});
    z.push_back({"offset rational cubic" + d, curves::makeOffset(bspline(dim, 3, {0, 1, 2, 3.5}, {4, 1, 2, 4}, cp,
      {1, 2, 0.5, 1, 3, 1, 0.7}), 0.05, dim == 3 ? Vec3{0, 0, 1} : ref), {0, 0}});
    z.push_back({"offset of offset" + d, curves::makeOffset(curves::makeOffset(conic(CBR_CURVE_CIRCLE, dim, q, 2, 2),
      0.5, ref), -0.25, ref), {0, 0}});
    z.push_back({"offset parabola" + d, curves::makeOffset(conic(CBR_CURVE_PARABOLA, dim, q, 0.75, 0), -0.3, ref),
      {-2, 2}});
  }
  for (Made& m : z) {
    REQUIRE(m.c);
    CurveDomain dom = m.c->domain();
    if (m.sample.lo == m.sample.hi) m.sample = std::isfinite(dom.range.lo) ? dom.range : Range{-inf, inf};
  }
  return z;
}

double dist(const CurveImpl& c, double t, Vec3 p) {
  Vec3 d[1];
  c.derivs(t, 0, d);
  return norm(d[0] - p);
}

} // namespace

// -- The reference shapes.

TEST_CASE("reference curvePoint facts: points and derivatives at every variant") {
  int n = 0;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    const Model m(ref.data, ref.size);
    REQUIRE(m.ok());
    for (int j = 0; j < ref.nCurvePoints; j++) {
      const fixtures::CurvePoint& f = ref.curvePoints[j];
      Status s;
      auto c = makeCurve(m, f.curve, s);
      if (!c) {
        CHECK(false);
        std::printf("  %s curve %d: no curve (status %d)\n", ref.file, f.curve, int(s));
        continue;
      }
      CurvePoint q;
      Status e = c->eval(f.t, 2, q);
      bool ok = e == Status::ok && nearVec(q.p, V(f.p), f.tol, f.abs) && nearVec(q.d1, V(f.d1), f.tol, f.abs)
        && nearVec(q.d2, V(f.d2), f.tol, f.abs);
      if (!ok) {
        CHECK(ok);
        std::printf("  %s curve %d at %.17g: p %s want %s, d1 %s want %s, d2 %s want %s\n", ref.file, f.curve, f.t,
          show(q.p).c_str(), show(V(f.p)).c_str(), show(q.d1).c_str(), show(V(f.d1)).c_str(), show(q.d2).c_str(),
          show(V(f.d2)).c_str());
      }
      n++;
    }
  }
  CHECK(n > 300);
}

TEST_CASE("reference curveLength facts at every variant") {
  int n = 0;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    const Model m(ref.data, ref.size);
    for (int j = 0; j < ref.nCurveLengths; j++) {
      const fixtures::CurveLength& f = ref.curveLengths[j];
      Status s;
      auto c = makeCurve(m, f.curve, s);
      REQUIRE(c);
      Estimate e = arcLength(*c, f.t0, f.t1, 1e-13);  // a tenth of the facts' tol
      bool ok = e.status == Status::ok && check::near(e.value, f.length, f.tol, f.abs)
        && e.error <= std::fmax(f.tol * f.length, f.abs);
      if (!ok) {
        CHECK(ok);
        std::printf("  %s curve %d [%.17g, %.17g]: %.17g (error %.3g, status %d) want %.17g\n", ref.file, f.curve,
          f.t0, f.t1, e.value, e.error, int(e.status), f.length);
      }
      n++;
    }
  }
  CHECK(n > 100);
}

TEST_CASE("reference curveInverse facts at every variant") {
  int n = 0;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    const Model m(ref.data, ref.size);
    for (int j = 0; j < ref.nCurveInverses; j++) {
      const fixtures::CurveInverse& f = ref.curveInverses[j];
      Status s;
      auto c = makeCurve(m, f.curve, s);
      REQUIRE(c);
      CurveInversion inv = invertCurve(*c, V(f.p), c->domain().range, f.abs);
      bool ok = inv.status == Status::ok && std::fabs(inv.t - f.t) <= f.ptol
        && check::near(inv.distance, f.distance, f.tol, f.abs) && inv.certainty == f.certainty
        && static_cast<int>(inv.alternatives.size()) == f.nAlternatives && inv.onSeam == f.onSeam;
      for (int a = 0; ok && a < f.nAlternatives; a++) ok = std::fabs(inv.alternatives[a] - f.alternatives[a]) <= f.ptol;
      if (!ok) {
        CHECK(ok);
        std::printf("  %s curve %d from %s: t %.17g distance %.17g certainty %d alternatives %zu onSeam %d "
          "(status %d); want t %.17g distance %.17g certainty %d alternatives %d onSeam %d\n", ref.file, f.curve,
          show(V(f.p)).c_str(), inv.t, inv.distance, int(inv.certainty), inv.alternatives.size(), inv.onSeam,
          int(inv.status), f.t, f.distance, int(f.certainty), f.nAlternatives, f.onSeam);
      }
      n++;
    }
  }
  CHECK(n > 50);
}

// -- The catalogue's curve cases (packages/cad-brep/test/reference/fixtures/case-*-s1.json, "cases").

TEST_CASE("catalogue: the parabola from its symmetry axis is ambiguous; from inside its curvature, unique") {
  const fixtures::Reference* ref = fixtures::reference("case-parabolic", "s1");
  REQUIRE(ref);
  const Model m(ref->data, ref->size);
  Status s;
  auto c = makeCurve(m, 0, s);
  REQUIRE(c);
  // parabolic-symmetry-curve: (3, 0, 0) over [-3, 3], tol 1e-9: t -1 and 1, distance sqrt 8.
  CurveInversion a = invertCurve(*c, {3, 0, 0}, {-3, 3}, 1e-9);
  CHECK(a.status == Status::ok);
  CHECK(a.certainty == Certainty::ambiguous);
  REQUIRE(a.alternatives.size() == 1);
  CHECK_NEAR(std::fmin(a.t, a.alternatives[0]), -1, 0, 1e-9);
  CHECK_NEAR(std::fmax(a.t, a.alternatives[0]), 1, 0, 1e-9);
  CHECK_NEAR(a.distance, std::sqrt(8.0), 1e-12, 0);
  CHECK(!a.onSeam);
  // parabolic-inside: (1.5, 0, 0): t 0, distance 1.5, unique.
  CurveInversion b = invertCurve(*c, {1.5, 0, 0}, {-3, 3}, 1e-9);
  CHECK(b.status == Status::ok);
  CHECK(b.certainty == Certainty::unique);
  CHECK(b.alternatives.empty());
  CHECK_NEAR(b.t, 0, 0, 1e-9);
  CHECK_NEAR(b.distance, 1.5, 1e-12, 0);
}

TEST_CASE("catalogue: the cubic's cusp is its one singular parameter") {
  const fixtures::Reference* ref = fixtures::reference("case-singular", "s1");
  REQUIRE(ref);
  const Model m(ref->data, ref->size);
  Status s;
  auto c = makeCurve(m, 6, s);
  REQUIRE(c);
  std::vector<double> z;
  c->singular({0, 1}, z);
  REQUIRE(z.size() == 1);
  CHECK_NEAR(z[0], 0.5, 0, 1e-9);
  CurvePoint q;
  c->eval(z[0], 1, q);
  CHECK(nearVec(q.p, {4.5, 0.75, 0}, 0, 1e-9));
  CHECK(norm(q.d1) < 1e-8);
  // Inside a subrange missing it, none; the length across it adds up.
  c->singular({0, 0.4}, z);
  CHECK(z.empty());
  Estimate whole = arcLength(*c, 0, 1, 1e-13), l = arcLength(*c, 0, 0.5, 1e-13), r = arcLength(*c, 0.5, 1, 1e-13);
  CHECK(whole.status == Status::ok);
  CHECK_NEAR(whole.value, l.value + r.value, 1e-12, 0);
}

// -- Oracles on every kind, 2D and 3D, near and far from the origin.

TEST_CASE("bounds hold: boxes and derivative bounds against dense samples over random subranges") {
  std::mt19937_64 rng(7);
  for (Vec3 o : {Vec3{0.5, -1, 2}, Vec3{1e6, -1e6, 1e6}}) {
    for (Made& m : zoo(o)) {
      const CurveImpl& c = *m.c;
      int bad = 0;
      for (int trial = 0; trial < 40; trial++) {
        std::uniform_real_distribution<double> u(m.sample.lo, m.sample.hi);
        double a = u(rng), b = u(rng);
        if (a > b) std::swap(a, b);
        if (trial == 0) a = m.sample.lo, b = m.sample.hi;
        if (trial == 1) b = a;  // a point
        Box3 box;
        double b1, b2;
        Status sb = c.bound({a, b}, box), s1 = c.derivBound({a, b}, 1, b1), s2 = c.derivBound({a, b}, 2, b2);
        if (sb != Status::ok || s1 != Status::ok || s2 != Status::ok) {
          bad++;
          std::printf("  %s: status %d %d %d on [%.17g, %.17g]\n", m.name.c_str(), int(sb), int(s1), int(s2), a, b);
          continue;
        }
        Box3 dbox[3];
        for (int k = 1; k <= 3; k++) CHECK(c.derivBox({a, b}, k, dbox[k - 1]) == Status::ok);
        for (int i = 0; i <= 200; i++) {
          double t = a + (b - a) * i / 200;
          Vec3 d[5];
          CHECK(c.derivs(t, 4, d) != Status::unsupported);
          bool ok = inBox(box, d[0]) && norm(d[1]) <= b1 && norm(d[2]) <= b2 && inBox(dbox[0], d[1])
            && inBox(dbox[1], d[2]) && inBox(dbox[2], d[3]);
          if (!ok && bad++ < 3)
            std::printf("  %s at %.17g in [%.17g, %.17g]: p %s |d1| %.17g <= %.17g |d2| %.17g <= %.17g\n",
              m.name.c_str(), t, a, b, show(d[0]).c_str(), norm(d[1]), b1, norm(d[2]), b2);
        }
      }
      if (bad) {
        CHECK(bad == 0);
        std::printf("  %s at %s: %d failures\n", m.name.c_str(), show(o).c_str(), bad);
      }
    }
  }
}

TEST_CASE("derivatives to order 4 agree with central differences of the order below") {
  for (Vec3 o : {Vec3{0.5, -1, 2}, Vec3{1e3, -1e3, 1e3}}) {
    for (Made& m : zoo(o)) {
      const CurveImpl& c = *m.c;
      std::vector<double> br;
      Range r = m.sample;
      for (int i = 1; i < 12; i++) {
        double t = r.lo + (r.hi - r.lo) * (i + 0.37) / 12.6;
        c.breaks({t - 1e-3, t + 1e-3}, br);
        if (br.size() > 2) continue;  // a break within the stencil
        Vec3 d[5], lo[5], hi[5], lo2[5], hi2[5];
        double h = 1e-3 * std::fmax(1.0, r.hi - r.lo);
        c.derivs(t, 4, d), c.derivs(t - h, 4, lo), c.derivs(t + h, 4, hi);
        c.derivs(t - h / 2, 4, lo2), c.derivs(t + h / 2, 4, hi2);
        for (int k = 1; k <= 4; k++) {
          // Central differences at h and h / 2, Richardson-extrapolated: error O(h^4 |C^(k+4)|).
          Vec3 f1 = (1 / (2 * h)) * (hi[k - 1] - lo[k - 1]), f2 = (1 / h) * (hi2[k - 1] - lo2[k - 1]);
          Vec3 fd = (1 / 3.0) * (4 * f2 - f1);
          double scale = std::fmax(1.0, norm(d[k]));
          bool ok = norm(fd - d[k]) <= 1e-6 * scale;
          if (!ok) {
            CHECK(ok);
            std::printf("  %s at %.17g order %d: %s vs differences %s\n", m.name.c_str(), t, k, show(d[k]).c_str(),
              show(fd).c_str());
          }
        }
      }
    }
  }
}

TEST_CASE("inversion: random points against dense sampling, the foot at the distance reported") {
  std::mt19937_64 rng(11);
  for (Vec3 o : {Vec3{0.5, -1, 2}, Vec3{1e6, -1e6, 1e6}}) {
    for (Made& m : zoo(o)) {
      const CurveImpl& c = *m.c;
      Range r = m.sample;
      for (int trial = 0; trial < 12; trial++) {
        std::uniform_real_distribution<double> u(r.lo, r.hi), off(-2, 2);
        Vec3 d[1];
        c.derivs(u(rng), 0, d);
        Vec3 p = d[0] + Vec3{off(rng), off(rng), c.dim() == 3 ? off(rng) : 0};
        CurveInversion inv = invertCurve(c, p, r, 1e-9);
        if (inv.status != Status::ok) {
          CHECK(inv.status == Status::ok);
          std::printf("  %s from %s: status %d\n", m.name.c_str(), show(p).c_str(), int(inv.status));
        }
        // The sampled minimum: never below ours by more than the tolerances.
        double best = curves::kInf;
        const int N = 20000;
        for (int i = 0; i <= N; i++) best = std::fmin(best, dist(c, r.lo + (r.hi - r.lo) * i / N, p));
        double slack = 1e-9 + 1e-15 * maxAbs(o);
        bool ok = inv.distance <= best + slack && std::fabs(dist(c, inv.t, p) - inv.distance) <= slack
          && inv.t >= r.lo && inv.t <= r.hi && norm(inv.foot - (p + Vec3{})) - inv.distance <= slack;
        if (!ok) {
          CHECK(ok);
          std::printf("  %s from %s: t %.17g distance %.17g, sampled %.17g\n", m.name.c_str(), show(p).c_str(),
            inv.t, inv.distance, best);
        }
      }
    }
  }
}

TEST_CASE("inversion: seams, ends, periods, ambiguity and a continuum") {
  Status s;
  auto circle = conic(CBR_CURVE_CIRCLE, 3, {1, 2, 3}, 2, 2);
  Vec3 d[1];
  // On the seam: t at the range's low end, onSeam, unique; a range from 1 reports in [1, 1 + 2 pi).
  circle->derivs(0, 0, d);
  CurveInversion a = invertCurve(*circle, d[0], circle->domain().range, 1e-9);
  CHECK(a.onSeam);
  CHECK_EQ(a.t, 0.0);
  CHECK(a.certainty == Certainty::unique);
  CHECK(a.alternatives.empty());
  circle->derivs(0.5, 0, d);
  CurveInversion b = invertCurve(*circle, d[0], {1, 1 + 4 * M_PI}, 1e-9);
  CHECK_NEAR(b.t, 0.5 + 2 * M_PI, 0, 1e-12);
  CHECK(!b.onSeam);
  // A subrange of the circle: not closed over it, so no seam; the nearest end.
  circle->derivs(0, 0, d);
  CurveInversion c = invertCurve(*circle, d[0], {0, 3}, 1e-9);
  CHECK(!c.onSeam);
  CHECK_EQ(c.t, 0.0);
  // The centre: every point a foot. Ambiguous, alternatives sampling the circle.
  CurveInversion e = invertCurve(*circle, {1, 2, 3}, circle->domain().range, 1e-9);
  CHECK(e.status == Status::ok);
  CHECK(e.certainty == Certainty::ambiguous);
  CHECK(e.alternatives.size() >= 2);
  CHECK_NEAR(e.distance, 2, 1e-12, 0);
  // Two feet: the ellipse from its centre, at the ends of the minor axis (t pi / 2 and 3 pi / 2).
  auto el = conic(CBR_CURVE_ELLIPSE, 3, {1, 2, 3}, 3, 1.25);
  CurveInversion f = invertCurve(*el, {1, 2, 3}, el->domain().range, 1e-9);
  CHECK(f.certainty == Certainty::ambiguous);
  REQUIRE(f.alternatives.size() == 1);
  CHECK_NEAR(std::fmin(f.t, f.alternatives[0]), M_PI / 2, 0, 1e-9);
  CHECK_NEAR(std::fmax(f.t, f.alternatives[0]), 3 * M_PI / 2, 0, 1e-9);
  // The closed NURBS circle at its ends: onSeam, t its domain's start.
  auto nc = nurbsCircle(3, {0, 0, 0});
  nc->derivs(1, 0, d);
  CurveInversion g = invertCurve(*nc, d[0], nc->domain().range, 1e-9);
  CHECK(g.onSeam);
  CHECK_EQ(g.t, 0.0);
  CHECK(g.alternatives.empty());
  // An unbounded hyperbola and line over their whole domains.
  auto hy = conic(CBR_CURVE_HYPERBOLA, 2, {0, 0, 0}, 1, 2);
  hy->derivs(1.7, 0, d);
  CurveInversion h = invertCurve(*hy, d[0] + Vec3{0.01, 0, 0}, hy->domain().range, 1e-9);
  CHECK(h.status == Status::ok);
  CHECK_NEAR(h.t, 1.7, 0, 1e-2);
  double ln[5] = {0, 0, 1, 0, 0.5};
  auto line = curves::makeLine(ln, 2);
  CurveInversion k = invertCurve(*line, {7, 3, 0}, line->domain().range, 1e-9);
  CHECK_NEAR(k.t, 14, 1e-12, 0);
  CHECK_NEAR(k.distance, 3, 1e-12, 0);
  (void)s;
}

TEST_CASE("lengths: closed forms and quadrature against chord sums; the parameter at a length") {
  for (Vec3 o : {Vec3{0.5, -1, 2}, Vec3{1e6, -1e6, 1e6}}) {
    for (Made& m : zoo(o)) {
      const CurveImpl& c = *m.c;
      Range r = m.sample;
      double a = r.lo + 0.1 * (r.hi - r.lo), b = r.hi - 0.2 * (r.hi - r.lo);
      Estimate L = arcLength(c, a, b, 1e-12);
      CHECK(L.status == Status::ok);
      // Chords from 2^16 pieces, Richardson-extrapolated once with 2^15 (error O(h^4)); local to the curve.
      auto chords = [&](int n) {
        std::vector<double> br;
        c.breaks({a, b}, br);
        double sum = 0;
        for (size_t s = 0; s + 1 < br.size(); s++)
          for (int i = 0; i < n; i++) {
            // A span's last point its left limit: a composite may jump at a joint.
            Vec3 p[1], q[1];
            double hi = br[s] + (br[s + 1] - br[s]) * (i + 1) / n;
            c.derivs(br[s] + (br[s + 1] - br[s]) * i / n, 0, p);
            c.derivs(i + 1 == n ? std::nextafter(hi, br[s]) : hi, 0, q);
            sum += norm(q[0] - p[0]);
          }
        return sum;
      };
      double c1 = chords(1 << 15), c2 = chords(1 << 14), ref = c1 + (c1 - c2) / 3;
      double slack = 1e-9 * L.value + 1e-13 * maxAbs(o) * (1 << 15);
      bool ok = std::fabs(L.value - ref) <= slack;
      if (!ok) {
        CHECK(ok);
        std::printf("  %s: length %.17g vs chords %.17g\n", m.name.c_str(), L.value, ref);
      }
      // The parameter at fractions of the length, and back.
      for (double f : {0.0, 0.3, 0.999, 1.0}) {
        Estimate t = paramAtLength(c, a, f * L.value, 1e-12);
        CHECK(t.status == Status::ok);
        Estimate back = arcLength(c, a, std::fmax(a, t.value), 1e-13);
        bool ok2 = std::fabs(back.value - f * L.value) <= 1e-10 * L.value + 1e-12;
        if (!ok2) {
          CHECK(ok2);
          std::printf("  %s: at %.3g of %.17g, t %.17g gives %.17g\n", m.name.c_str(), f, L.value, t.value,
            back.value);
        }
      }
    }
  }
}

TEST_CASE("lengths: closed forms exact; beyond a bounded curve's end; past a periodic one's period") {
  auto circle = conic(CBR_CURVE_CIRCLE, 3, {1, 2, 3}, 2, 2);
  Estimate a = arcLength(*circle, -1, 10, 1e-12);
  CHECK(a.status == Status::ok);
  CHECK_NEAR(a.value, 22, 1e-15, 0);
  Estimate t = paramAtLength(*circle, 0, 30, 1e-12);
  CHECK(t.status == Status::ok);
  CHECK_NEAR(t.value, 15, 1e-11, 0);
  double poly[6] = {0, 0, 3, 4, 3, 5};
  auto pl = curves::makePolyline(poly, 3, 2);
  CHECK_NEAR(arcLength(*pl, 0.5, 2, 1e-12).value, 3.5, 1e-15, 0);
  CHECK(arcLength(*pl, -1, 2, 1e-12).status == Status::outOfDomain);
  Estimate past = paramAtLength(*pl, 0, 7, 1e-12);
  CHECK(past.status == Status::outOfDomain);
  CHECK_EQ(past.value, 2.0);
  CHECK(arcLength(*pl, 2, 1, 1e-12).status == Status::outOfDomain);
}

TEST_CASE("structure: domains, breaks and singular parameters of compound curves") {
  Status s;
  Vec3 q{0, 0, 0};
  double tr[8] = {1, 2.5, NAN, NAN, NAN, NAN, NAN, NAN};
  auto with = curves::makeTrimmed(conic(CBR_CURVE_CIRCLE, 3, q, 2, 2), tr, 1, 1, s);
  CHECK_EQ(with->domain().range.lo, 1.0);
  CHECK_EQ(with->domain().range.hi, 2.5);
  CHECK_EQ(with->domain().period, 0.0);
  auto against = curves::makeTrimmed(conic(CBR_CURVE_CIRCLE, 3, q, 2, 2), tr, 0, 1, s);
  CHECK_NEAR(against->domain().range.lo, 2.5 - 2 * M_PI, 1e-15, 0);
  CHECK_EQ(against->domain().range.hi, 1.0);
  // Equal trims on a closed basis: once round.
  double eq[8] = {1, 1, NAN, NAN, NAN, NAN, NAN, NAN};
  auto round = curves::makeTrimmed(conic(CBR_CURVE_CIRCLE, 3, q, 2, 2), eq, 1, 1, s);
  CHECK_NEAR(round->domain().range.hi - round->domain().range.lo, 2 * M_PI, 1e-15, 0);
  // Trims by points, and the master representation choosing the point over the parameter.
  Vec3 d[1];
  auto basis = conic(CBR_CURVE_CIRCLE, 3, q, 2, 2);
  basis->derivs(0.75, 0, d);
  Vec3 p1 = d[0];
  basis->derivs(2, 0, d);
  double tp[8] = {NAN, 5, p1.x, p1.y, p1.z, d[0].x, d[0].y, d[0].z};
  auto byPoint = curves::makeTrimmed(conic(CBR_CURVE_CIRCLE, 3, q, 2, 2), tp, 1, CBR_TRIM_PARAMETER, s);
  CHECK_NEAR(byPoint->domain().range.lo, 0.75, 0, 1e-12);
  CHECK_EQ(byPoint->domain().range.hi, 5.0);
  auto cartesian = curves::makeTrimmed(conic(CBR_CURVE_CIRCLE, 3, q, 2, 2), tp, 1, CBR_TRIM_CARTESIAN, s);
  CHECK_NEAR(cartesian->domain().range.hi, 2, 0, 1e-12);
  // A composite's breaks: its joints and its segments' own breaks mapped.
  std::vector<curves::Segment> segs;
  double pl[6] = {0, 0, 1, 0, 1, 1};
  segs.push_back({curves::makePolyline(pl, 3, 2), true});
  segs.push_back({curves::makePolyline(pl, 3, 2), false});
  auto comp = curves::makeComposite(std::move(segs), s);
  std::vector<double> br;
  comp->breaks({0, 2}, br);
  CHECK(br == std::vector<double>({0, 0.5, 1, 1.5, 2}));
  comp->breaks({0.25, 1.25}, br);
  CHECK(br == std::vector<double>({0.25, 0.5, 1, 1.25}));
  Vec3 dd[2];
  comp->derivs(1.25, 1, dd);  // the second segment reversed: from (1, 1) back, d1 = -2 (0, 1)
  CHECK(nearVec(dd[0], {1, 0.5, 0}, 0, 1e-15));
  CHECK(nearVec(dd[1], {0, -2, 0}, 0, 1e-15));
  // A polyline's repeated point is singular; a composite maps it.
  double rep[8] = {0, 0, 1, 0, 1, 0, 2, 0};
  auto rp = curves::makePolyline(rep, 4, 2);
  std::vector<double> z;
  rp->singular({0, 3}, z);
  CHECK(z == std::vector<double>({1}));
  // A 2D offset to the right (outward on a counterclockwise circle) by minus the radius is a point: its speed
  // vanishes everywhere.
  auto off = curves::makeOffset(conic(CBR_CURVE_CIRCLE, 2, q, 2, 2), -2, {});
  off->derivs(0.3, 1, dd);
  CHECK(norm(dd[1]) < 1e-12);
  // Out of the domain: the clamped value, and the status says so.
  CurvePoint cp;
  CHECK(with->eval(3, 0, cp) == Status::outOfDomain);
  with->derivs(2.5, 0, d);
  CHECK(nearVec(cp.p, d[0], 0, 0));
}
