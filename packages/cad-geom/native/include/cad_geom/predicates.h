// Robust geometric predicates in 2D: answers that are signs, computed exactly (adaptive precision), so the
// triangulator's and the classifiers' decisions never contradict each other. The sign convention is Shewchuk's
// (y up: positive is counterclockwise).
#pragma once

#include "vec.h"

namespace cadgeom {

/** Positive if a, b, c run counterclockwise, negative if clockwise, zero if collinear; the sign exact. */
double orient2d(Vec2 a, Vec2 b, Vec2 c);

/** Positive if d is inside the circle through a, b, c (counterclockwise), negative outside, zero on it; exact sign. */
double incircle(Vec2 a, Vec2 b, Vec2 c, Vec2 d);

} // namespace cadgeom
