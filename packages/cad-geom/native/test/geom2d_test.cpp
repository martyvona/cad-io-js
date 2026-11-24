// geom2d.h: the catalogue's 2D cases (intersect2, selfIntersect2, classify2, nest2 on the case models' faces, their
// loops built from the coedges' p-curves), then synthetic ones on curves written here (lines, arcs, 2D B-splines on
// numerics.h), independent of curve.cpp: crossings and tangencies with known answers, overlaps against near-parallel
// and near-tangent curves either side of the rule, areas, classification at tol from the boundary, periodic bands,
// pole lines, nesting.
#include <cad_geom/curve.h>
#include <cad_geom/geom2d.h>
#include <cad_geom/numerics.h>
#include <cad_geom/predicates.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
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

TEST_CASE("classify2: one closed polyline curve (straight between corners, as a degree-1 B-spline): on along a side, "
  "in and out") {
  // The unit square as one curve on [0, 4], t's integer part the side: derivBound of order 2 is 0 everywhere, its
  // breaks the corners. Its ends meet, so a side's orientation can't come from them; and a point on a straight side
  // has a corner as the coarse polyline's nearest vertex, where Newton takes the other side's derivative.
  class Square final : public Curve {
  public:
    int dim() const override { return 2; }
    CurveDomain domain() const override { return {{0, 4}, 0}; }
    Status eval(double t, int, CurvePoint& out) const override {
      const Vec2 c[5] = {{1, 1}, {0, 1}, {0, 0}, {1, 0}, {1, 1}};
      const int k = std::clamp(static_cast<int>(std::floor(t)), 0, 3);
      const Vec2 d = c[k + 1] - c[k], p = c[k] + (t - k) * d;
      out = {{p.x, p.y, 0}, {d.x, d.y, 0}, {}};
      return t < 0 || t > 4 ? Status::outOfDomain : Status::ok;
    }
    void breaks(Range r, std::vector<double>& out) const override {
      out = {r.lo};
      for (double k : {1.0, 2.0, 3.0})
        if (k > r.lo && k < r.hi) out.push_back(k);
      out.push_back(r.hi);
    }
    Status bound(Range, Box3& out) const override {
      out = {{0, 1}, {0, 1}, Interval::point(0)};
      return Status::ok;
    }
    Status derivBound(Range, int order, double& out) const override {
      out = order == 1 ? 1 : 0;
      return Status::ok;
    }
    void singular(Range, std::vector<double>& out) const override { out.clear(); }
  } square;
  Loop2 loop;
  loop.pieces.push_back({&square, {0, 4}, false});
  const double tol = 1e-6;
  auto side = [&](Vec2 p) {
    Status st;
    Side s = classify2({loop}, p, {}, tol, st);
    CHECK(st == Status::ok);
    return s;
  };
  CHECK(side({0.8, 0}) == Side::on);
  CHECK(side({0.8, 1e-12}) == Side::on);
  CHECK(side({0, 0.3}) == Side::on);
  CHECK(side({1e-4, 0.8}) == Side::in);
  CHECK(side({0.5, 0.5}) == Side::in);
  CHECK(side({-1e-4, 0.8}) == Side::out);
  // From far off no ray meets it: out by the loop's signed area, its integral span by span between the breaks (over
  // the corners at once it doesn't converge, the sign unsure); run the other way, a hole alone: in.
  CHECK(side({1000, 1000}) == Side::out);
  Loop2 back;
  back.pieces.push_back({&square, {0, 4}, true});
  Status st;
  CHECK(classify2({back}, {1000, 1000}, {}, tol, st) == Side::in);
  CHECK(st == Status::ok);
  // A triangle whose side from (0, 0) is a B-spline along a line through the origin: x y' - y x' is 0 all along it,
  // so its integral is met only to an absolute tolerance (a relative one never is).
  BSpline q;
  q.degree = 2;
  q.dim = 2;
  q.knots = {0, 0, 0, 1, 1, 1};
  q.poles = {0, 0, 0.5, 0.5, 1, 1};
  Spline2 diag(q);
  std::vector<Loop2> tri{Loop2{{{line({0, 0}, {1, 0}), {0, 1}, false}, {line({1, 0}, {1, 1}), {0, 1}, false},
    {&diag, {0, 1}, true}}}};
  CHECK(classify2(tri, {1000, 1000}, {}, tol, st) == Side::out);
  CHECK(st == Status::ok);
  CHECK(side({0.5, 1.2}) == Side::out);
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

TEST_CASE("classify2: on a cone, past its apex's pole line, the other nappe, out") {
  // A cone's (u, v), the apex at v = 0 inside the domain: a face from the apex to v = 3 over u in [0, pi], its loop
  // up u = pi, back along v = 3 to u = 0, down from u = 2 pi (the same line a period on) to the apex, closed along
  // the pole line (nist_ctc_04's face #3633). A point at v < 0 is on the other nappe: out, whatever its u, though a ray
  // from it meets the loop as from inside a polar cap.
  std::vector<Loop2> face{Loop2{{{line({pi, 0}, {pi, 3}), {0, 1}, false}, {line({pi, 3}, {0, 3}), {0, 1}, false},
    {line({2 * pi, 3}, {2 * pi, 0}), {0, 1}, false}}}};
  Periods per{2 * pi, 0, {}, {0}};
  Status st;
  CHECK(classify2(face, {2, 1.5}, per, 1e-9, st) == Side::in);
  CHECK(classify2(face, {4, 1.5}, per, 1e-9, st) == Side::out);
  for (double v : {-1e-6, -1.0, -143.0}) {
    CHECK(classify2(face, {2, v}, per, 1e-9, st) == Side::out);
    CHECK(classify2(face, {4, v}, per, 1e-9, st) == Side::out);
  }
  // At the apex: on (the face reaches it).
  CHECK(classify2(face, {2, 0}, per, 1e-9, st) == Side::on);
}

TEST_CASE("classify2: a cone face whose loop has a piece a period on: closed along the apex without winding") {
  // nist_ctc_04's face #2286: up u = 4 pi (the p-curve as given, two periods on), back along v = 3 from 2 pi to pi,
  // down u = pi to the apex at v = 0. Closed straight from (pi, 0) to (4 pi, 0) the loop winds a period and the face is
  // taken for a band; closed to (2 pi, 0), the copy that keeps it from winding, it is the half cone u in [pi, 2 pi].
  std::vector<Loop2> face{Loop2{{{line({4 * pi, 0}, {4 * pi, 3}), {0, 1}, false},
    {line({2 * pi, 3}, {pi, 3}), {0, 1}, false}, {line({pi, 3}, {pi, 0}), {0, 1}, false}}}};
  Periods per{2 * pi, 0, {}, {0}};
  Status st;
  CHECK(classify2(face, {4, 1.5}, per, 1e-9, st) == Side::in);
  CHECK(classify2(face, {4 + 2 * pi, 1.5}, per, 1e-9, st) == Side::in);
  for (Vec2 p : {Vec2{0.368, 1.5}, Vec2{0.368, 27.4}, Vec2{4, 27}, Vec2{4, 4}, Vec2{4, -1}})
    CHECK(classify2(face, p, per, 1e-9, st) == Side::out);
}

TEST_CASE("classify2: a whole sphere's loop, down one seam, across a pole, up the other, back: all in") {
  // trj4_k1_top's face #7409 (less its hole): u = 0 down, the south pole from 0 to 2 pi, u = 2 pi up, the north pole
  // back. Its closures cancel; taken off one each, the loop would bound nothing.
  const double h = pi / 2;
  std::vector<Loop2> face{Loop2{{{line({0, h}, {0, -h}), {0, 1}, false}, {line({2 * pi, -h}, {2 * pi, h}), {0, 1},
    false}}}};
  Periods per{2 * pi, 0, {}, {-h, h}};
  Status st;
  for (Vec2 p : {Vec2{1, 0}, Vec2{6.2165, -0.628}, Vec2{4.77, -0.314}, Vec2{3, 1.5}})
    CHECK(classify2(face, p, per, 1e-9, st) == Side::in);
}

TEST_CASE("classify2: a sliver's loop, there and back along one line: out everywhere off it") {
  // Kuka.step #4099's cone face #28094: a spline and an arc within tolerance, their p-curves on one line v = c. Every
  // ray from off it meets both pieces at once with opposite verdicts; the first found decided, so points far away
  // came out in.
  const double c = -0.397197677;
  std::vector<Loop2> face{Loop2{{{line({3.069410352, c}, {3.213774955, c}), {0, 1}, false},
    {line({3.213774955, c}, {3.069410352, c}), {0, 1}, false}}}};
  for (bool pole : {false, true}) {
    Periods per{2 * pi, 0, {}, {}};
    if (pole) per.poleV.push_back(-50);
    Status st;
    for (double v : {1.0, 10.0, 50.0, 100.0, 1000.0, 13289.2, -1.0, -10.0})
      for (double u : {3.698125, 3.1, 0.5})
        CHECK(classify2(face, {u, v}, per, 2.4e-6, st) == Side::out);
    CHECK(classify2(face, {3.1, c}, per, 2.4e-6, st) == Side::on);
  }
}

TEST_CASE("classify2: a band narrower than the tolerance: its sides told apart by distance, points off it out") {
  // bug27453_165-174_piattello's plane face #517: three quarters of a ring from radius 2.5 to 2.501, its tolerance
  // 0.0508. A ray meets the two arcs 0.001 apart, nearer than the tolerance but not a tie: the nearest decides, and
  // every point off it is out, the rays converging (taken as one, the arcs were passed and the centre came out in).
  const double r0 = 2.5, r1 = 2.501;
  auto arc = [](double r) {
    keep.push_back(std::make_unique<Arc2>(Vec2{0, 0}, r));
    return keep.back().get();
  };
  std::vector<Loop2> face{Loop2{{{line({r0, 0}, {r1, 0}), {0, 1}, false},
    {arc(r1), {0, 1.5 * pi}, false}, {line({0, -r1}, {0, -r0}), {0, 1}, false}, {arc(r0), {0, 1.5 * pi}, true}}}};
  Periods per{0, 0, {}, {}};
  for (Vec2 p : {Vec2{0, 0}, Vec2{0, 3}, Vec2{0, 2}, Vec2{-3, -3}, Vec2{1.3, 2.3}, Vec2{1.77, -1.77}}) {
    Status st;
    CHECK(classify2(face, p, per, 0.0508, st) == Side::out);
    CHECK(st == Status::ok);
  }
}

TEST_CASE("classify2: a slit into a square, there and back: in on both sides of it") {
  // The square [0, 4]^2 with a cut from its bottom side's middle up to (2, 2) and back: the region around the cut.
  std::vector<Loop2> face{Loop2{{{line({0, 0}, {2, 0}), {0, 1}, false}, {line({2, 0}, {2, 2}), {0, 1}, false},
    {line({2, 2}, {2, 0}), {0, 1}, false}, {line({2, 0}, {4, 0}), {0, 1}, false},
    {line({4, 0}, {4, 4}), {0, 1}, false}, {line({4, 4}, {0, 4}), {0, 1}, false},
    {line({0, 4}, {0, 0}), {0, 1}, false}}}};
  Periods per{0, 0, {}, {}};
  Status st;
  for (Vec2 p : {Vec2{1.9, 1}, Vec2{2.1, 1}, Vec2{1.5, 1.5}, Vec2{2.5, 0.5}, Vec2{1, 3}})
    CHECK(classify2(face, p, per, 1e-9, st) == Side::in);
  for (Vec2 p : {Vec2{5, 1}, Vec2{2, -1}, Vec2{-1, 2}}) CHECK(classify2(face, p, per, 1e-9, st) == Side::out);
}

TEST_CASE("classify2: a ray through a self-crossing loop's crossing decides nothing") {
  // A bowtie, and below it a hole (clockwise) from x 0.5 to 1.5: from (1, 3) the first ray, down, meets both diagonals
  // at their crossing (1, 1), with opposite verdicts; they don't run along each other, so another ray decides: out.
  // Taking the first found makes it in, and so does passing them as a sliver's (the hole's top side next, p on its
  // left).
  std::vector<Loop2> face{Loop2{{{line({0, 0}, {2, 2}), {0, 1}, false}, {line({2, 2}, {2, 0}), {0, 1}, false},
    {line({2, 0}, {0, 2}), {0, 1}, false}, {line({0, 2}, {0, 0}), {0, 1}, false}}},
    Loop2{{{line({0.5, -2}, {1.5, -2}), {0, 1}, false}, {line({1.5, -2}, {1.5, -3}), {0, 1}, false},
    {line({1.5, -3}, {0.5, -3}), {0, 1}, false}, {line({0.5, -3}, {0.5, -2}), {0, 1}, false}}}};
  Status st;
  CHECK(classify2(face, {1, 3}, Periods{0, 0, {}, {}}, 1e-9, st) == Side::out);
}

TEST_CASE("classify2: on a pole its face's boundary reaches, at any u: the pole one point in space") {
  // wgehaeuse_surface's sphere face #60155: up to the north pole at u 6.36, a degenerate edge along it from 7.43 back
  // to 5.28 (over the closure from 6.36 to 7.43), down. At u 7.24 a point just under the pole is out of the face, but
  // the pole itself is on its boundary.
  const double h = pi / 2;
  std::vector<Loop2> face{Loop2{{{line({5.206, -0.036}, {6.283, 0.016}), {0, 1}, false},
    {line({6.283, 0.016}, {6.358, h}), {0, 1}, false}, {line({7.431, h}, {5.276, h}), {0, 1}, false},
    {line({5.276, h}, {5.206, -0.036}), {0, 1}, false}}}};
  Periods per{2 * pi, 0, {}, {-h, h}};
  Status st;
  for (double u : {7.242, 6.991, 0.5, 3.0, 5.5}) CHECK(classify2(face, {u, h}, per, 0.0122, st) == Side::on);
  CHECK(classify2(face, {3, -h}, per, 0.0122, st) == Side::out);
  CHECK(classify2(face, {5.8, 0.8}, per, 0.0122, st) == Side::in);
}

TEST_CASE("classify2: a spindle torus's poles split its periodic v: a face judged within its band") {
  // bug32239's face #54190: a latitude circle at v = 1.7066 running -u, the torus's poles (its axis crossings) at
  // 1.5721 and 4.7110. The face is the band from the circle to the nearer pole on its left; a ray past a pole line
  // is on the other sheet, and its copies of the circle made every point in.
  const double c = 1.706553780, a = 1.572137161, b = 4.711048146;
  std::vector<Loop2> face{Loop2{{{line({3 * pi, c}, {pi, c}), {0, 1}, false}}}};
  Periods per{2 * pi, 2 * pi, {}, {a, b}};
  Status st;
  for (double v : {1.6, 1.65, 1.7}) CHECK(classify2(face, {2.857, v}, per, 2e-6, st) == Side::in);
  for (double v : {1.7076, 2.5, 3.14, 4.6, 5.5, 6.0, 0.5})
    CHECK(classify2(face, {2.857, v}, per, 2e-6, st) == Side::out);
}

// LMP1 #173136's face #1078959 on a spindle torus (poles at v = a and b): a wedge from the pole line v = b up to
// v = h, u from u0 to u1 across the seam, its p-curves' ends on the pole line at other u (every u there one point in
// space), the loop closed along the line between them as the face API closes it: a turn of u in all, so by the loop's
// sense the other band lies on its left. Its pieces through `map` (u, v) -> plane, reversed where the map turns the
// plane over; its pole pieces at v = b + nudge.
namespace lmp {
const double a = 1.672572179, b = 4.610613128, h = 4.665256867, u0 = 6.202289296, u1 = 0.080896011;
template <class Map> std::vector<Loop2> wedge(Map map, bool flip, double shift = 0, double nudge = 0) {
  const double c0 = 3.222488642 + shift, c1 = 3.060696643 + shift, e = b + nudge;
  std::vector<std::pair<Vec2, Vec2>> sides{{{c0, e}, {u1 + shift, e}}, {{u1 + shift, e}, {u1 + shift, h}},
    {{u1 + 2 * pi + shift, h}, {u0 + shift, h}}, {{u0 + shift, h}, {u0 + shift, e}}, {{u0 + shift, e}, {c1, e}},
    {{c1, e}, {c0, e}}};
  if (flip) {
    std::reverse(sides.begin(), sides.end());
    for (auto& sd : sides) std::swap(sd.first, sd.second);
  }
  Loop2 l;
  for (auto& sd : sides) l.pieces.push_back({line(map(sd.first), map(sd.second)), {0, 1}, false});
  return {l};
}
}  // namespace lmp

TEST_CASE("classify2: a spindle torus's face against one pole line: points in the other band out, rays clipped there") {
  // Every ray from the other band, clipped at the pole lines, met the closures along b as from inside the face, and
  // the whole other sheet came out in.
  using namespace lmp;
  const std::vector<Vec2> in{{6.28, 4.64}, {0.03, 4.62}, {6.25, 4.655}};
  const std::vector<Vec2> out{{6.28, 4.0}, {6.28, 3.0}, {6.28, 1.8}, {3, 3}, {0.03, 4.5}, {6.28, -2.0}, {3, 4.64},
    {6.28, 5.0}, {6.28, 4.68}, {6.28, 4.6 + 2 * pi}};
  auto id = [](Vec2 p) { return p; };
  Status st;
  // The pole lines in any order, any period's copy; the face a period over in u; its pole pieces within tol of b.
  for (const std::vector<double>& poles : {std::vector<double>{a, b}, {b, a}, {b - 2 * pi, a + 4 * pi}})
    for (double shift : {0.0, 2 * pi})
      for (double nudge : {0.0, -0.004, 0.004}) {
        const std::vector<Loop2> face = wedge(id, false, shift, nudge);
        Periods per{2 * pi, 2 * pi, {}, poles};
        for (Vec2 p : in) CHECK(classify2(face, p, per, 0.0057, st) == Side::in);
        for (Vec2 p : out) CHECK(classify2(face, p, per, 0.0057, st) == Side::out);
      }
  // All of it 3 down in v: the other band across v = 0.
  {
    const std::vector<Loop2> face = wedge([](Vec2 p) { return Vec2{p.x, p.y - 3}; }, false);
    Periods per{2 * pi, 2 * pi, {}, {a - 3, b - 3}};
    for (Vec2 p : in) CHECK(classify2(face, {p.x, p.y - 3}, per, 0.0057, st) == Side::in);
    for (Vec2 p : out) CHECK(classify2(face, {p.x, p.y - 3}, per, 0.0057, st) == Side::out);
  }
  // Mirrored in v (the wedge below the pole line a, the other band (a, b) above it), and with u and v swapped.
  for (double nudge : {0.0, -0.004, 0.004}) {
    const std::vector<Loop2> face = wedge([](Vec2 p) { return Vec2{p.x, a + b - p.y}; }, true, 0, nudge);
    Periods per{2 * pi, 2 * pi, {}, {a, b}};
    for (Vec2 p : in) CHECK(classify2(face, {p.x, a + b - p.y}, per, 0.0057, st) == Side::in);
    for (Vec2 p : out) CHECK(classify2(face, {p.x, a + b - p.y}, per, 0.0057, st) == Side::out);
  }
  const std::vector<Loop2> face = wedge([](Vec2 p) { return Vec2{p.y, p.x}; }, true);
  Periods per{2 * pi, 2 * pi, {a, b}, {}};
  for (Vec2 p : in) CHECK(classify2(face, {p.y, p.x}, per, 0.0057, st) == Side::in);
  for (Vec2 p : out) CHECK(classify2(face, {p.y, p.x}, per, 0.0057, st) == Side::out);
}

TEST_CASE("classify2: bands by poles across a period: a face reaching two bands, by pieces across a pole line alone") {
  // Two pole lines at v = 1 and 4 across a period of 2 pi: bands (1, 4) and (4, 1 + 2 pi).
  const double pv = 2 * pi;
  Periods per{2 * pi, pv, {}, {1, 4}};
  Status st;
  // A triangle across the line v = 4, its apex in the upper band, which only its two slanted sides reach: in there.
  std::vector<Loop2> tri{Loop2{{{line({1, 3}, {2, 3}), {0, 1}, false}, {line({2, 3}, {1.5, 4.5}), {0, 1}, false},
    {line({1.5, 4.5}, {1, 3}), {0, 1}, false}}}};
  CHECK(classify2(tri, {1.5, 3.5}, per, 1e-6, st) == Side::in);
  CHECK(classify2(tri, {1.5, 4.2}, per, 1e-6, st) == Side::in);
  CHECK(classify2(tri, {1.5, 4.2 - pv}, per, 1e-6, st) == Side::in);
  CHECK(classify2(tri, {1.5, 5}, per, 1e-6, st) == Side::out);
  CHECK(classify2(tri, {3, 3.5}, per, 1e-6, st) == Side::out);
}

TEST_CASE("classify2: a ray within tol of a spike's tip of short pieces: the joint the pieces in and out of it") {
  // Kuka.step #4099's plane face #28100 (its fillets as lines): an arc in along the bottom to a tip at the right, a
  // piece shorter than the tolerance, a line back out. From far off one ray passes the tip within tol, meeting the
  // short piece and the line at their joint, both running back the same way, and took p as on their left: in. The
  // joint is the arc's and the line's: the ray passes outside it, so it decides nothing, and a ray meeting nothing
  // puts p out.
  const double r = 50, a0 = std::atan2(-48.779542117, -10.979811969) + 2 * pi,
    a1 = std::atan2(-48.779542117, 10.979811969) + 2 * pi;
  keep.push_back(std::make_unique<Arc2>(Vec2{0, 0}, r));
  const Curve* arc = keep.back().get();
  std::vector<Loop2> face{Loop2{{{arc, {a0, a1}, false},
    {line({10.979811969, -48.779542117}, {10.972162462, -48.777484776}), {0, 1}, false},
    {line({10.972162462, -48.777484776}, {6.427001557, -47.568148347}), {0, 1}, false},
    {line({6.427001557, -47.568148347}, {-6.427001557, -47.568148347}), {0, 1}, false},
    {line({-6.427001557, -47.568148347}, {-10.972162462, -48.777484776}), {0, 1}, false},
    {line({-10.972162462, -48.777484776}, {-10.979811969, -48.779542117}), {0, 1}, false}}}};
  const Periods per{0, 0, {}, {}};
  Status st;
  CHECK(classify2(face, {-109.616439, -179.916579}, per, 0.118037, st) == Side::out);
  CHECK(st == Status::ok);
  // (Periodic, a ray meeting nothing says nothing: out, unsettled.)
  CHECK(classify2(face, {-109.616439, -179.916579}, Periods{1000, 0, {}, {}}, 0.118037, st) == Side::out);
  CHECK(st == Status::noConvergence);
  // (A copy a period on: the joint judged on the piece as given, the meeting moved back by the copy's shift.)
  CHECK(classify2(face, {-109.616439 + 1000, -179.916579}, Periods{1000, 0, {}, {}}, 0.118037, st) == Side::out);
  CHECK(classify2(face, {1000, -49}, Periods{1000, 0, {}, {}}, 0.118037, st) == Side::in);
  CHECK(classify2(face, {0, -49}, per, 0.118037, st) == Side::in);
  CHECK(classify2(face, {0, -100}, per, 0.118037, st) == Side::out);
  // The same loop run the other way, a hole alone: its complement, unbounded. The far point's one ray meeting it
  // decides nothing again, the others meet nothing: in by the loops' signed area (negative), not out as for a region.
  Loop2 hole = face[0];
  std::reverse(hole.pieces.begin(), hole.pieces.end());
  for (LoopPiece& piece : hole.pieces) piece.reversed = !piece.reversed;
  const std::vector<Loop2> rest{hole};
  CHECK(classify2(rest, {-109.616439, -179.916579}, per, 0.118037, st) == Side::in);
  CHECK(st == Status::ok);
  CHECK(classify2(rest, {0, -49}, per, 0.118037, st) == Side::out);
  CHECK(classify2(rest, {0, -100}, per, 0.118037, st) == Side::in);
}

TEST_CASE("classify2: a joint's pieces all within tol, or a spike's piece in a half circle: judged by the loop's way") {
  // A square smaller than the tolerance: every piece at a joint short, nothing to tell there; points just past the
  // tolerance all round are out. A half circle in to a spike's tip (its tangent there up, at its start down), a short
  // piece, a line back: the joint's way in is the arc's at the tip.
  const Periods per{0, 0, {}, {}};
  Status st;
  // The square's joints met with every piece near the meeting: p, past tol, is outside what the loop encloses, out
  // of the square and in where the square is a hole. Periodic, where a ray meeting nothing settles nothing, that
  // settles all but a ray whose meeting is too far to one side for the far corner to be near (judged by the pieces
  // then: retried).
  std::vector<Loop2> tiny{polygon({{0, 0}, {0.05, 0}, {0.05, 0.05}, {0, 0.05}})};
  std::vector<Loop2> pit{polygon({{0, 0}, {0, 0.05}, {0.05, 0.05}, {0.05, 0}})};
  for (const Periods& q : {per, Periods{1000, 0, {}, {}}}) {
    int settled = 0;
    for (int k = 0; k < 16; k++) {
      const double a = 0.3 + k * 2 * pi / 16;
      const Vec2 p{0.025 + 0.2 * std::cos(a), 0.025 + 0.2 * std::sin(a)};
      for (bool hole : {false, true}) {
        const Side s = classify2(hole ? pit : tiny, p, q, 0.1, st);
        if (st != Status::ok) continue;
        settled++;
        CHECK(s == (hole ? Side::in : Side::out));
      }
    }
    CHECK(settled >= 30);
  }
  // The hole inside a face (the outer loop far off): from below it the first ray, up, meets the hole first, judged
  // by the hole's own area (negative), not the face's whole boundary (positive).
  std::vector<Loop2> plate{polygon({{-10, -10}, {10, -10}, {10, 10}, {-10, 10}}), pit[0]};
  for (const Periods& q : {per, Periods{1000, 0, {}, {}}})
    for (Vec2 p : {Vec2{0.025, -0.15}, Vec2{0.03, -0.2}, Vec2{0.01, -0.12}}) {
      CHECK(classify2(plate, p, q, 0.1, st) == Side::in);
      CHECK(st == Status::ok);
    }
  keep.push_back(std::make_unique<Arc2>(Vec2{0, 0}, 1));
  const Curve* arc = keep.back().get();
  std::vector<Loop2> half{Loop2{{{arc, {pi, 2 * pi}, false}, {line({1, 0}, {0.99, 0.0005}), {0, 1}, false},
    {line({0.99, 0.0005}, {-1, 0}), {0, 1}, false}}}};
  int out = 0, n = 0;
  for (int k = 0; k < 24; k++) {
    const double a = k * 2 * pi / 24;
    for (double d : {0.2, 1.0, 5.0, 40.0}) {
      const Vec2 p{1 + d * std::cos(a), d * std::sin(a)};
      if (std::hypot(p.x, p.y) < 1.1) continue;  // (in or near the half disc)
      n++, out += classify2(half, p, per, 0.08, st) == Side::out;
    }
  }
  CHECK(out == n);
  CHECK(classify2(half, {0.3, -0.5}, per, 0.08, st) == Side::in);
  // The way in at the tip, not at the arc's start: a half circle from (0, 2) round the left to (0, 0), arriving +x
  // (leaving (0, 2) -x), a piece 0.065 on to the tip, a line back up. From (0.125, -0.5) the first ray, up, passes
  // 0.06 off the tip and 0.125 off the arc: it meets the short piece, all within tol of where it does, and the line;
  // the arc in (+x) and the line out (up) on either side of it, it decides nothing. Taking the arc's tangent at its
  // start, p came out in.
  keep.push_back(std::make_unique<Arc2>(Vec2{0, 1}, 1));
  const Curve* left = keep.back().get();
  std::vector<Loop2> cap{Loop2{{{left, {pi / 2, 3 * pi / 2}, false}, {line({0, 0}, {0.065, 0}), {0, 1}, false},
    {line({0.065, 0}, {0, 2}), {0, 1}, false}}}};
  // (Periodic too, where a ray meeting nothing settles nothing: the first ray's joint decides.)
  for (const Periods& q : {per, Periods{1000, 0, {}, {}}})
    for (Vec2 p : {Vec2{0.125, -0.5}, Vec2{3, 3}, Vec2{-5, 1}}) {
      CHECK(classify2(cap, p, q, 0.1, st) == Side::out);
      CHECK(st == Status::ok);
    }
  CHECK(classify2(cap, {-0.5, 1}, per, 0.1, st) == Side::in);
  // The way out likewise, the same loop run the other way (in along the line, the short piece, out round the arc
  // from its end at the tip, leaving -x): a hole, its complement in.
  std::vector<Loop2> hole{Loop2{{{line({0, 2}, {0.065, 0}), {0, 1}, false}, {line({0.065, 0}, {0, 0}), {0, 1}, false},
    {left, {pi / 2, 3 * pi / 2}, true}}}};
  for (const Periods& q : {per, Periods{1000, 0, {}, {}}})
    for (Vec2 p : {Vec2{0.125, -0.5}, Vec2{3, 3}, Vec2{-5, 1}}) {
      CHECK(classify2(hole, p, q, 0.1, st) == Side::in);
      CHECK(st == Status::ok);
    }
  CHECK(classify2(hole, {-0.5, 1}, per, 0.1, st) == Side::out);
}

TEST_CASE("classify2: a sliver no wider than its tolerance, met past its corner: the piece's nearer end, out") {
  // bug24055_8MTF-75LS05's plane face #15612, 0.01 by 0.86 at a tolerance of 0.01, its pieces in the model's order
  // (the top first, leftward, its curve run backwards). A far point's ray passes 0.001 off its top right corner: the
  // top, within tol of both its ends, was judged at its curve's start (the other corner), and p came out in.
  const double x0 = 213.96196078, x1 = 213.97196078, y1 = 0.858995138;
  std::vector<Loop2> face{Loop2{{{line({x0, y1}, {x1, y1}), {0, 1}, true}, {line({x0, y1}, {x0, 0}), {0, 1}, false},
    {line({x0, 0}, {x1, 0}), {0, 1}, false}, {line({x1, 0}, {x1, y1}), {0, 1}, false}}}};
  Status st;
  CHECK(classify2(face, {229.566991, -39.7136494}, Periods{0, 0, {}, {}}, 0.01, st) == Side::out);
  CHECK(st == Status::ok);
  CHECK(classify2(face, {213.967, 0.43}, Periods{0, 0, {}, {}}, 0.01, st) == Side::on);
}

TEST_CASE("classify2: a loop of pieces each shorter than the tolerance: its joints judged past the near ones only") {
  // A 40-gon of radius 1 at a tolerance of 0.3, its sides 0.16: a joint's pieces all within tol of where a ray meets
  // it are passed, not every piece shorter than tol (all of them: the centre came out unsettled, so no point in).
  std::vector<Vec2> pts;
  for (int k = 0; k < 40; k++) pts.push_back({std::cos(2 * pi * k / 40), std::sin(2 * pi * k / 40)});
  std::vector<Loop2> face{polygon(pts)};
  Status st;
  for (Vec2 p : {Vec2{0, 0}, Vec2{0.3, -0.2}, Vec2{-0.1, 0.5}}) {
    CHECK(classify2(face, p, Periods{0, 0, {}, {}}, 0.3, st) == Side::in);
    CHECK(st == Status::ok);
  }
  CHECK(classify2(face, {2, 0.5}, Periods{0, 0, {}, {}}, 0.3, st) == Side::out);
}

TEST_CASE("classify2: a point no ray meets anything from: out of a region, in past a hole alone") {
  // A unit square 1000 away subtends a milliradian: none of the rays' directions meets it.
  std::vector<Loop2> far{polygon({{1000, 1000}, {1001, 1000}, {1001, 1001}, {1000, 1001}})};
  Status st;
  CHECK(classify2(far, {0, 0}, {}, 1e-9, st) == Side::out);
  CHECK(st == Status::ok);
  CHECK(classify2(far, {1000.5, 1000.5}, {}, 1e-9, st) == Side::in);
  // The square as a hole alone: its complement, unbounded, the far point in it (by the loop's signed area, negative).
  std::vector<Loop2> hole{polygon({{1000, 1000}, {1000, 1001}, {1001, 1001}, {1001, 1000}})};
  CHECK(classify2(hole, {0, 0}, {}, 1e-9, st) == Side::in);
  CHECK(st == Status::ok);
  CHECK(classify2(hole, {1000.5, 1000.5}, {}, 1e-9, st) == Side::out);
  // (Periodic, as was: out, settled.)
  CHECK(classify2(hole, {0, 0}, Periods{1e6, 0, {}, {}}, 1e-9, st) == Side::out);
  CHECK(st == Status::ok);
}

TEST_CASE("classify2 of many points: each point's single answer, the boxes and fine polylines made once for all") {
  // An annulus (radius 2 about the origin, a hole of radius 1), 300 points over a grid and on both circles, at three
  // tolerances in turn: the batch's sides and statuses each the point's own call's, its boundary polylines (the pieces'
  // boxes, the on tests') a fraction of theirs.
  Arc2 outer({0, 0}, 2), inner({0, 0}, 1);
  Loop2 a, b;
  a.pieces.push_back({&outer, {0, 2 * pi}, false});
  b.pieces.push_back({&inner, {0, 2 * pi}, true});
  const std::vector<Loop2> loops{a, b};
  std::vector<Vec2> p;
  std::vector<double> tol;
  const double tols[3] = {1e-9, 1e-6, 1e-3};
  for (int i = 0; i < 15; i++)
    for (int j = 0; j < 15; j++) p.push_back({-2.5 + 5.0 * (i + 0.5) / 15, -2.5 + 5.0 * (j + 0.5) / 15});
  for (int k = 0; k < 75; k++) {
    const double t = 2 * pi * k / 75, r = k % 2 ? 1 : 2;
    p.push_back({r * std::cos(t), r * std::sin(t)});
  }
  for (size_t k = 0; k < p.size(); k++) tol.push_back(tols[k % 3]);
  const int n = static_cast<int>(p.size());
  std::vector<Side> one(n), many(n);
  std::vector<Status> oneSt(n), manySt(n);
  long before = boundaryPolylines;
  for (int k = 0; k < n; k++) one[k] = classify2(loops, p[k], {}, tol[k], oneSt[k]);
  const long singles = boundaryPolylines - before;
  before = boundaryPolylines;
  classify2(loops, p.data(), tol.data(), n, {}, many.data(), manySt.data());
  const long batch = boundaryPolylines - before;
  int diff = 0, in = 0, out = 0, on = 0;
  for (int k = 0; k < n; k++) {
    diff += one[k] != many[k] || oneSt[k] != manySt[k];
    in += one[k] == Side::in, out += one[k] == Side::out, on += one[k] == Side::on;
  }
  CHECK_EQ(diff, 0);
  CHECK(in > 30 && out > 30 && on >= 75);
  CHECK(batch * 5 < singles);
  CHECK(batch <= 10);
  if (!(batch * 5 < singles)) std::printf("    polylines: %ld one at a time, %ld at once\n", singles, batch);
}

TEST_CASE("onPolylineDelta: a tolerance rounded down to a power of 2; classify2's batch shares polylines across it") {
  // The delta: a power of 2, at most the tolerance and more than half it; a power of 2 itself; others as they are.
  int bad = 0;
  for (double tol = 1e-12; tol < 1e3; tol *= 1.37) {
    const double d = onPolylineDelta(tol);
    int e = 0;
    bad += !(d <= tol && 2 * d > tol && std::frexp(d, &e) == 0.5);
  }
  CHECK_EQ(bad, 0);
  CHECK_EQ(onPolylineDelta(std::ldexp(1.0, -20)), std::ldexp(1.0, -20));
  CHECK_EQ(onPolylineDelta(std::ldexp(1.0, -20) * (1 - 1e-15)), std::ldexp(1.0, -21));
  CHECK_EQ(onPolylineDelta(0.0), 0.0);
  CHECK_EQ(onPolylineDelta(HUGE_VAL), HUGE_VAL);
  CHECK_EQ(onPolylineDelta(-1.5), -1.5);
  CHECK(std::isnan(onPolylineDelta(NAN)));
  // An annulus's 200 points 0 to 8e-6 off its circles, each at its own tolerance in [1e-6, 4e-6) (three powers of
  // 2): the batch's answers each point's own call's, its polylines the 2 pieces' boxes and at most 3 on tests' each.
  Arc2 outer({0, 0}, 2), inner({0, 0}, 1);
  Loop2 a, b;
  a.pieces.push_back({&outer, {0, 2 * pi}, false});
  b.pieces.push_back({&inner, {0, 2 * pi}, true});
  const std::vector<Loop2> loops{a, b};
  std::vector<Vec2> p;
  std::vector<double> tol;
  for (int k = 0; k < 200; k++) {
    const double t = 2 * pi * k / 200, r = (k % 2 ? 1 : 2) + (k % 4 < 2 ? 1 : -1) * 2e-6 * (k % 5);
    p.push_back({r * std::cos(t), r * std::sin(t)});
    tol.push_back(1e-6 + 3e-6 * k / 200);
  }
  const int n = static_cast<int>(p.size());
  std::vector<Side> one(n), many(n);
  std::vector<Status> oneSt(n), manySt(n);
  for (int k = 0; k < n; k++) one[k] = classify2(loops, p[k], {}, tol[k], oneSt[k]);
  const long before = boundaryPolylines;
  classify2(loops, p.data(), tol.data(), n, {}, many.data(), manySt.data());
  const long batch = boundaryPolylines - before;
  int diff = 0, on = 0, off = 0;
  for (int k = 0; k < n; k++) {
    diff += one[k] != many[k] || oneSt[k] != manySt[k];
    on += one[k] == Side::on, off += one[k] != Side::on;
  }
  CHECK_EQ(diff, 0);
  CHECK(on > 50 && off > 20);
  CHECK(batch <= 2 + 2 * 3);
  if (!(batch <= 8)) std::printf("    polylines at once: %ld\n", batch);
}

TEST_CASE("nest2: many holes in a plate, each in the plate only, none in another") {
  // A square plate with a 6 x 6 grid of round holes: each hole's parent the plate, the plate outermost; the holes'
  // boxes don't hold one another, so they aren't tested against one another.
  Line2 s0({0, 0}, {7, 0}), s1({7, 0}, {0, 7}), s2({7, 7}, {-7, 0}), s3({0, 7}, {0, -7});
  Loop2 plate;
  for (const Line2* s : {&s0, &s1, &s2, &s3}) plate.pieces.push_back({s, {0, 1}, false});
  std::vector<std::unique_ptr<Arc2>> arcs;
  std::vector<Loop2> loops{plate};
  for (int i = 0; i < 6; i++)
    for (int j = 0; j < 6; j++) {
      arcs.push_back(std::make_unique<Arc2>(Vec2{1.0 + i, 1.0 + j}, 0.3));
      Loop2 hole;
      hole.pieces.push_back({arcs.back().get(), {0, 2 * pi}, true});
      loops.push_back(hole);
    }
  Status st;
  std::vector<int> parent = nest2(loops, {}, 1e-9, st);
  CHECK(st == Status::ok);
  REQUIRE(parent.size() == loops.size());
  CHECK_EQ(parent[0], -1);
  int wrong = 0;
  for (size_t k = 1; k < parent.size(); k++) wrong += parent[k] != 0;
  CHECK_EQ(wrong, 0);
}

TEST_CASE("nest2: on a periodic surface a loop inside another's copy a period over is inside it") {
  // u periodic (2 pi): a square loop over u in [5.5, 7] (across 2 pi) and a small one at u in [0.2, 0.5], whose copy a
  // period on (u in [6.48, 6.78]) lies inside the first. Their boxes in u don't hold one another as they stand, so
  // the box test can't rule it out in a periodic direction; in v (not periodic) it still holds.
  const double P = 2 * pi;
  Line2 a0({5.5, 0}, {1.5, 0}), a1({7, 0}, {0, 1}), a2({7, 1}, {-1.5, 0}), a3({5.5, 1}, {0, -1});
  Line2 b0({0.2, 0.3}, {0, 0.3}), b1({0.2, 0.6}, {0.3, 0}), b2({0.5, 0.6}, {0, -0.3}), b3({0.5, 0.3}, {-0.3, 0});
  Loop2 outer, inner;
  for (const Line2* s : {&a0, &a1, &a2, &a3}) outer.pieces.push_back({s, {0, 1}, false});
  for (const Line2* s : {&b0, &b1, &b2, &b3}) inner.pieces.push_back({s, {0, 1}, false});
  Status st;
  std::vector<int> parent = nest2({outer, inner}, {P, 0, {}, {}}, 1e-9, st);
  CHECK(st == Status::ok);
  REQUIRE(parent.size() == 2u);
  CHECK_EQ(parent[0], -1);
  CHECK_EQ(parent[1], 0);
}
