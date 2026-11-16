// One part meshed: its edges sampled once (edges.h), each face's boundary meshed in (u, v) (mesh2d.h) against its
// criteria (criteria.h), the edges the mesher wants split split and the faces they bound meshed again, until none
// wants more or the rounds run out; then each face in 3D, its boundary points exactly its edges' samples (so faces
// meet along their edges), its normals the surface's, its triangles counterclockwise about the face's normal.
#pragma once

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
  enum Phase : uint8_t { surfaces, boxEdges, criteria, edges, meshing, splitting } phase = meshing;
  int row = 0, round = 0, facesDone = 0, facesTotal = 0;
};

struct PartOptions {
  /** The linear deflection, and the angle for faces' normals and edges' chords alike (EdgeOptions::angle). */
  Deflections d;
  /** Rounds of splitting edges and meshing their faces again. */
  int maxSplitRounds = 8;
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
   * Called as each face's meshing starts, and every so often during a long one (mesh2d.h's onWork), if set: for a
   * host to say how far a request got (a timeout). Not throttled here.
   */
  std::function<void(const PartProgress&)> progress;
};

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
   * Triangles its criteria still refuse (a fixed boundary too coarse for them; a pole's fan whose ends' spans weren't
   * split in to its ring), as indices into `triangles` / 3; those with two corners at one point left out with them.
   */
  std::vector<int32_t> rejected;
  /** Splits of its edges it still wanted when the rounds ran out. */
  int splitsWanted = 0;
  /** Whether its triangles' deviation was sampled rather than bounded (SurfaceCriteria::bounded). */
  bool sampled = false;
  /**
   * A note for diagnostics where the face is meshed but not as asked (its boundary's status, refinement stopped at
   * its point cap), else empty.
   */
  std::string note;
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

private:
  struct Impl;
  Impl* impl_;
};

} // namespace tesscadio
