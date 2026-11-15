// The curve query interface: every curve kind of the model (layout.ts's CURVE_KIND), 3D or 2D (a p-curve's geometry
// in a surface's (u, v)), evaluated with derivatives, bounded, inverted, measured. Parameterizations are Part 42's as
// docs/brep-reference.md gives them, trimmed and composite curves included. A 2D curve's points have z = 0.
// Precision far from the origin: no derivative or difference is formed from absolute coordinates. Evaluate relative
// to a local origin (a span's pole centroid, a placement's origin) and add the origin once, to the point only: a
// B-spline 1e6 mm out evaluated on absolute poles has speeds 1e-10 off, enough to stop arc length converging.
#pragma once

#include <memory>
#include <vector>

#include "interval.h"
#include "model.h"
#include "result.h"
#include "vec.h"

namespace cadgeom {

/** The natural parameter range and, for a closed periodic curve (circle, ellipse), its period (0: none). */
struct CurveDomain {
  Range range;
  double period = 0;
};

/** A point and derivatives with respect to the parameter, to the order asked (higher ones left zero). */
struct CurvePoint {
  Vec3 p, d1, d2;
};

class Curve {
public:
  virtual ~Curve() = default;
  /** 2 or 3. */
  virtual int dim() const = 0;
  virtual CurveDomain domain() const = 0;
  /**
   * C(t) and derivatives up to `order` (0 to 2) into `out`. A periodic curve takes any t (reduced by its period);
   * otherwise t outside the domain gives Status::outOfDomain (the value at the clamped t still written).
   */
  virtual Status eval(double t, int order, CurvePoint& out) const = 0;
  /**
   * The parameters in r where the curve is less smooth than its pieces (B-spline knots of multiplicity, segment
   * joints, polyline vertices, a trim's basis's breaks), sorted, r's ends included: spans between consecutive ones
   * are smooth, so sampling and integration work span by span.
   */
  virtual void breaks(Range r, std::vector<double>& out) const = 0;
  /** A box that certainly holds C(t) for every t in r (a span's control-point hull, a conic's bounding arc box). */
  virtual Status bound(Range r, Box3& out) const = 0;
  /**
   * An upper bound that holds on |C^(order)(t)| over r, order 1 or 2: the speed bounds a parameter step's chord
   * length, the second derivative its deviation (a chord over [a, b] is within (b - a)^2 / 8 * max |C''| of the
   * curve), so deflections are honoured by construction.
   */
  virtual Status derivBound(Range r, int order, double& out) const = 0;
  /** Where in r the speed vanishes (cusps, repeated poles), sorted: Newton steps and arc length fail there. */
  virtual void singular(Range r, std::vector<double>& out) const = 0;
};

/**
 * The curve at a model's row, with its references resolved (a trimmed curve's basis, a composite's segments, an
 * offset's basis): owned by the caller, viewing the model's buffer. Null with `status` saying why where the row can't
 * be made (Status::unsupported for kinds not implemented, Status::invalidModel for bad rows).
 */
std::unique_ptr<Curve> makeCurve(const Model& model, int row, Status& status);

/** The nearest point on a curve within a parameter range, and how sure that is. */
struct CurveInversion {
  double t = 0;
  Vec3 foot;
  double distance = 0;
  Status status = Status::unsupported;
  /**
   * unique: no other foot within `tol` of `distance`; ambiguous: `alternatives` holds the parameters of the other
   * feet (different points, more than `tol` from this one) whose distance is within `tol` of the best (two arcs
   * equidistant from the point). The same foot at another parameter is not an alternative but `onSeam`.
   */
  Certainty certainty = Certainty::none;
  std::vector<double> alternatives;
  /**
   * The foot is at a closed curve's junction within tol (a periodic curve's seam, or a closed B-spline's ends meeting):
   * t is one end of the range, the same point also at the other.
   */
  bool onSeam = false;
};

/**
 * The parameter in r of the point of c nearest p, global over r (branch and bound on bound(), then guarded Newton),
 * `tol` a distance in the curve's units. r defaults to the domain; a periodic curve's result lies in [lo, lo + period).
 */
CurveInversion invertCurve(const Curve& c, Vec3 p, Range r, double tol);

/** The length of c between t0 and t1 (t0 <= t1), relative tolerance relTol; status noConvergence when not reached. */
Estimate arcLength(const Curve& c, double t0, double t1, double relTol);

/** The parameter at arc length `length` from t0 (forward), relative tolerance relTol on the length. */
Estimate paramAtLength(const Curve& c, double t0, double length, double relTol);

} // namespace cadgeom
