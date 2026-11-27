// The 2D mesher's contract: a constrained Delaunay triangulation of a planar domain with a fixed boundary, refined by
// Steiner points inside until the caller's criteria hold. It knows nothing of surfaces: a face's (u, v) domain comes
// unwrapped (seams cut, periods resolved) with its boundary points already placed by the edges (each model edge
// meshed once, so neighbouring faces meet exactly), and the caller's SizeField says how long edges should be and
// whether a triangle is good enough in 3D. Signs come from cad-geom's predicates.h, exact ties are broken
// consistently (docs/own-tessellator.md, "Simulation of simplicity").
#pragma once

#include <cmath>
#include <cstdint>
#include <functional>
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
  /**
   * Whether the triangle is within the caller's refinement floor (criteria.h's refinementFloor): an accepted one so
   * small isn't refined for its shape either. None by default.
   */
  virtual bool belowFloor(const Vec2 tri[3]) const {
    (void)tri;
    return false;
  }
  /**
   * Why accept() refuses the triangle, as a small code (SurfaceCriteria: criteria.h's Refusal), for counts only; 0
   * where the caller doesn't say. Asked only where a caller wants the mesher's detail (mesh2d_impl.h).
   */
  virtual int refusalKind(const Vec2 tri[3]) const {
    (void)tri;
    return 0;
  }
  /**
   * For a triangle accept() refuses for its distance from the surface: a point inside it (u, v) where that distance
   * is the largest sampled, past the deflection; false where it has none (none by default). Refinement places it
   * where every other candidate fails: a long sliver's circumcentre leaves the domain or crowds its boundary.
   */
  virtual bool worstPoint(const Vec2 tri[3], Vec2& at) const {
    (void)tri, (void)at;
    return false;
  }
  /**
   * Whether a point at q would make a needle with the fixed segment from a to b: within a small band of it in 3D (a
   * share of criteria.h's refinement floor), a needle the criteria accept below the floor and whose facet turns.
   * Refinement treats such a q as encroaching the segment. `frozen`: the segment can't be split (Domain2::frozen),
   * so the caller says yes only where the needle would turn as shipped, since refusing q there leaves the triangle
   * as it is. None by default. A field wrapping another must pass it on.
   */
  virtual bool crowds(Vec2 a, Vec2 b, Vec2 q, bool frozen) const {
    (void)a, (void)b, (void)q, (void)frozen;
    return false;
  }
  /**
   * The position a point at p ships at (its 3D point as the output rounds it), into `out`; false where the caller
   * keeps none (the default). The mesher inserts no point at a position a vertex of its already ships at: the output
   * would weld them, and its triangles there fold (edges used twice the same way). A field wrapping another must pass
   * it on.
   */
  virtual bool shippedAt(Vec2 p, float out[3]) const {
    (void)p, (void)out;
    return false;
  }
};

/**
 * The domain: points, then boundary loops as closed sequences of point indices (outer counterclockwise, holes
 * clockwise: a face's loops in (u, v)). Boundary points and segments are fixed: never moved, never split. Optional
 * interior points (internal edges' samples, points a face must contain) are kept as vertices. A loop may pass one
 * point twice and loops may share one (a vertex the boundary touches itself at: one index, the caller's points
 * there exactly equal); two indices at one (u, v) are refused, as are segments that cross.
 */
struct Domain2 {
  std::vector<Vec2> points;
  std::vector<std::vector<int32_t>> loops;
  /** Interior constraint segments (pairs of point indices) the triangulation must contain, also fixed. */
  std::vector<int32_t> segments;
  /**
   * Per segment, numbered as SplitWanted::segment (each loop's, then the interior ones), whether the caller can never
   * split it (an edge's span whose chord is within criteria.h's refinement floor): a point encroaching
   * only such segments is inserted, and none is wanted split. Empty, or shorter than the segments: the rest not.
   */
  std::vector<uint8_t> frozen;
  /**
   * Points to start refinement from (a mesh's Steiner points from before), inserted in order as refinement inserts
   * its own (cavities Delaunay in each point's metric) once the boundary is in: Steiner points in the result, counted
   * toward maxPoints. One not finite, outside the domain or on a vertex is skipped.
   */
  std::vector<Vec2> seeds;
};

/**
 * The largest smallest angle refinement aims for (30 degrees): past it Delaunay refinement isn't guaranteed to end,
 * and it doesn't (spheres run away at 40).
 */
constexpr double kMaxMinAngle = 30 * M_PI / 180;

struct MeshOptions {
  /** Steiner points at most (a runaway refinement stops with Status::noConvergence, the mesh valid). */
  int maxPoints = 1000000;
  /**
   * The smallest angle refinement aims for, in radians, measured in the metric: 10 degrees by default, clamped to
   * [0, kMaxMinAngle].
   */
  double minAngle = 10 * M_PI / 180;
  /** Called every 1024 triangles refinement takes up, if set: a long refinement's heartbeat (progress reports). */
  std::function<void()> onWork;
  /**
   * With a Mesh2Detail (mesh2d_impl.h), the insertions counted by the caller's refusal kinds (SizeField::refusalKind:
   * the criteria evaluated again on each refused triangle queued); false counts them all as refused alike.
   */
  bool refusalKinds = true;
  /**
   * A triangle the criteria accept whose longest edge is past sqrt 2 in the metric, and whose every candidate
   * encroaches only segments that won't be split (within the size, or frozen), has that edge bisected
   * (mesh2d.cpp's rules), so no edge stays past the size beside them: for a longest-edge limit (Deflections::maxEdge).
   * Off, such a triangle is left as it is.
   */
  bool bisectLong = false;
};

/**
 * A fixed segment refinement wanted split: a triangle's every improving point encroached it (or the first left the
 * domain across it: the segment the ray from the triangle's centroid crosses first), that triangle is still in the
 * mesh, and either the segment is longer than sqrt 2 in its endpoints' metric (averaged) or accept() still refuses
 * the triangle. The caller splits the edge the segment samples (in 3D, once for both faces it bounds) and meshes
 * again.
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
