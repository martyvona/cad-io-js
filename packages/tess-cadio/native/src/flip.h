// Mending triangles turned as shipped, over a face's mesh in (u, v): flipped with a neighbour (part.h's
// PartOptions::flipTurned), what counts as turned, accepted and barred given by the caller (part.cpp: checkFacing's
// test, the face's criteria, a corner on a crease, at a pole or two corners at one point); and the topology of
// collapsing a point onto a neighbour (PartOptions::collapseTurned; part.cpp rechecks and undoes). Internal to
// tess-cadio.
#pragma once

#include <cad_geom/vec.h>

#include <cstdint>
#include <functional>
#include <set>
#include <utility>
#include <vector>

namespace tesscadio {

/** A triangle (a, b, c), counterclockwise in (u, v): whether something holds of it. */
using TrianglePredicate = std::function<bool(int32_t, int32_t, int32_t)>;

/**
 * Each triangle of `triangles` (counterclockwise in `uv`, three indices each) that `turned` holds of, flipped across
 * the first of its edges (in its order) that allows it: not in `fixed` (each pair low index first: the boundary's,
 * a constraint's or a ring's segments), with exactly one neighbour across it, neither triangle `barred`, the new
 * diagonal not already an edge, both new triangles counterclockwise in (u, v) as the old (the quadrilateral convex
 * across it), neither `turned` and both `accepted`. Each turned triangle is tried once, in index order; a flip
 * rewrites the two triangles in place (their indices kept). A refused one among them (`rejected`: triangle indices)
 * is accepted then, both new ones passing, and leaves `rejected`. Returns the flips made.
 */
int flipTurned(const std::vector<cadgeom::Vec2>& uv, std::vector<int32_t>& triangles, std::vector<int32_t>& rejected,
  const std::set<std::pair<int32_t, int32_t>>& fixed, const TrianglePredicate& turned,
  const TrianglePredicate& accepted, const TrianglePredicate& barred);

/** A point's (u, v): false where it has none (a fan's pole). */
using UvOf = std::function<bool(int32_t, cadgeom::Vec2&)>;

/**
 * Point C of `triangles` collapsed onto its neighbour E (part.h's PartOptions::collapseTurned): every triangle at C
 * takes E, and the two that had both are to go, their indices in `gone`, highest first, for the caller to remove.
 * Only where C is in no `fixed` pair, C and E share exactly two neighbours (the result manifold), and every
 * triangle that takes E keeps the sign of its area in (u, v) (none folds over). Else false, triangles unchanged.
 */
bool collapseVertex(const UvOf& uv, std::vector<int32_t>& triangles, int32_t C, int32_t E,
  const std::set<std::pair<int32_t, int32_t>>& fixed, std::vector<size_t>& gone);

}  // namespace tesscadio
