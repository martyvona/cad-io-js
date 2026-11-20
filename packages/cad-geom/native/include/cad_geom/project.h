// A 3D curve to a p-curve: the curve over a parameter range as a curve in a surface's (u, v), parameterized by the 3D
// curve's own parameter (Part 42's SURFACE_CURVE: same-parameter by construction), and how sure that is. Exact where
// a table allows (any curve on a plane; the iso-lines of elementary surfaces; any curve whose feet are affine in its
// parameter), otherwise traced by continuation and fitted with a 2D B-spline whose error is measured in 3D between
// its samples, not only at them (docs/own-tessellator.md: "The interrogation core", "Tracing by continuation").
#pragma once

#include <cmath>
#include <cstdint>
#include <map>
#include <memory>
#include <vector>

#include "curve.h"
#include "model.h"
#include "result.h"
#include "surface.h"
#include "vec.h"

namespace cadgeom {

/** How a p-curve was made. */
/**
 * Why a trace stopped short of its range's end: noConvergence, no corrector step converged however short (or no seed
 * found); jump, the corrected foot jumped in 3D by more than the curve moved (a seam's period never does: 3D is
 * compared); poleLine, every step landed on a pole line the curve stays off; degenerate, the first fundamental form
 * degenerated where it stopped (S_u x S_v vanishing off the domain's sides); fold, the Hessian of |S - C|^2 / 2 was
 * singular where it stopped (a fold or branch point of the feet).
 */
enum class StopWhy : uint8_t { none, noConvergence, jump, poleLine, degenerate, fold };

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
/** A foot of an end point (a vertex) on a surface, as the end search gives it. */
struct EndFoot {
  /** point: one (u, v); seamPair: on a seam, `twin` the other side's copy; pole: at a pole, its free coordinate any. */
  enum class Kind : uint8_t { point, seamPair, pole };
  Kind kind = Kind::point;
  Vec2 uv, twin{NAN, NAN};
  /** A pole's free coordinate (u where poleU, else v) and the interval it takes: the domain's in that direction. */
  bool poleU = false;
  double freeLo = NAN, freeHi = NAN;
  double distance = NAN;
  /** unique: the only foot within tol of the nearest; else ambiguous. */
  Certainty certainty = Certainty::none;
};

/**
 * The end search's results by key (the caller's: a vertex and a face, as (vertex row << 32) | face row), for a pass,
 * so a vertex's feet on a face are searched once (a trace's ends are checked against them, PcurveEnds; it isn't
 * seeded from them: on a C0 knot or toward a pole a trace from an end went astray where one from inside didn't):
 * the global search (invertSurface over the surface's domain) runs once per key, at the largest tol asked so far,
 * keeping every foot it found; each call clusters those at its own tol (feet within tol of the nearest kept, feet
 * within tol of each other one). A key's surface and point are its first call's. The vectors returned stay valid for
 * the cache's lifetime (a later call for the same key at a larger tol refills its vector, a smaller one too: there is
 * one per key). Not thread-safe: one per pass or worker.
 */
class EndSearchCache {
public:
  const std::vector<EndFoot>& feet(uint64_t key, const Surface& s, Vec3 p, double tol);
  void clear() { entries_.clear(); }
  /** The global searches run so far. */
  long searches() const { return searches_; }

private:
  struct Entry {
    double searched = -1, clustered = -1;
    std::vector<SurfaceFoot> raw;
    std::vector<EndFoot> feet;
  };
  std::map<uint64_t, Entry> entries_;
  long searches_ = 0;
};

/**
 * Known ends: (u, v) the result must start or end at (hasStart, hasEnd), which also seed the trace. And, through
 * `cache`, the feet of the end vertices' points (startPoint, endPoint; checkStart, checkEnd, keyed by startKey and
 * endKey) a traced result's ends are checked against (Pcurve's endCheck).
 */
struct PcurveEnds {
  bool hasStart = false, hasEnd = false;
  Vec2 start, end;
  EndSearchCache* cache = nullptr;
  bool checkStart = false, checkEnd = false;
  uint64_t startKey = 0, endKey = 0;
  Vec3 startPoint, endPoint;
};

/**
 * A traced result's end against the end search's feet there (PcurveEnds' cache): unchecked; the same foot; the same
 * a whole number of periods over (the result's unwrapping); a seam pair's other copy; a different foot (a fold or
 * another sheet: the end then ambiguous, the feet its alternatives); or the vertex farther than tol from the
 * curve's end (vertexOff: a gap in the model, the vertex's feet its alternatives, the end not ambiguous).
 */
enum class EndCheck : uint8_t { unchecked, same, periods, seamOther, different, vertexOff };

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
   * The trace stopped short (`stopped`): at stopAt, the last foot it had there stopDistance from the curve, for
   * stopWhy. No pieces are given then; status is noConvergence, or invalidModel where the feet it had were already
   * farther than tol (offSurface, a lower bound for the whole range).
   */
  bool stopped = false;
  double stopAt = NAN, stopDistance = NAN;
  StopWhy stopWhy = StopWhy::none;
  /**
   * The largest |S(p(t)) - C(t)| over the range (mm, measured between samples as well as at them, not bounded):
   * status ok promises error <= tol.
   */
  double error = 0;
  std::vector<double> tAmbiguous;
  /** Its start's and end's check (traced and affineFeet results, ends given a cache); different, vertexOff: the feet
   * there. */
  EndCheck endCheck[2] = {EndCheck::unchecked, EndCheck::unchecked};
  std::vector<Vec2> endAlternatives[2];
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
