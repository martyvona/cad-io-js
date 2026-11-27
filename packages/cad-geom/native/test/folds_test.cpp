// folds.h: the signed Jacobian's sign changes on a grid, kept where S_u x S_v vanishes, joined, clipped to the face.
#include <cad_geom/folds.h>
#include <cad_geom/surface.h>

#include <cmath>
#include <vector>

#include "../src/surface_impl.h"
#include "check.h"

using namespace cadgeom;

namespace {

/** A B-spline surface from raw values: degrees, distinct knots and multiplicities, poles[i][j] (i along u). */
std::unique_ptr<Surface> spline(int p, int q, std::vector<double> uk, std::vector<int> um, std::vector<double> vk,
  std::vector<int> vm, const std::vector<std::vector<Vec3>>& P) {
  int nu = static_cast<int>(P.size()), nv = static_cast<int>(P[0].size());
  std::vector<int32_t> in{p, q, nu, nv, static_cast<int32_t>(uk.size()), static_cast<int32_t>(vk.size()), 0, 0, 0, 0,
    0};
  in.insert(in.end(), um.begin(), um.end());
  in.insert(in.end(), vm.begin(), vm.end());
  std::vector<double> r(uk);
  r.insert(r.end(), vk.begin(), vk.end());
  for (auto& row : P)
    for (Vec3 x : row) r.insert(r.end(), {x.x, x.y, x.z});
  Status s;
  return surfaces::makeBSpline(r.data(), in.data(), s);
}

/**
 * Over u, t in [0, 1] with v = 2t - 1: (u + a v, v^2, v^3), linear in u and a cubic Bezier in t (the Bernstein
 * coefficients of v, v^2 and v^3 on [0, 1]). At v = 0 S_v = (a, 0, 0): a = 0 a cusp along the x axis (S_v vanishing,
 * a collapse), a = 1 a knife (S_v parallel to S_u, both of length 1); the normal turns back across v = 0 either way.
 * With e, + (0, 0, e u): a near knife, S_u x S_v = (-2 e v, e - 3 v^2, 2 v), (0, e, 0) at v = 0, the normal turning
 * through 180 degrees over a few e in v.
 */
std::unique_ptr<Surface> cusp(double a, double e = 0) {
  const double bv[4] = {-1, -1.0 / 3, 1.0 / 3, 1}, bv2[4] = {1, -1.0 / 3, -1.0 / 3, 1}, bv3[4] = {-1, 1, -1, 1};
  std::vector<std::vector<Vec3>> P(2);
  for (int i = 0; i < 2; i++)
    for (int j = 0; j < 4; j++) P[i].push_back({i + a * bv[j], bv2[j], bv3[j] + e * i});
  return spline(1, 3, {0, 1}, {2, 2}, {0, 1}, {4, 4}, P);
}

const auto allIn = [](const Vec2*, int n, int* side) {
  for (int i = 0; i < n; i++) side[i] = 0;
};
const auto tol9 = [](Vec2) { return 1e-9; };

} // namespace

TEST_CASE("a cusp's line (S_v vanishing along v = 0) is a collapse fold across the box, its 3D length the box's") {
  auto s = cusp(0);
  REQUIRE(s);
  std::vector<Fold> f = findFolds(*s, {0, 1}, {0, 1}, allIn, tol9);
  REQUIRE(f.size() == 1);
  CHECK(!f[0].knife);
  CHECK(f[0].uv.size() >= 60);
  for (Vec2 p : f[0].uv) CHECK(std::fabs(p.y - 0.5) <= 1e-8);
  // From one side of the box to the other, in order.
  const double lo = std::fmin(f[0].uv.front().x, f[0].uv.back().x), hi = std::fmax(f[0].uv.front().x, f[0].uv.back().x);
  CHECK(lo <= 1.0 / 64 && hi >= 1 - 1.0 / 64);
  for (size_t k = 1; k < f[0].uv.size(); k++)
    CHECK(std::fabs(f[0].uv[k].x - f[0].uv[k - 1].x) <= 1.0 / 32);
  CHECK_NEAR(f[0].length, hi - lo, 1e-6, 1e-9);
  CHECK(f[0].turn > M_PI / 2);
  // A single fold: the sheet never comes back.
  CHECK_EQ(f[0].depth, 0.0);
}

TEST_CASE("a doubled strip: S_v reversed between two folds, each fold's depth the strip's width in 3D") {
  // Flat, (u, v^3 - 0.75 v, 0) over v in [-1, 1]: y turns back at v = -0.5 (y 0.25) and on again at v = 0.5 (y
  // -0.25), the sheet three layers over 0.5 between them.
  std::vector<std::vector<Vec3>> P(2);
  const double by[4] = {-0.25, 1.25, -1.25, 0.25};
  for (int i = 0; i < 2; i++)
    for (int j = 0; j < 4; j++) P[i].push_back({double(i), by[j], 0});
  auto s = spline(1, 3, {0, 1}, {2, 2}, {0, 1}, {4, 4}, P);
  REQUIRE(s);
  std::vector<Fold> f = findFolds(*s, {0, 1}, {0, 1}, allIn, tol9);
  REQUIRE(f.size() == 2);
  for (const Fold& x : f) {
    CHECK(!x.knife);
    CHECK_NEAR(x.depth, 0.5, 1e-6, 1e-9);
  }
}

TEST_CASE("a knife (S_u and S_v parallel along v = 0, neither vanishing) is a knife fold") {
  auto s = cusp(1);
  REQUIRE(s);
  std::vector<Fold> f = findFolds(*s, {0, 1}, {0, 1}, allIn, tol9);
  REQUIRE(f.size() == 1);
  CHECK(f[0].knife);
  for (Vec2 p : f[0].uv) CHECK(std::fabs(p.y - 0.5) <= 1e-8);
  CHECK(f[0].turn > M_PI / 2);
}

TEST_CASE("a near knife (S_u x S_v small, not zero): the normal turning past 90 degrees between grid lines is one") {
  // e = 0.005 over t in [0, 0.99]: the grid's lines (0.99 / 64 apart) miss t = 0.5, the normals at the lines either
  // side about 162 degrees apart; the crossing where S_u x S_v is perpendicular to the first, |S_u x S_v| about 2 e
  // (in t, S_v twice as long), under 1e-2 of |S_v|^2.
  auto s = cusp(1, 0.005);
  REQUIRE(s);
  std::vector<Fold> f = findFolds(*s, {0, 1}, {0, 0.99}, allIn, tol9);
  REQUIRE(f.size() == 1);
  CHECK(f[0].knife);
  CHECK(f[0].turn > M_PI / 2 && f[0].turn < 0.95 * M_PI);
  for (Vec2 p : f[0].uv) CHECK(std::fabs(p.y - 0.5) <= 0.02);
  // At e = 0.5 the normal turns less than 90 degrees from one grid line to the next: no fold.
  CHECK(findFolds(*cusp(1, 0.5), {0, 1}, {0, 0.99}, allIn, tol9).empty());
}

TEST_CASE("folds kept only inside the face: the runs `inside` says are in, a run ending where the face does") {
  auto s = cusp(0);
  REQUIRE(s);
  // The face the box's left part, u < 0.4; on its boundary (2) within 0.01 of it.
  auto left = [](const Vec2* p, int n, int* side) {
    for (int i = 0; i < n; i++) side[i] = std::fabs(p[i].x - 0.4) <= 0.01 ? 2 : p[i].x < 0.4 ? 0 : 1;
  };
  std::vector<Fold> f = findFolds(*s, {0, 1}, {0, 1}, left, tol9);
  REQUIRE(f.size() == 1);
  for (Vec2 p : f[0].uv) CHECK(p.x < 0.4);
  // A face with a hole across the middle of the line: two runs.
  auto holed = [](const Vec2* p, int n, int* side) {
    for (int i = 0; i < n; i++) side[i] = p[i].x > 0.4 && p[i].x < 0.6 ? 1 : 0;
  };
  CHECK_EQ(findFolds(*s, {0, 1}, {0, 1}, holed, tol9).size(), size_t(2));
  // None in a box beside the line.
  CHECK(findFolds(*s, {0, 1}, {0, 0.4}, allIn, tol9).empty());
}

TEST_CASE("not folds: a C0 crease past 90 degrees (its normal jumps, S_u x S_v doesn't vanish), a smooth patch") {
  // Degree 1 in u through heights 0, 2, 0 at x = 0, 1, 2 (its knot at u = 0.5): normals (-2, 0, 1) and (2, 0, 1),
  // 127 degrees apart.
  auto tent = spline(1, 1, {0, 0.5, 1}, {2, 1, 2}, {0, 1}, {2, 2},
    {{{0, 0, 0}, {0, 1, 0}}, {{1, 0, 2}, {1, 1, 2}}, {{2, 0, 0}, {2, 1, 0}}});
  REQUIRE(tent);
  CHECK(findFolds(*tent, {0, 1}, {0, 1}, allIn, tol9).empty());
  auto flat = spline(1, 1, {0, 1}, {2, 2}, {0, 1}, {2, 2}, {{{0, 0, 0}, {0, 1, 0}}, {{1, 0, 0}, {1, 1, 0.3}}});
  REQUIRE(flat);
  CHECK(findFolds(*flat, {0, 1}, {0, 1}, allIn, tol9).empty());
  // A cone over both its nappes (radius 1 at v = 0, 45 degrees: its apex at v = -1): the normal turns back across the
  // apex line, but that's the surface's singularity (singularities()), not a fold.
  const double frame[] = {0, 0, 0, 0, 0, 1, 1, 0, 0};
  auto cone = surfaces::makeCone(frame, 1, 1);
  REQUIRE(cone);
  CHECK(findFolds(*cone, {0, 2 * M_PI}, {-2, 0}, allIn, tol9).empty());
  // An empty or infinite box: none.
  CHECK(findFolds(*tent, {0.5, 0.5}, {0, 1}, allIn, tol9).empty());
  CHECK(findFolds(*tent, {0, INFINITY}, {0, 1}, allIn, tol9).empty());
}
