// The C API of cad-geom's WebAssembly module (dist/cad_geom.mjs, build.sh's `module`), for src/index.ts: a model's
// buffer copied in once (cg_model_new takes a buffer the caller malloc'd and owns it from then on), its curves and
// surfaces made on first use per row and kept, and every query over a batch (parameters or points in, typed arrays
// out), since the corpus checks call it millions of times. Statuses and certainties are result.h's codes, one byte
// each. Lists of varying length (breaks, singular parameters, alternatives) go to one scratch array of doubles,
// valid until the next call that writes it (cg_scratch, cg_scratch_size).
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <vector>

#include <cmath>

#include "cad_geom/curve.h"
#include "cad_geom/geom2d.h"
#include "cad_geom/surface.h"

using namespace cadgeom;

namespace {

struct Entry {
  uint8_t* buffer;
  Model model;
  std::vector<std::unique_ptr<Curve>> curves;
  std::vector<std::unique_ptr<Surface>> surfaces;
  /** Per row: 255 not made yet, else makeCurve's (makeSurface's) status. */
  std::vector<uint8_t> curveStatus, surfaceStatus;
  Entry(uint8_t* b, uint32_t size) : buffer(b), model(b, size) {}
  ~Entry() { std::free(buffer); }
};

std::vector<std::unique_ptr<Entry>> models;
std::vector<double> scratch;

Entry* entry(int32_t h) {
  return h >= 0 && h < static_cast<int32_t>(models.size()) ? models[h].get() : nullptr;
}

const Curve* curve(int32_t h, int32_t row, Status& s) {
  Entry* e = entry(h);
  s = Status::invalidModel;
  if (!e || row < 0 || row >= e->model.curves()) return nullptr;
  if (e->curveStatus[row] == 255) {
    e->curves[row] = makeCurve(e->model, row, s);
    e->curveStatus[row] = static_cast<uint8_t>(s);
  }
  s = static_cast<Status>(e->curveStatus[row]);
  return e->curves[row].get();
}

const Surface* surface(int32_t h, int32_t row, Status& s) {
  Entry* e = entry(h);
  s = Status::invalidModel;
  if (!e || row < 0 || row >= e->model.surfaces()) return nullptr;
  if (e->surfaceStatus[row] == 255) {
    e->surfaces[row] = makeSurface(e->model, row, s);
    e->surfaceStatus[row] = static_cast<uint8_t>(s);
  }
  s = static_cast<Status>(e->surfaceStatus[row]);
  return e->surfaces[row].get();
}

void put(double* out, Vec3 v) { out[0] = v.x, out[1] = v.y, out[2] = v.z; }
void put(double* out, const Box3& b) {
  out[0] = b.x.lo, out[1] = b.x.hi, out[2] = b.y.lo, out[3] = b.y.hi, out[4] = b.z.lo, out[5] = b.z.hi;
}

} // namespace

extern "C" {

/** The format's version of this API, for the TypeScript layer to check. */
int32_t cg_api_version() { return 1; }

/**
 * A model from `size` bytes at `buffer` (from malloc; owned by the model from now on, freed by cg_model_free or
 * here if it isn't a model): its handle, or -1 if the bytes aren't a B-rep buffer.
 */
int32_t cg_model_new(uint8_t* buffer, uint32_t size) {
  auto e = std::make_unique<Entry>(buffer, size);
  if (!e->model.ok()) return -1;
  e->curves.resize(e->model.curves());
  e->curveStatus.assign(e->model.curves(), 255);
  e->surfaces.resize(e->model.surfaces());
  e->surfaceStatus.assign(e->model.surfaces(), 255);
  for (size_t i = 0; i < models.size(); i++)
    if (!models[i]) {
      models[i] = std::move(e);
      return static_cast<int32_t>(i);
    }
  models.push_back(std::move(e));
  return static_cast<int32_t>(models.size() - 1);
}

void cg_model_free(int32_t h) {
  if (entry(h)) models[h].reset();
}

int32_t cg_model_curves(int32_t h) { return entry(h) ? entry(h)->model.curves() : -1; }
int32_t cg_model_surfaces(int32_t h) { return entry(h) ? entry(h)->model.surfaces() : -1; }

double* cg_scratch() { return scratch.data(); }
int32_t cg_scratch_size() { return static_cast<int32_t>(scratch.size()); }

// -- Curves. Each returns the row's makeCurve status where the curve can't be made (nothing written then).

/** makeCurve's status for the row; its dim (2 or 3) and domain (lo, hi, period) into out[0..3]. */
int32_t cg_curve_info(int32_t h, int32_t row, double* out) {
  Status s;
  const Curve* c = curve(h, row, s);
  if (!c) return static_cast<int32_t>(s);
  CurveDomain d = c->domain();
  out[0] = c->dim(), out[1] = d.range.lo, out[2] = d.range.hi, out[3] = d.period;
  return 0;
}

/** C(t) and derivatives to `order` at n parameters: out n x (order + 1) x 3, status n. */
int32_t cg_curve_eval(int32_t h, int32_t row, const double* t, int32_t n, int32_t order, double* out,
  uint8_t* status) {
  Status s;
  const Curve* c = curve(h, row, s);
  if (!c) return static_cast<int32_t>(s);
  int w = 3 * (order + 1);
  for (int32_t i = 0; i < n; i++) {
    CurvePoint q;
    status[i] = static_cast<uint8_t>(c->eval(t[i], order, q));
    put(out + i * w, q.p);
    if (order >= 1) put(out + i * w + 3, q.d1);
    if (order >= 2) put(out + i * w + 6, q.d2);
  }
  return 0;
}

/** The breaks in [lo, hi] (curve.h) into the scratch; its count, or minus the status where there's no curve. */
int32_t cg_curve_breaks(int32_t h, int32_t row, double lo, double hi) {
  Status s;
  const Curve* c = curve(h, row, s);
  if (!c) return -static_cast<int32_t>(s);
  c->breaks({lo, hi}, scratch);
  return static_cast<int32_t>(scratch.size());
}

/** The speed's zeros in [lo, hi] into the scratch, as cg_curve_breaks. */
int32_t cg_curve_singular(int32_t h, int32_t row, double lo, double hi) {
  Status s;
  const Curve* c = curve(h, row, s);
  if (!c) return -static_cast<int32_t>(s);
  c->singular({lo, hi}, scratch);
  return static_cast<int32_t>(scratch.size());
}

/** bound() over each of n ranges (lo, hi pairs): out n x 6 (x lo, x hi, y lo, ...), status n. */
int32_t cg_curve_bound(int32_t h, int32_t row, const double* ranges, int32_t n, double* out, uint8_t* status) {
  Status s;
  const Curve* c = curve(h, row, s);
  if (!c) return static_cast<int32_t>(s);
  for (int32_t i = 0; i < n; i++) {
    Box3 b;
    status[i] = static_cast<uint8_t>(c->bound({ranges[2 * i], ranges[2 * i + 1]}, b));
    put(out + 6 * i, b);
  }
  return 0;
}

/** derivBound(order) over each of n ranges: out n, status n. */
int32_t cg_curve_deriv_bound(int32_t h, int32_t row, const double* ranges, int32_t n, int32_t order, double* out,
  uint8_t* status) {
  Status s;
  const Curve* c = curve(h, row, s);
  if (!c) return static_cast<int32_t>(s);
  for (int32_t i = 0; i < n; i++) {
    out[i] = 0;
    status[i] = static_cast<uint8_t>(c->derivBound({ranges[2 * i], ranges[2 * i + 1]}, order, out[i]));
  }
  return 0;
}

/**
 * invertCurve for n points (n x 3) over [lo, hi] within tol: t, distance and status n, foot n x 3, certainty n,
 * alternatives' counts n and onSeam n; the alternatives themselves, point by point, into the scratch.
 */
int32_t cg_curve_invert(int32_t h, int32_t row, const double* points, int32_t n, double lo, double hi, double tol,
  double* t, double* distance, double* foot, uint8_t* status, uint8_t* certainty, int32_t* alternatives,
  uint8_t* onSeam) {
  Status s;
  const Curve* c = curve(h, row, s);
  if (!c) return static_cast<int32_t>(s);
  scratch.clear();
  for (int32_t i = 0; i < n; i++) {
    CurveInversion r = invertCurve(*c, {points[3 * i], points[3 * i + 1], points[3 * i + 2]}, {lo, hi}, tol);
    t[i] = r.t, distance[i] = r.distance;
    put(foot + 3 * i, r.foot);
    status[i] = static_cast<uint8_t>(r.status), certainty[i] = static_cast<uint8_t>(r.certainty);
    alternatives[i] = static_cast<int32_t>(r.alternatives.size());
    onSeam[i] = r.onSeam;
    scratch.insert(scratch.end(), r.alternatives.begin(), r.alternatives.end());
  }
  return 0;
}

/** arcLength over n ranges (t0, t1 pairs) at relTol: value, error and status n. */
int32_t cg_curve_length(int32_t h, int32_t row, const double* ranges, int32_t n, double relTol, double* value,
  double* error, uint8_t* status) {
  Status s;
  const Curve* c = curve(h, row, s);
  if (!c) return static_cast<int32_t>(s);
  for (int32_t i = 0; i < n; i++) {
    Estimate e = arcLength(*c, ranges[2 * i], ranges[2 * i + 1], relTol);
    value[i] = e.value, error[i] = e.error, status[i] = static_cast<uint8_t>(e.status);
  }
  return 0;
}

/** paramAtLength from t0[i] by length[i] at relTol: value, error and status n. */
int32_t cg_curve_param_at_length(int32_t h, int32_t row, const double* t0, const double* length, int32_t n,
  double relTol, double* value, double* error, uint8_t* status) {
  Status s;
  const Curve* c = curve(h, row, s);
  if (!c) return static_cast<int32_t>(s);
  for (int32_t i = 0; i < n; i++) {
    Estimate e = paramAtLength(*c, t0[i], length[i], relTol);
    value[i] = e.value, error[i] = e.error, status[i] = static_cast<uint8_t>(e.status);
  }
  return 0;
}

// -- Surfaces, as the curves.

/** makeSurface's status; the domain (u lo, u hi, v lo, v hi, u period, v period) into out[0..5]. */
int32_t cg_surface_info(int32_t h, int32_t row, double* out) {
  Status s;
  const Surface* f = surface(h, row, s);
  if (!f) return static_cast<int32_t>(s);
  SurfaceDomain d = f->domain();
  out[0] = d.u.lo, out[1] = d.u.hi, out[2] = d.v.lo, out[3] = d.v.hi, out[4] = d.uPeriod, out[5] = d.vPeriod;
  return 0;
}

/**
 * S(u, v) and partials to `order` at n (u, v) pairs: out n x w x 3, w 1, 3 or 6 by order (p; du, dv; duu, duv, dvv),
 * status n.
 */
int32_t cg_surface_eval(int32_t h, int32_t row, const double* uv, int32_t n, int32_t order, double* out,
  uint8_t* status) {
  Status s;
  const Surface* f = surface(h, row, s);
  if (!f) return static_cast<int32_t>(s);
  int w = order == 0 ? 1 : order == 1 ? 3 : 6;
  for (int32_t i = 0; i < n; i++) {
    SurfacePoint q;
    status[i] = static_cast<uint8_t>(f->eval(uv[2 * i], uv[2 * i + 1], order, q));
    double* o = out + 3 * w * i;
    put(o, q.p);
    if (order >= 1) put(o + 3, q.du), put(o + 6, q.dv);
    if (order >= 2) put(o + 9, q.duu), put(o + 12, q.duv), put(o + 15, q.dvv);
  }
  return 0;
}

/** The unit normal at n (u, v) pairs: out n x 3, status n. */
int32_t cg_surface_normal(int32_t h, int32_t row, const double* uv, int32_t n, double* out, uint8_t* status) {
  Status s;
  const Surface* f = surface(h, row, s);
  if (!f) return static_cast<int32_t>(s);
  for (int32_t i = 0; i < n; i++) {
    Vec3 v;
    status[i] = static_cast<uint8_t>(f->normal(uv[2 * i], uv[2 * i + 1], v));
    put(out + 3 * i, v);
  }
  return 0;
}

/** bound() over each of n boxes (u lo, u hi, v lo, v hi): out n x 6, status n. */
int32_t cg_surface_bound(int32_t h, int32_t row, const double* boxes, int32_t n, double* out, uint8_t* status) {
  Status s;
  const Surface* f = surface(h, row, s);
  if (!f) return static_cast<int32_t>(s);
  for (int32_t i = 0; i < n; i++) {
    const double* b = boxes + 4 * i;
    Box3 r;
    status[i] = static_cast<uint8_t>(f->bound({b[0], b[1]}, {b[2], b[3]}, r));
    put(out + 6 * i, r);
  }
  return 0;
}

/** derivBound(order) over each of n boxes: out n x 3 (order + 1 of them used), status n. */
int32_t cg_surface_deriv_bound(int32_t h, int32_t row, const double* boxes, int32_t n, int32_t order, double* out,
  uint8_t* status) {
  Status s;
  const Surface* f = surface(h, row, s);
  if (!f) return static_cast<int32_t>(s);
  for (int32_t i = 0; i < n; i++) {
    const double* b = boxes + 4 * i;
    double* o = out + 3 * i;
    o[0] = o[1] = o[2] = 0;
    status[i] = static_cast<uint8_t>(f->derivBound({b[0], b[1]}, {b[2], b[3]}, order, o));
  }
  return 0;
}

/** The singularities into the scratch, 6 each (kind, isoU, at, point); their count, or minus the status. */
int32_t cg_surface_singularities(int32_t h, int32_t row) {
  Status s;
  const Surface* f = surface(h, row, s);
  if (!f) return -static_cast<int32_t>(s);
  std::vector<Singularity> v;
  f->singularities(v);
  scratch.clear();
  for (const Singularity& g : v)
    scratch.insert(scratch.end(), {double(g.kind), g.isoU ? 1.0 : 0.0, g.at, g.point.x, g.point.y, g.point.z});
  return static_cast<int32_t>(v.size());
}

/**
 * invertSurface for n points over the box (u lo, u hi, v lo, v hi) within tol: uv n x 2, distance and status n,
 * foot n x 3, certainty n, alternatives' counts n, flags n (1 onSeamU, 2 onSeamV, 4 atSingularity); the alternatives'
 * (u, v), point by point, into the scratch.
 */
int32_t cg_surface_invert(int32_t h, int32_t row, const double* points, int32_t n, const double* box, double tol,
  double* uv, double* distance, double* foot, uint8_t* status, uint8_t* certainty, int32_t* alternatives,
  uint8_t* flags) {
  Status s;
  const Surface* f = surface(h, row, s);
  if (!f) return static_cast<int32_t>(s);
  scratch.clear();
  for (int32_t i = 0; i < n; i++) {
    SurfaceInversion r = invertSurface(*f, {points[3 * i], points[3 * i + 1], points[3 * i + 2]}, {box[0], box[1]},
      {box[2], box[3]}, tol);
    uv[2 * i] = r.uv.x, uv[2 * i + 1] = r.uv.y, distance[i] = r.distance;
    put(foot + 3 * i, r.foot);
    status[i] = static_cast<uint8_t>(r.status), certainty[i] = static_cast<uint8_t>(r.certainty);
    alternatives[i] = static_cast<int32_t>(r.alternatives.size());
    flags[i] = (r.onSeamU ? 1 : 0) | (r.onSeamV ? 2 : 0) | (r.atSingularity ? 4 : 0);
    for (Vec2 a : r.alternatives) scratch.push_back(a.x), scratch.push_back(a.y);
  }
  return 0;
}

} // extern "C"

// -- Faces: 2D geometry on a face's loops in its surface's (u, v) (geom2d.h). A face's loops are its coedges' p-curves
// (vertex loops have none and are left out of nest2, their parents -1); its periods are its surface's, and its pole
// lines come from closed forms (a cone's apex at v = -r / tan(a), a sphere's v = -+pi / 2) until Surface::singularities
// gives them. The tolerance in (u, v) at a point is the 3D one divided by the largest stretch of the first fundamental
// form there (sqrt of its largest eigenvalue), so every (u, v) step within it is within the 3D one: a thin cylinder's
// u and a large plane's coordinates each get their own. The 3D tolerance is the caller's where given (tol3d > 0),
// else the larger of the part's uncertainty and the face's and its edges' tolerances, else DEFAULT_TOL.
// A coedge's p-curve range is the model's, in its edge's start-to-end order (so decreasing where the edge runs
// against its curve), the use running it forward or back by its orientation. Where the model gives none (STEP
// never does), it's derived as the p-curve's parameter is defined, the edge's 3D curve's (Part 42's SURFACE_CURVE;
// brep-reference.md): the edge's range, or its vertices inverted onto its curve (a closed or periodic curve's range
// a whole period apart where its vertices meet, else the way its sense runs), then checked: the surface at the
// p-curve's ends must reach the vertices (within 100 x the 3D tolerance).
// Face statuses, besides makeCurve's and makeSurface's codes: FACE_NO_PCURVE (a coedge without a p-curve),
// FACE_NO_RANGE (no range given or derivable: no 3D curve or no vertices) and FACE_RANGE_OFF (a derived range's
// p-curve ends off the vertices: the p-curve parameterized otherwise than its curve).

namespace {

constexpr int32_t FACE_NO_PCURVE = 100, FACE_NO_RANGE = 101, FACE_RANGE_OFF = 102;
constexpr double DEFAULT_TOL = 1e-7;  // mm: where neither the caller nor the model gives a tolerance

struct FaceLoops {
  int32_t status = 0;
  const Surface* surface = nullptr;
  std::vector<Loop2> loops;    // one per edge loop, in the face's order
  std::vector<int> loopIndex;  // each one's index among the face's loops
  std::vector<double> travel;  // per coedge of its edge loops, in order: the p-curve's parameters where it starts, ends
  int faceLoops = 0;
  Periods periods;
  double tol3 = 0;
};

/** The 3D tolerance of the coedge's edge: the larger of the part's uncertainty and the edge's, else DEFAULT_TOL. */
double edgeTolerance(const Model& m, int edge) {
  double u = m.uncertainty(), t = m.f64(CBR_EDGE_TOLERANCE)[edge];
  double best = std::isfinite(u) ? u : 0;
  if (std::isfinite(t) && t > best) best = t;
  return best > 0 ? best : DEFAULT_TOL;
}

/** The coedge's p-curve parameters at its edge's start and end (the file's comment): 0, or a face status. */
int32_t useRange(int32_t h, int c, const Surface* surface, double& t0, double& t1) {
  const Model& m = entry(h)->model;
  const double* given = m.f64(CBR_COEDGE_RANGE) + 2 * c;
  if (std::isfinite(given[0]) && std::isfinite(given[1])) {
    t0 = given[0], t1 = given[1];
    return 0;
  }
  const int e = m.coedgeEdge(c), ci = m.edgeCurve(e), vs = m.edgeStart(e), ve = m.edgeEnd(e);
  Range er = m.edgeRange(e);
  if (std::isfinite(er.lo) && std::isfinite(er.hi)) {
    t0 = er.lo, t1 = er.hi;
  } else {
    if (ci < 0 || vs < 0 || ve < 0) return FACE_NO_RANGE;
    Status s;
    const Curve* c3 = curve(h, ci, s);
    if (!c3) return static_cast<int32_t>(s);
    const double tol = edgeTolerance(m, e);
    CurveDomain d = c3->domain();
    CurveInversion a = invertCurve(*c3, m.vertexPoint(vs), d.range, tol);
    CurveInversion b = vs == ve ? a : invertCurve(*c3, m.vertexPoint(ve), d.range, tol);
    if (a.status != Status::ok || b.status != Status::ok) return FACE_NO_RANGE;
    t0 = a.t, t1 = b.t;
    const bool forward = m.edgeSameSense(e);
    if (d.period > 0) {
      // Round the way the edge runs; a closed edge a whole turn.
      if (forward) {
        while (t1 <= t0) t1 += d.period;
        if (vs != ve && t1 - t0 > d.period) t1 -= d.period;
      } else {
        while (t1 >= t0) t1 -= d.period;
        if (vs != ve && t0 - t1 > d.period) t1 += d.period;
      }
    } else if (vs == ve && std::isfinite(d.range.lo) && std::isfinite(d.range.hi)) {
      // A closed non-periodic curve (a closed B-spline): its whole domain, the way it runs.
      t0 = forward ? d.range.lo : d.range.hi, t1 = forward ? d.range.hi : d.range.lo;
    }
  }
  // The p-curve's ends through the surface must reach the edge's vertices.
  if (vs >= 0 && ve >= 0) {
    Status s;
    const Curve* pc = curve(h, m.coedgePcurve(c), s);
    const double tol = edgeTolerance(m, e);
    for (auto [t, v] : {std::pair{t0, vs}, std::pair{t1, ve}}) {
      CurvePoint q;
      pc->eval(t, 0, q);
      SurfacePoint sp;
      surface->eval(q.p.x, q.p.y, 0, sp);
      if (!(norm(sp.p - m.vertexPoint(v)) <= 100 * tol)) return FACE_RANGE_OFF;
    }
  }
  return 0;
}

FaceLoops faceLoops(int32_t h, int32_t face, double tol3d) {
  FaceLoops out;
  Entry* e = entry(h);
  if (!e || face < 0 || face >= e->model.faces()) {
    out.status = static_cast<int32_t>(Status::invalidModel);
    return out;
  }
  const Model& m = e->model;
  Status s;
  out.surface = surface(h, m.faceSurface(face), s);
  if (!out.surface) {
    out.status = static_cast<int32_t>(s);
    return out;
  }
  SurfaceDomain d = out.surface->domain();
  out.periods.u = d.uPeriod, out.periods.v = d.vPeriod;
  const double* r = m.surfaceReals(m.faceSurface(face));
  if (m.surfaceKind(m.faceSurface(face)) == CBR_SURFACE_CONE) out.periods.poleV = {-r[9] / std::tan(r[10])};
  if (m.surfaceKind(m.faceSurface(face)) == CBR_SURFACE_SPHERE) out.periods.poleV = {-M_PI / 2, M_PI / 2};
  double tol = m.uncertainty();
  auto widen = [&](double t) { if (std::isfinite(t) && !(t <= tol)) tol = t; };
  widen(m.f64(CBR_FACE_TOLERANCE)[face]);
  out.faceLoops = m.faceLoopCount(face);
  for (int l = m.faceFirstLoop(face); l < m.faceFirstLoop(face) + m.faceLoopCount(face); l++) {
    if (m.loopKind(l) != CBR_LOOP_EDGE) continue;
    Loop2 loop;
    for (int c = m.loopFirst(l); c < m.loopFirst(l) + m.loopCount(l); c++) {
      widen(m.f64(CBR_EDGE_TOLERANCE)[m.coedgeEdge(c)]);
      if (m.coedgePcurve(c) < 0) {
        out.status = FACE_NO_PCURVE;
        return out;
      }
      const Curve* pc = curve(h, m.coedgePcurve(c), s);
      if (!pc) {
        out.status = static_cast<int32_t>(s);
        return out;
      }
      double t0 = NAN, t1 = NAN;  // at the edge's start and end
      int32_t rs = useRange(h, c, out.surface, t0, t1);
      if (rs) {
        out.status = rs;
        return out;
      }
      // The use runs start to end forward, end to start reversed.
      const bool back = m.coedgeOrientation(c) == CBR_ORIENTATION_REVERSED;
      const double from = back ? t1 : t0, to = back ? t0 : t1;
      loop.pieces.push_back({pc, {std::min(from, to), std::max(from, to)}, from > to});
      out.travel.insert(out.travel.end(), {from, to});
    }
    out.loops.push_back(std::move(loop));
    out.loopIndex.push_back(l - m.faceFirstLoop(face));
  }
  // geom2d takes a face's loops with the face on their left in (u, v) (outer counterclockwise). A face's loops run
  // counterclockwise about its normal, which is the surface's (S_u x S_v, counterclockwise in (u, v)) only where its
  // sense is the surface's: elsewhere they're turned round, the pieces reversed in order and each in direction.
  if (!m.faceSameSense(face)) {
    size_t at = 0;
    for (Loop2& loop : out.loops) {
      const size_t n = loop.pieces.size();
      std::reverse(loop.pieces.begin(), loop.pieces.end());
      for (LoopPiece& p : loop.pieces) p.reversed = !p.reversed;
      std::vector<double> t(out.travel.begin() + 2 * at, out.travel.begin() + 2 * (at + n));
      for (size_t i = 0; i < n; i++) {
        out.travel[2 * (at + i)] = t[2 * (n - 1 - i) + 1];
        out.travel[2 * (at + i) + 1] = t[2 * (n - 1 - i)];
      }
      at += n;
    }
  }
  out.tol3 = tol3d > 0 ? tol3d : std::isfinite(tol) && tol > 0 ? tol : DEFAULT_TOL;
  return out;
}

/** The 3D tolerance in (u, v) at a point: tol3 over the first fundamental form's largest stretch. */
double uvTolerance(const FaceLoops& f, Vec2 p) {
  SurfacePoint q;
  f.surface->eval(p.x, p.y, 1, q);
  double E = dot(q.du, q.du), F = dot(q.du, q.dv), G = dot(q.dv, q.dv);
  double stretch = std::sqrt(0.5 * (E + G) + std::sqrt(0.25 * (E - G) * (E - G) + F * F));
  return stretch > 0 && std::isfinite(stretch) ? f.tol3 / stretch : f.tol3;
}

/** A representative point of the face's loops: the first piece's start (or (0, 0) for none). */
Vec2 somePoint(const FaceLoops& f) {
  for (const Loop2& l : f.loops)
    if (!l.pieces.empty()) {
      const LoopPiece& p = l.pieces[0];
      CurvePoint q;
      p.curve->eval(p.reversed ? p.range.hi : p.range.lo, 0, q);
      return {q.p.x, q.p.y};
    }
  return {0, 0};
}

} // namespace

extern "C" {

/**
 * The face's loops as geom2d sees them: its status (0, or why not: makeCurve's or makeSurface's code,
 * FACE_NO_PCURVE, FACE_NO_RANGE); into out the 3D tolerance used, the periods (u, v), the edge loops' count, and
 * the pole lines' count, those lines (u ones, then v ones) following in the scratch as (isoU, at) pairs.
 */
int32_t cg_face_info(int32_t h, int32_t face, double tol3d, double* out) {
  FaceLoops f = faceLoops(h, face, tol3d);
  if (f.status) return f.status;
  out[0] = f.tol3, out[1] = f.periods.u, out[2] = f.periods.v, out[3] = static_cast<double>(f.loops.size());
  scratch.clear();
  for (double u : f.periods.poleU) scratch.insert(scratch.end(), {1.0, u});
  for (double v : f.periods.poleV) scratch.insert(scratch.end(), {0.0, v});
  out[4] = static_cast<double>(scratch.size() / 2);
  return 0;
}

/**
 * classify2 of n (u, v) points against the face's loops, each at its own (u, v) tolerance: sides n (0 in, 1 out,
 * 2 on) and statuses n, and the (u, v) tolerance used per point into tolUv n; the face's status as cg_face_info.
 */
int32_t cg_face_classify(int32_t h, int32_t face, const double* uv, int32_t n, double tol3d, uint8_t* sides,
  uint8_t* status, double* tolUv) {
  FaceLoops f = faceLoops(h, face, tol3d);
  if (f.status) return f.status;
  for (int32_t i = 0; i < n; i++) {
    Vec2 p{uv[2 * i], uv[2 * i + 1]};
    Status s;
    tolUv[i] = uvTolerance(f, p);
    sides[i] = static_cast<uint8_t>(classify2(f.loops, p, f.periods, tolUv[i], s));
    status[i] = static_cast<uint8_t>(s);
  }
  return 0;
}

/**
 * The pieces as geom2d takes them: per coedge of the face's edge loops, in order (reversed, and each piece too, where
 * the face's sense isn't its surface's), the p-curve's parameters where the piece starts and ends (2 each) into the
 * scratch; their count, or minus the face's status. The face is on each piece's left in (u, v).
 */
int32_t cg_face_pieces(int32_t h, int32_t face) {
  FaceLoops f = faceLoops(h, face, 0);
  if (f.status) return -f.status;
  scratch = f.travel;
  return static_cast<int32_t>(f.travel.size() / 2);
}

/**
 * nest2 on the face's edge loops: parents per face loop (indices among the face's loops; -1 outermost, and for
 * vertex loops) into parents (the face's loop count of them), nest2's status into status[0].
 */
int32_t cg_face_nest(int32_t h, int32_t face, double tol3d, int32_t* parents, uint8_t* status) {
  FaceLoops f = faceLoops(h, face, tol3d);
  if (f.status) return f.status;
  for (int i = 0; i < f.faceLoops; i++) parents[i] = -1;
  Status s;
  std::vector<int> p = nest2(f.loops, f.periods, uvTolerance(f, somePoint(f)), s);
  for (size_t i = 0; i < p.size(); i++) parents[f.loopIndex[i]] = p[i] < 0 ? -1 : f.loopIndex[p[i]];
  status[0] = static_cast<uint8_t>(s);
  return 0;
}

/**
 * selfIntersect2 on the face's loop `loop` (its index among the face's loops; a vertex loop has none): counts[0]
 * crossings, counts[1] tangencies (touches), counts[2] overlaps; the crossings' (ta, tb, u, v, tangent) into the
 * scratch, 5 each.
 */
int32_t cg_face_self(int32_t h, int32_t face, int32_t loop, double tol3d, int32_t* counts, uint8_t* status) {
  FaceLoops f = faceLoops(h, face, tol3d);
  if (f.status) return f.status;
  counts[0] = counts[1] = counts[2] = 0;
  scratch.clear();
  status[0] = 0;
  for (size_t i = 0; i < f.loops.size(); i++) {
    if (f.loopIndex[i] != loop) continue;
    Intersections2 x = selfIntersect2(f.loops[i], uvTolerance(f, somePoint(f)));
    for (const Crossing& c : x.crossings) {
      counts[c.tangent ? 1 : 0]++;
      scratch.insert(scratch.end(), {c.ta, c.tb, c.p.x, c.p.y, c.tangent ? 1.0 : 0.0});
    }
    counts[2] = static_cast<int32_t>(x.overlaps.size());
    status[0] = static_cast<uint8_t>(x.status);
  }
  return 0;
}

} // extern "C"

