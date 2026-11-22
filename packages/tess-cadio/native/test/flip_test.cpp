// flip.h on hand-made meshes in (u, v): a square's two triangles (0, 1, 2) and (0, 2, 3), the first said turned,
// flipped to the other diagonal where every condition holds, and left where any one of them doesn't; a refused one
// leaving rejected; the triangles' indices kept. A hexagon's fan about its centre collapsed onto a corner, and not
// where the centre is fixed, the link isn't two, a triangle would fold or a point has no (u, v).
#include "../src/flip.h"

#include <algorithm>
#include <cmath>
#include <set>
#include <vector>

#include "check.h"

using namespace tesscadio;
using cadgeom::Vec2;

namespace {

bool hasEdge(const std::vector<int32_t>& T, int32_t a, int32_t b) {
  for (size_t t = 0; t + 2 < T.size(); t += 3)
    for (int k = 0; k < 3; k++)
      if ((T[t + k] == a && T[t + (k + 1) % 3] == b) || (T[t + k] == b && T[t + (k + 1) % 3] == a)) return true;
  return false;
}

/** Twice the signed area of each triangle in (u, v): all positive (counterclockwise). */
bool counterclockwise(const std::vector<Vec2>& uv, const std::vector<int32_t>& T) {
  for (size_t t = 0; t + 2 < T.size(); t += 3) {
    const Vec2 p = uv[T[t]], q = uv[T[t + 1]], r = uv[T[t + 2]];
    if (!((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) > 0)) return false;
  }
  return true;
}

struct Square {
  std::vector<Vec2> uv{{0, 0}, {1, 0}, {1, 1}, {0, 1}};
  std::vector<int32_t> T{0, 1, 2, 0, 2, 3};
  std::vector<int32_t> rejected;
  std::set<std::pair<int32_t, int32_t>> fixed{{0, 1}, {1, 2}, {2, 3}, {0, 3}};  // its boundary
  // (The first triangle turned, by its corners as a set: a flip's new triangles aren't.)
  TrianglePredicate turned = [](int32_t a, int32_t b, int32_t c) {
    std::vector<int32_t> s{a, b, c};
    std::sort(s.begin(), s.end());
    return s == std::vector<int32_t>{0, 1, 2};
  };
  TrianglePredicate accepted = [](int32_t, int32_t, int32_t) { return true; };
  TrianglePredicate barred = [](int32_t, int32_t, int32_t) { return false; };
  int run() { return flipTurned(uv, T, rejected, fixed, turned, accepted, barred); }
};

}  // namespace

TEST_CASE("a turned triangle flipped with its neighbour across their interior edge: the square's other diagonal, "
  "both counterclockwise, the indices' triangles rewritten in place") {
  Square s;
  CHECK_EQ(s.run(), 1);
  CHECK(hasEdge(s.T, 1, 3));
  CHECK(!hasEdge(s.T, 0, 2));
  CHECK(counterclockwise(s.uv, s.T));
  CHECK_EQ(s.T.size(), 6u);
  for (auto [a, b] : s.fixed) CHECK(hasEdge(s.T, a, b));
}

TEST_CASE("no flip where the quadrilateral isn't convex across the new diagonal") {
  // (Reflex at 0, then at 2: the diagonal 1-3 passes outside the quadrilateral, the one new triangle or the other
  // clockwise.)
  for (int at : {0, 2}) {
    Square s;
    s.uv[at] = at == 0 ? Vec2{0.7, 0.7} : Vec2{0.3, 0.3};
    REQUIRE(counterclockwise(s.uv, s.T));
    CHECK_EQ(s.run(), 0);
    CHECK(hasEdge(s.T, 0, 2));
  }
}

TEST_CASE("no flip where a new triangle would be turned too, or not accepted, or either is barred, or the edge is "
  "fixed") {
  {
    Square s;
    s.turned = [](int32_t a, int32_t b, int32_t c) {
      std::vector<int32_t> v{a, b, c};
      std::sort(v.begin(), v.end());
      return v == std::vector<int32_t>{0, 1, 2} || v == std::vector<int32_t>{1, 2, 3};
    };
    CHECK_EQ(s.run(), 0);
    CHECK(hasEdge(s.T, 0, 2));
  }
  {
    Square s;
    // (Neither new triangle accepted: each has the new diagonal's corners, 1 and 3.)
    s.accepted = [](int32_t a, int32_t b, int32_t c) {
      return !((a == 1 || b == 1 || c == 1) && (a == 3 || b == 3 || c == 3));
    };
    CHECK_EQ(s.run(), 0);
    CHECK(hasEdge(s.T, 0, 2));
  }
  {
    Square s;
    s.barred = [](int32_t a, int32_t b, int32_t c) { return a == 3 || b == 3 || c == 3; };  // the neighbour
    CHECK_EQ(s.run(), 0);
  }
  {
    Square s;
    s.fixed.insert({0, 2});
    CHECK_EQ(s.run(), 0);
  }
}

TEST_CASE("a refused turned triangle flipped leaves rejected, the others' entries kept") {
  Square s;
  s.uv.push_back({2, 0}), s.uv.push_back({2, 1});
  s.T.insert(s.T.end(), {1, 4, 5, 1, 5, 2});  // (a second square beside, triangles 2 and 3, untouched)
  s.fixed = {{0, 1}, {1, 2}, {2, 3}, {0, 3}, {1, 4}, {4, 5}, {2, 5}};
  s.rejected = {0, 3};
  CHECK_EQ(s.run(), 1);
  CHECK(s.rejected == std::vector<int32_t>{3});
  CHECK(hasEdge(s.T, 1, 3));
}

namespace {

/**
 * A regular hexagon's corners 1 to 6 about its centre 0 at (10, 10), the fan (0, i, i + 1) counterclockwise. (Off the
 * origin, so that a point's missing (u, v) taken as (0, 0) would judge a triangle rather than coincide with 0.)
 */
struct Hexagon {
  std::vector<Vec2> uv{{10, 10}};
  std::vector<int32_t> T;
  std::set<std::pair<int32_t, int32_t>> fixed;
  std::vector<size_t> gone;
  Hexagon() {
    for (int i = 0; i < 6; i++) uv.push_back({10 + std::cos(i * M_PI / 3), 10 + std::sin(i * M_PI / 3)});
    for (int i = 1; i <= 6; i++) T.insert(T.end(), {0, i, i % 6 + 1});
  }
  int32_t missing = -1;  // (a point with no (u, v))
  UvOf uvOf = [this](int32_t v, Vec2& out) {
    if (v < 0 || static_cast<size_t>(v) >= uv.size() || v == missing) return false;
    out = uv[v];
    return true;
  };
  bool run(int32_t C = 0, int32_t E = 1) { return collapseVertex(uvOf, T, C, E, fixed, gone); }
};

}  // namespace

TEST_CASE("a point collapsed onto a neighbour: its triangles take it, the two that had both to go, highest first; "
  "none folds") {
  Hexagon h;
  REQUIRE(h.run());
  CHECK(h.gone == (std::vector<size_t>{5, 0}));  // (0, 1, 2) and (0, 6, 1)
  for (size_t t = 0; t < 6; t++) {
    if (t == 0 || t == 5) continue;
    const int32_t* q = &h.T[3 * t];
    CHECK(q[0] == 1 || q[1] == 1 || q[2] == 1);
    CHECK(q[0] != 0 && q[1] != 0 && q[2] != 0);
  }
  std::vector<int32_t> kept;
  for (size_t t = 1; t < 5; t++) kept.insert(kept.end(), h.T.begin() + 3 * t, h.T.begin() + 3 * t + 3);
  CHECK(counterclockwise(h.uv, kept));
}

TEST_CASE("no collapse where the point is on a fixed segment, its link with the neighbour isn't two points, a "
  "triangle would fold, or a point has no (u, v); the triangles unchanged") {
  {
    Hexagon h;
    h.fixed.insert({0, 3});
    const std::vector<int32_t> before = h.T;
    CHECK(!h.run());
    CHECK(h.T == before);
    CHECK(h.gone.empty());
  }
  {
    Hexagon h;
    h.uv.push_back({13, 13});
    h.T.insert(h.T.end(), {1, 3, 7});  // (3 a neighbour of 1 besides: the collapse would join two sheets)
    const std::vector<int32_t> before = h.T;
    CHECK(!h.run());
    CHECK(h.T == before);
  }
  {
    Hexagon h;
    h.uv[2] = {10.2, 10.3};  // ((1, 2, 3) would turn clockwise)
    const std::vector<int32_t> before = h.T;
    REQUIRE(counterclockwise(h.uv, h.T));
    CHECK(!h.run());
    CHECK(h.T == before);
  }
  {
    Hexagon h;
    h.missing = 3;  // (3 has no (u, v); taken as (0, 0), its two triangles would keep their signs)
    CHECK(!h.run());
  }
}
