// creases.h: C0 lines found by the surfaces' forms, kept by the normals' jump, clipped by the face's sides.
#include <cad_geom/creases.h>
#include <cad_geom/surface.h>

#include <cmath>
#include <vector>

#include "../src/surface_impl.h"
#include "brep_models.h"
#include "check.h"

using namespace cadgeom;

namespace {

constexpr double kDeg = M_PI / 180;

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
 * A quadratic in u with a double knot at u = 1 (C0 by its form there), linear in v over [0, 1]: its cross-section the
 * control polygon through heights z at x = 0..4, the row at v = 1 scaled by top (1: a cylinder over the section).
 */
std::unique_ptr<Surface> section(std::vector<double> z, double top = 1) {
  std::vector<std::vector<Vec3>> P;
  for (int i = 0; i < 5; i++) P.push_back({{double(i), 0, z[i]}, {double(i), 1, top * z[i]}});
  return spline(2, 1, {0, 1, 2}, {3, 2, 3}, {0, 1}, {2, 2}, P);
}

/** Every point inside the face. */
void allIn(const Vec2*, int n, int* out) {
  for (int i = 0; i < n; i++) out[i] = 0;
}

double tol9(Vec2) { return 1e-9; }

/** The angle between the unit normals just either side of u = at at v, from points of S, not its normals. */
double jumpByPoints(const Surface& s, double at, double v) {
  auto n = [&](double u0, double u1) {
    SurfacePoint a, b, c;
    s.eval(u0, v, 0, a), s.eval(u1, v, 0, b), s.eval(u0, v + 1e-4, 0, c);
    Vec3 x = cross(b.p - a.p, c.p - a.p);
    return (1 / norm(x)) * x;
  };
  return std::acos(std::fmin(1.0, dot(n(at - 1e-5, at - 1e-6), n(at + 1e-6, at + 1e-5))));
}

// trj3_s1-al #6704 face #1349 (the corpus): linear in u over a section of five segments, cubic in v; its knots at
// u = 5, 6, 7 are C0 by its form. The section turns by 19.97 degrees at 5, 14.03 at 6 and 75.96 at 7.
const int32_t k1349I[] = {1, 3, 5, 4, 5, 2, 1, 2, 2, 2, 0, 2, 1, 1, 1, 2, 4, 4};
const double k1349R[] = {
    4, 5, 6, 7, 7.25, 0, 1, -184.75848197937, 72.3948533274233, -44.5196533203125, -184.75848197937,
    73.06152000402409, -44.5196533203125, -184.75848197937, 73.7281866806249, -44.5196533203125, -184.75848197937,
    74.3948533572257, -44.5196533203125, -169.670362472534, 72.3948533274233, -50.0009250640869,
    -169.670362472534, 73.06152000402409, -50.0009250640869, -169.670362472534, 73.7281866806249,
    -50.0009250640869, -169.670362472534, 74.3948533572257, -50.0009250640869, -144.648542404175,
    72.3948533274233, -50, -144.648542404175, 73.06152000402409, -50, -144.648542404175, 73.7281866806249, -50,
    -144.648542404175, 74.3948533572257, -50, -104.648542404175, 72.3948533274233, -40, -104.648542404175,
    73.06152000402409, -40, -104.648542404175, 73.7281866806249, -40, -104.648542404175, 74.3948533572257, -40,
    -104.648542404175, 72.3948533274233, -20, -104.648542404175, 73.06152000402409, -20, -104.648542404175,
    73.7281866806249, -20, -104.648542404175, 74.3948533572257, -20, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1,
};

} // namespace

TEST_CASE("creases: a corpus face's C0 knots, kept where its section turns past the angle") {
  Status st;
  auto s = surfaces::makeBSpline(k1349R, k1349I, st);
  REQUIRE(s);
  // The section's turns from its poles (i along u, 4 a row: x and z constant along a row), independently of S.
  auto turn = [&](int i) {
    auto pole = [&](int k) { return Vec3{k1349R[7 + 12 * k], 0, k1349R[7 + 12 * k + 2]}; };
    Vec3 a = pole(i) - pole(i - 1), b = pole(i + 1) - pole(i);
    return std::acos(dot(a, b) / (norm(a) * norm(b)));
  };
  CHECK(turn(2) > 14 * kDeg && turn(2) < 14.1 * kDeg);
  std::vector<Crease> c = findCreases(*s, {4, 7.25}, {0, 1}, 15 * kDeg, allIn, tol9);
  REQUIRE(c.size() == 2);
  CHECK(c[0].isoU && c[0].at == 5 && c[1].isoU && c[1].at == 7);
  CHECK_NEAR(c[0].jump, turn(1), 0, 1e-6);
  CHECK_NEAR(c[1].jump, turn(3), 0, 1e-6);
  CHECK_NEAR(c[0].jump, 19.97 * kDeg, 0, 0.01 * kDeg);
  CHECK_NEAR(c[1].jump, 75.96 * kDeg, 0, 0.01 * kDeg);
  for (const Crease& x : c)
    CHECK(x.lo < 0 && x.lo >= -3.1e-9 && x.hi > 1 && x.hi <= 1 + 3.1e-9 && x.loOnBoundary && x.hiOnBoundary);
  // At 30 degrees the 20 degree one goes too; below 14.03 the knot at 6 stays, its jump its turn.
  CHECK_EQ(findCreases(*s, {4, 7.25}, {0, 1}, 30 * kDeg, allIn, tol9).size(), size_t(1));
  c = findCreases(*s, {4, 7.25}, {0, 1}, 0.5 * turn(2), allIn, tol9);
  REQUIRE(c.size() == 3);
  CHECK(c[1].at == 6);
  CHECK_NEAR(c[1].jump, turn(2), 1e-3, 1e-9);

}

TEST_CASE("creases: a fold kept, a tangent-continuous double knot not, the angle a strict threshold") {
  auto fold = section({0, 1, 2, 1, 0}), smooth = section({0, 1, 1.5, 2, 2});
  std::vector<Crease> c = findCreases(*fold, {0, 2}, {0, 1}, 15 * kDeg, allIn, tol9);
  REQUIRE(c.size() == 1);
  CHECK(c[0].isoU && c[0].at == 1);
  CHECK_NEAR(c[0].jump, M_PI / 2, 0, 1e-6);
  CHECK_NEAR(c[0].jump, jumpByPoints(*fold, 1, 0.5), 0, 1e-3);
  // The smooth section's knot is C0 by its form only: its normals agree to rounding.
  CHECK(findCreases(*smooth, {0, 2}, {0, 1}, 1e-4, allIn, tol9).empty());
  CHECK_EQ(findCreases(*fold, {0, 2}, {0, 1}, 89.9 * kDeg, allIn, tol9).size(), size_t(1));
  CHECK(findCreases(*fold, {0, 2}, {0, 1}, 90.1 * kDeg, allIn, tol9).empty());
  // Only lines strictly inside the box: the knot at its edge is the face's boundary.
  CHECK(findCreases(*fold, {1, 2}, {0, 1}, 15 * kDeg, allIn, tol9).empty());
  CHECK(findCreases(*fold, {0, 1}, {0, 1}, 15 * kDeg, allIn, tol9).empty());
}

TEST_CASE("creases: clipped to the face, split where the line leaves it, a boundary run dropped, ends flagged") {
  auto fold = section({0, 1, 2, 1, 0});
  // Outside for v in (0.4, 0.6): two pieces, their ends there on the boundary, past it.
  auto hole = [](const Vec2* p, int n, int* out) {
    for (int i = 0; i < n; i++) out[i] = p[i].y > 0.4 && p[i].y < 0.6 ? 1 : 0;
  };
  std::vector<Crease> c = findCreases(*fold, {0, 2}, {0, 1}, 15 * kDeg, hole, tol9);
  REQUIRE(c.size() == 2);
  CHECK(c[0].lo < 0 && c[0].hi > 0.4 + 1e-9 && c[0].hi <= 0.4 + 3.1e-9 && c[0].loOnBoundary && c[0].hiOnBoundary);
  CHECK(c[1].lo < 0.6 - 1e-9 && c[1].lo >= 0.6 - 3.1e-9 && c[1].hi > 1 && c[1].loOnBoundary && c[1].hiOnBoundary);
  // A hole holding one sample (33 / 64) alone: still two pieces.
  auto narrow = [](const Vec2* p, int n, int* out) {
    for (int i = 0; i < n; i++) out[i] = p[i].y > 0.505 && p[i].y < 0.52 ? 1 : 0;
  };
  c = findCreases(*fold, {0, 2}, {0, 1}, 15 * kDeg, narrow, tol9);
  REQUIRE(c.size() == 2);
  CHECK(c[0].hi > 0.505 && c[0].hi < 0.506 && c[1].lo < 0.52 && c[1].lo > 0.519);
  // On the boundary (within its tolerance) wherever v < 0.5, outside past 0.75: the line runs along the face's edge
  // below 0.5, so the crease is (0.5, 0.75), both its ends on the boundary.
  auto edge = [](const Vec2* p, int n, int* out) {
    for (int i = 0; i < n; i++) out[i] = p[i].y < 0.5 ? 2 : p[i].y > 0.75 ? 1 : 0;
  };
  c = findCreases(*fold, {0, 2}, {0, 1}, 15 * kDeg, edge, tol9);
  REQUIRE(c.size() == 1);
  CHECK(c[0].lo < 0.5 - 1e-9 && c[0].lo >= 0.5 - 3.1e-9 && c[0].hi > 0.75 + 1e-9 && c[0].hi <= 0.75 + 3.1e-9);
  CHECK(c[0].loOnBoundary && c[0].hiOnBoundary);
  // On the boundary throughout: the face's edge, no crease.
  auto on = [](const Vec2*, int n, int* out) {
    for (int i = 0; i < n; i++) out[i] = 2;
  };
  CHECK(findCreases(*fold, {0, 2}, {0, 1}, 15 * kDeg, on, tol9).empty());
}

TEST_CASE("creases: a fold fading out ends inside the face, where its jump is the angle") {
  // The fold's height falls to 0 at v = 1, so its jump falls to 0 along the line, from acos(2/3) at v = 0: there the
  // section's sides (1, 0, +/-1) and the tilted v-tangent (0, 1, -2) give normals (-1, 2, 1) and (1, 2, 1).
  auto fade = section({0, 1, 2, 1, 0}, 0);
  std::vector<Crease> c = findCreases(*fade, {0, 2}, {0, 1}, 45 * kDeg, allIn, tol9);
  REQUIRE(c.size() == 1);
  CHECK(c[0].loOnBoundary && !c[0].hiOnBoundary);
  CHECK(c[0].hi > 0.05 && c[0].hi < 0.95);
  CHECK_NEAR(jumpByPoints(*fade, 1, c[0].hi), 45 * kDeg, 0, 1e-3);
  CHECK_NEAR(c[0].jump, std::acos(2.0 / 3), 0, 1e-6);
  CHECK_NEAR(jumpByPoints(*fade, 1, 0), std::acos(2.0 / 3), 0, 1e-3);
  // The face ending between where the jump fades and the next sample (out there): still an end inside the face, by
  // the jump, at the same place.
  const double hi = c[0].hi, b = 0.5 * (hi + std::ceil(hi * 64) / 64);
  auto cut = [b](const Vec2* p, int n, int* out) {
    for (int i = 0; i < n; i++) out[i] = p[i].y > b ? 1 : 0;
  };
  c = findCreases(*fade, {0, 2}, {0, 1}, 45 * kDeg, cut, tol9);
  REQUIRE(c.size() == 1);
  CHECK(!c[0].hiOnBoundary && std::fabs(c[0].hi - hi) <= 1e-9);
  // Growing along the line instead: its jump the largest, at v = 1, not the first.
  auto grow = section({0, 0.1, 0.2, 0.1, 0}, 10);
  c = findCreases(*grow, {0, 2}, {0, 1}, 10 * kDeg, allIn, tol9);
  REQUIRE(c.size() == 1);
  CHECK(c[0].hi > 1 && c[0].lo > 0.01);
  CHECK_NEAR(c[0].jump, jumpByPoints(*grow, 1, 1 - 1e-4), 0, 1e-3);
}

TEST_CASE("creases: u and v lines of one surface, u lines first whatever their parameters") {
  // Linear both ways, folding along u = 1 and v = 0.5: heights h(i) + h(j), h = 0, 1, 0.
  std::vector<std::vector<Vec3>> P;
  const double h[3] = {0, 1, 0}, y[3] = {0, 0.5, 2};
  for (int i = 0; i < 3; i++) P.push_back({{double(i), y[0], h[i] + h[0]}, {double(i), y[1], h[i] + h[1]},
    {double(i), y[2], h[i] + h[2]}});
  auto s = spline(1, 1, {0, 1, 2}, {2, 1, 2}, {0, 0.5, 2}, {2, 1, 2}, P);
  std::vector<Crease> c = findCreases(*s, {0, 2}, {0, 2}, 15 * kDeg, allIn, tol9);
  REQUIRE(c.size() == 2);
  CHECK(c[0].isoU && c[0].at == 1 && !c[1].isoU && c[1].at == 0.5);
}

TEST_CASE("creases: a closed surface's seam and knots once each in a box across the seam") {
  // A square tube, linear in u through its corners (closed in fact: its first and last poles one point).
  std::vector<std::vector<Vec3>> P;
  const double xy[5][2] = {{1, 0}, {0, 1}, {-1, 0}, {0, -1}, {1, 0}};
  for (auto& q : xy) P.push_back({{q[0], q[1], 0}, {q[0], q[1], 1}});
  auto tube = closeInFact(spline(1, 1, {0, 1, 2, 3, 4}, {2, 1, 1, 1, 2}, {0, 1}, {2, 2}, P), 1e-9);
  REQUIRE(tube->domain().uPeriod == 4);
  for (double lo : {-0.5, 0.5, 7.5}) {
    std::vector<Crease> c = findCreases(*tube, {lo, lo + 4}, {0, 1}, 15 * kDeg, allIn, tol9);
    REQUIRE(c.size() == 4);
    for (int i = 0; i < 4; i++) CHECK(c[i].at == std::ceil(lo) + i && std::fabs(c[i].jump - M_PI / 2) < 1e-6);
  }
}

TEST_CASE("creases: an extrusion's and a revolution's profile breaks, an offset's its basis's") {
  // everyKind's curve 7, a polyline (0, 0, 0), (1, 0, 0), (1, 1, 1): a 90 degree turn at t = 1 seen along z.
  const fixtures::Model* fm = fixtures::model("everyKind");
  REQUIRE(fm);
  const Model m(fm->data, fm->size);
  Status st;
  const double ex[4] = {0, 0, 1, 2}, rev[6] = {-3, 0, 0, 0, 0, 1};
  auto e = surfaces::makeExtrusion(m, 7, ex, 0, st);
  REQUIRE(e);
  std::vector<Crease> c = findCreases(*e, {0, 2}, {0, 1}, 15 * kDeg, allIn, tol9);
  REQUIRE(c.size() == 1);
  CHECK(c[0].isoU && c[0].at == 1);
  CHECK_NEAR(c[0].jump, M_PI / 2, 0, 1e-6);
  auto r = surfaces::makeRevolution(m, 7, rev, 0, st);
  REQUIRE(r);
  c = findCreases(*r, {0, M_PI}, {0, 2}, 15 * kDeg, allIn, tol9);
  REQUIRE(c.size() == 1);
  CHECK(!c[0].isoU && c[0].at == 1 && c[0].jump > 30 * kDeg);
  auto o = surfaces::makeOffset(std::unique_ptr<surfaces::SurfaceImpl>(
    static_cast<surfaces::SurfaceImpl*>(section({0, 1, 2, 1, 0}).release())), 0.1);
  c = findCreases(*o, {0, 2}, {0, 1}, 15 * kDeg, allIn, tol9);
  REQUIRE(c.size() == 1);
  CHECK_NEAR(c[0].jump, M_PI / 2, 0, 1e-6);
}
