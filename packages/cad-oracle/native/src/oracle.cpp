// The oracle (oracle.h): the model's views, edge lengths and perimeters, and each face sent to its method by its
// surface's kind. Areas: area_closed.cpp (the elementary surfaces), area_swept.cpp (extrusions and revolutions),
// free.cpp (B-splines, offsets, rectangular trims).

#include "cad_oracle/oracle.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

#include "cad_analysis.h"
#include "geom_api.h"
#include "oracle_impl.h"

namespace cadoracle {

using cadgeom::makeCurve;

Oracle::Impl::Impl(const uint8_t* buf, size_t size, Options o) : model(buf, size), tols(model), options(o) {
  if (!model.ok()) return;
  // The face API takes ownership of a malloc'd copy.
  auto* copy = static_cast<uint8_t*>(std::malloc(size ? size : 1));
  if (!copy) return;
  std::memcpy(copy, buf, size);
  h = cg_model_new(copy, static_cast<uint32_t>(size));
  // (Option bit 1: no projections of coedges without p-curves.)
  if (h >= 0 && !o.projectMissing) cg_model_options(h, 1);
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
  // The analysis's deviations of the p-curves healing made (an analysis of other rows ignored).
  healedDeviation.assign(model.coedges(), NAN);
  if (cba_view v[CBA_COLUMN_COUNT]; o.analysis && cba_open(o.analysis, o.analysisSize, v) == 0
      && static_cast<int>(v[CBA_COEDGE_PCURVE_FROM].count) == model.coedges()
      && static_cast<int>(v[CBA_COEDGE_DEVIATION].count) == model.coedges()) {
    for (int c = 0; c < model.coedges(); c++) {
      if (CBA_U8(v[CBA_COEDGE_PCURVE_FROM])[c] == CBA_PROVENANCE_HEALED) {
        healedDeviation[c] = CBA_F64(v[CBA_COEDGE_DEVIATION])[c];
      }
    }
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

/** Checks per span between breaks where a given p-curve's deviation is sampled, before a search around the worst. */
constexpr int kDeviationChecks = 17;

namespace {
/**
 * The worst of err over [a, b]: kDeviationChecks checks, then a golden-section search around the worst until its two
 * inner errors agree (as the face API's fits are measured: numerics_fit.cpp's spanError).
 */
template <class F> double spanWorst(double a, double b, F&& err) {
  const double step = (b - a) / (kDeviationChecks - 1);
  int best = 0;
  double w = -1;
  for (int k = 0; k < kDeviationChecks; k++) {
    const double x = err(k + 1 == kDeviationChecks ? b : a + k * step);
    if (x > w) w = x, best = k;
  }
  double l = std::fmax(a, a + (best - 1) * step), r = std::fmin(b, a + (best + 1) * step);
  const double g = 0.5 * (std::sqrt(5.0) - 1);
  double x1 = r - g * (r - l), x2 = l + g * (r - l), e1 = err(x1), e2 = err(x2);
  for (int it = 0; it < 30 && !(std::fabs(e1 - e2) <= 1e-8 * std::fmax(e1, e2)); it++) {
    if (e1 > e2) r = x2, x2 = x1, e2 = e1, x1 = r - g * (r - l), e1 = err(x1);
    else l = x1, x1 = x2, e1 = e2, x2 = l + g * (r - l), e2 = err(x2);
    w = std::fmax(w, std::fmax(e1, e2));
  }
  return w;
}
bool near(double x, double y) { return std::fabs(x - y) <= 1e-9 * (1 + std::fmax(std::fabs(x), std::fabs(y))); }
} // namespace

double Oracle::Impl::pcurveDeviation(int f, int c) {
  const int e = model.coedgeEdge(c);
  const Curve* C = curve(model.edgeCurve(e));
  double t0, t1;
  if (!C || !edgeParams(e, t0, t1)) return NAN;
  const double lo = std::fmin(t0, t1), hi = std::fmax(t0, t1);
  // The use's pieces on the face (the p-curve's parameters where each starts and ends, in the use's order): a
  // p-curve's parameter needn't be its edge's (STEP doesn't require it; a B-spline p-curve on [0, 1] under an arc).
  const int32_t np = cg_face_pieces(h, f);
  if (np <= 0) return NAN;
  std::vector<std::pair<double, double>> travel;
  for (int32_t k = 0; k < np; k++) {
    const double* q = cg_scratch() + 3 * k;
    if (static_cast<int>(q[0]) == c) travel.emplace_back(q[1], q[2]);
  }
  if (travel.empty()) return NAN;
  // The surface's domain: a p-curve's point past a side evaluated on it, as consumers evaluate it (clamped).
  double dom[6];
  if (cg_surface_info(h, model.faceSurface(f), dom) != 0) return NAN;
  bool bad = false;
  // S(p(s)): the use's p-curve as the face API takes it at its own parameter s, on the face's surface.
  const auto onSurface = [&](double s, cadgeom::Vec3& out) {
    double p[3], S[3];
    uint8_t st = 0;
    if (cg_coedge_eval(h, c, &s, 1, 0, p, &st) != 0 || st != 0) return bad = true, false;
    const double uv[2] = {std::clamp(p[0], dom[0], dom[1]), std::clamp(p[1], dom[2], dom[3])};
    if (cg_face_eval(h, f, uv, 1, 0, S, &st) != 0 || st != 0) return bad = true, false;
    out = {S[0], S[1], S[2]};
    return true;
  };
  const auto onCurve = [&](double t) {
    cadgeom::CurvePoint q;
    if (C->eval(t, 0, q) != Status::ok) bad = true;
    return q.p;
  };
  const auto dist = [](cadgeom::Vec3 a, cadgeom::Vec3 b) { return std::hypot(a.x - b.x, a.y - b.y, a.z - b.z); };
  // The spans of the p-curve's breaks over [a, b].
  const auto spans = [&](double a, double b, std::vector<double>& br) {
    const int32_t n = cg_coedge_breaks(h, c, a, b);
    if (n < 2) return bad = true, false;
    br.assign(cg_scratch(), cg_scratch() + n);
    return true;
  };
  std::vector<double> br;
  double worst = 0;
  if (travel.size() == 1 && ((near(travel[0].first, t0) && near(travel[0].second, t1))
    || (near(travel[0].first, t1) && near(travel[0].second, t0)))) {
    // The p-curve on its edge's parameter range: |S(p(t)) - C(t)| at the same t, which is at least the point's
    // distance from the curve (an upper bound where the parameterizations differ inside the range).
    if (!spans(lo, hi, br)) return NAN;
    const auto err = [&](double t) {
      cadgeom::Vec3 P;
      return onSurface(t, P) ? dist(P, onCurve(t)) : 0.0;
    };
    for (size_t s = 0; s + 1 < br.size(); s++) {
      if (br[s + 1] > br[s]) worst = std::fmax(worst, spanWorst(br[s], br[s + 1], err));
    }
    return bad ? NAN : worst;
  }
  // Else each point S(p(s)) against its nearest point on the edge's curve within the edge's range, along the use. The
  // feet must move one way along the curve (unwrapped by a period across a seam) and the use's ends meet the edge's
  // ends (their gaps counted), so the curve between them is the one the use follows; else the deviation is unknown.
  const double period = C->domain().period, tol = 1e-9 * (1 + std::fmax(std::fabs(lo), std::fabs(hi)));
  std::vector<double> feet;
  const auto err = [&](double s) {
    cadgeom::Vec3 P;
    if (!onSurface(s, P)) return 0.0;
    const cadgeom::CurveInversion v = cadgeom::invertCurve(*C, P, {lo, hi}, 1e-9);
    if (v.status != Status::ok) return bad = true, 0.0;
    return v.distance;
  };
  const auto foot = [&](double s) {
    cadgeom::Vec3 P;
    if (!onSurface(s, P)) return;
    const cadgeom::CurveInversion v = cadgeom::invertCurve(*C, P, {lo, hi}, 1e-9);
    if (v.status != Status::ok) return void(bad = true);
    double t = v.t;
    if (period > 0 && !feet.empty()) t += period * std::round((feet.back() - t) / period);
    feet.push_back(t);
  };
  cadgeom::Vec3 first, last;
  for (size_t k = 0; k < travel.size(); k++) {
    const auto [a, b] = travel[k];
    if (!spans(std::fmin(a, b), std::fmax(a, b), br)) return NAN;
    if (a > b) std::reverse(br.begin(), br.end());
    for (size_t s = 0; s + 1 < br.size(); s++) {
      if (br[s + 1] == br[s]) continue;
      worst = std::fmax(worst, spanWorst(std::fmin(br[s], br[s + 1]), std::fmax(br[s], br[s + 1]), err));
      for (int j = 0; j < kDeviationChecks; j++) foot(br[s] + (br[s + 1] - br[s]) * j / (kDeviationChecks - 1));
    }
    if (k == 0 && !onSurface(a, first)) return NAN;
    if (k + 1 == travel.size() && !onSurface(b, last)) return NAN;
  }
  if (bad || feet.size() < 2) return NAN;
  const bool up = feet.back() >= feet.front();
  for (size_t k = 1; k < feet.size(); k++) {
    if (up ? feet[k] < feet[k - 1] - tol : feet[k] > feet[k - 1] + tol) return NAN;
  }
  // The use's ends against the edge's, the use going the way its feet do.
  const cadgeom::Vec3 A = onCurve(up ? lo : hi), B = onCurve(up ? hi : lo);
  worst = std::fmax(worst, std::fmax(dist(first, A), dist(last, B)));
  return bad ? NAN : worst;
}

double Oracle::Impl::vertexGap(int e) {
  const Curve* C = curve(model.edgeCurve(e));
  double t[2];
  if (!C || !edgeParams(e, t[0], t[1])) return NAN;
  double gap = 0;
  const int v[2] = {model.edgeStart(e), model.edgeEnd(e)};
  for (int k = 0; k < 2; k++) {
    if (v[k] < 0) continue;
    cadgeom::CurvePoint q;
    if (C->eval(t[k], 0, q) != Status::ok) return NAN;
    const cadgeom::Vec3 p = model.vertexPoint(v[k]);
    gap = std::fmax(gap, std::hypot(q.p.x - p.x, q.p.y - p.y, q.p.z - p.z));
  }
  return gap;
}

double Oracle::Impl::boundary(int f, bool closedForm) {
  double sum = 0;
  for (int l = model.faceFirstLoop(f); l < model.faceFirstLoop(f) + model.faceLoopCount(f); l++) {
    if (model.loopKind(l) != CBR_LOOP_EDGE) continue;
    for (int c = model.loopFirst(l); c < model.loopFirst(l) + model.loopCount(l); c++) {
      const int e = model.coedgeEdge(c);
      // An edge without a 3D curve: its p-curve is the boundary.
      if (model.edgeCurve(e) < 0) continue;
      // How far the edge's curve misses its vertices at its ends: the boundary through the vertices (as a loop's
      // neighbours and other kernels take it) can be that far from the curve the integral follows.
      const double gap = vertexGap(e);
      double dev = NAN;
      if (closedForm) {
        // (Integrated along the edge's 3D curve: no p-curve's deviation.)
        dev = 0;
      } else if (model.coedgePcurve(c) < 0) {
        // The face API's projection (made when the face was first asked): its error, scratch[6] (putProjection).
        if (cg_coedge_project(h, c, NAN, nullptr, 0) == 0) dev = cg_scratch()[6];
      } else {
        dev = std::isfinite(healedDeviation[c]) ? healedDeviation[c] : pcurveDeviation(f, c);
      }
      const Estimate len = edgeLength(e);
      if (!std::isfinite(dev) || !std::isfinite(gap) || len.status != Status::ok) return NAN;
      sum += (dev + gap) * (len.value + len.error);
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

FaceMeasure Oracle::face(int f) { return face(f, nullptr, nullptr); }

FaceMeasure Oracle::face(int f, const Integrand& g, std::vector<Estimate>& gOut) { return face(f, &g, &gOut); }

FaceMeasure Oracle::face(int f, const Integrand* g, std::vector<Estimate>* gOut) {
  Impl& I = *impl_;
  // (g given: faceIntegral's results into *gOut from the free-form pass; elsewhere none, *gOut left empty.)
  if (g) gOut->clear();
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
    case CBR_SURFACE_TORUS:
      m = I.closedForm(f), m.boundary = m.area.status == Status::ok ? I.boundary(f, true) : NAN;
      break;
    case CBR_SURFACE_EXTRUSION:
    case CBR_SURFACE_REVOLUTION: m = I.swept(f), m.boundary = m.area.status == Status::ok ? I.boundary(f) : NAN;
      break;
    case CBR_SURFACE_BSPLINE:
    case CBR_SURFACE_OFFSET:
    case CBR_SURFACE_RECTANGULAR_TRIMMED:
      m = I.freeForm(f, g, gOut), m.boundary = m.area.status == Status::ok ? I.boundary(f) : NAN;
      break;
    default:
      m.area = {NAN, INFINITY, Status::unsupported};
      m.why = "a surface kind not supported";
  }
  m.perimeter = I.perimeter(f);
  if (I.loose[f]) m.flags |= flagLoose;
  // The boundary's error reported with the area's (FaceMeasure::boundary).
  if (std::isfinite(m.boundary)) m.area.error += m.boundary;
  return m;
}


} // namespace cadoracle
