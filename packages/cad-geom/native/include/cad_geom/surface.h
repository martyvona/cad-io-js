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

/**
 * The parameters in ru x rv of the point of s nearest p, global (branch and bound on bound(), then Gauss-Newton);
 * `tol` a distance. `hint`, if given, is a (u, v) the caller expects near the answer (a neighbouring sample's): it
 * seeds the search but never replaces the global check.
 */
SurfaceInversion invertSurface(const Surface& s, Vec3 p, Range ru, Range rv, double tol, const Vec2* hint = nullptr);

} // namespace cadgeom
