// The C API of cad-geom's WebAssembly module (dist/cad_geom.mjs, build.sh's `module`), for src/index.ts: a model's
// buffer copied in once (cg_model_new takes a buffer the caller malloc'd and owns it from then on), its curves and
// surfaces made on first use per row and kept, and every query over a batch (parameters or points in, typed arrays
// out), since the corpus checks call it millions of times. Statuses and certainties are result.h's codes, one byte
// each. Lists of varying length (breaks, singular parameters, alternatives) go to one scratch array of doubles,
// valid until the next call that writes it (cg_scratch, cg_scratch_size).
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <vector>

#include "cad_geom/curve.h"
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
