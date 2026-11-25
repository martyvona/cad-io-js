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

TEST_CASE("foldedEdges: an edge at the pole used twice the same way counted (more than twice, once), a manifold "
  "fan none; edges away from the pole not counted") {
  // (A fan about pole 0 over ring 1-2-3, and a triangle (4, 1, 2) beyond segment 1-2.)
  const std::vector<int32_t> weld{0, 1, 2, 3, 4};
  const std::vector<char> near{1, 0, 0, 0, 0};
  // Manifold: the fan's (0, 2, 1) runs 2 -> 1, against (4, 1, 2)'s 1 -> 2.
  CHECK_EQ(foldedEdges({0, 2, 1, 0, 3, 2, 4, 1, 2}, weld, near), 0);
  // Folded: the fan's (0, 1, 2) on (4, 1, 2)'s side, 1 -> 2 twice (not at the pole: not counted) and 2 -> 0 twice
  // with the next fan triangle (counted).
  CHECK_EQ(foldedEdges({0, 1, 2, 0, 3, 2, 4, 1, 2}, weld, near), 1);
  // Away from the pole: 1 -> 2 twice, no corner at it.
  CHECK_EQ(foldedEdges({4, 1, 2, 3, 1, 2}, weld, near), 0);
  // More than twice (so twice the same way): 0 -> 1 twice and 1 -> 0 once, one edge.
  CHECK_EQ(foldedEdges({0, 1, 2, 1, 0, 3, 0, 1, 4}, weld, near), 1);
  // Welded: 3 and 1 one point, so (0, 3, 2) and (0, 1, 4) share 0 -> 1 twice.
  CHECK_EQ(foldedEdges({0, 3, 2, 0, 1, 4}, std::vector<int32_t>{0, 1, 2, 1, 4}, near), 1);
  // Two triangles each with an edge whose ends weld together (1 and 3, at the pole too): not edges, so nothing.
  CHECK_EQ(foldedEdges({0, 1, 3, 2, 1, 3}, std::vector<int32_t>{0, 1, 2, 1, 4}, std::vector<char>{1, 1, 0, 1, 0}), 0);
}

TEST_CASE("windingFaults: a face's triangles each wound as their neighbours none; one triangle's winding swapped, its "
  "edges each used twice the same way counted, anywhere; points welded as one") {
  // A fan of four triangles about centre 0 over the square 1-2-3-4, each counterclockwise.
  const std::vector<int32_t> fan{0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1}, weld{0, 1, 2, 3, 4};
  CHECK_EQ(windingFaults(fan, weld), 0);
  // (0, 3, 2) for (0, 2, 3): its edges to the centre each used twice the same way, with its neighbours'.
  std::vector<int32_t> swapped = fan;
  std::swap(swapped[4], swapped[5]);
  CHECK_EQ(windingFaults(swapped, weld), 2);
  // Point 4 a copy of point 1 as shipped (welded): (0, 4, 1) degenerate, left out; (0, 3, 4) then runs 1 -> 0
  // against (0, 1, 2)'s 0 -> 1: none.
  CHECK_EQ(windingFaults(fan, std::vector<int32_t>{0, 1, 2, 3, 1}), 0);
  // An edge used three times (a fin): counted once.
  CHECK_EQ(windingFaults({0, 1, 2, 1, 0, 3, 0, 1, 4}, std::vector<int32_t>{0, 1, 2, 3, 4}), 1);
}

TEST_CASE("sectorKeep: a fan chain's points kept where they turn one way within the sector its ends bound; a step "
  "back, one past the far end and a needle left out; a sector past half a turn whole; either direction") {
  const double d = M_PI / 180, minTurn = 1e-3;
  // Monotone, 0 -> 90 degrees: all kept.
  CHECK(sectorKeep(0, {20 * d, 45 * d, 70 * d}, 90 * d, minTurn) == (std::vector<size_t>{0, 1, 2}));
  // A step back (45 then 30): the 30 left out.
  CHECK(sectorKeep(0, {20 * d, 45 * d, 30 * d, 70 * d}, 90 * d, minTurn) == (std::vector<size_t>{0, 1, 3}));
  // Past the far end (95 before 90): left out; and one before the first end (-3).
  CHECK(sectorKeep(0, {-3 * d, 45 * d, 95 * d}, 90 * d, minTurn) == (std::vector<size_t>{1}));
  // A needle: a point a hundredth of a degree from the first end.
  CHECK(sectorKeep(0, {0.01 * d, 45 * d}, 90 * d, minTurn) == (std::vector<size_t>{1}));
  // Past half a turn, 0 -> 300 degrees round: all kept (each against the far end wrapped would drop those past 120).
  CHECK(sectorKeep(0, {60 * d, 120 * d, 180 * d, 240 * d}, 300 * d, minTurn) ==
    (std::vector<size_t>{0, 1, 2, 3}));
  // The other way round, 90 -> 0: a step back (60 then 75) left out.
  CHECK(sectorKeep(90 * d, {60 * d, 75 * d, 30 * d}, 0, minTurn) == (std::vector<size_t>{0, 2}));
  // Across +/-180 degrees the negative way, -170 -> -179 -> 179 -> 170: each step wrapped, all kept.
  CHECK(sectorKeep(-170 * d, {-179 * d, 179 * d}, 170 * d, minTurn) == (std::vector<size_t>{0, 1}));
  // No points; and no turn at all: all.
  CHECK(sectorKeep(0, {}, 90 * d, minTurn).empty());
  CHECK(sectorKeep(0, {0, 0}, 0, minTurn) == (std::vector<size_t>{0, 1}));
}
