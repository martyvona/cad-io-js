// geom2d.h: 2D curve intersection, self-intersection, area, point classification and nesting, generic on the Curve
// interface (any 2D kind), with the tolerance deciding "on", "tangent" and "overlapping" (docs/own-tessellator.md,
// "Degenerate and ambiguous cases").
//
// Intersection. Candidates come from polyline approximations (each smooth span bisected until its sagitta is within
// a coarse deviation; bound() isn't relied on to shrink), paired through a box hierarchy inflated by the deviations and
// tol. Every decision is then made on the exact curves: from each candidate pair, Newton on the squared distance finds
// a local minimum of the gap; one above tol is nothing. Otherwise the stretch of a around it where the gap stays
// within tol (its "contact") is measured by projecting a's points onto b, and classified:
// - The rule: within tol, points are one, so any contact is a stretch, not a point. A contact is isolated (a crossing,
//   or a tangency) when the curves' own local shape where the gap is least, their relative angle theta and curvature
//   difference dk, separates them by at least half the tolerance at one of its ends,
//   |theta| s + |dk| s^2 / 2 >= tol / 2 with s the arc length to that end: the stretch is then the tolerance's blur
//   of a point contact (one-sided where a range ends at the contact). Otherwise their local shape can't account for the stretch: they coincide there, an
//   overlap, reported as the intervals on each and whether they run the same way. (Two lines crossing at an angle
//   below tol over their length coincide within tol: an overlap; a circle touching a line separates quadratically: a
//   tangency, however small the tolerance.) An overlap is longer than tol on both curves: one that's a point on
//   either (collinear pieces meeting end to end, where the gap grows only because a range ends) is a contact.
// - An isolated contact is a tangency when the signed gap has the same sign at both its ends (they touch without
//   crossing), a crossing otherwise; its point is where the gap is least (Newton on a(ta) = b(tb) for crossings).
// Classification. A point within tol of the boundary (or on a pole line the face reaches) is on. Otherwise a ray from
// it decides: the nearest boundary it meets has the region on its left (outer loops counterclockwise, holes
// clockwise), so p is in iff it's on that piece's left (orient2d for straight pieces, exact). Rays run along a
// non-periodic direction to beyond the boundary, or one period along a periodic one; a ray whose first hit is
// tangent, overlapping or at a piece's end is replaced by another at a different angle. In periodic directions the
// pieces are copied by multiples of the periods to cover the ray. Loop pieces that don't meet are closed by a straight
// segment where the jump lies along a pole line (Periods), or are a band closing around its period (a whole period
// apart, no segment).
#include "cad_geom/geom2d.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>

#include "cad_geom/numerics.h"
#include "cad_geom/predicates.h"

namespace cadgeom {

namespace {

constexpr double kInf = std::numeric_limits<double>::infinity();

Vec2 xy(Vec3 v) { return {v.x, v.y}; }
double len(Vec2 v) { return std::hypot(v.x, v.y); }

struct P2 {
  Vec2 p, d1, d2;
};
P2 at(const Curve& c, double t) {
  CurvePoint q;
  c.eval(t, 2, q);
  return {xy(q.p), xy(q.d1), xy(q.d2)};
}

/** A straight segment as a Curve: rays and pole-line closures. */
class Segment final : public Curve {
public:
  Segment(Vec2 a, Vec2 b) : a_(a), b_(b) {}
  int dim() const override { return 2; }
  CurveDomain domain() const override { return {{0, 1}, 0}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    Vec2 d = b_ - a_, p = a_ + t * d;
    out = {{p.x, p.y, 0}, order >= 1 ? Vec3{d.x, d.y, 0} : Vec3{}, {}};
    return t < 0 || t > 1 ? Status::outOfDomain : Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status bound(Range r, Box3& out) const override {
    Vec2 p = a_ + r.lo * (b_ - a_), q = a_ + r.hi * (b_ - a_);
    out = {Interval::hull(p.x, q.x), Interval::hull(p.y, q.y), Interval::point(0)};
    return Status::ok;
  }
  Status derivBound(Range, int order, double& out) const override {
    out = order == 1 ? len(b_ - a_) : 0;
    return Status::ok;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }
  Vec2 a() const { return a_; }
  Vec2 b() const { return b_; }

private:
  Vec2 a_, b_;
};

/** True if c is straight over r (derivBound of order 2 is 0). */
bool straight(const Curve& c, Range r) {
  double d2;
  return c.derivBound(r, 2, d2) == Status::ok && d2 == 0;
}

// ---- Polyline approximation and candidates ----

struct Poly {
  std::vector<double> t;
  std::vector<Vec2> p;
  std::vector<double> dev;  // per segment: an estimate of the chord's deviation from the curve
};

/** c over r as a polyline, each smooth span bisected until its sagitta (mid and quarter points) is within delta. */
Poly polyline(const Curve& c, Range r, double delta) {
  Poly out;
  std::vector<double> br;
  c.breaks(r, br);
  if (br.empty() || br.front() != r.lo) br.insert(br.begin(), r.lo);
  if (br.back() != r.hi) br.push_back(r.hi);
  auto point = [&](double t) { return at(c, t).p; };
  auto dist = [](Vec2 q, Vec2 a, Vec2 b) {
    Vec2 d = b - a;
    double l2 = dot(d, d), s = l2 > 0 ? std::clamp(dot(q - a, d) / l2, 0.0, 1.0) : 0;
    return len(q - (a + s * d));
  };
  out.t.push_back(br[0]);
  out.p.push_back(point(br[0]));
  for (size_t s = 0; s + 1 < br.size(); s++) {
    if (!(br[s + 1] > br[s])) continue;
    bool line = straight(c, {br[s], br[s + 1]});
    // Depth-first bisection, intervals on a stack (right first, so the left is emitted first).
    std::vector<std::pair<double, int>> stack{{br[s + 1], 0}};
    double t0 = br[s];
    Vec2 p0 = point(t0);
    while (!stack.empty()) {
      auto [t1, depth] = stack.back();
      Vec2 p1 = point(t1);
      double dev = 0;
      if (!line)
        for (double f : {0.5, 0.25, 0.75}) dev = std::max(dev, dist(point(t0 + f * (t1 - t0)), p0, p1));
      // Four times the sampled sagitta: a chord's deviation, for a curve whose curvature varies slowly over it.
      if (line || (4 * dev <= delta && depth >= 2) || depth >= 40) {
        stack.pop_back();
        out.t.push_back(t1);
        out.p.push_back(p1);
        out.dev.push_back(line ? 0 : 4 * dev);
        t0 = t1;
        p0 = p1;
      } else {
        // Both halves one level deeper: the right one is this entry, the left one pushed above it.
        stack.back().second = depth + 1;
        stack.push_back({0.5 * (t0 + t1), depth + 1});
      }
    }
  }
  return out;
}

struct Box {
  double x0, y0, x1, y1;
};
bool overlapBoxes(const Box& a, const Box& b, double grow) {
  return a.x0 - grow <= b.x1 && b.x0 - grow <= a.x1 && a.y0 - grow <= b.y1 && b.y0 - grow <= a.y1;
}

/** A box hierarchy over a polyline's segments (implicit: node k covers segments [lo, hi)). */
struct Tree {
  const Poly& poly;
  std::vector<Box> boxes;  // per node, in the order build visits
  std::vector<std::pair<int, int>> ranges, kids;
  explicit Tree(const Poly& p) : poly(p) {
    if (!p.dev.empty()) build(0, static_cast<int>(p.dev.size()));
  }
  int build(int lo, int hi) {
    int node = static_cast<int>(boxes.size());
    Box b{kInf, kInf, -kInf, -kInf};
    for (int i = lo; i < hi; i++)
      for (int k : {i, i + 1}) {
        const Vec2& q = poly.p[k];
        double e = poly.dev[i];
        b = {std::min(b.x0, q.x - e), std::min(b.y0, q.y - e), std::max(b.x1, q.x + e), std::max(b.y1, q.y + e)};
      }
    boxes.push_back(b);
    ranges.push_back({lo, hi});
    kids.push_back({-1, -1});
    if (hi - lo > 1) {
      int mid = (lo + hi) / 2;
      int l = build(lo, mid), r = build(mid, hi);
      kids[node] = {l, r};
    }
    return node;
  }
};

/** The closest points of segments [a0, a1] and [b0, b1], as fractions along each. */
void closest(Vec2 a0, Vec2 a1, Vec2 b0, Vec2 b1, double& sa, double& sb) {
  Vec2 d1 = a1 - a0, d2 = b1 - b0, r = a0 - b0;
  double a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  if (a <= 0 && e <= 0) { sa = sb = 0; return; }
  if (a <= 0) { sa = 0; sb = std::clamp(f / e, 0.0, 1.0); return; }
  double c = dot(d1, r);
  if (e <= 0) { sb = 0; sa = std::clamp(-c / a, 0.0, 1.0); return; }
  double b = dot(d1, d2), den = a * e - b * b;
  sa = den > 0 ? std::clamp((b * f - c * e) / den, 0.0, 1.0) : 0;
  sb = (b * sa + f) / e;
  if (sb < 0) { sb = 0; sa = std::clamp(-c / a, 0.0, 1.0); }
  else if (sb > 1) { sb = 1; sa = std::clamp((b - c) / a, 0.0, 1.0); }
}

// ---- Exact refinement ----

/** t on c in r nearest q, by Newton from t0 (local; clamped to r). */
double project(const Curve& c, Range r, Vec2 q, double t0) {
  double t = std::clamp(t0, r.lo, r.hi);
  for (int it = 0; it < 40; it++) {
    P2 e = at(c, t);
    Vec2 d = e.p - q;
    double f = dot(d, e.d1), fp = dot(e.d1, e.d1) + dot(d, e.d2);
    if (!(fp > 0)) break;
    double next = std::clamp(t - f / fp, r.lo, r.hi);
    if (std::fabs(next - t) <= 1e-15 * (1 + std::fabs(t))) { t = next; break; }
    t = next;
  }
  return t;
}

/** A local minimum of |a(ta) - b(tb)| from (ta, tb), by Newton on the squared distance's gradient (clamped). */
void minimize(const Curve& a, Range ra, const Curve& b, Range rb, double& ta, double& tb) {
  for (int it = 0; it < 60; it++) {
    P2 A = at(a, ta), B = at(b, tb);
    Vec2 d = A.p - B.p;
    double ga = dot(d, A.d1), gb = -dot(d, B.d1);
    double haa = dot(A.d1, A.d1) + dot(d, A.d2), hbb = dot(B.d1, B.d1) - dot(d, B.d2), hab = -dot(A.d1, B.d1);
    double det = haa * hbb - hab * hab;
    double na, nb;
    if (det > 0 && haa > 0) {
      na = ta - (hbb * ga - hab * gb) / det;
      nb = tb - (haa * gb - hab * ga) / det;
    } else {
      // Not convex here (tangent or parallel): alternate projections instead.
      na = project(a, ra, B.p, ta);
      nb = project(b, rb, at(a, na).p, tb);
    }
    na = std::clamp(na, ra.lo, ra.hi);
    nb = std::clamp(nb, rb.lo, rb.hi);
    // At a range end the step stalls against the clamp: project the free one.
    if (na == ta && nb != tb) nb = project(b, rb, at(a, na).p, nb);
    if (nb == tb && na != ta) na = project(a, ra, at(b, nb).p, na);
    double moved = std::fabs(na - ta) + std::fabs(nb - tb);
    ta = na;
    tb = nb;
    if (moved <= 1e-15 * (1 + std::fabs(ta) + std::fabs(tb))) break;
  }
}

/** The gap at a(t): distance to b near tb (updated), and its sign (b's left positive). */
double signedGap(const Curve& a, const Curve& b, Range rb, double t, double& tb) {
  Vec2 q = at(a, t).p;
  tb = project(b, rb, q, tb);
  P2 B = at(b, tb);
  double g = len(q - B.p), s = cross(B.d1, q - B.p);
  return s < 0 ? -g : g;
}

/** Arc length of a over [t0, t1], coarsely (the rule's half-length). */
double length(const Curve& a, double t0, double t1) {
  double L = 0;
  Vec2 prev = at(a, t0).p;
  for (int k = 1; k <= 16; k++) {
    Vec2 q = at(a, t0 + (t1 - t0) * k / 16).p;
    L += len(q - prev);
    prev = q;
  }
  return L;
}

struct Contact {
  double t0, t1;  // on a, where the gap is within tol
  double tb0, tb1;
  double ta, tb;  // the least gap
  double gap;
};

/** The contact around the minimum (ta, tb): a's stretch where the gap stays within tol, by stepping and bisection. */
Contact measure(const Curve& a, Range ra, const Curve& b, Range rb, double ta, double tb, double tol) {
  Contact c{ta, ta, tb, tb, ta, tb, 0};
  double tbm = tb;
  c.gap = std::fabs(signedGap(a, b, rb, ta, tbm));
  for (int dir : {-1, 1}) {
    double end = dir < 0 ? ra.lo : ra.hi, inside = ta, tbIn = tb;
    // Steps doubling from a tiny one until the gap exceeds tol or the range ends; then bisection between.
    double step = 1e-9 * (ra.hi - ra.lo), outside = end;
    bool found = false;
    for (int k = 0; k < 80; k++) {
      double t = ta + dir * step;
      if ((dir < 0 && t <= end) || (dir > 0 && t >= end)) break;
      double tbt = tbIn, g = std::fabs(signedGap(a, b, rb, t, tbt));
      if (g > tol) { outside = t; found = true; break; }
      inside = t;
      tbIn = tbt;
      step *= 2;
    }
    if (!found) {
      double tbt = tbIn, g = std::fabs(signedGap(a, b, rb, end, tbt));
      if (g <= tol) { inside = end; tbIn = tbt; outside = end; }
    }
    for (int k = 0; k < 60 && inside != outside; k++) {
      double mid = 0.5 * (inside + outside);
      if (mid == inside || mid == outside) break;
      double tbt = tbIn, g = std::fabs(signedGap(a, b, rb, mid, tbt));
      if (g <= tol) inside = mid, tbIn = tbt; else outside = mid;
    }
    if (dir < 0) c.t0 = inside, c.tb0 = tbIn; else c.t1 = inside, c.tb1 = tbIn;
  }
  return c;
}

/** Signed curvature of a 2D curve point. */
double curvature(const P2& e) {
  double s = len(e.d1);
  return s > 0 ? cross(e.d1, e.d2) / (s * s * s) : 0;
}

} // namespace

// ---- intersect2 ----

Intersections2 intersect2(const Curve& a, Range ra, const Curve& b, Range rb, double tol) {
  Intersections2 out;
  out.status = Status::ok;
  if (a.dim() != 2 || b.dim() != 2 || !(tol > 0) || !(ra.lo <= ra.hi) || !(rb.lo <= rb.hi)) {
    out.status = Status::invalidModel;
    return out;
  }
  // Candidates on polylines whose chords deviate by about a thousandth of the curves' size (or tol, if larger).
  auto size = [](const Poly& p) {
    double x0 = kInf, y0 = kInf, x1 = -kInf, y1 = -kInf;
    for (const Vec2& q : p.p)
      x0 = std::min(x0, q.x), y0 = std::min(y0, q.y), x1 = std::max(x1, q.x), y1 = std::max(y1, q.y);
    return std::max(x1 - x0, y1 - y0);
  };
  Poly pa0 = polyline(a, ra, kInf), pb0 = polyline(b, rb, kInf);
  double delta = std::max(tol, 1e-3 * std::max(size(pa0), size(pb0)));
  Poly pa = polyline(a, ra, delta), pb = polyline(b, rb, delta);
  Tree A(pa), B(pb);
  std::vector<std::pair<double, double>> seeds;
  if (!A.boxes.empty() && !B.boxes.empty()) {
    std::vector<std::pair<int, int>> stack{{0, 0}};
    while (!stack.empty()) {
      auto [i, j] = stack.back();
      stack.pop_back();
      if (!overlapBoxes(A.boxes[i], B.boxes[j], tol)) continue;
      bool leafA = A.kids[i].first < 0, leafB = B.kids[j].first < 0;
      if (leafA && leafB) {
        int sa = A.ranges[i].first, sb = B.ranges[j].first;
        double fa, fb;
        closest(pa.p[sa], pa.p[sa + 1], pb.p[sb], pb.p[sb + 1], fa, fb);
        seeds.push_back({pa.t[sa] + fa * (pa.t[sa + 1] - pa.t[sa]), pb.t[sb] + fb * (pb.t[sb + 1] - pb.t[sb])});
      } else if (leafA || (!leafB && B.ranges[j].second - B.ranges[j].first > A.ranges[i].second - A.ranges[i].first)) {
        stack.push_back({i, B.kids[j].first});
        stack.push_back({i, B.kids[j].second});
      } else {
        stack.push_back({A.kids[i].first, j});
        stack.push_back({A.kids[i].second, j});
      }
    }
  }
  std::vector<Contact> contacts;
  auto covered = [&](double t) {
    for (const Contact& c : contacts)
      if (t >= c.t0 && t <= c.t1) return true;
    return false;
  };
  std::sort(seeds.begin(), seeds.end());
  for (auto [ta, tb] : seeds) {
    if (covered(ta)) continue;
    minimize(a, ra, b, rb, ta, tb);
    if (covered(ta)) continue;
    double gap = len(at(a, ta).p - at(b, tb).p);
    if (gap > tol) continue;
    contacts.push_back(measure(a, ra, b, rb, ta, tb, tol));
  }
  // A closed curve's contact across its seam is found twice, one reaching its range's start, one its end (where the
  // least gap is located only to about sqrt(tol), so not at the same parameter): one contact, the smaller gap kept.
  auto closed = [&](const Curve& c, Range r) { return len(at(c, r.lo).p - at(c, r.hi).p) <= tol; };
  const bool closedA = closed(a, ra), closedB = closed(b, rb);
  auto seam = [](bool isClosed, Range r, double lo0, double hi0, double lo1, double hi1) {
    return isClosed && ((lo0 == r.lo && hi1 == r.hi) || (lo1 == r.lo && hi0 == r.hi));
  };
  // Two parameter ranges on c that overlap, or whose nearest ends are within tol of each other (rounding).
  auto meets = [&](const Curve& c, double lo0, double hi0, double lo1, double hi1) {
    if (lo0 <= hi1 && lo1 <= hi0) return true;
    double gapEnds = lo0 > hi1 ? len(at(c, lo0).p - at(c, hi1).p) : len(at(c, lo1).p - at(c, hi0).p);
    return gapEnds <= tol;
  };
  for (size_t i = 0; i < contacts.size(); i++)
    for (size_t j = i + 1; j < contacts.size(); j++) {
      const Contact &x = contacts[i], &y = contacts[j];
      double xb0 = std::min(x.tb0, x.tb1), xb1 = std::max(x.tb0, x.tb1), yb0 = std::min(y.tb0, y.tb1),
        yb1 = std::max(y.tb0, y.tb1);
      bool sameA = seam(closedA, ra, x.t0, x.t1, y.t0, y.t1) || meets(a, x.t0, x.t1, y.t0, y.t1);
      bool sameB = seam(closedB, rb, xb0, xb1, yb0, yb1) || meets(b, xb0, xb1, yb0, yb1);
      if (!sameA || !sameB) continue;
      if (y.gap < x.gap) contacts[i] = y;
      contacts.erase(contacts.begin() + static_cast<long>(j));
      j = i;
    }
  for (const Contact& c : contacts) {
    // The rule (the file's comment): the local shape where the gap is least against the tolerance at each end.
    P2 A0 = at(a, c.ta), B0 = at(b, c.tb);
    double sinTheta = std::fabs(cross(A0.d1, B0.d1)) / (len(A0.d1) * len(B0.d1));
    double cosTheta = dot(A0.d1, B0.d1);
    double dk = std::fabs(curvature(A0) - (cosTheta < 0 ? -1 : 1) * curvature(B0));
    auto separates = [&](double s) { return sinTheta * s + dk * s * s / 2 >= tol / 2; };
    bool isolated = c.t0 == c.t1 || separates(length(a, c.t0, c.ta)) || separates(length(a, c.ta, c.t1))
      || length(a, c.t0, c.t1) <= tol || length(b, std::min(c.tb0, c.tb1), std::max(c.tb0, c.tb1)) <= tol;
    if (!isolated) {
      out.overlaps.push_back({{c.t0, c.t1}, {std::min(c.tb0, c.tb1), std::max(c.tb0, c.tb1)}, cosTheta > 0});
      continue;
    }
    // Crossing or tangency: the signed gap at the contact's ends (or just past them).
    double tb0 = c.tb0, tb1 = c.tb1;
    double g0 = signedGap(a, b, rb, c.t0, tb0), g1 = signedGap(a, b, rb, c.t1, tb1);
    bool crossing = (g0 < 0) != (g1 < 0) && std::fabs(g0) > tol / 4 && std::fabs(g1) > tol / 4;
    double ta = c.ta, tb = c.tb;
    if (crossing) {
      // Newton on a(ta) - b(tb) = 0 from the least gap.
      for (int it = 0; it < 30; it++) {
        P2 A = at(a, ta), B = at(b, tb);
        Vec2 f = A.p - B.p;
        double det = cross(A.d1, B.d1);
        if (det == 0) break;
        double dta = cross(B.d1, f) / det, dtb = cross(A.d1, f) / det;
        ta = std::clamp(ta + dta, ra.lo, ra.hi);
        tb = std::clamp(tb + dtb, rb.lo, rb.hi);
        if (std::fabs(dta) + std::fabs(dtb) <= 1e-15 * (1 + std::fabs(ta) + std::fabs(tb))) break;
      }
    }
    Vec2 p = 0.5 * (at(a, ta).p + at(b, tb).p);
    out.crossings.push_back({ta, tb, p, !crossing});
  }
  std::sort(out.crossings.begin(), out.crossings.end(),
    [](const Crossing& x, const Crossing& y) { return x.ta < y.ta; });
  std::sort(out.overlaps.begin(), out.overlaps.end(),
    [](const Overlap& x, const Overlap& y) { return x.a.lo < y.a.lo; });
  return out;
}

// ---- Loops ----

namespace {

Vec2 pieceStart(const LoopPiece& p) { return at(*p.curve, p.reversed ? p.range.hi : p.range.lo).p; }
Vec2 pieceEnd(const LoopPiece& p) { return at(*p.curve, p.reversed ? p.range.lo : p.range.hi).p; }
/** The piece's direction of travel at t. */
Vec2 travel(const LoopPiece& p, double t) {
  Vec2 d = at(*p.curve, t).d1;
  return p.reversed ? -d : d;
}

bool onPole(Vec2 q, const Periods& per, double tol, bool& isU, double& c) {
  for (double u : per.poleU)
    if (std::fabs(q.x - u) <= tol) { isU = true; c = u; return true; }
  for (double v : per.poleV)
    if (std::fabs(q.y - v) <= tol) { isU = false; c = v; return true; }
  return false;
}

/** How many periods (k) b is from a in each direction, if it's a whole number of them within tol. */
bool periodsApart(Vec2 a, Vec2 b, const Periods& per, double tol) {
  auto whole = [&](double d, double period) {
    if (std::fabs(d) <= tol) return true;
    if (period <= 0) return false;
    double k = std::round(d / period);
    return k != 0 && std::fabs(d - k * period) <= tol;
  };
  return whole(b.x - a.x, per.u) && whole(b.y - a.y, per.v) && len(b - a) > tol;
}

/** A loop's boundary pieces with closures: pole-line jumps get a Segment (owned by `segments`). */
struct Boundary {
  std::vector<LoopPiece> pieces;
  std::vector<int> loopOf, next, prev;  // within the piece's loop, in its order of travel
  std::vector<std::unique_ptr<Segment>> segments;
  bool gaps = false;  // pieces that don't meet and aren't a pole jump or a period apart
};

void addLoop(Boundary& out, const Loop2& loop, int index, const Periods& per, double tol) {
  const size_t n = loop.pieces.size();
  const int first = static_cast<int>(out.pieces.size());
  for (size_t i = 0; i < n; i++) {
    out.pieces.push_back(loop.pieces[i]);
    out.loopOf.push_back(index);
    Vec2 e = pieceEnd(loop.pieces[i]), s = pieceStart(loop.pieces[(i + 1) % n]);
    if (len(s - e) <= tol) continue;
    bool eu, su;
    double ec, sc;
    bool pole = onPole(e, per, tol, eu, ec) && onPole(s, per, tol, su, sc) && eu == su && ec == sc;
    if (pole) {
      out.segments.push_back(std::make_unique<Segment>(e, s));
      out.pieces.push_back({out.segments.back().get(), {0, 1}, false});
      out.loopOf.push_back(index);
    } else if (!periodsApart(e, s, per, tol)) {
      out.gaps = true;
      out.segments.push_back(std::make_unique<Segment>(e, s));
      out.pieces.push_back({out.segments.back().get(), {0, 1}, false});
      out.loopOf.push_back(index);
    }
  }
  const int last = static_cast<int>(out.pieces.size());
  for (int i = first; i < last; i++) {
    out.next.push_back(i + 1 < last ? i + 1 : first);
    out.prev.push_back(i > first ? i - 1 : last - 1);
  }
}

struct Bbox {
  double x0 = kInf, y0 = kInf, x1 = -kInf, y1 = -kInf;
  void add(Vec2 q) { x0 = std::min(x0, q.x), y0 = std::min(y0, q.y), x1 = std::max(x1, q.x), y1 = std::max(y1, q.y); }
};
Bbox pieceBox(const LoopPiece& p) {
  Bbox b;
  Poly poly = polyline(*p.curve, p.range, kInf);
  for (const Vec2& q : poly.p) b.add(q);
  double grow = 0;
  for (double d : poly.dev) grow = std::max(grow, d);
  b.x0 -= grow, b.y0 -= grow, b.x1 += grow, b.y1 += grow;
  return b;
}

/** A Curve shifted by (du, dv): the copies periodic directions need. */
class Shifted final : public Curve {
public:
  Shifted(const Curve& c, Vec2 d) : c_(c), d_(d) {}
  int dim() const override { return 2; }
  CurveDomain domain() const override { return c_.domain(); }
  Status eval(double t, int order, CurvePoint& out) const override {
    Status s = c_.eval(t, order, out);
    out.p.x += d_.x, out.p.y += d_.y;
    return s;
  }
  void breaks(Range r, std::vector<double>& out) const override { c_.breaks(r, out); }
  Status bound(Range r, Box3& out) const override {
    Status s = c_.bound(r, out);
    out.x = out.x + Interval::point(d_.x), out.y = out.y + Interval::point(d_.y);
    return s;
  }
  Status derivBound(Range r, int order, double& out) const override { return c_.derivBound(r, order, out); }
  void singular(Range r, std::vector<double>& out) const override { c_.singular(r, out); }

private:
  const Curve& c_;
  Vec2 d_;
};

/** Each piece's copies (shifts) whose box meets the box [x0, x1] x [y0, y1], in periodic directions. */
std::vector<Vec2> shifts(const Bbox& piece, const Bbox& near, const Periods& per) {
  auto ks = [](double lo, double hi, double nlo, double nhi, double period) {
    std::vector<double> out;
    if (period <= 0) return std::vector<double>{0};
    int k0 = static_cast<int>(std::floor((nlo - hi) / period)), k1 = static_cast<int>(std::ceil((nhi - lo) / period));
    for (int k = k0; k <= k1; k++) out.push_back(k * period);
    return out;
  };
  std::vector<Vec2> out;
  for (double dx : ks(piece.x0, piece.x1, near.x0, near.x1, per.u))
    for (double dy : ks(piece.y0, piece.y1, near.y0, near.y1, per.v)) out.push_back({dx, dy});
  return out;
}

/** p within tol of the boundary (any copy). */
bool onBoundary(const Boundary& bd, Vec2 p, const Periods& per, double tol) {
  Bbox near;
  near.add({p.x - tol, p.y - tol});
  near.add({p.x + tol, p.y + tol});
  for (const LoopPiece& piece : bd.pieces) {
    Bbox b = pieceBox(piece);
    for (Vec2 d : shifts(b, near, per)) {
      if (b.x0 + d.x - tol > p.x || b.x1 + d.x + tol < p.x || b.y0 + d.y - tol > p.y || b.y1 + d.y + tol < p.y)
        continue;
      Vec2 q = p - d;
      // The nearest point by the polyline's nearest vertex, then Newton.
      Poly poly = polyline(*piece.curve, piece.range, tol);
      size_t best = 0;
      for (size_t i = 1; i < poly.p.size(); i++)
        if (len(poly.p[i] - q) < len(poly.p[best] - q)) best = i;
      double t = project(*piece.curve, piece.range, q, poly.t[best]);
      if (len(at(*piece.curve, t).p - q) <= tol) return true;
    }
  }
  return false;
}

enum class RayResult { in, out, retry, none };

/** The ray from p along dir (length L): in or out by the nearest boundary it meets, or retry if that's degenerate. */
RayResult cast(const Boundary& bd, Vec2 p, Vec2 dir, double L, const Periods& per, double tol) {
  Segment ray(p, p + L * dir);
  Bbox near;
  near.add(p);
  near.add(p + L * dir);
  double best = kInf;
  RayResult result = RayResult::out;
  bool hit = false;
  for (size_t k = 0; k < bd.pieces.size(); k++) {
    const LoopPiece& piece = bd.pieces[k];
    Bbox b = pieceBox(piece);
    for (Vec2 d : shifts(b, near, per)) {
      if (b.x0 + d.x > near.x1 + tol || b.x1 + d.x < near.x0 - tol || b.y0 + d.y > near.y1 + tol
        || b.y1 + d.y < near.y0 - tol)
        continue;
      Shifted copy(*piece.curve, d);
      Intersections2 x = intersect2(ray, {0, 1}, copy, piece.range, tol);
      for (const Overlap& o : x.overlaps)
        if (o.a.lo * L < best) best = o.a.lo * L, result = RayResult::retry, hit = true;
      for (const Crossing& c : x.crossings) {
        double s = c.ta * L;
        if (s >= best) continue;
        best = s;
        hit = true;
        if (c.tangent) {
          result = RayResult::retry;
          continue;
        }
        // At a piece's end the loop goes on in its neighbour (the same piece, a period on, for a band): p must be on
        // the same side of both, else the ray passes through a corner and decides nothing.
        double speed = len(at(*piece.curve, c.tb).d1);
        bool atLo = std::fabs(c.tb - piece.range.lo) * speed <= tol;
        bool atHi = std::fabs(c.tb - piece.range.hi) * speed <= tol;
        if (atLo || atHi) {
          bool travelStart = atLo != piece.reversed;
          const LoopPiece& nb = bd.pieces[travelStart ? bd.prev[k] : bd.next[k]];
          double joint = travelStart != nb.reversed ? nb.range.hi : nb.range.lo;  // the neighbour's end at the joint
          double here = cross(travel(piece, c.tb), p - c.p), there = cross(travel(nb, joint), p - c.p);
          if ((here > 0) != (there > 0) || here == 0 || there == 0) {
            result = RayResult::retry;
            continue;
          }
          result = here > 0 ? RayResult::in : RayResult::out;
          continue;
        }
        // p on the piece's left (its direction of travel): in.
        double side;
        if (straight(*piece.curve, piece.range)) {
          Vec2 s0 = at(copy, piece.reversed ? piece.range.hi : piece.range.lo).p;
          Vec2 s1 = at(copy, piece.reversed ? piece.range.lo : piece.range.hi).p;
          side = orient2d(s0, s1, p);
        } else {
          side = cross(travel(piece, c.tb), p - c.p);
        }
        result = side > 0 ? RayResult::in : side < 0 ? RayResult::out : RayResult::retry;
      }
    }
  }
  return hit ? result : RayResult::none;
}

Side classifyBoundary(const Boundary& bd, Vec2 p, const Periods& per, double tol, Status& status) {
  if (onBoundary(bd, p, per, tol)) return Side::on;
  if (bd.pieces.empty()) return Side::in;
  Bbox all;
  for (const LoopPiece& piece : bd.pieces) {
    Bbox b = pieceBox(piece);
    all.add({b.x0, b.y0});
    all.add({b.x1, b.y1});
  }
  double reach = 2 * (std::max(all.x1 - all.x0, all.y1 - all.y0) + len(p - Vec2{all.x0, all.y0})) + 1;
  // Directions: up and down in v unless it's periodic (then one period), then u, then slanted ones.
  const double pi = 3.14159265358979323846;
  for (int k = 0; k < 24; k++) {
    double angle = pi / 2 + k * 0.7389;  // a fixed irrational-ish turn per try
    Vec2 dir{std::cos(angle), std::sin(angle)};
    if (k == 0) dir = {0, 1};
    if (k == 1) dir = {0, -1};
    if (k == 2) dir = {1, 0};
    if (k == 3) dir = {-1, 0};
    double L = reach;
    if (per.u > 0 && per.v > 0) L = std::max(per.u, per.v) / std::max(std::fabs(dir.x), std::fabs(dir.y));
    else if (per.v > 0 && std::fabs(dir.y) > 0.5) L = per.v / std::fabs(dir.y);
    else if (per.u > 0 && std::fabs(dir.x) > 0.5) L = per.u / std::fabs(dir.x);
    else if (per.v > 0 || per.u > 0) {
      // Along the non-periodic direction (or close to it): to beyond the boundary.
      L = reach;
    }
    RayResult r = cast(bd, p, dir, L, per, tol);
    // Meeting nothing: out along a ray to beyond the boundary; along one period it says nothing (a band's loops run
    // parallel to it).
    if (r == RayResult::none) {
      if (L == reach) return Side::out;
      continue;
    }
    if (r == RayResult::retry) continue;
    return r == RayResult::in ? Side::in : Side::out;
  }
  status = Status::noConvergence;
  return Side::out;
}

} // namespace

Intersections2 selfIntersect2(const Loop2& loop, double tol) {
  Intersections2 out;
  out.status = Status::ok;
  const int n = static_cast<int>(loop.pieces.size());
  // A piece's parameter as the loop's: index + fraction along its direction of travel.
  auto loopT = [&](int i, double t) {
    const LoopPiece& p = loop.pieces[i];
    double w = p.range.hi - p.range.lo, f = w > 0 ? (t - p.range.lo) / w : 0;
    if (p.reversed) f = 1 - f;
    double s = i + f;
    return s >= n ? s - n : s;
  };
  auto near = [&](double x, double y) {
    double d = std::fabs(x - y);
    return std::min(d, n - d) <= 1e-9;
  };
  auto add = [&](Crossing c) {
    for (const Crossing& d : out.crossings)
      if ((near(d.ta, c.ta) && near(d.tb, c.tb)) || (near(d.ta, c.tb) && near(d.tb, c.ta))) return;
    if (c.ta > c.tb) std::swap(c.ta, c.tb);
    out.crossings.push_back(c);
  };
  // Snap a loop parameter within tol (in distance) of a piece end to the end's index (the next piece's start).
  auto snap = [&](int i, double t) {
    const LoopPiece& p = loop.pieces[i];
    double speed = len(at(*p.curve, t).d1);
    double s = loopT(i, t);
    double r = std::round(s);
    if (std::fabs(s - r) * (p.range.hi - p.range.lo) * speed <= tol) s = r >= n ? r - n : r;
    return s;
  };
  for (int i = 0; i < n; i++)
    for (int j = i + 1; j < n; j++) {
      const LoopPiece &A = loop.pieces[i], &B = loop.pieces[j];
      bool neighbours = j == i + 1 || (i == 0 && j == n - 1);
      Intersections2 x = intersect2(*A.curve, A.range, *B.curve, B.range, tol);
      if (x.status != Status::ok) out.status = x.status;
      for (const Crossing& c : x.crossings) {
        double sa = snap(i, c.ta), sb = snap(j, c.tb);
        // Neighbours' shared end isn't a self-intersection.
        if (neighbours && near(sa, sb)) continue;
        // At a vertex the loop passes twice: crossing or touching by the passages' directions.
        bool vertexA = sa == std::floor(sa), vertexB = sb == std::floor(sb);
        Crossing r{sa, sb, c.p, c.tangent};
        if (vertexA || vertexB) {
          auto passage = [&](double s, Vec2& in, Vec2& outDir) {
            int k = static_cast<int>(std::floor(s)) % n;
            double f = s - std::floor(s);
            const LoopPiece& here = loop.pieces[k];
            auto tOf = [&](const LoopPiece& p, double frac) {
              double ff = p.reversed ? 1 - frac : frac;
              return p.range.lo + ff * (p.range.hi - p.range.lo);
            };
            if (f == 0) {
              const LoopPiece& prev = loop.pieces[(k + n - 1) % n];
              in = -travel(prev, tOf(prev, 1));
              outDir = travel(here, tOf(here, 0));
            } else {
              in = -travel(here, tOf(here, f));
              outDir = travel(here, tOf(here, f));
            }
          };
          Vec2 ai, ao, bi, bo;
          passage(sa, ai, ao);
          passage(sb, bi, bo);
          // b's directions on both sides of a's passage (the turn from ai to ao, counterclockwise): a crossing.
          auto angle = [](Vec2 v) { return std::atan2(v.y, v.x); };
          auto between = [&](double x, double lo, double hi) {
            const double tau = 6.283185307179586;
            double d = std::fmod(x - lo + 2 * tau, tau), w = std::fmod(hi - lo + 2 * tau, tau);
            return d > 0 && d < w;
          };
          double a0 = angle(ao), a1 = angle(ai);
          bool b1 = between(angle(bi), a0, a1), b2 = between(angle(bo), a0, a1);
          r.tangent = b1 == b2;
        }
        add(r);
      }
      for (const Overlap& o : x.overlaps) {
        if (neighbours) {
          // Neighbours overlapping beyond their shared end fold back on themselves: still reported.
          double l = o.a.hi - o.a.lo;
          if (!(l > 0)) continue;
        }
        Overlap r{{loopT(i, o.a.lo), loopT(i, o.a.hi)}, {loopT(j, o.b.lo), loopT(j, o.b.hi)}, o.sameDirection};
        if (r.a.lo > r.a.hi) std::swap(r.a.lo, r.a.hi);
        if (r.b.lo > r.b.hi) std::swap(r.b.lo, r.b.hi);
        out.overlaps.push_back(r);
      }
    }
  std::sort(out.crossings.begin(), out.crossings.end(),
    [](const Crossing& x, const Crossing& y) { return x.ta < y.ta; });
  return out;
}

Estimate signedArea2(const Loop2& loop) {
  // Green: A = 1/2 * integral of (x dy - y dx) around the loop; straight pieces (and the closing chords between pieces
  // that don't meet) exactly, 1/2 cross(start, end).
  Estimate total{0, 0, Status::ok};
  const size_t n = loop.pieces.size();
  for (size_t i = 0; i < n; i++) {
    const LoopPiece& piece = loop.pieces[i];
    Vec2 s = pieceStart(piece), e = pieceEnd(piece), next = pieceStart(loop.pieces[(i + 1) % n]);
    total.value += 0.5 * cross(e, next);
    if (straight(*piece.curve, piece.range)) {
      total.value += 0.5 * cross(s, e);
      continue;
    }
    Estimate q = quadrature::integrate(
      [&](double t) {
        P2 e2 = at(*piece.curve, t);
        return 0.5 * cross(e2.p, e2.d1);
      },
      piece.range.lo, piece.range.hi, 0, 1e-13);
    total.value += piece.reversed ? -q.value : q.value;
    total.error += q.error;
    if (q.status != Status::ok) total.status = q.status;
  }
  return total;
}

Side classify2(const std::vector<Loop2>& loops, Vec2 p, Periods periods, double tol, Status& status) {
  status = Status::ok;
  Boundary bd;
  for (size_t i = 0; i < loops.size(); i++) addLoop(bd, loops[i], static_cast<int>(i), periods, tol);
  if (bd.gaps) status = Status::invalidModel;
  // On a pole line: on if the face reaches it (a point just off it, on either side, is in).
  bool isU;
  double c;
  if (onPole(p, periods, tol, isU, c)) {
    Status s2 = Status::ok;
    for (double side : {-1.0, 1.0}) {
      double off = 1e3 * tol + 1e-9 * std::fabs(c);
      Vec2 q = isU ? Vec2{c + side * off, p.y} : Vec2{p.x, c + side * off};
      if (classifyBoundary(bd, q, periods, tol, s2) != Side::out) return Side::on;
    }
    return Side::out;
  }
  Side s = classifyBoundary(bd, p, periods, tol, status);
  return s;
}

std::vector<int> nest2(const std::vector<Loop2>& loops, Periods periods, double tol, Status& status) {
  status = Status::ok;
  const int n = static_cast<int>(loops.size());
  std::vector<int> parent(n, -1);
  std::vector<double> area(n);
  std::vector<bool> winds(n, false);
  for (int i = 0; i < n; i++) {
    // A loop winds around a period when its pieces' net displacement is a nonzero whole number of periods.
    Vec2 net{0, 0};
    for (const LoopPiece& piece : loops[i].pieces) net = net + (pieceEnd(piece) - pieceStart(piece));
    Boundary one;
    addLoop(one, loops[i], i, periods, tol);
    for (size_t k = loops[i].pieces.size(); k < one.pieces.size(); k++)
      net = net + (pieceEnd(one.pieces[k]) - pieceStart(one.pieces[k]));
    winds[i] = len(net) > tol;
    area[i] = std::fabs(signedArea2(loops[i]).value);
  }
  for (int i = 0; i < n; i++) {
    if (winds[i]) continue;
    for (int j = 0; j < n; j++) {
      if (j == i || winds[j]) continue;
      // Loop j as an enclosure (counterclockwise whatever its orientation): a point of loop i off loop j inside it.
      Loop2 enclosure = loops[j];
      if (signedArea2(loops[j]).value < 0) {
        std::reverse(enclosure.pieces.begin(), enclosure.pieces.end());
        for (LoopPiece& piece : enclosure.pieces) piece.reversed = !piece.reversed;
      }
      Boundary bj;
      addLoop(bj, enclosure, j, periods, tol);
      bool decided = false, inside = false;
      for (const LoopPiece& piece : loops[i].pieces) {
        for (double f : {0.5, 0.25, 0.75, 0.125}) {
          Vec2 q = at(*piece.curve, piece.range.lo + f * (piece.range.hi - piece.range.lo)).p;
          Status s2;
          Side side = classifyBoundary(bj, q, periods, tol, s2);
          if (side == Side::on) continue;
          inside = side == Side::in;
          decided = true;
          break;
        }
        if (decided) break;
      }
      if (decided && inside && (parent[i] < 0 || area[j] < area[parent[i]])) parent[i] = j;
    }
  }
  return parent;
}

} // namespace cadgeom
