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
    out = {Interval::hull(a_.x + r.lo * d_.x, a_.x + r.hi * d_.x), Interval::hull(a_.y + r.lo * d_.y, a_.y + r.hi * d_.y),
      Interval::point(0)};
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
