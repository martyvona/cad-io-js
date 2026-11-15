// The numerics the other pieces call: the B-spline toolkit (Piegl and Tiller's algorithms), quadrature with error
// estimates, polynomial root isolation in Bernstein form, and 2D fitting with error control.
#pragma once

#include <cstdint>
#include <functional>
#include <vector>

#include "result.h"
#include "vec.h"

namespace cadgeom {

/**
 * A B-spline curve in working form: degree, dimension, the full knot vector (each knot repeated by its multiplicity:
 * n + degree + 1 entries for n poles), and poles as n rows of `dim` coordinates, followed by the weight when rational
 * (so a rational curve's rows are dim + 1 wide; the coordinates are not premultiplied by the weight). A curve's poles
 * are its precision: near coordinates of size X a k-th derivative is known to about ulp(X) (degree / shortest span)^k.
 * eval loses nothing beyond that (it works relative to the span's pole centroid), nor does the toolkit (relative to
 * the first pole), but a toolkit result stores its poles once more, so a far curve's derivatives after insertKnot or
 * elevateDegree can differ from the original's by up to 2 ulp(X) (degree / shortest span)^k.
 */
struct BSpline {
  int degree = 1;
  int dim = 3;
  bool rational = false;
  std::vector<double> knots;
  std::vector<double> poles;
  int poleCount() const { return static_cast<int>(poles.size()) / (dim + (rational ? 1 : 0)); }
};

namespace bspline {
/** The full knot vector from distinct knots and their multiplicities (the model's form). */
std::vector<double> fullKnots(const double* knots, const int32_t* mults, int count);
/** The span index i with knots[i] <= t < knots[i + 1] (the last nonempty span at the range's end). */
int findSpan(int degree, const std::vector<double>& knots, int poleCount, double t);
/** The degree + 1 nonzero basis functions at t in span i into N. */
void basis(int span, double t, int degree, const std::vector<double>& knots, double* N);
/** Their derivatives up to order n: ders[k * (degree + 1) + j] is the k-th derivative of N_{span - degree + j}. */
void basisDerivs(int span, double t, int degree, int n, const std::vector<double>& knots, double* ders);
/** The point and derivatives up to order (<= 2) at t, rational or not, into out[0..order] (dim coordinates each). */
Status eval(const BSpline& c, double t, int order, double* out);
/** Knot t inserted `times` times (Boehm): the same curve. */
Status insertKnot(BSpline& c, double t, int times);
/** The curve as Bezier pieces, one per nonempty knot span, in order. */
std::vector<BSpline> toBezier(const BSpline& c);
/** The degree raised by `by`: the same curve. */
Status elevateDegree(BSpline& c, int by);
} // namespace bspline

namespace quadrature {
/**
 * The integral of f over [a, b] by adaptive Gauss-Kronrod, until the estimated error is below max(absTol, relTol *
 * |integral|) or maxEval evaluations; status noConvergence when not reached (the best estimate kept).
 */
Estimate integrate(const std::function<double(double)>& f, double a, double b, double absTol, double relTol,
  int maxEval = 100000);
} // namespace quadrature

namespace roots {
/**
 * An interval that may hold roots: `changes` the sign changes left in it (Descartes' bound on its root count, with
 * multiplicity): 1 a simple root isolated, more where roots couldn't be separated within the tolerance.
 */
struct RootInterval {
  Range r;
  int changes = 1;
};
/**
 * The real roots in [0, 1] of the polynomial with these Bernstein coefficients, each in an interval of width at most
 * tol (Descartes' rule of signs and de Casteljau subdivision), sorted; Status::noConvergence where some interval
 * holds roots it couldn't separate (its `changes` above 1); a polynomial identically zero gives Status::singular.
 */
std::vector<RootInterval> bernstein(const std::vector<double>& coeffs, double tol, Status& status);
} // namespace roots

namespace fit {
/**
 * A 2D B-spline of the given degree approximating f over r within tol everywhere on r (the error measured between
 * samples too, not only at them), with as few spans as that needs; maxError the error estimated over r.
 */
Status curve2(const std::function<Vec2(double)>& f, Range r, int degree, double tol, BSpline& out, double& maxError);
} // namespace fit

} // namespace cadgeom
