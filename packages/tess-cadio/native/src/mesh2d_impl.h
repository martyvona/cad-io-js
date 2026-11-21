// What mesh2d.cpp reports beyond mesh2d.h's Mesh2, for tests: private to tess-cadio.
#pragma once

#include <vector>

#include "tess_cadio/mesh2d.h"

namespace tesscadio {

enum : uint8_t { kThinBoundary = 1, kThinFrozen = 2, kThinFloor = 4 };

struct Mesh2Detail {
  /** Steiner points refused (encroaching, outside the domain, too near a vertex), the triangles left final. */
  int refused = 0;
  int finalTriangles = 0;
  /** Refused candidates not moved toward the centroid again, their cavity past mesh2d.cpp's kHalvingCavity. */
  int halvingsSkipped = 0;
  /** Refused triangles broken at their centroid instead, only much shorter segments in the way (kShortSegment). */
  int brokenInside = 0;
  /**
   * Points inserted, by what queued the triangle they broke: [0] its size in the metric, [1] its thinness alone,
   * [2 + k] refused by the caller's criteria, k its SizeField::refusalKind (0 to 7, others counted at 7).
   */
  int inserted[10] = {};
  /**
   * Triangles queued again after surviving the point inserted for them; those left past kRequeues; and at the end, the
   * triangles refinement would still queue (bad) that were neither made final nor left so: dropped, none if every
   * bad triangle is judged.
   */
  int requeued = 0, requeuesSpent = 0, leftUnjudged = 0;
  /**
   * The final triangles whose smallest angle in the metric is under MeshOptions::minAngle (clamped), by index into
   * Mesh2::triangles; that angle (radians: the arcsine of the least corner sine, for counts only); and each one's
   * flags: kThinBoundary every corner a domain point, kThinFrozen an edge a frozen segment, kThinFloor within the
   * refinement floor (SizeField::belowFloor).
   */
  std::vector<int32_t> thin;
  std::vector<double> thinAngle;
  std::vector<uint8_t> thinFlags;
};

Mesh2 mesh2Detailed(const Domain2& domain, const SizeField& field, const MeshOptions& options, Mesh2Detail* detail);

} // namespace tesscadio
