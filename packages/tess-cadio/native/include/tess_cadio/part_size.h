// A part's size, the length the longest edge's limit is a fraction of (Deflections::maxEdge; docs/triage.md's
// criterion g): what a target judging another backend's mesh by that limit must take as the part's size too (the
// module's tc_part_size), so meshing and judging agree. An estimate, within about 10 % of the box of a mesh of the
// part either way on the corpus: a face's interior is sampled coarsely, from (u, v) ranges found without the mesher's
// placement of its boundary; for a limit that is itself a fraction picked by rule, agreeing matters, not exactness.
#pragma once

#include "cad_geom/model.h"

namespace tesscadio {

/**
 * The diagonal of the part's box: its vertices; each edge's curve at 9 points over its range (where it has none, its
 * vertices' parameters on the curve); and each face's surface on a 9 x 9 grid over its loops' (u, v) box (the box of
 * its coedges' p-curves at 9 points each over their ranges, or, for a coedge without both, of its edge's points'
 * nearest feet, found locally), over the surface's domain where the face has no loops. Where a face's loops wind round
 * a periodic direction and the other isn't periodic (a sphere's cap), its box reaches the domain's side the face lies
 * toward. Faces on unbounded surfaces (planes, cylinders, cones, extrusions) are taken as bounded by their edges. The
 * (u, v) box can reach past a trimmed face's own patch, which only makes the size a little larger. 0 for a part with
 * none of these.
 */
double partSize(const cadgeom::Model& m);

} // namespace tesscadio
