// mesh2d.h on domains with known answers, each mesh checked by properties independent of how it was made: triangles
// counterclockwise, the domain's points first and unchanged, every boundary and interior segment an edge, the
// triangles' area the domain's, no triangle outside the domain or in a hole, every edge not constrained locally
// Delaunay (isotropic metric: the opposite vertex not inside the circumcircle), the same mesh twice. Then refinement
// (sizes and angles where the boundary allows), the fixed boundary's limits (the segments refinement wanted split),
// anisotropic metrics, ties (collinear and cocircular points), and input that isn't a domain. Cases named "[exact] ..."
// need exact predicates for near-degenerate input; hidden until cad-geom's predicates.h has them.
#include <tess_cadio/mesh2d.h>

#include <cmath>
#include <cstdio>
#include <map>
#include <random>
#include <set>

#include "../src/cdt.h"
#include "../src/mesh2d_impl.h"
#include "cad_geom/predicates.h"
#include "check.h"

using namespace tesscadio;
using cadgeom::Vec2;

namespace {

struct Uniform : SizeField {
  double h;
  explicit Uniform(double h_) : h(h_) {}
  Metric2 metric(Vec2) const override { return {1 / (h * h), 0, 1 / (h * h)}; }
  bool accept(const Vec2*) const override { return true; }
};
struct Stretched : SizeField {
  double hx, hy;
  Stretched(double a, double b) : hx(a), hy(b) {}
  Metric2 metric(Vec2) const override { return {1 / (hx * hx), 0, 1 / (hy * hy)}; }
  bool accept(const Vec2*) const override { return true; }
};
/** Refuses triangles with an edge longer than `max` (Euclidean): accept() driving refinement. */
struct Refuse : SizeField {
  double max;
  explicit Refuse(double m) : max(m) {}
  Metric2 metric(Vec2) const override { return {1e-12, 0, 1e-12}; }
  bool accept(const Vec2* t) const override {
    for (int i = 0; i < 3; i++)
      if (std::hypot(t[i].x - t[(i + 1) % 3].x, t[i].y - t[(i + 1) % 3].y) > max) return false;
    return true;
  }
};

double area(Vec2 a, Vec2 b, Vec2 c) { return 0.5 * ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)); }
double loopArea(const Domain2& d, const std::vector<int32_t>& l) {
  double s = 0;
  for (size_t k = 0; k < l.size(); k++) {
    Vec2 a = d.points[l[k]], b = d.points[l[(k + 1) % l.size()]];
    s += a.x * b.y - b.x * a.y;
  }
  return 0.5 * s;
}
/** Whether p is inside the domain: the loops' crossings by a ray, odd inside. */
bool insideDomain(const Domain2& d, Vec2 p) {
  bool in = false;
  for (const auto& l : d.loops)
    for (size_t k = 0; k < l.size(); k++) {
      Vec2 a = d.points[l[k]], b = d.points[l[(k + 1) % l.size()]];
      if ((a.y > p.y) != (b.y > p.y) && p.x < a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y)) in = !in;
    }
  return in;
}

/** The structural checks; their failures named. Returns the number of failures. */
int validate(const Domain2& d, const Mesh2& m, const char* what, bool delaunay = true) {
  int bad = 0;
  auto fail = [&](const std::string& s) {
    if (bad++ < 5) std::printf("  %s: %s\n", what, s.c_str());
  };
  if (m.status != cadgeom::Status::ok && m.status != cadgeom::Status::noConvergence) fail("status");
  for (size_t i = 0; i < d.points.size(); i++)
    if (i >= m.points.size() || m.points[i].x != d.points[i].x || m.points[i].y != d.points[i].y) fail("point moved");
  std::map<std::pair<int32_t, int32_t>, int> edges;  // directed edge -> triangle
  double sum = 0;
  int nt = static_cast<int>(m.triangles.size() / 3);
  for (int t = 0; t < nt; t++) {
    const int32_t* v = &m.triangles[3 * t];
    Vec2 a = m.points[v[0]], b = m.points[v[1]], c = m.points[v[2]];
    double A = area(a, b, c);
    if (!(A > 0)) fail("triangle " + std::to_string(t) + " not counterclockwise");
    sum += A;
    Vec2 g{(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3};
    if (!insideDomain(d, g)) fail("triangle outside the domain");
    for (int i = 0; i < 3; i++)
      if (!edges.emplace(std::make_pair(v[i], v[(i + 1) % 3]), t).second) fail("an edge used twice the same way");
  }
  double want = 0;
  for (const auto& l : d.loops) want += loopArea(d, l);
  if (std::fabs(sum - want) > 1e-9 * std::fabs(want))
    fail("area " + std::to_string(sum) + " want " + std::to_string(want));
  std::set<std::pair<int32_t, int32_t>> constrained;
  for (const auto& l : d.loops)
    for (size_t k = 0; k < l.size(); k++) {
      int32_t a = l[k], b = l[(k + 1) % l.size()];
      constrained.insert({std::min(a, b), std::max(a, b)});
      if (!edges.count({a, b})) fail("boundary segment " + std::to_string(a) + "-" + std::to_string(b) + " missing");
    }
  for (size_t k = 0; k + 1 < d.segments.size(); k += 2) {
    int32_t a = d.segments[k], b = d.segments[k + 1];
    constrained.insert({std::min(a, b), std::max(a, b)});
    if (!edges.count({a, b}) || !edges.count({b, a})) fail("interior segment missing");
  }
  // Locally Delaunay across every free edge (isotropic): the far vertex not strictly inside, beyond rounding.
  for (auto [e, t] : edges) {
    auto o = edges.find({e.second, e.first});
    if (!delaunay || o == edges.end() || constrained.count({std::min(e.first, e.second), std::max(e.first, e.second)}))
      continue;
    const int32_t* v = &m.triangles[3 * o->second];
    int32_t far = v[0] != e.first && v[0] != e.second ? v[0] : v[1] != e.first && v[1] != e.second ? v[1] : v[2];
    const int32_t* w = &m.triangles[3 * t];
    double s = cadgeom::incircle(m.points[w[0]], m.points[w[1]], m.points[w[2]], m.points[far]);
    Vec2 a = m.points[w[0]], b = m.points[w[1]], c = m.points[w[2]];
    double scale = std::pow(std::hypot(b.x - a.x, b.y - a.y) + std::hypot(c.x - a.x, c.y - a.y), 4);
    if (s > 1e-10 * scale) fail("edge " + std::to_string(e.first) + "-" + std::to_string(e.second) + " not Delaunay");
  }
  return bad;
}

Domain2 square(int perSide, double side = 1) {
  Domain2 d;
  std::vector<int32_t> l;
  Vec2 c[4] = {{0, 0}, {side, 0}, {side, side}, {0, side}};
  for (int s = 0; s < 4; s++)
    for (int k = 0; k < perSide; k++) {
      Vec2 a = c[s], b = c[(s + 1) % 4];
      l.push_back(static_cast<int32_t>(d.points.size()));
      d.points.push_back({a.x + (b.x - a.x) * k / perSide, a.y + (b.y - a.y) * k / perSide});
    }
  d.loops.push_back(l);
  return d;
}
/** A loop of points, appended. */
void addLoop(Domain2& d, std::vector<Vec2> pts) {
  std::vector<int32_t> l;
  for (Vec2 p : pts) l.push_back(static_cast<int32_t>(d.points.size())), d.points.push_back(p);
  d.loops.push_back(l);
}
double minAngle(const Mesh2& m, int t) {
  const int32_t* v = &m.triangles[3 * t];
  double best = M_PI;
  for (int i = 0; i < 3; i++) {
    Vec2 a = m.points[v[i]], b = m.points[v[(i + 1) % 3]], c = m.points[v[(i + 2) % 3]];
    double ux = b.x - a.x, uy = b.y - a.y, wx = c.x - a.x, wy = c.y - a.y;
    double cosine = (ux * wx + uy * wy) / (std::hypot(ux, uy) * std::hypot(wx, wy));
    best = std::min(best, std::acos(std::clamp(cosine, -1.0, 1.0)));
  }
  return best;
}
bool touchesBoundary(const Mesh2& m, int t, size_t nDomain) {
  for (int i = 0; i < 3; i++)
    if (m.triangles[3 * t + i] < static_cast<int32_t>(nDomain)) return true;
  return false;
}

} // namespace

TEST_CASE("a square with no refinement: two triangles, the domain exactly") {
  Domain2 d = square(1);
  Mesh2 m = mesh2(d, Uniform(10));
  CHECK(m.status == cadgeom::Status::ok);
  CHECK_EQ(m.triangles.size(), 6u);
  CHECK_EQ(validate(d, m, "square"), 0);
}

TEST_CASE("an L, a square with a hole, a slit: constrained, labelled, Delaunay elsewhere") {
  Domain2 L;
  addLoop(L, {{0, 0}, {2, 0}, {2, 1}, {1, 1}, {1, 2}, {0, 2}});
  CHECK_EQ(validate(L, mesh2(L, Uniform(10)), "L"), 0);
  Domain2 H = square(1, 3);
  addLoop(H, {{1, 1}, {1, 2}, {2, 2}, {2, 1}});  // clockwise: a hole
  Mesh2 mh = mesh2(H, Uniform(10));
  CHECK_EQ(validate(H, mh, "hole"), 0);
  Domain2 S = square(1, 2);
  S.points.push_back({0.5, 1});
  S.points.push_back({1.5, 1});
  S.segments = {4, 5};
  Mesh2 ms = mesh2(S, Uniform(10));
  CHECK_EQ(validate(S, ms, "slit"), 0);
  // The slit is an edge used both ways: its two sides are two triangles.
  int uses = 0;
  for (size_t i = 0; i < ms.triangles.size(); i += 3)
    for (int k = 0; k < 3; k++) {
      int32_t a = ms.triangles[i + k], b = ms.triangles[i + (k + 1) % 3];
      uses += (a == 4 && b == 5) || (a == 5 && b == 4);
    }
  CHECK_EQ(uses, 2);
}

TEST_CASE("refinement in a boundary sampled at the size: edges at most about the size, angles at least minAngle") {
  Domain2 d = square(20);
  Mesh2Detail detail;
  Mesh2 m = mesh2Detailed(d, Uniform(0.05), {}, &detail);
  CHECK(m.status == cadgeom::Status::ok);
  CHECK_EQ(validate(d, m, "refined square"), 0);
  int nt = static_cast<int>(m.triangles.size() / 3), small = 0, longEdges = 0;
  for (int t = 0; t < nt; t++) {
    if (minAngle(m, t) < 0.35 * 0.999 && !touchesBoundary(m, t, d.points.size())) small++;
    const int32_t* v = &m.triangles[3 * t];
    for (int i = 0; i < 3; i++) {
      Vec2 a = m.points[v[i]], b = m.points[v[(i + 1) % 3]];
      if (std::hypot(b.x - a.x, b.y - a.y) > 0.05 * std::sqrt(2.0) * 1.0001) longEdges++;
    }
  }
  CHECK(nt > 400);
  CHECK_EQ(small, 0);
  CHECK_EQ(longEdges, 0);
}

TEST_CASE("a boundary too coarse for the size: kept as it is, the segments refinement wanted split reported") {
  Domain2 d = square(1);
  Mesh2Detail detail;
  Mesh2 m = mesh2Detailed(d, Uniform(0.1), {}, &detail);
  CHECK(m.status == cadgeom::Status::ok);
  CHECK_EQ(validate(d, m, "coarse square"), 0);
  // All four sides wanted, and nothing split: the four corners still the only boundary points on the sides.
  std::set<std::pair<int32_t, int32_t>> want;
  for (size_t i = 0; i + 1 < detail.splitWanted.size(); i += 2)
    want.insert({detail.splitWanted[i], detail.splitWanted[i + 1]});
  CHECK(want.count({0, 1}) && want.count({1, 2}) && want.count({2, 3}) && want.count({0, 3}));
  CHECK(detail.finalTriangles > 0);
}

TEST_CASE("accept() drives refinement; what it still refuses at the end is listed") {
  // Edges under 0.2 wanted, the boundary's 0.125: met everywhere, nothing left refused.
  Domain2 d = square(8);
  Mesh2 m = mesh2(d, Refuse(0.2));
  CHECK_EQ(validate(d, m, "accept"), 0);
  CHECK(m.rejected.empty());
  // Under 0.1: the boundary's own edges can't be, so the triangles on them stay refused, each listed, and only those.
  for (double max : {0.2, 0.1}) {
    Mesh2 k = mesh2(d, Refuse(max));
    int nt = static_cast<int>(k.triangles.size() / 3);
    std::set<int32_t> listed(k.rejected.begin(), k.rejected.end());
    Refuse r(max);
    int refused = 0;
    for (int t = 0; t < nt; t++) {
      Vec2 p[3] = {k.points[k.triangles[3 * t]], k.points[k.triangles[3 * t + 1]], k.points[k.triangles[3 * t + 2]]};
      CHECK_EQ(listed.count(t) == 1, !r.accept(p));
      refused += !r.accept(p);
    }
    CHECK_EQ(refused > 0, max == 0.1);
    CHECK(nt > 100);
  }
}

TEST_CASE("an anisotropic metric: triangles stretched 100 to 1, edges about unit in it") {
  Domain2 d;
  std::vector<Vec2> pts;
  for (int k = 0; k <= 20; k++) pts.push_back({k * 0.05, 0});
  for (int k = 1; k <= 10; k++) pts.push_back({1, k * 0.001});
  for (int k = 19; k >= 0; k--) pts.push_back({k * 0.05, 0.01});
  for (int k = 9; k >= 1; k--) pts.push_back({0, k * 0.001});
  addLoop(d, pts);
  Mesh2 m = mesh2(d, Stretched(0.05, 0.001));
  CHECK(m.status == cadgeom::Status::ok);
  int nt = static_cast<int>(m.triangles.size() / 3), longer = 0;
  double sum = 0;
  for (int t = 0; t < nt; t++) {
    const int32_t* v = &m.triangles[3 * t];
    for (int i = 0; i < 3; i++) {
      Vec2 a = m.points[v[i]], b = m.points[v[(i + 1) % 3]];
      double l = std::hypot((b.x - a.x) / 0.05, (b.y - a.y) / 0.001);
      longer += l > std::sqrt(2.0) * 1.0001;
    }
    sum += area(m.points[v[0]], m.points[v[1]], m.points[v[2]]);
  }
  CHECK_EQ(longer, 0);
  CHECK_NEAR(sum, 0.01, 1e-9, 0);
}

TEST_CASE("ties: collinear runs and a cocircular grid, triangulated consistently and the same each time") {
  // A square boundary with 50 collinear points a side and a 10 x 10 grid inside (every cell four cocircular points).
  Domain2 d = square(50, 11);
  for (int i = 1; i <= 10; i++)
    for (int j = 1; j <= 10; j++) d.points.push_back({double(i), double(j)});
  // (No angle wanted: the triangulation of the ties alone, no Steiner point.)
  MeshOptions none{1000000, 0};
  Mesh2 a = mesh2(d, Uniform(100), none), b = mesh2(d, Uniform(100), none);
  CHECK_EQ(validate(d, a, "grid"), 0);
  CHECK(a.triangles == b.triangles);
  CHECK(a.points.size() == d.points.size());
}

TEST_CASE("not a domain: crossing loops, a point on a segment, duplicate points, too few points") {
  Domain2 bow;
  addLoop(bow, {{0, 0}, {1, 1}, {1, 0}, {0, 1}});  // a bow tie: two sides cross
  Mesh2 m = mesh2(bow, Uniform(1));
  CHECK(m.status == cadgeom::Status::invalidModel);
  CHECK(m.triangles.empty());
  CHECK(!m.rejected.empty());
  Domain2 on = square(1, 2);
  on.points.push_back({1, 0});  // on the bottom side, not part of it
  m = mesh2(on, Uniform(10));
  CHECK(m.status == cadgeom::Status::invalidModel);
  // The segment named, and the point on it (as a pair of itself).
  bool named = false, point = false;
  for (size_t i = 0; i + 1 < m.rejected.size(); i += 2) {
    named |= m.rejected[i] == 0 && m.rejected[i + 1] == 1;
    point |= m.rejected[i] == 4 && m.rejected[i + 1] == 4;
  }
  CHECK(named);
  CHECK(point);
  Domain2 dup = square(1);
  dup.points.push_back({0.5, 0.5});
  dup.points.push_back({0.5, 0.5});
  m = mesh2(dup, Uniform(10));
  CHECK(m.status == cadgeom::Status::invalidModel);
  CHECK_EQ(m.rejected.size(), 2u);
  Domain2 two;
  addLoop(two, {{0, 0}, {1, 0}});
  CHECK(mesh2(two, Uniform(1)).status == cadgeom::Status::invalidModel);
}

TEST_CASE("a thin wedge (1 degree): meshed, the boundary kept, refinement ends") {
  Domain2 d;
  double a = M_PI / 180;
  std::vector<Vec2> pts{{0, 0}};
  for (int k = 1; k <= 20; k++) pts.push_back({k * 0.05 * std::cos(0.0), 0});
  for (int k = 20; k >= 1; k--) pts.push_back({k * 0.05 * std::cos(a), k * 0.05 * std::sin(a)});
  addLoop(d, pts);
  Mesh2 m = mesh2(d, Uniform(0.05), {5000, 0.35});
  CHECK(m.status == cadgeom::Status::ok);
  CHECK_EQ(validate(d, m, "wedge"), 0);
}

TEST_CASE("a cap on Steiner points: noConvergence, the mesh still a valid one") {
  Domain2 d = square(10);
  Mesh2 m = mesh2(d, Uniform(0.01), {50, 0.35});
  CHECK(m.status == cadgeom::Status::noConvergence);
  CHECK_EQ(m.points.size(), d.points.size() + 50);
  CHECK_EQ(validate(d, m, "capped"), 0);
}

TEST_CASE("random star-shaped polygons with holes, refined: every mesh valid") {
  std::mt19937 rng(5);
  std::uniform_real_distribution<double> u(0.6, 1.0);
  for (int trial = 0; trial < 20; trial++) {
    Domain2 d;
    std::vector<Vec2> outer, hole;
    int n = 12 + trial;
    for (int k = 0; k < n; k++) {
      double t = 2 * M_PI * k / n, r = u(rng);
      outer.push_back({r * std::cos(t), r * std::sin(t)});
    }
    for (int k = 0; k < 6; k++) {
      double t = -2 * M_PI * k / 6;
      hole.push_back({0.2 * std::cos(t), 0.2 * std::sin(t)});
    }
    addLoop(d, outer);
    addLoop(d, hole);
    Mesh2 m = mesh2(d, Uniform(0.08));
    char what[32];
    std::snprintf(what, sizeof what, "random %d", trial);
    CHECK_EQ(validate(d, m, what), 0);
  }
}

TEST_CASE("[hidden] [exact] nearly collinear and nearly cocircular points (needs exact predicates)") {
  // Points a few ulps off a line and off a circle: plain floating point can decide these inconsistently.
  Domain2 d = square(1, 1);
  for (int k = 1; k < 40; k++) d.points.push_back({k / 40.0, 0.5 + (k % 2 ? 1 : -1) * 1e-17 * k});
  for (int k = 0; k < 40; k++) {
    double t = 2 * M_PI * k / 40;
    d.points.push_back({0.5 + 0.3 * std::cos(t) * (1 + 1e-16 * (k % 3)), 0.5 + 0.3 * std::sin(t)});
  }
  CHECK_EQ(validate(d, mesh2(d, Uniform(10)), "near-degenerate"), 0);
}

TEST_CASE("segment recovery: boundaries crowded by interior points, recovered and constrained Delaunay elsewhere") {
  // Each side's diametral circle holds interior points, so no side is a Delaunay edge until recovered (pseudo-polygons
  // of several vertices on both sides).
  Domain2 d = square(1, 1);
  for (int k = 1; k < 10; k++) {
    double x = k / 10.0;
    d.points.push_back({x, 0.02 + 0.01 * (k % 3)});
    d.points.push_back({x, 0.98 - 0.01 * (k % 2)});
    d.points.push_back({0.02 + 0.01 * (k % 2), x});
    d.points.push_back({0.97 + 0.005 * (k % 3), x});
  }
  Mesh2 m = mesh2(d, Uniform(10));
  CHECK_EQ(validate(d, m, "crowded"), 0);
  // A concave star: its inner sides cross the convex hull's Delaunay edges.
  Domain2 star;
  std::vector<Vec2> pts;
  for (int k = 0; k < 16; k++) {
    double t = 2 * M_PI * k / 16, r = k % 2 ? 0.25 : 1;
    pts.push_back({r * std::cos(t), r * std::sin(t)});
  }
  addLoop(star, pts);
  for (int k = 0; k < 30; k++) star.points.push_back({0.1 * std::cos(k), 0.1 * std::sin(k * 1.3)});
  CHECK_EQ(validate(star, mesh2(star, Uniform(10)), "star"), 0);
}

TEST_CASE("interior segments stay through refinement: a slit and a chord between boundary points") {
  Domain2 s = square(10, 2);
  int32_t a = static_cast<int32_t>(s.points.size());
  s.points.push_back({0.4, 1.1});
  s.points.push_back({1.6, 0.9});
  s.segments = {a, a + 1};
  CHECK_EQ(validate(s, mesh2(s, Uniform(0.1)), "refined slit"), 0);
  // A chord from the bottom side's point 3 to the top's point 27 (both sides of it inside).
  Domain2 c = square(10, 2);
  c.segments = {3, 27};
  CHECK_EQ(validate(c, mesh2(c, Uniform(0.1)), "refined chord"), 0);
  // An island of four interior segments: its inside reached only across them, so inside too (they don't change sides).
  Domain2 isl = square(10, 2);
  int32_t b = static_cast<int32_t>(isl.points.size());
  for (Vec2 p : {Vec2{0.8, 0.8}, Vec2{1.2, 0.8}, Vec2{1.2, 1.2}, Vec2{0.8, 1.2}}) isl.points.push_back(p);
  isl.segments = {b, b + 1, b + 1, b + 2, b + 2, b + 3, b + 3, b};
  CHECK_EQ(validate(isl, mesh2(isl, Uniform(0.1)), "island"), 0);
  Domain2 odd = square(1);
  odd.segments = {0};
  CHECK(mesh2(odd, Uniform(1)).status == cadgeom::Status::invalidModel);
}

TEST_CASE("the angle criterion alone: no size wanted, skinny triangles from interior points refined") {
  Domain2 d = square(10, 1);
  std::mt19937 rng(3);
  std::uniform_real_distribution<double> u(0.15, 0.85);
  for (int k = 0; k < 60; k++) d.points.push_back({u(rng), u(rng)});
  Mesh2 m = mesh2(d, Uniform(100));
  CHECK_EQ(validate(d, m, "angles"), 0);
  // Triangles off the loops' 40 points (the fixed boundary) all reach the minimum, the interior points' included.
  int nt = static_cast<int>(m.triangles.size() / 3), small = 0, judged = 0;
  for (int t = 0; t < nt; t++) {
    if (touchesBoundary(m, t, 40)) continue;
    judged++;
    small += minAngle(m, t) < 0.35 * 0.999;
  }
  CHECK(judged > 50);
  CHECK_EQ(small, 0);
}

TEST_CASE("a varying, rotating metric: every triangle counterclockwise, the domain covered, edges about unit in it") {
  struct Rotating : SizeField {
    Metric2 metric(Vec2 p) const override {
      // Eigenvalues 1 / 0.02^2 and 1 / 0.1^2 along directions turning with x.
      double t = 2 * p.x, c = std::cos(t), s = std::sin(t), l1 = 1 / (0.02 * 0.02), l2 = 1 / (0.1 * 0.1);
      return {l1 * c * c + l2 * s * s, (l1 - l2) * c * s, l1 * s * s + l2 * c * c};
    }
    bool accept(const Vec2*) const override { return true; }
  } field;
  Domain2 d = square(50, 1);
  Mesh2 m = mesh2(d, field);
  CHECK(m.status == cadgeom::Status::ok);
  CHECK_EQ(validate(d, m, "rotating", false), 0);
  int nt = static_cast<int>(m.triangles.size() / 3), longer = 0, interior = 0;
  for (int t = 0; t < nt; t++) {
    if (touchesBoundary(m, t, d.points.size())) continue;
    const int32_t* v = &m.triangles[3 * t];
    for (int i = 0; i < 3; i++) {
      Vec2 a = m.points[v[i]], b = m.points[v[(i + 1) % 3]], mid{(a.x + b.x) / 2, (a.y + b.y) / 2};
      Metric2 M = field.metric(mid);
      double ex = b.x - a.x, ey = b.y - a.y, l = std::sqrt(M.a * ex * ex + 2 * M.b * ex * ey + M.c * ey * ey);
      longer += l > 2.0;
      interior++;
    }
  }
  CHECK(interior > 1000);
  CHECK(longer <= interior / 100);
}

TEST_CASE("ties by simulation of simplicity: of four cocircular points, exactly one diagonal, whatever their ranks") {
  // A square's corners are cocircular: incircle is exactly 0 for each triple and the fourth.
  for (int shift = 0; shift < 4; shift++) {
    std::vector<Vec2> pts = {{0, 0}, {1, 0}, {1, 1}, {0, 1}};
    std::rotate(pts.begin(), pts.begin() + shift, pts.end());
    cdt::Triangulation T(pts);
    int32_t dup[2];
    REQUIRE(T.build(dup));
    // Counterclockwise a, b, c, d: diagonal ac is Delaunay iff d is outside abc's circle iff b is outside cda's; bd
    // likewise; exactly one of the two.
    int32_t a = 0, b = 1, c = 2, d = 3;
    if (cadgeom::orient2d(pts[0], pts[1], pts[2]) < 0) std::swap(b, d);
    bool ac = !T.inCircleSoS(a, b, c, d), ac2 = !T.inCircleSoS(c, d, a, b);
    bool bd = !T.inCircleSoS(b, c, d, a), bd2 = !T.inCircleSoS(d, a, b, c);
    CHECK_EQ(ac, ac2);
    CHECK_EQ(bd, bd2);
    CHECK(ac != bd);
    // The same answer for the triangle's vertices taken in any rotation.
    CHECK_EQ(T.inCircleSoS(a, b, c, d), T.inCircleSoS(b, c, a, d));
    CHECK_EQ(T.inCircleSoS(a, b, c, d), T.inCircleSoS(c, a, b, d));
  }
}

TEST_CASE("insertion in a metric 1000 to 1: the cavity kept star-shaped, no triangle turned over") {
  // A Euclidean Delaunay triangulation of random points, then points inserted with cavities Delaunay in a metric
  // stretched 1000 times along x: a thin ellipse across many triangles, not star-shaped from the point uncorrected.
  std::mt19937 rng(9);
  std::uniform_real_distribution<double> u(0, 1);
  std::vector<Vec2> pts;
  for (int k = 0; k < 400; k++) pts.push_back({u(rng), u(rng)});
  cdt::Triangulation T(pts);
  int32_t dup[2];
  REQUIRE(T.build(dup));
  std::vector<int32_t> created;
  // Alternately stretched along x, along y and along a diagonal, so each cavity cuts across the last ones' triangles.
  const cdt::Map2 maps[3] = {{1000, 0, 1}, {1, 0, 1000}, {30, 29, 1}};
  for (int k = 0; k < 600; k++) {
    Vec2 p{0.1 + 0.8 * u(rng), 0.1 + 0.8 * u(rng)};
    int32_t t = T.locate(p, 0);
    T.insertPoint(p, t, created, maps[k % 3]);
  }
  int inverted = 0;
  for (const cdt::Tri& R : T.tris())
    if (!R.dead && R.v[2] != cdt::kGhost)
      inverted += cadgeom::orient2d(T.points()[R.v[0]], T.points()[R.v[1]], T.points()[R.v[2]]) <= 0;
  CHECK_EQ(inverted, 0);
}
