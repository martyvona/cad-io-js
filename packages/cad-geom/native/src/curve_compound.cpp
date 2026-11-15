// Curves made of others: trimmed curves (ISO 10303-42's TRIMMED_CURVE: the basis's parameter, the range from the
// trims, sorted), composites (segment k over [k, k + 1] mapped linearly onto the segment's own range, reversed where it
// runs against itself: the library's parameterization) and offsets (OFFSET_CURVE_3D, OFFSET_CURVE_2D: the basis plus
// d times the unit of B' x V, in 2D of B' turned -90 degrees), as docs/brep-reference.md defines them.
// An offset's derivatives are exact: with n the unnormalized direction (B' x V, so n^(j) = B^(j+1) x V), s = |n| and
// u = n / s, differentiating s^2 = n . n and n = s u gives s^(k) = sum_{j<k} (k-1 j) u^(j) . n^(k-j) and u^(k) = (n^(k)
// - sum_{j=1..k} (k j) s^(j) u^(k-j)) / s, so C^(k) = B^(k) + d u^(k) needs the basis's derivatives to order k + 1. The
// same identities with norms bound |u^(k)| over a range by the bounds of B's derivatives and the least |n| there, the
// distance from the origin of the box of B' x V.
#include <algorithm>
#include <cmath>

#include "curve_impl.h"

namespace cadgeom {
namespace curves {

namespace {

/** The box of a x v for a in the box and v a fixed vector (interval arithmetic). */
Box3 crossBox(const Box3& a, Vec3 v) {
  Interval vx = Interval::point(v.x), vy = Interval::point(v.y), vz = Interval::point(v.z);
  return {a.y * vz - a.z * vy, a.z * vx - a.x * vz, a.x * vy - a.y * vx};
}
Box3 scaleBox(const Box3& b, double s) {
  auto f = [s](Interval x) { return Interval::hull(s * x.lo, s * x.hi); };
  Box3 o{f(b.x), f(b.y), f(b.z)};
  return widen(o, 2 * kEps * boxMag(o));
}

class Trimmed final : public CurveImpl {
public:
  Trimmed(std::unique_ptr<CurveImpl> basis, Range r) : b_(std::move(basis)), r_(r) {}
  int dim() const override { return b_->dim(); }
  CurveDomain domain() const override { return {r_, 0}; }
  Status derivs(double t, int order, Vec3* out) const override {
    Status s = Status::ok;
    if (t < r_.lo || t > r_.hi) s = Status::outOfDomain, t = std::clamp(t, r_.lo, r_.hi);
    Status e = b_->derivs(t, order, out);
    return e == Status::ok ? s : e;
  }
  void breaks(Range r, std::vector<double>& out) const override { b_->breaks(clip(r), out); }
  Status derivBox(Range r, int order, Box3& out) const override { return b_->derivBox(clip(r), order, out); }
  Status derivBoundN(Range r, int order, double& out) const override {
    return b_->derivBoundN(clip(r), order, out);
  }
  void singular(Range r, std::vector<double>& out) const override { b_->singular(clip(r), out); }
  Range within(Vec3 p, double d) const override {
    // On a periodic basis the cut is in the basis's own range ([0, 2 pi) for a circle) while the trim's may lie
    // anywhere (across 0: [-pi / 2, pi / 2]), so clipping one to the other loses part of the trim: the whole trim
    // (the periodic kinds' cut is their whole period in any case).
    if (b_->domain().period > 0) return r_;
    return clip(b_->within(p, d));
  }
  bool exactLength(double t0, double t1, double& out) const override { return b_->exactLength(t0, t1, out); }

private:
  Range clip(Range r) const {
    Range c{std::fmax(r.lo, r_.lo), std::fmin(r.hi, r_.hi)};
    return c.lo <= c.hi ? c : Range{c.lo, c.lo};
  }
  std::unique_ptr<CurveImpl> b_;
  Range r_;
};

class Composite final : public CurveImpl {
public:
  explicit Composite(std::vector<Segment> s) : s_(std::move(s)) {
    for (const Segment& g : s_) ranges_.push_back(g.curve->domain().range);
  }
  int dim() const override { return s_[0].curve->dim(); }
  CurveDomain domain() const override { return {{0, static_cast<double>(s_.size())}, 0}; }
  Status derivs(double t, int order, Vec3* out) const override {
    Status s = Status::ok;
    double n = static_cast<double>(s_.size());
    if (t < 0 || t > n) s = Status::outOfDomain, t = std::clamp(t, 0.0, n);
    int k = segment(t);
    Status e = s_[k].curve->derivs(local(k, t), order, out);
    double sc = scale(k), m = 1;
    for (int j = 1; j <= order; j++) m *= sc, out[j] = m * out[j];
    return e == Status::ok ? s : e;
  }
  void breaks(Range r, std::vector<double>& out) const override {
    out = {r.lo};
    std::vector<double> b;
    forPieces(r, [&](int k, Range g, Range) {
      if (k > r.lo && k < r.hi && k > out.back()) out.push_back(k);
      s_[k].curve->breaks(g, b);
      std::vector<double> mapped;
      for (double u : b) mapped.push_back(global(k, u));
      std::sort(mapped.begin(), mapped.end());
      for (double t : mapped)
        if (t > out.back() && t < r.hi) out.push_back(t);
    });
    out.push_back(r.hi);
  }
  Status derivBox(Range r, int order, Box3& out) const override {
    out = emptyBox();
    Status s = Status::ok;
    forPieces(r, [&](int k, Range g, Range) {
      Box3 b;
      Status e = s_[k].curve->derivBox(g, order, b);
      if (e != Status::ok) s = e;
      out = hull(out, scaleBox(b, std::pow(scale(k), order)));
    });
    return s;
  }
  Status derivBoundN(Range r, int order, double& out) const override {
    out = 0;
    Status s = Status::ok;
    forPieces(r, [&](int k, Range g, Range) {
      double b;
      Status e = s_[k].curve->derivBoundN(g, order, b);
      if (e != Status::ok) s = e;
      out = std::fmax(out, b * std::pow(std::fabs(scale(k)), order) * (1 + 4 * kEps));
    });
    return s;
  }
  void singular(Range r, std::vector<double>& out) const override {
    out.clear();
    std::vector<double> z;
    forPieces(r, [&](int k, Range g, Range) {
      s_[k].curve->singular(g, z);
      std::vector<double> mapped;
      for (double u : z) mapped.push_back(global(k, u));
      std::sort(mapped.begin(), mapped.end());
      for (double t : mapped)
        if (out.empty() || t > out.back()) out.push_back(t);
    });
  }
  bool exactLength(double t0, double t1, double& out) const override {
    out = 0;
    bool all = true;
    forPieces({t0, t1}, [&](int k, Range g, Range) {
      double l;
      if (!s_[k].curve->exactLength(g.lo, g.hi, l)) all = false;
      out += l;
    });
    return all;
  }

private:
  int segment(double t) const {
    return std::clamp(static_cast<int>(std::floor(t)), 0, static_cast<int>(s_.size()) - 1);
  }
  /** d(local parameter) / dt on segment k: its range's length, negated where it runs against itself. */
  double scale(int k) const {
    double len = ranges_[k].hi - ranges_[k].lo;
    return s_[k].sameSense ? len : -len;
  }
  double local(int k, double t) const {
    double f = t - k;
    const Range& g = ranges_[k];
    return s_[k].sameSense ? g.lo + f * (g.hi - g.lo) : g.hi - f * (g.hi - g.lo);
  }
  double global(int k, double u) const {
    const Range& g = ranges_[k];
    double len = g.hi - g.lo;
    if (!(len > 0)) return k;
    return k + (s_[k].sameSense ? (u - g.lo) / len : (g.hi - u) / len);
  }
  /** Each segment r meets: its index, the local range (sorted) and the global one. */
  template <class F> void forPieces(Range r, F f) const {
    double n = static_cast<double>(s_.size());
    r = {std::fmax(r.lo, 0.0), std::fmin(r.hi, n)};
    if (r.lo > r.hi) return;
    for (int k = segment(r.lo); k < static_cast<int>(s_.size()); k++) {
      double a = std::fmax(r.lo, double(k)), b = std::fmin(r.hi, double(k + 1));
      if (a > b) break;
      double la = local(k, a), lb = local(k, b);
      f(k, Range{std::fmin(la, lb), std::fmax(la, lb)}, Range{a, b});
      // A range ending on a joint holds the next segment's start too: C(k + 1) is that segment's (derivs).
      if (b >= r.hi && !(b == k + 1 && k + 1 < n)) break;
    }
  }

  std::vector<Segment> s_;
  std::vector<Range> ranges_;
};

class Offset final : public CurveImpl {
public:
  Offset(std::unique_ptr<CurveImpl> basis, double d, Vec3 v) : b_(std::move(basis)), d_(d), v_(v) {}
  int dim() const override { return b_->dim(); }
  CurveDomain domain() const override { return b_->domain(); }
  Status derivs(double t, int order, Vec3* out) const override {
    if (order + 1 > kMaxOrder) return Status::unsupported;
    Vec3 B[kMaxOrder + 1];
    Status s = b_->derivs(t, order + 1, B);
    if (s != Status::ok && s != Status::outOfDomain) return s;
    Vec3 n[kMaxOrder + 1], u[kMaxOrder + 1];
    for (int j = 0; j <= order; j++) n[j] = normalOf(B[j + 1]);
    double S[kMaxOrder + 1];
    S[0] = norm(n[0]);
    for (int k = 0; k <= order; k++) out[k] = B[k];
    if (!(S[0] > 0)) return Status::singular;
    u[0] = (1 / S[0]) * n[0];
    for (int k = 1; k <= order; k++) {
      S[k] = 0;
      for (int j = 0; j < k; j++) S[k] += binom(k - 1, j) * dot(u[j], n[k - j]);
      Vec3 v = n[k];
      for (int j = 1; j <= k; j++) v = v - (binom(k, j) * S[j]) * u[k - j];
      u[k] = (1 / S[0]) * v;
    }
    for (int k = 0; k <= order; k++) out[k] = B[k] + d_ * u[k];
    return s;
  }
  void breaks(Range r, std::vector<double>& out) const override { b_->breaks(r, out); }
  Status derivBox(Range r, int order, Box3& out) const override {
    if (order == 0) {
      // The basis's box widened by |d| is a fixed size about the curve: met with the centred form, which shrinks.
      Status s = b_->derivBox(r, 0, out);
      out = widen(out, std::fabs(d_) * (1 + 4 * kEps) + 4 * kEps * boxMag(out));
      Box3 cb;
      if (s == Status::ok && centredBox(*this, r, 0, cb) == Status::ok) out = meet(out, cb);
      return s;
    }
    double U[kMaxOrder + 1];
    Status s = unitBounds(r, order, U);
    if (s != Status::ok) {
      out = entireBox();
      return s;
    }
    Box3 bb;
    s = b_->derivBox(r, order, bb);
    if (s != Status::ok) {
      out = entireBox();
      return s;
    }
    out = widen(bb, std::fabs(d_) * U[order] * (1 + 4 * kEps));
    Box3 cb;
    if (order + 1 <= kMaxOrder - 1 && centredBox(*this, r, order, cb) == Status::ok) out = meet(out, cb);
    return Status::ok;
  }
  Status derivBoundN(Range r, int order, double& out) const override {
    double U[kMaxOrder + 1], Bk;
    out = kInf;
    Status s = unitBounds(r, order, U);
    if (s != Status::ok) return s;
    s = b_->derivBoundN(r, order, Bk);
    if (s != Status::ok) return s;
    out = (Bk + std::fabs(d_) * U[order]) * (1 + 4 * kEps);
    return Status::ok;
  }
  void singular(Range r, std::vector<double>& out) const override {
    out.clear();
    std::vector<double> br, z;
    b_->breaks(r, br);
    for (size_t i = 0; i + 1 < br.size(); i++) {
      speedZeros(*this, {br[i], br[i + 1]}, z);
      for (double t : z)
        if (out.empty() || t > out.back()) out.push_back(t);
    }
  }
  Range within(Vec3 p, double d) const override { return b_->within(p, d + std::fabs(d_)); }

private:
  /** n for a tangent: B' x V in 3D, B' turned -90 degrees in 2D. */
  Vec3 normalOf(Vec3 t) const { return b_->dim() == 3 ? cross(t, v_) : Vec3{t.y, -t.x, 0}; }
  /**
   * Bounds U[0..order] on |u^(k)| over r (the unit normal's derivatives), r split in halves where the box of n there
   * holds the origin (a long range's tangents turn all round), to `depth` levels; singular where |n| may vanish.
   */
  Status unitBounds(Range r, int order, double* U, int depth = 0) const {
    if (order + 1 > kMaxOrder) return Status::unsupported;
    Box3 t;
    Status s = b_->derivBox(r, 1, t);
    if (s != Status::ok) return s;
    Box3 nb = b_->dim() == 3 ? crossBox(t, v_) : Box3{t.y, -t.x, Interval::point(0)};
    double smin = boxMinNorm(nb);
    if (!(smin > 0)) {
      if (depth >= 16 || !(r.hi > r.lo)) return Status::singular;
      double m = 0.5 * r.lo + 0.5 * r.hi, a[kMaxOrder + 1], b[kMaxOrder + 1];
      if ((s = unitBounds({r.lo, m}, order, a, depth + 1)) != Status::ok) return s;
      if ((s = unitBounds({m, r.hi}, order, b, depth + 1)) != Status::ok) return s;
      for (int k = 0; k <= order; k++) U[k] = std::fmax(a[k], b[k]);
      return Status::ok;
    }
    double vn = b_->dim() == 3 ? norm(v_) * (1 + 4 * kEps) : 1;
    double N[kMaxOrder + 1], S[kMaxOrder + 1];
    for (int j = 1; j <= order; j++) {
      double bj;
      s = b_->derivBoundN(r, j + 1, bj);
      if (s != Status::ok) return s;
      N[j] = bj * vn;
    }
    U[0] = 1;
    for (int k = 1; k <= order; k++) {
      S[k] = 0;
      for (int j = 0; j < k; j++) S[k] += binom(k - 1, j) * U[j] * N[k - j];
      double v = N[k];
      for (int j = 1; j <= k; j++) v += binom(k, j) * S[j] * U[k - j];
      U[k] = v / smin * (1 + 16 * kEps);
      // u' = (n' - (u . n') u) / s is n' / s without its part along u: |u'| <= |n'| / s, half the general bound.
      if (k == 1) U[1] = N[1] / smin * (1 + 16 * kEps);
    }
    return Status::ok;
  }

  std::unique_ptr<CurveImpl> b_;
  double d_;
  Vec3 v_;
};

} // namespace

std::unique_ptr<CurveImpl> makeTrimmed(std::unique_ptr<CurveImpl> basis, const double* r, int sense, int master,
  Status& status) {
  status = Status::ok;
  int d = basis->dim();
  CurveDomain dom = basis->domain();
  // Each trim's parameter: the one given, or the given point's projection on the basis (the point first where the
  // master representation is cartesian and both are given).
  auto trim = [&](double param, const double* point) {
    bool hasPoint = !std::isnan(point[0]);
    if (!std::isnan(param) && !(master == CBR_TRIM_CARTESIAN && hasPoint)) return param;
    if (!hasPoint) return param;
    Vec3 p = readVec(point, d);
    Range rr = dom.range;
    if (!finite(rr)) {
      Vec3 q[1];
      double t0 = std::clamp(0.0, rr.lo, rr.hi);
      basis->derivs(t0, 0, q);
      rr = basis->within(p, norm(q[0] - p));
    }
    CurveInversion inv = invertCurve(*basis, p, rr, 0);
    return inv.status == Status::ok && inv.certainty != Certainty::none ? inv.t : NAN;
  };
  double t1 = trim(r[0], r + 2), t2 = trim(r[1], r + 2 + d);
  Range range = dom.range;
  if (!std::isnan(t1) && !std::isnan(t2)) {
    // On a periodic basis the trim runs from t1 to t2 with the basis's direction (sense) or against it.
    if (dom.period > 0) {
      if (sense && t2 <= t1) t2 += dom.period;
      if (!sense && t2 >= t1) t2 -= dom.period;
    }
    range = {std::fmin(t1, t2), std::fmax(t1, t2)};
  }
  return std::make_unique<Trimmed>(std::move(basis), range);
}

std::unique_ptr<CurveImpl> makeComposite(std::vector<Segment> segments, Status& status) {
  status = Status::invalidModel;
  if (segments.empty()) return nullptr;
  for (const Segment& s : segments)
    if (!finite(s.curve->domain().range) || s.curve->dim() != segments[0].curve->dim()) return nullptr;
  status = Status::ok;
  return std::make_unique<Composite>(std::move(segments));
}

std::unique_ptr<CurveImpl> makeOffset(std::unique_ptr<CurveImpl> basis, double distance, Vec3 ref) {
  return std::make_unique<Offset>(std::move(basis), distance, ref);
}

} // namespace curves
} // namespace cadgeom
