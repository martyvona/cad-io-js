// What decides a face's mesh, behind one interface so the surfaces' lane can replace it in one file
// (native/src/criteria.cpp): mesh2d.h's SizeField (the metric in (u, v) and whether a triangle is good enough in 3D)
// plus the spacing the face's edges need for its triangles to be.
#pragma once

#include <algorithm>

#include <memory>

#include "cad_geom/interval.h"
#include "cad_geom/model.h"
#include "cad_geom/surface.h"
#include "tess_cadio/mesh2d.h"

namespace tesscadio {

/** A request's deflections, as cad-scene's profiles give them. */
struct Deflections {
  /** The largest distance between the mesh and the surface (or curve), in model units. */
  double linear = 0.1;
  /** The largest angle between the surface's normals at a triangle's corners (a curve's chord and tangent), radians. */
  double angular = 0.26;
};

/**
 * The refinement floor, max(the part's tolerance, 0.1 x the deflection): edges are sampled no finer than it and no span
 * whose chord is within it is split, whatever asks (EdgeMesh; the mesher told so, Domain2::frozen), a triangle whose
 * patch is no larger is accepted outright (SurfaceCriteria, SizeField::belowFloor), and the mesher's angle-only
 * refinement stops at it (mesh2d.h). Below it nothing a mesh shows changes, and refinement chases rounding.
 */
inline double refinementFloor(double partTolerance, double deflection) {
  return std::max(partTolerance, 0.1 * deflection);
}

/**
 * A facet (its corners' cross product) turned against a normal: past 90 degrees from it, however little. The
 * criteria refuse a facet so against any corner's normal (below the refinement floor too); PartMesher fails a face
 * whose triangle is so against its corners' mean normal (PartOptions::failTurnedOver).
 */
inline bool facetAgainst(cadgeom::Vec3 facet, cadgeom::Vec3 normal) { return cadgeom::dot(facet, normal) < 0; }

/** One face's criteria; the surface outlives it. */
/**
 * Why SurfaceCriteria refuses a triangle, its first check in accept()'s order that fails: the deviation by a closed
 * form (a sphere's, a cone's, a torus's), by sampling (its centroid and sides' middles at their barycentric (u, v)),
 * by the surface's derivative bounds over its (u, v) box, by inversion near a pole (deviationNearPole, the fallback
 * where both overstate); else a corner's normal against the facet's (normalFacet) or two corners' normals apart
 * (normalSpread), past the angle.
 */
enum class Refusal : uint8_t {
  none, deviationClosedForm, deviationSampled, deviationBounded, deviationNearPole, normalFacet, normalSpread
};
constexpr int kRefusalKinds = 7;

class SurfaceCriteria : public SizeField {
public:
  /**
   * The largest 3D span on this face's edges (EdgeMesh's faceSpacing): how narrow the triangles next to its boundary
   * must be for the deflections.
   */
  virtual double edgeSpacing() const = 0;
  /**
   * The graded grid's metric at p (bilinear between its nodes, without the point's own curvature): sqrt(det M), the
   * metric's area per unit area of (u, v). 0 where the criteria keep no grid.
   */
  virtual double gridDensity(cadgeom::Vec2 p) const {
    (void)p;
    return 0;
  }
  /**
   * A crease inside the face: the iso-line u = at (isoU) or v = at where its normal jumps; a point within `near` of it
   * in that coordinate (the face's (u, v) tolerance: a boundary point there is the loop's) is on it.
   */
  struct Crease {
    bool isoU;
    double at, near;
  };
  /** The face's creases, for the normals: a triangle's corner on one takes its normal from the triangle's side. */
  virtual void setCreases(std::vector<Crease> lines) = 0;
  /**
   * The boundary's own 3D points by their (u, v) (an edge's curve points, which its faces share and the mesh outputs):
   * a triangle is also refused as turned over when its facet with these at its corners where it has them, as the
   * output has it, faces against the mean of its corners' normals (the part's own check of its output). The other
   * tests, the deviation and the normals' angles, stay judged on the surface's
   * points, so a boundary off its surface within the face's tolerance isn't refused for being where the model put it.
   * None by default.
   */
  virtual void setBoundaryPoints(const std::vector<std::pair<cadgeom::Vec2, cadgeom::Vec3>>& points) { (void)points; }
  /**
   * Where the output's positions go as float32 minus this point (PartOptions::outputOrigin): the turned-over tests
   * judge each facet with its corners so rounded, as shipped, so refinement mends a facet the rounding alone turns.
   * None by default (in double).
   */
  virtual void setOutputOrigin(const double origin[3]) { (void)origin; }
  /**
   * Whether accept() has bounded every triangle's deviation from the surface it judged so far (by derivative bounds
   * or a distance function) rather than sampling it: false for the kinds it samples (extrusions, revolutions,
   * offsets) and wherever a bound wasn't available (near a cone's apex).
   */
  virtual bool bounded() const = 0;
  /**
   * The deviation half of accept() alone: the surface within `linear` of the triangle, its normals not judged. For a
   * fan at an apex-like pole (poles.h), where the normal's limit depends on the way to the point and no normal is
   * there to hold a triangle's to.
   */
  virtual bool acceptDeviation(const cadgeom::Vec2 tri[3]) const = 0;
  /**
   * accept() for a smooth pole's fan (poles.h): its facet held to the angle however thin (a thinner triangle's isn't,
   * only refused turned against a corner's normal: criteria.cpp's normalsRefusal).
   */
  virtual bool acceptFan(const cadgeom::Vec2 tri[3]) const = 0;
  /**
   * Why accept() (normals true; acceptFan(), fan true too) or acceptDeviation() refuses the triangle; Refusal::none
   * where it doesn't.
   */
  virtual Refusal refusal(const cadgeom::Vec2 tri[3], bool normals = true, bool fan = false) const = 0;
  /**
   * An upper bound on how far the flat triangle on the surface's points at its corners strays from the surface (a
   * sphere's or a distance function's closed form, else the derivative bounds over its (u, v) box, or with `pieces`
   * over its pieces, tighter and dearer, as accept() has them); false where there is none (the surface's kind
   * sampled, a bound failing, a corner not evaluated). For PartOptions::checkDeviation's check, which measures
   * only where this doesn't settle it.
   */
  virtual bool deviationBound(const cadgeom::Vec2 tri[3], double& out, bool pieces = true) const = 0;
  // metric(p): the first fundamental form over h^2, h the 3D size the deflections allow there.
  // accept(tri): the surface within `linear` of the triangle at sampled points (its centroid, its edges' middles),
  // and the surface's normals at its corners within `angular` of one another and of the triangle's own normal.
};

/**
 * Face f's criteria, on its surface over `uv` (the box of its boundary in (u, v), for the bounds); null with
 * Status::unsupported where they can't be made.
 */
std::unique_ptr<SurfaceCriteria> makeCriteria(const cadgeom::Model& m, int f, const cadgeom::Surface& s,
  cadgeom::Box2 uv, const Deflections& d, cadgeom::Status& status);

} // namespace tesscadio
