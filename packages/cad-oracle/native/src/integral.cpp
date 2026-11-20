// faceIntegral (oracle.h) on the faces the oracle measures: planes, cylinders, cones, spheres and tori by the engine of
// closed.h, extrusions and revolutions by swept.h's, B-splines, offsets and trims by free.h's, with H numeric: H(u, v)
// = -int_{v0}^{v} F(u, t) dt, F the integrand at the surface's point with its area vector n = S_u x S_v turned by the
// face's sense, by a composite Gauss-Legendre rule (smooth in v, so the outer quadrature can converge through it) whose
// panels are doubled per span until H at the loops' samples settles (inner.h). The area, |n|, rides along as one more
// component: on a sphere, and a revolution closed by two poles, the result is known modulo the integral over the whole
// surface (closed.h, swept.h, free.h), and the area, which lies in [0, whole), says which multiple; every component
// takes the same.

#include <algorithm>
#include <array>
#include <cmath>
#include <functional>
#include <memory>
#include <vector>

#include "cad_geom/surface.h"
#include "closed.h"
#include "free.h"
#include "geom_api.h"
#include "inner.h"
#include "quad.h"
#include "swept.h"

namespace cadoracle {

namespace {

std::vector<Estimate> unsupported(int k) {
  return std::vector<Estimate>(k > 0 ? k : 0, Estimate{NAN, INFINITY, Status::unsupported});
}

/** The integral of f(u) over [a, b] per component, by Gauss-Kronrod (each component on its own tolerance). */
void integrateEach(int K, const std::function<void(double u, double* out)>& f, double a, double b, double relTol,
  const std::vector<double>& floor, std::vector<Estimate>& out) {
  out.assign(K, Estimate{0, 0, Status::ok});
  std::vector<double> v(K);
  for (int c = 0; c < K; c++) {
    out[c] = cadgeom::quadrature::integrate([&](double u) {
      f(u, v.data());
      return v[c];
    }, a, b, relTol * floor[c], relTol);
  }
}

/** Points (u, -, v) on a grid over [ua, ub] x [va, vb]. */
std::vector<std::array<double, 3>> grid(double ua, double ub, double va, double vb) {
  constexpr int n = 8;
  std::vector<std::array<double, 3>> out;
  for (int i = 0; i <= n; i++)
    for (int j = 0; j <= n; j++) out.push_back({ua + (ub - ua) * i / n, va, va + (vb - va) * j / n});
  return out;
}

} // namespace

std::vector<Estimate> Oracle::Impl::integral(int f, const Integrand& g) {
  const int k = g.components;
  if (k <= 0 || !g.f) return unsupported(k);
  if (f < 0 || f >= model.faces() || h < 0) return std::vector<Estimate>(k, Estimate{NAN, INFINITY,
    Status::invalidModel});
  const int s = model.faceSurface(f);
  const int kind = s >= 0 && s < model.surfaces() ? model.surfaceKind(s) : -1;
  const double sense = model.faceSameSense(f) ? 1 : -1;
  const int K = k + 1;
  std::vector<Estimate> out(k);
  std::vector<double> innerErr(K, 0);

  if (kind == CBR_SURFACE_PLANE || kind == CBR_SURFACE_CYLINDER || kind == CBR_SURFACE_CONE ||
    kind == CBR_SURFACE_SPHERE || kind == CBR_SURFACE_TORUS) {
    const ClosedFace face = closedFace(*this, f);
    if (*face.why) return unsupported(k);
    const Elementary& E = face.E;
    Inner in;
    in.K = K;
    in.F = [&](double u, double t, double* o) {
      Vec3 p, n;
      E.eval(u, t, p, n);
      g.f(p, sense * n, o);
      o[k] = norm(n);
    };
    in.P = [&](double u, double v) {
      Vec3 p, n;
      E.eval(u, v, p, n);
      return p;
    };
    const bool sphere = E.kind == CBR_SURFACE_SPHERE, torus = E.kind == CBR_SURFACE_TORUS;
    std::vector<double> fl;
    // The whole surface's integral (a sphere's, a torus's), by a turn of the inner integral across all of v.
    auto whole = [&](int m, std::vector<Estimate>& w) {
      const double lo = sphere ? -M_PI / 2 : -M_PI, hi = sphere ? M_PI / 2 : M_PI;
      integrateEach(K, [&](double u, double* o) {
        in.H(u, hi, lo, m, o);
      }, 0, 2 * M_PI, options.relTol, fl, w);
    };
    if (face.loops.empty()) {
      if (!sphere && !torus) {
        for (int c = 0; c < k; c++) out[c] = {0, 0, Status::ok};
        return out;
      }
      const double vb = sphere ? M_PI / 2 : M_PI;
      fl = floors(g, in, grid(0, 2 * M_PI, -vb, vb));
      std::vector<double> err(K);
      const int m = innerPanels(in, {{0, vb, -vb}}, options.relTol, fl, err);
      std::vector<Estimate> w;
      whole(m, w);
      for (int c = 0; c < k; c++) out[c] = {w[c].value, w[c].error + err[c] * 2 * M_PI, w[c].status};
      return out;
    }
    // The inner rule's panels, from the loops' samples on both of a sphere's bases.
    std::vector<std::array<double, 3>> samples;
    for (const auto& runs : face.loops) {
      for (const Run& r : runs) {
        for (int j = 0; j <= kSizeSamples; j++) {
          CurvePoint q;
          r.curve->eval(r.ta + (r.tb - r.ta) * j / kSizeSamples, 1, q);
          double u, v, du, dv;
          E.uv(E.local(q.p), E.dir(q.d1), u, v, du, dv);
          samples.push_back({u, E.vZero(false), v});
          if (sphere) samples.push_back({u, E.vZero(true), v});
        }
      }
    }
    fl = floors(g, in, samples);
    const int m = innerPanels(in, samples, options.relTol, fl, innerErr);
    Antiderivative A;
    A.k = K;
    A.floor = fl;
    A.H = [&](double u, double v, bool south, double* o) { in.H(u, E.vZero(south), v, m, o); };
    // H_N - H_S = int over the whole meridian: H from the north pole down to the south.
    A.meridian = [&](double ua, double ub, double* o) {
      std::vector<Estimate> e;
      integrateEach(K, [&](double u, double* x) { in.H(u, M_PI / 2, -M_PI / 2, m, x); }, ua, ub, options.relTol, fl, e);
      for (int c = 0; c < K; c++) o[c] += e[c].value;
    };
    const ClosedTotals T = closedIntegral(face, A, options.relTol);
    std::vector<double> value(K);
    for (int c = 0; c < K; c++) value[c] = sense * T.value[c];
    if (sphere) {
      std::vector<Estimate> w;
      whole(m, w);
      const double j = std::floor(value[k] / w[k].value + 1e-12);
      for (int c = 0; c < K; c++) value[c] -= j * w[c].value;
    }
    // The inner rule's last change enters every H: times a turn (or the loops' extent in u).
    for (int c = 0; c < k; c++) out[c] = {value[c], T.error[c] + innerErr[c] * 2 * M_PI, T.status};
    return out;
  }

  if (kind == CBR_SURFACE_EXTRUSION || kind == CBR_SURFACE_REVOLUTION) {
    const SweptFace F = sweptFace(*this, f);
    if (*F.why) return unsupported(k);
    Status st;
    std::unique_ptr<cadgeom::Surface> S = cadgeom::makeSurface(model, s, st);
    if (!S) return unsupported(k);
    Inner in;
    in.K = K;
    in.F = [&](double u, double t, double* o) {
      cadgeom::SurfacePoint q;
      S->eval(u, t, 1, q);
      const Vec3 n = cross(q.du, q.dv);
      g.f(q.p, sense * n, o);
      o[k] = norm(n);
    };
    in.P = [&](double u, double v) {
      cadgeom::SurfacePoint q;
      S->eval(u, v, 0, q);
      return q.p;
    };
    // A revolution's inner integral runs along its profile: cut at its breaks.
    if (!F.extrusion) {
      const cadgeom::CurveDomain pd = F.C->domain();
      if (std::isfinite(pd.range.lo) && std::isfinite(pd.range.hi)) {
        F.C->breaks(pd.range, in.cuts);
        if (pd.period > 0) {
          const std::vector<double> one = in.cuts;
          for (int turn : {-2, -1, 1, 2})
            for (double c : one) in.cuts.push_back(c + turn * pd.period);
        }
      }
    }
    // The poles' rows, for the whole surface's integral and the reduction modulo it.
    double vlo = INFINITY, vhi = -INFINITY;
    for (double p : F.poleV) vlo = std::fmin(vlo, p), vhi = std::fmax(vhi, p);
    const bool twoPoles = !F.extrusion && F.poleV.size() >= 2;
    std::vector<double> fl;
    auto whole = [&](int m, std::vector<Estimate>& w) {
      integrateEach(K, [&](double u, double* o) { in.H(u, vhi, vlo, m, o); }, 0, F.Pu > 0 ? F.Pu : 2 * M_PI,
        options.relTol, fl, w);
    };
    if (F.pieces.empty()) {
      // Bounded by nothing: a revolution closed in v (by two poles, or a closed profile) is all of it.
      const cadgeom::CurveDomain pd = F.C->domain();
      if (F.extrusion || !(twoPoles || pd.period > 0)) {
        for (int c = 0; c < k; c++) out[c] = {0, 0, Status::ok};
        return out;
      }
      if (!twoPoles) vlo = pd.range.lo, vhi = pd.range.lo + pd.period;
      fl = floors(g, in, grid(0, F.Pu > 0 ? F.Pu : 2 * M_PI, vlo, vhi));
      std::vector<double> err(K);
      const int m = innerPanels(in, {{0, vhi, vlo}}, options.relTol, fl, err);
      std::vector<Estimate> w;
      whole(m, w);
      for (int c = 0; c < k; c++) out[c] = {w[c].value, w[c].error + err[c] * 2 * M_PI, w[c].status};
      return out;
    }
    std::vector<std::array<double, 3>> samples;
    for (const SweptPiece& p : F.pieces) {
      for (int j = 0; j <= kSizeSamples; j++) {
        double t = p.t0 + (p.t1 - p.t0) * j / kSizeSamples, o[6];
        uint8_t ok = 0;
        if (cg_coedge_eval(h, p.coedge, &t, 1, 0, o, &ok) == 0 && ok == 0) samples.push_back({o[0] + p.ou, F.v0,
          o[1] + p.ov});
      }
    }
    fl = floors(g, in, samples);
    const int m = innerPanels(in, samples, options.relTol, fl, innerErr);
    const SweptTotals T = sweptIntegral(*this, F, K, [&](double u, double v, double* o) { in.H(u, F.v0, v, m, o); },
      fl, options.relTol);
    if (T.failed) return std::vector<Estimate>(k, Estimate{NAN, INFINITY, Status::invalidModel});
    std::vector<double> value = T.value;
    if (twoPoles) {
      std::vector<Estimate> w;
      whole(m, w);
      const double j = std::floor(value[k] / w[k].value + 1e-12);
      for (int c = 0; c < K; c++) value[c] -= j * w[c].value;
    }
    for (int c = 0; c < k; c++) {
      out[c] = {value[c], T.error[c] + innerErr[c] * (T.spanU + std::fabs(F.windU) * F.Pu), T.status};
    }
    return out;
  }

  if (kind == CBR_SURFACE_BSPLINE || kind == CBR_SURFACE_OFFSET || kind == CBR_SURFACE_RECTANGULAR_TRIMMED) {
    const FreeTotals T = freeIntegral(*this, f, K, k, [&](Vec3 p, Vec3 n, double* o) {
      g.f(p, sense * n, o);
      o[k] = norm(n);
    }, [&](const Inner& in, const std::vector<std::array<double, 3>>& samples) { return floors(g, in, samples); },
      options.relTol);
    if (*T.why && T.status != Status::noConvergence && T.status != Status::singular) {
      return std::vector<Estimate>(k, Estimate{NAN, INFINITY, T.status});
    }
    for (int c = 0; c < k; c++) out[c] = {T.value[c], T.error[c], T.status};
    return out;
  }
  return unsupported(k);
}

std::vector<Estimate> Oracle::faceIntegral(int face, const Integrand& g) {
  if (!ok()) return std::vector<Estimate>(g.components > 0 ? g.components : 0,
    Estimate{NAN, INFINITY, Status::invalidModel});
  return impl_->integral(face, g);
}

} // namespace cadoracle
