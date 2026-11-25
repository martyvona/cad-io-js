// A face's domain mapped onto a plane where the first triangulation's own in-circle tests, which refinement doesn't
// revisit, run in about 3D lengths (part.h's PartOptions::develop): x = (s u + b v, c v), the upper Cholesky factor of
// the face's mean first fundamental form. The domain's own points come back to their exact (u, v) (the criteria key
// the boundary's points by their bits), the mesher's by the inverse map; a metric over (u, v) is carried over by the
// map's Jacobian. Internal to tess-cadio.
#pragma once

#include <map>
#include <utility>

#include "tess_cadio/mesh2d.h"

namespace tesscadio {

/** x = (s u + b v, c v); s 0: none (meshed in (u, v)). */
struct AffineMap {
  double s = 0, b = 0, c = 1;
};

class Development {
public:
  Development() = default;
  explicit Development(AffineMap a) : affine_(a) {}
  bool active() const { return affine_.s > 0; }
  Vec2 fwd(Vec2 uv) const { return {affine_.s * uv.x + affine_.b * uv.y, affine_.c * uv.y}; }
  /** A domain point at `uv`, mapped: its (u, v) kept, so back() gives it exactly. */
  Vec2 own(Vec2 uv) {
    const Vec2 x = fwd(uv);
    exact_.emplace(std::pair<double, double>{x.x, x.y}, uv);
    return x;
  }
  Vec2 back(Vec2 x) const {
    if (auto it = exact_.find({x.x, x.y}); it != exact_.end()) return it->second;
    const double v = x.y / affine_.c;
    return {(x.x - affine_.b * v) / affine_.s, v};
  }
  /** M, a metric over (u, v) at `uv`, over the plane: A^-T M A^-1. */
  Metric2 metric(Vec2 uv, const Metric2& M) const {
    (void)uv;
    const double i11 = 1 / affine_.s, i12 = -affine_.b / (affine_.s * affine_.c), i22 = 1 / affine_.c;
    return {M.a * i11 * i11, i11 * (M.a * i12 + M.b * i22), M.a * i12 * i12 + 2 * M.b * i12 * i22 + M.c * i22 * i22};
  }

private:
  AffineMap affine_;
  std::map<std::pair<double, double>, Vec2> exact_;
};

} // namespace tesscadio
