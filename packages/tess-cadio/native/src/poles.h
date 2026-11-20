// A face's poles and the ring each gets (docs/own-tessellator.md, "A pole's ring"): by case, the ring's radius as
// the largest at which, together, the clearance to the boundary away from the pole is halved, the curves through the
// pole are straight within the deflection out to it, and the fans inside it pass the criteria, never under its floor
// (the deflection, or half the clearance where that's less); one radius per pole across the part's faces
// (shareRings). Internal to tess-cadio.
#pragma once

#include <tess_cadio/criteria.h>
#include <tess_cadio/edges.h>

#include <cad_geom/model.h>
#include <cad_geom/surface.h>

#include <limits>
#include <utility>
#include <vector>

namespace tesscadio {

/** One of a face's surface's poles (a pole or apex row of its singularities()) and its ring. */
struct PoleRing {
  enum class Case {
    outside,  // the face's region doesn't reach the pole's row: no ring
    natural,  // a face with no edge loops (its surface's natural extent)
    clear,    // the region reaches the pole, no model edge within the tolerance of it
    through,  // a model edge passes through the pole or within the tolerance of it
  };
  int singularity = -1;
  Case kase = Case::outside;
  /** The normals' spread just off the row (radians), and whether it's within the angle: smooth, else apex-like. */
  double spread = 0;
  bool smooth = true;
  /** The row: its fixed coordinate (u where isoU), the side of it the face is on (+1, -1), the pole's 3D point. */
  bool isoU = false;
  double at = 0, side = 1;
  cadgeom::Vec3 pole;
  /** The free coordinate's ranges where the face's boundary runs along the row (one per run). */
  std::vector<std::pair<double, double>> runs;
  /** The model edges through the pole (a sample within the tolerance of it). */
  std::vector<int> through;
  /**
   * Each incident portion's nearest approach to the pole: the edge (a model edge or a cut's pseudo-edge) and its
   * parameter there (ringCuts cuts the ring into the edge from it).
   */
  std::vector<std::pair<int, double>> approaches;
  /**
   * The limits, in 3D from the pole: half the clearance (the ring's reach at half the fixed-coordinate distance to
   * the nearest boundary point away from the pole), the through edges' straight length; the floor; what the face
   * asks (`wanted`) and what it gets once shared (`reach`), the ring's fixed-coordinate offset from the row there
   * (`radius`), and whether the floor set it.
   */
  double clearance = std::numeric_limits<double>::infinity();
  double straight = std::numeric_limits<double>::infinity();
  double floor = 0, wanted = 0, reach = 0, radius = 0;
  bool floored = false;
};

/** The ring's farthest point from the pole in 3D at fixed-coordinate offset r (over its runs). */
double ringReach(const cadgeom::Surface& s, const PoleRing& ring, double r);

/** The offset whose ring reaches `reach` (the reach grows with the offset near the pole), within the domain. */
double ringRadius(const cadgeom::Surface& s, const PoleRing& ring, double reach);

/** The pieces a run's ring is divided into at offset r: by the edge rules, the chords within the deflection, each
 * piece's tangent turning at most `angle`. */
int ringPieces(const cadgeom::Surface& s, const PoleRing& ring, std::pair<double, double> run, double r,
  double deflection, double angle);

/**
 * Face f's poles, each with the ring it asks for (wanted, reach and radius, before sharing). `criteria` judges the
 * fans (each ring piece's two ends and the pole, as the fans are meshed): accept() at a smooth pole, acceptDeviation()
 * at an apex-like one (no normal there to hold a triangle's to); `tol` the face's tolerance.
 */
std::vector<PoleRing> facePoles(const cadgeom::Model& m, int f, const cadgeom::Surface& s, const FaceBoundary& fb,
  const EdgeMesh& em, const SurfaceCriteria& criteria, double tol, double deflection, double angle);

/**
 * One reach per pole across the part's faces (poles within `tol` of one another are one): the least any face asks,
 * each face's radius again for it.
 */
void shareRings(const std::vector<const cadgeom::Surface*>& surfaces, std::vector<std::vector<PoleRing>>& rings,
  double tol);

/**
 * The ring's cuts (EdgeMesh::cutRings) into its incident edges: from each approach, each way along the edge but past
 * its ends, to where the edge first reaches the ring's reach from the pole (the edge's end where it never does). The
 * same edge, approach and reach give the same cut for every face, so faces sharing the edge agree.
 */
std::vector<RingCut> ringCuts(const EdgeMesh& em, const PoleRing& ring);

} // namespace tesscadio
