// The engine for faces on planes, cylinders, cones, spheres and tori (closed.h says how it works), and their areas
// on it: H = P(v), the area element's antiderivative in closed form (plane -v; cylinder -r v; cone
// -rho |rho| / (2 sin a), rho = r + v tan a; sphere -R^2 (sin v -+ 1), zero at the north or south pole; torus
// -r (R v + r sin v)).

#include <algorithm>
#include <cmath>
#include <utility>

#include "cad_geom/numerics.h"
#include "closed.h"
#include "quad.h"

namespace cadoracle {

namespace {

/**
 * Where a curve between ta and tb (exclusive) passes through a sphere's axis: there u jumps (by pi, on a great circle
 * through a pole), which no quadrature of u' sees, and at the pole H isn't zero for the loop the jump counts. Local
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

ClosedFace closedFace(Oracle::Impl& I, int f) {
  ClosedFace out;
  const Model& model = I.model;
  const int s = model.faceSurface(f);
  const double* R = model.surfaceReals(s);
  Elementary& E = out.E;
  E.kind = model.surfaceKind(s);
  E.o = {R[0], R[1], R[2]}, E.z = {R[3], R[4], R[5]}, E.x = {R[6], R[7], R[8]}, E.y = cross(E.z, E.x);
  if (E.kind != CBR_SURFACE_PLANE) E.a = R[9];
  if (E.kind == CBR_SURFACE_CONE || E.kind == CBR_SURFACE_TORUS) E.b = R[10];
  if (E.kind == CBR_SURFACE_CONE) {
    E.tanB = std::tan(E.b), E.sinB = std::sin(E.b);
    if (std::fabs(E.sinB) < 1e-15) return out.why = "a cone with zero semi-angle", out;
  }
  if (E.kind == CBR_SURFACE_TORUS && (model.surfaceInts(s)[0] != 0 || E.b >= E.a)) {
    return out.why = "a degenerate torus", out;
  }
  for (int l = model.faceFirstLoop(f); l < model.faceFirstLoop(f) + model.faceLoopCount(f); l++) {
    if (model.loopKind(l) == CBR_LOOP_VERTEX) continue;
    if (model.loopKind(l) != CBR_LOOP_EDGE) return out.why = "a loop kind not supported", out;
    std::vector<Run> runs;
    for (int k = model.loopFirst(l); k < model.loopFirst(l) + model.loopCount(l); k++) {
      const int e = model.coedgeEdge(k);
      if (model.edgeCurve(e) < 0) return out.why = "an edge without a 3D curve", out;
      const Curve* c = I.curve(model.edgeCurve(e));
      if (!c) return out.why = "an edge curve not supported", out;
      double t0, t1;
      if (!I.edgeParams(e, t0, t1)) return out.why = "an edge's parameters not found", out;
      if (c->domain().period == 0 && (t1 - t0) * (model.edgeSameSense(e) ? 1 : -1) < 0) {
        return out.why = "an edge's vertices against its curve's sense", out;
      }
      const bool forward = model.coedgeOrientation(k) != CBR_ORIENTATION_REVERSED;
      const double ta = forward ? t0 : t1, tb = forward ? t1 : t0;
      std::vector<double> cuts;
      if (E.kind == CBR_SURFACE_SPHERE) axisCrossings(*c, E, ta, tb, cuts);
      double from = ta;
      for (double t : cuts) runs.push_back({c, from, t}), from = t;
      runs.push_back({c, from, tb});
    }
    if (!runs.empty()) out.loops.push_back(std::move(runs));
  }
  if (!out.loops.empty() && E.kind == CBR_SURFACE_PLANE) {
    CurvePoint a;
    out.loops[0][0].curve->eval(out.loops[0][0].ta, 0, a);
    const Vec3 q = E.local(a.p);
    E.o = E.o + q.x * E.x + q.y * E.y;
  }
  return out;
}

ClosedTotals closedIntegral(const ClosedFace& face, const Antiderivative& A, double relTol) {
  const Elementary& E = face.E;
  const auto& loops = face.loops;
  const int K = A.k;
  ClosedTotals T;
  T.value.assign(K, 0), T.error.assign(K, 0);
  Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
  auto grow = [&](Vec3 p) {
    lo = {std::fmin(lo.x, p.x), std::fmin(lo.y, p.y), std::fmin(lo.z, p.z)};
    hi = {std::fmax(hi.x, p.x), std::fmax(hi.y, p.y), std::fmax(hi.z, p.z)};
  };
  // An absolute tolerance per component on each run's integral, which may cancel to about 0 (a meridian's u' is
  // rounding): the scale the loops' integrals add up from, H's largest over them times u's extent (a turn where u
  // is an angle; a plane's u is a length), or the component's floor where that's more.
  std::vector<double> hMax(K, 0), h(K);
  double uLo = INFINITY, uHi = -INFINITY;
  for (const auto& runs : loops) {
    for (const Run& r : runs) {
      for (int k = 0; k <= kSizeSamples; k++) {
        CurvePoint q;
        r.curve->eval(r.ta + (r.tb - r.ta) * k / kSizeSamples, 1, q);
        grow(q.p);
        double u, v, du, dv;
        E.uv(E.local(q.p), E.dir(q.d1), u, v, du, dv);
        A.H(u, v, false, h.data());
        for (int c = 0; c < K; c++) hMax[c] = std::fmax(hMax[c], std::fabs(h[c]));
        uLo = std::fmin(uLo, u), uHi = std::fmax(uHi, u);
      }
    }
  }
  const double uExtent = E.periodicU() ? 2 * M_PI : uHi - uLo;
  std::vector<double> absTol(K);
  for (int c = 0; c < K; c++) {
    absTol[c] = relTol * std::fmax(c < static_cast<int>(A.floor.size()) ? A.floor[c] : 0, hMax[c] * uExtent);
  }
  const bool torus = E.kind == CBR_SURFACE_TORUS;
  double offMax = 0;
  auto add = [&](int c, const Estimate& e) {
    T.value[c] += e.value, T.error[c] += e.error;
    if (e.status != Status::ok && T.status == Status::ok) T.status = e.status;
  };

  for (const auto& runs : loops) {
    const size_t n = runs.size();
    // Per run: u and v at its ends (u the limit along the run at a pole), v unwrapped on a torus.
    std::vector<double> uA(n), uB(n), vA(n), vB(n);
    double vRef = NAN, uPrev = NAN, windU = 0;
    for (size_t i = 0; i < n; i++) {
      const Run& r = runs[i];
      bool south = false;
      if (E.kind == CBR_SURFACE_SPHERE) {
        // The pole this run comes nearer, by its points' heights along the axis.
        double zlo = INFINITY, zhi = -INFINITY;
        for (int k = 0; k <= kSizeSamples; k++) {
          CurvePoint q;
          r.curve->eval(r.ta + (r.tb - r.ta) * k / kSizeSamples, 0, q);
          const double z = E.local(q.p).z;
          zlo = std::fmin(zlo, z), zhi = std::fmax(zhi, z);
        }
        south = zlo + E.a < E.a - zhi;
      }
      std::vector<double> br;
      r.curve->breaks({std::fmin(r.ta, r.tb), std::fmax(r.ta, r.tb)}, br);
      if (r.tb < r.ta) std::reverse(br.begin(), br.end());
      // A torus's v along the run, unwrapped from where the loop is: (t, v) sorted by t, for the integrand's lookups.
      std::vector<std::pair<double, double>> table;
      auto rawUv = [&](double t, double& u) {
        CurvePoint q;
        r.curve->eval(t, 1, q);
        double v, du, dv;
        E.uv(E.local(q.p), E.dir(q.d1), u, v, du, dv);
        return v;
      };
      if (torus) {
        for (size_t k = 0; k + 1 < br.size(); k++) {
          for (int j = k == 0 ? 0 : 1; j <= kUnwrapSamples; j++) {
            double u;
            const double t = br[k] + (br[k + 1] - br[k]) * j / kUnwrapSamples, raw = rawUv(t, u);
            // (Across each joint too: the samples include each run's ends, so they go round the whole loop.)
            if (std::isfinite(uPrev)) windU += wrapAngle(u - uPrev);
            uPrev = u;
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
      // H du at t, all components: the first component's rule computes them, the others' mostly look them up.
      Memo memo(K);
      auto hdu = [&](double t, double* o) {
        CurvePoint q;
        r.curve->eval(t, 1, q);
        const Vec3 lq = E.local(q.p);
        double u, v, du, dv;
        E.uv(lq, E.dir(q.d1), u, v, du, dv);
        offMax = std::fmax(offMax, E.off(lq)), grow(q.p);
        A.H(u, unwrapped(t, v), south, o);
        for (int c = 0; c < K; c++) o[c] *= du;
      };
      for (int c = 0; c < K; c++) {
        auto integrand = [&](double t) { return memo.at(t, hdu)[c]; };
        for (size_t k = 0; k + 1 < br.size(); k++) {
          add(c, integrateSplit(integrand, br[k], br[k + 1], absTol[c], relTol));
        }
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
      // A run on the south's H: back to the north's by the integral of their difference over its change in u (whole
      // turns of it multiples of the whole sphere's integral).
      if (south) {
        std::vector<double> mv(K, 0);
        A.meridian(uA[i], uB[i], mv.data());
        for (int c = 0; c < K; c++) T.value[c] += mv[c];
      }
    }
    // The joints, straight in (u, v) (a pole row at a pole, where H depends on u but not on v).
    double windV = 0;
    for (size_t i = 0; i < n; i++) {
      const size_t j = (i + 1) % n;
      const double du = E.periodicU() ? wrapAngle(uA[j] - uB[i]) : uA[j] - uB[i];
      double vj = vA[j];
      if (torus) vj = vA[j] + kTwoPi * std::round((vB[i] - vA[j]) / kTwoPi);
      windV += vB[i] - vA[i] + (vj - vB[i]);
      if (du == 0) continue;
      const double ua = uB[i], va = vB[i], dv = vj - vB[i];
      Memo memo(K);
      auto hdu = [&](double x, double* o) {
        A.H(ua + x * du, va + x * dv, false, o);
        for (int c = 0; c < K; c++) o[c] *= du;
      };
      for (int c = 0; c < K; c++) {
        add(c, cadgeom::quadrature::integrate([&](double x) { return memo.at(x, hdu)[c]; }, 0, 1, absTol[c], relTol));
      }
    }
    if (torus && std::fabs(windV) > M_PI) T.flags |= flagWinds;
    if (torus && std::fabs(windU) > M_PI) T.windsU = true;
  }
  T.offSurface = offMax / std::fmax(norm(hi - lo), 1e-300);
  if (T.offSurface > kOffSurface) T.flags |= flagOffSurface;
  return T;
}

FaceMeasure Oracle::Impl::closedForm(int f) {
  FaceMeasure m;
  m.method = Method::closedForm;
  const ClosedFace face = closedFace(*this, f);
  if (*face.why) {
    m.area = {NAN, INFINITY, Status::unsupported};
    m.why = face.why;
    return m;
  }
  const Elementary& E = face.E;
  const double whole = E.kind == CBR_SURFACE_SPHERE ? 4 * M_PI * E.a * E.a
    : E.kind == CBR_SURFACE_TORUS ? 4 * M_PI * M_PI * E.a * E.b : 0;
  if (face.loops.empty()) {
    // Bounded by nothing: a closed surface's whole area; else nothing to measure.
    if (whole > 0) m.area = {whole, 0, Status::ok};
    else m.flags |= flagNoLoops, m.area = {0, 0, Status::ok};
    return m;
  }
  Antiderivative A;
  A.H = [&](double, double v, bool south, double* out) {
    switch (E.kind) {
      case CBR_SURFACE_PLANE: *out = -v; return;
      case CBR_SURFACE_CYLINDER: *out = -E.a * v; return;
      case CBR_SURFACE_CONE: {
        const double rho = E.a + v * E.tanB;
        *out = -(rho * std::fabs(rho)) / (2 * E.sinB);
        return;
      }
      case CBR_SURFACE_SPHERE: *out = -E.a * E.a * (std::sin(v) + (south ? 1 : -1)); return;
      default: *out = -E.b * (E.a * v + E.b * std::sin(v));
    }
  };
  // P_N - P_S = 2 R^2.
  A.meridian = [&](double ua, double ub, double* out) { *out += 2 * E.a * E.a * (ub - ua); };
  // The box's area, from the loops' samples (closedIntegral's): a plane's P is a length, its u one too.
  {
    Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
    for (const auto& runs : face.loops) {
      for (const Run& r : runs) {
        for (int k = 0; k <= kSizeSamples; k++) {
          CurvePoint q;
          r.curve->eval(r.ta + (r.tb - r.ta) * k / kSizeSamples, 0, q);
          lo = {std::fmin(lo.x, q.p.x), std::fmin(lo.y, q.p.y), std::fmin(lo.z, q.p.z)};
          hi = {std::fmax(hi.x, q.p.x), std::fmax(hi.y, q.p.y), std::fmax(hi.z, q.p.z)};
        }
      }
    }
    const double size = norm(hi - lo);
    A.floor = {size * size};
  }
  const ClosedTotals T = closedIntegral(face, A, options.relTol);
  double area = model.faceSameSense(f) ? T.value[0] : -T.value[0];
  m.flags |= T.flags;
  if (E.kind == CBR_SURFACE_SPHERE) {
    area = std::fmod(std::fmod(area, whole) + whole, whole);
    if (area > whole / 2 * (1 + 1e-9)) m.flags |= flagSphereSide;
  } else if (T.windsU) {
    // A loop a turn of v off the others: the area is the face's modulo the whole torus (the loops bound a region
    // whichever way they run, so never against the sense).
    area = std::fmod(std::fmod(area, whole) + whole, whole);
  } else if (area < 0) {
    m.flags |= flagOrientation;
    area = -area;
  }
  m.offSurface = T.offSurface;
  m.area = {area, T.error[0], T.status};
  return m;
}

} // namespace cadoracle
