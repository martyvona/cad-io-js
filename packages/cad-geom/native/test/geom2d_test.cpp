// geom2d.h: the catalogue's 2D cases (intersect2, selfIntersect2, classify2, nest2 on the case models' faces, their
// loops built from the coedges' p-curves), then synthetic ones on curves written here (lines, arcs, 2D B-splines on
// numerics.h), independent of curve.cpp: crossings and tangencies with known answers, overlaps against near-parallel
// and near-tangent curves either side of the rule, areas, classification at tol from the boundary, periodic bands,
// pole lines, nesting.
#include <cad_geom/curve.h>
#include <cad_geom/geom2d.h>
#include <cad_geom/numerics.h>
#include <cad_geom/predicates.h>

#include <cmath>
#include <cstring>
#include <memory>
#include <vector>

#include "brep_models.h"
#include "check.h"

using namespace cadgeom;

namespace {

const double pi = 3.14159265358979323846;

// ---- Curves written here ----

class Line2 final : public Curve {
public:
  Line2(Vec2 a, Vec2 d) : a_(a), d_(d) {}
  int dim() const override { return 2; }
  CurveDomain domain() const override { return {{-INFINITY, INFINITY}, 0}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    out = {{a_.x + t * d_.x, a_.y + t * d_.y, 0}, order >= 1 ? Vec3{d_.x, d_.y, 0} : Vec3{}, {}};
    return Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status bound(Range r, Box3& out) const override {
    out = {Interval::hull(a_.x + r.lo * d_.x, a_.x + r.hi * d_.x),
      Interval::hull(a_.y + r.lo * d_.y, a_.y + r.hi * d_.y), Interval::point(0)};
    return Status::ok;
  }
  Status derivBound(Range, int order, double& out) const override {
    out = order == 1 ? std::hypot(d_.x, d_.y) : 0;
    return Status::ok;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }

private:
  Vec2 a_, d_;
};

class Arc2 final : public Curve {
public:
  Arc2(Vec2 c, double r) : c_(c), r_(r) {}
  int dim() const override { return 2; }
  CurveDomain domain() const override { return {{0, 2 * pi}, 2 * pi}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    double c = std::cos(t), s = std::sin(t);
    out = {{c_.x + r_ * c, c_.y + r_ * s, 0}, order >= 1 ? Vec3{-r_ * s, r_ * c, 0} : Vec3{},
      order >= 2 ? Vec3{-r_ * c, -r_ * s, 0} : Vec3{}};
    return Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status bound(Range, Box3& out) const override {
    out = {{c_.x - r_, c_.x + r_}, {c_.y - r_, c_.y + r_}, Interval::point(0)};
    return Status::ok;
  }
  Status derivBound(Range, int, double& out) const override {
    out = r_;
    return Status::ok;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }

private:
  Vec2 c_;
  double r_;
};

/** A 2D B-spline by numerics.h's eval (derivBound unsupported, as curve.cpp's reference). */
class Spline2 final : public Curve {
public:
  explicit Spline2(BSpline c) : c_(std::move(c)) {}
  int dim() const override { return 2; }
  CurveDomain domain() const override { return {{c_.knots[c_.degree], c_.knots[c_.poleCount()]}, 0}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    double v[6] = {};
    Status s = bspline::eval(c_, t, std::min(order, 2), v);
    out = {{v[0], v[1], 0}, {v[2], v[3], 0}, {v[4], v[5], 0}};
    return s;
  }
  void breaks(Range r, std::vector<double>& out) const override {
    out = {r.lo};
    for (double k : c_.knots)
      if (k > r.lo && k < r.hi && k != out.back()) out.push_back(k);
    out.push_back(r.hi);
  }
  Status bound(Range, Box3& out) const override {
    Interval x{INFINITY, -INFINITY}, y{INFINITY, -INFINITY};
    int w = 2 + (c_.rational ? 1 : 0);
    for (int i = 0; i < c_.poleCount(); i++) {
      x = {std::min(x.lo, c_.poles[i * w]), std::max(x.hi, c_.poles[i * w])};
      y = {std::min(y.lo, c_.poles[i * w + 1]), std::max(y.hi, c_.poles[i * w + 1])};
    }
    out = {x, y, Interval::point(0)};
    return Status::ok;
  }
  Status derivBound(Range, int, double&) const override { return Status::unsupported; }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }

private:
  BSpline c_;
};

std::vector<std::unique_ptr<Curve>> keep;  // curves the loops point at, for the test's run
const Curve* line(Vec2 a, Vec2 b) {
  keep.push_back(std::make_unique<Line2>(a, b - a));
  return keep.back().get();
}

/** A closed polygon as a loop of segments [0, 1]. */
Loop2 polygon(const std::vector<Vec2>& pts) {
  Loop2 l;
  for (size_t i = 0; i < pts.size(); i++) l.pieces.push_back({line(pts[i], pts[(i + 1) % pts.size()]), {0, 1}, false});
  return l;
}

// ---- The case models ----

/** A face's loops from its coedges' p-curves (vertex loops have none), the curves kept in `curves`. */
std::vector<Loop2> faceLoops(const Model& m, int face, std::vector<std::unique_ptr<Curve>>& curves) {
  std::vector<Loop2> out;
  for (int l = m.faceFirstLoop(face); l < m.faceFirstLoop(face) + m.faceLoopCount(face); l++) {
    Loop2 loop;
    for (int c = m.loopFirst(l); c < m.loopFirst(l) + m.loopCount(l); c++) {
      Status st;
      std::unique_ptr<Curve> curve = makeCurve(m, m.coedgePcurve(c), st);
      REQUIRE(curve);
      const double* r = m.f64(CBR_COEDGE_RANGE) + 2 * c;
      loop.pieces.push_back({curve.get(), {r[0], r[1]}, m.coedgeOrientation(c) == CBR_ORIENTATION_REVERSED});
      curves.push_back(std::move(curve));
    }
    out.push_back(std::move(loop));
  }
  return out;
}

/** The case's periods, its pole lines from the input or else from the face's surface in closed form. */
template <class C> Periods periodsOf(const C& c, const Model& m) {
  Periods p{c.periodU, c.periodV, {}, {}};
  if (c.hasPoles) {
    p.poleU.assign(c.poleU, c.poleU + c.nPoleU);
    p.poleV.assign(c.poleV, c.poleV + c.nPoleV);
    return p;
  }
  int s = m.faceSurface(c.face);
  const double* r = m.surfaceReals(s);
  if (m.surfaceKind(s) == CBR_SURFACE_CONE) p.poleV = {-r[9] / std::tan(r[10])};  // the apex: r + v tan(a) = 0
  if (m.surfaceKind(s) == CBR_SURFACE_SPHERE) p.poleV = {-pi / 2, pi / 2};
  return p;
}

bool sameCrossings(const Intersections2& got, const fixtures::ExpectedCrossing* want, int n, double ptol,
  std::string& why) {
  if (static_cast<int>(got.crossings.size()) != n) {
    why = "crossings " + std::to_string(got.crossings.size()) + ", want " + std::to_string(n);
    return false;
  }
  for (int i = 0; i < n; i++) {
    const Crossing& g = got.crossings[i];
    if (std::fabs(g.ta - want[i].ta) > ptol || std::fabs(g.tb - want[i].tb) > ptol || g.tangent != want[i].tangent
      || std::hypot(g.p.x - want[i].p.x, g.p.y - want[i].p.y) > 1e3 * ptol) {
      why = "crossing " + std::to_string(i) + ": (" + check::show(g.ta) + ", " + check::show(g.tb) + ") tangent "
        + std::to_string(g.tangent);
      return false;
    }
  }
  return true;
}
bool sameOverlaps(const Intersections2& got, const fixtures::ExpectedOverlap* want, int n, double ptol,
  std::string& why) {
  if (static_cast<int>(got.overlaps.size()) != n) {
    why = "overlaps " + std::to_string(got.overlaps.size()) + ", want " + std::to_string(n);
    return false;
  }
  for (int i = 0; i < n; i++) {
    const Overlap& g = got.overlaps[i];
    const fixtures::ExpectedOverlap& w = want[i];
    if (std::fabs(g.a.lo - w.aLo) > ptol || std::fabs(g.a.hi - w.aHi) > ptol || std::fabs(g.b.lo - w.bLo) > ptol
      || std::fabs(g.b.hi - w.bHi) > ptol || g.sameDirection != w.sameDirection) {
      why = "overlap " + std::to_string(i) + ": a [" + check::show(g.a.lo) + ", " + check::show(g.a.hi) + "] b ["
        + check::show(g.b.lo) + ", " + check::show(g.b.hi) + "] same " + std::to_string(g.sameDirection);
      return false;
    }
  }
  return true;
}

} // namespace

// ---- The catalogue ----

TEST_CASE("the catalogue: intersect2 cases") {
  int n = 0;
  for (int k = 0; k < fixtures::nReferences; k++) {
    const fixtures::Reference& r = fixtures::references[k];
    const Model m(r.data, r.size);
    for (int i = 0; i < r.nIntersect2Cases; i++) {
      const fixtures::Intersect2Case& c = r.intersect2Cases[i];
      Status st;
      std::unique_ptr<Curve> a = makeCurve(m, c.aCurve, st), b = makeCurve(m, c.bCurve, st);
      REQUIRE(a && b);
      Intersections2 x = intersect2(*a, {c.aLo, c.aHi}, *b, {c.bLo, c.bHi}, c.tol);
      std::string why;
      // Parameters to 1e-6: a tangency's point is where the gap is least, which is flat to second order there.
      bool ok = x.status == Status::ok && sameCrossings(x, c.crossings, c.nCrossings, 1e-6, why)
        && sameOverlaps(x, c.overlaps, c.nOverlaps, 1e-6, why);
      if (!ok) check::fail(__FILE__, __LINE__, std::string(c.id) + ": " + why);
      n++;
    }
  }
  CHECK_EQ(n, 4);
}

TEST_CASE("the catalogue: selfIntersect2 cases") {
  int n = 0;
  for (int k = 0; k < fixtures::nReferences; k++) {
    const fixtures::Reference& r = fixtures::references[k];
    const Model m(r.data, r.size);
    for (int i = 0; i < r.nSelfIntersect2Cases; i++) {
      const fixtures::SelfIntersect2Case& c = r.selfIntersect2Cases[i];
      std::vector<std::unique_ptr<Curve>> curves;
      std::vector<Loop2> loops = faceLoops(m, c.face, curves);
      REQUIRE(c.loop < static_cast<int>(loops.size()));
      Intersections2 x = selfIntersect2(loops[c.loop], c.tol);
      std::string why;
      bool ok = sameCrossings(x, c.crossings, c.nCrossings, 1e-6, why)
        && sameOverlaps(x, c.overlaps, c.nOverlaps, 1e-6, why);
      if (!ok) check::fail(__FILE__, __LINE__, std::string(c.id) + ": " + why);
      n++;
    }
  }
  CHECK_EQ(n, 1);
}

TEST_CASE("the catalogue: classify2 cases") {
  int n = 0;
  for (int k = 0; k < fixtures::nReferences; k++) {
    const fixtures::Reference& r = fixtures::references[k];
    const Model m(r.data, r.size);
    for (int i = 0; i < r.nClassify2Cases; i++) {
      const fixtures::Classify2Case& c = r.classify2Cases[i];
      std::vector<std::unique_ptr<Curve>> curves;
      std::vector<Loop2> loops = faceLoops(m, c.face, curves);
      Status st;
      Side got = classify2(loops, {c.p.x, c.p.y}, periodsOf(c, m), c.tol, st);
      const char* names[] = {"in", "out", "on"};
      if (got != c.side || st != Status::ok)
        check::fail(__FILE__, __LINE__, std::string(c.id) + ": " + names[static_cast<int>(got)] + ", want "
          + names[static_cast<int>(c.side)] + (st != Status::ok ? " (status not ok)" : ""));
      n++;
    }
  }
  CHECK_EQ(n, 31);
}

TEST_CASE("the catalogue: nest2 cases") {
  int n = 0;
  for (int k = 0; k < fixtures::nReferences; k++) {
    const fixtures::Reference& r = fixtures::references[k];
    const Model m(r.data, r.size);
    for (int i = 0; i < r.nNest2Cases; i++) {
      const fixtures::Nest2Case& c = r.nest2Cases[i];
      std::vector<std::unique_ptr<Curve>> curves;
      std::vector<Loop2> loops = faceLoops(m, c.face, curves);
      Status st;
      std::vector<int> got = nest2(loops, periodsOf(c, m), c.tol, st);
      std::vector<int> want(c.parents, c.parents + c.nParents);
      if (got != want || st != Status::ok) {
        std::string g;
        for (int x : got) g += std::to_string(x) + " ";
        check::fail(__FILE__, __LINE__, std::string(c.id) + ": parents " + g);
      }
      n++;
    }
  }
  CHECK_EQ(n, 4);
}

// ---- Synthetic: intersect2 ----

namespace {
Intersections2 meet(const Curve& a, Range ra, const Curve& b, Range rb, double tol = 1e-9) {
  Intersections2 x = intersect2(a, ra, b, rb, tol);
  REQUIRE(x.status == Status::ok);
  return x;
}
} // namespace

TEST_CASE("intersect2: lines crossing, parallel, collinear both ways") {
  Line2 a({0, 0}, {2, 2}), b({0, 2}, {2, -2}), c({0, 1}, {2, 2}), d({1, 1}, {1, 1}), e({3, 3}, {-1, -1});
  Intersections2 x = meet(a, {0, 1}, b, {0, 1});
  REQUIRE(x.crossings.size() == 1 && x.overlaps.empty());
  CHECK_NEAR(x.crossings[0].ta, 0.5, 0, 1e-14);
  CHECK_NEAR(x.crossings[0].tb, 0.5, 0, 1e-14);
  CHECK_NEAR(x.crossings[0].p.x, 1, 0, 1e-14);
  CHECK(!x.crossings[0].tangent);
  x = meet(a, {0, 1}, c, {0, 1});
  CHECK(x.crossings.empty() && x.overlaps.empty());
  // a over [0, 1] runs (0, 0) to (2, 2); d over [0, 2] (1, 1) to (3, 3): they share (1, 1) to (2, 2).
  x = meet(a, {0, 1}, d, {0, 2});
  REQUIRE(x.overlaps.size() == 1 && x.crossings.empty());
  CHECK_NEAR(x.overlaps[0].a.lo, 0.5, 0, 1e-8);
  CHECK_NEAR(x.overlaps[0].a.hi, 1, 0, 1e-8);
  CHECK_NEAR(x.overlaps[0].b.lo, 0, 0, 1e-8);
  CHECK_NEAR(x.overlaps[0].b.hi, 1, 0, 1e-8);
  CHECK(x.overlaps[0].sameDirection);
  // e runs back from (3, 3) to (0, 0): all of a, opposite ways, e over [1, 3].
  x = meet(a, {0, 1}, e, {0, 3});
  REQUIRE(x.overlaps.size() == 1);
  CHECK_NEAR(x.overlaps[0].a.lo, 0, 0, 1e-8);
  CHECK_NEAR(x.overlaps[0].a.hi, 1, 0, 1e-8);
  CHECK_NEAR(x.overlaps[0].b.lo, 1, 0, 1e-8);
  CHECK_NEAR(x.overlaps[0].b.hi, 3, 0, 1e-8);
  CHECK(!x.overlaps[0].sameDirection);
  // Lines meeting end to end, collinear: a point contact, not an overlap.
  Line2 f({2, 2}, {1, 1});
  x = meet(a, {0, 1}, f, {0, 1});
  CHECK(x.overlaps.empty());
  REQUIRE(x.crossings.size() == 1);
  CHECK_NEAR(x.crossings[0].ta, 1, 0, 1e-9);
  CHECK_NEAR(x.crossings[0].tb, 0, 0, 1e-9);
}

TEST_CASE("intersect2: near-parallel lines either side of the overlap rule") {
  // Two unit lines through (0.5, 0) at angle theta: within tol 1e-9 over 2e-9 / theta. At theta = 1e-12 that's the
  // whole length, and their shape (theta s, s = 0.5) separates them by 5e-13 < tol / 2: an overlap. At 1e-6 they
  // separate by 5e-7: a crossing.
  // At 4e-10 the stretch is the whole length and they separate by 2e-10: below tol / 2, an overlap (the threshold).
  for (double theta : {1e-12, 4e-10, 1e-6}) {
    Line2 a({0, 0}, {1, 0}), b({0, -0.5 * theta}, {1, theta});
    Intersections2 x = meet(a, {0, 1}, b, {0, 1});
    if (theta < 1e-9) {
      CHECK(x.overlaps.size() == 1 && x.crossings.empty());
    } else {
      REQUIRE(x.crossings.size() == 1);
      CHECK(x.overlaps.empty());
      CHECK_NEAR(x.crossings[0].ta, 0.5, 0, 1e-9);
      CHECK(!x.crossings[0].tangent);
    }
  }
}

TEST_CASE("intersect2: a circle and lines: secant, tangent, just outside, just inside") {
  Arc2 c({0, 0}, 2);
  const Range full{0, 2 * pi};
  Line2 secant({-3, 1}, {6, 0}), tangent({-3, 2}, {6, 0}), outside({-3, 2 + 2e-9}, {6, 0}),
    inside({-3, 2 - 2e-6}, {6, 0});
  Intersections2 x = meet(secant, {0, 1}, c, full);
  REQUIRE(x.crossings.size() == 2);
  const double dx = std::sqrt(3.0);
  CHECK_NEAR(x.crossings[0].p.x, -dx, 0, 1e-12);
  CHECK_NEAR(x.crossings[1].p.x, dx, 0, 1e-12);
  CHECK_NEAR(x.crossings[0].tb, pi - pi / 6, 0, 1e-12);
  CHECK(!x.crossings[0].tangent && !x.crossings[1].tangent);
  x = meet(tangent, {0, 1}, c, full);
  REQUIRE(x.crossings.size() == 1);
  CHECK(x.overlaps.empty());
  CHECK(x.crossings[0].tangent);
  CHECK_NEAR(x.crossings[0].ta, 0.5, 0, 1e-6);  // the least gap's place: flat to second order
  CHECK_NEAR(x.crossings[0].tb, pi / 2, 0, 1e-6);
  x = meet(outside, {0, 1}, c, full);
  CHECK(x.crossings.empty() && x.overlaps.empty());
  // 2e-6 inside: two crossings 2 sqrt(2 r 2e-6) = 5.7e-3 apart, near-tangent but crossing.
  x = meet(inside, {0, 1}, c, full);
  REQUIRE(x.crossings.size() == 2);
  CHECK(!x.crossings[0].tangent && !x.crossings[1].tangent);
  CHECK_NEAR(x.crossings[1].p.x - x.crossings[0].p.x, 2 * std::sqrt(2 * 2 * 2e-6 - 4e-12), 1e-6, 0);
}

TEST_CASE("intersect2 and classify2: a long line past a circle's bulge, crossing twice closer than the coarse "
  "polyline's deviation") {
  // x = -1 + h crosses the unit circle at y = +/-sqrt(2h - h^2), 0.028 apart, separating by h = 10 tol between: two
  // crossings. The line is 100 long, so the first polyline may deviate by 0.1 and holds both in one pair.
  Arc2 c({0, 0}, 1);
  const double h = 1e-4, tol = 1e-5, y = std::sqrt(2 * h - h * h);
  Line2 down({-1 + h, 50}, {0, -100});
  Intersections2 x = meet(down, {0, 1}, c, {0, 2 * pi}, tol);
  REQUIRE(x.crossings.size() == 2);
  CHECK(x.overlaps.empty());
  CHECK_NEAR(x.crossings[0].p.y, y, 0, 1e-9);
  CHECK_NEAR(x.crossings[1].p.y, -y, 0, 1e-9);
  CHECK(!x.crossings[0].tangent && !x.crossings[1].tangent);
  // Just left of the line above the bulge: out (the ray down meets the first crossing, the disk on its right).
  Loop2 disk;
  disk.pieces.push_back({&c, {0, 2 * pi}, false});
  Status st;
  CHECK(classify2({disk}, {-1 + h, 0.05}, {}, tol, st) == Side::out);
  CHECK(st == Status::ok);
  CHECK(classify2({disk}, {-1 + h, 0}, {}, tol, st) == Side::in);
}

TEST_CASE("intersect2: circles crossing, touching outside and inside, the same circle over two ranges") {
  Arc2 a({0, 0}, 1), b({1, 0}, 1), out({2, 0}, 1), in({0.5, 0}, 0.5);
  const Range full{0, 2 * pi};
  Intersections2 x = meet(a, full, b, full);
  REQUIRE(x.crossings.size() == 2);
  CHECK_NEAR(x.crossings[0].p.x, 0.5, 0, 1e-12);
  CHECK_NEAR(std::fabs(x.crossings[0].p.y), std::sqrt(0.75), 0, 1e-12);
  x = meet(a, full, out, full);
  REQUIRE(x.crossings.size() == 1);
  CHECK(x.crossings[0].tangent);
  CHECK_NEAR(x.crossings[0].p.x, 1, 0, 1e-6);
  x = meet(a, full, in, full);
  REQUIRE(x.crossings.size() == 1);
  CHECK(x.crossings[0].tangent);
  CHECK(x.overlaps.empty());
  Arc2 same({0, 0}, 1);
  x = meet(a, {0, pi}, same, {pi / 2, 3 * pi / 2});
  REQUIRE(x.overlaps.size() == 1);
  CHECK(x.crossings.empty());
  CHECK_NEAR(x.overlaps[0].a.lo, pi / 2, 0, 1e-8);
  CHECK_NEAR(x.overlaps[0].a.hi, pi, 0, 1e-8);
  CHECK_NEAR(x.overlaps[0].b.lo, pi / 2, 0, 1e-8);
  CHECK_NEAR(x.overlaps[0].b.hi, pi, 0, 1e-8);
  CHECK(x.overlaps[0].sameDirection);
}

TEST_CASE("intersect2: a B-spline (no derivative bound) against lines: crossings and a tangency") {
  // The quadratic Bezier (-1, 1), (0, -1), (1, 1): y = 2 x^2 - 1 at x = 2 t - 1... its lowest point (0, 0) at t = 1/2.
  BSpline q;
  q.degree = 2;
  q.dim = 2;
  q.knots = {0, 0, 0, 1, 1, 1};
  q.poles = {-1, 1, 0, -1, 1, 1};
  Spline2 s(q);
  Line2 across({-2, 0.5}, {4, 0}), touch({-2, 0}, {4, 0});
  Intersections2 x = meet(s, {0, 1}, across, {0, 1});
  REQUIRE(x.crossings.size() == 2);
  // y(t) = (1 - t)^2 - 2 t (1 - t) + t^2 = 4 t^2 - 4 t + 1 = (2t - 1)^2: 0.5 at t = 1/2 -+ sqrt(0.5) / 2.
  CHECK_NEAR(x.crossings[0].ta, 0.5 - std::sqrt(0.5) / 2, 0, 1e-12);
  CHECK_NEAR(x.crossings[1].ta, 0.5 + std::sqrt(0.5) / 2, 0, 1e-12);
  x = meet(s, {0, 1}, touch, {0, 1});
  REQUIRE(x.crossings.size() == 1);
  CHECK(x.crossings[0].tangent);
  CHECK_NEAR(x.crossings[0].ta, 0.5, 0, 1e-6);
}

TEST_CASE("intersect2: refused arguments") {
  Line2 a({0, 0}, {1, 0});
  CHECK(intersect2(a, {0, 1}, a, {0, 1}, 0).status == Status::invalidModel);
  CHECK(intersect2(a, {1, 0}, a, {0, 1}, 1e-9).status == Status::invalidModel);
}

// ---- Synthetic: loops ----

TEST_CASE("signedArea2: squares both ways, a disc, a half disc, a loop closed across a gap") {
  CHECK_NEAR(signedArea2(polygon({{0, 0}, {2, 0}, {2, 1}, {0, 1}})).value, 2, 1e-14, 0);
  CHECK_NEAR(signedArea2(polygon({{0, 0}, {0, 1}, {2, 1}, {2, 0}})).value, -2, 1e-14, 0);
  Arc2 c({3, -1}, 2);
  Loop2 disc{{{&c, {0, 2 * pi}, false}}};
  Estimate e = signedArea2(disc);
  CHECK(e.status == Status::ok);
  CHECK_NEAR(e.value, 4 * pi, 1e-12, 0);
  CHECK(std::fabs(e.value - 4 * pi) <= e.error + 1e-12);
  Loop2 back{{{&c, {0, 2 * pi}, true}}};
  CHECK_NEAR(signedArea2(back).value, -4 * pi, 1e-12, 0);
  Loop2 half{{{&c, {0, pi}, false}, {line({1, -1}, {5, -1}), {0, 1}, false}}};
  CHECK_NEAR(signedArea2(half).value, 2 * pi, 1e-12, 0);
  // Three sides of a square: the chord from the last end to the first start closes it.
  // Away from the origin, so the chord's own contribution isn't 0.
  Loop2 open{{{line({5, 3}, {6, 3}), {0, 1}, false}, {line({6, 3}, {6, 4}), {0, 1}, false},
    {line({6, 4}, {5, 4}), {0, 1}, false}}};
  CHECK_NEAR(signedArea2(open).value, 1, 1e-13, 0);
}

TEST_CASE("classify2: a square with a hole: in, out, on within tol either side, vertices, rays through corners") {
  std::vector<Loop2> face{polygon({{0, 0}, {2, 0}, {2, 2}, {0, 2}}), polygon({{0.5, 0.5}, {0.5, 1}, {1, 1}, {1, 0.5}})};
  const double tol = 1e-9;
  auto side = [&](Vec2 p) {
    Status st;
    Side s = classify2(face, p, {}, tol, st);
    CHECK(st == Status::ok);
    return s;
  };
  CHECK(side({1.5, 1.5}) == Side::in);
  CHECK(side({0.75, 0.75}) == Side::out);  // in the hole
  CHECK(side({3, 1}) == Side::out);
  CHECK(side({-1, -1}) == Side::out);
  CHECK(side({2 + 0.5 * tol, 1}) == Side::on);
  CHECK(side({2 - 0.5 * tol, 1}) == Side::on);
  CHECK(side({2 + 2 * tol, 1}) == Side::out);
  CHECK(side({2 - 2 * tol, 1}) == Side::in);
  CHECK(side({0, 0}) == Side::on);
  CHECK(side({1, 0.75}) == Side::on);  // the hole's side
  CHECK(side({1 + 2 * tol, 0.75}) == Side::in);
  CHECK(side({1 - 2 * tol, 0.75}) == Side::out);
  // Vertical rays from these meet the hole's corners first: retried with another direction.
  CHECK(side({0.5, 0.25}) == Side::in);
  CHECK(side({1, 1.5}) == Side::in);
  CHECK(side({0.75, 0.25}) == Side::in);  // its ray meets the hole's bottom first
  Status st;
  CHECK(classify2({}, {5, 5}, {}, tol, st) == Side::in);  // no loops: the whole surface
}

TEST_CASE("classify2: a periodic band, its copies and its boundary") {
  // On a cylinder (u periodic): v = 0 to the right, v = 2 back: the band between.
  std::vector<Loop2> band{Loop2{{{line({0, 0}, {2 * pi, 0}), {0, 1}, false}}},
    Loop2{{{line({2 * pi, 2}, {0, 2}), {0, 1}, false}}}};
  Periods per{2 * pi, 0, {}, {}};
  auto side = [&](Vec2 p) {
    Status st;
    Side s = classify2(band, p, per, 1e-9, st);
    CHECK(st == Status::ok);
    return s;
  };
  CHECK(side({3, 1}) == Side::in);
  CHECK(side({3, 3}) == Side::out);
  CHECK(side({3, -0.5}) == Side::out);
  CHECK(side({-1, 1}) == Side::in);
  CHECK(side({7, 1}) == Side::in);
  CHECK(side({2 * pi, 1}) == Side::in);
  CHECK(side({0, 1}) == Side::in);
  CHECK(side({3, 2}) == Side::on);
  CHECK(side({-20, 0}) == Side::on);
  Status st;
  std::vector<int> parents = nest2(band, per, 1e-9, st);
  CHECK(st == Status::ok);
  CHECK(parents == (std::vector<int>{-1, -1}));
}

TEST_CASE("classify2: a cone's face reaching its apex line, with and without the pole line given") {
  // u periodic, the apex at v = -1: up the seam at 2 pi, back along the base v = 0, down the seam at 0; the loop
  // jumps along v = -1 from (0, -1) to (2 pi, -1).
  std::vector<Loop2> cone{Loop2{{{line({2 * pi, -1}, {2 * pi, 0}), {0, 1}, false},
    {line({2 * pi, 0}, {0, 0}), {0, 1}, false}, {line({0, 0}, {0, -1}), {0, 1}, false}}}};
  Periods per{2 * pi, 0, {}, {-1}};
  auto side = [&](Vec2 p) {
    Status st;
    Side s = classify2(cone, p, per, 1e-9, st);
    CHECK(st == Status::ok);
    return s;
  };
  CHECK(side({1, -1}) == Side::on);
  CHECK(side({5, -1}) == Side::on);
  CHECK(side({1, -0.5}) == Side::in);
  CHECK(side({1, 0.5}) == Side::out);
  CHECK(side({1, -1.5}) == Side::out);  // past the apex
  CHECK(side({1, 0}) == Side::on);
  Status st;
  CHECK(nest2(cone, per, 1e-9, st) == (std::vector<int>{-1}));
}

TEST_CASE("nest2: nested squares, siblings, a hole in a band") {
  Status st;
  std::vector<Loop2> nested{polygon({{0, 0}, {10, 0}, {10, 10}, {0, 10}}), polygon({{1, 1}, {1, 9}, {9, 9}, {9, 1}}),
    polygon({{2, 2}, {8, 2}, {8, 8}, {2, 8}})};
  CHECK(nest2(nested, {}, 1e-9, st) == (std::vector<int>{-1, 0, 1}));
  CHECK(st == Status::ok);
  std::vector<Loop2> siblings{polygon({{0, 0}, {10, 0}, {10, 10}, {0, 10}}), polygon({{1, 1}, {1, 4}, {4, 4}, {4, 1}}),
    polygon({{6, 6}, {6, 9}, {9, 9}, {9, 6}})};
  CHECK(nest2(siblings, {}, 1e-9, st) == (std::vector<int>{-1, 0, 0}));
  // Listed innermost first: the parent is the smallest container.
  std::vector<Loop2> reversed{nested[2], nested[1], nested[0]};
  CHECK(nest2(reversed, {}, 1e-9, st) == (std::vector<int>{1, 2, -1}));
  std::vector<Loop2> holed{Loop2{{{line({0, 0}, {2 * pi, 0}), {0, 1}, false}}},
    Loop2{{{line({2 * pi, 2}, {0, 2}), {0, 1}, false}}}, polygon({{1, 0.5}, {1, 1.5}, {2, 1.5}, {2, 0.5}})};
  CHECK(nest2(holed, {2 * pi, 0, {}, {}}, 1e-9, st) == (std::vector<int>{-1, -1, -1}));
}

TEST_CASE("selfIntersect2: a figure eight crosses, a square doesn't, a pinched loop touches") {
  Intersections2 x = selfIntersect2(polygon({{0, 0}, {2, 2}, {2, 0}, {0, 2}}), 1e-9);
  REQUIRE(x.crossings.size() == 1);
  CHECK(!x.crossings[0].tangent);
  CHECK_NEAR(x.crossings[0].ta, 0.5, 0, 1e-12);  // piece 0 halfway
  CHECK_NEAR(x.crossings[0].tb, 2.5, 0, 1e-12);  // piece 2 halfway
  CHECK_NEAR(x.crossings[0].p.x, 1, 0, 1e-12);
  x = selfIntersect2(polygon({{0, 0}, {1, 0}, {1, 1}, {0, 1}}), 1e-9);
  CHECK(x.crossings.empty() && x.overlaps.empty());
  // Through (1, 1) twice, touching: two squares sharing a corner, as one loop.
  x = selfIntersect2(polygon({{0, 0}, {1, 0}, {1, 1}, {2, 1}, {2, 2}, {1, 2}, {1, 1}, {0, 1}}), 1e-9);
  REQUIRE(x.crossings.size() == 1);
  CHECK(x.crossings[0].tangent);
  CHECK_NEAR(x.crossings[0].ta, 2, 0, 1e-12);
  CHECK_NEAR(x.crossings[0].tb, 6, 0, 1e-12);
  // Through (1, 1) twice as two V's, one opening down and one up: touching.
  x = selfIntersect2(polygon({{0, 0}, {1, 1}, {2, 0}, {2, 2}, {1, 1}, {0, 2}}), 1e-9);
  REQUIRE(x.crossings.size() == 1);
  CHECK(x.crossings[0].tangent);
  // Through (1, 1) twice, crossing: straight on from (0, 0) to (2, 2), then across from (2, 0) to (0, 2).
  x = selfIntersect2(polygon({{0, 0}, {1, 1}, {2, 2}, {2, 0}, {1, 1}, {0, 2}}), 1e-9);
  REQUIRE(x.crossings.size() == 1);
  CHECK(!x.crossings[0].tangent);
  CHECK_NEAR(x.crossings[0].ta, 1, 0, 1e-12);
  CHECK_NEAR(x.crossings[0].tb, 4, 0, 1e-12);
}

TEST_CASE("intersect2: many crossings close together, each found") {
  // y = 0.01 sin(40 pi x) against y = 0 over x in (0.01, 0.99): crossings at x = k / 40, k = 1..39.
  class Wave final : public Curve {
  public:
    int dim() const override { return 2; }
    CurveDomain domain() const override { return {{0, 1}, 0}; }
    Status eval(double t, int, CurvePoint& out) const override {
      double w = 40 * pi;
      out = {{t, 0.01 * std::sin(w * t), 0}, {1, 0.01 * w * std::cos(w * t), 0},
        {0, -0.01 * w * w * std::sin(w * t), 0}};
      return Status::ok;
    }
    void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
    Status bound(Range, Box3& out) const override {
      out = {{0, 1}, {-0.01, 0.01}, Interval::point(0)};
      return Status::ok;
    }
    Status derivBound(Range, int, double&) const override { return Status::unsupported; }
    void singular(Range, std::vector<double>& out) const override { out.clear(); }
  } wave;
  Line2 axis({0, 0}, {1, 0});
  Intersections2 x = meet(wave, {0.01, 0.99}, axis, {0, 1});
  REQUIRE(x.crossings.size() == 39);
  for (int k = 1; k <= 39; k++) {
    CHECK_NEAR(x.crossings[k - 1].ta, k / 40.0, 0, 1e-12);
    CHECK(!x.crossings[k - 1].tangent);
  }
}

TEST_CASE("classify2: a polar cap whose pole isn't in its loop: on at the pole it reaches, out at the other") {
  // A sphere's (u, v), v in [-pi/2, pi/2]: the cap above the equator, its loop the equator running +u (the cap on its
  // left); the poles at v = -pi/2 and pi/2.
  std::vector<Loop2> cap{Loop2{{{line({0, 0}, {2 * pi, 0}), {0, 1}, false}}}};
  Periods per{2 * pi, 0, {}, {-pi / 2, pi / 2}};
  Status st;
  CHECK(classify2(cap, {1, pi / 2}, per, 1e-9, st) == Side::on);
  CHECK(classify2(cap, {1, -pi / 2}, per, 1e-9, st) == Side::out);
  CHECK(classify2(cap, {1, 1}, per, 1e-9, st) == Side::in);
  CHECK(classify2(cap, {1, -1}, per, 1e-9, st) == Side::out);
}

TEST_CASE("classify2: a point no ray meets anything from is out") {
  // A unit square 1000 away subtends a milliradian: none of the rays' directions meets it.
  std::vector<Loop2> far{polygon({{1000, 1000}, {1001, 1000}, {1001, 1001}, {1000, 1001}})};
  Status st;
  CHECK(classify2(far, {0, 0}, {}, 1e-9, st) == Side::out);
  CHECK(st == Status::ok);
  CHECK(classify2(far, {1000.5, 1000.5}, {}, 1e-9, st) == Side::in);
}
