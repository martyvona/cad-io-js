// Each face's expected triangles for judging any backend's mesh of it (docs/triage.md's criterion h): the count
// tess-cadio's point cap takes on the face's first meshing (FaceMesh::capExpected), found by meshing up to it
// (PartOptions::expectedOnly), so the judge and the cap share one integral over one domain.
#pragma once

#include <cstdint>
#include <utility>
#include <vector>

#include "cad_geom/model.h"
#include "tess_cadio/part.h"

namespace tesscadio {

/**
 * Each face's (face id, expected triangles) with `options` as tess-cadio would mesh the part with them, its first
 * meshing's: where the face failed before the count (its boundary, no surface), 0, no count, not 0 triangles.
 * options.expectedOnly is set here.
 */
std::vector<std::pair<uint32_t, double>> expectedCounts(const cadgeom::Model& m, PartOptions options);

} // namespace tesscadio
