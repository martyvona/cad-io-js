// What mesh2d.cpp reports beyond mesh2d.h's Mesh2, for tests: private to tess-cadio.
#pragma once

#include <vector>

#include "tess_cadio/mesh2d.h"

namespace tesscadio {

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
};

Mesh2 mesh2Detailed(const Domain2& domain, const SizeField& field, const MeshOptions& options, Mesh2Detail* detail);

} // namespace tesscadio
