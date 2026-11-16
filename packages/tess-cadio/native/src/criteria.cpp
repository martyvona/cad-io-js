// The criteria (criteria.h). The metric is local and anisotropic: at each (u, v) the principal curvatures k1, k2 and
// their directions (the eigenpairs of the second fundamental form against the first), and along each direction the
// size h_i a chord may have, the smallest of sqrt(6 d / |k_i|) (an equilateral triangle's centroid strays h^2 |k| / 6
// from the surface), angle / |k_i| (the normal turns h |k| along it) and the face's 3D extent. In 3D the metric is
// sum e_i e_i^T / h_i^2 (e_i the unit principal directions), conservative in every direction between them (the
// normal curvature there is k1 cos^2 + k2 sin^2); in (u, v) it's pulled back through S_u, S_v. Sizes graded: the
// metric on a grid over the face's (u, v) box, each node's intersected with its neighbours' grown by their distance
// (Borouchaki, Hecht and Frey, "Mesh gradation control", 1998: M / (1 + beta L)^2 at metric length L), the size
// growing at most kGrowth per unit of its own length; a query takes the grid's, interpolated, intersected with its
// own point's. Where the parameterization degenerates (a pole: S_u x S_v vanishing) the point's own is skipped and
// the grid's used.
// accept() samples: the surface within the deflection of the triangle at its centroid and its edges' middles, the
// normals at its corners within the angle of one another and of the facet's own.
#include "tess_cadio/criteria.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace tesscadio {

using namespace cadgeom;

namespace {

/** The size's growth per unit of its own length between neighbouring points, at most (the gradation). */
constexpr double kGrowth = 0.5;
/** Grid cells per side of the face's (u, v) box, for the gradation. */
constexpr int kGrid = 16;

Metric2 scaled(Metric2 m, double s) { return {m.a * s, m.b * s, m.c * s}; }
double length2(Metric2 m, double x, double y) { return m.a * x * x + 2 * m.b * x * y + m.c * y * y; }

/** The symmetric 2 x 2 matrix's eigenvalues (lo, hi) and the unit eigenvector of hi. */
void eigen(Metric2 m, double& lo, double& hi, Vec2& vHi) {
  double t = 0.5 * (m.a + m.c), d = std::sqrt(0.25 * (m.a - m.c) * (m.a - m.c) + m.b * m.b);
  lo = t - d, hi = t + d;
  Vec2 v = std::fabs(m.a - hi) + std::fabs(m.b) >= std::fabs(m.c - hi) + std::fabs(m.b) ? Vec2{m.b, hi - m.a}
    : Vec2{hi - m.c, m.b};
  double l = std::hypot(v.x, v.y);
  vHi = l > 0 ? Vec2{v.x / l, v.y / l} : Vec2{1, 0};
}

/** m with its smaller eigenvalue at least `ratio` times its larger: positive definite whatever rounding did. */
Metric2 floored(Metric2 m, double ratio) {
  double lo, hi;
  Vec2 v;
  eigen(m, lo, hi, v);
  if (!(hi > 0) || !std::isfinite(hi)) return {1, 0, 1};
  if (lo >= ratio * hi) return m;
  lo = ratio * hi;
  // hi v v^T + lo w w^T, w perpendicular to v.
  return {hi * v.x * v.x + lo * v.y * v.y, (hi - lo) * v.x * v.y, hi * v.y * v.y + lo * v.x * v.x};
}

/**
 * The intersection of two metrics (the larger of the two in every direction, by simultaneous reduction), in the
 * symmetric form that stays well conditioned when they're nearly proportional: A = L L^T (Cholesky), C = L^-1 B L^-T
 * with orthonormal eigenvectors Q and eigenvalues c_i, M = L Q diag(max(1, c_i)) Q^T L^T.
 */
Metric2 intersect(Metric2 A, Metric2 B) {
  if (!(A.a > 0) || !(A.a * A.c - A.b * A.b > 0)) return B;
  double l11 = std::sqrt(A.a), l21 = A.b / l11, l22 = std::sqrt(A.c - l21 * l21);
  // L^-1 = [[1 / l11, 0], [-l21 / (l11 l22), 1 / l22]]; C = L^-1 B L^-T.
  double i11 = 1 / l11, i21 = -l21 / (l11 * l22), i22 = 1 / l22;
  double r1a = i11 * B.a, r1b = i11 * B.b;                                      // row 1 of L^-1 B
  double r2a = i21 * B.a + i22 * B.b, r2b = i21 * B.b + i22 * B.c;              // row 2
  Metric2 C{r1a * i11, r1a * i21 + r1b * i22, r2a * i21 + r2b * i22};
  double lo, hi;
  Vec2 v;
  eigen(C, lo, hi, v);
  double dh = std::max(1.0, hi), dl = std::max(1.0, lo);
  // Q D Q^T with Q = [v w], w perpendicular to v.
  Metric2 D{dh * v.x * v.x + dl * v.y * v.y, (dh - dl) * v.x * v.y, dh * v.y * v.y + dl * v.x * v.x};
  // M = L D L^T, L = [[l11, 0], [l21, l22]].
  return {l11 * l11 * D.a, l11 * (l21 * D.a + l22 * D.b),
    l21 * l21 * D.a + 2 * l21 * l22 * D.b + l22 * l22 * D.c};
}

class Local : public SurfaceCriteria {
public:
  Local(const Surface& s, Box2 uv, const Deflections& d, double extent)
    : s_(s), box_(uv), d_(d), hmax_(extent), hmin_(1e-7 * extent) {
    // The grid's own metrics, then graded: sweeps until no node changes (or a bound on them).
    grid_.resize((kGrid + 1) * (kGrid + 1));
    valid_.assign(grid_.size(), false);
    for (int i = 0; i <= kGrid; i++)
      for (int j = 0; j <= kGrid; j++) valid_[at(i, j)] = own(node(i, j), grid_[at(i, j)]);
    // Nodes at a degenerate point take a valid neighbour's (the nearest along the row or column).
    for (int pass = 0; pass < 2 * kGrid; pass++) {
      bool missing = false;
      for (int i = 0; i <= kGrid; i++)
        for (int j = 0; j <= kGrid; j++) {
          if (valid_[at(i, j)]) continue;
          missing = true;
          for (auto [di, dj] : {std::pair{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) {
            int a = i + di, b = j + dj;
            if (a < 0 || b < 0 || a > kGrid || b > kGrid || !valid_[at(a, b)]) continue;
            grid_[at(i, j)] = grid_[at(a, b)], valid_[at(i, j)] = true;
            break;
          }
        }
      if (!missing) break;
    }
    for (Metric2& m : grid_) m = floored(m, kFloor);
    for (int sweep = 0; sweep < 4 * kGrid; sweep++) {
      bool changed = false;
      for (int i = 0; i <= kGrid; i++)
        for (int j = 0; j <= kGrid; j++)
          for (int di = -1; di <= 1; di++)
            for (int dj = -1; dj <= 1; dj++) {
              int a = i + di, b = j + dj;
              if ((!di && !dj) || a < 0 || b < 0 || a > kGrid || b > kGrid) continue;
              Vec2 p = node(i, j), q = node(a, b);
              Metric2 from = grid_[at(a, b)];
              double L = std::sqrt(length2(from, p.x - q.x, p.y - q.y));
              Metric2 grown = scaled(from, 1 / ((1 + kGrowth * L) * (1 + kGrowth * L)));
              Metric2& m = grid_[at(i, j)];
              Metric2 n = intersect(m, grown);
              // (Changed where it's longer than before in some direction, by more than rounding.)
              bool longer = false;
              for (auto [x, y] : {std::pair{1.0, 0.0}, {0.0, 1.0}, {1.0, 1.0}, {1.0, -1.0}})
                longer = longer || length2(n, x, y) > length2(m, x, y) * (1 + 1e-9);
              if (longer) m = n, changed = true;
            }
      if (!changed) break;
    }
    for (int i = 0; i <= kGrid; i++)
      for (int j = 0; j <= kGrid; j++) spacing_ = std::max(spacing_, largest(grid_[at(i, j)], i, j));
    spacing_ = std::min(spacing_, hmax_);
  }

  double edgeSpacing() const override { return spacing_; }

  Metric2 metric(Vec2 p) const override {
    Metric2 g = interpolated(p), m;
    return own(p, m) ? floored(intersect(g, m), kFloor) : g;
  }

  bool accept(const Vec2 t[3]) const override {
    Vec3 p[3];
    for (int i = 0; i < 3; i++) p[i] = at(t[i]);
    // The surface at the centroid and the edges' middles against the flat triangle's points there.
    const double w[4][3] = {{1. / 3, 1. / 3, 1. / 3}, {0.5, 0.5, 0}, {0, 0.5, 0.5}, {0.5, 0, 0.5}};
    for (const auto& b : w) {
      Vec2 uv{b[0] * t[0].x + b[1] * t[1].x + b[2] * t[2].x, b[0] * t[0].y + b[1] * t[1].y + b[2] * t[2].y};
      Vec3 flat = b[0] * p[0] + b[1] * p[1] + b[2] * p[2];
      if (norm(at(uv) - flat) > d_.linear) return false;
    }
    // The normals at the corners (where the surface has one) within the angle of one another and of the flat
    // triangle's own (which a triangle turned over in 3D, as one wide in u near a pole can be, fails).
    Vec3 n[3], g = cross(p[1] - p[0], p[2] - p[0]);
    bool has[3];
    for (int i = 0; i < 3; i++) has[i] = s_.normal(t[i].x, t[i].y, n[i]) == Status::ok;
    // (A facet with two corners on a pole line has rounding for a normal: no direction to judge.)
    double gl = norm(g), c = d_.angular > 0 ? std::cos(d_.angular) : 0;
    double longest = std::max({norm(p[1] - p[0]), norm(p[2] - p[1]), norm(p[0] - p[2])});
    bool facet = gl > 1e-9 * longest * longest;
    for (int i = 0; i < 3; i++) {
      if (!has[i]) continue;
      if (facet && dot(g, n[i]) < c * gl) return false;
      for (int j = i + 1; j < 3; j++)
        if (d_.angular > 0 && has[j] && dot(n[i], n[j]) < c) return false;
    }
    return true;
  }

private:
  /** The metric's smaller eigenvalue at least this times its larger (a size ratio of 1000 at most). */
  static constexpr double kFloor = 1e-6;

  int at(int i, int j) const { return i * (kGrid + 1) + j; }
  Vec2 node(int i, int j) const {
    return {box_.x.lo + (box_.x.hi - box_.x.lo) * i / kGrid, box_.y.lo + (box_.y.hi - box_.y.lo) * j / kGrid};
  }
  Vec3 at(Vec2 p) const {
    SurfacePoint q;
    s_.eval(p.x, p.y, 0, q);
    return q.p;
  }
  double size(double k) const {
    double h = hmax_;
    k = std::fabs(k);
    if (k > 0) {
      h = std::min(h, std::sqrt(6 * d_.linear / k));
      if (d_.angular > 0) h = std::min(h, d_.angular / k);
    }
    return std::max(h, hmin_);
  }
  /** The largest 3D size a metric at grid node (i, j) allows (along its smaller eigenvalue), through S_u, S_v. */
  double largest(Metric2 m, int i, int j) const {
    double lo, hi;
    Vec2 v;
    eigen(m, lo, hi, v);
    // (The direction of the smaller eigenvalue, perpendicular to v, in 3D.)
    SurfacePoint q;
    Vec2 p = node(i, j);
    s_.eval(p.x, p.y, 1, q);
    Vec3 d = (-v.y) * q.du + v.x * q.dv;
    double len = norm(d);
    return lo > 0 && len > 0 ? len / std::sqrt(lo) : hmax_;
  }

  /** The metric of the point's own curvature, in (u, v); false where the parameterization degenerates there. */
  bool own(Vec2 p, Metric2& out) const {
    SurfacePoint q;
    Status st = s_.eval(p.x, p.y, 2, q);
    if (st != Status::ok && st != Status::outOfDomain) return false;
    double E = dot(q.du, q.du), F = dot(q.du, q.dv), G = dot(q.dv, q.dv), det = E * G - F * F;
    Vec3 nn = cross(q.du, q.dv);
    double nl = norm(nn);
    if (!(det > 1e-12 * (E + G) * (E + G)) || !(nl > 0) || !std::isfinite(det)) return false;
    Vec3 n = (1 / nl) * nn;
    double L = dot(n, q.duu), M = dot(n, q.duv), N = dot(n, q.dvv);
    // Principal curvatures: H +- sqrt(H^2 - K), H = (E N - 2 F M + G L) / (2 det), K = (L N - M^2) / det.
    double H = (E * N - 2 * F * M + G * L) / (2 * det), K = (L * N - M * M) / det;
    double r = std::sqrt(std::max(0.0, H * H - K)), k1 = H + r, k2 = H - r;
    // A direction of k1: (II - k1 I) x = 0, from its larger row; k2's I-orthogonal to it.
    Vec2 a{M - k1 * F, -(L - k1 * E)}, b{N - k1 * G, -(M - k1 * F)};
    Vec2 x1 = std::hypot(a.x, a.y) >= std::hypot(b.x, b.y) ? a : b;
    double h1 = size(k1), h2 = size(k2);
    double s1 = length2({E, F, G}, x1.x, x1.y);
    if (!(s1 > 0) || r <= 1e-12 * (std::fabs(H) + 1e-300) || !std::isfinite(s1)) {
      // An umbilic (or no curvature): every direction alike, the smaller size.
      double h = std::min(h1, h2);
      out = {E / (h * h), F / (h * h), G / (h * h)};
      return true;
    }
    x1 = {x1.x / std::sqrt(s1), x1.y / std::sqrt(s1)};
    Vec2 w1{E * x1.x + F * x1.y, F * x1.x + G * x1.y};  // I x1
    // (x2 = (-w1.y, w1.x) / sqrt(det): I-orthogonal to x1, and I-unit as x1 is.)
    Vec2 x2{-w1.y / std::sqrt(det), w1.x / std::sqrt(det)};
    Vec2 w2{E * x2.x + F * x2.y, F * x2.x + G * x2.y};
    double i1 = 1 / (h1 * h1), i2 = 1 / (h2 * h2);
    out = {i1 * w1.x * w1.x + i2 * w2.x * w2.x, i1 * w1.x * w1.y + i2 * w2.x * w2.y,
      i1 * w1.y * w1.y + i2 * w2.y * w2.y};
    return std::isfinite(out.a) && std::isfinite(out.b) && std::isfinite(out.c);
  }

  Metric2 interpolated(Vec2 p) const {
    double fx = box_.x.hi > box_.x.lo ? (p.x - box_.x.lo) / (box_.x.hi - box_.x.lo) * kGrid : 0;
    double fy = box_.y.hi > box_.y.lo ? (p.y - box_.y.lo) / (box_.y.hi - box_.y.lo) * kGrid : 0;
    fx = std::clamp(fx, 0.0, double(kGrid)), fy = std::clamp(fy, 0.0, double(kGrid));
    int i = std::min(int(fx), kGrid - 1), j = std::min(int(fy), kGrid - 1);
    double s = fx - i, t = fy - j;
    const Metric2 &m00 = grid_[at(i, j)], &m10 = grid_[at(i + 1, j)], &m01 = grid_[at(i, j + 1)],
      &m11 = grid_[at(i + 1, j + 1)];
    auto mix = [&](double x00, double x10, double x01, double x11) {
      return (1 - s) * (1 - t) * x00 + s * (1 - t) * x10 + (1 - s) * t * x01 + s * t * x11;
    };
    return {mix(m00.a, m10.a, m01.a, m11.a), mix(m00.b, m10.b, m01.b, m11.b), mix(m00.c, m10.c, m01.c, m11.c)};
  }

  const Surface& s_;
  Box2 box_;
  Deflections d_;
  double hmax_, hmin_;
  double spacing_ = 0;
  std::vector<Metric2> grid_;
  std::vector<bool> valid_;
};

} // namespace

std::unique_ptr<SurfaceCriteria> makeCriteria(const Model&, int, const Surface& s, Box2 uv, const Deflections& d,
  Status& status) {
  status = Status::unsupported;
  if (!(d.linear > 0) || !std::isfinite(uv.x.lo) || !std::isfinite(uv.x.hi) || !std::isfinite(uv.y.lo) ||
    !std::isfinite(uv.y.hi))
    return nullptr;
  // The face's 3D extent: the box's sampled points' (the largest size anywhere).
  Box3 box{{INFINITY, -INFINITY}, {INFINITY, -INFINITY}, {INFINITY, -INFINITY}};
  const int N = 8;
  for (int i = 0; i <= N; i++)
    for (int j = 0; j <= N; j++) {
      SurfacePoint q;
      s.eval(uv.x.lo + (uv.x.hi - uv.x.lo) * i / N, uv.y.lo + (uv.y.hi - uv.y.lo) * j / N, 0, q);
      box.x.lo = std::min(box.x.lo, q.p.x), box.x.hi = std::max(box.x.hi, q.p.x);
      box.y.lo = std::min(box.y.lo, q.p.y), box.y.hi = std::max(box.y.hi, q.p.y);
      box.z.lo = std::min(box.z.lo, q.p.z), box.z.hi = std::max(box.z.hi, q.p.z);
    }
  double extent = std::hypot(box.x.hi - box.x.lo, box.y.hi - box.y.lo, box.z.hi - box.z.lo);
  if (!(extent > 0) || !std::isfinite(extent)) extent = 1;
  status = Status::ok;
  return std::make_unique<Local>(s, uv, d, extent);
}

} // namespace tesscadio
