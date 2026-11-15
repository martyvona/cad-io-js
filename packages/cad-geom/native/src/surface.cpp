// surface.h, the reference version: planes, cylinders, spheres and B-splines (docs/brep-reference.md's definitions),
// the other kinds unsupported; inversion by dense sampling then Newton. Slow and simple, for the lanes that call it
// until the surfaces lane replaces it.
#include "cad_geom/surface.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "cad_geom/numerics.h"

namespace cadgeom {

namespace {

constexpr double kTwoPi = 6.283185307179586;
constexpr double kHalfPi = 1.5707963267948966;
const double kInf = std::numeric_limits<double>::infinity();

Vec3 read3(const double* r) { return {r[0], r[1], r[2]}; }

struct Frame {
  Vec3 o, x, y, z;
  explicit Frame(const double* r)
    : o(read3(r)), x(read3(r + 6)), y(cross(read3(r + 3), read3(r + 6))), z(read3(r + 3)) {}
};

Box3 boxOf(Vec3 lo, Vec3 hi) {
  double e = 8 * std::numeric_limits<double>::epsilon() * (norm(lo) + norm(hi));
  return {{lo.x - e, hi.x + e}, {lo.y - e, hi.y + e}, {lo.z - e, hi.z + e}};
}

Status unitNormal(const Surface& s, double u, double v, Vec3& out) {
  SurfacePoint q;
  Status st = s.eval(u, v, 1, q);
  Vec3 n = cross(q.du, q.dv);
  double l = norm(n);
  if (l == 0) return Status::singular;
  out = (1 / l) * n;
  return st;
}

class Plane final : public Surface {
public:
  explicit Plane(const double* r) : f_(r) {}
  SurfaceDomain domain() const override { return {{-kInf, kInf}, {-kInf, kInf}, 0, 0}; }
  Status eval(double u, double v, int order, SurfacePoint& out) const override {
    out = {f_.o + u * f_.x + v * f_.y, order >= 1 ? f_.x : Vec3{}, order >= 1 ? f_.y : Vec3{}, {}, {}, {}};
    return Status::ok;
  }
  Status normal(double, double, Vec3& out) const override {
    out = f_.z;
    return Status::ok;
  }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    us = {ru.lo, ru.hi};
    vs = {rv.lo, rv.hi};
  }
  Status bound(Range ru, Range rv, Box3& out) const override {
    Vec3 lo{kInf, kInf, kInf}, hi{-kInf, -kInf, -kInf};
    for (double u : {ru.lo, ru.hi})
      for (double v : {rv.lo, rv.hi}) {
        Vec3 p = f_.o + u * f_.x + v * f_.y;
        lo = {std::min(lo.x, p.x), std::min(lo.y, p.y), std::min(lo.z, p.z)};
        hi = {std::max(hi.x, p.x), std::max(hi.y, p.y), std::max(hi.z, p.z)};
      }
    out = boxOf(lo, hi);
    return Status::ok;
  }
  Status derivBound(Range, Range, int order, double out[3]) const override {
    out[0] = out[1] = order == 1 ? 1 + 1e-15 : 0;
    out[2] = 0;
    return Status::ok;
  }
  void singularities(std::vector<Singularity>& out) const override { out.clear(); }

private:
  Frame f_;
};

class Cylinder final : public Surface {
public:
  explicit Cylinder(const double* r) : f_(r), r_(r[9]) {}
  SurfaceDomain domain() const override { return {{0, kTwoPi}, {-kInf, kInf}, kTwoPi, 0}; }
  Status eval(double u, double v, int order, SurfacePoint& out) const override {
    double c = std::cos(u), s = std::sin(u);
    out = {};
    out.p = f_.o + r_ * c * f_.x + r_ * s * f_.y + v * f_.z;
    if (order >= 1) {
      out.du = -r_ * s * f_.x + r_ * c * f_.y;
      out.dv = f_.z;
    }
    if (order >= 2) out.duu = -r_ * c * f_.x - r_ * s * f_.y;
    return Status::ok;
  }
  Status normal(double u, double v, Vec3& out) const override { return unitNormal(*this, u, v, out); }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    us = {ru.lo, ru.hi};
    vs = {rv.lo, rv.hi};
  }
  Status bound(Range, Range rv, Box3& out) const override {
    // The whole circle's box swept over rv.
    Vec3 lo{kInf, kInf, kInf}, hi{-kInf, -kInf, -kInf};
    for (double v : {rv.lo, rv.hi}) {
      Vec3 c = f_.o + v * f_.z;
      Vec3 h{r_ * std::hypot(f_.x.x, f_.y.x), r_ * std::hypot(f_.x.y, f_.y.y), r_ * std::hypot(f_.x.z, f_.y.z)};
      lo = {std::min(lo.x, c.x - h.x), std::min(lo.y, c.y - h.y), std::min(lo.z, c.z - h.z)};
      hi = {std::max(hi.x, c.x + h.x), std::max(hi.y, c.y + h.y), std::max(hi.z, c.z + h.z)};
    }
    out = boxOf(lo, hi);
    return Status::ok;
  }
  Status derivBound(Range, Range, int order, double out[3]) const override {
    double e = 1 + 1e-14;
    if (order == 1) { out[0] = r_ * e; out[1] = e; out[2] = 0; }
    else { out[0] = r_ * e; out[1] = 0; out[2] = 0; }
    return Status::ok;
  }
  void singularities(std::vector<Singularity>& out) const override { out.clear(); }

private:
  Frame f_;
  double r_;
};

class Sphere final : public Surface {
public:
  explicit Sphere(const double* r) : f_(r), r_(r[9]) {}
  SurfaceDomain domain() const override { return {{0, kTwoPi}, {-kHalfPi, kHalfPi}, kTwoPi, 0}; }
  Status eval(double u, double v, int order, SurfacePoint& out) const override {
    Status st = (v < -kHalfPi || v > kHalfPi) ? Status::outOfDomain : Status::ok;
    v = std::clamp(v, -kHalfPi, kHalfPi);
    double cu = std::cos(u), su = std::sin(u), cv = std::cos(v), sv = std::sin(v);
    Vec3 radial = cu * f_.x + su * f_.y, tangent = -su * f_.x + cu * f_.y;
    out = {};
    out.p = f_.o + r_ * cv * radial + r_ * sv * f_.z;
    if (order >= 1) {
      out.du = r_ * cv * tangent;
      out.dv = -r_ * sv * radial + r_ * cv * f_.z;
    }
    if (order >= 2) {
      out.duu = -r_ * cv * radial;
      out.duv = -r_ * sv * tangent;
      out.dvv = -r_ * cv * radial - r_ * sv * f_.z;
    }
    return st;
  }
  Status normal(double u, double v, Vec3& out) const override {
    SurfacePoint q;
    Status st = eval(u, v, 0, q);
    out = (1 / r_) * (q.p - f_.o);
    return st;
  }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    us = {ru.lo, ru.hi};
    vs = {rv.lo, rv.hi};
  }
  Status bound(Range, Range, Box3& out) const override {
    Vec3 h{r_, r_, r_};
    out = boxOf(f_.o - h, f_.o + h);
    return Status::ok;
  }
  Status derivBound(Range, Range, int, double out[3]) const override {
    out[0] = out[1] = out[2] = r_ * (1 + 1e-14);
    return Status::ok;
  }
  void singularities(std::vector<Singularity>& out) const override {
    out = {{Singularity::pole, false, -kHalfPi, f_.o - r_ * f_.z},
      {Singularity::pole, false, kHalfPi, f_.o + r_ * f_.z}};
  }

private:
  Frame f_;
  double r_;
};

class SplineSurface final : public Surface {
public:
  SplineSurface(int p, int q, int nu, int nv, bool rational, std::vector<double> U, std::vector<double> V,
    std::vector<double> poles)
    : p_(p), q_(q), nu_(nu), nv_(nv), rational_(rational), U_(std::move(U)), V_(std::move(V)),
      poles_(std::move(poles)) {}
  SurfaceDomain domain() const override { return {{U_[p_], U_[nu_]}, {V_[q_], V_[nv_]}, 0, 0}; }
  Status eval(double u, double v, int order, SurfacePoint& out) const override {
    Status st = Status::ok;
    if (u < U_[p_] || u > U_[nu_] || v < V_[q_] || v > V_[nv_]) st = Status::outOfDomain;
    u = std::clamp(u, U_[p_], U_[nu_]);
    v = std::clamp(v, V_[q_], V_[nv_]);
    int su = bspline::findSpan(p_, U_, nu_, u), sv = bspline::findSpan(q_, V_, nv_, v);
    int n = std::min(order, 2);
    std::vector<double> Nu((n + 1) * (p_ + 1)), Nv((n + 1) * (q_ + 1));
    bspline::basisDerivs(su, u, p_, n, U_, Nu.data());
    bspline::basisDerivs(sv, v, q_, n, V_, Nv.data());
    // Homogeneous S^(k,l) and w^(k,l) for k + l <= n.
    double A[3][3][3] = {}, W[3][3] = {};
    int w = rational_ ? 4 : 3;
    for (int k = 0; k <= n; k++)
      for (int l = 0; k + l <= n; l++)
        for (int i = 0; i <= p_; i++)
          for (int j = 0; j <= q_; j++) {
            const double* P = poles_.data() + ((su - p_ + i) * nv_ + (sv - q_ + j)) * w;
            double wt = rational_ ? P[3] : 1.0, b = Nu[k * (p_ + 1) + i] * Nv[l * (q_ + 1) + j] * wt;
            for (int a = 0; a < 3; a++) A[k][l][a] += b * P[a];
            W[k][l] += b;
          }
    // Rational derivatives (Piegl and Tiller, eq. 4.20) to second order.
    Vec3 S[3][3];
    auto vecOf = [](const double* a) { return Vec3{a[0], a[1], a[2]}; };
    S[0][0] = (1 / W[0][0]) * vecOf(A[0][0]);
    if (n >= 1) {
      S[1][0] = (1 / W[0][0]) * (vecOf(A[1][0]) - W[1][0] * S[0][0]);
      S[0][1] = (1 / W[0][0]) * (vecOf(A[0][1]) - W[0][1] * S[0][0]);
    }
    if (n >= 2) {
      S[2][0] = (1 / W[0][0]) * (vecOf(A[2][0]) - 2 * W[1][0] * S[1][0] - W[2][0] * S[0][0]);
      S[0][2] = (1 / W[0][0]) * (vecOf(A[0][2]) - 2 * W[0][1] * S[0][1] - W[0][2] * S[0][0]);
      S[1][1] = (1 / W[0][0])
        * (vecOf(A[1][1]) - W[1][0] * S[0][1] - W[0][1] * S[1][0] - W[1][1] * S[0][0]);
    }
    out = {S[0][0], S[1][0], S[0][1], S[2][0], S[1][1], S[0][2]};
    if (order < 1) out.du = out.dv = {};
    return st;
  }
  Status normal(double u, double v, Vec3& out) const override { return unitNormal(*this, u, v, out); }
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
  Status bound(Range ru, Range rv, Box3& out) const override {
    int w = rational_ ? 4 : 3;
    int a = bspline::findSpan(p_, U_, nu_, ru.lo), b = bspline::findSpan(p_, U_, nu_, ru.hi);
    int c = bspline::findSpan(q_, V_, nv_, rv.lo), d = bspline::findSpan(q_, V_, nv_, rv.hi);
    Vec3 lo{kInf, kInf, kInf}, hi{-kInf, -kInf, -kInf};
    for (int i = a - p_; i <= b; i++)
      for (int j = c - q_; j <= d; j++) {
        Vec3 P = read3(poles_.data() + (i * nv_ + j) * w);
        lo = {std::min(lo.x, P.x), std::min(lo.y, P.y), std::min(lo.z, P.z)};
        hi = {std::max(hi.x, P.x), std::max(hi.y, P.y), std::max(hi.z, P.z)};
      }
    out = boxOf(lo, hi);
    return Status::ok;
  }
  Status derivBound(Range, Range, int, double[3]) const override { return Status::unsupported; }
  void singularities(std::vector<Singularity>& out) const override { out.clear(); }

private:
  int p_, q_, nu_, nv_;
  bool rational_;
  std::vector<double> U_, V_, poles_;
};

} // namespace

std::unique_ptr<Surface> makeSurface(const Model& m, int row, Status& status) {
  status = Status::invalidModel;
  if (row < 0 || row >= m.surfaces()) return nullptr;
  const double* r = m.surfaceReals(row);
  const int32_t* in = m.surfaceInts(row);
  status = Status::ok;
  switch (m.surfaceKind(row)) {
  case CBR_SURFACE_PLANE: return std::make_unique<Plane>(r);
  case CBR_SURFACE_CYLINDER: return std::make_unique<Cylinder>(r);
  case CBR_SURFACE_SPHERE: return std::make_unique<Sphere>(r);
  case CBR_SURFACE_BSPLINE: {
    int p = in[0], q = in[1], nu = in[2], nv = in[3], ku = in[4], kv = in[5];
    bool rational = in[6] != 0;
    std::vector<double> U = bspline::fullKnots(r, in + 11, ku), V = bspline::fullKnots(r + ku, in + 11 + ku, kv);
    if (static_cast<int>(U.size()) != nu + p + 1 || static_cast<int>(V.size()) != nv + q + 1) {
      status = Status::invalidModel;
      return nullptr;
    }
    const double* P = r + ku + kv;
    const double* Wt = P + 3 * nu * nv;
    std::vector<double> poles;
    for (int i = 0; i < nu * nv; i++) {
      poles.insert(poles.end(), P + 3 * i, P + 3 * i + 3);
      if (rational) poles.push_back(Wt[i]);
    }
    return std::make_unique<SplineSurface>(p, q, nu, nv, rational, std::move(U), std::move(V), std::move(poles));
  }
  default: status = Status::unsupported; return nullptr;
  }
}

SurfaceInversion invertSurface(const Surface& s, Vec3 p, Range ru, Range rv, double tol, const Vec2*) {
  SurfaceInversion out;
  if (!std::isfinite(ru.lo) || !std::isfinite(ru.hi) || !std::isfinite(rv.lo) || !std::isfinite(rv.hi)) return out;
  // A dense grid, the local minima polished by Newton on the gradient of |S - p|^2 / 2.
  const int N = 48;
  std::vector<double> d((N + 1) * (N + 1));
  auto at = [&](int i, int j) { return Vec2{ru.lo + (ru.hi - ru.lo) * i / N, rv.lo + (rv.hi - rv.lo) * j / N}; };
  for (int i = 0; i <= N; i++)
    for (int j = 0; j <= N; j++) {
      SurfacePoint q;
      Vec2 uv = at(i, j);
      s.eval(uv.x, uv.y, 0, q);
      d[i * (N + 1) + j] = norm(q.p - p);
    }
  std::vector<std::pair<Vec2, double>> minima;
  for (int i = 0; i <= N; i++)
    for (int j = 0; j <= N; j++) {
      double c = d[i * (N + 1) + j];
      bool isMin = true;
      for (int a = -1; a <= 1 && isMin; a++)
        for (int b = -1; b <= 1; b++) {
          int ii = i + a, jj = j + b;
          if ((a || b) && ii >= 0 && ii <= N && jj >= 0 && jj <= N && d[ii * (N + 1) + jj] < c) {
            isMin = false;
            break;
          }
        }
      if (!isMin) continue;
      Vec2 uv = at(i, j);
      for (int it = 0; it < 50; it++) {
        SurfacePoint q;
        s.eval(uv.x, uv.y, 2, q);
        Vec3 e = q.p - p;
        double gu = dot(e, q.du), gv = dot(e, q.dv);
        double huu = dot(q.du, q.du) + dot(e, q.duu), huv = dot(q.du, q.dv) + dot(e, q.duv),
          hvv = dot(q.dv, q.dv) + dot(e, q.dvv);
        double det = huu * hvv - huv * huv;
        if (!(det > 0) || !(huu > 0)) break;
        Vec2 next{uv.x - (hvv * gu - huv * gv) / det, uv.y - (huu * gv - huv * gu) / det};
        next = {std::clamp(next.x, ru.lo, ru.hi), std::clamp(next.y, rv.lo, rv.hi)};
        double step = norm(next - uv);
        uv = next;
        if (step <= 1e-15 * (1 + norm(uv))) break;
      }
      SurfacePoint q;
      s.eval(uv.x, uv.y, 0, q);
      minima.push_back({uv, norm(q.p - p)});
    }
  std::sort(minima.begin(), minima.end(), [](auto& x, auto& y) { return x.second < y.second; });
  out.status = Status::ok;
  if (minima.empty()) return out;
  out.uv = minima[0].first;
  out.distance = minima[0].second;
  SurfacePoint q;
  s.eval(out.uv.x, out.uv.y, 0, q);
  out.foot = q.p;
  out.certainty = Certainty::unique;
  SurfaceDomain dom = s.domain();
  out.onSeamU = dom.uPeriod > 0
    && (std::fabs(out.uv.x - dom.u.lo) <= 1e-9 || std::fabs(out.uv.x - dom.u.hi) <= 1e-9);
  out.onSeamV = dom.vPeriod > 0
    && (std::fabs(out.uv.y - dom.v.lo) <= 1e-9 || std::fabs(out.uv.y - dom.v.hi) <= 1e-9);
  std::vector<Singularity> sing;
  s.singularities(sing);
  for (auto& g : sing)
    if (g.kind != Singularity::normalVanishes && norm(g.point - out.foot) <= tol) out.atSingularity = true;
  for (size_t i = 1; i < minima.size(); i++) {
    SurfacePoint qi;
    s.eval(minima[i].first.x, minima[i].first.y, 0, qi);
    if (minima[i].second - out.distance > tol || norm(qi.p - out.foot) <= tol) continue;
    bool dup = false;
    for (auto& a : out.alternatives) {
      SurfacePoint qa;
      s.eval(a.x, a.y, 0, qa);
      dup = dup || norm(qa.p - qi.p) <= tol;
    }
    if (!dup) {
      out.certainty = Certainty::ambiguous;
      out.alternatives.push_back(minima[i].first);
    }
  }
  return out;
}

} // namespace cadgeom
