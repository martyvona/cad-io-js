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
// weight. Those hulls don't shrink within a span, so each box is met with the centred form on the next order's
// hulls, which does. Each bound is widened by the rounding of the differences that made its net (carried pole by
// pole). A row of poles all equal at a side of the domain is a pole of the surface (a collapsed iso-line).
#include <algorithm>
#include <cmath>

#include "cad_geom/numerics.h"
#include "scratch.h"
#include "surface_impl.h"

namespace cadgeom {
namespace surfaces {

namespace {

/** One partial's hodograph net: degrees, knots, poles (nu x nv, u-major, 4 wide: w (P - c), w), and its error. */
struct Net {
  int p, q, nu, nv;
  std::vector<double> U, V;
  std::vector<double> h;
  double error = 0;
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
      double w = W_[i];
      for (int a = 0; a < 3; a++) n0.h.push_back(w * P_[3 * i + a]), mag = std::fmax(mag, std::fabs(w * P_[3 * i + a]));
      n0.h.push_back(w);
    }
    n0.error = 2 * kEps * mag;
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
  Status derivs(double u, double v, int order, Vec3* out) const override {
    SurfaceDomain d = domain();
    Status st = Status::ok;
    if (u < d.u.lo || u > d.u.hi || v < d.v.lo || v > d.v.hi) st = Status::outOfDomain;
    u = std::clamp(u, d.u.lo, d.u.hi), v = std::clamp(v, d.v.lo, d.v.hi);
    int su = bspline::findSpan(p_, U_, nu_, u), sv = bspline::findSpan(q_, V_, nv_, v);
    int n = order;
    // On the stack to order 2 (evaluation) and a degree up to kStackDegree: no allocation in the hot path.
    Scratch<double, 3 * (kStackDegree + 1)> Nu((n + 1) * (p_ + 1)), Nv((n + 1) * (q_ + 1));
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
    // across a knot a partial of order past the continuity there jumps, and the mean value theorem fails.
    int su = bspline::findSpan(p_, U_, nu_, ru.lo), sv = bspline::findSpan(q_, V_, nv_, rv.lo);
    bool oneSpan = U_[su + 1] >= ru.hi && V_[sv + 1] >= rv.hi;
    if (oneSpan && k + l + 1 < kMaxOrder) {
      Box3 bu, bv;
      if (rawBox(ru, rv, k + 1, l, bu) == Status::ok && rawBox(ru, rv, k, l + 1, bv) == Status::ok) {
        double mu = 0.5 * ru.lo + 0.5 * ru.hi, mv = 0.5 * rv.lo + 0.5 * rv.hi;
        Vec3 d[kPartials];
        derivs(mu, mv, k + l, d);
        Vec3 c = d[pidx(k, l)];
        double r = (boxNorm(bu) * (ru.hi - ru.lo) + boxNorm(bv) * (rv.hi - rv.lo)) * 0.5 * (1 + 8 * kEps);
        double err = (k + l == 0 ? 8 * kEps * maxAbs(c - c_) + 4 * kEps * maxAbs(c_) : 1e-12 * maxAbs(c))
          + 1e-13 * r + (k + l == 0 ? 0 : 1e-13 * (boxNorm(out)));
        out = meet(out, ballBox(c, r + err));
      }
    }
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
    for (double x : P_) m = std::fmax(m, std::fabs(x));
    return m;
  }
  bool clip(Range& ru, Range& rv) const {
    SurfaceDomain d = domain();
    ru = {std::fmax(ru.lo, d.u.lo), std::fmin(ru.hi, d.u.hi)};
    rv = {std::fmax(rv.lo, d.v.lo), std::fmin(rv.hi, d.v.hi)};
    return ru.lo <= ru.hi && rv.lo <= rv.hi;
  }
  Net diffU(const Net& f) const {
    Net g{f.p - 1, f.q, f.nu - 1, f.nv, std::vector<double>(f.U.begin() + 1, f.U.end() - 1), f.V, {}, 0};
    double err = 0;
    for (int i = 0; i < g.nu; i++) {
      double den = f.U[i + f.p + 1] - f.U[i + 1];
      for (int j = 0; j < g.nv; j++)
        for (int a = 0; a < 4; a++) {
          double x = den > 0 ? f.p * (f.at(i + 1, j)[a] - f.at(i, j)[a]) / den : 0.0;
          g.h.push_back(x);
          if (den > 0) err = std::fmax(err, f.p * 2 * f.error / den + 4 * kEps * std::fabs(x));
        }
    }
    g.error = err;
    return g;
  }
  Net diffV(const Net& f) const {
    Net g{f.p, f.q - 1, f.nu, f.nv - 1, f.U, std::vector<double>(f.V.begin() + 1, f.V.end() - 1), {}, 0};
    g.h.resize(static_cast<size_t>(g.nu) * g.nv * 4);
    double err = 0;
    for (int j = 0; j < g.nv; j++) {
      double den = f.V[j + f.q + 1] - f.V[j + 1];
      for (int i = 0; i < g.nu; i++)
        for (int a = 0; a < 4; a++) {
          double x = den > 0 ? f.q * (f.at(i, j + 1)[a] - f.at(i, j)[a]) / den : 0.0;
          g.h[(i * g.nv + j) * 4 + a] = x;
          if (den > 0) err = std::fmax(err, f.q * 2 * f.error / den + 4 * kEps * std::fabs(x));
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
   * De Boor's algorithm on the q + 1 points D (4 wide) of span s in knots K, degree q, with argument arg(level) at
   * each level: the blossom (Ramshaw; Seidel's formulation), into out.
   */
  template <class A> static void blossom(double* D, int q, int s, const std::vector<double>& K, A arg, double* out) {
    for (int r = 1; r <= q; r++) {
      double t = arg(r);
      for (int j = q; j >= r; j--) {
        int i = s - q + j;
        double al = (t - K[i]) / (K[i + q + 1 - r] - K[i]);
        for (int a = 0; a < 4; a++) D[j * 4 + a] = (1 - al) * D[(j - 1) * 4 + a] + al * D[j * 4 + a];
      }
    }
    for (int a = 0; a < 4; a++) out[a] = D[q * 4 + a];
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
    std::vector<double> rows((p + 1) * (q + 1) * 4), D(std::max(p, q) * 4 + 4);
    // In v first, row by row: rows[i][j] the blossom of row i at (c^(q - j), d^j).
    for (int i = 0; i <= p; i++)
      for (int j = 0; j <= q; j++) {
        for (int m = 0; m <= q; m++)
          for (int a = 0; a < 4; a++) D[m * 4 + a] = n.at(s - p + i, t - q + m)[a];
        blossom(D.data(), q, t, n.V, [&](int level) { return level <= q - j ? rv.lo : rv.hi; },
          rows.data() + (i * (q + 1) + j) * 4);
      }
    out.resize((p + 1) * (q + 1) * 4);
    for (int j = 0; j <= q; j++)
      for (int i = 0; i <= p; i++) {
        for (int m = 0; m <= p; m++)
          for (int a = 0; a < 4; a++) D[m * 4 + a] = rows[(m * (q + 1) + j) * 4 + a];
        // The blossom's own knots in u are the net's; s - p + m indexes them as the rows came.
        blossom(D.data(), p, s, n.U, [&](int level) { return level <= p - i ? ru.lo : ru.hi; },
          out.data() + (i * (q + 1) + j) * 4);
      }
  }
  /** The hull box of partial (k, l) over the rectangle (no centred form). */
  Status rawBox(Range ru, Range rv, int k, int l, Box3& out) const {
    if (k + l >= kMaxOrder) return out = entireBox(), Status::unsupported;
    // Past the degree a polynomial surface's partial is 0; a rational one's isn't (the quotient rule below).
    if (!rational_ && (k > p_ || l > q_)) return out = pointBox({}), Status::ok;
    int su = bspline::findSpan(p_, U_, nu_, ru.lo), sv = bspline::findSpan(q_, V_, nv_, rv.lo);
    bool oneSpan = U_[su + 1] >= ru.hi && V_[sv + 1] >= rv.hi;
    std::vector<double> ctrl;
    const Net& n = nets_[k <= p_ && l <= q_ ? pidx(k, l) : 0];
    if (k <= p_ && l <= q_) control(n, ru, rv, oneSpan, su, sv, k, l, ctrl);
    // The blossom's rounding on top of the net's own (a few operations per level, on values up to the net's size).
    auto blossomErr = [&](const Net& m, const std::vector<double>& c) {
      double mag = 0;
      for (double x : c) mag = std::fmax(mag, std::fabs(x));
      return m.error + 8 * (m.p + m.q + 2) * kEps * mag;
    };
    double err = blossomErr(n, ctrl);
    if (!rational_ || k + l == 0) {
      Box3 b = emptyBox();
      double wmin = kInf;
      for (size_t a = 0; a < ctrl.size(); a += 4) {
        Vec3 x{ctrl[a], ctrl[a + 1], ctrl[a + 2]};
        if (k + l == 0) x = (1 / ctrl[a + 3]) * x, wmin = std::fmin(wmin, ctrl[a + 3]);
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
    std::vector<double> c0;
    control(nets_[0], ru, rv, oneSpan, su, sv, 0, 0, c0);
    double e0 = blossomErr(nets_[0], c0), wmin = kInf, s0 = 0;
    for (size_t a = 0; a < c0.size(); a += 4) {
      wmin = std::fmin(wmin, c0[a + 3] - e0);
      s0 = std::fmax(s0, norm(Vec3{c0[a], c0[a + 1], c0[a + 2]}) / c0[a + 3]);
    }
    if (!(wmin > 0)) return out = entireBox(), Status::singular;
    double B[kPartials] = {}, Am[kPartials] = {}, Wm[kPartials] = {};
    B[0] = s0 * (1 + 16 * kEps) + std::sqrt(3.0) * e0 / wmin;
    std::vector<double> cc;
    for (int t = 1; t <= k + l; t++)
      for (int m = 0; m <= t; m++) {
        int kk = t - m;
        if (kk > k || m > l || kk > p_ || m > q_) continue;
        const Net& nn = nets_[pidx(kk, m)];
        control(nn, ru, rv, oneSpan, su, sv, kk, m, cc);
        double e = blossomErr(nn, cc);
        for (size_t a = 0; a < cc.size(); a += 4) {
          Am[pidx(kk, m)] = std::fmax(Am[pidx(kk, m)], norm(Vec3{cc[a], cc[a + 1], cc[a + 2]}) + std::sqrt(3.0) * e);
          Wm[pidx(kk, m)] = std::fmax(Wm[pidx(kk, m)], std::fabs(cc[a + 3]) + e);
        }
      }
    for (int t = 1; t <= k + l; t++)
      for (int m = 0; m <= t; m++) {
        int kk = t - m;
        if (kk > k || m > l) continue;
        double v = Am[pidx(kk, m)];
        for (int i = 0; i <= kk; i++)
          for (int j = 0; j <= m; j++)
            if (i || j) v += binom(kk, i) * binom(m, j) * Wm[pidx(i, j)] * B[pidx(kk - i, m - j)];
        B[pidx(kk, m)] = v / wmin * (1 + 16 * kEps);
      }
    out = ballBox({}, B[pidx(k, l)]);
    return Status::ok;
  }

  int p_, q_, nu_, nv_;
  bool rational_;
  std::vector<double> U_, V_, P_, W_;  // poles relative to c_, weights (1 where not rational)
  Vec3 c_;
  std::vector<Net> nets_;
  std::vector<bool> has_;
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
