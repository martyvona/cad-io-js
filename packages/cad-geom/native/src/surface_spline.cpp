// B-spline surfaces, rational or not (clamped, as the canonical model has them: docs/brep-reference.md, rule 6).
// Evaluation by Piegl and Tiller ("The NURBS Book", 2nd ed., A3.6 and eq. 4.20 extended to any order): the span's
// basis functions and their derivatives in u and v, homogeneous partials A^(k,l) and w^(k,l) of the active poles
// taken relative to their own centroid (the centroid added to the point alone: surface.h's precision rule, so a far
// surface's derivatives are as exact as a near one's), then the quotient rule
//   S^(k,l) = (A^(k,l) - sum_{(i,j) != (0,0)} (k i)(l j) w^(i,j) S^(k-i,l-j)) / w.
// Bounds from the hodograph nets (Piegl and Tiller, eq. 3.17: a partial of a B-spline surface is a B-spline surface
// of lower degree whose poles are scaled differences of the poles), in homogeneous coordinates (w (P - c), w), for
// every order needed: over a rectangle the surface (or a partial of a polynomial surface) lies in the hull of the
// active poles of the spans it meets (nonnegative basis functions summing to one, positive weights); a rational
// partial is bounded by the quotient rule's recursion, each term by its own bound and w by its smallest active
// weight, met with the same recursion in intervals. Those hulls don't shrink within a span, so each box is met with
// the centred form on the next order's hulls, which does, within one span (across a knot the partial may jump). Each bound is widened by the rounding of the differences that made its net (carried pole by
// pole). A row of poles all equal at a side of the domain is a pole of the surface (a collapsed iso-line).
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>

#include "cad_geom/numerics.h"
#include "scratch.h"
#include "surface_impl.h"

namespace cadgeom {
namespace surfaces {

namespace {

/**
 * One partial's hodograph net: degrees, knots, poles (nu x nv, u-major, 4 wide: w (P - c), w), each pole's rounding
 * (perr: a difference divides its two poles' by its own knot gap, so a tiny span's poles round far more than the rest)
 * and the largest (error).
 */
struct Net {
  int p, q, nu, nv;
  std::vector<double> U, V;
  std::vector<double> h;
  double error = 0;
  std::vector<double> perr;
  const double* at(int i, int j) const { return h.data() + (i * nv + j) * 4; }
};

class BSplineSurface final : public SurfaceImpl {
public:
  BSplineSurface(int p, int q, int nu, int nv, bool rational, std::vector<double> U, std::vector<double> V,
    std::vector<double> poles, std::vector<double> weights, Vec3 c)
    : p_(p), q_(q), nu_(nu), nv_(nv), rational_(rational), U_(std::move(U)), V_(std::move(V)),
      P_(std::move(poles)), W_(std::move(weights)), c_(c) {
    // The order-(0, 0) net, then each (k, l) from (k - 1, l) by differences in u, (0, l) from (0, l - 1) in v.
    Net n0{p_, q_, nu_, nv_, U_, V_, {}, 0};
    double mag = 0;
    for (int i = 0; i < nu_ * nv_; i++) {
      double w = W_[i], m = std::fabs(w);
      for (int a = 0; a < 3; a++) n0.h.push_back(w * P_[3 * i + a]), m = maxNum(m, std::fabs(w * P_[3 * i + a]));
      n0.h.push_back(w);
      n0.perr.push_back(2 * kEps * m), mag = maxNum(mag, m);
    }
    n0.error = 2 * kEps * mag;
    size_ = span();
    wRatio_ = *std::max_element(W_.begin(), W_.end()) / *std::min_element(W_.begin(), W_.end());
    nets_.assign(kPartials, Net{});
    has_.assign(kPartials, false);
    nets_[0] = std::move(n0);
    has_[0] = true;
    for (int n = 1; n < kMaxOrder; n++)
      for (int l = 0; l <= n; l++) {
        int k = n - l;
        if (k > p_ || l > q_) continue;
        nets_[pidx(k, l)] = k > 0 ? diffU(nets_[pidx(k - 1, l)]) : diffV(nets_[pidx(0, l - 1)]);
        has_[pidx(k, l)] = true;
      }
  }
  SurfaceDomain domain() const override { return {{U_[p_], U_[nu_]}, {V_[q_], V_[nv_]}, 0, 0}; }
  void c0Lines(Range ru, Range rv, std::vector<IsoLine>& out) const override {
    out.clear();
    // Interior knots repeated at least the degree's times.
    auto add = [&](const std::vector<double>& K, int degree, Range r, bool isoU) {
      for (size_t i = 0; i < K.size();) {
        size_t j = i;
        while (j < K.size() && K[j] == K[i]) j++;
        if (static_cast<int>(j - i) >= degree && K[i] > r.lo && K[i] < r.hi) out.push_back({isoU, K[i]});
        i = j;
      }
    };
    add(U_, p_, ru, true), add(V_, q_, rv, false);
  }
  Status derivs(double u, double v, int order, Vec3* out) const override {
    SurfaceDomain d = domain();
    Status st = Status::ok;
    if (u < d.u.lo || u > d.u.hi || v < d.v.lo || v > d.v.hi) st = Status::outOfDomain;
    u = std::clamp(u, d.u.lo, d.u.hi), v = std::clamp(v, d.v.lo, d.v.hi);
    int su = bspline::findSpan(p_, U_, nu_, u), sv = bspline::findSpan(q_, V_, nv_, v);
    int n = order;
    // On the stack to order 2 (evaluation) and a degree up to kStackDegree: no allocation in the hot path.
    // (Not zero-filled: basisDerivs writes every entry.)
    using B = Scratch<double, 3 * (kStackDegree + 1)>;
    B Nu((n + 1) * (p_ + 1), B::uninitialized), Nv((n + 1) * (q_ + 1), B::uninitialized);
    bspline::basisDerivs(su, u, p_, n, U_, Nu.data());
    bspline::basisDerivs(sv, v, q_, n, V_, Nv.data());
    // The active poles' centroid: the span's local origin.
    Vec3 o{};
    for (int i = 0; i <= p_; i++)
      for (int j = 0; j <= q_; j++) o = o + read3(P_.data() + 3 * ((su - p_ + i) * nv_ + (sv - q_ + j)));
    o = (1.0 / ((p_ + 1) * (q_ + 1))) * o;
    Vec3 A[kPartials];
    double W[kPartials];
    for (int t = 0; t <= n; t++)
      for (int l = 0; l <= t; l++) {
        int k = t - l;
        Vec3 a{};
        double w = 0;
        for (int i = 0; i <= p_; i++) {
          double bu = Nu[k * (p_ + 1) + i];
          if (bu == 0) continue;
          for (int j = 0; j <= q_; j++) {
            int idx = (su - p_ + i) * nv_ + (sv - q_ + j);
            double b = bu * Nv[l * (q_ + 1) + j] * W_[idx];
            a = a + b * (read3(P_.data() + 3 * idx) - o);
            w += b;
          }
        }
        A[pidx(k, l)] = a, W[pidx(k, l)] = w;
      }
    // A polynomial surface's weights are 1: their partials are 0 exactly (summed basis functions would round).
    if (!rational_) {
      W[0] = 1;
      for (int i = 1; i <= pidx(0, n); i++) W[i] = 0;
    }
    for (int t = 0; t <= n; t++)
      for (int l = 0; l <= t; l++) {
        int k = t - l;
        Vec3 s = A[pidx(k, l)];
        for (int i = 0; i <= k; i++)
          for (int j = 0; j <= l; j++)
            if (i || j) s = s - (binom(k, i) * binom(l, j) * W[pidx(i, j)]) * out[pidx(k - i, l - j)];
        out[pidx(k, l)] = (1 / W[0]) * s;
      }
    out[0] = out[0] + o + c_;
    return st;
  }
  /** A rectangle within one span: its partial's hull met with the centred form; false where a hull fails. */
  bool centred(Range ru, Range rv, int k, int l, Box3& out) const {
    Box3 bu, bv;
    if (rawBox(ru, rv, k, l, out) != Status::ok || rawBox(ru, rv, k + 1, l, bu) != Status::ok ||
      rawBox(ru, rv, k, l + 1, bv) != Status::ok)
      return false;
    double mu = 0.5 * ru.lo + 0.5 * ru.hi, mv = 0.5 * rv.lo + 0.5 * rv.hi;
    // The centre's partials kept for the last (surface, point, order): the rectangle's partials share it.
    struct Centre {
      uint64_t owner = 0;
      double u = NAN, v = NAN;
      int n = -1;
      Vec3 d[kPartials];
    };
    thread_local Centre C;
    if (C.owner != id_ || C.u != mu || C.v != mv || C.n != k + l) {
      C.owner = id_, C.u = mu, C.v = mv, C.n = k + l;
      derivs(mu, mv, k + l, C.d);
    }
    Vec3 c = C.d[pidx(k, l)];
    double r = (boxNorm(bu) * (ru.hi - ru.lo) + boxNorm(bv) * (rv.hi - rv.lo)) * 0.5 * (1 + 8 * kEps);
    double err = (k + l == 0 ? 8 * kEps * maxAbs(c - c_) + 4 * kEps * maxAbs(c_) : 1e-12 * maxAbs(c))
      + 1e-13 * r + (k + l == 0 ? 0 : 1e-13 * (boxNorm(out)));
    // derivs' own rounding of a partial, which relative to the partial alone misses where it's near 0 (a cylinder's
    // twist): its sums of basis derivatives over the span du x dv are at most (2p / du)^k (2q / dv)^l, times the
    // poles about their centroid (within twice the poles' size), and for a rational surface the quotient rule's
    // division, the weights' ratio to the power k + l + 1.
    if (k + l > 0) {
      int su = bspline::findSpan(p_, U_, nu_, ru.lo), sv = bspline::findSpan(q_, V_, nv_, rv.lo);
      double scale = 2 * size_ * std::pow(2.0 * p_ / (U_[su + 1] - U_[su]), k)
        * std::pow(2.0 * q_ / (V_[sv + 1] - V_[sv]), l);
      if (rational_) scale *= std::pow(wRatio_, k + l + 1);
      err += 64 * (p_ + q_ + 2) * kEps * scale;
    }
    out = meet(out, ballBox(c, r + err));
    return true;
  }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    auto inner = [](const std::vector<double>& K, Range r, std::vector<double>& out) {
      out = {r.lo};
      for (double k : K)
        if (k > r.lo && k < r.hi && k != out.back()) out.push_back(k);
      out.push_back(r.hi);
    };
    inner(U_, ru, us);
    inner(V_, rv, vs);
  }
  Status derivBox(Range ru, Range rv, int k, int l, Box3& out) const override {
    if (!clip(ru, rv)) return out = entireBox(), Status::outOfDomain;
    Status s = rawBox(ru, rv, k, l, out);
    if (s != Status::ok) return s;
    // Met with the centred form on the next order's hulls (which shrinks with the rectangle), within one span only:
    // across a knot a partial of order past the continuity there jumps, and the mean value theorem fails. (A caller
    // wanting a rectangle across knots bounded as tightly cuts it at breaks() itself: tess-cadio's criteria do.)
    int su = bspline::findSpan(p_, U_, nu_, ru.lo), sv = bspline::findSpan(q_, V_, nv_, rv.lo);
    Box3 one;
    if (U_[su + 1] >= ru.hi && V_[sv + 1] >= rv.hi && k + l + 1 < kMaxOrder && centred(ru, rv, k, l, one))
      out = meet(out, one);
    return Status::ok;
  }
  void singularities(std::vector<Singularity>& out) const override {
    out.clear();
    // A side whose row of poles is one point: S there is that point for every value of the other parameter.
    auto row = [&](bool alongV, int index, double at) {
      int n = alongV ? nv_ : nu_;
      Vec3 a = pole(alongV ? index : 0, alongV ? 0 : index);
      double tol = 8 * kEps * (maxAbs(a) + maxAbs(c_)) + 1e-14 * span();
      for (int m = 1; m < n; m++)
        if (norm(pole(alongV ? index : m, alongV ? m : index) - a) > tol) return;
      out.push_back({Singularity::pole, alongV, at, a + c_});
    };
    SurfaceDomain d = domain();
    row(true, 0, d.u.lo), row(true, nu_ - 1, d.u.hi), row(false, 0, d.v.lo), row(false, nv_ - 1, d.v.hi);
    std::sort(out.begin(), out.end(), [](const Singularity& a, const Singularity& b) {
      return a.isoU != b.isoU ? a.isoU < b.isoU : a.at < b.at;
    });
  }

private:
  Vec3 pole(int i, int j) const { return read3(P_.data() + 3 * (i * nv_ + j)); }
  double span() const {
    double m = 0;
    for (double x : P_) m = maxNum(m, std::fabs(x));
    return m;
  }
  bool clip(Range& ru, Range& rv) const {
    SurfaceDomain d = domain();
    ru = {maxNum(ru.lo, d.u.lo), minNum(ru.hi, d.u.hi)};
    rv = {maxNum(rv.lo, d.v.lo), minNum(rv.hi, d.v.hi)};
    return ru.lo <= ru.hi && rv.lo <= rv.hi;
  }
  Net diffU(const Net& f) const {
    Net g{f.p - 1, f.q, f.nu - 1, f.nv, std::vector<double>(f.U.begin() + 1, f.U.end() - 1), f.V, {}, 0, {}};
    double err = 0;
    for (int i = 0; i < g.nu; i++) {
      double den = f.U[i + f.p + 1] - f.U[i + 1];
      for (int j = 0; j < g.nv; j++) {
        double e = 0;
        for (int a = 0; a < 4; a++) {
          double x = den > 0 ? f.p * (f.at(i + 1, j)[a] - f.at(i, j)[a]) / den : 0.0;
          g.h.push_back(x);
          if (den > 0)
            e = maxNum(e, f.p * (f.perr[(i + 1) * f.nv + j] + f.perr[i * f.nv + j]) / den + 4 * kEps * std::fabs(x));
        }
        g.perr.push_back(e), err = maxNum(err, e);
      }
    }
    g.error = err;
    return g;
  }
  Net diffV(const Net& f) const {
    Net g{f.p, f.q - 1, f.nu, f.nv - 1, f.U, std::vector<double>(f.V.begin() + 1, f.V.end() - 1), {}, 0, {}};
    g.h.resize(static_cast<size_t>(g.nu) * g.nv * 4);
    g.perr.assign(static_cast<size_t>(g.nu) * g.nv, 0.0);
    double err = 0;
    for (int j = 0; j < g.nv; j++) {
      double den = f.V[j + f.q + 1] - f.V[j + 1];
      for (int i = 0; i < g.nu; i++) {
        double e = 0;
        for (int a = 0; a < 4; a++) {
          double x = den > 0 ? f.q * (f.at(i, j + 1)[a] - f.at(i, j)[a]) / den : 0.0;
          g.h[(i * g.nv + j) * 4 + a] = x;
          if (den > 0)
            e = maxNum(e, f.q * (f.perr[i * f.nv + j + 1] + f.perr[i * f.nv + j]) / den + 4 * kEps * std::fabs(x));
        }
        g.perr[i * g.nv + j] = e, err = maxNum(err, e);
      }
    }
    g.error = err;
    return g;
  }
  /** The active poles of net n over the rectangle: index ranges [i0, i1] x [j0, j1]. */
  void active(const Net& n, Range ru, Range rv, int& i0, int& i1, int& j0, int& j1) const {
    int a = bspline::findSpan(n.p, n.U, n.nu, ru.lo), b = bspline::findSpan(n.p, n.U, n.nu, ru.hi);
    int c = bspline::findSpan(n.q, n.V, n.nv, rv.lo), d = bspline::findSpan(n.q, n.V, n.nv, rv.hi);
    i0 = std::max(0, a - n.p), i1 = std::min(n.nu - 1, b), j0 = std::max(0, c - n.q), j1 = std::min(n.nv - 1, d);
  }
  /**
   * The blossoms at (c^(q - j), d^j) for j = 0..q of the q + 1 points D (4 wide) of span s, into out[j * stride]: the
   * blossom by de Boor's algorithm (Ramshaw; Seidel's formulation), the c levels shared: each continued from the state
   * after its q - j of them (the same operations in the same order as q + 1 separate runs, at about a third of the
   * cost).
   */
  static void blossomAll(const double* D, int q, int s, const std::vector<double>& K, double c, double d, double* out,
    int stride) {
    Scratch<double, 64> state((q + 1) * 4), w((q + 1) * 4);
    std::copy(D, D + (q + 1) * 4, state.data());
    auto level = [&](double* X, int r, double t) {
      for (int j = q; j >= r; j--) {
        int i = s - q + j;
        double al = (t - K[i]) / (K[i + q + 1 - r] - K[i]);
        for (int a = 0; a < 4; a++) X[j * 4 + a] = (1 - al) * X[(j - 1) * 4 + a] + al * X[j * 4 + a];
      }
    };
    for (int L = 0; L <= q; L++) {
      // L levels at c done: blossom j = q - L takes the rest at d.
      std::copy(state.data(), state.data() + (q + 1) * 4, w.data());
      for (int r = L + 1; r <= q; r++) level(w.data(), r, d);
      for (int a = 0; a < 4; a++) out[(q - L) * stride + a] = w[q * 4 + a];
      if (L < q) level(state.data(), L + 1, c);
    }
  }
  /**
   * The Bezier points P[0..q] (4 wide, stride apart) on [0, 1] restricted to [s0, s1] in place: de Casteljau at s1,
   * keeping the left part, then at s0 / s1 of that, keeping the right.
   */
  static void restrict(double* P, int q, int stride, double s0, double s1) {
    if (s0 == 0 && s1 == 1) return;
    Scratch<double, 64> w((q + 1) * 4), left((q + 1) * 4);
    for (int k = 0; k <= q; k++)
      for (int a = 0; a < 4; a++) w[k * 4 + a] = P[k * stride + a];
    // Left part at s1: the first point of each level.
    for (int a = 0; a < 4; a++) left[a] = w[a];
    for (int r = 1; r <= q; r++) {
      for (int k = 0; k + r <= q; k++)
        for (int a = 0; a < 4; a++) w[k * 4 + a] = (1 - s1) * w[k * 4 + a] + s1 * w[(k + 1) * 4 + a];
      for (int a = 0; a < 4; a++) left[r * 4 + a] = w[a];
    }
    // Right part of that at s0 / s1: the last point of each level.
    const double t = s1 > 0 ? s0 / s1 : 0;
    for (int a = 0; a < 4; a++) P[q * stride + a] = left[q * 4 + a];
    for (int r = 1; r <= q; r++) {
      for (int k = 0; k + r <= q; k++)
        for (int a = 0; a < 4; a++) left[k * 4 + a] = (1 - t) * left[k * 4 + a] + t * left[(k + 1) * 4 + a];
      for (int a = 0; a < 4; a++) P[(q - r) * stride + a] = left[(q - r) * 4 + a];
    }
  }
  /**
   * The control points (4 wide each) a box of net n over the rectangle takes: within one span of the surface, the
   * sub-patch's Bezier net (the blossoms at (a^(p - i), b^i; c^(q - j), d^j): the patch over the rectangle lies in
   * its hull, which shrinks with it); across spans, the active poles.
   */
  void control(const Net& n, Range ru, Range rv, bool oneSpan, int su, int sv, int k, int l,
    std::vector<double>& out) const {
    out.clear();
    if (!oneSpan) {
      int i0, i1, j0, j1;
      active(n, ru, rv, i0, i1, j0, j1);
      for (int i = i0; i <= i1; i++)
        for (int j = j0; j <= j1; j++) out.insert(out.end(), n.at(i, j), n.at(i, j) + 4);
      return;
    }
    int p = n.p, q = n.q, s = su - k, t = sv - l;
    // The span's own Bezier net (its blossoms at its knots), kept by surface, partial and span, then restricted to
    // the rectangle: inversion and the criteria ask for many rectangles within a span, and blossoming each is
    // O(p q^2 + q p^2) where restricting is O(p q + q p) a split.
    const double ua = n.U[s], ub = n.U[s + 1], va = n.V[t], vb = n.V[t + 1];
    if (oneSpan && ub > ua && vb > va && !(ru.lo == ua && ru.hi == ub && rv.lo == va && rv.hi == vb)) {
      struct Key {
        uint64_t id;
        int at, s, t;
        bool operator==(const Key& o) const { return id == o.id && at == o.at && s == o.s && t == o.t; }
      };
      struct Hash {
        size_t operator()(const Key& k) const {
          const uint64_t h = k.id * 1000003u ^ (uint64_t(k.at) << 40) ^ (uint64_t(k.s) << 20) ^ uint64_t(k.t);
          return std::hash<uint64_t>()(h);
        }
      };
      thread_local std::unordered_map<Key, std::vector<double>, Hash> spans;
      if (spans.size() > (1u << 12)) spans.clear();
      std::vector<double>& span = spans[Key{id_, pidx(k, l), s, t}];
      if (span.empty()) control(n, {ua, ub}, {va, vb}, true, su, sv, k, l, span);
      out = span;
      const double u0 = (ru.lo - ua) / (ub - ua), u1 = (ru.hi - ua) / (ub - ua);
      const double v0 = (rv.lo - va) / (vb - va), v1 = (rv.hi - va) / (vb - va);
      for (int i = 0; i <= p; i++) restrict(out.data() + i * (q + 1) * 4, q, 4, v0, v1);
      for (int j = 0; j <= q; j++) restrict(out.data() + j * 4, p, (q + 1) * 4, u0, u1);
      return;
    }
    Scratch<double, 256> rows((p + 1) * (q + 1) * 4), D(std::max(p, q) * 4 + 4);
    // In v first, row by row: rows[i][j] the blossom of row i at (c^(q - j), d^j).
    for (int i = 0; i <= p; i++) {
      for (int m = 0; m <= q; m++)
        for (int a = 0; a < 4; a++) D[m * 4 + a] = n.at(s - p + i, t - q + m)[a];
      blossomAll(D.data(), q, t, n.V, rv.lo, rv.hi, rows.data() + i * (q + 1) * 4, 4);
    }
    out.resize((p + 1) * (q + 1) * 4);
    for (int j = 0; j <= q; j++) {
      for (int m = 0; m <= p; m++)
        for (int a = 0; a < 4; a++) D[m * 4 + a] = rows[(m * (q + 1) + j) * 4 + a];
      // The blossom's own knots in u are the net's; s - p + m indexes them as the rows came.
      blossomAll(D.data(), p, s, n.U, ru.lo, ru.hi, out.data() + j * 4, (q + 1) * 4);
    }
  }
  /**
   * The rounding of net m's control points c over a rectangle: its active poles' own (c are convex combinations of
   * them alone) and the blossom's (a few operations per level, on values up to the net's size).
   */
  double blossomErr(const Net& m, const std::vector<double>& c, Range ru, Range rv) const {
    double mag = 0, own = 0;
    for (double x : c) mag = maxNum(mag, std::fabs(x));
    int i0, i1, j0, j1;
    active(m, ru, rv, i0, i1, j0, j1);
    for (int i = i0; i <= i1; i++)
      for (int j = j0; j <= j1; j++) own = maxNum(own, m.perr[i * m.nv + j]);
    return own + 8 * (m.p + m.q + 2) * kEps * mag;
  }
  /**
   * Partial (k, l)'s control points over the rectangle (4 wide each, as control() makes them) and their rounding.
   * Within one span they're kept for the last rectangle asked, since inversion and tess-cadio's criteria ask for one
   * rectangle's partials one after another, each with its centred form: the order-(0, 0) sub-net is blossomed once,
   * and each partial's Bezier net over the rectangle is the next lower one's differences, m (P[i+1] - P[i]) / (b - a)
   * for degree m there (restriction commutes with differentiation: the same net as blossoming the partial's own),
   * unless their rounding, which the width divides, passes 1e-6 of the net's size (a rectangle a few millionths
   * wide, its second and third partials): then blossomed from the partial's own net, as across spans.
   */
  const std::vector<double>& over(int k, int l, Range ru, Range rv, bool oneSpan, int su, int sv, double& err) const {
    const Net& n = nets_[pidx(k, l)];
    if (!oneSpan) {
      // One buffer per partial: the rational bounds hold the order-0 net's while asking for the others'.
      thread_local std::vector<double> spread[kPartials];
      std::vector<double>& c = spread[pidx(k, l)];
      control(n, ru, rv, false, su, sv, k, l, c);
      err = blossomErr(n, c, ru, rv);
      return c;
    }
    struct Kept {
      uint64_t owner = 0;
      double a = NAN, b = NAN, c = NAN, d = NAN;
      bool have[kPartials] = {};
      std::vector<double> net[kPartials];
      double err[kPartials] = {};
    };
    thread_local Kept K;
    if (K.owner != id_ || K.a != ru.lo || K.b != ru.hi || K.c != rv.lo || K.d != rv.hi) {
      K.owner = id_, K.a = ru.lo, K.b = ru.hi, K.c = rv.lo, K.d = rv.hi;
      std::fill(K.have, K.have + kPartials, false);
    }
    const int at = pidx(k, l);
    if (!K.have[at]) {
      bool done = false;
      if (k + l > 0) {
        const bool inU = k > 0;
        double e0;
        const std::vector<double>& b = over(inU ? k - 1 : k, inU ? l : l - 1, ru, rv, true, su, sv, e0);
        const int bp = p_ - (inU ? k - 1 : k), bq = q_ - (inU ? l : l - 1), m = inU ? bp : bq;
        const int np = inU ? bp - 1 : bp, nq = inU ? bq : bq - 1;
        const double w = inU ? ru.hi - ru.lo : rv.hi - rv.lo;
        if (m > 0 && w > 0) {
          std::vector<double>& o = K.net[at];
          o.resize(static_cast<size_t>(np + 1) * (nq + 1) * 4);
          double e = 0, mag = 0;
          for (int r = 0; r <= np; r++)
            for (int t = 0; t <= nq; t++) {
              const double* lo = b.data() + (r * (bq + 1) + t) * 4;
              const double* hi = b.data() + (inU ? (r + 1) * (bq + 1) + t : r * (bq + 1) + t + 1) * 4;
              for (int a = 0; a < 4; a++) {
                const double x = m * (hi[a] - lo[a]) / w;
                o[(r * (nq + 1) + t) * 4 + a] = x;
                e = maxNum(e, m * 2 * e0 / w + 4 * kEps * std::fabs(x));
                mag = maxNum(mag, std::fabs(x));
              }
            }
          if (e <= 1e-6 * mag) K.err[at] = e, done = true;
        }
      }
      if (!done) {
        control(n, ru, rv, true, su, sv, k, l, K.net[at]);
        // Blossoming's rounding, and restriction's from the span's net: 2 (p + q) more levels of convex combinations
        // and the rectangle's ends mapped into the span (a few ulps of the parameters, scaled by the net's spread).
        double mag = 0;
        for (double x : K.net[at]) mag = maxNum(mag, std::fabs(x));
        K.err[at] = blossomErr(n, K.net[at], ru, rv) + 16 * (n.p + n.q + 1) * kEps * mag;
      }
      K.have[at] = true;
    }
    err = K.err[at];
    return K.net[at];
  }
  /** The hull box of partial (k, l) over the rectangle (no centred form). */
  Status rawBox(Range ru, Range rv, int k, int l, Box3& out) const {
    if (k + l >= kMaxOrder) return out = entireBox(), Status::unsupported;
    // Kept for the last rectangle asked, by partial: derivBound asks each partial's box twice (its own, then in its
    // centred form) and the next order's of neighbours twice more.
    struct Kept {
      uint64_t owner = 0;
      double a = NAN, b = NAN, c = NAN, d = NAN;
      bool have[kPartials] = {};
      Box3 box[kPartials];
      Status st[kPartials] = {};
    };
    thread_local Kept K;
    if (K.owner != id_ || K.a != ru.lo || K.b != ru.hi || K.c != rv.lo || K.d != rv.hi) {
      K.owner = id_, K.a = ru.lo, K.b = ru.hi, K.c = rv.lo, K.d = rv.hi;
      std::fill(K.have, K.have + kPartials, false);
    }
    const int at = pidx(k, l);
    if (!K.have[at]) K.st[at] = rawBoxOf(ru, rv, k, l, K.box[at]), K.have[at] = true;
    out = K.box[at];
    return K.st[at];
  }
  Status rawBoxOf(Range ru, Range rv, int k, int l, Box3& out) const {
    // Past the degree a polynomial surface's partial is 0; a rational one's isn't (the quotient rule below).
    if (!rational_ && (k > p_ || l > q_)) return out = pointBox({}), Status::ok;
    int su = bspline::findSpan(p_, U_, nu_, ru.lo), sv = bspline::findSpan(q_, V_, nv_, rv.lo);
    bool oneSpan = U_[su + 1] >= ru.hi && V_[sv + 1] >= rv.hi;
    // (The control points kept across calls, over(): inversion and tess-cadio's criteria ask for boxes by the
    // million, and allocating or blossoming them each time was most of their cost.)
    static const std::vector<double> none;
    double err = 0;
    const std::vector<double>& ctrl = k <= p_ && l <= q_ ? over(k, l, ru, rv, oneSpan, su, sv, err) : none;
    if (!rational_ || k + l == 0) {
      Box3 b = emptyBox();
      double wmin = kInf;
      for (size_t a = 0; a < ctrl.size(); a += 4) {
        Vec3 x{ctrl[a], ctrl[a + 1], ctrl[a + 2]};
        if (k + l == 0) x = (1 / ctrl[a + 3]) * x, wmin = minNum(wmin, ctrl[a + 3]);
        b = hull(b, x);
      }
      if (k + l == 0 && !(wmin - err > 0)) return out = entireBox(), Status::singular;
      b = widen(b, k + l == 0 ? err / (wmin - err) * (1 + boxNorm(b)) : err);
      if (k + l == 0) b = widen(b + pointBox(c_), 4 * kEps * maxAbs(c_));
      out = b;
      return Status::ok;
    }
    // A rational partial: |S^(k,l)| <= (|A^(k,l)| + sum (k i)(l j) |w^(i,j)| |S^(k-i,l-j)|) / w_min, each from the
    // control points of its own net; |S^(0,0) - c| from the order-0 net's projected ones.
    // Each net's summaries (its magnitudes, its weights' and coordinates' ranges) kept for the last rectangle, by
    // partial: every partial's bound reads all the lower ones', and derivBound asks a rectangle's partials together.
    struct IV {
      Interval c[3];
    };
    struct Sum {
      double e = 0, wmin = kInf, s0 = 0, am = 0, wm = 0;
      IV ia;
      Interval iw;
    };
    struct SumKept {
      uint64_t owner = 0;
      double a = NAN, b = NAN, c = NAN, d = NAN;
      bool have[kPartials] = {}, haveB[kPartials] = {}, haveS[kPartials] = {};
      Sum sum[kPartials];
      double B[kPartials];
      IV S[kPartials];
    };
    thread_local SumKept SK;
    if (SK.owner != id_ || SK.a != ru.lo || SK.b != ru.hi || SK.c != rv.lo || SK.d != rv.hi) {
      SK.owner = id_, SK.a = ru.lo, SK.b = ru.hi, SK.c = rv.lo, SK.d = rv.hi;
      std::fill(SK.have, SK.have + kPartials, false);
      std::fill(SK.haveB, SK.haveB + kPartials, false);
      std::fill(SK.haveS, SK.haveS + kPartials, false);
    }
    auto summary = [&](int kk, int m) -> const Sum& {
      const int at = pidx(kk, m);
      Sum& S = SK.sum[at];
      if (SK.have[at]) return S;
      S = Sum{};
      const std::vector<double>& cc = over(kk, m, ru, rv, oneSpan, su, sv, S.e);
      const double e = S.e;
      for (int d = 0; d < 3; d++) S.ia.c[d] = {kInf, -kInf};
      S.iw = {kInf, -kInf};
      for (size_t a = 0; a < cc.size(); a += 4) {
        if (at == 0) {
          S.wmin = minNum(S.wmin, cc[a + 3] - e);
          S.s0 = maxNum(S.s0, norm(Vec3{cc[a], cc[a + 1], cc[a + 2]}) / cc[a + 3]);
        } else {
          S.am = maxNum(S.am, norm(Vec3{cc[a], cc[a + 1], cc[a + 2]}) + std::sqrt(3.0) * e);
          S.wm = maxNum(S.wm, std::fabs(cc[a + 3]) + e);
        }
        for (int d = 0; d < 3; d++) S.ia.c[d] = {minNum(S.ia.c[d].lo, cc[a + d]), maxNum(S.ia.c[d].hi, cc[a + d])};
        S.iw = {minNum(S.iw.lo, cc[a + 3]), maxNum(S.iw.hi, cc[a + 3])};
      }
      for (int d = 0; d < 3; d++) S.ia.c[d] = {S.ia.c[d].lo - e, S.ia.c[d].hi + e};
      S.iw = {S.iw.lo - e, S.iw.hi + e};
      SK.have[at] = true;
      return S;
    };
    const Sum& z = summary(0, 0);
    const double e0 = z.e, wmin = z.wmin, s0 = z.s0;
    if (!(wmin > 0)) return out = entireBox(), Status::singular;
    // (Each partial's B and S below depend on the rectangle alone, each from the lower partials' before it: kept in
    // SK with the summaries, a rectangle's partials asked one after another each take the lower ones' as they are.)
    double* B = SK.B;
    if (!SK.haveB[0]) B[0] = s0 * (1 + 16 * kEps) + std::sqrt(3.0) * e0 / wmin, SK.haveB[0] = true;
    auto wm = [&](int i, int j) { return i > p_ || j > q_ ? 0.0 : summary(i, j).wm; };
    for (int t = 1; t <= k + l; t++)
      for (int m = 0; m <= t; m++) {
        int kk = t - m;
        if (kk > k || m > l || SK.haveB[pidx(kk, m)]) continue;
        double v = kk > p_ || m > q_ ? 0.0 : summary(kk, m).am;
        for (int i = 0; i <= kk; i++)
          for (int j = 0; j <= m; j++)
            if (i || j) v += binom(kk, i) * binom(m, j) * wm(i, j) * B[pidx(kk - i, m - j)];
        B[pidx(kk, m)] = v / wmin * (1 + 16 * kEps), SK.haveB[pidx(kk, m)] = true;
      }
    out = ballBox({}, B[pidx(k, l)]);
    if (k + l < 2) return Status::ok;
    // Met with the same recursion in intervals, component by component: the homogeneous partials' and the weights'
    // ranges from their nets' control points (restricted to the rectangle where it's one span, so they shrink with
    // it), S^(k,l) = (A^(k,l) - sum (k i)(l j) w^(i,j) S^(k-i,l-j)) / w. Signs and cancellations kept, which the
    // magnitudes above lose: tight as the rectangle shrinks, where those stay a constant factor off.
    const Interval IW0 = z.iw;
    if (!(IW0.lo > 0)) return Status::ok;
    IV* S = SK.S;
    auto iw = [&](int i, int j) { return i > p_ || j > q_ ? Interval::point(0) : summary(i, j).iw; };
    if (!SK.haveS[0]) {
      for (int d = 0; d < 3; d++) S[0].c[d] = z.ia.c[d] / IW0;
      SK.haveS[0] = true;
    }
    for (int t = 1; t <= k + l; t++)
      for (int m = 0; m <= t; m++) {
        int kk = t - m;
        if (kk > k || m > l || SK.haveS[pidx(kk, m)]) continue;
        const bool past = kk > p_ || m > q_;
        for (int d = 0; d < 3; d++) {
          Interval v = past ? Interval::point(0) : summary(kk, m).ia.c[d];
          for (int i = 0; i <= kk; i++)
            for (int j = 0; j <= m; j++)
              if (i || j)
                v = v - Interval::point(binom(kk, i) * binom(m, j)) * iw(i, j) * S[pidx(kk - i, m - j)].c[d];
          S[pidx(kk, m)].c[d] = v / IW0;
        }
        SK.haveS[pidx(kk, m)] = true;
      }
    const IV& r = S[pidx(k, l)];
    Box3 box{r.c[0], r.c[1], r.c[2]};
    // (Widened by the rounding of the recursion's own operations, relative to its terms.)
    out = meet(out, widen(box, 64 * kEps * boxNorm(box)));
    return Status::ok;
  }

  int p_, q_, nu_, nv_;
  bool rational_;
  std::vector<double> U_, V_, P_, W_;  // poles relative to c_, weights (1 where not rational)
  Vec3 c_;
  std::vector<Net> nets_;
  std::vector<bool> has_;
  /** The poles' largest coordinate about c_, the weights' largest over their smallest (centred()'s rounding). */
  double size_ = 0, wRatio_ = 1;
  /** This surface among all made, for over()'s kept nets (an address can be reused). */
  const uint64_t id_ = [] {
    static std::atomic<uint64_t> next{1};
    return next++;
  }();
};

} // namespace

std::unique_ptr<SurfaceImpl> makeBSpline(const double* r, const int32_t* in, Status& status) {
  int p = in[0], q = in[1], nu = in[2], nv = in[3], ku = in[4], kv = in[5];
  bool rational = in[6] != 0;
  status = Status::invalidModel;
  if (p < 1 || q < 1 || nu < p + 1 || nv < q + 1) return nullptr;
  for (int i = 0; i < ku; i++)
    if (in[11 + i] < 1 || (i > 0 && !(r[i] > r[i - 1]))) return nullptr;
  for (int i = 0; i < kv; i++)
    if (in[11 + ku + i] < 1 || (i > 0 && !(r[ku + i] > r[ku + i - 1]))) return nullptr;
  std::vector<double> U = bspline::fullKnots(r, in + 11, ku), V = bspline::fullKnots(r + ku, in + 11 + ku, kv);
  if (static_cast<int>(U.size()) != nu + p + 1 || static_cast<int>(V.size()) != nv + q + 1) return nullptr;
  const double* P = r + ku + kv;
  const double* Wt = P + 3 * nu * nv;
  // The poles' centroid: the surface's local origin (surface.h's precision rule); each span's again inside derivs.
  Vec3 c{};
  for (int i = 0; i < nu * nv; i++) c = c + read3(P + 3 * i);
  c = (1.0 / (nu * nv)) * c;
  std::vector<double> poles, weights;
  for (int i = 0; i < nu * nv; i++) {
    if (rational && !(Wt[i] > 0)) return nullptr;
    Vec3 x = read3(P + 3 * i) - c;
    poles.insert(poles.end(), {x.x, x.y, x.z});
    weights.push_back(rational ? Wt[i] : 1.0);
  }
  status = Status::ok;
  return std::make_unique<BSplineSurface>(p, q, nu, nv, rational, std::move(U), std::move(V), std::move(poles),
    std::move(weights), c);
}

} // namespace surfaces
} // namespace cadgeom
