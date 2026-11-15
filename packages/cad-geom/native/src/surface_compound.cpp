// Surfaces built on other rows: extrusions and revolutions of a curve (curve_impl.h's CurveImpl, its derivatives and
// boxes to any order), offsets and rectangular trims of a surface.
// Extrusion: S(u, v) = C(u) + v m D, so S^(k,0) = C^(k)(u), S^(0,1) = m D, the rest 0.
// Revolution: S(u, v) = A + R(u) (C(v) - A), R(u) q = (a.q) a + cos u (q - (a.q) a) + sin u (a x q) (Rodrigues), so
// S^(k,l) = R^(k)(u) Q^(l)(v) with Q = C - A: the u-derivatives fall on cos and sin alone. Its singular iso-lines are
// where the profile meets the axis, found by bisection on the box of the profile's part across the axis.
// Offset: S = B + d N / |N|, N = B_u x B_v, exact (not by differences): S's partials to order n from B's to order
// n + 1 through truncated bivariate Taylor series (jets: products by convolution, |N|^-1 by its power series about
// the value), in doubles for evaluation and in intervals over a rectangle for boxes (each coefficient a box holding
// its value over the rectangle, so the expression's interval evaluation holds the partial's every value there). Where
// the basis's normal vanishes the offset is undefined: its point is the basis's, with Status::singular.
// Rectangular trim: the basis restricted to [u1, u2] x [v1, v2] in its own parameters (sorted, as cad-brep's
// geometry.ts), periodic only where the trim spans a whole period.
#include <algorithm>
#include <cmath>

#include "curve_impl.h"
#include "surface_impl.h"

namespace cadgeom {
namespace surfaces {

namespace {

using curves::CurveImpl;

double factorial(int n) {
  double f = 1;
  for (int i = 2; i <= n; i++) f *= i;
  return f;
}

/** A box's shift by a fixed point (with its rounding). */
Box3 shiftBox(const Box3& b, Vec3 o) { return widen(b + pointBox(o), 4 * kEps * maxAbs(o)); }

class Extrusion final : public SurfaceImpl {
public:
  Extrusion(std::unique_ptr<CurveImpl> c, Vec3 dir) : c_(std::move(c)), D_(dir) {}
  SurfaceDomain domain() const override {
    CurveDomain d = c_->domain();
    return {d.range, {-kInf, kInf}, d.period, 0};
  }
  Status derivs(double u, double v, int order, Vec3* out) const override {
    Vec3 C[curves::kMaxOrder + 1];
    Status s = c_->derivs(u, std::min(order, curves::kMaxOrder), C);
    for (int i = 0; i < pidx(0, order) + 1; i++) out[i] = {};
    for (int k = 0; k <= order && k <= curves::kMaxOrder; k++) out[pidx(k, 0)] = C[k];
    out[0] = C[0] + v * D_;
    if (order >= 1) out[pidx(0, 1)] = D_;
    return s;
  }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    c_->breaks(ru, us);
    vs = {rv.lo, rv.hi};
  }
  Status derivBox(Range ru, Range rv, int k, int l, Box3& out) const override {
    if (l >= 2 || (l == 1 && k >= 1)) return out = pointBox({}), Status::ok;
    if (l == 1) return out = pointBox(D_), Status::ok;
    Status s = c_->derivBox(ru, k, out);
    if (s != Status::ok) return s;
    if (k == 0) {
      if (!finite(rv)) return out = entireBox(), Status::outOfDomain;
      out = widen(out + scaled({rv.lo, rv.hi}, D_), 4 * kEps * std::fmax(std::fabs(rv.lo), std::fabs(rv.hi))
        * maxAbs(D_));
    }
    return Status::ok;
  }
  void singularities(std::vector<Singularity>& out) const override { out.clear(); }
  void within(Vec3 p, double d, Range& ru, Range& rv) const override {
    // u: where the curve's range is infinite, a curve in a plane across D (its tangents across D at the samples
    // taken: conics and lines are planar) has |S - p| >= |C(u) - q| for q the point on p's line along D in that
    // plane, so the curve's own cut about q holds u; else no cut. v: (S - p) . D/|D| = (C(u) - p) . D/|D| + v |D|,
    // so v is within d of -(C(u) - p) . D / |D|^2 over u's range.
    CurveDomain cd = c_->domain();
    ru = cd.range, rv = {-kInf, kInf};
    double L = norm(D_);
    Vec3 Dh = (1 / L) * D_;
    if (!finite(ru)) {
      Vec3 c[2];
      bool across = true;
      for (double t : {0.0, 1.0, -1.0, 3.0, -3.0}) {
        c_->derivs(t, 1, c);
        across = across && std::fabs(dot(c[1], Dh)) <= 1e-12 * norm(c[1]);
      }
      if (!across) return;
      c_->derivs(0, 0, c);
      Vec3 q = p - dot(p - c[0], Dh) * Dh;
      ru = c_->within(q, d * (1 + 1e-12) + 8 * kEps * (maxAbs(p) + maxAbs(c[0])));
      if (!finite(ru)) return;
    }
    Box3 b;
    if (c_->derivBox(ru, 0, b) != Status::ok) return;
    Interval proj = dotBox(b - pointBox(p), pointBox(Dh));
    double e = d * (1 + 1e-12) + 8 * kEps * (boxMag(b) + maxAbs(p));
    rv = {(-proj.hi - e) / L, (-proj.lo + e) / L};
  }

private:
  std::unique_ptr<CurveImpl> c_;
  Vec3 D_;  // the direction times the magnitude
};

class Revolution final : public SurfaceImpl {
public:
  Revolution(std::unique_ptr<CurveImpl> c, Vec3 A, Vec3 a) : c_(std::move(c)), A_(A), a_(a) {}
  SurfaceDomain domain() const override {
    CurveDomain d = c_->domain();
    return {{0, kTwoPi}, d.range, kTwoPi, d.period};
  }
  Status derivs(double u, double v, int order, Vec3* out) const override {
    Vec3 Q[curves::kMaxOrder + 1];
    Status s = c_->derivs(v, std::min(order, curves::kMaxOrder), Q);
    Q[0] = Q[0] - A_;
    double cu = std::cos(u), su = std::sin(u);
    double C[4] = {cu, -su, -cu, su}, S[4] = {su, cu, -su, -cu};
    for (int t = 0; t <= order; t++)
      for (int l = 0; l <= t; l++) {
        int k = t - l;
        if (l > curves::kMaxOrder) {
          out[pidx(k, l)] = {};
          continue;
        }
        Vec3 q = Q[l], ax = dot(a_, q) * a_;
        out[pidx(k, l)] = (k == 0 ? ax : Vec3{}) + C[k % 4] * (q - ax) + S[k % 4] * cross(a_, q);
      }
    out[0] = out[0] + A_;
    return s;
  }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    us = {ru.lo, ru.hi};
    c_->breaks(rv, vs);
  }
  Status derivBox(Range ru, Range rv, int k, int l, Box3& out) const override {
    if (l > curves::kMaxOrder - 1) return out = entireBox(), Status::unsupported;
    Box3 Q;
    Status s = c_->derivBox(rv, l, Q);
    if (s != Status::ok) return out = entireBox(), s;
    if (l == 0) Q = widen(Q - pointBox(A_), 4 * kEps * maxAbs(A_));
    Box3 a = pointBox(a_);
    Interval aq = dotBox(a, Q);
    Box3 ax = aq * a, perp = Q - ax, side = crossBox(a, Q);
    double A0 = 1, B0 = 0, A1 = 0, B1 = 1;
    turn(A0, B0, k), turn(A1, B1, k);
    Interval cI = sinusoid(A0, B0, ru), sI = sinusoid(A1, B1, ru);
    Box3 b = cI * perp + sI * side;
    if (k == 0) b = b + ax;
    out = k == 0 && l == 0 ? shiftBox(b, A_) : b;
    return Status::ok;
  }
  void singularities(std::vector<Singularity>& out) const override {
    out.clear();
    CurveDomain cd = c_->domain();
    if (!finite(cd.range)) return;
    // Where the profile's part across the axis, Q - (a.Q) a, vanishes: bisection on its box.
    Range r = cd.range;
    double wmin = 1e-12 * (r.hi - r.lo);
    std::vector<Range> stack{r}, leaves;
    int budget = 20000;
    while (!stack.empty() && budget-- > 0) {
      Range g = stack.back();
      stack.pop_back();
      Box3 Q;
      if (c_->derivBox(g, 0, Q) != Status::ok) continue;
      Q = Q - pointBox(A_);
      Box3 a = pointBox(a_), perp = Q - dotBox(a, Q) * a;
      if (boxMinNorm(perp) > 0) continue;
      if (g.hi - g.lo <= wmin) {
        leaves.push_back(g);
        continue;
      }
      double m = 0.5 * g.lo + 0.5 * g.hi;
      stack.push_back({m, g.hi}), stack.push_back({g.lo, m});
    }
    std::sort(leaves.begin(), leaves.end(), [](Range x, Range y) { return x.lo < y.lo; });
    for (size_t i = 0; i < leaves.size();) {
      size_t j = i;
      while (j + 1 < leaves.size() && leaves[j + 1].lo <= leaves[j].hi) j++;
      double v = 0.5 * leaves[i].lo + 0.5 * leaves[j].hi;
      if (leaves[i].lo <= r.lo) v = r.lo;
      if (leaves[j].hi >= r.hi) v = r.hi;
      Vec3 q[1];
      c_->derivs(v, 0, q);
      out.push_back({Singularity::pole, false, v, A_ + dot(a_, q[0] - A_) * a_});
      i = j + 1;
    }
  }
  void within(Vec3 p, double d, Range& ru, Range& rv) const override {
    // |S - A| = |C(v) - A|, so a point within d of p has |C(v) - A| <= |p - A| + d; a bounded profile keeps its
    // domain (nothing to gain, and a curve's cut on a trim of a periodic basis may not hold a range across 0).
    ru = {0, kTwoPi};
    CurveDomain cd = c_->domain();
    rv = finite(cd.range) ? cd.range : c_->within(A_, norm(p - A_) + d);
  }

private:
  std::unique_ptr<CurveImpl> c_;
  Vec3 A_, a_;
};

// -- Jets: truncated bivariate Taylor series, coefficient (k, l) the partial S^(k,l) / (k! l!).

template <class T> T sc(double s, const T& x);
template <> double sc(double s, const double& x) { return s * x; }
template <> Interval sc(double s, const Interval& x) { return Interval::point(s) * x; }

template <class T> struct Jet {
  T c[kPartials];
};
template <class T> Jet<T> zero(int n) {
  Jet<T> j;
  for (int i = 0; i <= pidx(0, n); i++) j.c[i] = T{};
  return j;
}
template <class T> Jet<T> mul(const Jet<T>& a, const Jet<T>& b, int n) {
  Jet<T> r = zero<T>(n);
  for (int t = 0; t <= n; t++)
    for (int l = 0; l <= t; l++) {
      int k = t - l;
      T s{};
      for (int i = 0; i <= k; i++)
        for (int j = 0; j <= l; j++) s = s + a.c[pidx(i, j)] * b.c[pidx(k - i, l - j)];
      r.c[pidx(k, l)] = s;
    }
  return r;
}
template <class T> Jet<T> plus(const Jet<T>& a, const Jet<T>& b, int n) {
  Jet<T> r;
  for (int i = 0; i <= pidx(0, n); i++) r.c[i] = a.c[i] + b.c[i];
  return r;
}
template <class T> Jet<T> minus(const Jet<T>& a, const Jet<T>& b, int n) {
  Jet<T> r;
  for (int i = 0; i <= pidx(0, n); i++) r.c[i] = a.c[i] - b.c[i];
  return r;
}
template <class T> struct VJet {
  Jet<T> x, y, z;
};
template <class T> Jet<T> dotJ(const VJet<T>& a, const VJet<T>& b, int n) {
  return plus(plus(mul(a.x, b.x, n), mul(a.y, b.y, n), n), mul(a.z, b.z, n), n);
}
template <class T> VJet<T> crossJ(const VJet<T>& a, const VJet<T>& b, int n) {
  return {minus(mul(a.y, b.z, n), mul(a.z, b.y, n), n), minus(mul(a.z, b.x, n), mul(a.x, b.z, n), n),
    minus(mul(a.x, b.y, n), mul(a.y, b.x, n), n)};
}

/** 1 in the jets' scalar type. */
inline double one(double) { return 1; }
inline Interval one(Interval) { return Interval::point(1); }

/** q^(-1/2) at q0 and its derivatives' coefficients: c_m q0^(-1/2 - m), c_m = prod_{i < m} (-1/2 - i). */
double rsqrtDeriv(double q0, int m) {
  double c = 1;
  for (int i = 0; i < m; i++) c *= -0.5 - i;
  return c / (std::sqrt(q0) * std::pow(q0, m));
}
Interval rsqrtDeriv(Interval q0, int m) {
  double c = 1;
  for (int i = 0; i < m; i++) c *= -0.5 - i;
  Interval d = sqrt(q0);
  for (int i = 0; i < m; i++) d = d * q0;
  return Interval::point(c) * (Interval::point(1) / d);
}
/** The jet of q^(-1/2): sum_m phi^(m)(q0) / m! (q - q0)^m, truncated at order n. */
template <class T> Jet<T> rsqrtJ(const Jet<T>& q, int n) {
  Jet<T> d = q, pw = zero<T>(n), r = zero<T>(n);
  d.c[0] = T{};
  pw.c[0] = T{} + sc(1.0, one(q.c[0]));
  double fact = 1;
  for (int m = 0; m <= n; m++) {
    if (m > 0) pw = mul(pw, d, n), fact *= m;
    T f = sc(1 / fact, rsqrtDeriv(q.c[0], m));
    for (int i = 0; i <= pidx(0, n); i++) r.c[i] = r.c[i] + f * pw.c[i];
  }
  return r;
}

class Offset final : public SurfaceImpl {
public:
  Offset(std::unique_ptr<SurfaceImpl> basis, double d) : b_(std::move(basis)), d_(d) {}
  SurfaceDomain domain() const override { return b_->domain(); }
  Status derivs(double u, double v, int order, Vec3* out) const override {
    if (order + 1 > kMaxOrder) return Status::unsupported;
    Vec3 B[kPartials];
    Status s = b_->derivs(u, v, order + 1, B);
    if (s != Status::ok && s != Status::outOfDomain) return s;
    Vec3 su = B[pidx(1, 0)], sv = B[pidx(0, 1)];
    double big = std::fmax(norm(su), norm(sv));
    if (!(big > 0) || norm(cross(su, sv)) <= 1e-14 * big * big) {
      // Where the basis's normal vanishes (its pole): the point moved along the normal's limit there, its partials
      // the basis's (the offset's own are undefined).
      Vec3 n;
      b_->normal(u, v, n);
      for (int i = 0; i <= pidx(0, order); i++) out[i] = B[i];
      out[0] = B[0] + d_ * n;
      return Status::singular;
    }
    auto coef = [&](int k, int l) { return (1 / (factorial(k) * factorial(l))) * B[pidx(k, l)]; };
    VJet<double> Bu{}, Bv{};
    for (int t = 0; t <= order; t++)
      for (int l = 0; l <= t; l++) {
        int k = t - l;
        Vec3 a = (k + 1.0) * coef(k + 1, l), b = (l + 1.0) * coef(k, l + 1);
        Bu.x.c[pidx(k, l)] = a.x, Bu.y.c[pidx(k, l)] = a.y, Bu.z.c[pidx(k, l)] = a.z;
        Bv.x.c[pidx(k, l)] = b.x, Bv.y.c[pidx(k, l)] = b.y, Bv.z.c[pidx(k, l)] = b.z;
      }
    VJet<double> N = crossJ(Bu, Bv, order);
    Jet<double> rho = rsqrtJ(dotJ(N, N, order), order);
    Jet<double> nx = mul(N.x, rho, order), ny = mul(N.y, rho, order), nz = mul(N.z, rho, order);
    for (int t = 0; t <= order; t++)
      for (int l = 0; l <= t; l++) {
        int k = t - l, i = pidx(k, l);
        double f = factorial(k) * factorial(l) * d_;
        out[i] = B[i] + Vec3{f * nx.c[i], f * ny.c[i], f * nz.c[i]};
      }
    return s;
  }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    b_->breaks(ru, rv, us, vs);
  }
  Status derivBox(Range ru, Range rv, int k, int l, Box3& out) const override {
    Status s = rawBox(ru, rv, k, l, out);
    if (s != Status::ok || !finite(ru) || !finite(rv) || k + l + 2 >= kMaxOrder) return s;
    // Met with the centred form on the next order's jet boxes, which shrinks with the rectangle where the jets'
    // interval dependency doesn't.
    Box3 bu, bv;
    if (rawBox(ru, rv, k + 1, l, bu) != Status::ok || rawBox(ru, rv, k, l + 1, bv) != Status::ok) return s;
    double mu = 0.5 * ru.lo + 0.5 * ru.hi, mv = 0.5 * rv.lo + 0.5 * rv.hi;
    Vec3 d[kPartials];
    if (derivs(mu, mv, k + l, d) != Status::ok) return s;
    Vec3 c = d[pidx(k, l)];
    double r = (boxNorm(bu) * (ru.hi - ru.lo) + boxNorm(bv) * (rv.hi - rv.lo)) * 0.5 * (1 + 8 * kEps);
    double err = (k + l == 0 ? 8 * kEps * maxAbs(c) : 1e-12 * maxAbs(c)) + 1e-13 * r;
    out = meet(out, ballBox(c, r + err));
    return s;
  }
  /** A box of S^(k,l) from the interval jets alone (and for the point, the basis's box and a ball of |d|). */
  Status rawBox(Range ru, Range rv, int k, int l, Box3& out) const {
    Box3 ball;
    if (k + l == 0) {
      // The basis's box and a ball of |d| (a unit normal's length): always, met below with the jets' where they go.
      Status s = b_->derivBox(ru, rv, 0, 0, ball);
      if (s != Status::ok) return out = ball, s;
      ball = widen(ball, std::fabs(d_) * (1 + 4 * kEps));
    }
    int n = k + l;
    if (n + 1 >= kMaxOrder) return out = entireBox(), Status::unsupported;
    // Interval jets of B's partials to order n + 1 over the rectangle.
    Box3 B[kPartials];
    for (int t = n == 0 ? 0 : 1; t <= n + 1; t++)
      for (int m = 0; m <= t; m++) {
        Status s = b_->derivBox(ru, rv, t - m, m, B[pidx(t - m, m)]);
        if (s != Status::ok) return out = n == 0 ? ball : entireBox(), n == 0 ? Status::ok : s;
      }
    VJet<Interval> Bu{}, Bv{};
    for (int t = 0; t <= n; t++)
      for (int m = 0; m <= t; m++) {
        int a = t - m;
        double fu = (a + 1.0) / (factorial(a + 1) * factorial(m)), fv = (m + 1.0) / (factorial(a) * factorial(m + 1));
        Box3 x = Interval::point(fu) * B[pidx(a + 1, m)], y = Interval::point(fv) * B[pidx(a, m + 1)];
        Bu.x.c[pidx(a, m)] = x.x, Bu.y.c[pidx(a, m)] = x.y, Bu.z.c[pidx(a, m)] = x.z;
        Bv.x.c[pidx(a, m)] = y.x, Bv.y.c[pidx(a, m)] = y.y, Bv.z.c[pidx(a, m)] = y.z;
      }
    VJet<Interval> N = crossJ(Bu, Bv, n);
    Jet<Interval> q = dotJ(N, N, n);
    if (!(q.c[0].lo > 0)) {
      if (n > 0) return out = entireBox(), Status::singular;
      out = ball;
      Box3 near;
      if (poleBox(ru, rv, B, near)) out = meet(out, near);
      return Status::ok;
    }
    Jet<Interval> rho = rsqrtJ(q, n);
    int i = pidx(k, l);
    Interval f = Interval::point(factorial(k) * factorial(l) * d_);
    Box3 nb{f * mul(N.x, rho, n).c[i], f * mul(N.y, rho, n).c[i], f * mul(N.z, rho, n).c[i]};
    out = B[i] + nb;
    if (n == 0) out = meet(out, ball);
    return Status::ok;
  }
  void singularities(std::vector<Singularity>& out) const override {
    // The basis's collapsed iso-lines stay collapsed, moved along the normal's limit there.
    b_->singularities(out);
    SurfaceDomain dom = b_->domain();
    for (Singularity& g : out) {
      if (g.kind == Singularity::normalVanishes) continue;
      double other = g.isoU ? (finite(dom.v) ? 0.5 * dom.v.lo + 0.5 * dom.v.hi : 0)
        : (finite(dom.u) ? 0.5 * dom.u.lo + 0.5 * dom.u.hi : 0);
      Vec3 n;
      b_->normal(g.isoU ? g.at : other, g.isoU ? other : g.at, n);
      g.point = g.point + d_ * n;
    }
  }
  void within(Vec3 p, double d, Range& ru, Range& rv) const override { b_->within(p, d + std::fabs(d_), ru, rv); }

private:
  /**
   * The point's box over a rectangle touching one of the basis's collapsed iso-lines (B[] its partials' boxes to
   * order 1, and order 2 asked of the basis here), where N vanishes and the jets can't divide by it: along v = v0
   * where S_u = 0, S_u(u, v) = (v - v0) times the mean of S_uv between, so N = (v - v0) (M x S_v) with M in the box
   * of S_uv, and the unit normal is +/- M x S_v normalized, bounded by the box of that over its norm's range (a line
   * u = u0 likewise with S_u x M). False where no such line meets the rectangle or the reduced normal may vanish too.
   */
  bool poleBox(Range ru, Range rv, const Box3* B, Box3& out) const {
    std::vector<Singularity> sing;
    b_->singularities(sing);
    for (const Singularity& g : sing) {
      if (g.kind == Singularity::normalVanishes) continue;
      Range r = g.isoU ? ru : rv;
      if (g.at < r.lo || g.at > r.hi) continue;
      Box3 m;
      if (b_->derivBox(ru, rv, 1, 1, m) != Status::ok) return false;
      Box3 red = g.isoU ? crossBox(B[pidx(1, 0)], m) : crossBox(m, B[pidx(0, 1)]);
      double lo = boxMinNorm(red), hi = boxNorm(red);
      if (!(lo > 0)) return false;
      Interval inv{1 / hi * (1 - 4 * kEps), 1 / lo * (1 + 4 * kEps)};
      Box3 n = inv * red;
      // The sign of (v - v0): one side of the line, or both where the rectangle straddles it.
      bool below = r.lo < g.at, above = r.hi > g.at;
      Box3 neg = Interval::point(-1) * n;
      Box3 dir = below && above ? hull(n, neg) : (g.isoU ? (below ? neg : n) : (below ? neg : n));
      out = B[0] + Interval::point(d_) * dir;
      out = widen(out, 8 * kEps * (boxMag(out) + std::fabs(d_)));
      return true;
    }
    return false;
  }

  std::unique_ptr<SurfaceImpl> b_;
  double d_;
};

class Trimmed final : public SurfaceImpl {
public:
  Trimmed(std::unique_ptr<SurfaceImpl> basis, Range u, Range v) : b_(std::move(basis)), u_(u), v_(v) {
    SurfaceDomain d = b_->domain();
    uP_ = d.uPeriod > 0 && u.hi - u.lo >= d.uPeriod * (1 - 8 * kEps) ? d.uPeriod : 0;
    vP_ = d.vPeriod > 0 && v.hi - v.lo >= d.vPeriod * (1 - 8 * kEps) ? d.vPeriod : 0;
  }
  SurfaceDomain domain() const override { return {u_, v_, uP_, vP_}; }
  Status derivs(double u, double v, int order, Vec3* out) const override {
    Status s = Status::ok;
    if (!uP_ && (u < u_.lo || u > u_.hi)) s = Status::outOfDomain, u = std::clamp(u, u_.lo, u_.hi);
    if (!vP_ && (v < v_.lo || v > v_.hi)) s = Status::outOfDomain, v = std::clamp(v, v_.lo, v_.hi);
    Status e = b_->derivs(u, v, order, out);
    return e == Status::ok ? s : e;
  }
  Status normal(double u, double v, Vec3& out) const override { return b_->normal(u, v, out); }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    b_->breaks(ru, rv, us, vs);
  }
  Status derivBox(Range ru, Range rv, int k, int l, Box3& out) const override {
    if (!uP_) ru = {std::fmax(ru.lo, u_.lo), std::fmin(ru.hi, u_.hi)};
    if (!vP_) rv = {std::fmax(rv.lo, v_.lo), std::fmin(rv.hi, v_.hi)};
    if (!(ru.lo <= ru.hi) || !(rv.lo <= rv.hi)) return out = entireBox(), Status::outOfDomain;
    return b_->derivBox(ru, rv, k, l, out);
  }
  void singularities(std::vector<Singularity>& out) const override {
    std::vector<Singularity> all;
    b_->singularities(all);
    out.clear();
    for (const Singularity& g : all) {
      Range r = g.isoU ? u_ : v_;
      if (g.kind == Singularity::normalVanishes || (g.at >= r.lo && g.at <= r.hi)) out.push_back(g);
    }
  }
  void within(Vec3 p, double d, Range& ru, Range& rv) const override {
    b_->within(p, d, ru, rv);
    ru = {std::fmax(ru.lo, u_.lo), std::fmin(ru.hi, u_.hi)};
    rv = {std::fmax(rv.lo, v_.lo), std::fmin(rv.hi, v_.hi)};
  }
  bool footCandidates(Vec3 p, Range ru, Range rv, double tol, std::vector<Vec2>& out) const override {
    return b_->footCandidates(p, ru, rv, tol, out);
  }
  char footFamily(Vec3 p) const override { return b_->footFamily(p); }

private:
  std::unique_ptr<SurfaceImpl> b_;
  Range u_, v_;
  double uP_ = 0, vP_ = 0;
};

} // namespace

std::unique_ptr<SurfaceImpl> makeExtrusion(const Model& m, int curve, const double* r, int depth, Status& status) {
  std::unique_ptr<CurveImpl> c = curves::make(m, curve, depth + 1, status);
  if (!c) return nullptr;
  if (c->dim() != 3) return status = Status::invalidModel, nullptr;
  status = Status::ok;
  return std::make_unique<Extrusion>(std::move(c), r[3] * read3(r));
}

std::unique_ptr<SurfaceImpl> makeRevolution(const Model& m, int curve, const double* r, int depth, Status& status) {
  std::unique_ptr<CurveImpl> c = curves::make(m, curve, depth + 1, status);
  if (!c) return nullptr;
  if (c->dim() != 3) return status = Status::invalidModel, nullptr;
  status = Status::ok;
  return std::make_unique<Revolution>(std::move(c), read3(r), read3(r + 3));
}

std::unique_ptr<SurfaceImpl> makeOffset(std::unique_ptr<SurfaceImpl> basis, double distance) {
  return std::make_unique<Offset>(std::move(basis), distance);
}

std::unique_ptr<SurfaceImpl> makeTrimmed(std::unique_ptr<SurfaceImpl> basis, const double* r, Status& status) {
  status = Status::invalidModel;
  if (!(r[0] != r[1]) || !(r[2] != r[3])) return nullptr;
  status = Status::ok;
  return std::make_unique<Trimmed>(std::move(basis), Range{std::fmin(r[0], r[1]), std::fmax(r[0], r[1])},
    Range{std::fmin(r[2], r[3]), std::fmax(r[2], r[3])});
}

} // namespace surfaces
} // namespace cadgeom
