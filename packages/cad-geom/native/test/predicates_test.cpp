// predicates.h on inputs where the sign is exact and known: points exactly collinear and cocircular, then moved by an
// ulp; the classic grid of near-collinear points (Kettner, Mehlhorn, Pion, Schirra and Yap, "Classroom examples of
// robustness problems in geometric computations", 2008) where naive orient2d gives inconsistent signs and the wrapped
// one must not. The reference signs are computed exactly in 128-bit integers: every coordinate here is an integer
// times a power of two, so the determinants are integers.
#include <cad_geom/predicates.h>

#include <cmath>
#include <cstdint>

#include "check.h"

using namespace cadgeom;

namespace {

using I = __int128;

/** The exact sign of orient2d for points that are integers times 2^-e (scaled to integers). */
int exactOrient(Vec2 a, Vec2 b, Vec2 c, int e) {
  auto n = [e](double x) { return static_cast<I>(std::ldexp(x, e)); };
  I d = (n(b.x) - n(a.x)) * (n(c.y) - n(a.y)) - (n(b.y) - n(a.y)) * (n(c.x) - n(a.x));
  return (d > 0) - (d < 0);
}

/** The exact sign of incircle for integer points within 2^20 of each other (the terms fit 128 bits). */
int exactIncircle(Vec2 a, Vec2 b, Vec2 c, Vec2 d) {
  auto n = [](double x) { return static_cast<I>(x); };
  I ax = n(a.x) - n(d.x), ay = n(a.y) - n(d.y), bx = n(b.x) - n(d.x), by = n(b.y) - n(d.y), cx = n(c.x) - n(d.x),
    cy = n(c.y) - n(d.y);
  I det = (ax * ax + ay * ay) * (bx * cy - by * cx) + (bx * bx + by * by) * (cx * ay - cy * ax)
    + (cx * cx + cy * cy) * (ax * by - ay * bx);
  return (det > 0) - (det < 0);
}

int sign(double x) { return (x > 0) - (x < 0); }

double naiveOrient(Vec2 a, Vec2 b, Vec2 c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }

} // namespace

TEST_CASE("orient2d: the convention (counterclockwise positive), collinear zero") {
  CHECK(orient2d({0, 0}, {1, 0}, {0, 1}) > 0);
  CHECK(orient2d({0, 0}, {0, 1}, {1, 0}) < 0);
  CHECK_EQ(orient2d({0, 0}, {1, 1}, {3, 3}), 0.0);
  CHECK_EQ(orient2d({0.1, 0.1}, {0.2, 0.2}, {0.3, 0.3}) == 0, (exactOrient({0.1, 0.1}, {0.2, 0.2}, {0.3, 0.3}, 60)
    == 0));
}

TEST_CASE("orient2d: the grid of ulps where the naive determinant fails, every sign exact") {
  // p = (0.5 + i u, 0.5 + j u) for 0 <= i, j < 256, u = 2^-53, against the line through (12, 12) and (24, 24).
  const double u = 0x1.0p-53;
  const Vec2 q{12, 12}, r{24, 24};
  int naiveWrong = 0, wrong = 0;
  for (int i = 0; i < 256; i++)
    for (int j = 0; j < 256; j++) {
      Vec2 p{0.5 + i * u, 0.5 + j * u};
      int want = exactOrient(p, q, r, 53);
      naiveWrong += sign(naiveOrient(p, q, r)) != want;
      wrong += sign(orient2d(p, q, r)) != want;
    }
  CHECK(naiveWrong > 1000);  // the failure is real at this grid
  CHECK_EQ(wrong, 0);
}

TEST_CASE("orient2d: random near-collinear triples, moved by ulps, against the exact sign") {
  uint64_t s = 7;
  auto next = [&] { s = s * 6364136223846793005ull + 1442695040888963407ull; return s >> 11; };
  int wrong = 0;
  for (int k = 0; k < 20000; k++) {
    // Integers times 2^-40 on a line y = m x (m small rational), then c nudged by -2..2 ulps of 2^-40.
    double ax = static_cast<double>(next() % (1ull << 30)), bx = static_cast<double>(next() % (1ull << 30));
    double m = static_cast<double>(1 + next() % 7);
    Vec2 a{std::ldexp(ax, -40), std::ldexp(ax * m, -40)}, b{std::ldexp(bx, -40), std::ldexp(bx * m, -40)};
    double cx = static_cast<double>(next() % (1ull << 30));
    Vec2 c{std::ldexp(cx, -40), std::ldexp(cx * m + static_cast<double>(next() % 5) - 2, -40)};
    wrong += sign(orient2d(a, b, c)) != exactOrient(a, b, c, 40);
  }
  CHECK_EQ(wrong, 0);
}

TEST_CASE("incircle: the convention, exactly cocircular points, and an ulp in or out, far from the origin") {
  CHECK(incircle({0, 0}, {1, 0}, {0, 1}, {0.2, 0.2}) > 0);
  CHECK(incircle({0, 0}, {1, 0}, {0, 1}, {5, 5}) < 0);
  // On the circle of radius 5 about the origin, moved by 2^40 (integers, exact): (5, 0), (3, 4), (0, 5), (-4, 3).
  for (double off : {0.0, 1099511627776.0}) {
    Vec2 a{off + 5, off}, b{off + 3, off + 4}, c{off, off + 5};
    for (int dy = -1; dy <= 1; dy++) {
      Vec2 d{off - 4, off + 3 + dy};
      CHECK_EQ(sign(incircle(a, b, c, d)), exactIncircle(a, b, c, d));
    }
    CHECK_EQ(incircle(a, b, c, {off - 4, off + 3}), 0.0);
  }
  // Random integer quadruples near a big offset, nearly cocircular (Pythagorean points of radius 65, nudged).
  const int pts[][2] = {{65, 0}, {63, 16}, {60, 25}, {56, 33}, {52, 39}, {39, 52}, {33, 56}, {25, 60}, {16, 63}};
  int wrong = 0;
  for (int i = 0; i < 9; i++)
    for (int j = i + 1; j < 9; j++)
      for (int k = j + 1; k < 9; k++)
        for (int l = 0; l < 9; l++)
          for (int dy = -1; dy <= 1; dy++) {
            const double off = 1 << 20;
            Vec2 a{off + pts[i][0], off + pts[i][1]}, b{off + pts[j][0], off + pts[j][1]},
              c{off + pts[k][0], off + pts[k][1]}, d{off - pts[l][1], off + pts[l][0] + dy};
            wrong += sign(incircle(a, b, c, d)) != exactIncircle(a, b, c, d);
          }
  CHECK_EQ(wrong, 0);
}
