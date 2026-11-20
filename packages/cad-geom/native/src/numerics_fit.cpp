// numerics.h's 2D fitting: a least-squares B-spline (Piegl and Tiller, "The NURBS Book", 2nd ed., section 9.4.1, with
// the ends interpolated so a fitted p-curve meets its vertices exactly) on breakpoints that adapt: every span whose
// error exceeds tol is halved and the whole fit solved again, until each span is within tol or the spans run out.
// The fit keeps f's parameter (knots in r's units), so a p-curve's parameter stays its 3D curve's.
// The error is measured, not bounded: f is a black box, so no bound can hold without bounds on its derivatives. Each
// span is checked at CHECKS points, uniformly spaced including its ends, then a golden-section search refines the
// worst of them between its neighbours; a feature narrower than the spacing between checks (h / (CHECKS - 1)) can
// still hide. maxError is the largest error found.
#include <algorithm>
#include <cmath>
#include <limits>

#include <Eigen/Dense>

#include "cad_geom/numerics.h"

namespace cadgeom {
namespace fit {

namespace {

constexpr int CHECKS = 33;       // error checks per span
constexpr int MAX_SPANS = 1024;  // then noConvergence

struct Fitter {
  const std::function<Vec2(double)>& f;
  int p;
  const std::function<double(Vec2, Vec2)>* measure = nullptr;  // the caller's error, else the (u, v) distance
  bool finite = true;

  Vec2 at(double t) {
    Vec2 v = f(t);
    finite = finite && std::isfinite(v.x) && std::isfinite(v.y);
    return v;
  }

  /** The least-squares spline on these breakpoints (r's ends first and last), the ends interpolated. */
  BSpline solve(const std::vector<double>& br) {
    BSpline c;
    c.degree = p;
    c.dim = 2;
    c.knots.assign(p, br.front());
    c.knots.insert(c.knots.end(), br.begin(), br.end());
    c.knots.insert(c.knots.end(), p, br.back());
    const int spans = static_cast<int>(br.size()) - 1, n = spans + p;
    Vec2 first = at(br.front()), last = at(br.back());
    c.poles.assign(2 * n, 0.0);
    c.poles[0] = first.x, c.poles[1] = first.y;
    c.poles[2 * n - 2] = last.x, c.poles[2 * n - 1] = last.y;
    const int free = n - 2;
    if (free <= 0) return c;
    // Normal equations for the free poles over 2 (p + 1) samples per span, inside it.
    Eigen::MatrixXd A = Eigen::MatrixXd::Zero(free, free);
    Eigen::MatrixXd rhs = Eigen::MatrixXd::Zero(free, 2);
    std::vector<double> N(p + 1);
    const int per = 2 * (p + 1);
    for (int s = 0; s < spans; s++)
      for (int k = 0; k < per; k++) {
        double t = br[s] + (br[s + 1] - br[s]) * (k + 0.5) / per;
        int span = bspline::findSpan(p, c.knots, n, t);
        bspline::basis(span, t, p, c.knots, N.data());
        Vec2 q = at(t);
        // The fixed end poles' share moved to the right-hand side.
        for (int j = 0; j <= p; j++) {
          int i = span - p + j;
          if (i == 0) q = q - N[j] * first;
          if (i == n - 1) q = q - N[j] * last;
        }
        for (int j = 0; j <= p; j++) {
          int i = span - p + j - 1;  // index among the free poles
          if (i < 0 || i >= free) continue;
          rhs(i, 0) += N[j] * q.x;
          rhs(i, 1) += N[j] * q.y;
          for (int l = 0; l <= p; l++) {
            int k2 = span - p + l - 1;
            if (k2 >= 0 && k2 < free) A(i, k2) += N[j] * N[l];
          }
        }
      }
    Eigen::MatrixXd x = A.ldlt().solve(rhs);
    for (int i = 0; i < free; i++) c.poles[2 * (i + 1)] = x(i, 0), c.poles[2 * (i + 1) + 1] = x(i, 1);
    return c;
  }

  double error(const BSpline& c, double t) {
    double v[2];
    bspline::eval(c, t, 0, v);
    Vec2 q = at(t);
    return measure && *measure ? (*measure)(Vec2{v[0], v[1]}, q) : std::hypot(v[0] - q.x, v[1] - q.y);
  }

  /** The largest error found on [a, b]: the checks, then golden-section search around the worst. */
  double spanError(const BSpline& c, double a, double b) {
    double worst = -1, h = (b - a) / (CHECKS - 1);
    int best = 0;
    for (int k = 0; k < CHECKS; k++) {
      double e = error(c, k + 1 == CHECKS ? b : a + k * h);
      if (e > worst) worst = e, best = k;
    }
    double lo = std::max(a, a + (best - 1) * h), hi = std::min(b, a + (best + 1) * h);
    const double g = 0.5 * (std::sqrt(5.0) - 1);
    double x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), e1 = error(c, x1), e2 = error(c, x2);
    for (int it = 0; it < 30; it++) {
      if (e1 > e2) {
        hi = x2, x2 = x1, e2 = e1, x1 = hi - g * (hi - lo), e1 = error(c, x1);
      } else {
        lo = x1, x1 = x2, e1 = e2, x2 = lo + g * (hi - lo), e2 = error(c, x2);
      }
      worst = std::max({worst, e1, e2});
    }
    return worst;
  }
};

} // namespace

long curve2Rounds = 0;

Status curve2(const std::function<Vec2(double)>& f, Range r, int degree, double tol, BSpline& out, double& maxError) {
  return curve2(f, r, degree, tol, out, maxError, {});
}

Status curve2(const std::function<Vec2(double)>& f, Range r, int degree, double tol, BSpline& out, double& maxError,
  const std::function<double(Vec2, Vec2)>& error) {
  maxError = std::numeric_limits<double>::infinity();
  if (!(degree >= 1 && degree <= 9) || !(tol > 0) || !std::isfinite(r.lo) || !std::isfinite(r.hi) || !(r.lo < r.hi))
    return Status::invalidModel;
  Fitter fit{f, degree, &error};
  std::vector<double> br{r.lo, r.hi};
  while (true) {
    curve2Rounds++;
    BSpline c = fit.solve(br);
    std::vector<double> next{br.front()};
    double worst = 0;
    for (size_t s = 0; s + 1 < br.size(); s++) {
      double e = fit.spanError(c, br[s], br[s + 1]);
      worst = std::max(worst, e);
      if (e > tol) next.push_back(0.5 * (br[s] + br[s + 1]));
      next.push_back(br[s + 1]);
    }
    if (!fit.finite) return Status::singular;
    out = std::move(c);
    maxError = worst;
    if (worst <= tol) return Status::ok;
    // Halving stops where the spans are too many, or too narrow to halve in floating point.
    bool narrow = false;
    for (size_t s = 0; s + 1 < next.size(); s++) narrow = narrow || !(next[s] < next[s + 1]);
    if (static_cast<int>(next.size()) - 1 > MAX_SPANS || narrow) return Status::noConvergence;
    br = std::move(next);
  }
}

} // namespace fit
} // namespace cadgeom
