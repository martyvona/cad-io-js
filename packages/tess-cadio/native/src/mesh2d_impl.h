// What mesh2d.cpp reports beyond mesh2d.h's Mesh2, for tests: private to tess-cadio.
#pragma once

#include <vector>

#include "tess_cadio/mesh2d.h"

namespace tesscadio {

struct Mesh2Detail {
  /** Steiner points refused (encroaching, outside the domain, too near a vertex), the triangles left final. */
  int refused = 0;
  int finalTriangles = 0;
};

Mesh2 mesh2Detailed(const Domain2& domain, const SizeField& field, const MeshOptions& options, Mesh2Detail* detail);

} // namespace tesscadio
