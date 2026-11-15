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
// (vertex loops have none and are left out of nest2, their parents -1); its periods are its surface's, and a finite
// direction's width where the surface is closed in fact; its pole lines come from closed forms (a cone's apex at
// v = -r / tan(a), a sphere's v = -+pi / 2) and the domain's collapsed edges (closedAndCollapsed), until
// Surface::singularities gives them. Joints meeting in 3D within its tolerance are bridged (faceLoops). The tolerance
// in (u, v) at a point is the 3D one divided by the largest stretch of the first fundamental form there (sqrt of its
// largest eigenvalue), so every (u, v) step within it is within the 3D one: a thin cylinder's u and a large plane's
// coordinates each get their own. The 3D tolerance is the caller's where given (tol3d > 0), else the larger of the
// part's uncertainty and the face's and its edges' tolerances, else DEFAULT_TOL.
// A coedge's p-curve range is the model's, in its edge's start-to-end order (so decreasing where the edge runs
// against its curve), the use running it forward or back by its orientation. Where the model gives none (STEP
// never does), it's derived as the p-curve's parameter is defined, the edge's 3D curve's (Part 42's SURFACE_CURVE;
// brep-reference.md): the edge's range, or its vertices inverted onto its curve (a closed or periodic curve's range
// a whole period apart where its vertices meet, else the way its sense runs), then checked: the surface at the
// p-curve's ends must reach the vertices. Past the 3D tolerance (a p-curve parameterized otherwise than its curve,
// against Part 42: a B-spline fitted to a circle, say), the vertices' (u, v) are inverted onto the p-curve for its
// own parameters, taken where they land nearer (counted: cg_face_info); else the curve's, within 100 x the tolerance.
// Face statuses, besides makeCurve's and makeSurface's codes: FACE_NO_PCURVE (a coedge without a p-curve),
// FACE_NO_RANGE (no range given or derivable: no 3D curve or no vertices) and FACE_RANGE_OFF (neither the curve's
// parameters nor the p-curve's own reach the vertices).

namespace {

constexpr int32_t FACE_NO_PCURVE = 100, FACE_NO_RANGE = 101, FACE_RANGE_OFF = 102;
constexpr double DEFAULT_TOL = 1e-7;  // mm: where neither the caller nor the model gives a tolerance

struct FaceLoops {
  int32_t status = 0;
  const Surface* surface = nullptr;
  std::vector<Loop2> loops;    // one per edge loop, in the face's order
  std::vector<int> loopIndex;  // each one's index among the face's loops
  std::vector<double> travel;  // per piece of its edge loops, in order: the p-curve's parameters where it starts, ends
  std::vector<int> pieceCoedge;  // per piece, its coedge (one coedge two pieces where its use wraps: useRange)
  int faceLoops = 0;
  Periods periods;
  double tol3 = 0;
  int ownRanges = 0;  // coedges whose p-curve range is the p-curve's own (useRange), not its curve's
  std::vector<std::unique_ptr<Curve>> bridges;  // the joints' segments (faceLoops), which loops' pieces point to
};

/** A straight segment in (u, v) from a to b on [0, 1]: a bridge across a joint (faceLoops). */
class Bridge final : public Curve {
public:
  Bridge(Vec2 a, Vec2 b) : a_(a), b_(b) {}
  int dim() const override { return 2; }
  CurveDomain domain() const override { return {{0, 1}, 0}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    const Vec2 d = b_ - a_, p = a_ + t * d;
    out = {{p.x, p.y, 0}, order >= 1 ? Vec3{d.x, d.y, 0} : Vec3{}, {}};
    return t < 0 || t > 1 ? Status::outOfDomain : Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status bound(Range r, Box3& out) const override {
    const Vec2 p = a_ + r.lo * (b_ - a_), q = a_ + r.hi * (b_ - a_);
    out = {Interval::hull(p.x, q.x), Interval::hull(p.y, q.y), Interval::point(0)};
    return Status::ok;
  }
  Status derivBound(Range, int order, double& out) const override {
    out = order == 1 ? std::hypot(b_.x - a_.x, b_.y - a_.y) : 0;
    return Status::ok;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }

private:
  Vec2 a_, b_;
};

/**
 * A surface's domain edges that are one in 3D, sampled (within tol at 9 points): opposite edges of a finite,
 * non-periodic range that coincide (closed in fact, a B-spline closed but not periodic) give that direction a period,
 * the range's width, and an edge whose points coincide (a collapsed row of B-spline poles) a pole line, where Periods
 * has none there yet. Until the surfaces give their seams and singularities themselves (Surface::singularities).
 */
void closedAndCollapsed(const Surface& s, double tol, Periods& per) {
  const SurfaceDomain d = s.domain();
  auto at = [&](double u, double v) {
    SurfacePoint q;
    return s.eval(u, v, 0, q) == Status::ok ? q.p : Vec3{NAN, NAN, NAN};
  };
  auto finite = [](Range r) { return std::isfinite(r.lo) && std::isfinite(r.hi) && r.hi > r.lo; };
  for (bool isoU : {true, false}) {
    const Range fixed = isoU ? d.u : d.v, free = isoU ? d.v : d.u;
    const double period = isoU ? d.uPeriod : d.vPeriod;
    if (!finite(fixed) || !finite(free) || period > 0) continue;
    auto point = [&](double x, int k) {
      const double y = free.lo + (free.hi - free.lo) * k / 8;
      return isoU ? at(x, y) : at(y, x);
    };
    bool closed = true;
    for (int k = 0; k <= 8 && closed; k++) closed = norm(point(fixed.lo, k) - point(fixed.hi, k)) <= tol;
    if (closed) (isoU ? per.u : per.v) = fixed.hi - fixed.lo;
    std::vector<double>& poles = isoU ? per.poleU : per.poleV;
    for (double x : {fixed.lo, fixed.hi}) {
      bool collapsed = true;
      for (int k = 1; k <= 8 && collapsed; k++) collapsed = norm(point(x, k) - point(x, 0)) <= tol;
      bool known = false;
      for (double p : poles) known = known || p == x;
      if (collapsed && !known) poles.push_back(x);
    }
  }
}

/** The 3D tolerance of the coedge's edge: the larger of the part's uncertainty and the edge's, else DEFAULT_TOL. */
double edgeTolerance(const Model& m, int edge) {
  double u = m.uncertainty(), t = m.f64(CBR_EDGE_TOLERANCE)[edge];
  double best = std::isfinite(u) ? u : 0;
  if (std::isfinite(t) && t > best) best = t;
  return best > 0 ? best : DEFAULT_TOL;
}

/** The pieces' parameters at both ends, rounded the way the edge runs over a period (a closed edge a whole turn). */
void around(CurveDomain d, bool closed, bool forward, double t0, double& t1) {
  if (d.period > 0) {
    if (forward) {
      while (t1 <= t0) t1 += d.period;
      if (!closed && t1 - t0 > d.period) t1 -= d.period;
    } else {
      while (t1 >= t0) t1 -= d.period;
      if (!closed && t0 - t1 > d.period) t1 += d.period;
    }
  }
}

/**
 * The coedge's p-curve parameters at its edge's start and end (the file's comment): 0, or a face status. `own` is set
 * where they're the p-curve's own, found by inverting the vertices onto it, its curve's parameters missing them (a
 * p-curve parameterized otherwise than its curve: a B-spline fitted to a circle, say); `wrap` then nonzero where the
 * edge crosses a closed, non-periodic p-curve's ends: from t0 out through the p-curve's end its sign says (1 the
 * upper), in again from the other to t1 (a closed edge's t1 its t0).
 */
int32_t useRange(int32_t h, int c, const Surface* surface, const Periods& per, double& t0, double& t1, bool& own,
  int& wrap) {
  own = false, wrap = 0;
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
      around(d, vs == ve, forward, t0, t1);
    } else if (vs == ve && std::isfinite(d.range.lo) && std::isfinite(d.range.hi)) {
      // A closed non-periodic curve (a closed B-spline): its whole domain, the way it runs.
      t0 = forward ? d.range.lo : d.range.hi, t1 = forward ? d.range.hi : d.range.lo;
    }
  }
  // The p-curve's ends through the surface must reach the edge's vertices.
  if (vs < 0 || ve < 0) return 0;
  Status s;
  const Curve* pc = curve(h, m.coedgePcurve(c), s);
  const double tol = edgeTolerance(m, e);
  // How far the surface at the p-curve's ends lands from the vertices, the larger: infinite where it can't say, a
  // parameter outside the p-curve's domain included (an evaluation there is clamped, and may land on a vertex).
  auto reaches = [&](double a, double b) -> double {
    double off = 0;
    for (auto [t, v] : {std::pair{a, vs}, std::pair{b, ve}}) {
      CurvePoint q;
      SurfacePoint sp;
      if (pc->eval(t, 0, q) != Status::ok || surface->eval(q.p.x, q.p.y, 0, sp) != Status::ok) return INFINITY;
      const double d = norm(sp.p - m.vertexPoint(v));
      off = std::isfinite(d) ? std::max(off, d) : INFINITY;
    }
    return off;
  };
  const double curveOff = reaches(t0, t1);
  if (curveOff <= tol) return 0;
  // Else the p-curve's own parameters, where they land nearer (the curve's may still be within 100 x tol of the
  // vertices on a p-curve parameterized otherwise: a fitted B-spline's own parameters drift from the circle's).
  auto ownRange = [&](double& own0, double& own1) -> int32_t {
    // The vertices' (u, v) inverted onto the p-curve, searched for within the p-curve's own (u, v) box, doubled
    // (inversion needs a finite box; a plane's domain isn't). An unbounded p-curve (a line) is sampled over the
    // curve's parameters instead, its box widened by how far those land from the vertices (a line's p-curve may be
    // scaled otherwise than its 3D line).
    SurfaceDomain sd = surface->domain();
    CurveDomain pd = pc->domain();
    const bool bounded = std::isfinite(pd.range.lo) && std::isfinite(pd.range.hi);
    const Range sampled = bounded ? pd.range : Range{std::min(t0, t1), std::max(t0, t1)};
    if (!std::isfinite(sampled.lo) || !std::isfinite(sampled.hi)) return FACE_RANGE_OFF;
    Range bu{INFINITY, -INFINITY}, bv{INFINITY, -INFINITY};
    for (int i = 0; i <= 32; i++) {
      CurvePoint q;
      pc->eval(sampled.lo + (sampled.hi - sampled.lo) * i / 32, 0, q);
      bu = {std::min(bu.lo, q.p.x), std::max(bu.hi, q.p.x)}, bv = {std::min(bv.lo, q.p.y), std::max(bv.hi, q.p.y)};
    }
    const double pad = std::max({bu.hi - bu.lo, bv.hi - bv.lo, 1e-9, bounded ? 0 : 2 * curveOff});
    const Vec2 centre{0.5 * (bu.lo + bu.hi), 0.5 * (bv.lo + bv.hi)};
    bu = {std::max(sd.u.lo, bu.lo - pad), std::min(sd.u.hi, bu.hi + pad)};
    bv = {std::max(sd.v.lo, bv.lo - pad), std::min(sd.v.hi, bv.hi + pad)};
    if (per.u > 0) bu = sd.u;
    if (per.v > 0) bv = sd.v;
    // In a periodic direction the p-curve may lie a period or more from the surface's domain (u from 0 to -pi/4 on a
    // cylinder): the point's (u, v) is taken the whole number of periods on nearest the p-curve's box's centre.
    auto onPcurve = [&](Vec3 p, double& t) {
      SurfaceInversion uv = invertSurface(*surface, p, bu, bv, tol);
      if (uv.status != Status::ok) return false;
      auto near = [](double x, double c, double period) {
        return period > 0 ? x + period * std::round((c - x) / period) : x;
      };
      CurveInversion r = invertCurve(*pc, {near(uv.uv.x, centre.x, per.u), near(uv.uv.y, centre.y, per.v), 0}, pd.range,
        tol);
      t = r.t;
      return r.status == Status::ok;
    };
    double mid = NAN;
    if (!onPcurve(m.vertexPoint(vs), own0) || !onPcurve(m.vertexPoint(ve), own1)) return FACE_RANGE_OFF;
    // Which way the use runs on the p-curve (its parameterization may run either way): through the p-curve's
    // parameter at the 3D curve's middle between the vertices (t0, t1 its parameters there, rounded the way the edge
    // runs); without a 3D curve, or for a closed edge (its middle on both ways round), the way the edge runs on it.
    Status cs;
    const Curve* c3 = ci >= 0 ? curve(h, ci, cs) : nullptr;
    const bool forward = m.edgeSameSense(e);
    // The 3D curve's parameter a fraction f along the edge: on a closed, non-periodic curve whose t0 to t1 runs against
    // the edge, the edge crosses the curve's ends (as a p-curve's use can), and so does the fraction.
    auto along = [&](double f) {
      CurveDomain d = c3->domain();
      const bool against = forward ? t1 < t0 : t1 > t0;
      if (d.period > 0 || !against || !std::isfinite(d.range.lo) || !std::isfinite(d.range.hi)) {
        return t0 + f * (t1 - t0);
      }
      CurvePoint lo, hi;
      c3->eval(d.range.lo, 0, lo), c3->eval(d.range.hi, 0, hi);
      if (!(norm(lo.p - hi.p) <= tol)) return t0 + f * (t1 - t0);
      const double span = d.range.hi - d.range.lo, run = std::fabs(t1 - t0);
      double t = t0 + (forward ? 1 : -1) * f * (span - run);
      return t > d.range.hi ? t - span : t < d.range.lo ? t + span : t;
    };
    if (c3) {
      CurvePoint q;
      c3->eval(along(0.5), 0, q);
      if (!onPcurve(q.p, mid)) return FACE_RANGE_OFF;
    }
    if (pd.period > 0) {
      if (std::isfinite(mid) && vs != ve) {
        double a = own1, b = own1;
        around(pd, vs == ve, true, own0, a), around(pd, vs == ve, false, own0, b);
        double ma = mid;
        while (ma < own0) ma += pd.period;
        while (ma >= own0 + pd.period) ma -= pd.period;
        own1 = ma <= a ? a : b;
      } else {
        around(pd, vs == ve, forward, own0, own1);
      }
    } else if (vs == ve) {
      // A closed edge: the whole p-curve from its vertex, across the p-curve's ends where the vertex isn't at one; up
      // its parameter where the 3D curve's points a third and two thirds along come in that order going up from the
      // vertex (without a 3D curve, the way the edge runs on it).
      CurvePoint qlo, qhi, q;
      pc->eval(pd.range.lo, 0, qlo), pc->eval(pd.range.hi, 0, qhi), pc->eval(own0, 0, q);
      const bool atEnd = norm(q.p - qlo.p) <= 1e-9 * pad || norm(q.p - qhi.p) <= 1e-9 * pad;
      const double from = atEnd ? pd.range.lo : own0, span = pd.range.hi - pd.range.lo;
      bool up = forward;
      if (c3) {
        double third[2];
        for (int k = 0; k < 2; k++) {
          CurvePoint p3;
          c3->eval(along((k + 1) / 3.0), 0, p3);
          if (!onPcurve(p3.p, third[k])) return FACE_RANGE_OFF;
          third[k] = std::fmod(third[k] - from + 2 * span, span);
        }
        up = third[0] < third[1];
      }
      if (atEnd) {
        own0 = up ? pd.range.lo : pd.range.hi, own1 = up ? pd.range.hi : pd.range.lo;
      } else if (norm(qlo.p - qhi.p) <= 1e-9 * pad) {
        own1 = own0, wrap = up ? 1 : -1;
      } else {
        return FACE_RANGE_OFF;
      }
    } else if (std::isfinite(mid)) {
      // The middle off the direct way: a closed p-curve, the use across where it closes. An end at the closure is
      // either of the p-curve's ends (its vertex inverts to either): the one that puts the middle on the direct way;
      // else the use goes across, in two pieces.
      auto between = [&](double a, double b) { return std::min(a, b) <= mid && mid <= std::max(a, b); };
      CurvePoint qlo, qhi, q;
      pc->eval(pd.range.lo, 0, qlo), pc->eval(pd.range.hi, 0, qhi);
      const bool closed = norm(qlo.p - qhi.p) <= 1e-9 * pad;
      auto twin = [&](double t) {
        pc->eval(t, 0, q);
        if (!closed || !(norm(q.p - qlo.p) <= 1e-9 * pad)) return t;
        return t - pd.range.lo < pd.range.hi - t ? pd.range.hi : pd.range.lo;
      };
      if (!between(own0, own1)) {
        // (A vertex away from the closure is its own twin; the two vertices can't both be at it.)
        if (between(twin(own0), twin(own1))) own0 = twin(own0), own1 = twin(own1);
        else if (closed) wrap = own0 < own1 ? -1 : 1;
        else return FACE_RANGE_OFF;
      }
    }
    return 0;
  };
  double own0 = NAN, own1 = NAN;
  if (ownRange(own0, own1) == 0) {
    const double ownOff = reaches(own0, own1);
    if (ownOff <= 100 * tol && ownOff < curveOff) {
      t0 = own0, t1 = own1, own = true;
      return 0;
    }
  }
  wrap = 0;
  return curveOff <= 100 * tol ? 0 : FACE_RANGE_OFF;
}

double uvTolerance(const FaceLoops& f, Vec2 p);

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
  double tol = m.uncertainty();
  auto widen = [&](double t) { if (std::isfinite(t) && !(t <= tol)) tol = t; };
  widen(m.f64(CBR_FACE_TOLERANCE)[face]);
  SurfaceDomain d = out.surface->domain();
  out.periods.u = d.uPeriod, out.periods.v = d.vPeriod;
  const double* r = m.surfaceReals(m.faceSurface(face));
  if (m.surfaceKind(m.faceSurface(face)) == CBR_SURFACE_CONE) out.periods.poleV = {-r[9] / std::tan(r[10])};
  if (m.surfaceKind(m.faceSurface(face)) == CBR_SURFACE_SPHERE) out.periods.poleV = {-M_PI / 2, M_PI / 2};
  closedAndCollapsed(*out.surface, std::isfinite(tol) && tol > 0 ? tol : DEFAULT_TOL, out.periods);
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
      bool own;
      int wrap;
      int32_t rs = useRange(h, c, out.surface, out.periods, t0, t1, own, wrap);
      out.ownRanges += own;
      if (rs) {
        out.status = rs;
        return out;
      }
      // The use runs start to end forward, end to start reversed.
      const bool back = m.coedgeOrientation(c) == CBR_ORIENTATION_REVERSED;
      const double from = back ? t1 : t0, to = back ? t0 : t1;
      auto piece = [&](double a, double b) {
        loop.pieces.push_back({pc, {std::min(a, b), std::max(a, b)}, a > b});
        out.travel.insert(out.travel.end(), {a, b});
        out.pieceCoedge.push_back(c);
      };
      if (wrap) {
        // Out through one of the p-curve's ends, in again from the other (they meet); the use reversed, the other way.
        const Range d = pc->domain().range;
        const bool up = (wrap > 0) != back;
        piece(from, up ? d.hi : d.lo), piece(up ? d.lo : d.hi, to);
      } else {
        piece(from, to);
      }
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
      std::reverse(out.pieceCoedge.begin() + at, out.pieceCoedge.begin() + at + n);
      at += n;
    }
  }
  out.tol3 = tol3d > 0 ? tol3d : std::isfinite(tol) && tol > 0 ? tol : DEFAULT_TOL;
  // Joints that meet within tol3 in 3D but not within the (u, v) tolerance (which takes the surface's largest
  // stretch, so a joint apart along a less stretched direction can be off by more): bridged by a segment, as geom2d
  // would close them, but not as a gap (a pole line's joint too, the same segment geom2d would give it). Joints a
  // whole period apart (a band's closing) are geom2d's.
  for (Loop2& loop : out.loops) {
    std::vector<LoopPiece> bridged;
    const size_t n = loop.pieces.size();
    for (size_t i = 0; i < n; i++) {
      bridged.push_back(loop.pieces[i]);
      auto end = [](const LoopPiece& p, bool start) {
        CurvePoint q;
        p.curve->eval(start != p.reversed ? p.range.lo : p.range.hi, 0, q);
        return Vec2{q.p.x, q.p.y};
      };
      const Vec2 a = end(loop.pieces[i], false), b = end(loop.pieces[(i + 1) % n], true);
      Vec2 g = b - a;
      if (out.periods.u > 0) g.x -= out.periods.u * std::round(g.x / out.periods.u);
      if (out.periods.v > 0) g.y -= out.periods.v * std::round(g.y / out.periods.v);
      // (Within half the joint's (u, v) tolerance geom2d joins them itself; a bridge there would part neighbours,
      // which then touch across it.)
      if (!(std::hypot(g.x, g.y) > 0.5 * uvTolerance(out, a))) continue;
      if (g.x != b.x - a.x || g.y != b.y - a.y) continue;  // a period apart: a band's closing
      SurfacePoint qa, qb;
      if (out.surface->eval(a.x, a.y, 0, qa) != Status::ok || out.surface->eval(b.x, b.y, 0, qb) != Status::ok
        || !(norm(qa.p - qb.p) <= out.tol3))
        continue;
      out.bridges.push_back(std::make_unique<Bridge>(a, b));
      bridged.push_back({out.bridges.back().get(), {0, 1}, false});
    }
    loop.pieces = std::move(bridged);
  }
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
 * the pole lines' count, those lines (u ones, then v ones) following in the scratch as (isoU, at) pairs, and how many
 * coedges' ranges are their p-curves' own (parameterized otherwise than their curves).
 */
int32_t cg_face_info(int32_t h, int32_t face, double tol3d, double* out) {
  FaceLoops f = faceLoops(h, face, tol3d);
  if (f.status) return f.status;
  out[0] = f.tol3, out[1] = f.periods.u, out[2] = f.periods.v, out[3] = static_cast<double>(f.loops.size());
  scratch.clear();
  for (double u : f.periods.poleU) scratch.insert(scratch.end(), {1.0, u});
  for (double v : f.periods.poleV) scratch.insert(scratch.end(), {0.0, v});
  out[4] = static_cast<double>(scratch.size() / 2);
  out[5] = f.ownRanges;
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
 * The pieces as geom2d takes them, the face's edge loops' coedges in order (reversed, and each piece too, where the
 * face's sense isn't its surface's; a coedge two pieces where its use crosses its p-curve's ends): per piece its
 * coedge, the p-curve's parameters where it starts and ends (3 each) into the scratch; their count, or minus the
 * face's status. The face is on each piece's left in (u, v).
 */
int32_t cg_face_pieces(int32_t h, int32_t face) {
  FaceLoops f = faceLoops(h, face, 0);
  if (f.status) return -f.status;
  scratch.clear();
  for (size_t i = 0; i < f.pieceCoedge.size(); i++) {
    scratch.insert(scratch.end(), {static_cast<double>(f.pieceCoedge[i]), f.travel[2 * i], f.travel[2 * i + 1]});
  }
  return static_cast<int32_t>(f.pieceCoedge.size());
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

