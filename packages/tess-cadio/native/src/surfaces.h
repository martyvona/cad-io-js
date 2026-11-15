// A face's surface as tess-cadio meshes it: cad-geom's, and where it closes in fact along a direction without a period
// (a B-spline closed in u or v, as Part 42 allows without a periodic form: a tube), that direction periodic with the
// range as its period and every query reduced into the range first. Its boundary's (u, v) can then run past the
// seam as on a cylinder (unwrapped, cut where it winds), and the mesher's points beyond the range still evaluate.
#pragma once

#include <memory>

#include "cad_geom/model.h"
#include "cad_geom/surface.h"

namespace tesscadio {

/** The surface at the model's row (cadgeom::makeSurface), closed directions made periodic; null as makeSurface. */
std::unique_ptr<cadgeom::Surface> faceSurface(const cadgeom::Model& m, int row, cadgeom::Status& status);

} // namespace tesscadio
