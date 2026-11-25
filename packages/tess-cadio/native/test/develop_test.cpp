// develop.h's maps on their own: the domain's own points back to their exact (u, v), the mesher's within rounding,
// and a metric over (u, v) carried over so that every vector's length in it is its image's in the plane's.
#include "../src/develop.h"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

#include "check.h"

using namespace tesscadio;
using cadgeom::Vec2;

namespace {

/** A fixed pseudorandom stream in [0, 1) (the same on every target). */
struct Stream {
  uint64_t x = 0x9e3779b97f4a7c15ull;
  double next() {
    x ^= x << 13, x ^= x >> 7, x ^= x << 17;
    return static_cast<double>(x >> 11) / 9007199254740992.0;
  }
};

bool same(Vec2 a, Vec2 b) {
  return std::memcmp(&a.x, &b.x, sizeof a.x) == 0 && std::memcmp(&a.y, &b.y, sizeof a.y) == 0;
}

/** |d| in M. */
double len(const Metric2& M, Vec2 d) { return std::sqrt(M.a * d.x * d.x + 2 * M.b * d.x * d.y + M.c * d.y * d.y); }

} // namespace

TEST_CASE("an affine development: none by default; the domain's own points back bit for bit, the mesher's within "
  "rounding; a metric carried over so lengths are the same") {
  CHECK(!Development().active());
  // (A sheared, stretched map, as a cylinder strip's or a B-spline's mean first fundamental form gives.)
  Development dev(AffineMap{37.5, -4.25, 1});
  CHECK(dev.active());
  Stream r;
  std::vector<Vec2> own, image;
  for (int i = 0; i < 1000; i++) {
    const Vec2 uv{-3 + 7 * r.next(), 0.01 * r.next()};
    own.push_back(uv), image.push_back(dev.own(uv));
  }
  int exact = 0, near = 0;
  for (size_t i = 0; i < own.size(); i++) exact += same(dev.back(image[i]), own[i]);
  CHECK_EQ(exact, 1000);
  for (int i = 0; i < 1000; i++) {
    const Vec2 uv{-3 + 7 * r.next(), 0.01 * r.next()};
    const Vec2 b = dev.back(dev.fwd(uv));
    near += std::fabs(b.x - uv.x) <= 1e-14 * 8 && std::fabs(b.y - uv.y) <= 1e-14 * 0.01 * 8;
  }
  CHECK_EQ(near, 1000);
  // Lengths: a vector d at (u, v) in M against its image A d in the plane's metric.
  const Metric2 M{2.5, 0.75, 9};
  int kept = 0;
  for (int i = 0; i < 1000; i++) {
    const Vec2 d{r.next() - 0.5, r.next() - 0.5};
    const Vec2 Ad = dev.fwd(d);
    const double a = len(M, d), b = len(dev.metric({0, 0}, M), Ad);
    kept += std::fabs(a - b) <= 1e-12 * a;
  }
  CHECK_EQ(kept, 1000);
}
