// The 2D mesher's contract: a constrained Delaunay triangulation of a planar domain with a fixed boundary, refined by
// Steiner points inside until the caller's criteria hold. It knows nothing of surfaces: a face's (u, v) domain comes
// unwrapped (seams cut, periods resolved) with its boundary points already placed by the edges (each model edge
// meshed once, so neighbouring faces meet exactly), and the caller's SizeField says how long edges should be and
// whether a triangle is good enough in 3D. Signs come from cad-geom's predicates.h, exact ties are broken
// consistently (docs/own-tessellator.md, "Simulation of simplicity").
#pragma once

#include <cstdint>
#include <vector>

#include "cad_geom/result.h"
#include "cad_geom/vec.h"

namespace tesscadio {

using cadgeom::Status;
using cadgeom::Vec2;

/** A symmetric positive definite 2x2 metric [a b; b c]: an edge e is unit length where e^T M e = 1. */
struct Metric2 {
  double a = 1, b = 0, c = 1;
};

/** What the caller decides: the wanted edge length (as a metric) at a point, and whether a triangle is acceptable. */
class SizeField {
public:
  virtual ~SizeField() = default;
  /** The metric at p, in which a good triangle's edges have unit length (isotropic: a = c = 1 / h^2, b = 0). */
  virtual Metric2 metric(Vec2 p) const = 0;
  /**
   * Whether the triangle (counterclockwise) meets the caller's criteria in 3D (chord to surface, normal angle);
   * false asks the mesher to refine it. Called on every triangle until the mesh is final.
   */
  virtual bool accept(const Vec2 tri[3]) const = 0;
};

/**
 * The domain: points, then boundary loops as closed sequences of point indices (outer counterclockwise, holes
 * clockwise: a face's loops in (u, v)). Boundary points and segments are fixed: never moved, never split. Optional
 * interior points (internal edges' samples, points a face must contain) are kept as vertices.
 */
struct Domain2 {
  std::vector<Vec2> points;
  std::vector<std::vector<int32_t>> loops;
  /** Interior constraint segments (pairs of point indices) the triangulation must contain, also fixed. */
  std::vector<int32_t> segments;
};

struct MeshOptions {
  /** Steiner points at most (a runaway refinement stops with Status::noConvergence, the mesh valid). */
  int maxPoints = 1000000;
  /** The smallest angle refinement aims for, in radians, measured in the metric. */
  double minAngle = 0.35;
};

/**
 * A fixed segment refinement wanted split: a triangle's every improving point encroached it, that triangle is still
 * in the mesh, and either the segment is longer than sqrt 2 in its endpoints' metric (averaged) or accept() still
 * refuses the triangle. The caller splits the edge the segment samples (in 3D, once for both faces it bounds) and
 * meshes again.
 */
struct SplitWanted {
  /** The segment's index: each loop's segments in order (from loop[k] to loop[k + 1]), then Domain2::segments. */
  int32_t segment;
  /** Its endpoints as the domain has them. */
  int32_t a, b;
  /** Where it would split: the middle in the metric (the endpoints' sizes interpolated), a fraction from a to b. */
  double fraction;
  Vec2 point;
};

struct Mesh2 {
  Status status = Status::unsupported;
  /** The domain's points first, in order and unchanged, then the Steiner points. */
  std::vector<Vec2> points;
  /** Counterclockwise triangles, 3 point indices each, covering the domain exactly (holes empty). */
  std::vector<int32_t> triangles;
  /** Triangles the criteria still reject at the end (a fixed boundary too coarse for them), for diagnostics. */
  std::vector<int32_t> rejected;
  /**
   * The segments to split for refinement to finish, each once (a segment used twice by its first index), in
   * segment order. The boundary itself is never split; status stays ok.
   */
  std::vector<SplitWanted> splitWanted;
};

/**
 * The domain triangulated and refined. A domain whose loops cross or don't close gives Status::invalidModel and no
 * triangles, the offending segments named in `rejected` as point-index pairs.
 */
Mesh2 mesh2(const Domain2& domain, const SizeField& field, const MeshOptions& options = {});

} // namespace tesscadio
