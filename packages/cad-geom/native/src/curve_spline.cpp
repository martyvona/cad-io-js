// B-spline curves (rational or not, clamped or not) and polylines, 2D and 3D.
// B-splines: evaluation to second order through numerics.h's bspline::eval on poles relative to their centroid (the
// centroid added to the point alone, curve.h's precision rule); higher orders by de Boor's algorithm on the
// hodographs. Bounds from the hodographs (Piegl and Tiller, "The NURBS Book", 2nd ed., eq. 3.8 and section 3.3: the
// derivative of a B-spline is a B-spline of one degree less, its poles scaled pole differences), precomputed in
// homogeneous coordinates (w (P - c), w) for every order needed. A range's piece of a span is a Bezier curve whose
// control points are the span's blossom at (a, ..., a, b, ..., b) (Ramshaw's blossoming; de Boor's algorithm with a
// different argument at each level, Seidel's formulation), so a piece's box is its control points' hull (the convex
// hull property, positive weights) and its derivative's bound the largest control point of the hodograph's piece.
// Rational curves bound their derivatives through the quotient rule's recursion C^(k) = (A^(k) - sum_i (k i)
// w^(i) C^(k-i)) / w (Piegl and Tiller, eq. 4.8), each term by its own bound and w by its smallest control point.
// Each bound is widened by the rounding of the differences that made its hodograph (carried pole by pole) and of
// the blossom.
// Polylines: segment k over [k, k + 1] (the library's parameterization, docs/brep-reference.md).
#include <algorithm>
#include <cmath>

#include "cad_geom/numerics.h"
#include "curve_impl.h"

namespace cadgeom {
namespace curves {

namespace {

/** One derivative order of a B-spline in homogeneous coordinates: degree, knots, poles `width` wide. */
struct Hodograph {
  int degree;
  std::vector<double> knots;
  std::vector<double> poles;
  /** A bound on any pole's coordinate's error from the differences that made it. */
  double error = 0;
};

class BSplineCurve final : public CurveImpl {
public:
  BSplineCurve(BSpline local, Vec3 centroid) : c_(std::move(local)), o_(centroid) {
    p_ = c_.degree;
    n_ = c_.poleCount();
    d_ = c_.dim;
    w_ = d_ + 1;
    // Order 0: (w (P - c), w); the local poles are relative to c already.
    Hodograph h{p_, c_.knots, {}, 0};
    int cw = d_ + (c_.rational ? 1 : 0);
    double mag = 0;
    for (int i = 0; i < n_; i++) {
      const double* P = c_.poles.data() + i * cw;
      double wt = c_.rational ? P[d_] : 1.0;
      for (int a = 0; a < d_; a++) h.poles.push_back(wt * P[a]), mag = maxNum(mag, std::fabs(wt * P[a]));
      h.poles.push_back(wt);
    }
    h.error = 2 * kEps * mag;
    hodo_.push_back(std::move(h));
    // Each order from the last: R'_i = q (R_{i+1} - R_i) / (V_{i+q+1} - V_{i+1}) over knots V[1 .. end - 1]; a zero
    // denominator (a knot of multiplicity q + 1) leaves the pole without influence, so 0.
    for (int k = 1; k <= std::min(p_, kMaxOrder); k++) {
      const Hodograph& f = hodo_.back();
      int q = f.degree, m = static_cast<int>(f.poles.size()) / w_;
      Hodograph g{q - 1, std::vector<double>(f.knots.begin() + 1, f.knots.end() - 1), {}, 0};
      double err = 0;
      for (int i = 0; i + 1 < m; i++) {
        double den = f.knots[i + q + 1] - f.knots[i + 1];
        for (int a = 0; a < w_; a++) {
          double v = den > 0 ? q * (f.poles[(i + 1) * w_ + a] - f.poles[i * w_ + a]) / den : 0.0;
          g.poles.push_back(v);
          if (den > 0) err = maxNum(err, q * 2 * f.error / den + 4 * kEps * std::fabs(v));
        }
      }
      g.error = err;
      hodo_.push_back(std::move(g));
    }
  }
  int dim() const override { return d_; }
  CurveDomain domain() const override { return {{c_.knots[p_], c_.knots[n_]}, 0}; }
  Status derivs(double t, int order, Vec3* out) const override {
    Status s = Status::ok;
    Range r = domain().range;
    if (t < r.lo || t > r.hi) s = Status::outOfDomain, t = std::clamp(t, r.lo, r.hi);
    if (order <= 2) {
      double v[9] = {};
      Status e = bspline::eval(c_, t, order, v);
      if (e != Status::ok && e != Status::outOfDomain) return e;
      for (int k = 0; k <= order; k++) out[k] = readVec(v + k * d_, d_);
      out[0] = out[0] + o_;
      return s;
    }
    // Homogeneous derivatives from the hodographs, then the quotient rule.
    int span = bspline::findSpan(p_, c_.knots, n_, t);
    Vec3 A[kMaxOrder + 1];
    double W[kMaxOrder + 1];
    for (int k = 0; k <= order; k++) {
      if (k > p_) {
        A[k] = {}, W[k] = 0;
        continue;
      }
      double h[4];
      blossom(hodo_[k], span - k, [&](int) { return t; }, h);
      A[k] = readVec(h, d_), W[k] = h[d_];
    }
    for (int k = 0; k <= order; k++) {
      Vec3 v = A[k];
      for (int i = 1; i <= k; i++) v = v - (binom(k, i) * W[i]) * out[k - i];
      out[k] = (1 / W[0]) * v;
    }
    out[0] = out[0] + o_;
    return s;
  }
  void breaks(Range r, std::vector<double>& out) const override {
    out = {r.lo};
    for (double k : c_.knots)
      if (k > r.lo && k < r.hi && k != out.back()) out.push_back(k);
    out.push_back(r.hi);
  }
  Status derivBox(Range r, int order, Box3& out) const override {
    if (!clip(r)) return Status::outOfDomain;
    if (c_.rational && order > 0) {
      double b;
      Status s = derivBoundN(r, order, b);
      if (s != Status::ok) return s;
      Box3 cb;
      out = ballBox({}, b);
      if (centredBox(*this, r, order, cb) == Status::ok) out = meet(out, cb);
      return Status::ok;
    }
    out = emptyBox();
    if (order > p_) {
      out = pointBox({});
      return Status::ok;
    }
    forPieces(r, order, [&](const std::vector<double>& ctrl, double err) {
      int q = static_cast<int>(ctrl.size()) / w_;
      double mag = 0;
      Box3 b = emptyBox();
      for (int j = 0; j < q; j++) {
        const double* h = ctrl.data() + j * w_;
        Vec3 v = readVec(h, d_);
        if (order == 0 && c_.rational) v = (1 / h[d_]) * v;
        b = hull(b, v);
        mag = maxNum(mag, maxAbs(v));
      }
      // The projection's rounding (rational points) and the blossom's, on top of the hodograph's own.
      double wmin = order == 0 && c_.rational ? minWeight(ctrl) : 1;
      out = hull(out, widen(b, (err + 8 * (q + 2) * kEps * mag) / wmin));
    });
    if (order == 0) {
      out = {{out.x.lo + o_.x, out.x.hi + o_.x}, {out.y.lo + o_.y, out.y.hi + o_.y},
        {out.z.lo + o_.z, out.z.hi + o_.z}};
      out = widen(out, 4 * kEps * maxAbs(o_));
    }
    return Status::ok;
  }
  Status derivBoundN(Range r, int order, double& out) const override {
    out = 0;
    if (!clip(r)) {
      out = kInf;
      return Status::outOfDomain;
    }
    if (!c_.rational) {
      if (order > p_) return Status::ok;
      forPieces(r, order, [&](const std::vector<double>& ctrl, double err) {
        int q = static_cast<int>(ctrl.size()) / w_;
        double m = 0, mag = 0;
        for (int j = 0; j < q; j++) {
          Vec3 v = readVec(ctrl.data() + j * w_, d_);
          m = maxNum(m, norm(v)), mag = maxNum(mag, maxAbs(v));
        }
        out = maxNum(out, (m + std::sqrt(3.0) * (err + 8 * (q + 2) * kEps * mag)) * (1 + 4 * kEps));
      });
      return Status::ok;
    }
    // Per piece: the bounds of A^(k), w^(k), the smallest w and |C - c|, then the quotient rule's recursion.
    double Bk = 0;
    Status s = Status::ok;
    std::vector<double> piece[kMaxOrder + 1];
    forSpans(r, [&](int span, double a, double b) {
      double Am[kMaxOrder + 1] = {}, Wm[kMaxOrder + 1] = {}, wmin = kInf, B[kMaxOrder + 1] = {};
      for (int k = 0; k <= std::min(order, p_); k++) {
        bezier(hodo_[k], span - k, a, b, piece[k]);
        int q = static_cast<int>(piece[k].size()) / w_;
        double err = hodo_[k].error + 8 * (q + 2) * kEps * absMax(piece[k]);
        for (int j = 0; j < q; j++) {
          const double* h = piece[k].data() + j * w_;
          Am[k] = maxNum(Am[k], norm(readVec(h, d_)) + std::sqrt(3.0) * err);
          Wm[k] = maxNum(Wm[k], std::fabs(h[d_]) + err);
          if (k == 0) {
            wmin = minNum(wmin, h[d_] - err);
            B[0] = maxNum(B[0], norm(readVec(h, d_)) / h[d_]);
          }
        }
      }
      if (!(wmin > 0)) {
        s = Status::singular;
        Bk = kInf;
        return;
      }
      B[0] = B[0] * (1 + 16 * kEps) + std::sqrt(3.0) * hodo_[0].error / wmin;
      for (int k = 1; k <= order; k++) {
        double v = Am[k];
        for (int i = 1; i <= k; i++) v += binom(k, i) * Wm[i] * B[k - i];
        B[k] = v / wmin * (1 + 16 * kEps);
      }
      Bk = maxNum(Bk, B[order]);
    });
    out = Bk;
    return s;
  }
  void singular(Range r, std::vector<double>& out) const override {
    out.clear();
    if (!clip(r)) return;
    std::vector<double> br, z;
    breaks(r, br);
    for (size_t i = 0; i + 1 < br.size(); i++) {
      speedZeros(*this, {br[i], br[i + 1]}, z);
      for (double t : z)
        if (out.empty() || t > out.back()) out.push_back(t);
    }
  }

private:
  /** r clipped to the domain; false if it misses it. */
  bool clip(Range& r) const {
    Range d = domain().range;
    r = {maxNum(r.lo, d.lo), minNum(r.hi, d.hi)};
    return r.lo <= r.hi;
  }
  /** Each nonempty span meeting r, with r's part of it [a, b]. */
  template <class F> void forSpans(Range r, F f) const {
    const std::vector<double>& U = c_.knots;
    for (int i = bspline::findSpan(p_, U, n_, r.lo); i < n_; i++) {
      if (U[i] == U[i + 1]) continue;
      double a = maxNum(r.lo, U[i]), b = minNum(r.hi, U[i + 1]);
      if (a > b) break;
      f(i, a, b);
      if (U[i + 1] >= r.hi) break;
    }
  }
  /** Each piece over r of hodograph `order`: its Bezier control points and its poles' error bound. */
  template <class F> void forPieces(Range r, int order, F f) const {
    std::vector<double> ctrl;
    forSpans(r, [&](int span, double a, double b) {
      bezier(hodo_[order], span - order, a, b, ctrl);
      f(ctrl, hodo_[order].error);
    });
  }
  /** The piece over [a, b] of span s (in h's own knots) as Bezier control points: the blossoms at (a^(q-j), b^j). */
  void bezier(const Hodograph& h, int s, double a, double b, std::vector<double>& out) const {
    int q = h.degree;
    out.assign((q + 1) * w_, 0);
    for (int j = 0; j <= q; j++) blossom(h, s, [&](int level) { return level <= q - j ? a : b; }, out.data() + j * w_);
  }
  /** De Boor's algorithm on span s of h with argument arg(level) at each level 1..q: the blossom, into out. */
  template <class A> void blossom(const Hodograph& h, int s, A arg, double* out) const {
    int q = h.degree;
    double d[(kMaxOrder + 8) * 4];
    std::vector<double> big;
    double* D = d;
    if (q + 1 > kMaxOrder + 8) big.resize((q + 1) * w_), D = big.data();
    for (int j = 0; j <= q; j++)
      for (int a = 0; a < w_; a++) D[j * w_ + a] = h.poles[(s - q + j) * w_ + a];
    const std::vector<double>& V = h.knots;
    for (int r = 1; r <= q; r++) {
      double t = arg(r);
      for (int j = q; j >= r; j--) {
        int i = s - q + j;  // the pole's index
        double al = (t - V[i]) / (V[i + q + 1 - r] - V[i]);
        for (int a = 0; a < w_; a++) D[j * w_ + a] = (1 - al) * D[(j - 1) * w_ + a] + al * D[j * w_ + a];
      }
    }
    for (int a = 0; a < w_; a++) out[a] = D[q * w_ + a];
  }
  double minWeight(const std::vector<double>& ctrl) const {
    double m = kInf;
    for (size_t j = d_; j < ctrl.size(); j += w_) m = minNum(m, ctrl[j]);
    return m;
  }
  static double absMax(const std::vector<double>& v) {
    double m = 0;
    for (double x : v) m = maxNum(m, std::fabs(x));
    return m;
  }

  BSpline c_;  // poles relative to o_
  Vec3 o_;
  int p_, n_, d_, w_;
  std::vector<Hodograph> hodo_;
};

class Polyline final : public CurveImpl {
public:
  Polyline(const double* r, int n, int dim) : dim_(dim) {
    for (int i = 0; i < n; i++) pts_.push_back(readVec(r + i * dim, dim));
  }
  int dim() const override { return dim_; }
  CurveDomain domain() const override { return {{0, last()}, 0}; }
  Status derivs(double t, int order, Vec3* out) const override {
    Status s = (t < 0 || t > last()) ? Status::outOfDomain : Status::ok;
    t = std::clamp(t, 0.0, last());
    int k = segment(t);
    Vec3 d = pts_[k + 1] - pts_[k];
    out[0] = pts_[k] + (t - k) * d;
    for (int j = 1; j <= order; j++) out[j] = j == 1 ? d : Vec3{};
    return s;
  }
  void breaks(Range r, std::vector<double>& out) const override {
    out = {r.lo};
    for (double k = std::floor(r.lo) + 1; k < r.hi; k++) out.push_back(k);
    out.push_back(r.hi);
  }
  Status derivBox(Range r, int order, Box3& out) const override {
    Status s = clip(r);
    if (order >= 2) {
      out = pointBox({});
      return s;
    }
    out = emptyBox();
    double mag = 0;
    if (order == 0) {
      Vec3 v[2];
      for (double t : {r.lo, r.hi}) derivs(t, 0, v), out = hull(out, v[0]), mag = maxNum(mag, maxAbs(v[0]));
      for (double k = std::floor(r.lo) + 1; k < r.hi; k++) out = hull(out, pts_[static_cast<int>(k)]);
    } else {
      for (int k = segment(r.lo); k <= lastSegment(r); k++) {
        Vec3 d = pts_[k + 1] - pts_[k];
        out = hull(out, d), mag = maxNum(mag, maxAbs(d));
      }
    }
    out = widen(out, 4 * kEps * mag);
    return s;
  }
  Status derivBoundN(Range r, int order, double& out) const override {
    Status s = clip(r);
    out = 0;
    if (order != 1) return s;
    for (int k = segment(r.lo); k <= lastSegment(r); k++) out = maxNum(out, norm(pts_[k + 1] - pts_[k]));
    out *= 1 + 4 * kEps;
    return s;
  }
  void singular(Range r, std::vector<double>& out) const override {
    out.clear();
    if (clip(r) != Status::ok && r.lo > r.hi) return;
    for (int k = segment(r.lo); k <= lastSegment(r); k++)
      if (norm(pts_[k + 1] - pts_[k]) == 0) out.push_back(maxNum(r.lo, double(k)));
  }
  bool exactLength(double t0, double t1, double& out) const override {
    // Whole segments' lengths, and the fractions of the first and last.
    out = 0;
    for (int k = segment(t0); k <= lastSegment({t0, t1}); k++) {
      double a = maxNum(t0, double(k)), b = minNum(t1, double(k + 1));
      if (b > a) out += (b - a) * norm(pts_[k + 1] - pts_[k]);
    }
    return true;
  }

private:
  double last() const { return static_cast<double>(pts_.size() - 1); }
  int segment(double t) const {
    return std::clamp(static_cast<int>(std::floor(t)), 0, static_cast<int>(pts_.size()) - 2);
  }
  /** The last segment r reaches (r.hi on a vertex reaches the segment before it). */
  int lastSegment(Range r) const {
    int k = segment(r.hi);
    return k > segment(r.lo) && k == r.hi ? k - 1 : k;
  }
  Status clip(Range& r) const {
    Range c{maxNum(r.lo, 0.0), minNum(r.hi, last())};
    Status s = c.lo == r.lo && c.hi == r.hi ? Status::ok : Status::outOfDomain;
    r = c.lo <= c.hi ? c : Range{c.lo, c.lo};
    return s;
  }

  int dim_;
  std::vector<Vec3> pts_;
};

} // namespace

std::unique_ptr<CurveImpl> makeBSpline(const double* r, const int32_t* in, int dim, Status& status) {
  BSpline c;
  c.degree = in[0];
  int n = in[1], k = in[2];
  c.rational = in[3] != 0;
  c.dim = dim;
  status = Status::invalidModel;
  if (c.degree < 1 || n < c.degree + 1 || k < 2) return nullptr;
  for (int i = 0; i < k; i++)
    if (in[7 + i] < 1 || (i > 0 && !(r[i] > r[i - 1]))) return nullptr;
  c.knots = bspline::fullKnots(r, in + 7, k);
  if (static_cast<int>(c.knots.size()) != n + c.degree + 1) return nullptr;
  const double* poles = r + k;
  const double* weights = poles + n * dim;
  // The centroid of the poles: the local origin (curve.h's precision rule).
  Vec3 o{};
  for (int i = 0; i < n; i++) o = o + readVec(poles + i * dim, dim);
  o = (1.0 / n) * o;
  for (int i = 0; i < n; i++) {
    if (c.rational && !(weights[i] > 0)) return nullptr;
    Vec3 q = readVec(poles + i * dim, dim) - o;
    double v[3] = {q.x, q.y, q.z};
    for (int a = 0; a < dim; a++) c.poles.push_back(v[a]);
    if (c.rational) c.poles.push_back(weights[i]);
  }
  status = Status::ok;
  return std::make_unique<BSplineCurve>(std::move(c), o);
}

std::unique_ptr<CurveImpl> makePolyline(const double* r, int n, int dim) {
  return std::make_unique<Polyline>(r, n, dim);
}

} // namespace curves
} // namespace cadgeom
