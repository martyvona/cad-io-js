// predicates.h by Shewchuk's adaptive-precision predicates (native/third_party/predicates.c, vendored unmodified:
// its README.md), whose signs are exact for any double inputs barring overflow and underflow. exactinit() sets the
// file's machine constants (epsilon, splitter, the error bounds) once, before the first call, through a function-local
// static: C++ initializes those once, thread-safely.
#include "cad_geom/predicates.h"

extern "C" {
void exactinit();
double orient2d(double* pa, double* pb, double* pc);
double incircle(double* pa, double* pb, double* pc, double* pd);
}

namespace cadgeom {

namespace {
void init() {
  static const bool done = (exactinit(), true);
  (void)done;
}
} // namespace

double orient2d(Vec2 a, Vec2 b, Vec2 c) {
  init();
  double pa[2] = {a.x, a.y}, pb[2] = {b.x, b.y}, pc[2] = {c.x, c.y};
  return ::orient2d(pa, pb, pc);
}

double incircle(Vec2 a, Vec2 b, Vec2 c, Vec2 d) {
  init();
  double pa[2] = {a.x, a.y}, pb[2] = {b.x, b.y}, pc[2] = {c.x, c.y}, pd[2] = {d.x, d.y};
  return ::incircle(pa, pb, pc, pd);
}

} // namespace cadgeom
