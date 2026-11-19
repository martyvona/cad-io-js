// A 3D curve to a p-curve: the curve over a parameter range as a curve in a surface's (u, v), parameterized by the 3D
// curve's own parameter (Part 42's SURFACE_CURVE: same-parameter by construction), and how sure that is. Exact where
// a table allows (any curve on a plane; the iso-lines of elementary surfaces; any curve whose feet are affine in its
// parameter), otherwise traced by continuation and fitted with a 2D B-spline whose error is measured in 3D between
// its samples, not only at them (docs/own-tessellator.md: "The interrogation core", "Tracing by continuation").
#pragma once

#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

#include "curve.h"
#include "model.h"
#include "result.h"
#include "surface.h"
#include "vec.h"

namespace cadgeom {

/** How a p-curve was made. */
enum class PcurveMethod : uint8_t {
  /** Nothing made (status says why). */
  none,
  /** On a plane: the curve's own form mapped by the plane's affine (u, v) map (points, control points, conics). */
  planeAffine,
  /** An iso-line of a cylinder, cone, sphere or torus in closed form: a coaxial circle, a generatrix, a meridian. */
  isoLine,
  /** The feet affine in the curve's parameter, on any surface (an extrusion's profile copy, a B-spline's iso-curve). */
  affineFeet,
  /** Traced by continuation and fitted. */
  traced,
};

/** Known (u, v) at the range's ends: a vertex's, a seam side fixed by the neighbours. */
struct PcurveEnds {
  bool hasStart = false, hasEnd = false;
  Vec2 start, end;
};

/**
 * Where the exact table reads the curve's and surface's kinds and parameters (the model's rows the Curve and Surface
 * were made from); without it only the affine-feet test and tracing run.
 */
struct PcurveSource {
  const Model* model = nullptr;
  int curve = -1, surface = -1;
};

/**
 * One piece of a p-curve over t (a sub-range of the range asked), or a jump along a pole line: where the 3D curve
 * passes through a pole or an apex at t.lo == t.hi, the p-curve runs along the pole line from `from` to `to` (zero
 * 3D length), and `curve` is null.
 */
struct PcurvePiece {
  Range t;
  /** dim 2, parameterized by the 3D curve's t. */
  std::unique_ptr<Curve> curve;
  /**
   * The curve in the model's form (layout.ts's CURVE_LAYOUTS, dim 2: its CBR_CURVE_* kind, reals and ints as a
   * model's pools would hold them), kind 0 where it has none: the 3D curve's image by a plane's map that no 2D kind of
   * the same parameter holds (a conic running clockwise in (u, v), an offset curve), given then by `affine` (u =
   * affine[0..2] . (P - o), v = affine[3..5] . (P - o), o = affine[6..8], P the 3D curve's point). Its `curve`
   * views the 3D curve projectCurve was given, which must outlive it.
   */
  int kind = 0;
  std::vector<double> reals;
  std::vector<int32_t> ints;
  double affine[9] = {};
  bool poleLine = false;
  Vec2 from, to;
  Certainty certainty = Certainty::none;
  /** As Pcurve's error, over this piece. */
  double error = 0;
};

struct Pcurve {
  /**
   * ok: every piece made and `error` <= tol. invalidModel: the curve is farther than tol from the surface somewhere
   * (`offSurface`), so no p-curve can be within tol; the feet's p-curve is still given. noConvergence: a p-curve was
   * made but its error stays above tol. singular: the whole range is at one singular point. unsupported: none made.
   */
  Status status = Status::unsupported;
  PcurveMethod method = PcurveMethod::none;
  /**
   * unique: the feet are one branch throughout. ambiguous: somewhere another foot is within tol of the traced one
   * (a fold, a non-injective surface, a known end the trace doesn't reach), at the parameters in `tAmbiguous`.
   */
  Certainty certainty = Certainty::none;
  /** In order of t, end to end (a pole piece between the pieces it joins); usually one. */
  std::vector<PcurvePiece> pieces;
  /**
   * The curve lies on a seam (seamU: u at the seam throughout; seamV likewise): `seamTwin` is the other side's
   * p-curve, `pieces` shifted by +1 period in that parameter. A use takes one of them by seamUseTakesTwin.
   */
  bool seamU = false, seamV = false;
  std::vector<PcurvePiece> seamTwin;
  /**
   * The largest distance from the curve to its feet on the surface over the range: its deviation (mm, measured), or
   * where a span's control hull leaves the surface's box, at least the farthest point's distance from that box.
   */
  double offSurface = 0;
  /** Where offSurface came from the hulls: the span (between two of the curve's breaks) holding it; else NaN. */
  Range offSpan{NAN, NAN};
  /**
   * The largest |S(p(t)) - C(t)| over the range (mm, measured between samples as well as at them, not bounded):
   * status ok promises error <= tol.
   */
  double error = 0;
  std::vector<double> tAmbiguous;
};

/**
 * The p-curve of c over r (finite, lo < hi) on s (as it closes in fact: closeInFact), `tol` a 3D distance (the
 * part's uncertainty or the edge's tolerance). `ends`, where given, are (u, v) the result must start or end at (a
 * period's difference is taken up by the unwrapping; a pole's free parameter is the end's); `source`, where given,
 * lets the exact table read the rows c and s were made from. Periods are unwrapped continuously, so a p-curve
 * crossing a seam leaves the domain by up to a period (geom2d's Periods take that).
 */
Pcurve projectCurve(const Curve& c, Range r, const Surface& s, double tol, const PcurveEnds* ends = nullptr,
  const PcurveSource* source = nullptr);

/**
 * For a p-curve on a seam: whether a use of it takes `seamTwin` (the higher copy) rather than `pieces`. The face's
 * material is to the left of its loops in (u, v) where its sense is the surface's (to the right otherwise), so a use
 * whose left side is +u (seamU) or +v (seamV) has the material above it and takes the lower copy. `useForward`: the
 * use runs with the 3D curve's parameter.
 */
bool seamUseTakesTwin(const Pcurve& p, bool useForward, bool faceSameSense);

} // namespace cadgeom
