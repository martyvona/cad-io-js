// What every surface kind of surface*.cpp implements beyond surface.h's interface: partial derivatives to any order
// the kinds need (an offset's of order n take its basis's of order n + 1), boxes of each partial over a parameter
// rectangle (the bounds, inversion's pruning and convexity test), a finite parameter box holding every point near a
// given one (inversion over infinite ranges), and closed-form feet where a kind has them. Private to surface*.cpp:
// makeSurface builds only these.
#pragma once

#include <cmath>
#include <limits>
#include <memory>
#include <vector>

#include "cad_geom/model.h"
#include "cad_geom/surface.h"

namespace cadgeom {
namespace surfaces {

/** The highest total order derivs() gives: eval's 2, a box's centred form 3, one more per offset nested. */
constexpr int kMaxOrder = 6;
/** Partials S^(k,l) (k in u, l in v) of total order <= n are out[pidx(k, l)]: n = 0, then (1,0) (0,1), then ... */
constexpr int pidx(int k, int l) { return (k + l) * (k + l + 1) / 2 + l; }
constexpr int kPartials = pidx(0, kMaxOrder) + 1;
constexpr double kEps = std::numeric_limits<double>::epsilon();
const double kInf = std::numeric_limits<double>::infinity();
constexpr double kPi = 3.141592653589793;
constexpr double kTwoPi = 6.283185307179586;
constexpr double kHalfPi = 1.5707963267948966;

/** An iso-line of a surface: u = at (isoU), else v = at. */
struct IsoLine {
  bool isoU;
  double at;
};

class SurfaceImpl : public Surface {
public:
  /**
   * The iso-lines inside ru x rv (strictly) where the surface is only C0 by its form, so its normal can jump there: a
   * B-spline's knots of multiplicity at least its degree, an extrusion's or revolution's profile breaks; a wrapper's,
   * its basis's. Candidates only: tangent-continuous ones are among them (findCreases tests the normals).
   */
  virtual void c0Lines(Range, Range, std::vector<IsoLine>& out) const { out.clear(); }
  /**
   * S and its partials of total order <= `order` (0 to kMaxOrder) into out[pidx(k, l)]; periodic directions take any
   * value, others outside the domain give outOfDomain with the clamped values; singular where a kind's formula
   * breaks down there (an offset where its basis's normal vanishes: the basis's point then).
   */
  virtual Status derivs(double u, double v, int order, Vec3* out) const = 0;
  /** A box certainly holding S^(k,l) over ru x rv, k + l < kMaxOrder (infinite with a status where none is known). */
  virtual Status derivBox(Range ru, Range rv, int k, int l, Box3& out) const = 0;
  /**
   * Parameter ranges certain to hold every (u, v) of the domain with |S(u, v) - p| <= d (the domain where that's
   * finite; kinds with infinite parameters bound them in closed form).
   */
  virtual void within(Vec3 p, double d, Range& ru, Range& rv) const {
    (void)p, (void)d;
    SurfaceDomain dom = domain();
    ru = dom.u, rv = dom.v;
  }
  /**
   * Where a closed form gives every local minimum of |S - p| over ru x rv: their (u, v) into `out` (a continuum
   * sampled), and true; else false, and inversion searches.
   */
  virtual bool footCandidates(Vec3 p, Range ru, Range rv, double tol, std::vector<Vec2>& out) const {
    (void)p, (void)ru, (void)rv, (void)tol, (void)out;
    return false;
  }

  /**
   * Where p's feet form a curve in closed form (on an axis of revolution: a circle along u; at a torus's tube centre:
   * the tube's circle along v), its direction: 'u' or 'v'; else 0 (no curve, or none known).
   */
  virtual char footFamily(Vec3 p) const {
    (void)p;
    return 0;
  }

  /**
   * Whether inversion should choose a rectangle's split by its partials' boxes (an offset: beside its basis's pole
   * only a narrow u range bounds its normal) rather than by its sampled 3D extent (the rest: beside a pole a split
   * along the pole line only doubles the rectangles touching it).
   */
  virtual bool splitByBoxes() const { return false; }

  Status eval(double u, double v, int order, SurfacePoint& out) const final;
  Status normal(double u, double v, Vec3& out) const override;
  Status bound(Range ru, Range rv, Box3& out) const final { return derivBox(ru, rv, 0, 0, out); }
  Status derivBound(Range ru, Range rv, int order, double out[3]) const final;

  /** The rectangles between breaks() over u x v, row by row in u: each one's box and S at its middle. */
  struct SpanGrid {
    Range u, v;
    std::vector<double> us, vs;
    std::vector<Box3> box;           // derivBox(0, 0), where ok
    std::vector<unsigned char> ok;   // derivBox's status was ok
    std::vector<Vec3> mid;           // S at the rectangle's middle
  };
  /**
   * The grid over ru x rv, kept for the last ranges asked (inversion starts every point's search from it, on a
   * B-spline one rectangle per knot span: thousands of control-net boxes). Made lazily inside a const surface, so
   * not safe for threads sharing one surface.
   */
  const SpanGrid& spanGrid(Range ru, Range rv) const;

private:
  mutable std::unique_ptr<SpanGrid> grid_;
};

/** The rectangles invertSurface's searches have examined (taken from the queue, not pruned): for tests; never reset. */
extern long inversionRects;

/** The surface at a row, `depth` the references followed to reach it (a cycle stops at a limit: invalidModel). */
std::unique_ptr<SurfaceImpl> make(const Model& m, int row, int depth, Status& status);

std::unique_ptr<SurfaceImpl> makePlane(const double* r);
/** Cylinders (k = 0) and cones (k = tan of the semi-angle). */
std::unique_ptr<SurfaceImpl> makeCone(const double* r, double radius, double k);
std::unique_ptr<SurfaceImpl> makeSphere(const double* r);
std::unique_ptr<SurfaceImpl> makeTorus(const double* r);
std::unique_ptr<SurfaceImpl> makeBSpline(const double* r, const int32_t* in, Status& status);
std::unique_ptr<SurfaceImpl> makeExtrusion(const Model& m, int curve, const double* r, int depth, Status& status);
std::unique_ptr<SurfaceImpl> makeRevolution(const Model& m, int curve, const double* r, int depth, Status& status);
std::unique_ptr<SurfaceImpl> makeOffset(std::unique_ptr<SurfaceImpl> basis, double distance);
std::unique_ptr<SurfaceImpl> makeTrimmed(std::unique_ptr<SurfaceImpl> basis, const double* r, Status& status);

// Shared helpers.

inline Vec3 read3(const double* r) { return {r[0], r[1], r[2]}; }
inline bool finite(Range r) { return std::isfinite(r.lo) && std::isfinite(r.hi); }
inline double maxAbs(Vec3 v) { return maxNum(std::fabs(v.x), maxNum(std::fabs(v.y), std::fabs(v.z))); }
inline double binom(int n, int k) {
  double b = 1;
  for (int i = 1; i <= k; i++) b = b * (n - k + i) / i;
  return b;
}
inline double coord(Vec3 v, int i) { return i == 0 ? v.x : i == 1 ? v.y : v.z; }
inline Interval& coord(Box3& b, int i) { return i == 0 ? b.x : i == 1 ? b.y : b.z; }
inline Interval widen(Interval a, double by) { return {a.lo - by, a.hi + by}; }
inline Box3 widen(Box3 b, double by) { return {widen(b.x, by), widen(b.y, by), widen(b.z, by)}; }
inline Box3 pointBox(Vec3 p) { return {Interval::point(p.x), Interval::point(p.y), Interval::point(p.z)}; }
inline Box3 hull(Box3 a, Box3 b) {
  auto h = [](Interval x, Interval y) { return Interval{minNum(x.lo, y.lo), maxNum(x.hi, y.hi)}; };
  return {h(a.x, b.x), h(a.y, b.y), h(a.z, b.z)};
}
inline Box3 hull(Box3 a, Vec3 p) { return hull(a, pointBox(p)); }
inline Box3 emptyBox() { return {{kInf, -kInf}, {kInf, -kInf}, {kInf, -kInf}}; }
inline Box3 entireBox() { return {Interval::entire(), Interval::entire(), Interval::entire()}; }
inline Box3 ballBox(Vec3 c, double r) { return widen(pointBox(c), r); }
inline Box3 meet(Box3 a, Box3 b) {
  auto m = [](Interval x, Interval y) { return Interval{maxNum(x.lo, y.lo), minNum(x.hi, y.hi)}; };
  return {m(a.x, b.x), m(a.y, b.y), m(a.z, b.z)};
}
inline Box3 operator+(const Box3& a, const Box3& b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline Box3 operator-(const Box3& a, const Box3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline Box3 operator*(Interval s, const Box3& a) { return {s * a.x, s * a.y, s * a.z}; }
inline Interval dotBox(const Box3& a, const Box3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Box3 crossBox(const Box3& a, const Box3& b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
/** The box of a fixed vector times an interval. */
inline Box3 scaled(Interval s, Vec3 v) { return s * pointBox(v); }
inline double boxMag(const Box3& b) { return maxNum(b.x.mag(), maxNum(b.y.mag(), b.z.mag())); }
/** An upper bound on |v| for v in the box. */
inline double boxNorm(const Box3& b) {
  double x = b.x.mag(), y = b.y.mag(), z = b.z.mag();
  return std::sqrt(x * x + y * y + z * z) * (1 + 4 * kEps);
}
/** A lower bound on |v| for v in the box (0 when it holds the origin). */
inline double boxMinNorm(const Box3& b) {
  auto m = [](Interval x) { return x.lo > 0 ? x.lo : x.hi < 0 ? -x.hi : 0.0; };
  double x = m(b.x), y = m(b.y), z = m(b.z);
  return std::sqrt(x * x + y * y + z * z) * (1 - 4 * kEps);
}
/** A lower bound on the distance from p to the box. */
inline double boxDistance(const Box3& b, Vec3 p) {
  auto m = [](Interval x, double c) { return c < x.lo ? x.lo - c : c > x.hi ? c - x.hi : 0.0; };
  double x = m(b.x, p.x), y = m(b.y, p.y), z = m(b.z, p.z);
  return std::sqrt(x * x + y * y + z * z) * (1 - 4 * kEps);
}
inline bool boxFinite(const Box3& b) {
  return std::isfinite(b.x.lo) && std::isfinite(b.x.hi) && std::isfinite(b.y.lo) && std::isfinite(b.y.hi)
    && std::isfinite(b.z.lo) && std::isfinite(b.z.hi);
}

/**
 * The range of A cos t + B sin t over r (all of [-R, R] for a period or more; R = hypot(A, B)), widened by its
 * rounding: its extremes are at t = atan2(B, A) + j pi.
 */
Interval sinusoid(double A, double B, Range r);
/** (A, B) of the k-th derivative of A cos t + B sin t: each derivative turns it to (B, -A). */
inline void turn(double& A, double& B, int k) {
  for (int j = 0; j < (k & 3); j++) {
    double t = A;
    A = B, B = -t;
  }
}

/**
 * The centred form: S^(k,l) over ru x rv lies within max|S^(k+1,l)| |u - mu| + max|S^(k,l+1)| |v - mv| of its value
 * at the middle (the mean value theorem along a path from the middle, coordinate by coordinate), which shrinks with
 * the rectangle where a hull of control points doesn't. The next order's bounds from the kind's own boxes.
 */
Status centredBox(const SurfaceImpl& s, Range ru, Range rv, int k, int l, Box3& out);

/** Each kind's singular iso-lines reached by a foot: whether q is within tol of any (point-type) singularity. */
bool nearSingularity(const Surface& s, Vec3 q, double tol);

} // namespace surfaces
} // namespace cadgeom
