// What decides a face's mesh, behind one interface so the surfaces' lane can replace it in one file
// (native/src/criteria.cpp): mesh2d.h's SizeField (the metric in (u, v) and whether a triangle is good enough in 3D)
// plus the spacing the face's edges need for its triangles to be.
#pragma once

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

/** One face's criteria; the surface outlives it. */
class SurfaceCriteria : public SizeField {
public:
  /**
   * The largest 3D span on this face's edges (EdgeMesh's faceSpacing): how narrow the triangles next to its boundary
   * must be for the deflections.
   */
  virtual double edgeSpacing() const = 0;
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
