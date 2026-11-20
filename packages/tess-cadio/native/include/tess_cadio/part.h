// One part meshed: its edges sampled once (edges.h), each face's boundary meshed in (u, v) (mesh2d.h) against its
// criteria (criteria.h), the edges the mesher wants split split and the faces they bound meshed again, until none
// wants more or the rounds run out; then each face in 3D, its boundary points exactly its edges' samples (so faces
// meet along their edges), its normals the surface's, its triangles counterclockwise about the face's normal.
#pragma once

#include <cmath>
#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "cad_geom/model.h"
#include "tess_cadio/criteria.h"
#include "tess_cadio/edges.h"

namespace tesscadio {

/**
 * Where PartMesher is: its phase; meshing, the face (its row), the round (0 the first pass, then each split round)
 * and how many of the round's faces are done of how many it meshes; in the other phases, how many of the phase's
 * items (faces, or edges and their uses) are done of how many, row the face (a use's) or -1 (an edge).
 */
struct PartProgress {
  /** In order; deviation the check after the rounds (PartOptions::maxDeviationFactor), its round the last's. */
  enum Phase : uint8_t { surfaces, edges, criteria, meshing, splitting, deviation } phase = meshing;
  int row = 0, round = 0, facesDone = 0, facesTotal = 0;
};

struct PartOptions {
  /** The linear deflection, and the angle for faces' normals and edges' chords alike (EdgeOptions::angle). */
  Deflections d;
  /** Rounds of splitting edges and meshing their faces again at most (they end once no face asks for a split). */
  int maxSplitRounds = 24;
  /**
   * The criteria's spacing for each face's edges multiplied by this (above 1: edges coarser than the faces want,
   * left to the split rounds; for tests and tuning).
   */
  double edgeSpacingScale = 1;
  /**
   * Steiner points per face at most (mesh2d.h's maxPoints): a refinement its criteria can't end (a B-spline's
   * degenerate corner) stops there, the mesh kept with its refused triangles and noted.
   */
  int maxPointsPerFace = 100000;
  /**
   * The smallest angle refinement aims for in each face's triangles, in radians, in the criteria's metric (mesh2d.h's
   * MeshOptions::minAngle; clamped to [0, kMaxMinAngle], 30 degrees): the triangles' shape, which neither the
   * deflection nor the angle between normals asks for. 10 degrees by default; 0 for none.
   */
  double minAngle = 10 * M_PI / 180;
  /**
   * Called as each face's meshing starts, and every so often during a long one (mesh2d.h's onWork), if set: for a
   * host to say how far a request got (a timeout). Not throttled here.
   */
  std::function<void(const PartProgress&)> progress;
  /** EdgeOptions::projectMissingPcurves: uses without p-curves projected (else by inversion). */
  bool projectMissingPcurves = true;
  /**
   * A face whose mesh, when the rounds end, is farther from its surface than this times the larger of the linear
   * deflection and the face's tolerance (cad-geom's Tolerances::face) fails (Status::noConvergence, its triangles
   * dropped, the measure and the limit in its cause): its refused triangles measured, each at the points of its
   * barycentric lattice of order 4 but its corners, inverted onto the face's surface (accepted ones are within the
   * deflection by the criteria), but those its criteria's bound puts within (deviationBound), and only until a point
   * past it. 0 or less: never.
   */
  double maxDeviationFactor = 1.0;
  /**
   * A face whose mesher's triangles include one turned against its surface (its facet against the mean of its
   * corners' normals; a corner at a pole or apex aside, where the normal is a limit) fails with Status::noConvergence
   * and a cause saying so, as one past its deflection does: wrong output however rare.
   */
  bool failTurnedOver = true;
  /**
   * A face whose refinement reached its point cap (maxPointsPerFace) when the rounds end fails with
   * Status::noConvergence and a cause saying so, its triangles dropped: a capped mesh isn't the one asked for. False
   * keeps it, noted (FaceMesh::capped), for tests.
   */
  bool failCapped = true;
  /**
   * Creases inside a face (cad_geom/creases.h: iso-lines where its normal jumps past the angle) met as the mesher's
   * constraints, their normals by side.
   */
  bool creases = true;
  /**
   * Count each face's mesher insertions by what queued them (FaceMesh::inserted). Off by default: it evaluates the
   * criteria again on every refused triangle the mesher queues (up to 2 x the time); the mesh is the same either way.
   */
  bool countInsertions = false;
  /**
   * Keep each face's criteria verdicts (accept, belowFloor, the metric) from its last two meshings and answer the
   * same question again from them: a face meshed again after a split round asks mostly about the triangles it asked
   * about before. The mesh is the same bits either way (the criteria are functions of a triangle's corners as given);
   * off to compare, at the cost of evaluating them all again.
   */
  bool reuseVerdicts = true;
  /**
   * The bytes the kept verdicts may take across the part, as estimated (reuseVerdicts): past half of it the least
   * recently meshed faces' are dropped as another face's meshing starts, and past all of it nothing more is kept.
   * The mesh is the same bits whatever the budget.
   */
  size_t verdictBudget = size_t{256} << 20;
};

/** FaceMesh::inserted's kinds: size, thinness, and mesh2d's refusal kinds 0 to 7. */
constexpr int kInsertionKinds = 10;

struct FaceMesh {
  /**
   * ok; or why the face has no mesh: unsupported (a surface kind cad-geom lacks, a face with no loops),
   * invalidModel (a boundary that isn't a domain), or the boundary's or the mesher's own status.
   */
  Status status = Status::unsupported;
  /**
   * Why, where the status isn't ok: a short cause for diagnostics (its surface, its boundary's FaceBoundary::cause,
   * the mesher's segments that cross, its criteria), else empty.
   */
  std::string cause;
  /** The face's vertices: its boundary's points first (edges' samples, exactly), then the mesher's. */
  std::vector<Vec3> points;
  /** Unit normals, the face's (the surface's, turned where the face's sense is false); at a pole, the limit. */
  std::vector<Vec3> normals;
  /** Counterclockwise about the normal, 3 indices each; none with two corners at one point (a pole line's). */
  std::vector<int32_t> triangles;
  /**
   * Triangles its criteria still refuse (a fixed boundary, an edge's or a pole's ring, too coarse for them), as
   * indices into `triangles` / 3; those with two corners at one point left out with them.
   */
  std::vector<int32_t> rejected;
  /**
   * Its refused triangles' largest measured deviation (PartOptions::maxDeviationFactor): where it failed, the first
   * point found past the limit, a lower bound on the worst; 0 where nothing was measured.
   */
  double worstDeviation = 0;
  /** Its refused triangles measured for the deviation check, the rest within it by their bound. */
  int deviationMeasured = 0;
  /** The refused triangles by why the criteria refused each (criteria.h's Refusal, as indices; [0] unused). */
  int refusedBy[kRefusalKinds] = {};
  /**
   * With PartOptions::countInsertions, its final mesh's Steiner points by what queued the triangle each broke:
   * [0] its size in the metric, [1] its thinness alone, [2 + k] refused by its criteria, k criteria.h's Refusal.
   */
  int inserted[kInsertionKinds] = {};
  /** Splits of its edges it still wanted when the rounds ran out. */
  int splitsWanted = 0;
  /**
   * The meshings (the first and each split round's) in which refinement asked for a pole ring's segment to be split,
   * which a ring's never is (it stays as the ring was cut): its triangles there refused for good.
   */
  int ringBlocked = 0;
  /** Whether its triangles' deviation was sampled rather than bounded (SurfaceCriteria::bounded). */
  bool sampled = false;
  /**
   * A note for diagnostics where the face is meshed but not as asked (its boundary's status, refinement stopped at
   * its point cap), else empty: what seamUnsettled and capped say, in words.
   */
  std::string note;
  /** Whether a seam's side in (u, v) wasn't settled by its neighbours (FaceBoundary's Status::singular), meshed. */
  bool seamUnsettled = false;
  /** Whether refinement stopped at the point cap (maxPointsPerFace): the face failed, or kept (failCapped false). */
  bool capped = false;
  /** Its boundary's FaceBoundary::againstSense: a loop against the face's sense, meshed as the sense has it. */
  bool againstSense = false;
  /** Its boundary's FaceBoundary::foldsRepaired. */
  int foldsRepaired = 0;
};

class PartMesher {
public:
  PartMesher(const cadgeom::Model& model, const PartOptions& options);
  ~PartMesher();
  PartMesher(const PartMesher&) = delete;
  PartMesher& operator=(const PartMesher&) = delete;

  const FaceMesh& face(int f) const;
  const EdgeMesh& edges() const;
  /** The rounds of splitting run. */
  int rounds() const;
  /** The most bytes the kept verdicts took at once, as estimated (PartOptions::verdictBudget): for tests. */
  size_t verdictPeak() const;

private:
  struct Impl;
  Impl* impl_;
};

} // namespace tesscadio
