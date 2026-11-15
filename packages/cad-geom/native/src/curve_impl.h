// What every curve kind of curve*.cpp implements beyond curve.h's interface: derivatives to any order the kinds need
// (an offset's derivative of order k takes its basis's of order k + 1), boxes of derivatives (an offset bounds its
// unit normal by its basis's tangent box), and a finite parameter range holding every point near a given one (so
// inversion on an infinite curve searches a finite range). Private to curve*.cpp: makeCurve builds only these.
#pragma once

#include <cmath>
#include <limits>
#include <memory>
#include <vector>

#include "cad_geom/curve.h"
#include "cad_geom/model.h"

namespace cadgeom {
namespace curves {

/**
 * The highest derivative order derivs() takes: eval's 2 and bounds' 3 (a centred box of order 2 takes the bound of
 * order 3), plus one per offset nested (each takes its basis's order k + 1).
 */
constexpr int kMaxOrder = 6;
constexpr double kEps = std::numeric_limits<double>::epsilon();
const double kInf = std::numeric_limits<double>::infinity();
constexpr double kTwoPi = 6.283185307179586;

class CurveImpl : public Curve {
public:
  /**
   * C(t) and its derivatives up to `order` (0 to kMaxOrder) into out[0..order]; statuses as Curve::eval (a periodic
   * curve takes any t; outside the domain otherwise, outOfDomain with the clamped t's values).
   */
  virtual Status derivs(double t, int order, Vec3* out) const = 0;
  /** An upper bound on |C^(order)(t)| over r, order 1 to kMaxOrder (infinite with a status where none is known). */
  virtual Status derivBoundN(Range r, int order, double& out) const = 0;
  /** A box holding C^(order)(t) for every t in r, order 0 (the curve itself) to kMaxOrder - 1. */
  virtual Status derivBox(Range r, int order, Box3& out) const = 0;
  /**
   * A parameter range certain to hold every t in the domain with |C(t) - p| <= d (the domain where that's finite;
   * infinite kinds bound it in closed form).
   */
  virtual Range within(Vec3 p, double d) const {
    (void)p, (void)d;
    return domain().range;
  }
  /**
   * Where a closed form gives every local minimum of |C(t) - p| over r (circles): their parameters into `out`, and
   * true; else false, and inversion searches. A continuum of feet (a point on a circle's axis) is sampled.
   */
  virtual bool footCandidates(Vec3 p, Range r, double tol, std::vector<double>& out) const {
    (void)p, (void)r, (void)tol, (void)out;
    return false;
  }
  /** The length over [t0, t1] where it has a closed form (lines, circles, polylines), else false. */
  virtual bool exactLength(double t0, double t1, double& out) const {
    (void)t0, (void)t1, (void)out;
    return false;
  }

  Status eval(double t, int order, CurvePoint& out) const final;
  Status bound(Range r, Box3& out) const final { return derivBox(r, 0, out); }
  Status derivBound(Range r, int order, double& out) const final;
};

/** The curve at a row, `depth` the references followed to reach it (a cycle stops at a limit: invalidModel). */
std::unique_ptr<CurveImpl> make(const Model& m, int row, int depth, Status& status);

std::unique_ptr<CurveImpl> makeLine(const double* r, int dim);
/** Circles (a = b) and ellipses. */
std::unique_ptr<CurveImpl> makeEllipse(const double* r, int dim, double a, double b);
std::unique_ptr<CurveImpl> makeHyperbola(const double* r, int dim);
std::unique_ptr<CurveImpl> makeParabola(const double* r, int dim);
/** From the model's row (its pools checked by the caller against the counts it reads). */
std::unique_ptr<CurveImpl> makeBSpline(const double* r, const int32_t* in, int dim, Status& status);
std::unique_ptr<CurveImpl> makePolyline(const double* r, int n, int dim);
std::unique_ptr<CurveImpl> makeTrimmed(std::unique_ptr<CurveImpl> basis, const double* r, int sense, int master,
  Status& status);
struct Segment {
  std::unique_ptr<CurveImpl> curve;
  bool sameSense;
};
std::unique_ptr<CurveImpl> makeComposite(std::vector<Segment> segments, Status& status);
std::unique_ptr<CurveImpl> makeOffset(std::unique_ptr<CurveImpl> basis, double distance, Vec3 ref);

// Shared helpers.

inline Vec3 readVec(const double* r, int dim) { return {r[0], r[1], dim == 3 ? r[2] : 0.0}; }
inline bool finite(Range r) { return std::isfinite(r.lo) && std::isfinite(r.hi); }
inline double maxAbs(Vec3 v) { return std::fmax(std::fabs(v.x), std::fmax(std::fabs(v.y), std::fabs(v.z))); }
/** The binomial coefficient, n <= kMaxOrder + 1. */
inline double binom(int n, int k) {
  double b = 1;
  for (int i = 1; i <= k; i++) b = b * (n - k + i) / i;
  return b;
}
inline Interval widen(Interval a, double by) { return {a.lo - by, a.hi + by}; }
inline Box3 widen(Box3 b, double by) { return {widen(b.x, by), widen(b.y, by), widen(b.z, by)}; }
inline Box3 pointBox(Vec3 p) { return {Interval::point(p.x), Interval::point(p.y), Interval::point(p.z)}; }
inline Box3 hull(Box3 a, Box3 b) {
  auto h = [](Interval x, Interval y) { return Interval{std::fmin(x.lo, y.lo), std::fmax(x.hi, y.hi)}; };
  return {h(a.x, b.x), h(a.y, b.y), h(a.z, b.z)};
}
inline Box3 hull(Box3 a, Vec3 p) { return hull(a, pointBox(p)); }
inline Box3 emptyBox() { return {{kInf, -kInf}, {kInf, -kInf}, {kInf, -kInf}}; }
inline Box3 entireBox() { return {Interval::entire(), Interval::entire(), Interval::entire()}; }
/** The box of the ball of radius r about c. */
inline Box3 ballBox(Vec3 c, double r) { return widen(pointBox(c), r); }
/** a intersected with b (each holding the same set: the result holds it too). */
inline Box3 meet(Box3 a, Box3 b) {
  auto m = [](Interval x, Interval y) { return Interval{std::fmax(x.lo, y.lo), std::fmin(x.hi, y.hi)}; };
  return {m(a.x, b.x), m(a.y, b.y), m(a.z, b.z)};
}
/** The largest coordinate magnitude in the box: with its norm bound below. */
inline double boxMag(const Box3& b) { return std::fmax(b.x.mag(), std::fmax(b.y.mag(), b.z.mag())); }
/** An upper bound on |v| for v in the box. */
inline double boxNorm(const Box3& b) {
  double x = b.x.mag(), y = b.y.mag(), z = b.z.mag();
  return std::sqrt(x * x + y * y + z * z) * (1 + 4 * kEps);
}
/** A lower bound on |v| for v in the box: its distance from the origin (0 when it holds it). */
inline double boxMinNorm(const Box3& b) {
  auto m = [](Interval x) { return x.lo > 0 ? x.lo : x.hi < 0 ? -x.hi : 0.0; };
  double x = m(b.x), y = m(b.y), z = m(b.z);
  return std::sqrt(x * x + y * y + z * z) * (1 - 4 * kEps);
}
/** A lower bound on the distance from p to any point of the box. */
inline double boxDistance(const Box3& b, Vec3 p) {
  auto m = [](Interval x, double c) { return c < x.lo ? x.lo - c : c > x.hi ? c - x.hi : 0.0; };
  double x = m(b.x, p.x), y = m(b.y, p.y), z = m(b.z, p.z);
  return std::sqrt(x * x + y * y + z * z) * (1 - 4 * kEps);
}

/**
 * The centred form: every C^(k)(t) for t in r lies within |t - m| max |C^(k+1)| of C^(k)(m), m the middle (the mean
 * value theorem per coordinate), so the box shrinks with r where a hull of fixed size doesn't.
 */
Status centredBox(const CurveImpl& c, Range r, int order, Box3& out);

/**
 * Where on r (one smooth span) the speed vanishes, sorted: branch and bound on derivBox(r, 1), keeping the ranges
 * whose box holds the origin down to a width of 1e-12 of r's, each cluster of them reported by its middle. A speed
 * identically zero over a stretch is reported at its start.
 */
void speedZeros(const CurveImpl& c, Range r, std::vector<double>& out);

} // namespace curves
} // namespace cadgeom
