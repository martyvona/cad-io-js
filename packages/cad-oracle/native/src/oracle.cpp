// The oracle (oracle.h): the model's views, edge lengths and perimeters, and each face sent to its method by its
// surface's kind. Areas: area_closed.cpp (the elementary surfaces), area_swept.cpp (extrusions and revolutions).

#include "cad_oracle/oracle.h"

#include <cmath>
#include <cstdlib>
#include <cstring>

#include "geom_api.h"
#include "oracle_impl.h"

namespace cadoracle {

using cadgeom::makeCurve;

Oracle::Impl::Impl(const uint8_t* buf, size_t size, Options o) : model(buf, size), options(o) {
  if (!model.ok()) return;
  // The face API takes ownership of a malloc'd copy.
  auto* copy = static_cast<uint8_t*>(std::malloc(size ? size : 1));
  if (!copy) return;
  std::memcpy(copy, buf, size);
  h = cg_model_new(copy, static_cast<uint32_t>(size));
  curves_.resize(model.curves());
  made_.assign(model.curves(), 0);
  lengths_.assign(model.edges(), Estimate{NAN, INFINITY, Status::unsupported});
  lengths_done_.assign(model.edges(), 0);
  // Loose faces: face items, unless a shell uses them.
  loose.assign(model.faces(), false);
  const int items = model.rows(CBR_ITEM_KIND), uses = model.rows(CBR_FACE_USE_FACE);
  for (int i = 0; i < items; i++) {
    const int f = model.i32(CBR_ITEM_REF)[i];
    if (model.u8(CBR_ITEM_KIND)[i] == CBR_ITEM_FACE && f >= 0 && f < model.faces()) loose[f] = true;
  }
  for (int i = 0; i < uses; i++) {
    const int f = model.i32(CBR_FACE_USE_FACE)[i];
    if (f >= 0 && f < model.faces()) loose[f] = false;
  }
}

Oracle::Impl::~Impl() {
  if (h >= 0) cg_model_free(h);
}

const Curve* Oracle::Impl::curve(int row) {
  if (row < 0 || row >= model.curves()) return nullptr;
  if (!made_[row]) {
    Status s;
    curves_[row] = makeCurve(model, row, s);
    made_[row] = 1;
  }
  return curves_[row].get();
}

bool Oracle::Impl::edgeParams(int edge, double& t0, double& t1) {
  double out[2];
  if (h < 0 || cg_edge_params(h, edge, out) != 0) return false;
  t0 = out[0], t1 = out[1];
  return std::isfinite(t0) && std::isfinite(t1);
}

Estimate Oracle::Impl::edgeLength(int e) {
  if (e < 0 || e >= model.edges()) return {NAN, INFINITY, Status::invalidModel};
  if (lengths_done_[e]) return lengths_[e];
  lengths_done_[e] = 1;
  Estimate& out = lengths_[e];
  const Curve* c = curve(model.edgeCurve(e));
  double t0, t1;
  if (!c || !edgeParams(e, t0, t1)) return out = {NAN, INFINITY, c ? Status::invalidModel : Status::unsupported};
  out = cadgeom::arcLength(*c, std::fmin(t0, t1), std::fmax(t0, t1), options.relTol);
  return out;
}

Estimate Oracle::Impl::perimeter(int f) {
  Estimate sum{0, 0, Status::ok};
  for (int l = model.faceFirstLoop(f); l < model.faceFirstLoop(f) + model.faceLoopCount(f); l++) {
    if (model.loopKind(l) != CBR_LOOP_EDGE) continue;
    for (int k = model.loopFirst(l); k < model.loopFirst(l) + model.loopCount(l); k++) {
      Estimate e = edgeLength(model.coedgeEdge(k));
      if (e.status != Status::ok && sum.status == Status::ok) sum.status = e.status;
      sum.value += e.value, sum.error += e.error;
    }
  }
  return sum;
}

const char* faceStatusWhy(int32_t code) {
  switch (code) {
    case 100: return "a coedge without a p-curve";
    case 101: return "a coedge's p-curve range not found";
    case 102: return "a p-curve's range off its domain";
    case 103: return "a projection failed";
    case static_cast<int32_t>(Status::unsupported): return "a curve or surface kind not supported";
    case static_cast<int32_t>(Status::invalidModel): return "an invalid model";
    default: return "the face API failed";
  }
}

Oracle::Oracle(const uint8_t* buf, size_t size, Options options)
  : impl_(std::make_unique<Impl>(buf, size, options)) {}
Oracle::~Oracle() = default;
bool Oracle::ok() const { return impl_->model.ok() && impl_->h >= 0; }

Estimate Oracle::edgeLength(int edge) { return impl_->edgeLength(edge); }

FaceMeasure Oracle::face(int f) {
  Impl& I = *impl_;
  FaceMeasure m;
  if (!ok() || f < 0 || f >= I.model.faces()) {
    m.area = m.perimeter = {NAN, INFINITY, Status::invalidModel};
    m.why = "no such face";
    return m;
  }
  const int s = I.model.faceSurface(f);
  const int kind = s >= 0 && s < I.model.surfaces() ? I.model.surfaceKind(s) : -1;
  switch (kind) {
    case CBR_SURFACE_PLANE:
    case CBR_SURFACE_CYLINDER:
    case CBR_SURFACE_CONE:
    case CBR_SURFACE_SPHERE:
    case CBR_SURFACE_TORUS: m = I.closedForm(f); break;
    case CBR_SURFACE_EXTRUSION:
    case CBR_SURFACE_REVOLUTION: m = I.swept(f); break;
    default:
      m.area = {NAN, INFINITY, Status::unsupported};
      m.why = "a surface kind not supported";
  }
  m.perimeter = I.perimeter(f);
  if (I.loose[f]) m.flags |= flagLoose;
  return m;
}

std::vector<Estimate> Oracle::faceIntegral(int, const Integrand& g) {
  return std::vector<Estimate>(g.components > 0 ? g.components : 0, Estimate{NAN, INFINITY, Status::unsupported});
}

} // namespace cadoracle
