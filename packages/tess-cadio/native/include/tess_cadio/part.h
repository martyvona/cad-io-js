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
  int maxSplitRounds = 48;
  /**
   * The criteria's spacing for each face's edges multiplied by this (above 1: edges coarser than the faces want,
   * left to the split rounds; for tests and tuning).
   */
  double edgeSpacingScale = 1;
  /**
   * Each face's point cap: refinement stops at max(capFloor, capMultiple x the triangles its own size metric expects
   * over its domain in (u, v)) triangles, at most capCeiling (FaceMesh::cap; as a mesher's Steiner points, mesh2d.h's
   * maxPoints, half as many), so an undulating face that needs more isn't failed while a runaway past its own metric
   * still is (the user's numbers: 200,000, 64 and 10M; 2M on phones and tablets, the caller's ceiling). The expected
   * count the integral of the criteria's graded grid's sqrt(det M) over the face's domain (SurfaceCriteria::
   * gridDensity, by rows across its boundary's loops) over sqrt(3) / 4, as countExpected's over its mesh.
   * maxPointsPerFace, where not negative, the cap itself in Steiner points instead (0: none, the boundary's mesh).
   */
  int maxPointsPerFace = -1;
  double capFloor = 200000, capMultiple = 64, capCeiling = 10000000;
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
   * Fail a face whose pole's fan folds over itself (Status::noConvergence, "a pole's fan folds over itself: N edges
   * used twice the same way"): its output welded at shipped positions, an edge with a corner within the face's
   * tolerance of a pole or apex used twice the same way (as is any used more than twice). failTurnedOver exempts
   * triangles there.
   */
  bool failFoldedFans = true;
  /**
   * Two rules against such folds, each on by default (off for tests and measuring): `consistentFans`, a fan whose
   * triangles' directions by their normals disagree has every one against the mesher's use of its ring segment;
   * `apexCorners`, at an apex a far end's corner under 1e-3 rad about it from that end is left out (a needle else).
   */
  bool consistentFans = true, apexCorners = true;
  /** The model's analysis buffer, if given (EdgeOptions::analysis: healed p-curves, tolerances past repair). */
  const uint8_t* analysis = nullptr;
  size_t analysisSize = 0;
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
   * Count each face's final triangles whose smallest angle in the metric is under minAngle (FaceMesh::thin): their
   * number, by that angle, their area, and what holds them there. Off by default; the mesh is the same either way.
   */
  bool countAngles = false;
  /**
   * Each meshed face's expected triangles from its own size metric (FaceMesh::expectedTriangles): the integral over its
   * mesh's triangles in (u, v) of the criteria's graded grid's sqrt(det M) (SurfaceCriteria::gridDensity, at each
   * triangle's centroid), over sqrt(3) / 4, an equilateral triangle of unit size in the metric. Off by default; the
   * mesh is the same either way.
   */
  bool countExpected = false;
  /**
   * Where the output's positions go as float32 minus this point (the C API's origin): the turned-over check
   * (failTurnedOver) judges each facet as shipped, its corners and normals so rounded; a needle's facet can turn in the
   * rounding alone. Not finite (the default): judged in double.
   */
  double outputOrigin[3] = {NAN, NAN, NAN};
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
  /**
   * A face meshed again after a split round, from its fourth meshing on, starts from its last mesh's points (but those
   * beside the segments split), so refinement only works near the splits and the rounds' asks settle; meshed from its
   * boundary alone again if that fails or leaves a refused triangle. Not the same mesh as meshing from the boundary
   * alone, but deterministic.
   */
  bool keepSteiner = true;
  /**
   * A triangle turned against its corners' normals as shipped (failTurnedOver's test) flipped with its neighbour
   * across an edge that isn't the boundary's, a constraint's or a ring's, where both new triangles keep their
   * orientation in (u, v), pass the criteria and face as shipped (FaceMesh::turnedFlips): a sliver within the
   * refinement floor at a boundary point off its surface turns there, which refinement neither judges nor splits.
   */
  bool flipTurned = true;
  /**
   * After every face is meshed, a triangle still turned as shipped (failTurnedOver's test) that no flip mended, its
   * apex C one of the mesher's own points and its longest edge AB a boundary span where a split at the edge's point
   * nearest C's projection would leave AP or PB under the refinement floor: C collapsed onto the nearer end of AB,
   * its triangles taking that point (FaceMesh::collapsed). Every triangle at that point rechecked for facing as
   * shipped and for its deviation (maxDeviationFactor x max(d, the face's tolerance)), the collapse undone where any
   * fails. Faces at their point cap that failCapped fails aren't tried.
   */
  bool collapseTurned = true;
};

/** FaceMesh::thinByAngle's bins: under 1, 2, 5, 8 and 10 degrees, and the rest. */
constexpr int kThinBins = 6;

/** FaceMesh::inserted's kinds: size, thinness, mesh2d's refusal kinds 0 to 7, and kept from the last mesh. */
constexpr int kInsertionKinds = 11;

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
  /**
   * With PartOptions::countAngles: its mesher's triangles whose smallest angle in the metric is under minAngle; by
   * that angle (degrees: under 1, 1 to 2, 2 to 5, 5 to 8, 8 to 10, 10 and up); their area in 3D; and how many have
   * every corner on the boundary, an edge on a frozen segment (an edge's span within the refinement floor), or lie
   * within the floor (criteria.h's belowFloor), each counted where it holds.
   */
  int thin = 0, thinByAngle[kThinBins] = {}, thinBoundary = 0, thinFrozen = 0, thinFloor = 0;
  double thinArea = 0;
  /**
   * With PartOptions::countExpected, its triangles as its own size metric expects them (0 otherwise), kept where the
   * face fails after meshing (at its point cap, turned).
   */
  double expectedTriangles = 0;
  /** Splits of its edges it still wanted when the rounds ran out. */
  int splitsWanted = 0;
  /** Its triangles turned as shipped flipped with a neighbour (PartOptions::flipTurned). */
  int turnedFlips = 0;
  /** Its triangles turned as shipped mended by PartOptions::collapseTurned. */
  int collapsed = 0;
  /**
   * The meshings (the first and each split round's) in which refinement asked for a pole ring's segment to be split,
   * which a ring's never is (it stays as the ring was cut): its triangles there refused for good.
   */
  int ringBlocked = 0;
  /**
   * Splits its refinement asked for, over its meshings, of a segment that is no edge's span, crease's segment or
   * ring's (none should be: each is a bug, its triangles there refused for good).
   */
  int splitsDropped = 0;
  /** Whether its triangles' deviation was sampled rather than bounded (SurfaceCriteria::bounded). */
  bool sampled = false;
  /**
   * A note for diagnostics where the face is meshed but not as asked (its boundary's status, refinement stopped at
   * its point cap), else empty: what seamUnsettled and capped say, in words.
   */
  std::string note;
  /** Whether a seam's side in (u, v) wasn't settled by its neighbours (FaceBoundary's Status::singular), meshed. */
  bool seamUnsettled = false;
  /** Its point cap in triangles (PartOptions::capFloor and the rest) and the expected count it came from. */
  double cap = 0, capExpected = 0;
  /** Whether refinement stopped at the point cap (maxPointsPerFace): the face failed, or kept (failCapped false). */
  bool capped = false;
  /** Its boundary's FaceBoundary::againstSense: a loop against the face's sense, meshed as the sense has it. */
  bool againstSense = false;
  /** Its boundary's FaceBoundary::holesOnly: its edge loops all holes, its surface's natural extent their outer. */
  bool holesOnly = false;
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
  /**
   * In the rounds, the poles whose rings were shrunk for a split another face asked inside them (never nearer the
   * pole than the refinement floor; a shrink undone, a face it changed failing that didn't, not counted), and the
   * faces meshed again for them, undoing included (counted each time).
   */
  int ringsShrunk() const;
  int ringFacesRemeshed() const;
  /** The most bytes the kept verdicts took at once, as estimated (PartOptions::verdictBudget): for tests. */
  size_t verdictPeak() const;

private:
  struct Impl;
  Impl* impl_;
};

} // namespace tesscadio
