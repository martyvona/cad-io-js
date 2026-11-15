// edges.h: every model edge sampled by refining its smooth spans (the curve's breaks) until each span's bounds meet
// the criteria (a span s long in parameter strays at most s^2 max |C''| / 8 from its chord and is at most s max |C'|
// long); its uses' (u, v) through their p-curves at the same parameters, else by inverting each point onto the
// surface; then each face's loops assembled in (u, v): coedges shifted by periods to join, jumps along pole lines
// filled, seam uses found by inversion placed by their neighbours, and loops that wind round a period joined by a cut
// (a pseudo-edge on an iso-line, sampled like an edge). The cuts and their crossing samples are made at construction,
// so the samples every face sees are fixed until split().
#include "tess_cadio/edges.h"

#include <algorithm>
#include <cmath>
#include <memory>

#include "cad_geom/curve.h"
#include "cad_geom/surface.h"

namespace tesscadio {

using namespace cadgeom;

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
    if (s.derivBound(free == 1 ? rx : rf, free == 1 ? rf : rx, order, o) != Status::ok) return kInf;
    double m = order == 1 ? o[free] : (free == 1 ? o[2] : o[0]);
    return std::isfinite(m) ? m : kInf;
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
};

/**
 * The samples after a through b (a < b) appended, every span meeting the criteria by the bounds: split into as many
 * equal pieces as the bounds say (at least 2) and each checked again, since a piece's bounds are tighter. False where
 * the depth or the sample cap ran out (the span kept as it is).
 */
bool refine(const Geom& g, double a, double b, const Criteria& k, std::vector<double>& out, int depth) {
  double s = b - a, m1 = g.bound(a, b, 1), m2 = g.bound(a, b, 2);
  bool ok = std::isfinite(m2) && s * s * m2 / 8 <= k.deflection &&
    (k.spacing == kInf || (std::isfinite(m1) && s * m1 <= k.spacing));
  if (ok && k.angle > 0 && s * m2 > 0) {
    double v = norm(g.d1(a)) - s * m2;
    ok = (v > 0 && s * m2 <= std::sin(k.angle) * v) || g.singular(a, b);
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
  int pieces = static_cast<int>(std::min(n, 64.0));
  bool all = true;
  for (int i = 0; i < pieces; i++) {
    double x0 = a + s * i / pieces, x1 = i == pieces - 1 ? b : a + s * (i + 1) / pieces;
    all = refine(g, x0, x1, k, out, depth + 1) && all;
  }
  return all;
}

/** Parameters from t0 to t1 (either way round), each span within the criteria; a closed edge in at least 3 spans. */
std::vector<double> sample(const Geom& g, double t0, double t1, bool closed, const Criteria& k, Status& status) {
  double lo = std::min(t0, t1), hi = std::max(t0, t1);
  std::vector<double> cuts;
  g.breaks(lo, hi, cuts);
  if (closed) cuts.insert(cuts.end(), {lo + (hi - lo) / 3, lo + 2 * (hi - lo) / 3});
  std::sort(cuts.begin(), cuts.end());
  cuts.push_back(hi);
  std::vector<double> t{lo};
  bool ok = true;
  double a = lo;
  for (double b : cuts) {
    if (!(b > a)) continue;
    ok = refine(g, a, b, k, t, 0) && ok;
    a = b;
  }
  status = ok ? Status::ok : Status::noConvergence;
  if (t0 > t1) std::reverse(t.begin(), t.end());
  return t;
}

/** x shifted by a whole number of periods to be nearest `to` (period 0: unchanged). */
double nearest(double x, double to, double period) {
  return period > 0 ? x + std::round((to - x) / period) * period : x;
}

} // namespace

struct EdgeMesh::Impl {
  const Model& m;
  EdgeOptions o;
  double tol;
  int nModel = 0;

  struct Edge {
    std::unique_ptr<Curve> curve;   // its 3D curve, or the p-curve it's sampled through
    std::unique_ptr<Geom> geom;
    bool closed = false;
    int start = -1, end = -1;       // vertices (model edges)
    double spacing = kInf;
    std::vector<int> coedges;
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
    Status status = Status::ok;
  };
  std::vector<Edge> edges;
  std::vector<Coedge> coedges;
  std::vector<Face> faces;

  Impl(const Model& model, const EdgeOptions& options) : m(model), o(options) {
    double u = m.uncertainty();
    tol = std::isfinite(u) && u > 0 ? u : 1e-6;
  }

  Criteria criteria(double spacing) const {
    return {o.deflection, o.angle, std::min(spacing, o.maxSpacing)};
  }
  double coedgeRange(int c, int j) const { return m.f64(CBR_COEDGE_RANGE)[2 * c + j]; }

  /** A point in a face's (u, v) at the surface: S(uv). */
  Vec3 surfaceAt(int f, Vec2 uv) const {
    SurfacePoint p;
    faces[f].s->eval(uv.x, uv.y, 0, p);
    return p.p;
  }
  /** The singularity (pole or apex) at 3D point p, or -1. */
  int poleAt(int f, Vec3 p) const {
    const Face& F = faces[f];
    for (size_t i = 0; i < F.sing.size(); i++)
      if (F.sing[i].kind != Singularity::normalVanishes && norm(F.sing[i].point - p) <= 10 * tol)
        return static_cast<int>(i);
    return -1;
  }

  /**
   * invertSurface over the face's domain, an infinite direction (a plane's, a cylinder's v) narrowed to a window
   * round where Newton from `hint` (else the domain's middle, or 0) lands: the global search needs a finite box.
   */
  SurfaceInversion invert(int f, Vec3 p, const Vec2* hint) const {
    const Face& F = faces[f];
    Range r[2] = {F.dom.u, F.dom.v};
    bool infinite = false;
    for (Range& x : r) infinite = infinite || !std::isfinite(x.lo) || !std::isfinite(x.hi);
    if (infinite) {
      auto mid = [](Range x) {
        return std::isfinite(x.lo) && std::isfinite(x.hi) ? 0.5 * (x.lo + x.hi) :
          std::isfinite(x.lo) ? x.lo : std::isfinite(x.hi) ? x.hi : 0.0;
      };
      // Newton from the hint, else from 8 seeds across the finite direction: the nearest result.
      auto newton = [&](Vec2 x) {
        for (int it = 0; it < 50; it++) {
          SurfacePoint q;
          F.s->eval(x.x, x.y, 2, q);
          Vec3 e = q.p - p;
          double gu = dot(e, q.du), gv = dot(e, q.dv);
          double huu = dot(q.du, q.du) + dot(e, q.duu), huv = dot(q.du, q.dv) + dot(e, q.duv);
          double hvv = dot(q.dv, q.dv) + dot(e, q.dvv), det = huu * hvv - huv * huv;
          if (!(det > 0) || !(huu > 0)) break;
          Vec2 next{x.x - (hvv * gu - huv * gv) / det, x.y - (huu * gv - huv * gu) / det};
          next = {std::clamp(next.x, r[0].lo, r[0].hi), std::clamp(next.y, r[1].lo, r[1].hi)};
          double step = norm(next - x);
          x = next;
          if (!(step > 1e-15 * (1 + norm(x)))) break;
        }
        SurfacePoint q;
        F.s->eval(x.x, x.y, 0, q);
        return std::make_pair(x, norm(q.p - p));
      };
      std::vector<Vec2> seeds;
      if (hint) seeds.push_back(*hint);
      for (int k = 0; k < 8; k++) {
        Vec2 x{mid(r[0]), mid(r[1])};
        for (int d = 0; d < 2; d++)
          if (std::isfinite(r[d].lo) && std::isfinite(r[d].hi))
            (d ? x.y : x.x) = r[d].lo + (r[d].hi - r[d].lo) * (k + 0.5) / 8;
        seeds.push_back(x);
      }
      Vec2 x = seeds[0];
      double best = kInf;
      for (Vec2 seed : seeds) {
        auto [y, dist] = newton(seed);
        if (dist < best) best = dist, x = y;
      }
      for (int d = 0; d < 2; d++) {
        if (std::isfinite(r[d].lo) && std::isfinite(r[d].hi)) continue;
        double c = d ? x.y : x.x, w = 1 + 1e-3 * std::fabs(c);
        r[d] = {std::max(r[d].lo, c - w), std::min(r[d].hi, c + w)};
      }
    }
    return invertSurface(*F.s, p, r[0], r[1], tol, hint);
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
      return false;
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
    if (C.pcurve) {
      s.fromPcurve = true;
      for (int i = 0; i < n; i++) {
        CurvePoint q;
        s.status = worse(s.status, C.pcurve->eval(E.s.t[s.index[i]], 0, q) == Status::ok ? Status::ok :
          Status::outOfDomain);
        s.uv.push_back({q.p.x, q.p.y});
      }
    } else {
      for (int i = 0; i < n; i++) {
        Vec2 hint = i ? s.uv.back() : Vec2{};
        SurfaceInversion si = invert(C.face, E.s.points[s.index[i]], i ? &hint : nullptr);
        s.status = worse(s.status, si.status);
        s.uv.push_back(si.uv);
        singular[i] = si.atSingularity;
        seam[0][i] = si.onSeamU, seam[1][i] = si.onSeamV;
      }
      // At a pole the free coordinate is arbitrary: the nearest regular sample's, along the coedge.
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
      for (int d = 0; d < 2; d++) {
        if (!(F.period[d] > 0)) continue;
        bool all = true, any = false;
        for (int i = 0; i < n; i++)
          if (!singular[i]) all = all && seam[d][i], any = true;
        C.ambiguous[d] = all && any;
      }
    }
    // Continuous along periodic directions.
    for (int i = 1; i < n; i++) {
      s.uv[i].x = nearest(s.uv[i].x, s.uv[i - 1].x, F.period[0]);
      s.uv[i].y = nearest(s.uv[i].y, s.uv[i - 1].y, F.period[1]);
    }
    for (int i = 0; i < n; i++) s.gap = std::fmax(s.gap, norm(surfaceAt(C.face, s.uv[i]) - E.s.points[s.index[i]]));
  }

  /** The coedge's (u, v) at edge parameter t (p-curve, else inversion seeded by `hint`). */
  Vec2 coedgeUv(int c, double t, Vec2 hint) const {
    const Coedge& C = coedges[c];
    if (C.pcurve) {
      CurvePoint q;
      C.pcurve->eval(t, 0, q);
      return {q.p.x, q.p.y};
    }
    return invert(C.face, edges[m.coedgeEdge(c)].geom->at(t), &hint).uv;
  }

  /** t inserted into edge e's samples in order (an existing one within a millionth of its span used instead). */
  void insertSample(int e, double t) {
    Edge& E = edges[e];
    std::vector<double>& ts = E.s.t;
    bool up = ts.back() > ts.front();
    size_t i = 0;
    while (i + 1 < ts.size() && (up ? ts[i + 1] < t : ts[i + 1] > t)) i++;
    double span = std::fabs(ts[i + 1] - ts[i]);
    if (std::fabs(t - ts[i]) <= 1e-6 * span || std::fabs(ts[i + 1] - t) <= 1e-6 * span) return;
    ts.insert(ts.begin() + static_cast<long>(i) + 1, t);
    E.s.points.insert(E.s.points.begin() + static_cast<long>(i) + 1, E.geom->at(t));
  }

  // ---- faces ----

  struct Chain {
    std::vector<BoundaryPoint> pts;  // the last the first's junction again (shifted by the winding)
    int winding[2] = {0, 0};
    Status status = Status::ok;
    std::vector<int> owner;  // per point: the coedge (-1: a pole fill)
  };

  /** The coedge's points as BoundaryPoints, shifted. */
  void coedgePoints(int c, Vec2 shift, std::vector<BoundaryPoint>& out, std::vector<int>& owner, size_t from) const {
    const CoedgeSamples& s = coedges[c].s;
    int e = m.coedgeEdge(c);
    for (size_t i = from; i < s.uv.size(); i++) {
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
      int fr = F.sing[p].isoU ? 1 : 0, other = 1 - fr;
      double mean = 0;
      int count = 0;
      for (int k = 0; k < K; k++)
        for (Vec2 q : coedges[cs[k]].s.uv) mean += other == 0 ? q.x : q.y, count++;
      bool top = F.sing[p].at > mean / std::max(1, count);
      double sgn = fr == 0 ? (top ? -1 : 1) : (top ? 1 : -1);
      return sense ? sgn : -sgn;
    };
    // Shift for coedge k to follow point `end` across a junction that's at pole p (-1: none).
    auto follow = [&](int k, Vec2 end, int p) {
      Vec2 st = coedges[cs[k]].s.uv.front(), sh{0, 0};
      for (int d = 0; d < 2; d++) {
        double P = F.period[d], e = d ? end.y : end.x, s0 = d ? st.y : st.x, x = nearest(s0, e, P);
        if (p >= 0 && P > 0 && d == (F.sing[p].isoU ? 1 : 0)) {
          // Along the pole: the jump runs its way, at most a period (0 where it doesn't jump).
          double sg = jumpSign(p), delta = std::fmod((x - e) * sg, P);
          if (delta < 0) delta += P;
          if (delta > P - 1e-9 * P) delta = 0;
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
      shift[k] = follow(k, last(prev), p);
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
        Vec2 sh = fromB ? follow(k, last(b), -1) : Vec2{0, 0};
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
  void makeCut(int f) {
    Face& F = faces[f];
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
      chains.push_back(chain(f, cs));
      loopOf.push_back(l);
    }
    int windDirs = 0, d = -1;
    for (int k = 0; k < 2; k++) {
      bool any = false;
      for (const Chain& c : chains) any = any || c.winding[k] != 0;
      if (any) windDirs++, d = k;
    }
    if (windDirs == 0) return;
    if (windDirs == 2) {
      F.status = Status::unsupported;
      return;
    }
    std::vector<int> W;
    for (size_t i = 0; i < chains.size(); i++)
      if (chains[i].winding[d] != 0) W.push_back(static_cast<int>(i));
    int other = 1 - d, pole = -1;
    if (W.size() == 2 && poleLoops == 0) {
      if (chains[W[0]].winding[d] != -chains[W[1]].winding[d] || std::abs(chains[W[0]].winding[d]) != 1) {
        F.status = Status::invalidModel;
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
        return;
      }
    } else {
      F.status = Status::unsupported;
      return;
    }
    // Where: the period's start, unless a loop's point is within the tolerance of that line; then the middle of the
    // widest gap between the points' values there, modulo the period.
    double P = F.period[d], lo = F.lo[d];
    std::vector<double> xs;
    bool near = false;
    for (int w : W)
      for (const BoundaryPoint& q : chains[w].pts) {
        double x = d ? q.uv.y : q.uv.x, r = std::fmod(x - lo, P);
        if (r < 0) r += P;
        xs.push_back(r);
        Vec2 on = q.uv;
        (d ? on.y : on.x) = lo;
        near = near || norm(surfaceAt(f, on) - q.point) <= tol;
      }
    double cut = lo;
    if (near) {
      std::sort(xs.begin(), xs.end());
      double gap = -1;
      for (size_t i = 0; i < xs.size(); i++) {
        double a = xs[i], b = i + 1 < xs.size() ? xs[i + 1] : xs[0] + P;
        if (b - a > gap) gap = b - a, cut = lo + std::fmod(0.5 * (a + b), P);
      }
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
        if (A.kind != BoundaryPoint::edgeSample || B.kind != BoundaryPoint::edgeSample || A.edgeIndex != B.edgeIndex ||
          ch.owner[i] < 0) {
          found = 99;
          continue;
        }
        int e = A.edgeIndex, co = ch.owner[i];
        double ta = edges[e].s.t[A.sample], tb = edges[e].s.t[B.sample];
        // The shift this coedge has in the chain, so the solve compares like with like.
        Vec2 raw = coedges[co].s.uv[0];
        double shiftD = 0;
        for (size_t q = 0; q < coedges[co].s.index.size(); q++)
          if (coedges[co].s.index[q] == A.sample) {
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
        F.cutDir = -1;
        return;
      }
    }
    // The crossings as samples of their edges; those edges' coedges redone.
    for (size_t j = 0; j < W.size(); j++) {
      int e = F.cross[j].edge;
      insertSample(e, F.cross[j].t);
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
    if (!F.s || m.faceLoopCount(f) == 0) return out;
    out.status = F.status;
    if (F.status != Status::ok && F.cutDir < 0 && F.status != Status::singular) return out;
    std::vector<std::vector<BoundaryPoint>> loops;
    std::vector<BoundaryPoint> joined;
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
      out.status = worse(out.status, ch.status);
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
      else loops.push_back(std::move(rot));  // loop B, joined below
    }
    if (F.cutDir >= 0 && !joined.empty()) {
      int d = F.cutDir;
      double P = F.period[d];
      const Edge& E = edges[F.pseudo];
      int n = static_cast<int>(E.s.t.size());
      Vec2 aStart = joined.front().uv, aEnd = joined.back().uv;
      std::vector<BoundaryPoint> B;
      if (F.loopB >= 0) {
        B = std::move(loops.back());
        loops.pop_back();
      }
      auto pseudoPoint = [&](int i, double at) {
        Vec2 q = d == 0 ? Vec2{at, E.s.t[i]} : Vec2{E.s.t[i], at};
        return BoundaryPoint{BoundaryPoint::pseudoSample, q, F.pseudo, i, E.s.points[i]};
      };
      double atEnd = nearest(F.cut, d ? aEnd.y : aEnd.x, P), atStart = nearest(F.cut, d ? aStart.y : aStart.x, P);
      std::vector<BoundaryPoint> loop = joined;  // A, from its crossing round to it again
      // Up the cut at A's end.
      for (int i = 1; i < n - 1; i++) loop.push_back(pseudoPoint(i, atEnd));
      if (F.loopB >= 0) {
        // B from its crossing, shifted to start at A's end, round to A's start.
        Vec2 sh{0, 0};
        double bx = d ? B.front().uv.y : B.front().uv.x;
        (d ? sh.y : sh.x) = nearest(bx, d ? aEnd.y : aEnd.x, P) - bx;
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
    if (!m.faceSameSense(f))
      for (auto& l : loops) std::reverse(l.begin(), l.end());
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
    F.s = makeSurface(m, m.faceSurface(f), st);
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
    I.sampleModelEdge(e);
  }
  for (int c = 0; c < m.coedges(); c++) I.computeCoedge(c);
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
const CoedgeSamples& EdgeMesh::coedge(int c) const { return impl_->coedges[c].s; }
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
    double f = std::clamp(r.fraction, 0.1, 0.9);
    add[r.edge].push_back(t[r.span] + f * (t[r.span + 1] - t[r.span]));
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

} // namespace tesscadio
