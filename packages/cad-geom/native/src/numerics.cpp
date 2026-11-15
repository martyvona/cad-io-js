// numerics.h, the reference version: the B-spline basis and evaluation (Piegl and Tiller, "The NURBS Book", 2nd ed.,
// algorithms A2.1, A2.2, A2.3; rational derivatives by the quotient rule, eq. 4.8), adaptive Simpson quadrature with
// Richardson's error estimate. Knot insertion, Bezier extraction, degree elevation, root isolation and fitting are
// unsupported here.
#include "cad_geom/numerics.h"

#include <algorithm>
#include <cmath>

namespace cadgeom {
namespace bspline {

std::vector<double> fullKnots(const double* knots, const int32_t* mults, int count) {
  std::vector<double> out;
  for (int i = 0; i < count; i++)
    for (int k = 0; k < mults[i]; k++) out.push_back(knots[i]);
  return out;
}

int findSpan(int degree, const std::vector<double>& U, int n, double t) {
  if (t >= U[n]) {
    int i = n - 1;
    while (i > degree && U[i] == U[i + 1]) i--;
    return i;
  }
  if (t <= U[degree]) return degree;
  int lo = degree, hi = n;
  while (hi - lo > 1) {
    int mid = (lo + hi) / 2;
    if (t < U[mid]) hi = mid; else lo = mid;
  }
  return lo;
}

void basis(int i, double t, int p, const std::vector<double>& U, double* N) {
  std::vector<double> left(p + 1), right(p + 1);
  N[0] = 1;
  for (int j = 1; j <= p; j++) {
    left[j] = t - U[i + 1 - j];
    right[j] = U[i + j] - t;
    double saved = 0;
    for (int r = 0; r < j; r++) {
      double tmp = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    N[j] = saved;
  }
}

void basisDerivs(int i, double t, int p, int n, const std::vector<double>& U, double* ders) {
  std::vector<double> ndu((p + 1) * (p + 1)), left(p + 1), right(p + 1), a(2 * (p + 1));
  auto NDU = [&](int r, int c) -> double& { return ndu[r * (p + 1) + c]; };
  NDU(0, 0) = 1;
  for (int j = 1; j <= p; j++) {
    left[j] = t - U[i + 1 - j];
    right[j] = U[i + j] - t;
    double saved = 0;
    for (int r = 0; r < j; r++) {
      NDU(j, r) = right[r + 1] + left[j - r];
      double tmp = NDU(r, j - 1) / NDU(j, r);
      NDU(r, j) = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    NDU(j, j) = saved;
  }
  for (int k = 0; k <= n; k++)
    for (int j = 0; j <= p; j++) ders[k * (p + 1) + j] = k == 0 ? NDU(j, p) : 0;
  for (int r = 0; r <= p; r++) {
    double* a0 = a.data();
    double* a1 = a.data() + (p + 1);
    a0[0] = 1;
    for (int k = 1; k <= n && k <= p; k++) {
      double d = 0;
      int rk = r - k, pk = p - k;
      if (r >= k) {
        a1[0] = a0[0] / NDU(pk + 1, rk);
        d = a1[0] * NDU(rk, pk);
      }
      int j1 = rk >= -1 ? 1 : -rk, j2 = (r - 1 <= pk) ? k - 1 : p - r;
      for (int j = j1; j <= j2; j++) {
        a1[j] = (a0[j] - a0[j - 1]) / NDU(pk + 1, rk + j);
        d += a1[j] * NDU(rk + j, pk);
      }
      if (r <= pk) {
        a1[k] = -a0[k - 1] / NDU(pk + 1, r);
        d += a1[k] * NDU(r, pk);
      }
      ders[k * (p + 1) + r] = d;
      std::swap(a0, a1);
    }
  }
  double f = p;
  for (int k = 1; k <= n; k++) {
    for (int j = 0; j <= p; j++) ders[k * (p + 1) + j] *= f;
    f *= p - k;
  }
}

Status eval(const BSpline& c, double t, int order, double* out) {
  int n = c.poleCount(), p = c.degree, d = c.dim, w = d + (c.rational ? 1 : 0);
  if (n < p + 1 || static_cast<int>(c.knots.size()) != n + p + 1 || order < 0 || order > 2) return Status::invalidModel;
  Status status = Status::ok;
  if (t < c.knots[p] || t > c.knots[n]) {
    status = Status::outOfDomain;
    t = std::clamp(t, c.knots[p], c.knots[n]);
  }
  int span = findSpan(p, c.knots, n, t);
  std::vector<double> ders((order + 1) * (p + 1));
  basisDerivs(span, t, p, order, c.knots, ders.data());
  // Homogeneous derivatives A^(k) (coordinates times weight) and w^(k).
  double A[3][4] = {}, W[3] = {};
  for (int k = 0; k <= order; k++)
    for (int j = 0; j <= p; j++) {
      const double* P = c.poles.data() + (span - p + j) * w;
      double wt = c.rational ? P[d] : 1.0, N = ders[k * (p + 1) + j];
      for (int a = 0; a < d; a++) A[k][a] += N * wt * P[a];
      W[k] += N * wt;
    }
  // C = A / w; C' = (A' - w' C) / w; C'' = (A'' - 2 w' C' - w'' C) / w.
  for (int a = 0; a < d; a++) {
    double C0 = A[0][a] / W[0];
    out[a] = C0;
    if (order >= 1) out[d + a] = (A[1][a] - W[1] * C0) / W[0];
    if (order >= 2) out[2 * d + a] = (A[2][a] - 2 * W[1] * out[d + a] - W[2] * C0) / W[0];
  }
  return status;
}

Status insertKnot(BSpline&, double, int) { return Status::unsupported; }
std::vector<BSpline> toBezier(const BSpline&) { return {}; }
Status elevateDegree(BSpline&, int) { return Status::unsupported; }

} // namespace bspline

namespace quadrature {

namespace {
struct Simpson {
  const std::function<double(double)>& f;
  int evals = 0;
  int maxEval;
  double step(double a, double fa, double m, double fm, double b, double fb, double whole, double tol, int depth,
    double& err) {
    double lm = 0.5 * (a + m), rm = 0.5 * (m + b);
    double flm = f(lm), frm = f(rm);
    evals += 2;
    double left = (m - a) / 6 * (fa + 4 * flm + fm), right = (b - m) / 6 * (fm + 4 * frm + fb);
    double delta = left + right - whole;
    if (depth <= 0 || evals >= maxEval || std::fabs(delta) <= 15 * tol) {
      err += std::fabs(delta) / 15;
      return left + right + delta / 15;
    }
    return step(a, fa, lm, flm, m, fm, left, tol / 2, depth - 1, err)
      + step(m, fm, rm, frm, b, fb, right, tol / 2, depth - 1, err);
  }
};
} // namespace

Estimate integrate(const std::function<double(double)>& f, double a, double b, double absTol, double relTol,
  int maxEval) {
  Simpson s{f, 3, maxEval};
  double fa = f(a), fb = f(b), m = 0.5 * (a + b), fm = f(m);
  double whole = (b - a) / 6 * (fa + 4 * fm + fb);
  double tol = std::max(absTol, relTol * std::fabs(whole));
  double err = 0;
  double value = s.step(a, fa, m, fm, b, fb, whole, tol, 50, err);
  bool reached = err <= std::max(absTol, relTol * std::fabs(value)) && s.evals < maxEval;
  return {value, err, reached ? Status::ok : Status::noConvergence};
}

} // namespace quadrature

namespace roots {
std::vector<Range> bernstein(const std::vector<double>&, double, Status& status) {
  status = Status::unsupported;
  return {};
}
} // namespace roots

namespace fit {
Status curve2(const std::function<Vec2(double)>&, Range, int, double, BSpline&, double&) { return Status::unsupported; }
} // namespace fit

} // namespace cadgeom
