// What mesh2d.cpp reports beyond mesh2d.h's Mesh2, for tests and for the boundary decision still open (whether the
// caller is told which boundary segments refinement wanted split): private to tess-cadio until it is.
#pragma once

#include <vector>

#include "tess_cadio/mesh2d.h"

namespace tesscadio {

struct Mesh2Detail {
  /** Constrained segments (point pairs) a Steiner point would have encroached: refinement wanted them split. */
  std::vector<int32_t> splitWanted;
  /** Steiner points refused (encroaching, outside the domain, too near a vertex), the triangles left final. */
  int refused = 0;
  int finalTriangles = 0;
};

Mesh2 mesh2Detailed(const Domain2& domain, const SizeField& field, const MeshOptions& options, Mesh2Detail* detail);

} // namespace tesscadio
