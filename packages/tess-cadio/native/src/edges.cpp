// edges.h: every model edge sampled by refining its smooth spans (the curve's breaks) until each span's bounds meet
// the criteria (a span s long in parameter strays at most s^2 max |C''| / 8 from its chord and is at most s max |C'|
// long); its uses' (u, v) through their p-curves at the same parameters, else by inverting each point onto the
// surface; then each face's loops assembled in (u, v): coedges shifted by periods to join, jumps along pole lines
// filled, seam uses found by inversion placed by their neighbours, and loops that wind round a period joined by a cut
// (a pseudo-edge on an iso-line, sampled like an edge). The cuts and their crossing samples are made at construction,
// so the samples every face sees are fixed until split().
#include "tess_cadio/edges.h"

#include "tess_cadio/criteria.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <set>

#include "cad_geom/curve.h"
#include "cad_geom/project.h"
#include "cad_geom/surface.h"

namespace tesscadio {

using namespace cadgeom;

std::unique_ptr<Surface> closedSurface(const Model& m, const Tolerances& tols, int face, Status& status) {
  std::unique_ptr<Surface> s = makeSurface(m, m.faceSurface(face), status);
  if (!s) return s;
  return closeInFact(std::move(s), tols.face(face));
}

namespace {

constexpr double kInf = std::numeric_limits<double>::infinity();
/** Refinement's limits: levels of subdivision, and samples per edge (a curve whose bounds never shrink). */
constexpr int kMaxDepth = 60;
constexpr size_t kMaxSamples = 1000000;
/** Pole lines: at least this many points per period. */
constexpr int kMinPolePoints = 16;

Status worse(Status a, Status b) { return a == Status::ok ? b : a; }

/** What an edge is sampled on: its parameter to a 3D point, with bounds on its derivatives over a range. */
struct Geom {
  virtual ~Geom() = default;
  virtual Vec3 at(double t) const = 0;
  virtual Vec3 d1(double t) const = 0;
  /** An upper bound on |C^(order)| over [a, b] (order 1 or 2); infinity where none. */
  virtual double bound(double a, double b, int order) const = 0;
  /** The less smooth parameters inside (a, b), sorted. */
  virtual void breaks(double a, double b, std::vector<double>& out) const = 0;
  /** Whether the speed vanishes somewhere in [a, b] (the angle can't be bounded there). */
  virtual bool singular(double a, double b) const = 0;
};

struct CurveGeom : Geom {
  const Curve& c;
  explicit CurveGeom(const Curve& curve) : c(curve) {}
  Vec3 at(double t) const override {
    CurvePoint q;
    c.eval(t, 0, q);
    return q.p;
  }
  Vec3 d1(double t) const override {
    CurvePoint q;
    c.eval(t, 1, q);
    return q.d1;
  }
  double bound(double a, double b, int order) const override {
    double m = kInf;
    return c.derivBound({a, b}, order, m) == Status::ok && std::isfinite(m) ? m : kInf;
  }
  void breaks(double a, double b, std::vector<double>& out) const override {
    std::vector<double> all;
    c.breaks({a, b}, all);
    for (double x : all)
      if (x > a && x < b) out.push_back(x);
  }
  bool singular(double a, double b) const override {
    std::vector<double> z;
    c.singular({a, b}, z);
    return !z.empty();
  }
};

/**
 * A projected p-curve (projectCurve) as one 2D curve over the edge's parameters: its pieces, or its seam twin's
 * (the copy the use takes), the first that covers t; pole pieces left out, so at a pole the piece before it gives
 * the free coordinate (throughPoles adds the other side's). Its points clamped into the surface's range in a
 * direction that isn't periodic, as inversion's are (the projection, within tol, can stray a rounding past a side,
 * and a boundary there would be sampled again at the side). Only eval is used.
 */
struct ProjectedCurve final : Curve {
  Pcurve p;
  bool twin;
  SurfaceDomain dom;
  ProjectedCurve(Pcurve projected, bool takesTwin, SurfaceDomain domain)
    : p(std::move(projected)), twin(takesTwin), dom(domain) {}
  const std::vector<PcurvePiece>& pieces() const { return twin ? p.seamTwin : p.pieces; }
  int dim() const override { return 2; }
  CurveDomain domain() const override { return {{pieces().front().t.lo, pieces().back().t.hi}, 0}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    for (const PcurvePiece& q : pieces())
      if (q.curve && !q.poleLine && t >= q.t.lo && t <= q.t.hi) {
        const Status st = q.curve->eval(t, order, out);
        if (!(dom.uPeriod > 0)) out.p.x = std::clamp(out.p.x, dom.u.lo, dom.u.hi);
        if (!(dom.vPeriod > 0)) out.p.y = std::clamp(out.p.y, dom.v.lo, dom.v.hi);
        return st;
      }
    return Status::outOfDomain;
  }
  void breaks(Range r, std::vector<double>& out) const override {
    for (const PcurvePiece& q : pieces())
      if (q.t.lo > r.lo && q.t.lo < r.hi) out.push_back(q.t.lo);
  }
  Status bound(Range, Box3&) const override { return Status::unsupported; }
  Status derivBound(Range, int, double&) const override { return Status::unsupported; }
  void singular(Range, std::vector<double>&) const override {}
};

/** A p-curve through its surface (an edge with no 3D curve): C(t) = S(c(t)), bounded by the chain rule. */
struct ComposedGeom : Geom {
  const Surface& s;
  const Curve& pc;
  ComposedGeom(const Surface& surface, const Curve& pcurve) : s(surface), pc(pcurve) {}
  SurfacePoint eval(double t, int order, Vec2& d) const {
    CurvePoint q;
    pc.eval(t, order, q);
    SurfacePoint p;
    s.eval(q.p.x, q.p.y, order, p);
    d = {q.d1.x, q.d1.y};
    return p;
  }
  Vec3 at(double t) const override {
    Vec2 d;
    return eval(t, 0, d).p;
  }
  Vec3 d1(double t) const override {
    Vec2 d;
    SurfacePoint p = eval(t, 1, d);
    return d.x * p.du + d.y * p.dv;
  }
  double bound(double a, double b, int order) const override {
    Box3 box;
    double c1 = kInf, c2 = kInf, o1[3] = {kInf, kInf, kInf}, o2[3] = {kInf, kInf, kInf};
    if (pc.bound({a, b}, box) != Status::ok || pc.derivBound({a, b}, 1, c1) != Status::ok) return kInf;
    Range ru{box.x.lo, box.x.hi}, rv{box.y.lo, box.y.hi};
    if (s.derivBound(ru, rv, 1, o1) != Status::ok) return kInf;
    double first = (o1[0] + o1[1]) * c1;
    if (order == 1) return std::isfinite(first) ? first : kInf;
    if (pc.derivBound({a, b}, 2, c2) != Status::ok || s.derivBound(ru, rv, 2, o2) != Status::ok) return kInf;
    double second = (o2[0] + 2 * o2[1] + o2[2]) * c1 * c1 + (o1[0] + o1[1]) * c2;
    return std::isfinite(second) ? second : kInf;
  }
  void breaks(double a, double b, std::vector<double>& out) const override {
    std::vector<double> all;
    pc.breaks({a, b}, all);
    for (double x : all)
      if (x > a && x < b) out.push_back(x);
  }
  bool singular(double a, double b) const override {
    std::vector<double> z;
    pc.singular({a, b}, z);
    return !z.empty();
  }
};

/** A surface's iso-line (a cut): coordinate `free` runs as the parameter, the other fixed at `fixed`. */
struct IsoGeom : Geom {
  const Surface& s;
  int free;
  double fixed;
  IsoGeom(const Surface& surface, int f, double x) : s(surface), free(f), fixed(x) {}
  Vec2 uv(double t) const { return free == 1 ? Vec2{fixed, t} : Vec2{t, fixed}; }
  Vec3 at(double t) const override {
    SurfacePoint p;
    Vec2 q = uv(t);
    s.eval(q.x, q.y, 0, p);
    return p.p;
  }
  Vec3 d1(double t) const override {
    SurfacePoint p;
    Vec2 q = uv(t);
    s.eval(q.x, q.y, 1, p);
    return free == 1 ? p.dv : p.du;
  }
  double bound(double a, double b, int order) const override {
    Range rf{a, b}, rx{fixed, fixed};
    double o[3] = {kInf, kInf, kInf};
    if (s.derivBound(free == 1 ? rx : rf, free == 1 ? rf : rx, order, o) == Status::ok) {
      double m = order == 1 ? o[free] : (free == 1 ? o[2] : o[0]);
      if (std::isfinite(m)) return m;
    }
    return kInf;
  }
  void breaks(double a, double b, std::vector<double>& out) const override {
    std::vector<double> us, vs;
    Range rf{a, b}, rx{fixed, fixed};
    s.breaks(free == 1 ? rx : rf, free == 1 ? rf : rx, us, vs);
    for (double x : free == 1 ? vs : us)
      if (x > a && x < b) out.push_back(x);
  }
  bool singular(double, double) const override { return false; }
};

struct Criteria {
  double deflection, angle, spacing;
  /**
   * A span whose length bound is at most this (the refinement floor, criteria.h) is never refined by the sampler:
   * near a zero-speed point the curve doesn't report as singular the angle's speed bound shrinks towards 0, and
   * samples would pile up there until they coincide.
   */
  double floor = 0;
};

/**
 * The samples after a through b (a < b) appended, every span meeting the criteria by the bounds: split into as many
 * equal pieces as the bounds say (at least 2) and each checked again, since a piece's bounds are tighter. False where
 * the depth or the sample cap ran out (the span kept as it is).
 */
/** Tangents a span's turn is sampled at to choose its pieces' count (its check is by the bound). */
constexpr int kTurnSamples = 8;

bool refine(const Geom& g, double a, double b, const Criteria& k, std::vector<double>& out, int depth) {
  double s = b - a, m1 = g.bound(a, b, 1), m2 = g.bound(a, b, 2);
  if (std::isfinite(m1) && s * m1 <= k.floor) {
    out.push_back(b);
    return true;
  }
  bool ok = std::isfinite(m2) && s * s * m2 / 8 <= k.deflection &&
    (k.spacing == kInf || (std::isfinite(m1) && s * m1 <= k.spacing));
  // The turn across the span: every C'(t) lies within r = s m2 / 2 of C'(mid), so any two tangents are within
  // 2 asin(r / |C'(mid)|) of one another.
  double turnRoom = 0;
  if (k.angle > 0 && std::isfinite(m2) && s * m2 > 0) {
    turnRoom = 2 * norm(g.d1(a + s / 2)) * std::sin(k.angle / 2);
    ok = ok && (s * m2 <= turnRoom || g.singular(a, b));
  }
  if (ok) {
    out.push_back(b);
    return true;
  }
  if (depth >= kMaxDepth || out.size() > kMaxSamples) {
    out.push_back(b);
    return false;
  }
  double n = 2;
  if (std::isfinite(m2) && m2 > 0) n = std::max(n, std::ceil(s * std::sqrt(m2 / (8 * k.deflection))));
  if (k.spacing < kInf && std::isfinite(m1)) n = std::max(n, std::ceil(s * m1 / k.spacing));
  // As many pieces as the turn asks for (where the speed nearly vanishes the room is tiny and would ask for 64 at
  // once: the floor below caps it). The count by the tangents' turn as sampled where the
  // bound's is more (a B-spline's bound over a long span is loose: its pieces, bounded again, pass far sooner), with
  // a tenth to spare so an arc's pieces pass at once; the pieces are checked by the bound in any case.
  if (turnRoom > 0) {
    double turnN = std::ceil(s * m2 / turnRoom), seen = 0;
    Vec3 t0 = g.d1(a);
    for (int i = 1; i <= kTurnSamples; i++) {
      Vec3 t1 = g.d1(a + s * i / kTurnSamples);
      seen += std::atan2(norm(cross(t0, t1)), dot(t0, t1));
      t0 = t1;
    }
    turnN = std::min(turnN, std::ceil(seen / (0.9 * k.angle)));
    n = std::max(n, turnN);
  }
  // No more pieces than bring their length bounds to the floor (at least two still): the fewest within it, so they
  // stop there rather than land just over it and halve.
  if (k.floor > 0 && std::isfinite(m1)) n = std::min(n, std::max(2.0, std::ceil(s * m1 / k.floor)));
  int pieces = static_cast<int>(std::min(n, 64.0));
  // Equal pieces, but no cut within a tenth of the floor (the tolerance) of the last kept or of b: where the speed
  // nearly vanishes, equal parameter steps make chords far shorter than the pieces' bounds.
  std::vector<double> cuts{a};
  Vec3 kept = g.at(a), end = g.at(b);
  for (int i = 1; i < pieces; i++) {
    double x = a + s * i / pieces;
    Vec3 p = g.at(x);
    if (k.floor > 0 && (norm(p - kept) < 0.1 * k.floor || norm(end - p) < 0.1 * k.floor)) continue;
    cuts.push_back(x);
    kept = p;
  }
  if (cuts.size() == 1) cuts.push_back(a + s / 2);  // (some cut, so the pieces shrink)
  cuts.push_back(b);
  bool all = true;
  for (size_t i = 0; i + 1 < cuts.size(); i++) all = refine(g, cuts[i], cuts[i + 1], k, out, depth + 1) && all;
  return all;
}

/** Parameters from t0 to t1 (either way round), each span within the criteria; a closed edge in at least 3 spans. */
std::vector<double> sample(const Geom& g, double t0, double t1, bool closed, const Criteria& k, Status& status) {
  double lo = std::min(t0, t1), hi = std::max(t0, t1);
  std::vector<double> cuts;
  g.breaks(lo, hi, cuts);
  if (closed) cuts.insert(cuts.end(), {lo + (hi - lo) / 3, lo + 2 * (hi - lo) / 3});
  std::sort(cuts.begin(), cuts.end());
  // A break at the last kept one or at the range's end in 3D, within the coordinates' rounding, is that point: a
  // B-spline's knot 1e-13 from where its vertex inverts (LMP1 #505096's, 3e-14 off) would make a span of rounding,
  // a spike in (u, v) that refinement beside it runs into.
  const Vec3 end = g.at(hi);
  auto one = [](Vec3 x, Vec3 y) { return norm(x - y) <= 1e-12 * (1 + std::fmax(norm(x), norm(y))); };
  std::vector<double> t{lo};
  bool ok = true;
  double a = lo;
  Vec3 pa = g.at(lo);
  for (double b : cuts) {
    if (!(b > a) || !(b < hi)) continue;
    const Vec3 pb = g.at(b);
    if (one(pb, pa) || one(pb, end)) continue;
    ok = refine(g, a, b, k, t, 0) && ok;
    a = b, pa = pb;
  }
  if (hi > a) ok = refine(g, a, hi, k, t, 0) && ok;
  status = ok ? Status::ok : Status::noConvergence;
  if (t0 > t1) std::reverse(t.begin(), t.end());
  return t;
}

/** x shifted by a whole number of periods to be nearest `to` (period 0: unchanged). */
/** A projected p-curve for meshing within this times the deflection of its feet, where the curve allows. */
constexpr double kMeshTolerance = 0.05;

double nearest(double x, double to, double period) {
  return period > 0 ? x + std::round((to - x) / period) * period : x;
}

} // namespace

struct EdgeMesh::Impl {
  const Model& m;
  EdgeOptions o;
  double tol;
  int nModel = 0;
  ProjectionCounts projections;

  struct Edge {
    std::unique_ptr<Curve> curve;   // its 3D curve, or the p-curve it's sampled through
    std::unique_ptr<Geom> geom;
    bool closed = false;
    int start = -1, end = -1;       // vertices (model edges)
    double spacing = kInf;
    std::vector<int> coedges;
    std::vector<Range> rings;  // spans kept empty (cutRings): parameter ranges, low to high
    // A pseudo-edge's: its face, the cut's fixed coordinate (dim 1 - free) and its end points.
    int face = -1, free = 1;
    double fixed = 0;
    Vec3 ends[2];
    // A model edge with no 3D curve: sampled through its first use's p-curve (on `face`), that use's range if the
    // edge has none.
    bool pcurveOnly = false;
    Range useRange{NAN, NAN};
    EdgeSamples s;
  };
  struct Coedge {
    std::unique_ptr<Curve> pcurve;
    int face = -1;
    bool ambiguous[2] = {false, false};  // by inversion and wholly on a seam in u (v): its side in question
    bool pcurveOff = false;              // its p-curve parameterized otherwise than its edge's curve: by inversion
    bool projected = false;              // its p-curve projected from its edge's curve (the model gives none)
    double projectedTol = 0;             // the 3D distance its projection was made within
    bool atVertex[2] = {false, false};   // a projected use's vertices' feet (its edge's start, end), where found
    int seamDir = -1;                    // a projected use on a seam in u (0) or v (1), its copy by the rule
    Vec2 vertexUv[2];
    std::map<double, SurfaceInversion> inverted;  // by edge parameter: each sample inverted once
    CoedgeSamples s;
  };
  struct Crossing {
    int edge = -1;   // the sample's edge and parameter (found again by parameter after splits), or -1: the pole
    double t = 0;
  };
  struct Face {
    std::unique_ptr<Surface> s;
    SurfaceDomain dom;
    double period[2] = {0, 0}, lo[2] = {0, 0};
    std::vector<Singularity> sing;
    double spacing = kInf;
    int polePerPeriod = kMinPolePoints;
    // The cut, where its loops wind: the period's direction d, the fixed value, the pseudo-edge, the loops it joins
    // (loop rows; -1 for the pole), where it crosses them, the pole's singularity.
    int cutDir = -1, pseudo = -1, loopA = -1, loopB = -1, pole = -1;
    double cut = 0;
    Crossing cross[2];
    bool againstSense = false;  // a loop of it runs against its sense (Chain::againstSense)
    Status status = Status::ok;
    // A face with no edge loops: its surface's natural extent (makeNatural), its cuts' pseudo-edges: along
    // the periodic direction's cut (sphere-like: from pole to pole) and, periodic both ways, along the other's too;
    // the cuts' values; the poles at the low and high ends of the other direction (sphere-like).
    enum class Natural { none, sphere, torus, rect } natural = Natural::none;
    int natDir = 0, natPseudo[2] = {-1, -1}, natPole[2] = {-1, -1};
    double natAt[2] = {0, 0};
    // A B-spline's whole knot rectangle (Natural::rect), counterclockwise from (u0, v0): its sides bottom (v = v0),
    // right (u = u1), top (v = v1), left (u = u0), each a pseudo-edge along it (natSide) or a pole row (natSidePole);
    // a periodic direction's two sides across it the one pseudo-edge (the cut), its range from the cut a period on.
    int natSide[4] = {-1, -1, -1, -1}, natSidePole[4] = {-1, -1, -1, -1};
    double natBox[4] = {0, 0, 0, 0};  // u0, u1, v0, v1
    /** Why the status isn't ok (FaceBoundary::cause). */
    const char* why = nullptr;
  };
  std::vector<Edge> edges;
  std::vector<Coedge> coedges;
  std::vector<Face> faces;

  /** The tolerances edges and faces are judged by (cad-geom's tolerance.h, as the face API's). */
  Tolerances tols;

  Impl(const Model& model, const EdgeOptions& options) : m(model), o(options), tols(model) {
    tol = tols.part();
  }

  Criteria criteria(double spacing) const {
    return {o.deflection, o.angle, std::min(spacing, o.maxSpacing), refinementFloor(tol, o.deflection)};
  }
  double coedgeRange(int c, int j) const { return m.f64(CBR_COEDGE_RANGE)[2 * c + j]; }

  /** A point in a face's (u, v) at the surface: S(uv). */
  Vec3 surfaceAt(int f, Vec2 uv) const {
    SurfacePoint p;
    faces[f].s->eval(uv.x, uv.y, 0, p);
    return p.p;
  }
  /**
   * The foot of p on face f's surface near `start`: Gauss-Newton steps on |S - p|^2 / 2, each taken only where it
   * comes nearer, a direction that isn't periodic clamped to the domain; start itself unless the foot is within
   * `radius` of S(start) in 3D.
   */
  Vec2 localFoot(int f, Vec3 p, Vec2 start, double radius) const {
    const Face& F = faces[f];
    Vec2 x = start;
    SurfacePoint q;
    if (F.s->eval(x.x, x.y, 1, q) != Status::ok) return start;
    const Vec3 s0 = q.p;
    double best = norm(q.p - p);
    for (int it = 0; it < 16; it++) {
      Vec3 e = q.p - p;
      double gu = dot(e, q.du), gv = dot(e, q.dv), a = dot(q.du, q.du), b = dot(q.du, q.dv), c = dot(q.dv, q.dv);
      double det = a * c - b * b;
      if (!(det > 1e-12 * a * c && a > 0)) break;
      Vec2 n{x.x - (c * gu - b * gv) / det, x.y - (a * gv - b * gu) / det};
      if (!(F.period[0] > 0)) n.x = std::clamp(n.x, F.dom.u.lo, F.dom.u.hi);
      if (!(F.period[1] > 0)) n.y = std::clamp(n.y, F.dom.v.lo, F.dom.v.hi);
      SurfacePoint qn;
      if (F.s->eval(n.x, n.y, 1, qn) != Status::ok) break;
      double d = norm(qn.p - p);
      if (!(d < best)) break;
      double step = std::fabs(n.x - x.x) + std::fabs(n.y - x.y);
      x = n, q = qn, best = d;
      if (step <= 4e-16 * (1 + std::fabs(x.x) + std::fabs(x.y))) break;
    }
    return norm(q.p - s0) <= radius ? x : start;
  }

  /**
   * Face f's loops' folds repaired (FaceBoundary::foldsRepaired), counted: each point whose (u, v) corner with its
   * neighbours is convex (the loops counterclockwise) while its 3D turn about S_u x S_v there is the other way, both
   * past rounding, its (u, v) onto their chord at its share of their 3D distance where the surface is within the
   * face's tolerance of its 3D point, and from there a step towards that point where it keeps the turn its 3D one.
   * One pass in loop order, each point judged with its neighbours as they stand.
   */
  int repairFolds(int f, std::vector<std::vector<BoundaryPoint>>& loops) const {
    const Face& F = faces[f];
    const double within = tols.face(f);
    int n = 0;
    for (auto& L : loops) {
      const size_t k = L.size();
      if (k < 3) continue;
      for (size_t i = 0; i < k; i++) {
        const BoundaryPoint &A = L[(i + k - 1) % k], &C = L[(i + 1) % k];
        BoundaryPoint& B = L[i];
        if (B.kind == BoundaryPoint::poleLine) continue;
        const Vec2 ab = B.uv - A.uv, bc = C.uv - B.uv;
        const double s2 = ab.x * bc.y - ab.y * bc.x;
        if (!(s2 > 1e-12 * norm(ab) * norm(bc))) continue;
        SurfacePoint q;
        if (F.s->eval(B.uv.x, B.uv.y, 1, q) != Status::ok) continue;
        const Vec3 nn = cross(q.du, q.dv);
        if (!(norm(nn) > 0)) continue;
        const double l1 = norm(B.point - A.point), l2 = norm(C.point - B.point);
        const double s3 = dot(cross(B.point - A.point, C.point - B.point), (1 / norm(nn)) * nn);
        if (!(s3 < -1e-9 * l1 * l2)) continue;
        Vec2 to = A.uv + (l1 / (l1 + l2)) * (C.uv - A.uv);
        SurfacePoint r;
        if (F.s->eval(to.x, to.y, 1, r) != Status::ok || !(norm(r.p - B.point) <= within)) continue;
        // From the chord, one Gauss-Newton step towards the 3D point, not held to the range (its feet were clamped
        // there): its turn then as the 3D point's, where that step evaluates, keeps within the tolerance and agrees.
        const Vec3 e = B.point - r.p;
        const double a = dot(r.du, r.du), b = dot(r.du, r.dv), c = dot(r.dv, r.dv), det = a * c - b * b;
        if (det > 1e-12 * a * c && a > 0) {
          const double gu = dot(e, r.du), gv = dot(e, r.dv);
          const Vec2 step = to + Vec2{(c * gu - b * gv) / det, (a * gv - b * gu) / det};
          const Vec2 ab2 = step - A.uv, bc2 = C.uv - step;
          SurfacePoint w;
          if (F.s->eval(step.x, step.y, 0, w) == Status::ok && norm(w.p - B.point) <= within &&
            ab2.x * bc2.y - ab2.y * bc2.x < 0)
            to = step;
        }
        B.uv = to;
        n++;
      }
    }
    return n;
  }

  /**
   * Coedge c's p-curve at edge parameter t: a t outside the p-curve's own domain (not periodic) by at most 1e-9 of
   * its edge's sampled range's width is clamped onto that domain's end (a range ending a hair past a B-spline's last
   * knot: bug32314 #392624's 1.6e-9; the face API's projection clamps by the same rule), anything farther left to the
   * p-curve, which refuses it.
   */
  Status pcurveAt(int c, double t, CurvePoint& q) const {
    const Coedge& C = coedges[c];
    const CurveDomain D = C.pcurve->domain();
    const EdgeSamples& es = edges[m.coedgeEdge(c)].s;
    const double width = es.t.empty() ? 0 : std::fabs(es.t.back() - es.t.front()), slack = 1e-9 * width;
    if (!(D.period > 0)) {
      if (t < D.range.lo && D.range.lo - t <= slack) t = D.range.lo;
      if (t > D.range.hi && t - D.range.hi <= slack) t = D.range.hi;
    }
    return C.pcurve->eval(t, 0, q);
  }

  /** The singularity (pole or apex) at 3D point p, or -1. */
  int poleAt(int f, Vec3 p) const {
    const Face& F = faces[f];
    for (size_t i = 0; i < F.sing.size(); i++)
      if (F.sing[i].kind != Singularity::normalVanishes && norm(F.sing[i].point - p) <= tol)
        return static_cast<int>(i);
    return -1;
  }

  /** invertSurface over the face's domain: the result's (u, v) within the range (callers unwrap). */
  SurfaceInversion invert(int f, Vec3 p, const Vec2* hint) const {
    const Face& F = faces[f];
    return invertSurface(*F.s, p, F.dom.u, F.dom.v, tol, hint);
  }

  // ---- edges ----

  /** A model edge's range in its start-to-end order, from what's given or by inversion; false if none can be had. */
  bool edgeRange(int e, Range& r) {
    Edge& E = edges[e];
    r = m.edgeRange(e);
    if (!std::isnan(r.lo) && !std::isnan(r.hi)) return true;
    r = E.useRange;
    if (!std::isnan(r.lo) && !std::isnan(r.hi)) return true;
    const Curve* c = E.curve.get();
    if (!c) return false;
    CurveDomain dom = c->domain();
    bool sense = m.edgeSameSense(e);
    if (E.start < 0 || E.end < 0) {
      r = sense ? dom.range : Range{dom.range.hi, dom.range.lo};
      return std::isfinite(r.lo) && std::isfinite(r.hi);
    }
    double t[2];
    for (int j = 0; j < 2; j++) {
      Vec3 p = j ? m.vertexPoint(E.end) : m.vertexPoint(E.start);
      double vt = m.f64(CBR_VERTEX_TOLERANCE)[j ? E.end : E.start];
      double tl = std::max(tol, std::isfinite(vt) ? vt : 0.0);
      Range search = dom.range;
      if (E.pcurveOnly) {
        // The vertex's (u, v) on the use's surface, then its parameter on the p-curve.
        SurfaceInversion si = invert(E.face, p, nullptr);
        if (si.status != Status::ok) return false;
        p = {si.uv.x, si.uv.y, 0};
      }
      CurveInversion ci = invertCurve(*c, p, search, tl);
      if (ci.status != Status::ok || ci.certainty == Certainty::none) return false;
      t[j] = ci.t;
    }
    if (E.closed) {
      if (dom.period > 0) t[1] = t[0] + (sense ? dom.period : -dom.period);
      else t[0] = sense ? dom.range.lo : dom.range.hi, t[1] = sense ? dom.range.hi : dom.range.lo;
    } else if (dom.period > 0) {
      if (sense && t[1] <= t[0]) t[1] += dom.period;
      if (!sense && t[1] >= t[0]) t[1] -= dom.period;
    } else if (sense != (t[1] > t[0])) {
      // Against what sameSense says: on a curve that closes without a period (a closed B-spline), a vertex at its
      // junction is either end, so the end that runs the edge the way sameSense says; otherwise the vertices' order
      // stands, the flag wrong (as cad-brep's edgeParams has it).
      Vec3 a = E.geom->at(dom.range.lo), b = E.geom->at(dom.range.hi);
      if (std::isfinite(dom.range.lo) && std::isfinite(dom.range.hi) && norm(a - b) <= tol) {
        auto atEnd = [&](int v) {
          Vec3 q = m.vertexPoint(v);
          return norm(q - a) <= tol || norm(q - b) <= tol;
        };
        if (atEnd(E.end)) t[1] = sense ? dom.range.hi : dom.range.lo;
        else if (atEnd(E.start)) t[0] = sense ? dom.range.lo : dom.range.hi;
      }
    }
    r = {t[0], t[1]};
    return true;
  }

  /** An edge's points at its parameters: the vertices' (or a pseudo-edge's ends') exactly at the ends. */
  void points(int e) {
    Edge& E = edges[e];
    std::vector<Vec3>& p = E.s.points;
    p.clear();
    for (double t : E.s.t) p.push_back(E.geom->at(t));
    if (p.empty()) return;
    if (e >= nModel) {
      p.front() = E.ends[0], p.back() = E.ends[1];
    } else if (E.start >= 0 && E.end >= 0) {
      p.front() = m.vertexPoint(E.start), p.back() = m.vertexPoint(E.end);
    }
  }

  void sampleModelEdge(int e) {
    Edge& E = edges[e];
    Range r;
    if (!E.geom) {
      E.s.status = worse(E.s.status, Status::unsupported);
      return;
    }
    if (!edgeRange(e, r) || !(r.lo != r.hi)) {
      E.s.status = Status::invalidModel;
      return;
    }
    Status st;
    E.s.t = sample(*E.geom, r.lo, r.hi, E.closed, criteria(E.spacing), st);
    E.s.status = st;
    points(e);
  }

  // ---- coedges ----

  void computeCoedge(int c) {
    Coedge& C = coedges[c];
    Edge& E = edges[m.coedgeEdge(c)];
    CoedgeSamples& s = C.s;
    s = {};
    C.ambiguous[0] = C.ambiguous[1] = false;
    if (E.s.t.empty() || C.face < 0 || !faces[C.face].s) {
      s.status = E.s.t.empty() ? E.s.status : Status::unsupported;
      return;
    }
    const Face& F = faces[C.face];
    int n = static_cast<int>(E.s.t.size());
    bool reversed = m.coedgeOrientation(c) == CBR_ORIENTATION_REVERSED;
    for (int i = 0; i < n; i++) s.index.push_back(reversed ? n - 1 - i : i);
    s.status = Status::ok;
    std::vector<char> singular(n, 0), seam[2] = {std::vector<char>(n, 0), std::vector<char>(n, 0)};
    // Through the p-curve at the edge's parameters, where it lands on the edge's points: a p-curve parameterized
    // otherwise (against Part 42: its own range, a B-spline fitted to a circle) leaves its domain or misses them by
    // more than 100 x the tolerance, and is used only to seed inversion.
    std::vector<Vec2> seeds;
    C.pcurveOff = false;
    if (C.pcurve) {
      double et = m.f64(CBR_EDGE_TOLERANCE)[m.coedgeEdge(c)];
      double miss = 100 * std::max(tol, std::isfinite(et) ? et : 0.0);
      for (int i = 0; i < n && !C.pcurveOff; i++) {
        CurvePoint q;
        Status st = pcurveAt(c, E.s.t[s.index[i]], q);
        seeds.push_back({q.p.x, q.p.y});
        // (The ends are the vertices', which may miss the curve themselves: inside samples only.)
        bool end = i == 0 || i == n - 1;
        if (st != Status::ok || (!end && norm(surfaceAt(C.face, seeds.back()) - E.s.points[s.index[i]]) > miss))
          C.pcurveOff = true;
      }
      // And between the samples, at each span's quarters and middle, against the edge's own curve: a use with its
      // ends alone (no inside sample to judge by) or a long span has the p-curve checked there too (pr1db #1317's,
      // a semicircle's p-curve on a collapsed row, one point in 3D, 112 off).
      for (int i = 0; i + 1 < n && !C.pcurveOff && E.geom; i++)
        for (double f : {0.25, 0.5, 0.75}) {
          const double t = E.s.t[s.index[i]] + f * (E.s.t[s.index[i + 1]] - E.s.t[s.index[i]]);
          CurvePoint q;
          if (pcurveAt(c, t, q) != Status::ok || norm(surfaceAt(C.face, {q.p.x, q.p.y}) - E.geom->at(t)) > miss) {
            C.pcurveOff = true;
            break;
          }
        }
      if (!C.pcurveOff) {
        s.fromPcurve = true;
        s.projected = C.projected;
        s.uv = seeds;
        // A projected use's inside samples at their points' feet: the projection is within its tolerance of them,
        // not on them, and at a coarse one (an edge's, LMP1's 0.13) neighbouring samples' (u, v) can fold against
        // their order in 3D (a boundary ear turned over: #1038273's). A local Gauss-Newton from the p-curve's value,
        // kept where it comes nearer within that tolerance of it; not at a pole (its free coordinate arbitrary).
        if (C.projected)
          for (int i = 1; i + 1 < n; i++)
            if (poleAt(C.face, E.s.points[s.index[i]]) < 0)
              s.uv[i] = localFoot(C.face, E.s.points[s.index[i]], s.uv[i], C.projectedTol);
        // A projected use's vertices at their feet (the projection is within tol of them, not on them), the copy
        // its own: uses meeting there meet in (u, v), a closed edge's use closes.
        if (C.projected)
          for (int i : {0, n - 1}) {
            const int k = s.index[i] == 0 ? 0 : s.index[i] == n - 1 ? 1 : -1;
            if (k < 0 || !C.atVertex[k]) continue;
            s.uv[i] = {nearest(C.vertexUv[k].x, s.uv[i].x, F.period[0]), nearest(C.vertexUv[k].y, s.uv[i].y,
              F.period[1])};
          }
      }
    }
    if (!C.pcurve || C.pcurveOff) {
      for (int i = 0; i < n; i++) {
        Vec2 hint = i < static_cast<int>(seeds.size()) ? seeds[i] : i ? s.uv.back() : Vec2{};
        bool hinted = i < static_cast<int>(seeds.size()) || i > 0;
        // (Each sample inverted once: a split round redoes the coedge, its old samples from the cache.)
        double t = E.s.t[s.index[i]];
        auto hit = C.inverted.find(t);
        SurfaceInversion si;
        if (hit != C.inverted.end()) {
          si = hit->second;
        } else if (int p = poleAt(C.face, E.s.points[s.index[i]]); p >= 0) {
          // At a known pole, no search (its feet a continuum: slow to bound): its row, the free coordinate arbitrary
          // (the hint's), filled from a neighbour below.
          const Singularity& g = F.sing[p];
          si.status = Status::ok, si.atSingularity = true, si.foot = g.point;
          si.distance = norm(g.point - E.s.points[s.index[i]]);
          si.uv = g.isoU ? Vec2{g.at, hinted ? hint.y : F.lo[1]} : Vec2{hinted ? hint.x : F.lo[0], g.at};
          si.certainty = Certainty::unique;
        } else {
          si = invert(C.face, E.s.points[s.index[i]], hinted ? &hint : nullptr);
        }
        if (hit == C.inverted.end()) C.inverted.emplace(t, si);
        s.status = worse(s.status, si.status);
        s.uv.push_back(si.uv);
        singular[i] = si.atSingularity;
        seam[0][i] = si.onSeamU, seam[1][i] = si.onSeamV;
      }
      // Wholly on a seam, and running along it (its other coordinate varying: an edge shorter than the tolerance
      // across the seam is within it at both ends but isn't a seam use).
      for (int d = 0; d < 2; d++) {
        if (!(F.period[d] > 0)) continue;
        bool all = true, any = false;
        double lo = INFINITY, hi = -INFINITY;
        for (int i = 0; i < n; i++)
          if (!singular[i]) {
            all = all && seam[d][i], any = true;
            double w = d ? s.uv[i].x : s.uv[i].y;
            lo = std::min(lo, w), hi = std::max(hi, w);
          }
        Range other = d ? F.dom.u : F.dom.v;
        double scale = std::isfinite(other.hi - other.lo) ? other.hi - other.lo : 1;
        C.ambiguous[d] = all && any && hi - lo > 1e-9 * scale;
      }
    }
    // At a pole the free coordinate is arbitrary: the nearest regular sample's, along the coedge. A projected use's
    // samples too, at a pole by their points: an edge within the tolerance of an apex has its p-curve's value there
    // from across it, half a turn round (LMP1's spindle tori), and its loop then winds round the period.
    if (s.fromPcurve && s.projected)
      for (int i = 0; i < n; i++) singular[i] = poleAt(C.face, E.s.points[s.index[i]]) >= 0;
    if (!s.fromPcurve || s.projected)
      for (int i = 0; i < n; i++) {
        if (!singular[i]) continue;
        int j = -1;
        for (int k = 1; k < n && j < 0; k++) {
          if (i + k < n && !singular[i + k]) j = i + k;
          else if (i - k >= 0 && !singular[i - k]) j = i - k;
        }
        int p = poleAt(C.face, E.s.points[s.index[i]]);
        if (j >= 0 && p >= 0) {
          int fr = F.sing[p].isoU ? 1 : 0;
          (fr == 0 ? s.uv[i].x : s.uv[i].y) = fr == 0 ? s.uv[j].x : s.uv[j].y;
        }
      }
    // Continuous along periodic directions: each sample the copy nearest the one before. A step over a quarter
    // period goes through its span's middle instead (the p-curve's there, else its inversion), each half then
    // nearest: two samples half a period apart (a semicircle's ends alone) are a tie that rounding settles either
    // way, and the loop then winds round the period where it doesn't, or runs round the other half.
    for (int i = 1; i < n; i++) {
      Vec2 mid{NAN, NAN};
      for (int d = 0; d < 2; d++) {
        const double P = F.period[d], before = d ? s.uv[i - 1].y : s.uv[i - 1].x;
        double& x = d ? s.uv[i].y : s.uv[i].x;
        x = nearest(x, before, P);
        if (!(P > 0) || !(std::fabs(x - before) > 0.25 * P) || !E.geom) continue;
        if (std::isnan(mid.x)) {
          const double tm = 0.5 * (E.s.t[s.index[i - 1]] + E.s.t[s.index[i]]);
          CurvePoint q;
          if (s.fromPcurve && pcurveAt(c, tm, q) == Status::ok) mid = {q.p.x, q.p.y};
          else mid = invert(C.face, E.geom->at(tm), &s.uv[i - 1]).uv;
        }
        x = nearest(x, nearest(d ? mid.y : mid.x, before, P), P);
      }
    }
    if (!s.fromPcurve || s.projected) throughPoles(c);
    for (size_t i = 0; i < s.uv.size(); i++)
      s.gap = std::fmax(s.gap, norm(surfaceAt(C.face, s.uv[i]) - E.s.points[s.index[i]]));
  }

  /**
   * Which way a jump along pole p runs in face f, its other coordinate's values `mean` on average: the face to its
   * left (its sense true), so along a pole at the top of the other coordinate towards -u (+v for a pole line in v),
   * at the bottom the other way.
   */
  double jumpSignAt(int f, int p, double mean) const {
    const Face& F = faces[f];
    int fr = F.sing[p].isoU ? 1 : 0;
    bool top = F.sing[p].at > mean;
    double sgn = fr == 0 ? (top ? -1 : 1) : (top ? 1 : -1);
    return m.faceSameSense(f) ? sgn : -sgn;
  }

  /**
   * A coedge by inversion through a pole between its ends (a meridian over a sphere's pole): its sample there twice,
   * at the free coordinate on each side, the jump between them the way the face lies (jumpSignAt), the samples after
   * shifted to follow; chain() fills the pole line between the two.
   */
  void throughPoles(int c) {
    Coedge& C = coedges[c];
    CoedgeSamples& s = C.s;
    const Face& F = faces[C.face];
    const Edge& E = edges[m.coedgeEdge(c)];
    for (size_t i = 1; i + 1 < s.uv.size(); i++) {
      // (At the pole by the surface at its (u, v), as its foot is: an edge a little off its surface misses the pole.)
      int p = poleAt(C.face, E.s.points[s.index[i]]);
      if (p < 0) p = poleAt(C.face, surfaceAt(C.face, s.uv[i]));
      if (p < 0 || s.index[i - 1] == s.index[i]) continue;
      int fr = F.sing[p].isoU ? 1 : 0, other = 1 - fr;
      double P = F.period[fr];
      if (!(P > 0)) continue;
      auto at = [&](Vec2& q) -> double& { return fr ? q.y : q.x; };
      double mean = 0;
      for (const Vec2& q : s.uv) mean += other ? q.y : q.x;
      mean /= static_cast<double>(s.uv.size());
      double before = at(s.uv[i - 1]), after = at(s.uv[i + 1]), sg = jumpSignAt(C.face, p, mean);
      double delta = std::fmod((after - before) * sg, P);
      if (delta < 0) delta += P;
      if (delta < 1e-9 * P || delta > P - 1e-9 * P) continue;
      double to = before + sg * delta, shift = to - after;
      Vec2 a = s.uv[i], b = s.uv[i];
      at(a) = before, at(b) = to;
      for (size_t j = i + 1; j < s.uv.size(); j++) at(s.uv[j]) += shift;
      s.uv[i] = a;
      s.uv.insert(s.uv.begin() + static_cast<long>(i) + 1, b);
      s.index.insert(s.index.begin() + static_cast<long>(i) + 1, s.index[i]);
      i++;
    }
  }

  /**
   * A span that passes over a pole between its samples (its free coordinate jumping by over a quarter period from
   * one to the next: an edge a little off its surface whose foot is at the pole somewhere inside the span) gets a
   * sample at its point nearest the pole where that point's foot is the pole, so its loop crosses the pole line
   * there the face's way (throughPoles), not by whichever unwrapping of the jump is nearer, which flips with where
   * the samples fall.
   */
  void samplePoleCrossings() {
    std::vector<std::vector<double>> add(edges.size());
    for (int c = 0; c < m.coedges(); c++) {
      const Coedge& C = coedges[c];
      const CoedgeSamples& s = C.s;
      if (C.face < 0 || !faces[C.face].s || (s.fromPcurve && !s.projected) || s.uv.size() < 2) continue;
      const Face& F = faces[C.face];
      const Edge& E = edges[m.coedgeEdge(c)];
      if (!E.geom) continue;
      for (size_t i = 0; i + 1 < s.uv.size(); i++) {
        if (s.index[i] == s.index[i + 1]) continue;
        for (const Singularity& g : F.sing) {
          if (g.kind == Singularity::normalVanishes) continue;
          int fr = g.isoU ? 1 : 0;
          double P = F.period[fr];
          double jump = std::fabs(fr ? s.uv[i + 1].y - s.uv[i].y : s.uv[i + 1].x - s.uv[i].x);
          if (!(P > 0) || jump <= 0.25 * P) continue;
          // The point nearest the pole: golden section on the distance (one minimum near a pole).
          double a = E.s.t[s.index[i]], b = E.s.t[s.index[i + 1]];
          const double r = 0.5 * (std::sqrt(5.0) - 1);
          double x1 = b - r * (b - a), x2 = a + r * (b - a);
          double f1 = norm(E.geom->at(x1) - g.point), f2 = norm(E.geom->at(x2) - g.point);
          for (int it = 0; it < 80; it++) {
            if (f1 < f2) b = x2, x2 = x1, f2 = f1, x1 = b - r * (b - a), f1 = norm(E.geom->at(x1) - g.point);
            else a = x1, x1 = x2, f1 = f2, x2 = a + r * (b - a), f2 = norm(E.geom->at(x2) - g.point);
          }
          double t = 0.5 * (a + b);
          SurfaceInversion si = invert(C.face, E.geom->at(t), &s.uv[i]);
          if (si.status == Status::ok && poleAt(C.face, surfaceAt(C.face, si.uv)) >= 0)
            add[m.coedgeEdge(c)].push_back(t);
        }
      }
    }
    for (size_t e = 0; e < add.size(); e++) {
      if (add[e].empty()) continue;
      Edge& E = edges[e];
      bool up = E.s.t.back() > E.s.t.front();
      for (double t : add[e]) {
        size_t j = 0;
        while (j + 1 < E.s.t.size() && (up ? E.s.t[j + 1] < t : E.s.t[j + 1] > t)) j++;
        if (j + 1 >= E.s.t.size() || E.s.t[j] == t || E.s.t[j + 1] == t) continue;
        E.s.t.insert(E.s.t.begin() + static_cast<long>(j) + 1, t);
        E.s.points.insert(E.s.points.begin() + static_cast<long>(j) + 1, E.geom->at(t));
      }
      for (int c : E.coedges) computeCoedge(c);
    }
  }

  /**
   * Each use without a p-curve whose edge has a 3D curve: its curve projected onto the face's surface over the
   * edge's samples' range, within kMeshTolerance x the deflection where the curve allows, else at the edge's
   * tolerance (tols.edge, as the face API's), from and to its vertices' feet, the seam copy the use takes; where a
   * projection is ok, its p-curve, and each pole it passes through (a pole piece's parameter) a sample of the edge,
   * so the use's sample there is doubled across the pole line (throughPoles). Else by inversion. Counted in
   * `projections`.
   */
  void projectMissing() {
    for (int c = 0; c < m.coedges(); c++) {
      Coedge& C = coedges[c];
      const int e = m.coedgeEdge(c);
      Edge& E = edges[e];
      if (C.pcurve || C.face < 0 || !faces[C.face].s || !E.curve || E.pcurveOnly || E.s.t.size() < 2) continue;
      const double t0 = E.s.t.front(), t1 = E.s.t.back();
      if (!(t0 != t1)) continue;
      const PcurveSource source{&m, m.edgeCurve(e), m.faceSurface(C.face)};
      // Its ends at its vertices' feet (as inversion places them, the same point the same (u, v) up to periods),
      // so uses meeting at a vertex meet in (u, v) and a closed edge closes; not at a pole (its free coordinate the
      // projection's).
      PcurveEnds ends;
      const bool up = t1 > t0;
      for (int k = 0; k < 2; k++) {
        // (k: the edge's start, end; the projection's range runs low to high.)
        const Vec3 at = k == 0 ? E.s.points.front() : E.s.points.back();
        C.atVertex[k] = false;
        if (poleAt(C.face, at) >= 0) continue;
        const SurfaceInversion si = invert(C.face, at, nullptr);
        if (si.status != Status::ok) continue;
        C.atVertex[k] = true, C.vertexUv[k] = si.uv;
        const bool low = (k == 0) == up;
        (low ? ends.hasStart : ends.hasEnd) = true;
        (low ? ends.start : ends.end) = si.uv;
      }
      // Judged against the mesh: within kMeshTolerance x the deflection where the curve allows (a p-curve within
      // the model's tolerance but farther from its feet than that has the mesh chase the difference), else at the
      // edge's tolerance (the curve that far off its surface), else by inversion.
      const Range r{std::min(t0, t1), std::max(t0, t1)};
      const double edgeTol = tols.edge(e), tight = std::min(edgeTol, kMeshTolerance * o.deflection);
      Pcurve p = projectCurve(*E.curve, r, *faces[C.face].s, tight, &ends, &source);
      bool ok = p.status == Status::ok && !p.pieces.empty();
      double madeAt = tight;
      if (!ok && tight < edgeTol) {
        p = projectCurve(*E.curve, r, *faces[C.face].s, edgeTol, &ends, &source);
        ok = p.status == Status::ok && !p.pieces.empty();
        madeAt = edgeTol;
        if (ok) projections.atEdgeTolerance++;
      } else if (ok) {
        projections.withinMesh++;
      }
      if (!ok) {
        projections.byInversion++;
        continue;
      }
      // The use runs start to end forward, end to start reversed.
      const bool back = m.coedgeOrientation(c) == CBR_ORIENTATION_REVERSED;
      const bool twin = (p.seamU || p.seamV) && seamUseTakesTwin(p, back ? t0 > t1 : t1 > t0, m.faceSameSense(C.face));
      C.seamDir = p.seamU ? 0 : p.seamV ? 1 : -1;
      std::vector<double> poles;
      for (const PcurvePiece& q : p.pieces)
        if (q.poleLine) poles.push_back(q.t.lo);
      C.pcurve = std::make_unique<ProjectedCurve>(std::move(p), twin, faces[C.face].dom);
      C.projected = true;
      C.projectedTol = madeAt;
      for (double t : poles)
        if (t > std::min(t0, t1) && t < std::max(t0, t1)) insertSample(e, t);
    }
  }

  /** The coedge's (u, v) at edge parameter t (p-curve, else inversion seeded by `hint`). */
  Vec2 coedgeUv(int c, double t, Vec2 hint) const {
    const Coedge& C = coedges[c];
    if (C.pcurve && !C.pcurveOff) {
      CurvePoint q;
      pcurveAt(c, t, q);
      return {q.p.x, q.p.y};
    }
    return invert(C.face, edges[m.coedgeEdge(c)].geom->at(t), &hint).uv;
  }

  /**
   * t inserted into edge e's samples in order (an existing one within a millionth of its span used instead): the
   * sample's parameter, which callers must keep (a reused one isn't t).
   */
  double insertSample(int e, double t) {
    Edge& E = edges[e];
    std::vector<double>& ts = E.s.t;
    bool up = ts.back() > ts.front();
    size_t i = 0;
    while (i + 1 < ts.size() && (up ? ts[i + 1] < t : ts[i + 1] > t)) i++;
    double span = std::fabs(ts[i + 1] - ts[i]);
    if (std::fabs(t - ts[i]) <= 1e-6 * span) return ts[i];
    if (std::fabs(ts[i + 1] - t) <= 1e-6 * span) return ts[i + 1];
    ts.insert(ts.begin() + static_cast<long>(i) + 1, t);
    E.s.points.insert(E.s.points.begin() + static_cast<long>(i) + 1, E.geom->at(t));
    return t;
  }

  // ---- faces ----

  struct Chain {
    std::vector<BoundaryPoint> pts;  // the last the first's junction again (shifted by the winding)
    int winding[2] = {0, 0};
    Status status = Status::ok;
    std::vector<int> owner;  // per point: the coedge (-1: a pole fill)
    bool againstSense = false;  // a projected seam use's side (by the rule) against where its loop has it
  };

  /** The coedge's points as BoundaryPoints, shifted. */
  void coedgePoints(int c, Vec2 shift, std::vector<BoundaryPoint>& out, std::vector<int>& owner, size_t from) const {
    const CoedgeSamples& s = coedges[c].s;
    int e = m.coedgeEdge(c);
    for (size_t i = from; i < s.uv.size(); i++) {
      // A sample twice (throughPoles): the pole line between its copies.
      if (i > from && s.index[i] == s.index[i - 1])
        if (int p = poleAt(coedges[c].face, surfaceAt(coedges[c].face, s.uv[i])); p >= 0)
          poleFill(coedges[c].face, p, s.uv[i - 1] + shift, s.uv[i] + shift, out, owner);
      out.push_back({BoundaryPoint::edgeSample, s.uv[i] + shift, e, s.index[i], edges[e].s.points[s.index[i]]});
      owner.push_back(c);
    }
  }

  /** Points along pole line p from a to b (both excluded), kPolePerPeriod-ish per period. */
  void poleFill(int f, int p, Vec2 a, Vec2 b, std::vector<BoundaryPoint>& out, std::vector<int>& owner) const {
    const Face& F = faces[f];
    int fr = F.sing[p].isoU ? 1 : 0;
    double da = fr == 0 ? b.x - a.x : b.y - a.y, P = F.period[fr] > 0 ? F.period[fr] : 2 * M_PI;
    int n = std::max(1, static_cast<int>(std::ceil(std::fabs(da) / P * F.polePerPeriod)));
    for (int k = 1; k < n; k++) {
      double f01 = static_cast<double>(k) / n;
      Vec2 q = fr == 0 ? Vec2{a.x + f01 * da, F.sing[p].at} : Vec2{F.sing[p].at, a.y + f01 * da};
      out.push_back({BoundaryPoint::poleLine, q, -1, -1, F.sing[p].point});
      owner.push_back(-1);
    }
  }

  /** The junction's pole (the 3D point of coedge c's end), or -1. */
  int junctionPole(int f, int c) const {
    const CoedgeSamples& s = coedges[c].s;
    return s.index.empty() ? -1 : poleAt(f, edges[m.coedgeEdge(c)].s.points[s.index.back()]);
  }

  /**
   * An edge loop's chain in (u, v): its coedges shifted by periods to join (across a pole by the side the face lies
   * on), seam uses found by inversion placed by a regular junction, pole jumps filled.
   */
  Chain chain(int f, const std::vector<int>& cs) const {
    const Face& F = faces[f];
    Chain ch;
    int K = static_cast<int>(cs.size());
    if (!K) return ch;
    bool sense = m.faceSameSense(f);
    std::vector<Vec2> shift(K, Vec2{0, 0});
    std::vector<char> placed(K, 0), amb(K, 0);
    for (int k = 0; k < K; k++) {
      const Coedge& C = coedges[cs[k]];
      amb[k] = C.ambiguous[0] || C.ambiguous[1];
      if (C.s.uv.empty()) {
        ch.status = worse(ch.status, C.s.status == Status::ok ? Status::invalidModel : C.s.status);
        return ch;
      }
      ch.status = worse(ch.status, C.s.status);
    }
    auto first = [&](int k) { return coedges[cs[k]].s.uv.front() + shift[k]; };
    auto last = [&](int k) { return coedges[cs[k]].s.uv.back() + shift[k]; };
    // Which way a jump along pole p runs: the face to its left (its sense true), so along a pole at the top of the
    // other coordinate towards -u (+v for a pole line in v), at the bottom the other way.
    auto jumpSign = [&](int p) {
      int other = F.sing[p].isoU ? 0 : 1;
      double mean = 0;
      int count = 0;
      for (int k = 0; k < K; k++)
        for (Vec2 q : coedges[cs[k]].s.uv) mean += other == 0 ? q.x : q.y, count++;
      return jumpSignAt(f, p, mean / std::max(1, count));
    };
    // A jump along a pole of none or a whole period (the same point) between coedges ca and cb: the whole period where
    // they're the two uses of one edge (a seam through the pole, a cone's from its apex: up it and back down, which
    // no jump would make a slit), else none (a loop touching the pole leaves it where it came).
    auto wholeTurn = [&](int ca, int cb) { return m.coedgeEdge(cs[ca]) == m.coedgeEdge(cs[cb]); };
    // Shift for coedge k to follow point `end` (coedge `from`'s) across a junction that's at pole p (-1: none).
    auto follow = [&](int k, Vec2 end, int p, int from) {
      Vec2 st = coedges[cs[k]].s.uv.front(), sh{0, 0};
      for (int d = 0; d < 2; d++) {
        double P = F.period[d], e = d ? end.y : end.x, s0 = d ? st.y : st.x, x = nearest(s0, e, P);
        if (p >= 0 && P > 0 && d == (F.sing[p].isoU ? 1 : 0)) {
          // Along the pole: the jump runs its way, at most a period (0 where it doesn't jump).
          double sg = jumpSign(p), delta = std::fmod((x - e) * sg, P);
          if (delta < 0) delta += P;
          if (delta > P - 1e-9 * P) delta = 0;
          if (delta == 0 && wholeTurn(from, k)) delta = P;
          x = e + sg * delta;
        }
        (d ? sh.y : sh.x) = x - s0;
      }
      return sh;
    };
    int start = 0;
    while (start < K && amb[start]) start++;
    if (start == K) {
      ch.status = Status::singular;
      start = 0;
    }
    placed[start] = 1;
    // The regular coedges in order; a pole anywhere between two decides the jump.
    int prev = start;
    for (int step = 1; step < K; step++) {
      int k = (start + step) % K;
      if (amb[k]) continue;
      int p = -1;
      for (int j = prev; j != k; j = (j + 1) % K)
        if (int q = junctionPole(f, cs[j]); q >= 0) p = q;
      shift[k] = follow(k, last(prev), p, prev);
      placed[k] = 1;
      prev = k;
    }
    // Seam uses by inversion: from a neighbour across a junction that isn't at a pole.
    for (bool changed = true; changed;) {
      changed = false;
      for (int k = 0; k < K; k++) {
        if (placed[k]) continue;
        int b = (k + K - 1) % K, a = (k + 1) % K;
        bool fromB = placed[b] && junctionPole(f, cs[b]) < 0, fromA = placed[a] && junctionPole(f, cs[k]) < 0;
        if (!fromB && !fromA) continue;
        Vec2 sh = fromB ? follow(k, last(b), -1, b) : Vec2{0, 0};
        if (fromA) {
          // Its end onto the next's start.
          Vec2 en = coedges[cs[k]].s.uv.back(), want = first(a), s2{0, 0};
          for (int d = 0; d < 2; d++) {
            double e0 = d ? en.y : en.x, w = d ? want.y : want.x;
            (d ? s2.y : s2.x) = nearest(e0, w, F.period[d]) - e0;
          }
          if (fromB && (std::fabs(s2.x - sh.x) > 1e-9 || std::fabs(s2.y - sh.y) > 1e-9)) ch.status = Status::singular;
          if (!fromB) sh = s2;
        }
        shift[k] = sh;
        placed[k] = 1;
        changed = true;
      }
    }
    for (int k = 0; k < K; k++)
      if (!placed[k]) ch.status = Status::singular;
    // Each seam use's side against its direction and the face's sense: the face's other points on its left.
    for (int k = 0; k < K; k++) {
      if (!amb[k]) continue;
      int d = coedges[cs[k]].ambiguous[0] ? 0 : 1, other = 1 - d;
      Vec2 a = first(k), b = last(k);
      double dir = other == 1 ? b.y - a.y : b.x - a.x, seamAt = d == 0 ? a.x : a.y, mean = 0;
      int count = 0;
      for (int j = 0; j < K; j++) {
        if (amb[j]) continue;
        for (Vec2 q : coedges[cs[j]].s.uv) mean += (d == 0 ? q.x + shift[j].x : q.y + shift[j].y), count++;
      }
      if (!count || dir == 0) continue;
      // Left of (0, dir) is -u; left of (dir, 0) is +v.
      double want = (d == 0 ? -dir : dir) * (sense ? 1 : -1), got = mean / count - seamAt;
      if (want * got <= 0) ch.status = Status::singular;
    }
    // A projected seam use took its copy by the rule (its direction and the face's sense); where its loop has the
    // face's other points on its other side, the loop runs against the face's sense (a face turned while its loop
    // isn't): meshed as the face's sense has it, the contradiction reported, which is right left to healing.
    for (int k = 0; k < K; k++) {
      const Coedge& C = coedges[cs[k]];
      if (amb[k] || !C.projected || C.seamDir < 0) continue;
      int d = C.seamDir, other = 1 - d;
      Vec2 a = first(k), b = last(k);
      double dir = other == 1 ? b.y - a.y : b.x - a.x, seamAt = d == 0 ? a.x : a.y, mean = 0;
      int count = 0;
      for (int j = 0; j < K; j++) {
        if (amb[j] || m.coedgeEdge(cs[j]) == m.coedgeEdge(cs[k])) continue;
        for (Vec2 q : coedges[cs[j]].s.uv) mean += (d == 0 ? q.x + shift[j].x : q.y + shift[j].y), count++;
      }
      if (!count || dir == 0) continue;
      double want = (d == 0 ? -dir : dir) * (sense ? 1 : -1), got = mean / count - seamAt;
      if (want * got <= 0) ch.againstSense = true;
    }
    // Emitted from coedge 0: each junction once (the end of the one before), pole jumps filled.
    for (int k = 0; k < K; k++) {
      if (k == 0) {
        coedgePoints(cs[0], shift[0], ch.pts, ch.owner, 0);
        continue;
      }
      int p = junctionPole(f, cs[k - 1]);
      Vec2 a = last(k - 1), b = first(k);
      if (p >= 0 && norm(a - b) > 1e-12) {
        poleFill(f, p, a, b, ch.pts, ch.owner);
        coedgePoints(cs[k], shift[k], ch.pts, ch.owner, 0);
      } else {
        coedgePoints(cs[k], shift[k], ch.pts, ch.owner, 1);
      }
    }
    // The closing junction: the first point again, shifted by the winding.
    int p = junctionPole(f, cs[K - 1]);
    Vec2 a = last(K - 1), b0 = first(0);
    Vec2 b = b0;
    for (int d = 0; d < 2; d++) (d ? b.y : b.x) = nearest(d ? b0.y : b0.x, d ? a.y : a.x, F.period[d]);
    if (p >= 0 && F.period[F.sing[p].isoU ? 1 : 0] > 0) {
      // Across a pole the closing jump runs the face's way too.
      int fr = F.sing[p].isoU ? 1 : 0;
      double P = F.period[fr], e = fr ? a.y : a.x, x = fr ? b.y : b.x, sg = jumpSign(p);
      double delta = std::fmod((x - e) * sg, P);
      if (delta < 0) delta += P;
      if (delta > P - 1e-9 * P) delta = 0;
      if (delta == 0 && wholeTurn(K - 1, 0)) delta = P;
      (fr ? b.y : b.x) = e + sg * delta;
    }
    if (p >= 0 && norm(a - b) > 1e-12) {
      poleFill(f, p, a, b, ch.pts, ch.owner);
      BoundaryPoint q = ch.pts.front();
      q.uv = b;
      ch.pts.push_back(q);
    } else {
      ch.pts.back().uv = b;  // the last coedge's end is the first's start
    }
    ch.owner.push_back(ch.owner.front());
    if (p < 0) {
      // The last point is the closing vertex: as the first, shifted.
      BoundaryPoint q = ch.pts.front();
      q.uv = b;
      ch.pts.back() = q;
    }
    for (int d = 0; d < 2; d++)
      if (F.period[d] > 0) {
        double w = ((d ? ch.pts.back().uv.y : ch.pts.back().uv.x) - (d ? ch.pts[0].uv.y : ch.pts[0].uv.x)) /
          F.period[d];
        ch.winding[d] = static_cast<int>(std::lround(w));
      }
    return ch;
  }

  /** Why a chain of coedges cs isn't ok (its status st): its first coedge whose edge or use isn't, else the chain's. */
  const char* chainWhy(const std::vector<int>& cs, Status st) const {
    for (int c : cs) {
      const Edge& E = edges[m.coedgeEdge(c)];
      const CoedgeSamples& s = coedges[c].s;
      if (E.s.status != Status::ok) return E.s.t.empty() ? "an edge not sampled (its curve not made or not bounded)"
        : "an edge's sampling stopped at its depth or sample cap";
      if (s.status == Status::singular) return "a seam's side in (u, v) not settled by its neighbours";
      if (s.status != Status::ok) return s.uv.empty() ? "a use of an edge with no samples on its face"
        : "a use of an edge not placed on its face (its p-curve or inversion)";
    }
    // (Singular at the chain itself: a seam use by inversion whose side no junction settles.)
    return st == Status::singular ? "a seam's side in (u, v) not settled by its neighbours"
      : "a loop's coedges not joined in (u, v)";
  }

  /** The pole (singularity) a chain's every point is at, or -1. */
  int chainPole(int f, const Chain& ch) const {
    int p = -1;
    for (const BoundaryPoint& q : ch.pts) {
      int a = q.kind == BoundaryPoint::poleLine ? -2 : poleAt(f, q.point);
      if (a == -2) continue;
      if (a < 0 || (p >= 0 && a != p)) return -1;
      p = a;
    }
    return p;
  }

  /** A loop's coedges that bound (not internal or external), in order. */
  std::vector<int> bounding(int l, std::vector<int>* internal = nullptr) const {
    std::vector<int> cs;
    for (int k = 0; k < m.loopCount(l); k++) {
      int c = m.loopFirst(l) + k, or_ = m.coedgeOrientation(c);
      if (or_ == CBR_ORIENTATION_INTERNAL) {
        if (internal) internal->push_back(c);
      } else if (or_ != CBR_ORIENTATION_EXTERNAL) {
        cs.push_back(c);
      }
    }
    return cs;
  }

  /** Face f's cut, if its loops wind: made once, its crossings inserted into their edges, its pseudo-edge sampled. */
  /**
   * A face with no edge loops (none, or vertex loops only) on a surface closed in fact: its natural extent, by cuts.
   * Periodic in one direction with poles at both ends of the other (a sphere, a closed B-spline collapsed at both
   * ends): one pseudo-edge from pole to pole along the cut. Periodic both ways with no singularity (a torus): one
   * closed pseudo-edge along each direction's cut, meeting at one corner. The cuts half a period from the faces'
   * vertex loops' points (none on a cut). Otherwise nothing (face() says unsupported).
   */
  void makeNatural(int f) {
    Face& F = faces[f];
    std::vector<Vec2> at;
    for (int i = 0; i < m.faceLoopCount(f); i++) {
      int l = m.faceFirstLoop(f) + i;
      Vec3 p = m.vertexPoint(m.loopFirst(l));
      if (poleAt(f, p) < 0) at.push_back(invert(f, p, nullptr).uv);
    }
    auto cutAt = [&](int d) {
      return at.empty() ? F.lo[d] : (d ? at[0].y : at[0].x) + 0.5 * F.period[d];
    };
    auto pseudo = [&](int free, double fixed, double t0, double t1, bool closed, Vec3 a, Vec3 b) {
      Edge E;
      E.face = f, E.free = free, E.fixed = fixed;
      E.geom = std::make_unique<IsoGeom>(*F.s, free, fixed);
      E.ends[0] = a, E.ends[1] = b;
      E.closed = closed;
      E.spacing = F.spacing;
      Status st;
      E.s.t = sample(*E.geom, t0, t1, closed, criteria(E.spacing), st);
      E.s.status = st;
      int id = static_cast<int>(edges.size());
      edges.push_back(std::move(E));
      points(id);
      return id;
    };
    std::vector<const Singularity*> rows;
    for (const Singularity& g : F.sing)
      if (g.kind != Singularity::normalVanishes) rows.push_back(&g);
    if (F.period[0] > 0 && F.period[1] > 0 && rows.empty()) {
      double u0 = cutAt(0), v0 = cutAt(1);
      Vec3 corner = surfaceAt(f, {u0, v0});
      F.natural = Face::Natural::torus;
      F.natAt[0] = u0, F.natAt[1] = v0;
      F.natPseudo[0] = pseudo(0, v0, u0, u0 + F.period[0], true, corner, corner);  // along u at v0
      F.natPseudo[1] = pseudo(1, u0, v0, v0 + F.period[1], true, corner, corner);  // along v at u0
      return;
    }
    for (int d = 0; d < 2; d++) {
      int o = 1 - d;
      Range r = o ? F.dom.v : F.dom.u;
      if (!(F.period[d] > 0) || F.period[o] > 0 || !std::isfinite(r.lo) || !std::isfinite(r.hi)) continue;
      int lo = -1, hi = -1;
      for (size_t i = 0; i < F.sing.size(); i++) {
        const Singularity& g = F.sing[i];
        if (g.kind == Singularity::normalVanishes || (g.isoU ? 0 : 1) != o) continue;
        if (g.at == r.lo) lo = static_cast<int>(i);
        if (g.at == r.hi) hi = static_cast<int>(i);
      }
      if (lo < 0 || hi < 0) continue;
      double c = cutAt(d);
      F.natural = Face::Natural::sphere;
      F.natDir = d, F.natAt[0] = c;
      F.natPole[0] = lo, F.natPole[1] = hi;
      F.natPseudo[0] = pseudo(o, c, r.lo, r.hi, false, F.sing[lo].point, F.sing[hi].point);
      return;
    }
    // A B-spline's whole rectangle (a face without bounds is the whole surface, and a B-spline's is its knot range):
    // closed in neither or one direction, its finite sides pseudo-edges or pole rows.
    if (m.surfaceKind(m.faceSurface(f)) != CBR_SURFACE_BSPLINE || (F.period[0] > 0 && F.period[1] > 0)) return;
    double box[4];
    for (int d = 0; d < 2; d++) {
      Range r = d ? F.dom.v : F.dom.u;
      if (F.period[d] > 0) r = {cutAt(d), cutAt(d) + F.period[d]};
      if (!std::isfinite(r.lo) || !std::isfinite(r.hi) || !(r.lo < r.hi)) return;
      box[2 * d] = r.lo, box[2 * d + 1] = r.hi;
    }
    // A side's pole: a singularity whose row is the side's (isoU at u = u0 or u1; else at v = v0 or v1).
    auto poleOf = [&](bool isoU, double at) {
      for (size_t i = 0; i < F.sing.size(); i++) {
        const Singularity& g = F.sing[i];
        if (g.kind != Singularity::normalVanishes && g.isoU == isoU && g.at == at) return static_cast<int>(i);
      }
      return -1;
    };
    F.natural = Face::Natural::rect;
    std::copy(box, box + 4, F.natBox);
    const double u0 = box[0], u1 = box[1], v0 = box[2], v1 = box[3];
    // Sides along u (bottom, top) and along v (right, left); a periodic direction's two sides across it one edge.
    for (int side = 0; side < 4; side++) {
      const bool alongU = side == 0 || side == 2;
      const double at = side == 0 ? v0 : side == 1 ? u1 : side == 2 ? v1 : u0;
      const int across = alongU ? 1 : 0;  // the direction the side is fixed in
      if (F.period[across] > 0 && (side == 2 || side == 3)) {
        F.natSide[side] = F.natSide[side - 2];
        continue;
      }
      if (int g = poleOf(!alongU, at); g >= 0 && F.period[across] == 0) {
        F.natSidePole[side] = g;
        continue;
      }
      const double t0 = alongU ? u0 : v0, t1 = alongU ? u1 : v1;
      const Vec2 a = alongU ? Vec2{t0, at} : Vec2{at, t0}, b = alongU ? Vec2{t1, at} : Vec2{at, t1};
      const bool closed = F.period[alongU ? 0 : 1] > 0;
      F.natSide[side] = pseudo(alongU ? 0 : 1, at, t0, t1, closed, surfaceAt(f, a), surfaceAt(f, b));
    }
  }

  /** Face f's natural extent's loop (makeNatural), counterclockwise in (u, v). */
  std::vector<BoundaryPoint> naturalLoop(int f) const {
    const Face& F = faces[f];
    std::vector<BoundaryPoint> loop;
    auto sample = [&](int e, int i, Vec2 uv) {
      return BoundaryPoint{BoundaryPoint::pseudoSample, uv, e, i, edges[e].s.points[i]};
    };
    if (F.natural == Face::Natural::torus) {
      const Edge& A = edges[F.natPseudo[0]];  // along u
      const Edge& B = edges[F.natPseudo[1]];  // along v
      double u0 = F.natAt[0], v0 = F.natAt[1], Pu = F.period[0], Pv = F.period[1];
      int na = static_cast<int>(A.s.t.size()), nb = static_cast<int>(B.s.t.size());
      for (int i = 0; i + 1 < na; i++) loop.push_back(sample(F.natPseudo[0], i, {A.s.t[i], v0}));
      for (int j = 0; j + 1 < nb; j++) loop.push_back(sample(F.natPseudo[1], j, {u0 + Pu, B.s.t[j]}));
      for (int i = na - 1; i >= 1; i--) loop.push_back(sample(F.natPseudo[0], i, {A.s.t[i], v0 + Pv}));
      for (int j = nb - 1; j >= 1; j--) loop.push_back(sample(F.natPseudo[1], j, {u0, B.s.t[j]}));
      return loop;
    }
    if (F.natural == Face::Natural::rect) {
      // Counterclockwise from (u0, v0), each side from its start corner up to (not) its end: a pseudo-edge's samples
      // (backwards on the top and left), a pole row's start corner and its fill. The periodic sides across the
      // period one edge, a period apart.
      const double u0 = F.natBox[0], u1 = F.natBox[1], v0 = F.natBox[2], v1 = F.natBox[3];
      const Vec2 corner[4] = {{u0, v0}, {u1, v0}, {u1, v1}, {u0, v1}};
      std::vector<int> owner;
      for (int side = 0; side < 4; side++) {
        const Vec2 a = corner[side], b = corner[(side + 1) % 4];
        if (F.natSidePole[side] >= 0) {
          const int g = F.natSidePole[side];
          loop.push_back({BoundaryPoint::poleLine, a, -1, -1, F.sing[g].point});
          poleFill(f, g, a, b, loop, owner);
          continue;
        }
        const int e = F.natSide[side];
        const Edge& E = edges[e];
        const int n = static_cast<int>(E.s.t.size());
        const bool alongU = side == 0 || side == 2, back = side >= 2;
        for (int k = 0; k + 1 < n; k++) {
          const int i = back ? n - 1 - k : k;
          loop.push_back(sample(e, i, alongU ? Vec2{E.s.t[i], a.y} : Vec2{a.x, E.s.t[i]}));
        }
      }
      return loop;
    }
    // Sphere-like, in (x, y) = (the periodic direction, the other): the low pole's line along +x, the cut's copy a
    // period on up, the high pole's line back, the cut down; swapped to (u, v) (reversed where that turns it).
    int d = F.natDir, e = F.natPseudo[0];
    const Edge& E = edges[e];
    int n = static_cast<int>(E.s.t.size());
    double c = F.natAt[0], P = F.period[d];
    auto uv = [&](double x, double y) { return d == 0 ? Vec2{x, y} : Vec2{y, x}; };
    std::vector<int> owner;
    loop.push_back(sample(e, 0, uv(c, E.s.t[0])));
    poleFill(f, F.natPole[0], uv(c, E.s.t[0]), uv(c + P, E.s.t[0]), loop, owner);
    for (int k = 0; k < n; k++) loop.push_back(sample(e, k, uv(c + P, E.s.t[k])));
    poleFill(f, F.natPole[1], uv(c + P, E.s.t[n - 1]), uv(c, E.s.t[n - 1]), loop, owner);
    for (int k = n - 1; k >= 1; k--) loop.push_back(sample(e, k, uv(c, E.s.t[k])));
    if (d == 1) std::reverse(loop.begin(), loop.end());
    return loop;
  }

  void makeCut(int f) {
    Face& F = faces[f];
    F.againstSense = false;
    bool edgeLoops = false;
    for (int i = 0; i < m.faceLoopCount(f); i++)
      edgeLoops = edgeLoops || m.loopKind(m.faceFirstLoop(f) + i) == CBR_LOOP_EDGE;
    if (!edgeLoops) {
      makeNatural(f);
      return;
    }
    std::vector<Chain> chains;
    std::vector<int> loopOf;
    int poleLoops = 0, poleSing = -1;
    for (int i = 0; i < m.faceLoopCount(f); i++) {
      int l = m.faceFirstLoop(f) + i;
      if (m.loopKind(l) == CBR_LOOP_VERTEX) {
        int p = poleAt(f, m.vertexPoint(m.loopFirst(l)));
        if (p >= 0) poleLoops++, poleSing = p;
        continue;
      }
      std::vector<int> cs = bounding(l);
      if (cs.empty()) continue;
      Chain ch = chain(f, cs);
      F.againstSense = F.againstSense || ch.againstSense;
      if (ch.pts.size() < 2) continue;  // (face() reports it)
      // A loop wholly at a pole (an unflagged degenerate edge there): the pole, as a vertex loop at it is.
      if (int p = chainPole(f, ch); p >= 0) {
        poleLoops++, poleSing = p;
        continue;
      }
      chains.push_back(std::move(ch));
      loopOf.push_back(l);
    }
    int windDirs = 0, d = -1;
    for (int k = 0; k < 2; k++) {
      bool any = false;
      for (const Chain& c : chains) any = any || c.winding[k] != 0;
      if (any) windDirs++, d = k;
    }
    if (windDirs == 0) return;
    // A seam use no neighbour placed winds its loop wrongly: its own status (singular), not the cut's.
    for (const Chain& c : chains)
      if (c.status == Status::singular) {
        F.status = Status::singular;
        F.why = "a seam's side in (u, v) not settled by its neighbours";
        return;
      }
    if (windDirs == 2) {
      F.status = Status::unsupported;
      F.why = "its loops wind round both periods";
      return;
    }
    std::vector<int> W;
    for (size_t i = 0; i < chains.size(); i++)
      if (chains[i].winding[d] != 0) W.push_back(static_cast<int>(i));
    int other = 1 - d, pole = -1;
    if (W.size() == 2 && poleLoops == 0) {
      if (chains[W[0]].winding[d] != -chains[W[1]].winding[d] || std::abs(chains[W[0]].winding[d]) != 1) {
        F.status = Status::invalidModel;
        F.why = "two loops winding round a period, not once each and opposite";
        return;
      }
    } else if (W.size() == 1 && std::abs(chains[W[0]].winding[d]) == 1) {
      if (poleLoops == 1) {
        pole = poleSing;
      } else {
        // The pole on the face's side of the loop: left of its direction (+d: +v for u, -u for v).
        double side = (d == 0 ? 1 : -1) * chains[W[0]].winding[d] * (m.faceSameSense(f) ? 1 : -1), mean = 0;
        for (const BoundaryPoint& q : chains[W[0]].pts) mean += other ? q.uv.y : q.uv.x;
        mean /= static_cast<double>(chains[W[0]].pts.size());
        double best = kInf;
        for (size_t i = 0; i < F.sing.size(); i++) {
          const Singularity& s = F.sing[i];
          if (s.kind == Singularity::normalVanishes || (s.isoU ? 1 : 0) != d) continue;
          double off = (s.at - mean) * side;
          if (off > 0 && off < best) best = off, pole = static_cast<int>(i);
        }
      }
      if (pole < 0 || (F.sing[pole].isoU ? 1 : 0) != d) {
        F.status = Status::unsupported;
        F.why = "a loop winding round a period with no pole on the face's side to cut to";
        return;
      }
    } else {
      F.status = Status::unsupported;
      F.why = W.size() > 2 ? "more than two loops winding round a period"
        : "a loop winding round a period more than once";
      return;
    }
    // Whether the period's start will do: not if a point of the face's loops is within the tolerance of that line or
    // the line crosses a loop that doesn't wind (a hole: its values span it).
    double P = F.period[d], lo = F.lo[d];
    bool near = false;
    for (size_t k = 0; k < chains.size(); k++) {
      double a = INFINITY, b = -INFINITY;
      for (const BoundaryPoint& q : chains[k].pts) {
        double x = d ? q.uv.y : q.uv.x;
        a = std::min(a, x), b = std::max(b, x);
        Vec2 on = q.uv;
        (d ? on.y : on.x) = lo;
        near = near || norm(surfaceAt(f, on) - q.point) <= tol;
      }
      // A hole across the line u = lo (any of its copies a period apart).
      if (chains[k].winding[d] == 0 && b - a < P) {
        double first = lo + std::ceil((a - lo) / P) * P;
        near = near || first <= b;
      }
    }
    // Where each winding loop crosses the line once, between two points neither at a pole (a loop through a pole
    // crosses every value of the pole line there, at no one point): the period's start, unless nearness says
    // otherwise, else the gaps' middles, the widest first.
    auto atPole = [&](const BoundaryPoint& q) {
      return q.kind == BoundaryPoint::poleLine || poleAt(f, q.point) >= 0 || poleAt(f, surfaceAt(f, q.uv)) >= 0;
    };
    auto once = [&](double c0) {
      for (int w : W) {
        int crossings = 0;
        const Chain& ch = chains[w];
        for (size_t i = 0; i + 1 < ch.pts.size(); i++) {
          double xa = d ? ch.pts[i].uv.y : ch.pts[i].uv.x, xb = d ? ch.pts[i + 1].uv.y : ch.pts[i + 1].uv.x;
          double c = nearest(c0, 0.5 * (xa + xb), P);
          if (!((xa - c) * (xb - c) < 0 || xa == c)) continue;
          if (atPole(ch.pts[i]) || atPole(ch.pts[i + 1])) return false;
          crossings++;
        }
        if (crossings != 1) return false;
      }
      return true;
    };
    std::vector<double> candidates;
    if (!near) candidates.push_back(lo);
    {
      std::vector<double> regular;
      for (size_t k = 0; k < chains.size(); k++)
        for (const BoundaryPoint& q : chains[k].pts) {
          if (atPole(q)) continue;
          double r = std::fmod((d ? q.uv.y : q.uv.x) - lo, P);
          regular.push_back(r < 0 ? r + P : r);
        }
      std::sort(regular.begin(), regular.end());
      std::vector<std::pair<double, double>> gaps;  // width, middle
      for (size_t i = 0; i < regular.size(); i++) {
        double a = regular[i], b = i + 1 < regular.size() ? regular[i + 1] : regular[0] + P;
        if (b > a) gaps.push_back({b - a, lo + std::fmod(0.5 * (a + b), P)});
      }
      std::stable_sort(gaps.begin(), gaps.end(), [](auto& x, auto& y) { return x.first > y.first; });
      for (auto& g : gaps) candidates.push_back(g.second);
    }
    double cut = NAN;
    for (double c : candidates)
      if (once(c)) {
        cut = c;
        break;
      }
    if (std::isnan(cut)) {
      F.status = Status::unsupported;
      F.why = "no cut crossing each winding loop once away from a pole";
      return;
    }
    F.cutDir = d, F.cut = cut, F.pole = pole;
    F.loopA = loopOf[W[0]];
    F.loopB = W.size() == 2 ? loopOf[W[1]] : -1;
    // Each winding loop's crossing: the span where its values pass cut + k P, solved for the edge's parameter.
    for (size_t j = 0; j < W.size(); j++) {
      const Chain& ch = chains[W[j]];
      int found = 0;
      for (size_t i = 0; i + 1 < ch.pts.size(); i++) {
        double xa = d ? ch.pts[i].uv.y : ch.pts[i].uv.x, xb = d ? ch.pts[i + 1].uv.y : ch.pts[i + 1].uv.x;
        double c = nearest(cut, 0.5 * (xa + xb), P);
        if (!((xa - c) * (xb - c) < 0 || xa == c)) continue;
        found++;
        if (found > 1) continue;
        const BoundaryPoint& A = ch.pts[i];
        const BoundaryPoint& B = ch.pts[i + 1];
        if (xa == c && A.kind == BoundaryPoint::edgeSample) {
          F.cross[j] = {A.edgeIndex, edges[A.edgeIndex].s.t[A.sample]};
          continue;
        }
        if (A.kind != BoundaryPoint::edgeSample || B.kind != BoundaryPoint::edgeSample || ch.owner[i] < 0 ||
          ch.owner[i + 1] < 0) {
          found = 99;
          continue;
        }
        int e = A.edgeIndex, co = ch.owner[i], as = A.sample, bs = B.sample;
        // Where A's and B's edges don't give the span (below): as consecutive samples of B's owner, the coedge it
        // lies on (each point after the first is its owner's, the closing point the last coedge's), at A's and B's
        // points within its edge's tolerance. An edge whose two samples are both junctions has no point of its own in
        // the chain: its first is the edge before's last, its last the closing point, which carries the first
        // coedge's edge.
        auto inOwner = [&] {
          const int c2 = ch.owner[i + 1], e2 = m.coedgeEdge(c2);
          const CoedgeSamples& s2 = coedges[c2].s;
          const double et = tols.edge(e2);
          for (size_t q = 0; q + 1 < s2.index.size(); q++)
            if (norm(edges[e2].s.points[s2.index[q]] - A.point) <= et &&
              norm(edges[e2].s.points[s2.index[q + 1]] - B.point) <= et) {
              e = e2, co = c2, as = s2.index[q], bs = s2.index[q + 1];
              return true;
            }
          return false;
        };
        if (A.edgeIndex != B.edgeIndex) {
          // Across a junction, whose point carries one edge though it ends one and starts the other: the span is the
          // edge whose sample next to one end is the other's point (B's next to it A's: from a junction into the next
          // edge; else A's, into the loop's closing point, which carries the first coedge's edge).
          auto next = [&](int edge, int sample, Vec3 to) {
            for (int j : {sample - 1, sample + 1})
              if (j >= 0 && j < static_cast<int>(edges[edge].s.points.size()) &&
                norm(edges[edge].s.points[j] - to) == 0)
                return j;
            return -1;
          };
          if (int j = next(B.edgeIndex, B.sample, A.point); j >= 0) {
            e = B.edgeIndex, co = ch.owner[i + 1], as = j, bs = B.sample;
          } else if (int k = next(A.edgeIndex, A.sample, B.point); k >= 0) {
            e = A.edgeIndex, co = ch.owner[i], as = A.sample, bs = k;
          } else if (!inOwner()) {
            found = 99;
            continue;
          }
        }
        // A closed edge's first and last samples are one point: the loop's closing point carries one of them, so the
        // span's other end may be either (the sample adjacent to A's).
        int last = static_cast<int>(edges[e].s.t.size()) - 1;
        if (std::abs(as - bs) != 1 && edges[e].closed) {
          if (bs == last || bs == 0) bs = (bs == last ? 0 : last);
          if (std::abs(as - bs) != 1 && (as == last || as == 0)) as = (as == last ? 0 : last);
        }
        if (std::abs(as - bs) != 1 && !inOwner()) {
          found = 99;
          continue;
        }
        double ta = edges[e].s.t[as], tb = edges[e].s.t[bs];
        // The shift this coedge has in the chain, so the solve compares like with like.
        Vec2 raw = coedges[co].s.uv[0];
        double shiftD = 0;
        for (size_t q = 0; q < coedges[co].s.index.size(); q++)
          if (coedges[co].s.index[q] == as) {
            raw = coedges[co].s.uv[q];
            shiftD = xa - (d ? raw.y : raw.x);
          }
        double fa = xa - c;
        Vec2 hint = raw;
        for (int it = 0; it < 80; it++) {
          double tm = 0.5 * (ta + tb);
          Vec2 q = coedgeUv(co, tm, hint);
          double xm = nearest((d ? q.y : q.x) + shiftD, xa, P) - c;
          if ((xm < 0) == (fa < 0)) ta = tm, fa = xm;
          else tb = tm;
          hint = q;
        }
        F.cross[j] = {e, 0.5 * (ta + tb)};
      }
      if (found != 1) {
        F.status = Status::unsupported;
        F.why = "a winding loop's crossing of the cut not found once along its edges";
        F.cutDir = -1;
        return;
      }
    }
    // The crossings as samples of their edges; those edges' coedges redone.
    for (size_t j = 0; j < W.size(); j++) {
      int e = F.cross[j].edge;
      F.cross[j].t = insertSample(e, F.cross[j].t);
      for (int c : edges[e].coedges) computeCoedge(c);
    }
    // The pseudo-edge along the cut, from loop A's crossing to loop B's (or the pole).
    Vec3 pa = sampleAtT(F.cross[0].edge, F.cross[0].t), pb;
    double va = valueAt(f, F.loopA, F.cross[0], other), vb;
    if (pole >= 0) {
      F.cross[1] = {-1, 0};
      pb = F.sing[pole].point, vb = F.sing[pole].at;
    } else {
      pb = sampleAtT(F.cross[1].edge, F.cross[1].t);
      vb = valueAt(f, F.loopB, F.cross[1], other);
      // Where the cut's own direction is periodic too (a torus), from A the way the face lies: to the left of A's
      // direction (+v of a loop running +u, -u of one running +v; the other way where the face's sense is false).
      double Po = F.period[other];
      if (Po > 0) {
        double side = (d == 0 ? 1 : -1) * chains[W[0]].winding[d] * (m.faceSameSense(f) ? 1 : -1);
        double ahead = std::fmod((vb - va) * side, Po);
        if (ahead <= 0) ahead += Po;
        vb = va + side * ahead;
      }
    }
    Edge E;
    E.face = f, E.free = other, E.fixed = cut;
    E.geom = std::make_unique<IsoGeom>(*F.s, other, cut);
    E.ends[0] = pa, E.ends[1] = pb;
    E.spacing = F.spacing;
    Status st;
    E.s.t = sample(*E.geom, va, vb, false, criteria(E.spacing), st);
    E.s.status = st;
    F.pseudo = static_cast<int>(edges.size());
    edges.push_back(std::move(E));
    points(F.pseudo);
  }

  Vec3 sampleAtT(int e, double t) const {
    const Edge& E = edges[e];
    for (size_t i = 0; i < E.s.t.size(); i++)
      if (E.s.t[i] == t) return E.s.points[i];
    return E.geom->at(t);
  }
  int sampleIndex(int e, double t) const {
    const Edge& E = edges[e];
    for (size_t i = 0; i < E.s.t.size(); i++)
      if (E.s.t[i] == t) return static_cast<int>(i);
    return -1;
  }
  /** The `dim` coordinate of a crossing sample in face f's loop l (its coedge there). */
  double valueAt(int f, int l, const Crossing& x, int dim) const {
    int idx = sampleIndex(x.edge, x.t);
    for (int c : bounding(l))
      if (m.coedgeEdge(c) == x.edge && coedges[c].face == f)
        for (size_t i = 0; i < coedges[c].s.index.size(); i++)
          if (coedges[c].s.index[i] == idx) return dim ? coedges[c].s.uv[i].y : coedges[c].s.uv[i].x;
    return 0;
  }

  FaceBoundary face(int f) const {
    FaceBoundary out;
    const Face& F = faces[f];
    // (The first cause found is the one given.)
    auto because = [&](const char* why) {
      if (out.cause.empty() && why) out.cause = why;
    };
    if (!F.s) {
      out.status = F.status == Status::ok ? Status::unsupported : F.status;
      because("its surface not made");
      return out;
    }
    out.status = F.status;
    out.againstSense = F.againstSense;
    because(F.why);
    if (F.status != Status::ok && F.cutDir < 0 && F.status != Status::singular) return out;
    std::vector<std::vector<BoundaryPoint>> loops;
    std::vector<BoundaryPoint> joined, joinedB;
    for (int i = 0; i < m.faceLoopCount(f); i++) {
      int l = m.faceFirstLoop(f) + i;
      if (m.loopKind(l) == CBR_LOOP_VERTEX) {
        Vec3 p = m.vertexPoint(m.loopFirst(l));
        if (poleAt(f, p) >= 0) continue;  // a pole: its line comes with the cut
        SurfaceInversion si = invert(f, p, nullptr);
        out.interior.push_back({{BoundaryPoint::vertexPoint, si.uv, -1, -1, p}});
        continue;
      }
      std::vector<int> internal;
      std::vector<int> cs = bounding(l, &internal);
      for (int c : internal) {
        std::vector<BoundaryPoint> run;
        std::vector<int> owner;
        coedgePoints(c, {0, 0}, run, owner, 0);
        out.interior.push_back(run);
      }
      if (cs.empty()) continue;
      Chain ch = chain(f, cs);
      if (ch.pts.size() >= 2 && chainPole(f, ch) >= 0) continue;  // (its pole line comes with the cut)
      out.status = worse(out.status, ch.status);
      if (ch.status != Status::ok) because(chainWhy(cs, ch.status));
      // (A loop with a coedge that has no samples, its edge unsampled: no chain, the status says why.)
      if (ch.pts.size() < 2) {
        out.status = worse(out.status, Status::invalidModel);
        because("a loop with an edge not sampled");
        continue;
      }
      if (l != F.loopA && l != F.loopB) {
        ch.pts.pop_back();
        loops.push_back(std::move(ch.pts));
        continue;
      }
      if (F.cutDir < 0) {
        ch.pts.pop_back();
        loops.push_back(std::move(ch.pts));
        continue;
      }
      // A winding loop, rotated to start at its crossing.
      const Crossing& x = l == F.loopA ? F.cross[0] : F.cross[1];
      int idx = sampleIndex(x.edge, x.t);
      size_t r = ch.pts.size();
      for (size_t k = 0; k + 1 < ch.pts.size() && r == ch.pts.size(); k++)
        if (ch.pts[k].kind == BoundaryPoint::edgeSample && ch.pts[k].edgeIndex == x.edge && ch.pts[k].sample == idx)
          r = k;
      if (r == ch.pts.size()) {
        out.status = worse(out.status, Status::invalidModel);
        because("a winding loop's crossing of the cut not among its samples");
        ch.pts.pop_back();
        loops.push_back(std::move(ch.pts));
        continue;
      }
      Vec2 wrap = ch.pts.back().uv - ch.pts.front().uv;
      std::vector<BoundaryPoint> rot(ch.pts.begin() + static_cast<long>(r), ch.pts.end() - 1);
      for (size_t k = 0; k <= r; k++) {
        BoundaryPoint q = ch.pts[k];
        q.uv = q.uv + wrap;
        rot.push_back(q);
      }
      if (l == F.loopA) joined.swap(rot);
      else joinedB.swap(rot);  // loop B, joined below
    }
    if (F.cutDir >= 0 && !joined.empty()) {
      int d = F.cutDir;
      double P = F.period[d];
      const Edge& E = edges[F.pseudo];
      int n = static_cast<int>(E.s.t.size());
      Vec2 aStart = joined.front().uv, aEnd = joined.back().uv;
      std::vector<BoundaryPoint> B = std::move(joinedB);
      // (The cut's values along its own direction, shifted by periods there to start at A's crossing as A is placed.)
      int other = 1 - d;
      double Po = F.period[other], a0 = other ? aEnd.y : aEnd.x;
      double offO = Po > 0 ? nearest(E.s.t.front(), a0, Po) - E.s.t.front() : 0;
      auto pseudoPoint = [&](int i, double at) {
        Vec2 q = d == 0 ? Vec2{at, E.s.t[i] + offO} : Vec2{E.s.t[i] + offO, at};
        return BoundaryPoint{BoundaryPoint::pseudoSample, q, F.pseudo, i, E.s.points[i]};
      };
      double atEnd = nearest(F.cut, d ? aEnd.y : aEnd.x, P), atStart = nearest(F.cut, d ? aStart.y : aStart.x, P);
      std::vector<BoundaryPoint> loop = joined;  // A, from its crossing round to it again
      // Up the cut at A's end.
      for (int i = 1; i < n - 1; i++) loop.push_back(pseudoPoint(i, atEnd));
      if (F.loopB >= 0) {
        // B from its crossing, shifted to start at A's end, round to A's start.
        Vec2 sh{0, 0};
        double bx = d ? B.front().uv.y : B.front().uv.x, bo = other ? B.front().uv.y : B.front().uv.x;
        (d ? sh.y : sh.x) = nearest(bx, d ? aEnd.y : aEnd.x, P) - bx;
        if (Po > 0) (other ? sh.y : sh.x) = nearest(bo, E.s.t.back() + offO, Po) - bo;
        for (BoundaryPoint q : B) {
          q.uv = q.uv + sh;
          loop.push_back(q);
        }
      } else {
        // The pole line from A's end across the period back to A's start.
        BoundaryPoint top = pseudoPoint(n - 1, atEnd);
        top.uv = d == 0 ? Vec2{atEnd, F.sing[F.pole].at} : Vec2{F.sing[F.pole].at, atEnd};
        loop.push_back(top);
        std::vector<int> owner;
        Vec2 to = d == 0 ? Vec2{atStart, F.sing[F.pole].at} : Vec2{F.sing[F.pole].at, atStart};
        poleFill(f, F.pole, top.uv, to, loop, owner);
        BoundaryPoint back = top;
        back.uv = to;
        loop.push_back(back);
      }
      // Down the cut at A's start; the loop closes on A's first point, the cut's foot there.
      for (int i = n - 2; i >= 1; i--) loop.push_back(pseudoPoint(i, atStart));
      loops.insert(loops.begin(), std::move(loop));
    }
    // Along a period, each loop's own unwrapping puts it anywhere a period apart: every loop but the widest (the cut's
    // joined one where there is one) shifted by whole periods to its middle within the widest's span (a hole in a
    // band is inside the band's period, not one beyond).
    for (int d = 0; d < 2 && loops.size() > 1; d++) {
      double P = F.period[d];
      if (!(P > 0)) continue;
      auto span = [&](const std::vector<BoundaryPoint>& l) {
        double lo = INFINITY, hi = -INFINITY;
        for (const BoundaryPoint& q : l) lo = std::min(lo, d ? q.uv.y : q.uv.x), hi = std::max(hi, d ? q.uv.y : q.uv.x);
        return std::make_pair(lo, hi);
      };
      size_t ref = 0;
      if (F.cutDir < 0)
        for (size_t i = 1; i < loops.size(); i++) {
          auto a = span(loops[i]), b = span(loops[ref]);
          if (a.second - a.first > b.second - b.first) ref = i;
        }
      auto [lo, hi] = span(loops[ref]);
      for (size_t i = 0; i < loops.size(); i++) {
        if (i == ref) continue;
        auto [a, b] = span(loops[i]);
        double mid = 0.5 * (a + b), k = 0;
        if (mid < lo) k = std::ceil((lo - mid) / P);
        else if (mid > hi) k = -std::ceil((mid - hi) / P);
        if (k == 0) continue;
        for (BoundaryPoint& q : loops[i]) (d ? q.uv.y : q.uv.x) += k * P;
      }
    }
    // Nothing but vertex loops, or no loops (a sphere bounded by a point): the surface's natural extent, where it
    // has one (makeNatural).
    if (loops.empty() && F.natural != Face::Natural::none) loops.push_back(naturalLoop(f));
    if (!m.faceSameSense(f))
      for (auto& l : loops) std::reverse(l.begin(), l.end());
    if (loops.empty()) {
      out.status = worse(out.status, Status::unsupported);
      because("no edge loops, and its surface's natural extent doesn't close (a whole plane, cylinder or cone)");
    }
    out.foldsRepaired = repairFolds(f, loops);
    out.loops = std::move(loops);
    return out;
  }
};

EdgeMesh::EdgeMesh(const Model& model, const EdgeOptions& options, const std::vector<double>& faceSpacing)
  : impl_(new Impl(model, options)) {
  Impl& I = *impl_;
  const Model& m = model;
  I.nModel = m.edges();
  I.faces.resize(m.faces());
  I.coedges.resize(m.coedges());
  I.edges.resize(I.nModel);
  for (int f = 0; f < m.faces(); f++) {
    Impl::Face& F = I.faces[f];
    Status st;
    F.s = closedSurface(m, I.tols, f, st);
    if (!F.s) {
      F.status = st;
      continue;
    }
    F.dom = F.s->domain();
    F.period[0] = F.dom.uPeriod, F.period[1] = F.dom.vPeriod;
    F.lo[0] = F.dom.u.lo, F.lo[1] = F.dom.v.lo;
    F.s->singularities(F.sing);
    F.spacing = f < static_cast<int>(faceSpacing.size()) ? faceSpacing[f] : kInf;
    for (int i = 0; i < m.faceLoopCount(f); i++) {
      int l = m.faceFirstLoop(f) + i;
      if (m.loopKind(l) != CBR_LOOP_EDGE) continue;
      for (int k = 0; k < m.loopCount(l); k++) {
        int c = m.loopFirst(l) + k;
        I.coedges[c].face = f;
        I.edges[m.coedgeEdge(c)].coedges.push_back(c);
      }
    }
  }
  for (int c = 0; c < m.coedges(); c++) {
    Status st;
    if (m.coedgePcurve(c) >= 0) I.coedges[c].pcurve = makeCurve(m, m.coedgePcurve(c), st);
  }
  for (int e = 0; e < I.nModel; e++) {
    Impl::Edge& E = I.edges[e];
    E.start = m.edgeStart(e), E.end = m.edgeEnd(e);
    E.closed = E.start >= 0 && E.start == E.end;
    for (int c : E.coedges) E.spacing = std::min(E.spacing, I.faces[I.coedges[c].face].spacing);
    Status st = Status::ok;
    if (m.edgeCurve(e) >= 0) {
      E.curve = makeCurve(m, m.edgeCurve(e), st);
      if (E.curve) E.geom = std::make_unique<CurveGeom>(*E.curve);
    } else {
      // No 3D curve: through its first use's p-curve on that face's surface.
      for (int c : E.coedges)
        if (!E.geom && I.coedges[c].pcurve && I.faces[I.coedges[c].face].s) {
          E.curve = makeCurve(m, m.coedgePcurve(c), st);
          E.face = I.coedges[c].face;
          E.pcurveOnly = true;
          E.geom = std::make_unique<ComposedGeom>(*I.faces[E.face].s, *E.curve);
          Range r = m.edgeRange(e);
          if (std::isnan(r.lo)) E.useRange = {I.coedgeRange(c, 0), I.coedgeRange(c, 1)};
        }
      if (!E.geom) st = Status::invalidModel;
    }
    E.s.status = E.geom ? Status::ok : (st == Status::ok ? Status::unsupported : st);
    if (options.progress) options.progress(e, I.nModel + m.coedges(), -1);
    I.sampleModelEdge(e);
  }
  if (options.projectMissingPcurves) I.projectMissing();
  for (int c = 0; c < m.coedges(); c++) {
    if (options.progress) options.progress(I.nModel + c, I.nModel + m.coedges(), I.coedges[c].face);
    I.computeCoedge(c);
  }
  I.samplePoleCrossings();
  // Pole lines' density: the face's coedges' samples per period along it, at least kMinPolePoints.
  for (int f = 0; f < m.faces(); f++) {
    Impl::Face& F = I.faces[f];
    if (!F.s) continue;
    for (int i = 0; i < m.faceLoopCount(f); i++) {
      int l = m.faceFirstLoop(f) + i;
      if (m.loopKind(l) != CBR_LOOP_EDGE) continue;
      for (int k = 0; k < m.loopCount(l); k++) {
        const CoedgeSamples& s = I.coedges[m.loopFirst(l) + k].s;
        if (s.uv.size() < 2) continue;
        for (int d = 0; d < 2; d++) {
          double P = F.period[d];
          double ext = std::fabs(d ? s.uv.back().y - s.uv.front().y : s.uv.back().x - s.uv.front().x);
          if (P > 0 && ext >= 0.5 * P)
            F.polePerPeriod = std::max(F.polePerPeriod, static_cast<int>(std::ceil((s.uv.size() - 1) * P / ext)));
        }
      }
    }
  }
  for (int f = 0; f < m.faces(); f++)
    if (I.faces[f].s) I.makeCut(f);
}

EdgeMesh::~EdgeMesh() { delete impl_; }

int EdgeMesh::edgeCount() const { return static_cast<int>(impl_->edges.size()); }
bool EdgeMesh::isPseudo(int e) const { return e >= impl_->nModel; }
const EdgeSamples& EdgeMesh::edge(int e) const { return impl_->edges[e].s; }
Vec3 EdgeMesh::point(int e, double t) const {
  const Impl::Edge& E = impl_->edges[e];
  return E.geom ? E.geom->at(t) : Vec3{NAN, NAN, NAN};
}
const CoedgeSamples& EdgeMesh::coedge(int c) const { return impl_->coedges[c].s; }
const ProjectionCounts& EdgeMesh::projections() const { return impl_->projections; }
FaceBoundary EdgeMesh::face(int f) const { return impl_->face(f); }

Status EdgeMesh::split(const std::vector<SplitRequest>& requests) {
  Impl& I = *impl_;
  bool bad = false;
  // Per edge, the new parameters (each at its fraction of its span as it was).
  std::vector<std::vector<double>> add(I.edges.size());
  for (const SplitRequest& r : requests) {
    if (r.edge < 0 || r.edge >= static_cast<int>(I.edges.size()) || !std::isfinite(r.fraction)) {
      bad = true;
      continue;
    }
    const std::vector<double>& t = I.edges[r.edge].s.t;
    if (r.span < 0 || r.span + 1 >= static_cast<int>(t.size())) {
      bad = true;
      continue;
    }
    // (A refused triangle's request is honoured below the refinement floor, but no span whose chord is within the
    // part's tolerance is split: the model can't say where its curve is below that.)
    const std::vector<Vec3>& pts = I.edges[r.edge].s.points;
    if (norm(pts[r.span + 1] - pts[r.span]) <= I.tol) continue;
    double f = std::clamp(r.fraction, 0.1, 0.9), x = t[r.span] + f * (t[r.span + 1] - t[r.span]);
    bool inRing = false;
    for (const Range& g : I.edges[r.edge].rings) inRing = inRing || (x > g.lo && x < g.hi);
    if (!inRing) add[r.edge].push_back(x);
  }
  for (size_t e = 0; e < add.size(); e++) {
    if (add[e].empty()) continue;
    Impl::Edge& E = I.edges[e];
    const std::vector<double> t = E.s.t;
    const std::vector<Vec3> pts = E.s.points;
    bool up = t.back() > t.front();
    auto before = [&](double a, double b) { return up ? a < b : a > b; };
    std::sort(add[e].begin(), add[e].end(), before);
    // Each new one in its span; one within a tenth of the span of the last kept in the same span is dropped.
    std::vector<std::pair<size_t, double>> news;
    for (double x : add[e]) {
      size_t sp = 0;
      while (sp + 2 < t.size() && !before(x, t[sp + 1])) sp++;
      double width = std::fabs(t[sp + 1] - t[sp]);
      if (!news.empty() && news.back().first == sp && std::fabs(x - news.back().second) < 0.1 * width) continue;
      news.push_back({sp, x});
    }
    E.s.t.clear();
    E.s.points.clear();
    size_t k = 0;
    for (size_t i = 0; i < t.size(); i++) {
      E.s.t.push_back(t[i]);
      E.s.points.push_back(pts[i]);
      for (; k < news.size() && news[k].first == i; k++) {
        E.s.t.push_back(news[k].second);
        E.s.points.push_back(E.geom->at(news[k].second));
      }
    }
    for (int c : E.coedges) I.computeCoedge(c);
  }
  return bad ? Status::invalidModel : Status::ok;
}

Status EdgeMesh::cutRings(const std::vector<RingCut>& cuts) {
  Impl& I = *impl_;
  bool bad = false;
  std::set<int> touched;
  for (const RingCut& c : cuts) {
    if (c.edge < 0 || c.edge >= static_cast<int>(I.edges.size()) || !std::isfinite(c.approach) ||
      !std::isfinite(c.crossing) || c.approach == c.crossing) {
      bad = true;
      continue;
    }
    Impl::Edge& E = I.edges[c.edge];
    if (E.s.t.size() < 2 || !E.geom) {
      bad = true;
      continue;
    }
    const double lo = std::min(E.s.t.front(), E.s.t.back()), hi = std::max(E.s.t.front(), E.s.t.back());
    if (c.approach < lo || c.approach > hi || c.crossing < lo || c.crossing > hi) {
      bad = true;
      continue;
    }
    const double a = I.insertSample(c.edge, c.approach), b = I.insertSample(c.edge, c.crossing);
    if (a == b) {
      bad = true;
      continue;
    }
    const Range g{std::min(a, b), std::max(a, b)};
    for (size_t i = 0; i < E.s.t.size();) {
      if (E.s.t[i] > g.lo && E.s.t[i] < g.hi) {
        E.s.t.erase(E.s.t.begin() + static_cast<long>(i));
        E.s.points.erase(E.s.points.begin() + static_cast<long>(i));
      } else {
        i++;
      }
    }
    E.rings.push_back(g);
    touched.insert(c.edge);
  }
  for (int e : touched)
    for (int co : I.edges[e].coedges) I.computeCoedge(co);
  return bad ? Status::invalidModel : Status::ok;
}

} // namespace tesscadio
