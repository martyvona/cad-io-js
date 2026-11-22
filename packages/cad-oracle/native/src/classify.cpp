// Point classification's faces (oracle.h's rayFace): a line against a trimmed face, cad-geom's intersectLine on the
// face's surface as the face API closes it, each contact classified against the face's loops by the face API
// (cg_face_classify), so a ray and a mesh see one face. A crossing on the boundary within the face's tolerance is its
// own kind: the face beside it may or may not see the same crossing, so a parity count can't take it.
#include <algorithm>
#include <cmath>

#include "geom_api.h"
#include "oracle_impl.h"

namespace cadoracle {

using cadgeom::LineHit;
using cadgeom::LineIntersection;

const Surface* Oracle::Impl::faceSurface(int face) {
  if (face < 0 || face >= model.faces()) return nullptr;
  if (faceSurfaces_.empty()) faceSurfaces_.resize(model.faces()), faceSurfaceMade_.assign(model.faces(), 0);
  if (!faceSurfaceMade_[face]) {
    faceSurfaceMade_[face] = 1;
    Status st;
    std::unique_ptr<Surface> S = cadgeom::makeSurface(model, model.faceSurface(face), st);
    if (S) faceSurfaces_[face] = cadgeom::closeInFact(std::move(S), tols.face(face));
  }
  return faceSurfaces_[face].get();
}

RayFace Oracle::Impl::rayFace(int face, Vec3 o, Vec3 d, Range tr) {
  RayFace out;
  const Surface* S = h >= 0 ? faceSurface(face) : nullptr;
  if (!S) return out;
  // The face API's tolerance for the face (its own, widened by its edges'), in 3D.
  double info[8];
  if (cg_face_info(h, face, 0, info) != 0) return out;
  const double tol = info[0];
  const cadgeom::SurfaceDomain D = S->domain();
  const LineIntersection li = intersectLine(*S, o, d, tr, D.u, D.v, tol);
  if (li.status != Status::ok && li.status != Status::noConvergence) {
    out.status = li.status;
    return out;
  }
  // Classified, each at its own tolerance in 3D: the face's for crossings, widened by half a tangency's span (its
  // cluster stands for that stretch of the line) for tangencies.
  auto side = [&](cadgeom::Vec2 uv, double tol3d) {
    const double p[2] = {uv.x, uv.y};
    uint8_t sd = 0, st = 0;
    double tolUv = 0;
    if (cg_face_classify(h, face, p, 1, tol3d, &sd, &st, &tolUv) != 0 || st != 0) return -1;
    return static_cast<int>(sd);  // cadgeom::Side: in 0, out 1, on 2
  };
  const double dl = std::sqrt(dot(d, d));
  for (const LineHit& c : li.crossings) {
    const int sd = side(c.uv, tol);
    if (sd == 1) continue;
    out.hits.push_back({sd == 0 ? FaceHit::crossing : FaceHit::boundary, c.t, c.span, c.uv, c.point, c.cosine});
    // (A classification that failed is taken as the boundary: the ray can't count it.)
    if (sd < 0) out.hits.back().kind = FaceHit::boundary;
  }
  for (const LineHit& g : li.tangencies) {
    const int sd = side(g.uv, tol + 0.5 * (g.span.hi - g.span.lo) * dl);
    if (sd == 1) continue;
    out.hits.push_back({FaceHit::tangency, g.t, g.span, g.uv, g.point, g.cosine});
  }
  // A line lying in the face's surface: kept whatever the loops (rare along the rays a classification casts, and a
  // ray along it can't be counted in any case).
  for (const Range& r : li.overlaps) {
    FaceHit k;
    k.kind = FaceHit::overlap, k.t = r.lo, k.span = r, k.point = o + r.lo * d;
    out.hits.push_back(k);
  }
  std::sort(out.hits.begin(), out.hits.end(), [](const FaceHit& a, const FaceHit& b) { return a.t < b.t; });
  out.status = li.status;
  return out;
}

RayFace Oracle::rayFace(int face, Vec3 o, Vec3 d, Range tr) {
  if (!ok() || face < 0 || face >= impl_->model.faces()) {
    RayFace out;
    out.status = Status::invalidModel;
    return out;
  }
  return impl_->rayFace(face, o, d, tr);
}

} // namespace cadoracle
