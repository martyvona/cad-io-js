// What project*.cpp share: building a piece's 2D curve from its model form, the 3D error measure, shifting by
// periods, and the stages projectCurve runs (the exact table, then tracing). Private to project*.cpp.
#pragma once

#include <cmath>
#include <limits>
#include <memory>
#include <vector>

#include "cad_geom/project.h"

namespace cadgeom {
namespace project {

constexpr double kPi = 3.141592653589793;
constexpr double kTwoPi = 6.283185307179586;
const double kInf = std::numeric_limits<double>::infinity();

/** A curve's or surface's kind and pools as a model's row holds them (layout.ts): what the exact table reads. */
struct Form {
  int kind = -1, dim = 3;
  const double* reals = nullptr;
  const int32_t* ints = nullptr;
};

/** The model's row as a Form; a trimmed curve that keeps its basis's parameter is its basis. Empty if out of range. */
Form curveForm(const Model& m, int row);
Form surfaceForm(const Model& m, int row);

/** What every stage needs: the inputs, the table's forms, the surface's domain and singular places. */
struct Job {
  const Curve& c;
  Range r;
  const Surface& s;
  double tol;
  const PcurveEnds* ends;
  Form curveForm, surfaceForm;
  SurfaceDomain dom;
  std::vector<Singularity> sing;
  /** The curve's breaks over r (its ends included). */
  std::vector<double> breaks;
  /**
   * The surface's breaks inside its domain (knots, a profile's), and a periodic direction's seam, where its partials
   * may jump: the trace's rate.
   */
  std::vector<double> uBreaks, vBreaks;
};

/** The piece's `curve` from its form (kind, reals, ints; kind 0 from `affine` over `basis`); false if it can't be. */
bool build(PcurvePiece& p, std::shared_ptr<const Curve> basis = nullptr);

/** A line piece over t: uv(t) = uv0 + (t - t.lo) * vel (vel nonzero). */
PcurvePiece linePiece(Range t, Vec2 uv0, Vec2 vel);

/** p moved by (du, dv) in (u, v): a whole number of periods, for unwrapping. */
void shift(PcurvePiece& p, double du, double dv);

/** The p-curve's (u, v) at t (a pole piece's `from`). */
Vec2 at(const PcurvePiece& p, double t);

/**
 * The largest |S(p(t)) - C(t)| over the piece, measured on each smooth span (the curve's and the piece's breaks) at
 * evenly spaced points, then refined by golden-section search around the worst of them.
 */
double measure(const Job& job, const PcurvePiece& p);

/**
 * The point's local foot on s from uv (damped Newton on the squared distance), in a periodic direction within half a
 * period of where it started; its distance.
 */
double footFrom(const Surface& s, const SurfaceDomain& dom, Vec3 p, Vec2& uv, int iters = 30);

/** The exact table (planes, elementary iso-lines) on the job's forms: true with `out` filled and verified, else false. */
bool exact(const Job& job, Pcurve& out);

/** Tracing by continuation, the affine-feet test, the fit, poles: always fills `out` (status saying how it went). */
void trace(const Job& job, Pcurve& out);

/** fit::curve2's calls from trace, counted for tests (how many attempts a fit took); never reset. */
extern long traceFits;

/** projectCurve with the table's forms given directly (projectCurve reads them from its PcurveSource). */
Pcurve projectForms(const Curve& c, Range r, const Surface& s, double tol, const PcurveEnds* ends, Form curve,
  Form surface);

/** Takes the pieces whole periods on so the start is the given one's (or in the domain), and checks the end. */
void align(const Job& job, Pcurve& out);

/** Fills seamU, seamV and seamTwin where the p-curve runs along a seam. */
void seams(const Job& job, Pcurve& out);

/** The 3D tolerance in (u, v) at uv: tol over the first fundamental form's largest stretch there. */
double uvTol(const Surface& s, Vec2 uv, double tol);

} // namespace project
} // namespace cadgeom
