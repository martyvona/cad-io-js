// The surface query interface: every surface kind of the model (layout.ts's SURFACE_KIND) evaluated to second
// derivatives, bounded, with its singular places and periods, and inverted. Parameterizations are Part 42's as
// docs/brep-reference.md gives them (a revolution's u is the angle, v the profile's parameter). The normal is
// S_u x S_v, before a face's sense turns it. As for curves (curve.h), no derivative is formed from absolute
// coordinates: evaluate relative to a local origin and add it to the point only.
#pragma once

#include <memory>
#include <vector>

#include "interval.h"
#include "model.h"
#include "result.h"
#include "vec.h"

namespace cadgeom {

struct SurfaceDomain {
  Range u, v;
  /** 0 where not periodic. */
  double uPeriod = 0, vPeriod = 0;
};

/** A point and its partial derivatives, to the order asked (higher ones left zero). */
struct SurfacePoint {
  Vec3 p, du, dv, duu, duv, dvv;
};

/**
 * A place where the parameterization degenerates. Along an iso-line (`isoU`: u fixed at `at`, v free; else v fixed,
 * u free) every point is the same 3D `point`: a sphere's pole (v = +/-pi/2), a cone's apex (v at the apex), a
 * revolution's profile meeting the axis, collapsed rows of B-spline poles. `normalVanishes` without a collapse: S_u x
 * S_v = 0 at isolated points or along a curve (an offset past its radius, a B-spline fold); `point` unused there.
 */
struct Singularity {
  enum Kind : uint8_t { pole, apex, normalVanishes } kind = pole;
  bool isoU = false;
  double at = 0;
  Vec3 point;
};

class Surface {
public:
  virtual ~Surface() = default;
  virtual SurfaceDomain domain() const = 0;
  /** S(u, v) and partials up to `order` (0 to 2); periodic directions reduced; outside the domain outOfDomain. */
  virtual Status eval(double u, double v, int order, SurfacePoint& out) const = 0;
  /**
   * eval at n points of an iso-line, (fixed, ts[i]) where alongV, else (ts[i], fixed), into out[i] and st[i], bit for
   * bit as eval gives them: a B-spline finds the fixed direction's span and basis once.
   */
  virtual void evalRow(bool alongV, double fixed, int n, const double* ts, int order, SurfacePoint* out,
    Status* st) const {
    for (int i = 0; i < n; i++) st[i] = alongV ? eval(fixed, ts[i], order, out[i]) : eval(ts[i], fixed, order, out[i]);
  }
  /** The unit normal S_u x S_v / |S_u x S_v|; Status::singular where it vanishes (a limit may be given then). */
  virtual Status normal(double u, double v, Vec3& out) const = 0;
  /** The u and v parameters in ru, rv where the surface is less smooth (knots, a profile's breaks), sorted, ends in. */
  virtual void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const = 0;
  /** A box that certainly holds S over ru x rv. */
  virtual Status bound(Range ru, Range rv, Box3& out) const = 0;
  /**
   * Upper bounds that hold over ru x rv on the derivatives of `order` (1: max |S_u|, |S_v|; 2: max |S_uu|, |S_uv|,
   * |S_vv|), as out[0..order]: the distortion between (u, v) and 3D, and a triangle's deviation from the surface.
   */
  virtual Status derivBound(Range ru, Range rv, int order, double out[3]) const = 0;
  virtual void singularities(std::vector<Singularity>& out) const = 0;
};

/** The surface at a model's row, references resolved; null with `status` saying why (as makeCurve). */
std::unique_ptr<Surface> makeSurface(const Model& model, int row, Status& status);

/**
 * s as it closes in fact, the rule every consumer shares: a direction whose range is finite and which isn't periodic
 * becomes periodic, its period hi - lo and every query reduced into its range, where |S(lo, y_k) - S(hi, y_k)| <=
 * tol at 9 evenly spaced y_k of the other range, or of [-1, 1] where that is infinite (a B-spline whose first and
 * last rows of poles meet, an extrusion of a closed profile), and where the longest of the iso-curves along the
 * direction at those y_k (as 64-step polylines) is at least 10 x tol (a sliver narrower than that is degenerate, its
 * sides boundaries); a side of a finite range where S(x, y_k), k = 1..8, are within tol of S(x, y_0) is a pole line,
 * reported by singularities() as a sphere's is (with those the surface reports already, none twice), where the
 * longest of the iso-curves along that side (at 9 points of its own range) is at least 10 x tol (a surface about as
 * small as its tolerance has every side within it, and no meaningful pole). Nearly closed
 * or nearly collapsed (any of the points farther than tol) gets neither. s itself comes back where neither applies.
 * tol is the caller's: max(part uncertainty, face tolerance), else 1e-9 times the surface's size.
 */
std::unique_ptr<Surface> closeInFact(std::unique_ptr<Surface> s, double tol);

/** The nearest point on a surface within a parameter box, and how sure that is. */
struct SurfaceInversion {
  Vec2 uv;
  Vec3 foot;
  double distance = 0;
  Status status = Status::unsupported;
  /** As CurveInversion's: the same foot at another (u, v), on a seam or at a pole, is not an alternative but a flag. */
  Certainty certainty = Certainty::none;
  std::vector<Vec2> alternatives;
  /**
   * The foot is within tol of a seam (periodic, or closed in fact), where u (or v) is also at the other end of its
   * range; uv stays the foot's own parameters (never snapped), as CurveInversion's onSeam.
   */
  bool onSeamU = false, onSeamV = false;
  /**
   * The foot is at a singularity within tol, where the free parameter's value is arbitrary (uv holds one choice; the
   * seam flag for that parameter stays false, since its value is a choice, not a seam).
   */
  bool atSingularity = false;
  /**
   * Where the feet form a curve (a point on an axis of revolution: the circle round it; a torus's tube centre: the
   * tube's circle): it runs along u over [lo, hi] at v = at (familyU), else along v; alternatives sample it. Where
   * they cover the surface (a sphere's centre) there is no curve: hasFamily stays false, alternatives sample them.
   */
  bool hasFamily = false, familyU = false;
  double familyLo = 0, familyHi = 0, familyAt = 0;
};

/** A foot found locally (localFoot). */
struct LocalFoot {
  /** ok (a foot on a side of the domain included: `side`); noConvergence; singular (the normal matrix degenerate). */
  Status status = Status::noConvergence;
  /** ok against a side of a direction that isn't periodic: 0 u's lo, 1 u's hi, 2 v's lo, 3 v's hi; else -1. */
  int side = -1;
  /** Continued from start (periodic parameters not reduced), S there and its distance from p. */
  Vec2 uv;
  Vec3 point;
  double distance = NAN;
  int iterations = 0;
};

/**
 * The foot of p on s continued from `start` (a nearby known foot's (u, v)), no global search: Gauss-Newton on
 * |S - p|^2 / 2, each step taken only where it comes nearer; held against a side of the domain (a direction that isn't
 * periodic), along that side, the other coordinate's Newton step alone. ok where it converged: the step it would take,
 * in 3D, within max(1e-12 (1 + |p|), 1e-6 |S - p|); where no step comes nearer, within max(1e-9 (1 + |p|),
 * 1e-4 |S - p|), the surface's own rounding. singular where the normal matrix degenerates on the way, or a direction
 * collapses (|S_u| under 1e-12 |S_v|, or the other way: a pole row); noConvergence where it stalled away from a foot
 * or ran out of steps. Pass the surface as it closes in fact (closeInFact), so its periods are the face's.
 */
LocalFoot localFoot(const Surface& s, Vec3 p, Vec2 start);

/** A foot the search found: its parameters, point and distance from the point inverted. */
struct SurfaceFoot {
  Vec2 uv;
  Vec3 foot;
  double distance;
};

/**
 * The parameters in ru x rv of the point of s nearest p, global (branch and bound on bound(), then Gauss-Newton);
 * `tol` a distance. `hint`, if given, is a (u, v) the caller expects near the answer (a neighbouring sample's): it
 * seeds the search but never replaces the global check. `all`, if given, receives every foot the search found within
 * tol of the nearest, nearest first, before feet within tol of each other are taken as one (the end search clusters
 * them at its own tolerances); periodic parameters in [lo, lo + period) as uv's. `distanceOnly`: only the nearest
 * distance is wanted, within eps = 1e-3 tol of the true one (a rectangle is dropped once its lower bound is past the
 * nearest found less eps, not kept while it could hold a foot within tol of it): uv and foot are a point at that
 * distance, certainty none and no alternatives, no seam or singularity flags; noConvergence where the budget ran out
 * with a rectangle that could hold a point nearer by eps. `untilAmbiguous`: the search stops once it holds two points
 * of s within tol of p more than tol apart, the result made from every point it found by then (status ok; its feet by
 * the rule above, ambiguous or not as they cluster): where every point within tol of p lies within 2 tol of one, the
 * whole search may cluster them otherwise, its foot and certainty then differing. Meanwhile each rectangle that could
 * hold a point within tol of p offers its local minimum to that test (kept apart from the candidates until the search
 * stops, so a search that doesn't is the whole search, bit for bit), so such points turn up long before the rectangles
 * are tiny. (On a surface nearly folded flat, where a long strip of the domain maps within tol of p, certifying every
 * foot there was most of a projection's time.)
 */
SurfaceInversion invertSurface(const Surface& s, Vec3 p, Range ru, Range rv, double tol, const Vec2* hint = nullptr,
  std::vector<SurfaceFoot>* all = nullptr, bool distanceOnly = false, bool untilAmbiguous = false);

/** A point where a line meets a surface: the line's parameter, the surface's, the point, and d . n there (unit). */
struct LineHit {
  double t = 0;
  Vec2 uv;
  Vec3 point;
  double cosine = 0;
  /** At a singularity (a pole or an apex) within tol: uv's free parameter is one choice. */
  bool atSingularity = false;
  /** The t the hit covers: a crossing's t alone, a tangency's cluster (the line within reach of the surface there). */
  Range span;
};

/**
 * Where a line meets a surface, within tol. Crossings: the line through the surface, |cosine| at least
 * kLineMargin, each one proven unique where it was found. Tangencies: contacts that aren't such crossings, the line
 * within tol of the surface or too near it for the search to tell at its finest size, 1e-6 of the range's 3D size
 * (touching it, crossing it too obliquely for tol to place the crossing along t, or meeting it at a pole, where the
 * normal is undefined): each one a cluster of contacts, at its point nearest the line, any crossing within its reach
 * part of it. Conservative: a caller that needs every contact resolved takes a tangency as "can't tell". Overlaps: t
 * ranges where the line lies within tol of the surface, in closed form (a plane holding the line, a cylinder's or
 * cone's generator). noConvergence where the budget ran out with rectangles unresolved (what was found is given): a
 * line lying in a surface without a closed form for it (a B-spline cylinder's generator) can take that.
 */
struct LineIntersection {
  Status status = Status::unsupported;
  std::vector<LineHit> crossings, tangencies;
  std::vector<Range> overlaps;
};

/** |d . n| below this, about 1e-3 rad between the line and the tangent plane, is a tangency, not a crossing. */
constexpr double kLineMargin = 1e-3;

/**
 * Where the line o + t d, t in tr (finite; d not 0, t in its units), meets s over ru x rv, within tol (a distance):
 * branch and bound on parameter rectangles as invertSurface's, a rectangle dropped where its box widened by tol misses
 * the segment, solved where the surface is transversal to the line all over it (interval Newton, Krawczyk's operator,
 * on the projection of S - o onto the plane normal to d: no root or exactly one), else split; periodic directions
 * searched over one period from the range's start, results in [lo, lo + period). Crossings, tangencies and overlaps
 * sorted by t; a crossing found from two rectangles (on the side they share) given once. A crossing exactly on the
 * search range's side (not a periodic seam: a surface closed in fact, or a range cut short) is a tangency, Krawczyk's
 * test needing a little room past the root.
 */
LineIntersection intersectLine(const Surface& s, Vec3 o, Vec3 d, Range tr, Range ru, Range rv, double tol);

} // namespace cadgeom
