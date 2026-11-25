// A regular grid of seed points for an elementary face's interior (PartOptions::gridElementary): rows along v, each
// row's points evenly along u, both steps in closed form from the surface's normal curvature along its iso-lines (the
// principal directions on a plane, cylinder, cone, sphere or torus) so that a grid cell's two triangles are within the
// deflection and the angle. The mesher (mesh2d.h) inserts them as seeds and fills the band between them and the
// boundary as it fills any domain. Internal to tess-cadio.
#pragma once

#include <tess_cadio/criteria.h>
#include <tess_cadio/mesh2d.h>

#include <cad_geom/surface.h>

#include <cstddef>
#include <vector>

namespace tesscadio {

/**
 * The grid's points inside the domain d of surface s (its loops' (u, v)), each farther than half a cell from every
 * segment and point of d's boundary and interior constraints (the cell about it, its row's u step by the rows' v
 * step, meets none). The steps: along an iso-line of 3D normal curvature k, the 3D step min(hmax, 1.8 sqrt(d / |k|),
 * 0.9 angle / (sqrt 2 |k|)), hmax the face's 3D extent, or maxEdge / sqrt 2 where maxEdge > 0: a right triangle of
 * legs a and b then deviates at most (|k_u| a^2 + |k_v| b^2) / 8 <= 0.81 d and its corners' normals at most 0.9 x the
 * angle apart. Empty where the grid would have more than maxPoints points, where the surface can't be evaluated at the
 * box's middle, or where the steps leave no interior row.
 */
std::vector<cadgeom::Vec2> elementaryGrid(const cadgeom::Surface& s, const Domain2& d, const Deflections& defl,
  double maxEdge, size_t maxPoints);

} // namespace tesscadio
