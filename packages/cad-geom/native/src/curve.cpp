// curve.h, the reference version: lines, circles, polylines and B-splines (docs/brep-reference.md's definitions), the
// other kinds unsupported; inversion by dense sampling then Newton, arc length by quadrature span by span. Slow and
// simple, for the lanes that call it until the curves lane replaces it.
#include "cad_geom/curve.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "cad_geom/numerics.h"

namespace cadgeom {

namespace {

constexpr double kTwoPi = 6.283185307179586;
const double kInf = std::numeric_limits<double>::infinity();

Vec3 readVec(const double* r, int dim) { return {r[0], r[1], dim == 3 ? r[2] : 0.0}; }

Interval widen(Interval a, double by) { return {a.lo - by, a.hi + by}; }

class Line final : public Curve {
public:
  Line(const double* r, int dim) : dim_(dim), p_(readVec(r, dim)), d_(r[2 * dim] * readVec(r + dim, dim)) {}
  int dim() const override { return dim_; }
  CurveDomain domain() const override { return {{-kInf, kInf}, 0}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    out = {p_ + t * d_, order >= 1 ? d_ : Vec3{}, {}};
    return Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status bound(Range r, Box3& out) const override {
    Vec3 a = p_ + r.lo * d_, b = p_ + r.hi * d_;
    double e = 4 * std::numeric_limits<double>::epsilon() * (norm(a) + norm(b));
    out = {widen(Interval::hull(a.x, b.x), e), widen(Interval::hull(a.y, b.y), e), widen(Interval::hull(a.z, b.z), e)};
    return std::isfinite(r.lo) && std::isfinite(r.hi) ? Status::ok : Status::outOfDomain;
  }
  Status derivBound(Range, int order, double& out) const override {
    out = order == 1 ? norm(d_) * (1 + 1e-15) : 0.0;
    return Status::ok;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }

private:
  int dim_;
  Vec3 p_, d_;
};

class Circle final : public Curve {
public:
  Circle(const double* r, int dim) : dim_(dim) {
    if (dim == 3) {
      o_ = readVec(r, 3);
      Vec3 z = readVec(r + 3, 3);
      x_ = readVec(r + 6, 3);
      y_ = cross(z, x_);
      r_ = r[9];
    } else {
      o_ = readVec(r, 2);
      x_ = readVec(r + 2, 2);
      y_ = {-x_.y, x_.x, 0};
      r_ = r[4];
    }
  }
  int dim() const override { return dim_; }
  CurveDomain domain() const override { return {{0, kTwoPi}, kTwoPi}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    double c = std::cos(t), s = std::sin(t);
    out.p = o_ + r_ * c * x_ + r_ * s * y_;
    out.d1 = order >= 1 ? -r_ * s * x_ + r_ * c * y_ : Vec3{};
    out.d2 = order >= 2 ? -r_ * c * x_ - r_ * s * y_ : Vec3{};
    return Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status bound(Range, Box3& out) const override {
    // The whole circle's box: |x_i cos t + y_i sin t| <= hypot(x_i, y_i).
    double e = 1 + 1e-14;
    auto axis = [&](double o, double x, double y) {
      double h = r_ * std::hypot(x, y) * e;
      return Interval{o - h - 1e-14 * std::fabs(o), o + h + 1e-14 * std::fabs(o)};
    };
    out = {axis(o_.x, x_.x, y_.x), axis(o_.y, x_.y, y_.y), axis(o_.z, x_.z, y_.z)};
    return Status::ok;
  }
  Status derivBound(Range, int, double& out) const override {
    out = r_ * (1 + 1e-14);
    return Status::ok;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }

private:
  int dim_;
  Vec3 o_, x_, y_;
  double r_ = 0;
};

class Polyline final : public Curve {
public:
  Polyline(const double* r, int n, int dim) : dim_(dim) {
    for (int i = 0; i < n; i++) pts_.push_back(readVec(r + i * dim, dim));
  }
  int dim() const override { return dim_; }
  CurveDomain domain() const override { return {{0, static_cast<double>(pts_.size() - 1)}, 0}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    double last = static_cast<double>(pts_.size() - 1);
    Status s = (t < 0 || t > last) ? Status::outOfDomain : Status::ok;
    t = std::clamp(t, 0.0, last);
    int k = std::min(static_cast<int>(t), static_cast<int>(pts_.size()) - 2);
    Vec3 d = pts_[k + 1] - pts_[k];
    out = {pts_[k] + (t - k) * d, order >= 1 ? d : Vec3{}, {}};
    return s;
  }
  void breaks(Range r, std::vector<double>& out) const override {
    out = {r.lo};
    for (int k = static_cast<int>(std::floor(r.lo)) + 1; k < r.hi; k++) out.push_back(k);
    out.push_back(r.hi);
  }
  Status bound(Range r, Box3& out) const override {
    CurvePoint a, b;
    eval(r.lo, 0, a);
    eval(r.hi, 0, b);
    Vec3 lo = a.p, hi = a.p;
    auto add = [&](Vec3 p) {
      lo = {std::min(lo.x, p.x), std::min(lo.y, p.y), std::min(lo.z, p.z)};
      hi = {std::max(hi.x, p.x), std::max(hi.y, p.y), std::max(hi.z, p.z)};
    };
    add(b.p);
    for (int k = static_cast<int>(std::floor(r.lo)) + 1; k < r.hi; k++) add(pts_[k]);
    double e = 4 * std::numeric_limits<double>::epsilon() * (norm(lo) + norm(hi));
    out = {{lo.x - e, hi.x + e}, {lo.y - e, hi.y + e}, {lo.z - e, hi.z + e}};
    return Status::ok;
  }
  Status derivBound(Range r, int order, double& out) const override {
    out = 0;
    if (order != 1) return Status::ok;
    int a = std::max(0, static_cast<int>(std::floor(r.lo)));
    int b = std::min(static_cast<int>(pts_.size()) - 2, static_cast<int>(std::ceil(r.hi)) - 1);
    for (int k = a; k <= b; k++) out = std::max(out, norm(pts_[k + 1] - pts_[k]) * (1 + 1e-15));
    return Status::ok;
  }
  void singular(Range r, std::vector<double>& out) const override {
    out.clear();
    for (size_t k = 0; k + 1 < pts_.size(); k++)
      if (norm(pts_[k + 1] - pts_[k]) == 0 && k + 1 > r.lo && k < r.hi) out.push_back(std::max(r.lo, double(k)));
  }

private:
  int dim_;
  std::vector<Vec3> pts_;
};

class Spline final : public Curve {
public:
  Spline(BSpline c) : c_(std::move(c)) {}
  int dim() const override { return c_.dim; }
  CurveDomain domain() const override { return {{c_.knots[c_.degree], c_.knots[c_.poleCount()]}, 0}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    double v[9] = {};
    Status s = bspline::eval(c_, t, order, v);
    int d = c_.dim;
    out = {readVec(v, d), readVec(v + d, d), readVec(v + 2 * d, d)};
    return s;
  }
  void breaks(Range r, std::vector<double>& out) const override {
    out = {r.lo};
    for (double k : c_.knots)
      if (k > r.lo && k < r.hi && k != out.back()) out.push_back(k);
    out.push_back(r.hi);
  }
  Status bound(Range r, Box3& out) const override {
    // The poles of the spans r touches: a B-spline (rational, weights positive) lies in their convex hull.
    int n = c_.poleCount(), p = c_.degree, w = c_.dim + (c_.rational ? 1 : 0);
    int a = bspline::findSpan(p, c_.knots, n, r.lo), b = bspline::findSpan(p, c_.knots, n, r.hi);
    Vec3 lo{kInf, kInf, kInf}, hi{-kInf, -kInf, -kInf};
    for (int i = a - p; i <= b; i++) {
      Vec3 q = readVec(c_.poles.data() + i * w, c_.dim);
      lo = {std::min(lo.x, q.x), std::min(lo.y, q.y), std::min(lo.z, q.z)};
      hi = {std::max(hi.x, q.x), std::max(hi.y, q.y), std::max(hi.z, q.z)};
    }
    double e = 8 * std::numeric_limits<double>::epsilon() * (norm(lo) + norm(hi));
    out = {{lo.x - e, hi.x + e}, {lo.y - e, hi.y + e}, {lo.z - e, hi.z + e}};
    return Status::ok;
  }
  Status derivBound(Range, int, double&) const override { return Status::unsupported; }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }

private:
  BSpline c_;
};

} // namespace

std::unique_ptr<Curve> makeCurve(const Model& m, int row, Status& status) {
  status = Status::invalidModel;
  if (row < 0 || row >= m.curves()) return nullptr;
  int dim = m.curveDim(row);
  if (dim != 2 && dim != 3) return nullptr;
  const double* r = m.curveReals(row);
  const int32_t* in = m.curveInts(row);
  status = Status::ok;
  switch (m.curveKind(row)) {
  case CBR_CURVE_LINE: return std::make_unique<Line>(r, dim);
  case CBR_CURVE_CIRCLE: return std::make_unique<Circle>(r, dim);
  case CBR_CURVE_POLYLINE: return std::make_unique<Polyline>(r, in[0], dim);
  case CBR_CURVE_BSPLINE: {
    BSpline c;
    c.degree = in[0];
    int n = in[1], k = in[2];
    c.rational = in[3] != 0;
    c.dim = dim;
    c.knots = bspline::fullKnots(r, in + 7, k);
    const double* poles = r + k;
    const double* weights = poles + n * dim;
    for (int i = 0; i < n; i++) {
      for (int a = 0; a < dim; a++) c.poles.push_back(poles[i * dim + a]);
      if (c.rational) c.poles.push_back(weights[i]);
    }
    if (static_cast<int>(c.knots.size()) != n + c.degree + 1) {
      status = Status::invalidModel;
      return nullptr;
    }
    return std::make_unique<Spline>(std::move(c));
  }
  default: status = Status::unsupported; return nullptr;
  }
}

CurveInversion invertCurve(const Curve& c, Vec3 p, Range r, double tol) {
  CurveInversion out;
  CurveDomain dom = c.domain();
  if (!std::isfinite(r.lo) || !std::isfinite(r.hi)) {
    out.status = Status::unsupported;
    return out;
  }
  // Dense samples per span, each local minimum polished by Newton on f(t) = (C - p) . C'.
  std::vector<double> br;
  c.breaks(r, br);
  std::vector<std::pair<double, double>> minima;
  auto dist = [&](double t) {
    CurvePoint q;
    c.eval(t, 0, q);
    return norm(q.p - p);
  };
  auto polish = [&](double t, double lo, double hi) {
    for (int it = 0; it < 50; it++) {
      CurvePoint q;
      c.eval(t, 2, q);
      Vec3 e = q.p - p;
      double f = dot(e, q.d1), df = dot(q.d1, q.d1) + dot(e, q.d2);
      if (df <= 0) break;
      double nt = std::clamp(t - f / df, lo, hi);
      if (std::fabs(nt - t) <= 1e-15 * (1 + std::fabs(t))) { t = nt; break; }
      t = nt;
    }
    return t;
  };
  for (size_t s = 0; s + 1 < br.size(); s++) {
    const int N = 64;
    double a = br[s], b = br[s + 1], prev = dist(a), cur = dist(a + (b - a) / N);
    if (prev <= cur) minima.push_back({polish(a, a, b), 0});
    for (int i = 1; i < N; i++) {
      double next = dist(a + (b - a) * (i + 1) / N);
      if (cur <= prev && cur <= next) minima.push_back({polish(a + (b - a) * i / N, a, b), 0});
      prev = cur;
      cur = next;
    }
    if (cur <= prev) minima.push_back({polish(b, a, b), 0});
  }
  for (auto& m : minima) m.second = dist(m.first);
  std::sort(minima.begin(), minima.end(), [](auto& x, auto& y) { return x.second < y.second; });
  if (minima.empty()) {
    out.status = Status::ok;
    return out;
  }
  out.t = minima[0].first;
  out.distance = minima[0].second;
  CurvePoint q;
  c.eval(out.t, 0, q);
  out.foot = q.p;
  out.status = Status::ok;
  out.certainty = Certainty::unique;
  CurvePoint ends[2];
  c.eval(dom.range.lo, 0, ends[0]);
  c.eval(dom.range.hi, 0, ends[1]);
  bool closed = std::isfinite(dom.range.lo) && std::isfinite(dom.range.hi) && norm(ends[1].p - ends[0].p) <= tol;
  out.onSeam = closed && (norm(out.foot - ends[0].p) <= tol || norm(out.foot - ends[1].p) <= tol);
  for (size_t i = 1; i < minima.size(); i++) {
    double t = minima[i].first;
    bool same = std::fabs(t - out.t) <= 1e-9 * (1 + std::fabs(out.t));
    if (dom.period > 0) same = same || std::fabs(std::fabs(t - out.t) - dom.period) <= 1e-9 * dom.period;
    if (same) continue;
    CurvePoint qi;
    c.eval(t, 0, qi);
    if (minima[i].second - out.distance <= tol && norm(qi.p - out.foot) > tol) {
      out.certainty = Certainty::ambiguous;
      out.alternatives.push_back(t);
    }
  }
  return out;
}

Estimate arcLength(const Curve& c, double t0, double t1, double relTol) {
  std::vector<double> br;
  c.breaks({t0, t1}, br);
  Estimate total{0, 0, Status::ok};
  for (size_t s = 0; s + 1 < br.size(); s++) {
    Estimate e = quadrature::integrate(
      [&](double t) {
        CurvePoint q;
        c.eval(t, 1, q);
        return norm(q.d1);
      },
      br[s], br[s + 1], 0, relTol);
    total.value += e.value;
    total.error += e.error;
    if (e.status != Status::ok) total.status = e.status;
  }
  return total;
}

Estimate paramAtLength(const Curve& c, double t0, double length, double relTol) {
  // Bisection on arcLength over the domain's end (slow: the reference only).
  CurveDomain dom = c.domain();
  double hi = std::isfinite(dom.range.hi) ? dom.range.hi : t0 + 1;
  if (!std::isfinite(dom.range.hi))
    while (arcLength(c, t0, hi, relTol).value < length) hi = t0 + 2 * (hi - t0);
  double lo = t0;
  for (int it = 0; it < 200 && hi - lo > 1e-15 * (1 + std::fabs(hi)); it++) {
    double mid = 0.5 * (lo + hi);
    if (arcLength(c, t0, mid, relTol).value < length) lo = mid; else hi = mid;
  }
  return {0.5 * (lo + hi), hi - lo, Status::ok};
}

} // namespace cadgeom
