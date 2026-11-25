// Areas of faces on extrusions and revolutions (swept.h says how the integral works), with H closed in the profile C:
// an extrusion S = C(u) + v m D has |S_u x S_v| = m |C'(u) x D|, so H = -(v - v0) m |C'(u) x D|; a revolution (u the
// angle, v the profile's parameter) has |S_u x S_v| = rho(v) |C'(v)|, rho the profile's distance from the axis, so
// H = -(G(v) - G(v0)) with G a 1D integral along the profile (Gauss-Legendre from the profile's breaks).

#include <algorithm>
#include <cmath>
#include <vector>

#include "cad_geom/numerics.h"
#include "geom_api.h"
#include "oracle_impl.h"
#include "quad.h"
#include "swept.h"

namespace cadoracle {

using cadgeom::CurvePoint;
using cadgeom::Vec2;

namespace {

} // namespace

LoopPieces loopPieces(Oracle::Impl& I, int f, double Pu, double Pv) {
  LoopPieces L;
  const Model& model = I.model;
  auto fail = [&](Status st, const char* why) {
    L.status = st, L.why = why;
    return std::move(L);
  };
  const int32_t np = cg_face_pieces(I.h, f);
  if (np < 0) return fail(Status::invalidModel, faceStatusWhy(-np));
  std::vector<int> loopOf(model.coedges(), -1);
  for (int l = model.faceFirstLoop(f); l < model.faceFirstLoop(f) + model.faceLoopCount(f); l++)
    for (int k = model.loopFirst(l); k < model.loopFirst(l) + model.loopCount(l); k++)
      if (model.loopKind(l) == CBR_LOOP_EDGE) loopOf[k] = l;
  {
    const double* sc = cg_scratch();
    for (int i = 0; i < np; i++) {
      const int c = static_cast<int>(sc[3 * i]);
      L.pieces.push_back({c, c >= 0 && c < model.coedges() ? loopOf[c] : -1, sc[3 * i + 1], sc[3 * i + 2]});
    }
  }
  // Each loop's pieces unwrapped: a piece's start brought within half a period of the previous piece's end; the
  // whole periods a loop closes across are its winding.
  bool ok = true;
  auto& P = L.pieces;
  for (size_t i = 0; i < P.size(); i++) {
    Vec2 a, b, d;
    if (i > 0 && P[i - 1].loop == P[i].loop) {
      ok &= pieceAt(I.h, P[i - 1], P[i - 1].t1, b, d);
      ok &= pieceAt(I.h, P[i], P[i].t0, a, d);
      P[i].ou = reducePeriods(b.x - a.x, Pu), P[i].ov = reducePeriods(b.y - a.y, Pv);
    }
    if (i + 1 == P.size() || P[i + 1].loop != P[i].loop) {
      size_t j = i;
      while (j > 0 && P[j - 1].loop == P[i].loop) j--;
      ok &= pieceAt(I.h, P[i], P[i].t1, b, d);
      ok &= pieceAt(I.h, P[j], P[j].t0, a, d);
      L.windU.push_back(Pu > 0 ? std::round((b.x - a.x) / Pu) : 0);
      L.windV.push_back(Pv > 0 ? std::round((b.y - a.y) / Pv) : 0);
    }
  }
  if (!ok) return fail(Status::invalidModel, "a p-curve not evaluated");
  return L;
}

SweptFace sweptFace(Oracle::Impl& I, int f) {
  SweptFace F;
  const Model& model = I.model;
  const int s = F.surface = model.faceSurface(f);
  F.extrusion = model.surfaceKind(s) == CBR_SURFACE_EXTRUSION;
  auto fail = [&](Status st, const char* why) {
    F.status = st, F.why = why;
    return F;
  };
  const double* R = model.surfaceReals(s);
  F.C = I.curve(model.surfaceInts(s)[0]);
  if (!F.C) return fail(Status::unsupported, "a profile curve not supported");
  double info[16];
  if (int32_t r = cg_face_info(I.h, f, NAN, info)) return fail(Status::invalidModel, faceStatusWhy(r));
  F.Pu = info[1], F.Pv = info[2];
  {
    const double* sc = cg_scratch();
    for (int i = 0; i < static_cast<int>(info[4]); i++)
      if (sc[2 * i] == 0) F.poleV.push_back(sc[2 * i + 1]);
  }
  if (!F.extrusion && F.poleV.empty() && model.curveKind(model.surfaceInts(s)[0]) == CBR_CURVE_LINE) {
    // A line through the axis is a pole cad-geom doesn't list (the line's domain is unbounded): where its distance
    // from the axis, linear in t, vanishes.
    CurvePoint q;
    F.C->eval(0, 1, q);
    const Vec3 Ax{R[0], R[1], R[2]}, ax{R[3], R[4], R[5]}, w = q.p - Ax;
    const Vec3 w0 = w - dot(w, ax) * ax, d = q.d1 - dot(q.d1, ax) * ax;
    const double dd = dot(d, d);
    if (dd > 0) {
      const double t = -dot(w0, d) / dd;
      if (norm(w0 + t * d) <= 1e-9 * (norm(w0) + norm(d))) F.poleV.push_back(t);
    }
  }
  if (info[6] > 0) F.flags |= flagProjectedBoundary;
  if (info[7] + info[8] > 0) F.flags |= flagEdgesPlaced;
  LoopPieces L = loopPieces(I, f, F.Pu, F.Pv);
  if (*L.why) return fail(L.status, L.why);
  F.pieces = std::move(L.pieces);
  for (double w : L.windU) F.windU += w;
  // Any loop winding v by itself, whatever the others do: two winding it opposite ways (a band round a tube between
  // two of its profile's circles) cancel in the sum but not in the area, which the seam term the method lacks holds.
  for (double w : L.windV) F.windV += w, F.flags |= w != 0 ? flagWinds : 0u;
  if (F.pieces.empty()) return F;
  auto& P = F.pieces;
  if (F.windU != 0 && (F.extrusion || F.poleV.empty())) F.flags |= flagWinds;
  Vec2 start, d0;
  pieceAt(I.h, P[0], P[0].t0, start, d0);
  F.v0 = !F.extrusion && !F.poleV.empty() ? F.poleV[0] : start.y;
  Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
  for (const SweptPiece& p : P) {
    const int e = model.coedgeEdge(p.coedge);
    for (int v : {model.edgeStart(e), model.edgeEnd(e)}) {
      if (v < 0) continue;
      const Vec3 q = model.vertexPoint(v);
      lo = {std::fmin(lo.x, q.x), std::fmin(lo.y, q.y), std::fmin(lo.z, q.z)};
      hi = {std::fmax(hi.x, q.x), std::fmax(hi.y, q.y), std::fmax(hi.z, q.z)};
    }
  }
  F.size = std::isfinite(lo.x) ? norm(hi - lo) : 1;
  return F;
}

SweptTotals sweptIntegral(Oracle::Impl& I, const SweptFace& F, int K,
  const std::function<void(double u, double v, double* out)>& H, const std::vector<double>& floor, double relTol) {
  SweptTotals T;
  T.value.assign(K, 0), T.error.assign(K, 0);
  const Model& model = I.model;
  bool ok = true;
  auto at = [&](const SweptPiece& p, double t, Vec2& uv, Vec2& d) { ok &= pieceAt(I.h, p, t, uv, d); };
  // An absolute tolerance per component: the scale the loops' integrals add up from, a turn (or the loops' extent in
  // u) at H's largest at the pieces' ends, or the component's floor where that's more.
  std::vector<double> absTol(K), hv(K), hMax(K, 0);
  {
    double uMin = INFINITY, uMax = -INFINITY;
    for (const SweptPiece& p : F.pieces) {
      for (double t : {p.t0, p.t1}) {
        Vec2 uv, d;
        at(p, t, uv, d);
        H(uv.x, uv.y, hv.data());
        for (int c = 0; c < K; c++) hMax[c] = std::fmax(hMax[c], std::fabs(hv[c]));
        uMin = std::fmin(uMin, uv.x), uMax = std::fmax(uMax, uv.x);
      }
    }
    for (int c = 0; c < K; c++) {
      absTol[c] = relTol * std::fmax(c < static_cast<int>(floor.size()) ? floor[c] : 0,
        hMax[c] * std::fmax(uMax - uMin, F.Pu));
    }
  }
  auto add = [&](int c, const Estimate& e) {
    T.value[c] += e.value, T.error[c] += e.error;
    if (e.status != Status::ok && T.status == Status::ok) T.status = e.status;
  };
  const auto& P = F.pieces;
  for (size_t i = 0; i < P.size(); i++) {
    const SweptPiece& p = P[i];
    std::vector<double> br;
    // Cut where the p-curve is less smooth: its own breaks, or a projection's pieces' (a fit's knots) and, as the
    // projection is in its edge's curve's parameter, that curve's (an extrusion's profile copy: the profile's knots,
    // where C' and so H may kink).
    const Range span{std::fmin(p.t0, p.t1), std::fmax(p.t0, p.t1)};
    const int32_t nb = cg_coedge_breaks(I.h, p.coedge, span.lo, span.hi);
    if (nb >= 2) br.assign(cg_scratch(), cg_scratch() + nb);
    else br = {span.lo, span.hi};
    if (model.coedgePcurve(p.coedge) < 0) {
      if (const Curve* own = I.curve(model.edgeCurve(model.coedgeEdge(p.coedge)))) {
        std::vector<double> more;
        own->breaks(span, more);
        for (double x : more) br.push_back(std::clamp(x, span.lo, span.hi));
        std::sort(br.begin(), br.end());
        br.erase(std::unique(br.begin(), br.end()), br.end());
      }
    }
    if (p.t1 < p.t0) std::reverse(br.begin(), br.end());
    // H du at t, all components (the first component's rule computes them, the others' mostly look them up).
    Memo memo(K);
    auto hdu = [&](double t, double* o) {
      Vec2 uv, d;
      at(p, t, uv, d);
      H(uv.x, uv.y, o);
      for (int c = 0; c < K; c++) o[c] *= d.x;
    };
    for (int c = 0; c < K; c++) {
      for (size_t k = 0; k + 1 < br.size(); k++) {
        add(c, integrateSplit([&](double t) { return memo.at(t, hdu)[c]; }, br[k], br[k + 1], absTol[c], relTol));
      }
    }
    // The gap to the next piece of the loop (or back to its first), less whole periods, run straight in (u, v).
    size_t j = i + 1;
    if (j == P.size() || P[j].loop != p.loop) {
      j = i;
      while (j > 0 && P[j - 1].loop == p.loop) j--;
    }
    Vec2 a, b, d, s0;
    at(p, p.t1, a, d);
    at(p, p.t0, s0, d);
    T.spanU += std::fabs(a.x - s0.x);
    at(P[j], P[j].t0, b, d);
    b = {b.x + reducePeriods(a.x - b.x, F.Pu), b.y + reducePeriods(a.y - b.y, F.Pv)};
    if (norm(b - a) <= 1e-12 * (1 + norm(a))) continue;
    Memo gap(K);
    auto gapHdu = [&](double x, double* o) {
      const Vec2 uv = a + x * (b - a);
      H(uv.x, uv.y, o);
      for (int c = 0; c < K; c++) o[c] *= b.x - a.x;
    };
    for (int c = 0; c < K; c++) {
      add(c, cadgeom::quadrature::integrate([&](double x) { return gap.at(x, gapHdu)[c]; }, 0, 1, absTol[c], relTol));
    }
  }
  T.failed = !ok;
  return T;
}

FaceMeasure Oracle::Impl::swept(int f) {
  FaceMeasure m;
  m.offSurface = NAN;
  const int s = model.faceSurface(f);
  const bool extrusion = model.surfaceKind(s) == CBR_SURFACE_EXTRUSION;
  m.method = extrusion ? Method::extrusion : Method::revolution;
  auto fail = [&](Status st, const char* why) {
    m.area = {NAN, INFINITY, st};
    m.why = why;
    return m;
  };
  const double* R = model.surfaceReals(s);
  const Curve* C = curve(model.surfaceInts(s)[0]);
  if (!C) return fail(Status::unsupported, "a profile curve not supported");

  const SweptFace F = sweptFace(*this, f);
  if (*F.why) return fail(F.status, F.why);
  m.flags |= F.flags;
  if (F.pieces.empty()) {
    // Bounded by nothing: a revolution closed in v (its profile closed, or meeting the axis at both ends) is its
    // whole area, 2 pi int rho |C'|; anything else is unbounded, nothing to measure.
    const cadgeom::CurveDomain pd = C->domain();
    const double lo = pd.range.lo, hi = pd.period > 0 ? lo + pd.period : pd.range.hi;
    const Vec3 A{R[0], R[1], R[2]}, axis{R[3], R[4], R[5]};
    auto rho = [&](double t, CurvePoint& q) {
      C->eval(t, 1, q);
      const Vec3 w = q.p - A;
      return norm(w - dot(w, axis) * axis);
    };
    bool closed = false;
    if (!extrusion && std::isfinite(lo) && std::isfinite(hi)) {
      CurvePoint a, b;
      const double ra = rho(lo, a), rb = rho(hi, b), size = norm(b.p - a.p) + std::fabs(ra) + std::fabs(rb);
      closed = pd.period > 0 || (ra <= 1e-9 * size && rb <= 1e-9 * size);
    }
    if (!closed) {
      m.flags |= flagNoLoops;
      m.area = {0, 0, Status::ok};
      return m;
    }
    std::vector<double> br;
    C->breaks({lo, hi}, br);
    Estimate whole{0, 0, Status::ok};
    for (size_t k = 0; k + 1 < br.size(); k++) {
      Estimate e = cadgeom::quadrature::integrate([&](double t) {
        CurvePoint q;
        const double r = rho(t, q);
        return r * norm(q.d1);
      }, br[k], br[k + 1], 0, options.relTol);
      whole.value += 2 * M_PI * e.value, whole.error += 2 * M_PI * e.error;
      if (e.status != Status::ok) whole.status = e.status;
    }
    m.area = whole;
    return m;
  }

  const double v0 = F.v0;
  const double absTol = options.relTol * F.size * F.size;
  const auto& poleV = F.poleV;
  const Vec3 D{R[0], R[1], R[2]}, A{R[0], R[1], R[2]}, axis{R[3], R[4], R[5]};
  const double mag = R[3];
  // A revolution's G(v) = int rho |C'| from the profile's first break, by span from the breaks (cumulative there).
  std::vector<double> gb, gv;
  std::vector<int> gm{kGaussPanels};
  Status gStatus = Status::ok;
  const cadgeom::CurveDomain pd = C->domain();
  auto g = [&](double t) {
    CurvePoint q;
    C->eval(t, 1, q);
    const Vec3 w = q.p - A, radial = w - dot(w, axis) * axis;
    return norm(radial) * norm(q.d1);
  };
  double gError = 0;
  if (!extrusion) {
    const double lo = pd.range.lo, hi = pd.period > 0 ? pd.range.lo + pd.period : pd.range.hi;
    // An unbounded profile (a line) has no breaks: G from v0.
    if (std::isfinite(lo) && std::isfinite(hi)) C->breaks({lo, hi}, gb);
    else gb = {v0};
    gv.assign(gb.size(), 0);
    gm.assign(gb.size(), kGaussPanels);
    for (size_t k = 0; k + 1 < gb.size(); k++) {
      Estimate e = cadgeom::quadrature::integrate(g, gb[k], gb[k + 1], absTol, options.relTol);
      gv[k + 1] = gv[k] + e.value, gError += e.error;
      if (e.status != Status::ok && gStatus == Status::ok) gStatus = e.status;
      // The fixed rule's panels for this span: doubled until it gives the span's integral within its tolerance.
      const double tol = std::fmax(absTol, options.relTol * std::fabs(e.value)) + e.error;
      while (gm[k] < kMaxGaussPanels && std::fabs(gauss(g, gb[k], gb[k + 1], gm[k]) - e.value) > tol) gm[k] *= 2;
      if (std::fabs(gauss(g, gb[k], gb[k + 1], gm[k]) - e.value) > tol && gStatus == Status::ok) {
        gStatus = Status::noConvergence;
      }
    }
  }
  auto G = [&](double v) {
    double shift = 0;
    if (pd.period > 0) {
      const double k = std::floor((v - gb.front()) / pd.period);
      shift = k * gv.back(), v -= k * pd.period;
    }
    size_t k = 0;
    while (k + 2 < gb.size() && gb[k + 1] <= v) k++;
    // A fixed rule from the break, its nodes moving with v, so G is as smooth in v as the profile (an adaptive one's
    // result jumps as its subdivision changes, noise the integral of H du can't converge through).
    return shift + gv[k] + gauss(g, gb[k], v, gm[k]);
  };
  const double g0 = extrusion ? 0 : G(v0);
  auto H = [&](Vec2 uv) {
    if (extrusion) {
      CurvePoint q;
      C->eval(uv.x, 1, q);
      return -(uv.y - v0) * mag * norm(cross(q.d1, D));
    }
    return -(G(uv.y) - g0);
  };

  SweptTotals T = sweptIntegral(*this, F, 1, [&](double u, double v, double* out) { *out = H({u, v}); },
    {F.size * F.size}, options.relTol);
  if (T.failed) return fail(Status::invalidModel, "a p-curve not evaluated");
  double sum = T.value[0];
  Status status = T.status;
  if (gStatus != Status::ok && status == Status::ok) status = gStatus;
  if (!extrusion && poleV.size() >= 2) {
    // Closed in v by two poles (a sphere's like): the area is known modulo the whole surface's, as an elementary
    // sphere's is (area_closed.cpp), and past half of it flagged.
    double lo = poleV[0], hi = poleV[0];
    for (double p : poleV) lo = std::fmin(lo, p), hi = std::fmax(hi, p);
    const double whole = 2 * M_PI * std::fabs(G(hi) - G(lo));
    sum = std::fmod(std::fmod(sum, whole) + whole, whole);
    if (sum > whole / 2 * (1 + 1e-9)) m.flags |= flagSphereSide;
  } else if (sum < 0) {
    m.flags |= flagOrientation;
    sum = -sum;
  }
  // G's own error enters every H: times the loops' extent in u.
  m.area = {sum, T.error[0] + gError * (T.spanU + std::fabs(F.windU) * F.Pu), status};
  return m;
}

} // namespace cadoracle
