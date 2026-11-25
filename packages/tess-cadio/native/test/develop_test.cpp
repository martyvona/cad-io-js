// develop.h's maps on their own: the domain's own points back to their exact (u, v), the mesher's within rounding,
// and a metric over (u, v) carried over so that every vector's length in it is its image's in the plane's.
#include "../src/develop.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
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

namespace {

/** The cone o + (r + v k) E(u) + v z (cad-geom's), o 0, its frame the axes. */
cadgeom::Vec3 conePoint(double r, double k, Vec2 uv) {
  const double R = r + uv.y * k;
  return {R * std::cos(uv.x), R * std::sin(uv.x), uv.y};
}

/** The cone's development from its samples, as part.cpp's developCone takes them: |S_u| at vlo and vhi, |S_v|. */
ConeMap coneMap(double r, double k, double ulo, double uhi, double vlo, double vhi) {
  return coneFromSamples(0.5 * (ulo + uhi), vlo, vhi, std::fabs(r + vlo * k), std::fabs(r + vhi * k),
    std::sqrt(1 + k * k));
}

} // namespace

TEST_CASE("a cone's development: an isometry (nearby points as far apart as on the cone), orientation kept, the "
  "domain's own points and the apex back bit for bit (the apex at a second u a collision), the mesher's within "
  "rounding, across u's seam and with v reversed; a metric carried over so lengths are the same") {
  struct Face {
    const char* what;
    double r, k, ulo, uhi, vlo, vhi;
  };
  // (Apex at v = -r / k: the first face reaches it at v = -4, the second crosses u's seam at 2 pi, the third has |R|
  // falling with v towards its apex at v = 4, the fourth is a narrow band of a wide, shallow cone.)
  for (const Face& F : {Face{"whole turn to the apex", 2, 0.5, 0, 2 * M_PI, -4, 3},
         Face{"across the seam", 2, 0.5, 5.5, 7.5, -2, 3}, Face{"v reversed", 2, -0.5, 0, 3, -3, 4},
         Face{"wide shallow band", 300, 0.05, 1, 1.4, 0, 0.25}}) {
    const ConeMap c = coneMap(F.r, F.k, F.ulo, F.uhi, F.vlo, F.vhi);
    Development dev(c);
    CHECK(dev.active());
    Stream rnd;
    auto at = [&](double s, double t) { return Vec2{F.ulo + s * (F.uhi - F.ulo), F.vlo + t * (F.vhi - F.vlo)}; };
    // Nearby points: their distance in the plane against the cone's chord (equal to second order).
    int iso = 0, oriented = 0, near = 0, exact = 0, kept = 0;
    for (int i = 0; i < 1000; i++) {
      const Vec2 p = at(rnd.next(), 0.02 + 0.96 * rnd.next());
      const Vec2 q{p.x + 1e-5 * (rnd.next() - 0.5), p.y + 1e-5 * (rnd.next() - 0.5)};
      const cadgeom::Vec3 P = conePoint(F.r, F.k, p), Q = conePoint(F.r, F.k, q);
      const Vec2 a = dev.fwd(p), b = dev.fwd(q);
      const double d3 = cadgeom::norm(Q - P), d2 = std::hypot(b.x - a.x, b.y - a.y);
      iso += std::fabs(d2 - d3) <= 1e-4 * d3;
      double J[2][2];
      c.jacobian(p, J);
      oriented += J[0][0] * J[1][1] - J[0][1] * J[1][0] > 0;
      const Vec2 back = dev.back(a);
      near += std::fabs(back.x - p.x) <= 1e-11 * (1 + std::fabs(p.x)) &&
        std::fabs(back.y - p.y) <= 1e-11 * (1 + std::fabs(p.y));
      // Lengths in a metric at p, against their images' in the carried-over one.
      const Metric2 M{2.5 + rnd.next(), 0.75 * (rnd.next() - 0.5), 9 + rnd.next()};
      const Vec2 dv{rnd.next() - 0.5, rnd.next() - 0.5};
      const Vec2 Jd{J[0][0] * dv.x + J[0][1] * dv.y, J[1][0] * dv.x + J[1][1] * dv.y};
      const double l = len(M, dv);
      kept += std::fabs(len(dev.metric(p, M), Jd) - l) <= 1e-9 * l;
    }
    // The domain's own points, the apex among them where the face reaches it.
    std::vector<Vec2> own;
    for (int i = 0; i < 1000; i++) own.push_back(at(rnd.next(), rnd.next()));
    own.push_back(at(0.5, 0)), own.push_back(at(0, 1));
    std::vector<Vec2> image;
    for (Vec2 p : own) image.push_back(dev.own(p));
    for (size_t i = 0; i < own.size(); i++) exact += same(dev.back(image[i]), own[i]);
    CHECK(!dev.collided());
    // The apex at a second u: the same image, a collision (the face meshed in (u, v)).
    if (F.vlo == -F.r / F.k) {
      dev.own(at(1, 0));
      CHECK(dev.collided());
    }
    if (iso < 1000 || oriented < 1000 || near < 1000 || kept < 1000 || exact < static_cast<int>(own.size()))
      std::printf("  %s: isometric %d, oriented %d, back near %d, lengths %d, own exact %d of %zu\n", F.what, iso,
        oriented, near, kept, exact, own.size());
    CHECK_EQ(iso, 1000);
    CHECK_EQ(oriented, 1000);
    CHECK_EQ(near, 1000);
    CHECK_EQ(kept, 1000);
    CHECK_EQ(exact, static_cast<int>(own.size()));
  }
}
