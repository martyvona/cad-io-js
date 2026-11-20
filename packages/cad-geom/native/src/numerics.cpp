// numerics.h's B-spline basics: knot vectors, span search and the basis with its derivatives (Piegl and Tiller, "The
// NURBS Book", 2nd ed., algorithms A2.1, A2.2, A2.3), and evaluation with derivatives to second order (A3.2 in
// homogeneous form, rational derivatives by the quotient rule, eq. 4.8), relative to each span's pole centroid. The
// toolkit (A5.1, A5.6, A5.9) is numerics_toolkit.cpp; quadrature, roots and fitting have their own files.
#include "cad_geom/numerics.h"

#include <algorithm>
#include <cmath>

#include "scratch.h"

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
  int lo = degree, hi = n;
  while (hi - lo > 1) {
    int mid = (lo + hi) / 2;
    if (t < U[mid]) hi = mid; else lo = mid;
  }
  return lo;
}

void basis(int i, double t, int p, const std::vector<double>& U, double* N) {
  Scratch<double, kStackDegree + 1> left(p + 1), right(p + 1);
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
  // (Allocation-free up to kStackDegree: this is evaluation's hot path.)
  Scratch<double, (kStackDegree + 1) * (kStackDegree + 1)> ndu((p + 1) * (p + 1));
  Scratch<double, kStackDegree + 1> left(p + 1), right(p + 1);
  Scratch<double, 2 * (kStackDegree + 1)> a(2 * (p + 1));
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
  if (d < 1 || d > 3 || p < 1 || n < p + 1 || static_cast<int>(c.knots.size()) != n + p + 1 || order < 0 || order > 2)
    return Status::invalidModel;
  Status status = Status::ok;
  if (t < c.knots[p] || t > c.knots[n]) {
    status = Status::outOfDomain;
    t = std::clamp(t, c.knots[p], c.knots[n]);
  }
  int span = findSpan(p, c.knots, n, t);
  Scratch<double, 3 * (kStackDegree + 1)> ders((order + 1) * (p + 1));
  basisDerivs(span, t, p, order, c.knots, ders.data());
  // Poles relative to the span's centroid o, added back to the point once at the end: the derivatives never see
  // large coordinates (a curve near 1e6 loses 1e-10 of its speed to cancellation otherwise).
  double o[3] = {};
  for (int j = 0; j <= p; j++)
    for (int a = 0; a < d; a++) o[a] += c.poles[(span - p + j) * w + a] / (p + 1);
  // Homogeneous derivatives A^(k) (coordinates times weight) and w^(k).
  double A[3][4] = {}, W[3] = {};
  for (int k = 0; k <= order; k++)
    for (int j = 0; j <= p; j++) {
      const double* P = c.poles.data() + (span - p + j) * w;
      double wt = c.rational ? P[d] : 1.0, N = ders[k * (p + 1) + j];
      for (int a = 0; a < d; a++) A[k][a] += N * wt * (P[a] - o[a]);
      W[k] += N * wt;
    }
  // C = A / w; C' = (A' - w' C) / w; C'' = (A'' - 2 w' C' - w'' C) / w, all relative to o.
  for (int a = 0; a < d; a++) {
    double C0 = A[0][a] / W[0];
    out[a] = C0 + o[a];
    if (order >= 1) out[d + a] = (A[1][a] - W[1] * C0) / W[0];
    if (order >= 2) out[2 * d + a] = (A[2][a] - 2 * W[1] * out[d + a] - W[2] * C0) / W[0];
  }
  return status;
}

} // namespace bspline

} // namespace cadgeom
