// predicates.h by Shewchuk's adaptive-precision predicates (native/third_party/predicates.c, vendored with a patch
// guarding reads past its expansions: its README.md), whose signs are exact for any double inputs barring overflow and
// underflow. exactinit() sets the file's machine constants (epsilon, splitter, the error bounds) once, at load, by a
// namespace-scope initializer: not a function-local static, whose guard every call checked (the mesher's cavities
// call these by the million). Nothing may call them from another static initializer, which could run before it.
#include "cad_geom/predicates.h"

extern "C" {
void exactinit();
double orient2d(double* pa, double* pb, double* pc);
double incircle(double* pa, double* pb, double* pc, double* pd);
}

namespace cadgeom {

namespace {
[[maybe_unused]] const bool kInitialized = (exactinit(), true);
} // namespace

double orient2d(Vec2 a, Vec2 b, Vec2 c) {
  double pa[2] = {a.x, a.y}, pb[2] = {b.x, b.y}, pc[2] = {c.x, c.y};
  return ::orient2d(pa, pb, pc);
}

double incircle(Vec2 a, Vec2 b, Vec2 c, Vec2 d) {
  double pa[2] = {a.x, a.y}, pb[2] = {b.x, b.y}, pc[2] = {c.x, c.y}, pd[2] = {d.x, d.y};
  return ::incircle(pa, pb, pc, pd);
}

} // namespace cadgeom
