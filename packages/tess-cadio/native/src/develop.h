// A face's domain mapped onto a plane where the first triangulation's own in-circle tests, which refinement doesn't
// revisit, run in about 3D lengths (part.h's PartOptions::develop): a cone's exact development (an isometry onto a
// plane sector), or x = (s u + b v, c v), the upper Cholesky factor of the face's mean first fundamental form. The
// domain's own points come back to their exact (u, v) (the criteria key the boundary's points by their bits), the
// mesher's by the inverse map; a metric over (u, v) is carried over by the map's Jacobian. Internal to tess-cadio.
#pragma once

#include <cmath>
#include <map>
#include <utility>

#include "tess_cadio/mesh2d.h"

namespace tesscadio {

/** x = (s u + b v, c v); s 0: none (meshed in (u, v)). */
struct AffineMap {
  double s = 0, b = 0, c = 1;
};

/**
 * A cone's development: (u, v) to (rho cos phi, sigma rho sin phi), rho the distance from the apex along the ruling
 * and phi (u - u0) |slope| / sv, where |R(v)| = |S_u| = r1 + (v - v1) slope on the face's side of the apex and
 * sv = |S_v|: an isometry onto a sector of angle 2 pi sin(half-angle) at most over a whole turn of u, sigma the sign
 * that keeps its orientation. u0 the face's middle u keeps the sector within +-pi of the x axis, so atan2's branch
 * is never crossed. slope 0: none.
 */
struct ConeMap {
  double u0 = 0, v1 = 0, r1 = 0, slope = 0, sv = 1, sigma = 1;
  double rate() const { return std::fabs(slope) / sv; }
  double rho(double v) const { return std::fabs(r1 + (v - v1) * slope) / rate(); }
  Vec2 fwd(Vec2 p) const {
    const double r = rho(p.y), phi = (p.x - u0) * rate();
    return {r * std::cos(phi), sigma * r * std::sin(phi)};
  }
  Vec2 back(Vec2 q) const {
    const double r = std::hypot(q.x, q.y), phi = std::atan2(sigma * q.y, q.x);
    return {u0 + phi / rate(), v1 + (r * rate() - r1) / slope};
  }
  /** The map's Jacobian at (u, v): rows x, y; columns u, v. */
  void jacobian(Vec2 p, double J[2][2]) const {
    const double r = rho(p.y), phi = (p.x - u0) * rate(), c = rate(), g = (slope >= 0 ? 1 : -1) * sv;
    J[0][0] = -r * c * std::sin(phi), J[0][1] = g * std::cos(phi);
    J[1][0] = sigma * r * c * std::cos(phi), J[1][1] = sigma * g * std::sin(phi);
  }
  /** sigma set so the map keeps orientation at (u, v) (its Jacobian's determinant positive). */
  void orient(Vec2 p) {
    sigma = 1;
    double J[2][2];
    jacobian(p, J);
    if (J[0][0] * J[1][1] - J[0][1] * J[1][0] < 0) sigma = -1;
  }
};

/**
 * A cone's development from samples of its surface: |S_u| (|R|) at the face's middle u0 at heights vlo and vhi (on
 * the face's side of the apex), |S_v| (sv). slope 0 where they give none.
 */
inline ConeMap coneFromSamples(double u0, double vlo, double vhi, double ra, double rb, double sv) {
  const double slope = vhi > vlo ? (rb - ra) / (vhi - vlo) : 0;
  if (!(std::fabs(slope) > 1e-12 * (1 + ra + rb)) || !(sv > 0)) return {};
  ConeMap c{u0, vlo, ra, slope, sv, 1};
  c.orient({u0, 0.5 * (vlo + vhi)});
  return c;
}

class Development {
public:
  Development() = default;
  explicit Development(AffineMap a) : affine_(a) {}
  explicit Development(ConeMap c) : cone_(c) {}
  bool active() const { return affine_.s > 0 || cone_.slope != 0; }
  Vec2 fwd(Vec2 uv) const {
    if (cone_.slope != 0) return cone_.fwd(uv);
    return {affine_.s * uv.x + affine_.b * uv.y, affine_.c * uv.y};
  }
  /**
   * A domain point at `uv`, mapped: its (u, v) kept, so back() gives it exactly. Two domain points at one image (a
   * cone's apex at two u) are a collision: the development is no use to that domain.
   */
  Vec2 own(Vec2 uv) {
    const Vec2 x = fwd(uv);
    const auto [it, fresh] = exact_.emplace(std::pair<double, double>{x.x, x.y}, uv);
    if (!fresh && !(it->second.x == uv.x && it->second.y == uv.y)) collided_ = true;
    return x;
  }
  bool collided() const { return collided_; }
  Vec2 back(Vec2 x) const {
    if (auto it = exact_.find({x.x, x.y}); it != exact_.end()) return it->second;
    if (cone_.slope != 0) return cone_.back(x);
    const double v = x.y / affine_.c;
    return {(x.x - affine_.b * v) / affine_.s, v};
  }
  /** M, a metric over (u, v) at `uv`, over the plane: J^-T M J^-1, J the map's Jacobian there. */
  Metric2 metric(Vec2 uv, const Metric2& M) const {
    if (cone_.slope != 0) {
      double J[2][2];
      cone_.jacobian(uv, J);
      const double det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
      const double a = J[1][1] / det, b = -J[0][1] / det, c = -J[1][0] / det, d = J[0][0] / det;  // J^-1
      return {a * (M.a * a + M.b * c) + c * (M.b * a + M.c * c), a * (M.a * b + M.b * d) + c * (M.b * b + M.c * d),
        b * (M.a * b + M.b * d) + d * (M.b * b + M.c * d)};
    }
    const double i11 = 1 / affine_.s, i12 = -affine_.b / (affine_.s * affine_.c), i22 = 1 / affine_.c;
    return {M.a * i11 * i11, i11 * (M.a * i12 + M.b * i22), M.a * i12 * i12 + 2 * M.b * i12 * i22 + M.c * i22 * i22};
  }

private:
  AffineMap affine_;
  ConeMap cone_;
  bool collided_ = false;
  std::map<std::pair<double, double>, Vec2> exact_;
};

} // namespace tesscadio
