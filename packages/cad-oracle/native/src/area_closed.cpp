// Areas of faces on planes, cylinders, cones, spheres and tori: Green's theorem in the surface's (u, v), area =
// oint P(v) du with dP/dv = -|S_u x S_v| in closed form (plane -(v - v0); cylinder -r v; cone -rho |rho| / (2 sin a),
// rho = r + v tan a; sphere -R^2 (sin v - 1); torus -r (R v + r sin v)). The boundary is each edge's 3D curve between
// its vertices' parameters (the face API's edgeParams), each point mapped to (u, v) by the surface's closed-form
// inverse and du/dt by the chain rule from the curve's derivative, so u is never unwrapped and a loop winding the
// axis needs nothing of its own. Each edge's integral is adaptive Gauss-Kronrod per span of its curve (the error the
// quadrature's estimate). At a joint the loop runs straight in (u, v) from one edge's end to the next's start: zero
// where they meet, the pole row at a sphere's pole or a cone's apex, where u is the limit along each edge's tangent.
// P is zero at a cone's apex and at the sphere's pole each edge comes nearer (its north or south); at the other the
// jump in u is ambiguous by 2 pi, which changes the sum by 4 pi R^2, so spheres' areas are reduced modulo the
// sphere's. A torus's v is unwrapped along each loop against samples of it (P isn't periodic in v); a loop winding v
// is flagged (flagWinds). Planes measure v from the face's first edge point, so small faces far from their plane's
// origin don't cancel.

#include <algorithm>
#include <cmath>
#include <utility>

#include "cad_geom/numerics.h"
#include "oracle_impl.h"

namespace cadoracle {

using cadgeom::CurvePoint;

namespace {

constexpr double kTwoPi = 2 * M_PI;
/**
 * A point within this of the axis, relative to the radius (a cone's: its extent from its origin to its apex), is the
 * pole or apex: a thin cone's radius at v = 0 is no scale for its points (cnc-box-ap242.step #92's spikes, apex
 * vertices 2-4e-9 off the axis, would otherwise get a u of their own).
 */
constexpr double kSamePoint = 1e-9;
/** Samples per span of an edge's curve where it's searched for crossings of a sphere's axis. */
constexpr int kCrossingSamples = 32;
/** Points per edge for the loops' size (a closed edge's ends are one point). */
constexpr int kSizeSamples = 8;
/** A torus's v sampled this many times per span of an edge's curve, to unwrap it along a loop. */
constexpr int kUnwrapSamples = 16;

double wrapAngle(double d) { return d - kTwoPi * std::round(d / kTwoPi); }

struct Elementary {
  int kind = 0;
  Vec3 o, x, y, z;
  /** Cylinder, sphere: the radius; cone: the radius at v = 0 and the semi-angle; torus: R, r. */
  double a = 0, b = 0, tanB = 0, sinB = 0;
  /** A plane's v origin. */
  double v0 = 0;
  /**
   * A sphere's P is zero at the pole each run of a loop comes nearer (south: -R^2 (sin v + 1)), the north's elsewhere
   * (the joints): near a pole u' is the rounding of x y' - y x' over the squared distance from the axis, which only P
   * zero there keeps integrable.
   */
  bool south = false;

  Vec3 local(Vec3 p) const {
    Vec3 q = p - o;
    return {dot(q, x), dot(q, y), dot(q, z)};
  }
  Vec3 dir(Vec3 d) const { return {dot(d, x), dot(d, y), dot(d, z)}; }
  bool periodicU() const { return kind != CBR_SURFACE_PLANE; }
  double modulus() const { return kind == CBR_SURFACE_SPHERE ? 4 * M_PI * a * a : 0; }
  bool atPole(Vec3 q) const {
    const double rho = std::hypot(q.x, q.y);
    if (kind == CBR_SURFACE_CONE) return rho < kSamePoint * (1 + std::fabs(a) + std::fabs(a / tanB));
    if (kind == CBR_SURFACE_SPHERE) return rho < kSamePoint * a;
    return false;
  }
  /** (u, v) of the local point q, and their rates along the local direction dq. */
  void uv(Vec3 q, Vec3 dq, double& u, double& v, double& du, double& dv) const {
    if (kind == CBR_SURFACE_PLANE) {
      u = q.x, v = q.y, du = dq.x, dv = dq.y;
      return;
    }
    const double r2 = q.x * q.x + q.y * q.y, rho = std::sqrt(r2);
    u = std::atan2(q.y, q.x);
    du = r2 > 0 ? (q.x * dq.y - q.y * dq.x) / r2 : 0;
    const double drho = rho > 0 ? (q.x * dq.x + q.y * dq.y) / rho : 0;
    if (kind == CBR_SURFACE_CYLINDER || kind == CBR_SURFACE_CONE) {
      v = q.z, dv = dq.z;
    } else {
      const double w = kind == CBR_SURFACE_SPHERE ? rho : rho - a, d = w * w + q.z * q.z;
      v = std::atan2(q.z, w), dv = d > 0 ? (w * dq.z - q.z * drho) / d : 0;
    }
  }
  double P(double v) const {
    switch (kind) {
      case CBR_SURFACE_PLANE: return -(v - v0);
      case CBR_SURFACE_CYLINDER: return -a * v;
      case CBR_SURFACE_CONE: {
        const double rho = a + v * tanB;
        return -(rho * std::fabs(rho)) / (2 * sinB);
      }
      case CBR_SURFACE_SPHERE: return -a * a * (std::sin(v) + (south ? 1 : -1));
      default: return -b * (a * v + b * std::sin(v));
    }
  }
  /** The local point's distance from the surface (a cone's both nappes). */
  double off(Vec3 q) const {
    switch (kind) {
      case CBR_SURFACE_PLANE: return std::fabs(q.z);
      case CBR_SURFACE_CYLINDER: return std::fabs(std::hypot(q.x, q.y) - a);
      case CBR_SURFACE_CONE: {
        const double h = std::hypot(q.x, q.y), zz = q.z + a / tanB, c = std::cos(b);
        return std::fmin(std::fabs(h * c - zz * sinB), std::fabs(h * c + zz * sinB));
      }
      case CBR_SURFACE_SPHERE: return std::fabs(norm(q) - a);
      default: return std::fabs(std::hypot(std::hypot(q.x, q.y) - a, q.z) - b);
    }
  }
};

/** An edge of a loop as it's run: its curve from ta to tb. */
struct Run {
  const Curve* curve;
  double ta, tb;
};

/**
 * Where a curve between ta and tb (exclusive) passes through a sphere's axis: there u jumps (by pi, on a great circle
 * through a pole), which no quadrature of u' sees, and at the pole P isn't zero for the loop the jump counts. Local
 * minima of the distance from the axis among samples, near it, polished by golden section (the distance is V-shaped
 * across a crossing), within kSamePoint of the radius.
 */
void axisCrossings(const Curve& c, const Elementary& E, double ta, double tb, std::vector<double>& out) {
  auto rho = [&](double t) {
    CurvePoint q;
    c.eval(t, 0, q);
    const Vec3 l = E.local(q.p);
    return std::hypot(l.x, l.y);
  };
  std::vector<double> br;
  c.breaks({std::fmin(ta, tb), std::fmax(ta, tb)}, br);
  std::vector<double> ts, rs;
  for (size_t k = 0; k + 1 < br.size(); k++)
    for (int j = k == 0 ? 0 : 1; j <= kCrossingSamples; j++)
      ts.push_back(br[k] + (br[k + 1] - br[k]) * j / kCrossingSamples);
  for (double t : ts) rs.push_back(rho(t));
  const double span = std::fabs(tb - ta);
  for (size_t i = 1; i + 1 < ts.size(); i++) {
    if (!(rs[i] <= rs[i - 1] && rs[i] <= rs[i + 1] && rs[i] < 0.1 * E.a)) continue;
    double lo = ts[i - 1], hi = ts[i + 1];
    const double g = (std::sqrt(5.0) - 1) / 2;
    double x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = rho(x1), f2 = rho(x2);
    for (int it = 0; it < 200 && hi - lo > 1e-15 * span; it++) {
      if (f1 <= f2) hi = x2, x2 = x1, f2 = f1, x1 = hi - g * (hi - lo), f1 = rho(x1);
      else lo = x1, x1 = x2, f1 = f2, x2 = lo + g * (hi - lo), f2 = rho(x2);
    }
    const double t = f1 <= f2 ? x1 : x2;
    if (rho(t) <= kSamePoint * E.a && std::fabs(t - ta) > 1e-12 * span && std::fabs(t - tb) > 1e-12 * span &&
      (out.empty() || std::fabs(t - out.back()) > 1e-12 * span)) {
      out.push_back(t);
    }
  }
  std::sort(out.begin(), out.end());
  if (tb < ta) std::reverse(out.begin(), out.end());
}

} // namespace

FaceMeasure Oracle::Impl::closedForm(int f) {
  FaceMeasure m;
  m.method = Method::closedForm;
  auto unsupported = [&](const char* why) {
    m.area = {NAN, INFINITY, Status::unsupported};
    m.why = why;
    return m;
  };
  const int s = model.faceSurface(f);
  const double* R = model.surfaceReals(s);
  Elementary E;
  E.kind = model.surfaceKind(s);
  E.o = {R[0], R[1], R[2]}, E.z = {R[3], R[4], R[5]}, E.x = {R[6], R[7], R[8]}, E.y = cross(E.z, E.x);
  if (E.kind != CBR_SURFACE_PLANE) E.a = R[9];
  if (E.kind == CBR_SURFACE_CONE || E.kind == CBR_SURFACE_TORUS) E.b = R[10];
  if (E.kind == CBR_SURFACE_CONE) {
    E.tanB = std::tan(E.b), E.sinB = std::sin(E.b);
    if (std::fabs(E.sinB) < 1e-15) return unsupported("a cone with zero semi-angle");
  }
  if (E.kind == CBR_SURFACE_TORUS && (model.surfaceInts(s)[0] != 0 || E.b >= E.a)) {
    return unsupported("a degenerate torus");
  }

  // The loops as runs of curves, checked before anything is integrated.
  std::vector<std::vector<Run>> loops;
  for (int l = model.faceFirstLoop(f); l < model.faceFirstLoop(f) + model.faceLoopCount(f); l++) {
    if (model.loopKind(l) == CBR_LOOP_VERTEX) continue;
    if (model.loopKind(l) != CBR_LOOP_EDGE) return unsupported("a loop kind not supported");
    std::vector<Run> runs;
    for (int k = model.loopFirst(l); k < model.loopFirst(l) + model.loopCount(l); k++) {
      const int e = model.coedgeEdge(k);
      if (model.edgeCurve(e) < 0) return unsupported("an edge without a 3D curve");
      const Curve* c = curve(model.edgeCurve(e));
      if (!c) return unsupported("an edge curve not supported");
      double t0, t1;
      if (!edgeParams(e, t0, t1)) return unsupported("an edge's parameters not found");
      if (c->domain().period == 0 && (t1 - t0) * (model.edgeSameSense(e) ? 1 : -1) < 0) {
        return unsupported("an edge's vertices against its curve's sense");
      }
      const bool forward = model.coedgeOrientation(k) != CBR_ORIENTATION_REVERSED;
      const double ta = forward ? t0 : t1, tb = forward ? t1 : t0;
      // A sphere's run split where it crosses the axis, so the jump in u there is a joint's.
      std::vector<double> cuts;
      if (E.kind == CBR_SURFACE_SPHERE) axisCrossings(*c, E, ta, tb, cuts);
      double from = ta;
      for (double t : cuts) runs.push_back({c, from, t}), from = t;
      runs.push_back({c, from, tb});
    }
    if (!runs.empty()) loops.push_back(std::move(runs));
  }
  if (loops.empty()) {
    // Bounded by nothing: a closed surface's whole area; else nothing to measure.
    if (E.kind == CBR_SURFACE_SPHERE) m.area = {E.modulus(), 0, Status::ok};
    else if (E.kind == CBR_SURFACE_TORUS) m.area = {4 * M_PI * M_PI * E.a * E.b, 0, Status::ok};
    else m.flags |= flagNoLoops, m.area = {0, 0, Status::ok};
    return m;
  }

  // The scale an absolute tolerance is set from (an edge's integral may cancel to about 0): the runs' ends' box.
  Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
  auto grow = [&](Vec3 p) {
    lo = {std::fmin(lo.x, p.x), std::fmin(lo.y, p.y), std::fmin(lo.z, p.z)};
    hi = {std::fmax(hi.x, p.x), std::fmax(hi.y, p.y), std::fmax(hi.z, p.z)};
  };
  for (const auto& runs : loops) {
    for (const Run& r : runs) {
      for (int k = 0; k <= kSizeSamples; k++) {
        CurvePoint a;
        r.curve->eval(r.ta + (r.tb - r.ta) * k / kSizeSamples, 0, a);
        grow(a.p);
      }
    }
  }
  {
    CurvePoint a;
    loops[0][0].curve->eval(loops[0][0].ta, 0, a);
    if (E.kind == CBR_SURFACE_PLANE) E.v0 = E.local(a.p).y;
  }
  const double size = norm(hi - lo);
  // An absolute tolerance on each run's integral, which may cancel to about 0 (a meridian's u' is rounding): the
  // scale the loops' integrals add up from, P's largest over them times u's extent (a turn where u is an angle; a
  // plane's u is a length), or the box's area where that's less.
  double pMax = 0, uLo = INFINITY, uHi = -INFINITY;
  for (const auto& runs : loops) {
    for (const Run& r : runs) {
      for (int k = 0; k <= kSizeSamples; k++) {
        CurvePoint q;
        r.curve->eval(r.ta + (r.tb - r.ta) * k / kSizeSamples, 1, q);
        double u, v, du, dv;
        E.uv(E.local(q.p), E.dir(q.d1), u, v, du, dv);
        pMax = std::fmax(pMax, std::fabs(E.P(v)));
        uLo = std::fmin(uLo, u), uHi = std::fmax(uHi, u);
      }
    }
  }
  const double uExtent = E.periodicU() ? 2 * M_PI : uHi - uLo;
  const double absTol = options.relTol * std::fmax(size * size, pMax * uExtent);
  const bool torus = E.kind == CBR_SURFACE_TORUS;
  double total = 0, error = 0, offMax = 0;
  Status status = Status::ok;

  for (const auto& runs : loops) {
    const size_t n = runs.size();
    // Per run: u and v at its ends (u the limit along the run at a pole), v unwrapped on a torus.
    std::vector<double> uA(n), uB(n), vA(n), vB(n);
    double vRef = NAN, sum = 0;
    for (size_t i = 0; i < n; i++) {
      const Run& r = runs[i];
      if (E.kind == CBR_SURFACE_SPHERE) {
        // The pole this run comes nearer, by its points' heights along the axis.
        double zlo = INFINITY, zhi = -INFINITY;
        for (int k = 0; k <= kSizeSamples; k++) {
          CurvePoint q;
          r.curve->eval(r.ta + (r.tb - r.ta) * k / kSizeSamples, 0, q);
          const double z = E.local(q.p).z;
          zlo = std::fmin(zlo, z), zhi = std::fmax(zhi, z);
        }
        E.south = zlo + E.a < E.a - zhi;
      }
      std::vector<double> br;
      r.curve->breaks({std::fmin(r.ta, r.tb), std::fmax(r.ta, r.tb)}, br);
      if (r.tb < r.ta) std::reverse(br.begin(), br.end());
      // A torus's v along the run, unwrapped from where the loop is: (t, v) sorted by t, for the integrand's lookups.
      std::vector<std::pair<double, double>> table;
      auto rawV = [&](double t) {
        CurvePoint q;
        r.curve->eval(t, 1, q);
        double u, v, du, dv;
        E.uv(E.local(q.p), E.dir(q.d1), u, v, du, dv);
        return v;
      };
      if (torus) {
        for (size_t k = 0; k + 1 < br.size(); k++) {
          for (int j = k == 0 ? 0 : 1; j <= kUnwrapSamples; j++) {
            const double t = br[k] + (br[k + 1] - br[k]) * j / kUnwrapSamples, raw = rawV(t);
            vRef = std::isfinite(vRef) ? raw + kTwoPi * std::round((vRef - raw) / kTwoPi) : raw;
            table.push_back({t, vRef});
          }
        }
        std::sort(table.begin(), table.end());
      }
      auto unwrapped = [&](double t, double raw) {
        if (table.empty()) return raw;
        auto it = std::lower_bound(table.begin(), table.end(), std::make_pair(t, -INFINITY));
        double ref;
        if (it == table.begin()) ref = it->second;
        else if (it == table.end()) ref = table.back().second;
        else {
          auto p = it - 1;
          ref = it->first > p->first ? p->second + (it->second - p->second) * (t - p->first) / (it->first - p->first)
                                     : it->second;
        }
        return raw + kTwoPi * std::round((ref - raw) / kTwoPi);
      };
      auto integrand = [&](double t) {
        CurvePoint q;
        r.curve->eval(t, 1, q);
        const Vec3 lq = E.local(q.p);
        double u, v, du, dv;
        E.uv(lq, E.dir(q.d1), u, v, du, dv);
        offMax = std::fmax(offMax, E.off(lq));
        grow(q.p);
        return E.P(unwrapped(t, v)) * du;
      };
      for (size_t k = 0; k + 1 < br.size(); k++) {
        Estimate e = cadgeom::quadrature::integrate(integrand, br[k], br[k + 1], absTol, options.relTol);
        sum += e.value, error += e.error;
        if (e.status != Status::ok && status == Status::ok) status = e.status;
      }
      // The ends: u and v there, u at a pole the limit along the run (its tangent there, the way the loop runs).
      auto end = [&](double t, double sign, double& u, double& v) {
        CurvePoint q;
        r.curve->eval(t, 1, q);
        const Vec3 lq = E.local(q.p), w = sign * E.dir(q.d1);
        double du, dv;
        E.uv(lq, w, u, v, du, dv);
        if (E.atPole(lq)) u = std::atan2(w.y, w.x);
        v = unwrapped(t, v);
      };
      const double dir = r.tb >= r.ta ? 1 : -1;
      end(r.ta, dir, uA[i], vA[i]);
      end(r.tb, -dir, uB[i], vB[i]);
      // A run on the south's P: back to the north's, P_N = P_S + 2 R^2, by 2 R^2 times its change in u (whole turns
      // of it multiples of the sphere's area).
      if (E.south) sum += 2 * E.a * E.a * (uB[i] - uA[i]), E.south = false;
    }
    // The joints, straight in (u, v): (P(v_end) + P(v_start)) / 2 times the jump in u (exact on a plane, where P is
    // linear; a pole row elsewhere, P constant along it).
    double windV = 0;
    for (size_t i = 0; i < n; i++) {
      const size_t j = (i + 1) % n;
      const double du = E.periodicU() ? wrapAngle(uA[j] - uB[i]) : uA[j] - uB[i];
      double vj = vA[j];
      if (torus) vj = vA[j] + kTwoPi * std::round((vB[i] - vA[j]) / kTwoPi);
      sum += 0.5 * (E.P(vB[i]) + E.P(vj)) * du;
      windV += vB[i] - vA[i] + (vj - vB[i]);
    }
    if (torus && std::fabs(windV) > M_PI) m.flags |= flagWinds;
    total += sum;
  }

  double area = model.faceSameSense(f) ? total : -total;
  if (const double mod = E.modulus()) {
    area = std::fmod(std::fmod(area, mod) + mod, mod);
    if (area > mod / 2 * (1 + 1e-9)) m.flags |= flagSphereSide;
  } else if (area < 0) {
    m.flags |= flagOrientation;
    area = -area;
  }
  m.offSurface = offMax / std::fmax(norm(hi - lo), 1e-300);
  if (m.offSurface > kOffSurface) m.flags |= flagOffSurface;
  m.area = {area, error, status};
  return m;
}

} // namespace cadoracle
