// numerics.h: the B-spline basis against the Cox-de Boor recursion written out here (the oracle independent of
// Piegl and Tiller's triangular algorithms), evaluation against it and against the reference shapes' exact facts at
// every variant (far ones too), the toolkit (insertion, Bezier pieces, degree elevation) leaving curves the same,
// rational iso-curves of the exact cylinder, sphere and torus included; quadrature on closed forms, its error
// estimate covering the true error; Bernstein root isolation; 2D fitting within tol, checked densely here.
#include <cad_geom/curve.h>
#include <cad_geom/numerics.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

#include "brep_models.h"
#include "check.h"

using namespace cadgeom;

namespace {

/** splitmix64: a fixed, portable sequence (std's distributions differ between libraries). */
struct Rng {
  uint64_t s;
  uint64_t next() {
    uint64_t z = (s += 0x9e3779b97f4a7c15ull);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
    return z ^ (z >> 31);
  }
  double uniform(double a = 0, double b = 1) { return a + (b - a) * (next() >> 11) * 0x1.0p-53; }
  int below(int n) { return static_cast<int>(next() % n); }
};

// The Cox-de Boor recursion and its derivative (N'_{i,p} = p / (u_{i+p} - u_i) N_{i,p-1} - p / (u_{i+p+1} - u_{i+1})
// N_{i+1,p-1}), 0/0 as 0, half-open spans with the last one closed.
double cox(const std::vector<double>& U, int i, int p, double t, int order) {
  if (order == 0 && p == 0) {
    double last = U.back();
    bool closedEnd = t == last && U[i + 1] == last && U[i] < last;
    return (U[i] <= t && t < U[i + 1]) || closedEnd ? 1.0 : 0.0;
  }
  if (p == 0) return 0;
  double a = 0, b = 0, d1 = U[i + p] - U[i], d2 = U[i + p + 1] - U[i + 1];
  if (order == 0) {
    if (d1 > 0) a = (t - U[i]) / d1 * cox(U, i, p - 1, t, 0);
    if (d2 > 0) b = (U[i + p + 1] - t) / d2 * cox(U, i + 1, p - 1, t, 0);
    return a + b;
  }
  if (d1 > 0) a = p / d1 * cox(U, i, p - 1, t, order - 1);
  if (d2 > 0) b = p / d2 * cox(U, i + 1, p - 1, t, order - 1);
  return a - b;
}

/** The point and derivatives by the recursion and the quotient rule written out: the oracle for eval. */
void naiveEval(const BSpline& c, double t, double* out) {
  int n = c.poleCount(), d = c.dim, w = d + (c.rational ? 1 : 0);
  double A[3][4] = {}, W[3] = {};
  for (int k = 0; k <= 2; k++)
    for (int i = 0; i < n; i++) {
      double N = cox(c.knots, i, c.degree, t, k), wt = c.rational ? c.poles[i * w + d] : 1.0;
      for (int a = 0; a < d; a++) A[k][a] += N * wt * c.poles[i * w + a];
      W[k] += N * wt;
    }
  for (int a = 0; a < d; a++) {
    double C = A[0][a] / W[0], C1 = (A[1][a] - W[1] * C) / W[0];
    out[a] = C;
    out[d + a] = C1;
    out[2 * d + a] = (A[2][a] - 2 * W[1] * C1 - W[2] * C) / W[0];
  }
}

/** A random clamped B-spline: degree p, n poles, interior knots with multiplicities up to p, weights if rational. */
BSpline randomSpline(Rng& r, int p, int n, int dim, bool rational) {
  BSpline c;
  c.degree = p;
  c.dim = dim;
  c.rational = rational;
  std::vector<double> inner;
  while (static_cast<int>(inner.size()) < n - p - 1) {
    double u = std::round(r.uniform(0.05, 0.95) * 64) / 64;
    if (std::find(inner.begin(), inner.end(), u) != inner.end()) continue;  // multiplicities stay <= p
    int m = 1 + r.below(p);
    for (int k = 0; k < m && static_cast<int>(inner.size()) < n - p - 1; k++) inner.push_back(u);
  }
  std::sort(inner.begin(), inner.end());
  c.knots.assign(p + 1, 0.0);
  c.knots.insert(c.knots.end(), inner.begin(), inner.end());
  c.knots.insert(c.knots.end(), p + 1, 1.0);
  for (int i = 0; i < n; i++) {
    for (int a = 0; a < dim; a++) c.poles.push_back(r.uniform(-10, 10));
    if (rational) c.poles.push_back(r.uniform(0.3, 3));
  }
  return c;
}

double dist(const double* a, const double* b, int n) {
  double s = 0;
  for (int k = 0; k < n; k++) s += (a[k] - b[k]) * (a[k] - b[k]);
  return std::sqrt(s);
}
double len(const double* a, int n) {
  double s = 0;
  for (int k = 0; k < n; k++) s += a[k] * a[k];
  return std::sqrt(s);
}

/**
 * Every derivative of b against a at these parameters, relative to its order's scale: the largest pole times
 * (degree / shortest span)^k, what rounding in the poles is amplified by (a derivative that's 0, say a line's
 * second, is still only known to that).
 */
double worstDifference(const BSpline& a, const BSpline& b, const std::vector<double>& ts) {
  double worst = 0, pole = 1, span = 1;
  int w = a.dim + (a.rational ? 1 : 0);
  for (int i = 0; i < a.poleCount(); i++) pole = std::max(pole, len(a.poles.data() + i * w, a.dim));
  for (size_t i = 1; i < a.knots.size(); i++)
    if (a.knots[i] > a.knots[i - 1]) span = std::min(span, a.knots[i] - a.knots[i - 1]);
  const double scale[3] = {pole, pole * a.degree / span, pole * a.degree * a.degree / (span * span)};
  for (double t : ts) {
    double x[9], y[9];
    REQUIRE(bspline::eval(a, t, 2, x) == Status::ok);
    REQUIRE(bspline::eval(b, t, 2, y) == Status::ok);
    for (int k = 0; k <= 2; k++) {
      int d = a.dim;
      worst = std::max(worst, dist(x + k * d, y + k * d, d) / std::max(scale[k], len(x + k * d, d)));
    }
  }
  return worst;
}

std::vector<double> samples(const BSpline& c, int count) {
  std::vector<double> ts;
  double lo = c.knots[c.degree], hi = c.knots[c.poleCount()];
  for (int i = 0; i <= count; i++) ts.push_back(lo + (hi - lo) * i / count);
  for (double u : c.knots) ts.push_back(u);  // the knots themselves, where one-sided derivatives meet
  return ts;
}

/** A model's B-spline curve row as numerics.h's form (cad-brep's layout: degree, poles, knots, rational, ...). */
BSpline curveRow(const Model& m, int row) {
  const double* r = m.curveReals(row);
  const int32_t* in = m.curveInts(row);
  BSpline c;
  c.degree = in[0];
  int n = in[1], k = in[2];
  c.rational = in[3] != 0;
  c.dim = m.curveDim(row);
  c.knots = bspline::fullKnots(r, in + 7, k);
  const double *poles = r + k, *weights = poles + n * c.dim;
  for (int i = 0; i < n; i++) {
    for (int a = 0; a < c.dim; a++) c.poles.push_back(poles[i * c.dim + a]);
    if (c.rational) c.poles.push_back(weights[i]);
  }
  return c;
}

/**
 * The u iso-curve of a model's B-spline surface row at v: a rational B-spline in u whose homogeneous poles are the
 * v-combinations of the surface's (Piegl and Tiller, eq. 4.9's surface at fixed v), so S(u, v), S_u and S_uu are
 * its point and derivatives.
 */
BSpline isoCurve(const Model& m, int row, double v, double* origin) {
  const double* r = m.surfaceReals(row);
  const int32_t* in = m.surfaceInts(row);
  int p = in[0], q = in[1], nu = in[2], nv = in[3], ku = in[4], kv = in[5];
  bool rational = in[6] != 0;
  std::vector<double> U = bspline::fullKnots(r, in + 11, ku), V = bspline::fullKnots(r + ku, in + 11 + ku, kv);
  const double *P = r + ku + kv, *Wt = P + 3 * nu * nv;
  // Combined relative to the first pole (the facts are then compared moved by it): combining poles near 1e6 in the
  // test itself would cost what the evaluation is tested for keeping.
  for (int a = 0; a < 3; a++) origin[a] = P[a];
  int span = bspline::findSpan(q, V, nv, v);
  std::vector<double> N(q + 1);
  bspline::basis(span, v, q, V, N.data());
  BSpline c;
  c.degree = p;
  c.dim = 3;
  c.rational = true;
  c.knots = U;
  for (int i = 0; i < nu; i++) {
    double h[4] = {};
    for (int j = 0; j <= q; j++) {
      int jj = span - q + j;
      double w = rational ? Wt[i * nv + jj] : 1.0;
      for (int a = 0; a < 3; a++) h[a] += N[j] * w * (P[3 * (i * nv + jj) + a] - origin[a]);
      h[3] += N[j] * w;
    }
    c.poles.insert(c.poles.end(), {h[0] / h[3], h[1] / h[3], h[2] / h[3], h[3]});
  }
  return c;
}

bool near3(const fixtures::Vec& e, const double* g, double tol, double abs) {
  double d = std::hypot(e.x - g[0], e.y - g[1], e.z - g[2]);
  return d <= std::max(tol * std::hypot(e.x, e.y, e.z), abs);
}

/** The reference shapes' B-spline curve rows and the facts on them, with the curve as numerics.h holds it. */
template <class F> void eachSplineCurveFact(F f) {
  for (int k = 0; k < fixtures::nReferences; k++) {
    const fixtures::Reference& r = fixtures::references[k];
    const Model m(r.data, r.size);
    REQUIRE(m.ok());
    for (int i = 0; i < r.nCurvePoints; i++) {
      const fixtures::CurvePoint& fact = r.curvePoints[i];
      if (m.curveKind(fact.curve) == CBR_CURVE_BSPLINE) f(r, fact, curveRow(m, fact.curve));
    }
  }
}

/** The facts on B-spline surfaces, with the u iso-curve through each. */
template <class F> void eachSplineSurfaceFact(F f) {
  for (int k = 0; k < fixtures::nReferences; k++) {
    const fixtures::Reference& r = fixtures::references[k];
    const Model m(r.data, r.size);
    REQUIRE(m.ok());
    for (int i = 0; i < r.nSurfacePoints; i++) {
      const fixtures::SurfacePoint& fact = r.surfacePoints[i];
      if (m.surfaceKind(fact.surface) != CBR_SURFACE_BSPLINE) continue;
      double o[3];
      BSpline c = isoCurve(m, fact.surface, fact.v, o);
      fixtures::SurfacePoint moved = fact;
      moved.p = {fact.p.x - o[0], fact.p.y - o[1], fact.p.z - o[2]};
      f(r, moved, c);
    }
  }
}

/**
 * A curve's point, d1, d2 at t against a fact's; `rounded` adds what storing c's poles once more costs (a curve the
 * toolkit made: each pole rounded to its own ulp, amplified in the k-th derivative by (degree / shortest span)^k).
 */
bool matches(const BSpline& c, double t, const fixtures::Vec& p, const fixtures::Vec& d1, const fixtures::Vec& d2,
  double tol, double abs, bool rounded = false) {
  double extra[3] = {0, 0, 0};
  if (rounded) {
    double pole = 0, span = 1;
    int w = c.dim + (c.rational ? 1 : 0);
    for (int i = 0; i < c.poleCount(); i++) pole = std::max(pole, len(c.poles.data() + i * w, c.dim));
    for (size_t i = 1; i < c.knots.size(); i++)
      if (c.knots[i] > c.knots[i - 1]) span = std::min(span, c.knots[i] - c.knots[i - 1]);
    double ulp = std::nextafter(pole, INFINITY) - pole, gain = c.degree / span;
    extra[0] = 2 * ulp, extra[1] = 2 * ulp * gain, extra[2] = 2 * ulp * gain * gain;
  }
  double out[9];
  if (bspline::eval(c, t, 2, out) != Status::ok) return false;
  if (c.dim == 2) {  // pad 2D to 3D as the fixtures do
    double o[9] = {out[0], out[1], 0, out[2], out[3], 0, out[4], out[5], 0};
    std::copy(o, o + 9, out);
  }
  return near3(p, out, tol, abs + extra[0]) && near3(d1, out + 3, tol, abs + extra[1])
    && near3(d2, out + 6, tol, abs + extra[2]);
}

/** A Bernstein polynomial's value at s, de Casteljau's way (the test's own). */
double deCasteljau(std::vector<double> b, double s) {
  for (size_t r = 1; r < b.size(); r++)
    for (size_t i = 0; i + r < b.size(); i++) b[i] = (1 - s) * b[i] + s * b[i + 1];
  return b[0];
}

/** Power-basis coefficients a_0..a_n of the polynomial with these roots (times lead), as Bernstein coefficients. */
std::vector<double> bernsteinFromRoots(const std::vector<double>& roots, double lead = 1) {
  std::vector<double> a{lead};
  for (double r : roots) {
    std::vector<double> b(a.size() + 1, 0.0);
    for (size_t i = 0; i < a.size(); i++) b[i + 1] += a[i], b[i] -= r * a[i];
    a = b;
  }
  const int n = static_cast<int>(a.size()) - 1;
  auto C = [](int n2, int k) {
    double c = 1;
    for (int i = 1; i <= k; i++) c = c * (n2 - k + i) / i;
    return c;
  };
  std::vector<double> out(n + 1, 0.0);  // b_i = sum_{j <= i} C(i, j) / C(n, j) a_j
  for (int i = 0; i <= n; i++)
    for (int j = 0; j <= i; j++) out[i] += C(i, j) / C(n, j) * a[j];
  return out;
}

} // namespace

// ---- The basis ----

TEST_CASE("findSpan: the span holding t, the last nonempty one at the end, multiplicities skipped") {
  const std::vector<double> U{0, 0, 0, 0.25, 0.25, 0.5, 0.75, 0.75, 0.75, 1, 1, 1};  // p = 2, n = 9
  const int p = 2, n = 9;
  for (int k = 0; k <= 400; k++) {
    double t = k / 400.0;
    int s = bspline::findSpan(p, U, n, t);
    // The oracle: U[s] <= t < U[s + 1] and nonempty, or the last nonempty span at t = U[n].
    if (t < U[n]) CHECK(U[s] <= t && t < U[s + 1]);
    else CHECK(U[s] < U[s + 1] && U[s + 1] == U[n]);
    CHECK(s >= p && s < n);
  }
  CHECK_EQ(bspline::findSpan(p, U, n, 0.25), 4);
  CHECK_EQ(bspline::findSpan(p, U, n, 0.75), 8);
  CHECK_EQ(bspline::findSpan(p, U, n, 1.0), 8);
  CHECK_EQ(bspline::findSpan(p, U, n, std::nextafter(0.25, 0.0)), 2);
  CHECK_EQ(bspline::findSpan(p, U, n, -1.0), 2);
  CHECK_EQ(bspline::findSpan(p, U, n, 2.0), 8);
  // An end knot repeated beyond p + 1 (a malformed vector a caller may still pass): the last nonempty span all the
  // same, at the end and beyond it.
  const std::vector<double> V{0, 0, 0, 0.5, 1, 1, 1, 1};  // p = 2, n = 5: U[4] = U[5] = 1
  CHECK_EQ(bspline::findSpan(2, V, 5, 1.0), 3);
  CHECK_EQ(bspline::findSpan(2, V, 5, 1.5), 3);
  CHECK_EQ(bspline::findSpan(2, V, 5, 0.75), 3);
}

TEST_CASE("basis and basisDerivs: the Cox-de Boor recursion, partition of unity, derivatives summing to 0") {
  Rng r{1};
  for (int trial = 0; trial < 60; trial++) {
    int p = 1 + trial % 5, n = p + 1 + r.below(8);
    BSpline c = randomSpline(r, p, n, 1, false);
    for (int k = 0; k < 40; k++) {
      double t = k == 0 ? c.knots[p] : k == 1 ? c.knots[n] : r.uniform(c.knots[p], c.knots[n]);
      if (k == 2) t = c.knots[p + 1];  // at an interior knot
      int s = bspline::findSpan(p, c.knots, n, t);
      std::vector<double> N(p + 1), D(3 * (p + 1));
      bspline::basis(s, t, p, c.knots, N.data());
      bspline::basisDerivs(s, t, p, 2, c.knots, D.data());
      double sum = 0, sum1 = 0, sum2 = 0;
      for (int j = 0; j <= p; j++) {
        int i = s - p + j;
        CHECK_NEAR(N[j], cox(c.knots, i, p, t, 0), 1e-12, 1e-12);
        CHECK(N[j] >= -1e-15);
        CHECK_NEAR(D[j], N[j], 1e-12, 1e-12);
        for (int o = 1; o <= 2; o++) {
          double scale = std::pow(64.0, o) * std::pow(p, o);  // knots on a 1/64 grid: derivatives up to (64 p)^o
          CHECK_NEAR(D[o * (p + 1) + j], cox(c.knots, i, p, t, o), 1e-11, 1e-13 * scale);
        }
        sum += N[j], sum1 += D[p + 1 + j], sum2 += D[2 * (p + 1) + j];
      }
      CHECK_NEAR(sum, 1, 1e-14, 0);
      CHECK_NEAR(sum1, 0, 0, 1e-10 * 64 * p);
      CHECK_NEAR(sum2, 0, 0, 1e-8 * 64 * 64 * p * p);
    }
  }
}

TEST_CASE("basisDerivs: orders above the degree are zero") {
  const std::vector<double> U{0, 0, 1, 1};  // p = 1
  double D[3 * 2];
  bspline::basisDerivs(1, 0.3, 1, 2, U, D);
  CHECK_NEAR(D[0], 0.7, 1e-15, 0);
  CHECK_NEAR(D[1], 0.3, 1e-15, 0);
  CHECK_NEAR(D[2], -1, 1e-15, 0);
  CHECK_NEAR(D[3], 1, 1e-15, 0);
  CHECK_EQ(D[4], 0.0);
  CHECK_EQ(D[5], 0.0);
}

TEST_CASE("fullKnots: distinct knots by multiplicity") {
  const double k[] = {0, 0.5, 1};
  const int32_t m[] = {3, 1, 3};
  CHECK(bspline::fullKnots(k, m, 3) == (std::vector<double>{0, 0, 0, 0.5, 1, 1, 1}));
}

// ---- Evaluation ----

TEST_CASE("eval: the recursion's point and derivatives, rational or not, 2D and 3D") {
  Rng r{2};
  for (int trial = 0; trial < 80; trial++) {
    int p = 1 + trial % 4, n = p + 1 + r.below(6), dim = 2 + trial % 2;
    BSpline c = randomSpline(r, p, n, dim, trial % 3 != 0);
    for (double t : samples(c, 25)) {
      double got[9], want[9];
      REQUIRE(bspline::eval(c, t, 2, got) == Status::ok);
      naiveEval(c, t, want);
      for (int k = 0; k <= 2; k++) {
        double scale = std::max(1.0, len(want + k * dim, dim));
        CHECK(dist(got + k * dim, want + k * dim, dim) <= 1e-10 * scale);
      }
    }
  }
}

TEST_CASE("eval: order, the domain, malformed curves") {
  BSpline c;
  c.degree = 1;
  c.dim = 2;
  c.knots = {0, 0, 1, 1};
  c.poles = {0, 0, 2, 4};
  double out[6] = {9, 9, 9, 9, 9, 9};
  CHECK(bspline::eval(c, 0.25, 0, out) == Status::ok);
  CHECK_NEAR(out[0], 0.5, 1e-15, 0);
  CHECK_NEAR(out[1], 1, 1e-15, 0);
  CHECK_EQ(out[2], 9.0);  // order 0 writes the point only
  CHECK(bspline::eval(c, 0.25, 1, out) == Status::ok);
  CHECK_NEAR(out[2], 2, 1e-15, 0);
  CHECK_NEAR(out[3], 4, 1e-15, 0);
  CHECK(bspline::eval(c, 1.5, 0, out) == Status::outOfDomain);
  CHECK_NEAR(out[0], 2, 1e-15, 0);  // the clamped value still written
  CHECK(bspline::eval(c, -0.5, 0, out) == Status::outOfDomain);
  CHECK_NEAR(out[1], 0, 0, 1e-15);
  CHECK(bspline::eval(c, 0.5, 3, out) == Status::invalidModel);
  CHECK(bspline::eval(c, 0.5, -1, out) == Status::invalidModel);
  BSpline bad = c;
  bad.knots = {0, 0, 1};
  CHECK(bspline::eval(bad, 0.5, 0, out) == Status::invalidModel);
  bad = c;
  bad.dim = 4;
  bad.poles = {0, 0, 0, 0, 1, 1, 1, 1};
  CHECK(bspline::eval(bad, 0.5, 0, out) == Status::invalidModel);
}

TEST_CASE("eval: every B-spline curve fact of the reference shapes, at every variant, far ones included") {
  int facts = 0, far = 0;
  eachSplineCurveFact([&](const fixtures::Reference& r, const fixtures::CurvePoint& f, const BSpline& c) {
    bool ok = matches(c, f.t, f.p, f.d1, f.d2, f.tol, f.abs);
    if (!ok) check::fail(__FILE__, __LINE__, std::string(r.file) + ": curve " + std::to_string(f.curve) + " at t = "
      + check::show(f.t));
    facts++;
    far += std::strcmp(r.variant, "far") == 0;
  });
  CHECK(facts >= 84);  // bsplineCircle's at 7 variants, as fixtures hold them
  CHECK(far >= 12);
}

TEST_CASE("eval: B-spline surfaces' u iso-curves give the surface facts' point, S_u and S_uu, far ones included") {
  int facts = 0;
  eachSplineSurfaceFact([&](const fixtures::Reference& r, const fixtures::SurfacePoint& f, const BSpline& c) {
    bool ok = matches(c, f.u, f.p, f.du, f.duu, f.tol, f.abs);
    if (!ok) check::fail(__FILE__, __LINE__, std::string(r.file) + ": surface " + std::to_string(f.surface)
      + " at (" + check::show(f.u) + ", " + check::show(f.v) + ")");
    facts++;
  });
  CHECK(facts >= 100);
}

TEST_CASE("arcLength on B-splines: every curveLength fact, far ones included (curve.cpp on these numerics)") {
  int facts = 0;
  for (int k = 0; k < fixtures::nReferences; k++) {
    const fixtures::Reference& r = fixtures::references[k];
    const Model m(r.data, r.size);
    for (int i = 0; i < r.nCurveLengths; i++) {
      const fixtures::CurveLength& f = r.curveLengths[i];
      if (m.curveKind(f.curve) != CBR_CURVE_BSPLINE) continue;
      Status st;
      std::unique_ptr<Curve> c = makeCurve(m, f.curve, st);
      REQUIRE(c);
      Estimate e = arcLength(*c, f.t0, f.t1, 1e-13);
      CHECK(e.status == Status::ok);
      if (!(std::fabs(e.value - f.length) <= std::max(f.tol * f.length, f.abs)))
        check::fail(__FILE__, __LINE__, std::string(r.file) + " length " + std::to_string(i) + ": "
          + check::show(e.value) + " vs " + check::show(f.length));
      CHECK(std::fabs(e.value - f.length) <= e.error + f.abs);
      facts++;
    }
  }
  CHECK(facts >= 20);
}

TEST_CASE("eval: far from the origin the derivatives keep the precision they have at it") {
  // The same random curves at the origin and moved by 1e6: derivatives must agree to near the origin's precision,
  // not lose the 1e-10 that evaluating with absolute coordinates costs.
  Rng r{3};
  double worst = 0;
  for (int trial = 0; trial < 40; trial++) {
    BSpline c = randomSpline(r, 2 + trial % 3, 8, 3, trial % 2 == 0), moved = c;
    int w = 3 + (c.rational ? 1 : 0);
    for (int i = 0; i < c.poleCount(); i++)
      for (int a = 0; a < 3; a++) {
        moved.poles[i * w + a] += a == 1 ? -1e6 : 1e6;
        c.poles[i * w + a] = moved.poles[i * w + a] - (a == 1 ? -1e6 : 1e6);  // exact: the same curve, moved
      }
    for (double t : samples(c, 50)) {
      double x[9], y[9];
      bspline::eval(c, t, 2, x);
      bspline::eval(moved, t, 2, y);
      for (int k = 1; k <= 2; k++) worst = std::max(worst, dist(x + 3 * k, y + 3 * k, 3) / len(x + 3 * k, 3));
      double back[3] = {y[0] - 1e6, y[1] + 1e6, y[2] - 1e6};
      CHECK(dist(back, x, 3) <= 4e-10);  // the point: rounded once at 1e6 (ulp 1.2e-10)
    }
  }
  CHECK(worst < 1e-11);
}

// ---- The toolkit ----

TEST_CASE("insertKnot: new knots and raised multiplicities leave the curve the same") {
  Rng r{4};
  for (int trial = 0; trial < 120; trial++) {
    int p = 1 + trial % 5, n = p + 1 + r.below(6);
    BSpline c = randomSpline(r, p, n, 2 + trial % 2, trial % 2 == 1);
    BSpline d = c;
    double t = trial % 3 == 0 && n > p + 1 ? c.knots[p + 1] : r.uniform(0.01, 0.99);
    int s = static_cast<int>(std::count(c.knots.begin(), c.knots.end(), t));
    if (s >= p) continue;
    int times = 1 + r.below(p - s);
    REQUIRE(bspline::insertKnot(d, t, times) == Status::ok);
    CHECK_EQ(d.poleCount(), n + times);
    CHECK_EQ(static_cast<int>(d.knots.size()), n + times + p + 1);
    CHECK_EQ(static_cast<int>(std::count(d.knots.begin(), d.knots.end(), t)), s + times);
    CHECK(std::is_sorted(d.knots.begin(), d.knots.end()));
    CHECK(worstDifference(c, d, samples(c, 60)) < 1e-12);
  }
}

TEST_CASE("insertKnot: the arguments it refuses, and times 0") {
  BSpline c;
  c.degree = 2;
  c.dim = 2;
  c.knots = {0, 0, 0, 0.5, 1, 1, 1};
  c.poles = {0, 0, 1, 2, 2, 0, 3, 1};
  BSpline d = c;
  CHECK(bspline::insertKnot(d, 0.5, 0) == Status::ok);
  CHECK(d.knots == c.knots && d.poles == c.poles);
  CHECK(bspline::insertKnot(d, 0, 1) == Status::outOfDomain);
  CHECK(bspline::insertKnot(d, 1, 1) == Status::outOfDomain);
  CHECK(bspline::insertKnot(d, 1.5, 1) == Status::outOfDomain);
  CHECK(bspline::insertKnot(d, 0.5, 2) == Status::invalidModel);  // multiplicity 3 > p
  CHECK(bspline::insertKnot(d, 0.25, 3) == Status::invalidModel);
  CHECK(bspline::insertKnot(d, 0.25, -1) == Status::invalidModel);
  CHECK(d.knots == c.knots && d.poles == c.poles);  // refused: unchanged
  CHECK(bspline::insertKnot(d, 0.5, 1) == Status::ok);
  CHECK(bspline::insertKnot(d, 0.25, 2) == Status::ok);
  CHECK(worstDifference(c, d, samples(c, 40)) < 1e-14);
}

TEST_CASE("toBezier: one piece per nonempty span, each the curve over its span") {
  Rng r{5};
  for (int trial = 0; trial < 120; trial++) {
    int p = 1 + trial % 5, n = p + 1 + r.below(7);
    BSpline c = randomSpline(r, p, n, 2 + trial % 2, trial % 2 == 0);
    std::vector<BSpline> z = bspline::toBezier(c);
    std::vector<double> distinct;
    for (int i = p; i <= n; i++)
      if (distinct.empty() || c.knots[i] != distinct.back()) distinct.push_back(c.knots[i]);
    REQUIRE(z.size() == distinct.size() - 1);
    for (size_t k = 0; k < z.size(); k++) {
      CHECK_EQ(z[k].poleCount(), p + 1);
      CHECK_EQ(z[k].degree, p);
      CHECK(z[k].rational == c.rational);
      CHECK_EQ(z[k].knots.front(), distinct[k]);
      CHECK_EQ(z[k].knots.back(), distinct[k + 1]);
      std::vector<double> ts;
      for (int i = 0; i <= 20; i++) ts.push_back(distinct[k] + (distinct[k + 1] - distinct[k]) * i / 20);
      // At the span's ends the piece has the one-sided derivatives; the curve's right-hand ones agree except at the
      // right end, so that end is compared by the point only.
      ts.pop_back();
      CHECK(worstDifference(c, z[k], ts) < 1e-11);
      double x[3], y[3];
      bspline::eval(c, distinct[k + 1], 0, x);
      bspline::eval(z[k], distinct[k + 1], 0, y);
      CHECK(dist(x, y, c.dim) < 1e-11 * std::max(1.0, len(x, c.dim)));
    }
  }
}

TEST_CASE("toBezier: a Bezier curve is itself; a split curve is refused") {
  BSpline c;
  c.degree = 2;
  c.dim = 2;
  c.knots = {0, 0, 0, 1, 1, 1};
  c.poles = {0, 0, 1, 2, 3, 0};
  std::vector<BSpline> z = bspline::toBezier(c);
  REQUIRE(z.size() == 1);
  CHECK(z[0].knots == c.knots && z[0].poles == c.poles);
  BSpline split = c;
  split.degree = 1;
  split.knots = {0, 0, 0.5, 0.5, 1, 1};
  split.poles = {0, 0, 1, 1, 2, 2, 3, 3};
  CHECK(bspline::toBezier(split).empty());  // 0.5 twice at degree 1: C^-1
  BSpline bad = c;
  bad.knots.pop_back();
  CHECK(bspline::toBezier(bad).empty());
}

TEST_CASE("elevateDegree: by 1 to 3, the curve the same, each distinct knot's multiplicity raised by as much") {
  Rng r{6};
  for (int trial = 0; trial < 120; trial++) {
    int p = 1 + trial % 4, n = p + 1 + r.below(7), by = 1 + trial % 3;
    BSpline c = randomSpline(r, p, n, 2 + trial % 2, trial % 2 == 1);
    BSpline d = c;
    REQUIRE(bspline::elevateDegree(d, by) == Status::ok);
    CHECK_EQ(d.degree, p + by);
    std::vector<std::pair<double, int>> mc, md;
    for (double u : c.knots)
      if (mc.empty() || mc.back().first != u) mc.push_back({u, 1}); else mc.back().second++;
    for (double u : d.knots)
      if (md.empty() || md.back().first != u) md.push_back({u, 1}); else md.back().second++;
    REQUIRE(mc.size() == md.size());
    for (size_t k = 0; k < mc.size(); k++) {
      CHECK_EQ(md[k].first, mc[k].first);
      CHECK_EQ(md[k].second, mc[k].second + by);
    }
    CHECK_EQ(d.poleCount(), static_cast<int>(d.knots.size()) - (p + by) - 1);
    CHECK(worstDifference(c, d, samples(c, 60)) < 1e-11);
  }
}

TEST_CASE("elevateDegree: by 0 unchanged; refused when malformed or split") {
  BSpline c;
  c.degree = 1;
  c.dim = 2;
  c.knots = {0, 0, 0.5, 1, 1};
  c.poles = {0, 0, 1, 1, 2, 0};
  BSpline d = c;
  CHECK(bspline::elevateDegree(d, 0) == Status::ok);
  CHECK(d.poles == c.poles && d.knots == c.knots);
  CHECK(bspline::elevateDegree(d, -1) == Status::invalidModel);
  BSpline split = c;
  split.knots = {0, 0, 0.5, 0.5, 1, 1};
  split.poles = {0, 0, 1, 1, 1, 2, 2, 0};
  CHECK(bspline::elevateDegree(split, 1) == Status::invalidModel);
  // A line raised to degree 3: its poles evenly spaced along it.
  BSpline line;
  line.degree = 1;
  line.dim = 2;
  line.knots = {0, 0, 1, 1};
  line.poles = {0, 0, 3, 6};
  REQUIRE(bspline::elevateDegree(line, 2) == Status::ok);
  REQUIRE(line.poleCount() == 4);
  for (int i = 0; i < 4; i++) {
    CHECK_NEAR(line.poles[2 * i], i, 1e-15, 1e-15);
    CHECK_NEAR(line.poles[2 * i + 1], 2 * i, 1e-15, 1e-15);
  }
}

TEST_CASE("the toolkit on the exact rational shapes: curve and iso-curve facts still hold after each operation") {
  int checked = 0;
  auto each = [&](const char* file, const BSpline& c, double t, const fixtures::Vec& p, const fixtures::Vec& d1,
                const fixtures::Vec& d2, double tol, double abs) {
    double lo = c.knots[c.degree], hi = c.knots[c.poleCount()];
    std::vector<std::pair<const char*, BSpline>> variants{{"as given", c}};
    BSpline k1 = c;
    double mid = 0.5 * (lo + hi);
    if (bspline::insertKnot(k1, mid, 1) == Status::ok) variants.push_back({"knot at mid", k1});
    BSpline k2 = c;
    if (bspline::insertKnot(k2, t > lo && t < hi ? t : mid, 1) == Status::ok) variants.push_back({"knot at t", k2});
    BSpline e = c;
    REQUIRE(bspline::elevateDegree(e, 2) == Status::ok);
    variants.push_back({"elevated", e});
    for (const BSpline& z : bspline::toBezier(c))
      if (t >= z.knots.front() && (t < z.knots.back() || (t == hi && z.knots.back() == hi)))
        variants.push_back({"Bezier", z});
    for (const auto& [name, v] : variants) {
      // The surface facts' tolerances hold derivatives; a curve's Bezier piece at its right end has the left-hand
      // ones, which the facts give only at the range's end, as here.
      if (!matches(v, t, p, d1, d2, tol, abs, std::strcmp(name, "as given") != 0))
        check::fail(__FILE__, __LINE__, std::string(file) + " " + name + " at " + check::show(t));
      checked++;
    }
  };
  eachSplineCurveFact([&](const fixtures::Reference& r, const fixtures::CurvePoint& f, const BSpline& c) {
    each(r.file, c, f.t, f.p, f.d1, f.d2, f.tol, f.abs);
  });
  eachSplineSurfaceFact([&](const fixtures::Reference& r, const fixtures::SurfacePoint& f, const BSpline& c) {
    each(r.file, c, f.u, f.p, f.du, f.duu, f.tol, f.abs);
  });
  CHECK(checked >= 500);
}

// ---- Quadrature ----

TEST_CASE("quadrature: one K15 is exact to degree 22, G7 to 13 (the table), and no more") {
  // Without halving (absTol huge): the Kronrod value alone, |K15 - G7| as its error estimate.
  for (int k = 0; k <= 26; k++) {
    Estimate e = quadrature::integrate([k](double x) { return std::pow(x, k); }, -1, 1, 1e300, 0);
    double exact = k % 2 ? 0 : 2.0 / (k + 1);
    if (k <= 22) CHECK_NEAR(e.value, exact, 1e-14, 1e-15);
    else if (k % 2 == 0) CHECK(std::fabs(e.value - exact) > 1e-12);
    if (k <= 13) CHECK(e.error <= 1e-13);  // the rounding floor, 50 ulp of the integral of |f|
    else if (k % 2 == 0) CHECK(e.error > 1e-6);
  }
  // On [0, 1] so odd degrees count too.
  for (int k : {21, 22}) {
    Estimate e = quadrature::integrate([k](double x) { return std::pow(x, k); }, 0, 1, 1e300, 0);
    CHECK_NEAR(e.value, 1.0 / (k + 1), 1e-13, 0);
  }
  Estimate e40 = quadrature::integrate([](double x) { return std::pow(x, 40); }, 0, 1, 1e300, 0);
  CHECK(std::fabs(e40.value - 1.0 / 41) > 1e-10);
}

TEST_CASE("quadrature: closed forms, smooth, peaked, oscillating and singular at an end; the estimate covers") {
  const double pi = 3.14159265358979323846;
  struct Case {
    const char* name;
    std::function<double(double)> f;
    double a, b, exact;
  };
  const Case cases[] = {
    {"exp", [](double x) { return std::exp(x); }, 0, 1, std::exp(1.0) - 1},
    {"sin", [](double x) { return std::sin(x); }, 0, pi, 2},
    {"peak", [](double x) { return 1 / (1e-6 + (x - 0.3) * (x - 0.3)); }, 0, 1,
      (std::atan(0.7 / 1e-3) + std::atan(0.3 / 1e-3)) / 1e-3},
    {"cos 200x", [](double x) { return std::cos(200 * x); }, 0, 1, std::sin(200.0) / 200},
    {"1 / sqrt x", [](double x) { return 1 / std::sqrt(x); }, 0, 1, 2},
    {"log x", [](double x) { return std::log(x); }, 0, 1, -1},
    {"x^-0.9", [](double x) { return std::pow(x, -0.9); }, 0, 1, 10},
    {"sqrt(1 - x^2)", [](double x) { return std::sqrt(1 - x * x); }, -1, 1, pi / 2},
    {"kink |x - 1/3|", [](double x) { return std::fabs(x - 1.0 / 3); }, 0, 1, 5.0 / 18},
    {"reversed", [](double x) { return x * x; }, 2, -1, -3},
  };
  for (const Case& c : cases)
    for (double rel : {1e-6, 1e-10, 1e-13}) {
      Estimate e = quadrature::integrate(c.f, c.a, c.b, 0, rel);
      double err = std::fabs(e.value - c.exact);
      if (!(err <= e.error)) check::fail(__FILE__, __LINE__, std::string(c.name) + ": error " + check::show(err)
        + " above the estimate " + check::show(e.error));
      if (e.status == Status::ok) CHECK(e.error <= rel * std::fabs(e.value));
      else CHECK(e.status == Status::noConvergence);
      if (rel >= 1e-10 && e.status != Status::ok) check::fail(__FILE__, __LINE__, std::string(c.name) + " at "
        + check::show(rel) + " didn't converge");
    }
}

TEST_CASE("quadrature: noConvergence when the evaluations run out or the singularity can't be resolved") {
  // x^-0.99: integrable (100), but its tail shrinks by only 2^-0.01 a halving: out of evaluations.
  Estimate e = quadrature::integrate([](double x) { return std::pow(x, -0.99); }, 0, 1, 0, 1e-10);
  CHECK(e.status == Status::noConvergence);
  CHECK(std::fabs(e.value - 100) <= e.error);
  // 1 / sqrt(1 - x): integrable (2), but 1 - x cancels near 1, so nothing below about 1e-14 of the end can be
  // resolved (any sampler's limit): fine at 1e-6, then an honest noConvergence.
  auto atEnd = [](double x) { return 1 / std::sqrt(1 - x); };
  Estimate coarse = quadrature::integrate(atEnd, 0, 1, 0, 1e-6);
  CHECK(coarse.status == Status::ok);
  CHECK(std::fabs(coarse.value - 2) <= coarse.error);
  Estimate fine = quadrature::integrate(atEnd, 0, 1, 0, 1e-10);
  CHECK(fine.status == Status::noConvergence);
  CHECK(std::fabs(fine.value - 2) <= fine.error);
  // 1 / (1 - x): not integrable; the estimate stays large.
  int divCalls = 0;
  Estimate div = quadrature::integrate([&](double x) { divCalls++; return 1 / (1 - x); }, 0, 1, 0, 1e-8);
  CHECK(div.status == Status::noConvergence);
  CHECK(std::isinf(div.error));
  CHECK(divCalls < 20000);  // given up once an infinite error can't come down, not after every evaluation
  // An interior singularity off every split point (1/3): its pieces narrow to rounding and stop there, their
  // estimates at least their values; honest, whether or not it converges.
  auto spike = [](double x) { return 1 / std::sqrt(std::fabs(x - 1.0 / 3)); };
  const double spikeExact = 2 * std::sqrt(1.0 / 3) + 2 * std::sqrt(2.0 / 3);
  for (double rel : {1e-8, 1e-12, 1e-15}) {
    Estimate sp = quadrature::integrate(spike, 0, 1, 0, rel);
    CHECK(std::fabs(sp.value - spikeExact) <= sp.error);
  }
  // Below rounding nothing can be certified: an integral asked for 1e-18 doesn't converge, honestly.
  for (double rel : {1e-17, 1e-18}) {
    Estimate tight = quadrature::integrate([](double x) { return std::exp(x); }, 0, 10, 0, rel);
    CHECK(tight.status == Status::noConvergence);
    CHECK(std::fabs(tight.value - (std::exp(10.0) - 1)) <= tight.error);
  }
  // Just above rounding a smooth integrand still converges (halvings whose change is rounding noise don't count).
  Estimate nearFloor = quadrature::integrate([](double x) { return std::exp(x); }, 0, 10, 0, 2e-14);
  CHECK(nearFloor.status == Status::ok);
  Estimate few = quadrature::integrate([](double x) { return std::cos(200 * x); }, 0, 1, 0, 1e-12, 60);
  CHECK(few.status == Status::noConvergence);
  CHECK(std::fabs(few.value - std::sin(200.0) / 200) <= few.error);
  // An absolute tolerance alone suffices near a zero integral.
  Estimate zero = quadrature::integrate([](double x) { return std::sin(x); }, -1, 1, 1e-12, 0);
  CHECK(zero.status == Status::ok);
  CHECK_NEAR(zero.value, 0, 0, 1e-12);
}

TEST_CASE("quadrature: an integral cancelling to 0 under a relTol: noConvergence at once, the estimate covering") {
  // Over [1e6, 1e6 + 1e-6], f = t - the midpoint: the integral is 0, the nodes only placed to ulp(1e6), so nothing
  // below about ulp(1e6) times f's variation (1e-16) can be known. Likewise sin over a symmetric span.
  const double c = 1e6 + 0.5e-6;
  int n = 0;
  Estimate e = quadrature::integrate([&](double t) { n++; return t - c; }, 1e6, 1e6 + 1e-6, 0, 1e-9);
  CHECK(e.status == Status::noConvergence);
  CHECK(std::isfinite(e.error));
  CHECK(std::fabs(e.value) <= e.error);
  CHECK(e.error <= 1e-15);
  CHECK(n <= 45);
  n = 0;
  Estimate s = quadrature::integrate([&](double t) { n++; return std::sin(t); }, -1e-12, 1e-12, 0, 1e-9);
  CHECK(s.status == Status::noConvergence);
  CHECK(std::fabs(s.value) <= s.error);
  CHECK(n <= 45);
  // A cubic cancelling near 1e6 is halved (|K - G| isn't 0 there): its estimate stays finite and covering.
  Estimate cube = quadrature::integrate([&](double t) { return std::pow(t - c, 3) * 1e18; }, 1e6, 1e6 + 1e-6, 0, 1e-9);
  CHECK(std::isfinite(cube.error));
  CHECK(std::fabs(cube.value) <= cube.error);
  // With an absolute tolerance above that floor, it's met.
  Estimate abs = quadrature::integrate([&](double t) { return t - c; }, 1e6, 1e6 + 1e-6, 1e-15, 1e-9);
  CHECK(abs.status == Status::ok);
}

TEST_CASE("quadrature: a smooth integral near a large t, halved down to its nodes' rounding: finite, covering, early") {
  // sin(1000 (t - 1e6)) over [1e6, 1e6 + 1]: the nodes are only placed to ulp(1e6), so halvings reach changes that
  // are that rounding's noise; they mustn't read as a tail (not shrinking: infinite) or run to maxEval.
  const double exact = (1 - std::cos(1000.0)) / 1000;
  int n = 0;
  Estimate e = quadrature::integrate([&](double t) { n++; return std::sin(1e3 * (t - 1e6)); }, 1e6, 1e6 + 1, 0, 1e-9);
  CHECK(e.status == Status::noConvergence);
  CHECK(std::isfinite(e.error));
  CHECK(std::fabs(e.value - exact) <= e.error);
  // The nodes' rounding isn't in the estimate (numerics.h): summed over the pieces it would be 5e-8 here.
  CHECK(e.error <= 2e-8);
  CHECK(n < 50000);
  // Relative to the range's start (as callers keep t), the same integral converges.
  Estimate r = quadrature::integrate([](double s) { return std::sin(1e3 * s); }, 0, 1, 0, 1e-9);
  CHECK(r.status == Status::ok);
  CHECK(std::fabs(r.value - exact) <= r.error + 1e-15);
}

TEST_CASE("quadrature: non-finite values, infinite or empty ranges") {
  Estimate e = quadrature::integrate([](double x) { return 1 / x; }, -1, 1, 0, 1e-8);  // 0 is the centre node
  CHECK(e.status == Status::singular);
  CHECK(std::isnan(e.value));
  Estimate inf = quadrature::integrate([](double x) { return x; }, 0, INFINITY, 0, 1e-8);
  CHECK(inf.status == Status::outOfDomain);
  Estimate empty = quadrature::integrate([](double) { return 1.0; }, 2, 2, 0, 1e-8);
  CHECK(empty.status == Status::ok);
  CHECK_EQ(empty.value, 0.0);
  int calls = 0;
  quadrature::integrate([&](double x) { calls++; return std::exp(x); }, 0, 1, 0, 1e-12, 100000);
  CHECK(calls <= 100000);
  CHECK_EQ(calls % 15, 0);
}

// ---- Roots ----

TEST_CASE("roots::bernstein: simple roots isolated within tol, each holding its root") {
  Status st;
  const std::vector<double> want{0.1, 0.35, 0.77};
  std::vector<roots::RootInterval> got = roots::bernstein(bernsteinFromRoots(want), 1e-12, st);
  CHECK(st == Status::ok);
  REQUIRE(got.size() == 3);
  for (size_t i = 0; i < 3; i++) {
    CHECK(got[i].r.lo <= want[i] + 1e-15 && want[i] - 1e-15 <= got[i].r.hi);
    CHECK(got[i].r.hi - got[i].r.lo <= 1e-12);
    CHECK_EQ(got[i].changes, 1);
  }
  // Outside [0, 1] and complex roots aren't reported.
  got = roots::bernstein(bernsteinFromRoots({-0.5, 0.6, 1.7}), 1e-10, st);
  CHECK(st == Status::ok);
  REQUIRE(got.size() == 1);
  CHECK(got[0].r.lo <= 0.6 && 0.6 <= got[0].r.hi);
  // (t - 0.5)^2 + 0.01 = 0.26 - t + t^2: Bernstein coefficients a0, a0 + a1 / 2, a0 + a1 + a2.
  got = roots::bernstein({0.26, -0.24, 0.26}, 1e-10, st);
  CHECK(st == Status::ok);
  CHECK(got.empty());
}

TEST_CASE("roots::bernstein: roots at the ends and at a split point are points; a nonzero constant has none") {
  Status st;
  // 3 t (1 - t) (1 - 2 t): exactly 0 at 0, 1/2 and 1.
  std::vector<roots::RootInterval> got = roots::bernstein({0, 1, -1, 0}, 1e-10, st);
  CHECK(st == Status::ok);
  REQUIRE(got.size() == 3);
  CHECK(got[0].r.lo == 0 && got[0].r.hi == 0);
  CHECK(got[1].r.lo == 0.5 && got[1].r.hi == 0.5);
  CHECK(got[2].r.lo == 1 && got[2].r.hi == 1);
  for (const roots::RootInterval& g : got) CHECK_EQ(g.changes, 1);
  got = roots::bernstein({2, 2, 2}, 1e-10, st);
  CHECK(st == Status::ok);
  CHECK(got.empty());
  got = roots::bernstein({-3}, 1e-10, st);
  CHECK(st == Status::ok);
  CHECK(got.empty());
}

TEST_CASE("roots::bernstein: multiple and clustered roots are one interval, with noConvergence") {
  Status st;
  std::vector<roots::RootInterval> got = roots::bernstein(bernsteinFromRoots({1.0 / 3, 1.0 / 3}), 1e-9, st);
  CHECK(st == Status::noConvergence);
  REQUIRE(!got.empty());
  bool covered = false;
  for (const roots::RootInterval& g : got) covered = covered || (g.r.lo <= 1.0 / 3 && 1.0 / 3 <= g.r.hi);
  CHECK(covered);
  for (const roots::RootInterval& g : got) CHECK(g.r.hi - g.r.lo <= 1e-9);
  CHECK(std::any_of(got.begin(), got.end(), [](const roots::RootInterval& g) { return g.changes >= 2; }));
  // A double root on a split point and at an end.
  got = roots::bernstein(bernsteinFromRoots({0.5, 0.5}), 1e-9, st);
  CHECK(st == Status::noConvergence);
  REQUIRE(got.size() == 1);
  CHECK(got[0].r.lo == 0.5 && got[0].r.hi == 0.5 && got[0].changes == 2);
  got = roots::bernstein(bernsteinFromRoots({0, 0, 0.7}), 1e-9, st);
  CHECK(st == Status::noConvergence);
  REQUIRE(got.size() == 2);
  CHECK(got[0].r.lo == 0 && got[0].changes == 2 && got[1].changes == 1);
  got = roots::bernstein({-1, 1, 0, 0}, 1e-9, st);  // (1 - t)^2 (4 t - 1): exactly, a double root at 1
  CHECK(st == Status::noConvergence);
  REQUIRE(got.size() == 2);
  CHECK(got[0].changes == 1 && got[1].r.lo == 1 && got[1].changes == 2);
  // Two roots 1e-4 apart: separated at tol 1e-6, one interval at tol 1e-3.
  got = roots::bernstein(bernsteinFromRoots({0.4, 0.4001}), 1e-6, st);
  CHECK(st == Status::ok);
  CHECK_EQ(got.size(), 2u);
  CHECK(got[0].changes == 1 && got[1].changes == 1);
  got = roots::bernstein(bernsteinFromRoots({0.4, 0.4001}), 1e-3, st);
  CHECK(st == Status::noConvergence);
  REQUIRE(got.size() == 1);
  CHECK_EQ(got[0].changes, 2);
  CHECK(got[0].r.lo <= 0.4 && 0.4001 <= got[0].r.hi);
}

TEST_CASE("roots::bernstein: random polynomials, every root found once, every interval a sign change") {
  Rng r{7};
  for (int trial = 0; trial < 300; trial++) {
    int n = 1 + r.below(8);
    std::vector<double> want;
    while (static_cast<int>(want.size()) < n) {
      double x = r.uniform(0.01, 0.99);
      bool apart = true;
      for (double y : want) apart = apart && std::fabs(x - y) > 0.02;
      if (apart) want.push_back(x);
    }
    std::sort(want.begin(), want.end());
    std::vector<double> b = bernsteinFromRoots(want, r.uniform(0.5, 4) * (r.below(2) ? 1 : -1));
    Status st;
    std::vector<roots::RootInterval> got = roots::bernstein(b, 1e-10, st);
    CHECK(st == Status::ok);
    REQUIRE(got.size() == want.size());
    // What the isolation guarantees is about the polynomial it's given (its coefficients rounded): a sign change
    // in each interval. The exact roots move with the rounding by up to its conditioning, well under 1e-6 here.
    for (size_t i = 0; i < want.size(); i++) {
      CHECK(deCasteljau(b, got[i].r.lo) * deCasteljau(b, got[i].r.hi) <= 0);
      CHECK(std::fabs(0.5 * (got[i].r.lo + got[i].r.hi) - want[i]) <= 1e-6);
      CHECK(got[i].r.hi - got[i].r.lo <= 1e-10);
      CHECK_EQ(got[i].changes, 1);
      if (i > 0) CHECK(got[i - 1].r.hi <= got[i].r.lo);
    }
  }
}

TEST_CASE("roots::bernstein: what it refuses") {
  Status st;
  CHECK(roots::bernstein({0, 0, 0}, 1e-10, st).empty());
  CHECK(st == Status::singular);
  CHECK(roots::bernstein({}, 1e-10, st).empty());
  CHECK(st == Status::invalidModel);
  CHECK(roots::bernstein({1, -1}, 0, st).empty());
  CHECK(st == Status::invalidModel);
  CHECK(roots::bernstein({1, NAN}, 1e-10, st).empty());
  CHECK(st == Status::invalidModel);
}

// ---- Fitting ----

namespace {
/** The fit's error at many points, independently of its own checks. */
double denseError(const BSpline& c, const std::function<Vec2(double)>& f, Range r, int count = 20000) {
  double worst = 0;
  for (int i = 0; i <= count; i++) {
    double t = r.lo + (r.hi - r.lo) * i / count, v[2];
    bspline::eval(c, t, 0, v);
    Vec2 q = f(t);
    worst = std::max(worst, std::hypot(v[0] - q.x, v[1] - q.y));
  }
  return worst;
}
} // namespace

TEST_CASE("fit::curve2: polynomials of the degree are one span, exact; ends interpolated") {
  for (int p = 1; p <= 4; p++) {
    auto f = [p](double t) { return Vec2{std::pow(t, p) - 2 * t, 3 + t * t * (p >= 2)}; };
    BSpline c;
    double err;
    REQUIRE(fit::curve2(f, {-1, 2}, p, 1e-9, c, err) == Status::ok);
    CHECK_EQ(c.poleCount(), p + 1);
    CHECK(err <= 1e-9);
    CHECK(denseError(c, f, {-1, 2}) <= 1e-12);
    double v[2];
    bspline::eval(c, -1, 0, v);
    CHECK_EQ(v[0], f(-1).x);
    bspline::eval(c, 2, 0, v);
    CHECK_EQ(v[1], f(2).y);
  }
}

TEST_CASE("fit::curve2: smooth, kinked and fast curves within tol everywhere, the reported error honest") {
  struct Case {
    const char* name;
    std::function<Vec2(double)> f;
    Range r;
    int degree;
    double tol;
  };
  const Case cases[] = {
    {"half circle", [](double t) { return Vec2{std::cos(t), std::sin(t)}; }, {0, 3.14159}, 3, 1e-7},
    {"kink", [](double t) { return Vec2{t, std::fabs(t - 0.3)}; }, {0, 1}, 2, 1e-5},
    {"spiral", [](double t) { return Vec2{t * std::cos(20 * t), t * std::sin(20 * t)}; }, {0, 1}, 3, 1e-6},
    {"far", [](double t) { return Vec2{1e6 + std::cos(t), -1e6 + std::sin(t)}; }, {0, 1.5}, 3, 1e-6},
    {"degree 1", [](double t) { return Vec2{t, t * t}; }, {0, 1}, 1, 1e-4},
  };
  for (const Case& c : cases) {
    BSpline out;
    double err;
    Status st = fit::curve2(c.f, c.r, c.degree, c.tol, out, err);
    if (st != Status::ok) check::fail(__FILE__, __LINE__, std::string(c.name) + ": not ok");
    CHECK(err <= c.tol);
    double dense = denseError(out, c.f, c.r);
    if (!(dense <= c.tol)) check::fail(__FILE__, __LINE__, std::string(c.name) + ": dense error "
      + check::show(dense) + " above tol");
    // The reported error is the largest there is (the local search), but for rounding in the errors themselves:
    // 4 ulp of the curve's size (the "far" case's coordinates are 1e6).
    Vec2 mid = c.f(0.5 * (c.r.lo + c.r.hi));
    double size = std::max(std::fabs(mid.x), std::fabs(mid.y));
    CHECK(dense <= err * (1 + 1e-6) + 4 * (std::nextafter(size, INFINITY) - size));
    CHECK_EQ(out.dim, 2);
    CHECK_EQ(out.knots.front(), c.r.lo);
    CHECK_EQ(out.knots.back(), c.r.hi);
  }
}

TEST_CASE("fit::curve2: a jump stops halving at 2^-30 of the range, not at rounding; a smooth fit to 1e-9 converges") {
  BSpline c;
  double err;
  // A step at a third of the range (not a halving's point; the range 1000 wide, so the limit is relative): its span
  // stays past any tolerance below the step, halved each round until narrower than 2^-30 of the range, then
  // noConvergence (each round halves it once: about 30 rounds, not 50 or so).
  const long before = fit::curve2Rounds;
  CHECK(fit::curve2([](double t) { return Vec2{t < 1000.0 / 3 ? 0.0 : 1.0, t}; }, {0, 1000}, 3, 1e-3, c, err)
    == Status::noConvergence);
  const long rounds = fit::curve2Rounds - before;
  CHECK(rounds >= 30);
  CHECK(rounds <= 33);
  CHECK(std::isfinite(err));
  // A smooth function fitted to 1e-9 needs spans far wider than that: it converges.
  CHECK(fit::curve2([](double t) { return Vec2{std::sin(3 * t), std::exp(t)}; }, {0, 3}, 3, 1e-9, c, err)
    == Status::ok);
  CHECK(err <= 1e-9);
}

TEST_CASE("fit::curve2: noConvergence below rounding, singular on non-finite values, refused arguments") {
  BSpline c;
  double err;
  CHECK(fit::curve2([](double t) { return Vec2{std::cos(40 * t), t}; }, {0, 1}, 2, 1e-17, c, err)
    == Status::noConvergence);
  CHECK(err > 1e-17);
  CHECK(std::isfinite(err));
  CHECK(fit::curve2([](double t) { return Vec2{1 / (t - 0.5), t}; }, {0, 1}, 3, 1e-6, c, err) == Status::singular);
  CHECK(fit::curve2([](double t) { return Vec2{t, t}; }, {1, 0}, 3, 1e-6, c, err) == Status::invalidModel);
  CHECK(fit::curve2([](double t) { return Vec2{t, t}; }, {0, 1}, 0, 1e-6, c, err) == Status::invalidModel);
  CHECK(fit::curve2([](double t) { return Vec2{t, t}; }, {0, 1}, 3, 0, c, err) == Status::invalidModel);
  CHECK(fit::curve2([](double t) { return Vec2{t, t}; }, {0, INFINITY}, 3, 1e-6, c, err) == Status::invalidModel);
}
