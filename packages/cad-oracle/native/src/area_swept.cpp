// Areas of faces on extrusions and revolutions: Green's theorem in (u, v), area = oint H du with dH/dv = -|S_u x S_v|,
// H closed in the profile C. An extrusion S = C(u) + v m D has |S_u x S_v| = m |C'(u) x D|, so H = -(v - v0) m
// |C'(u) x D|; a revolution (u the angle, v the profile's parameter) has |S_u x S_v| = rho(v) |C'(v)|, rho the
// profile's distance from the axis, so H = -(G(v) - G(v0)) with G a 1D integral along the profile (Gauss-Kronrod from
// the profile's breaks). v isn't periodic on either but for a revolution of a closed profile, so H du is one form on
// the surface and a seam needs no term. The boundary is the face API's loops in (u, v) (cg_face_pieces: the face on
// each piece's left, its sense applied; p-curves given, else its projection, flagged), each loop unwrapped piece to
// piece by whole periods; a gap left between pieces (the face API closes loops along pole rows without a piece) is
// run straight in (u, v). A face whose loops wind the angle in all bounds a pole row: v0 is put on the pole on the
// face's side (the left of a loop running +u is +v), where G - G(v0) is 0; with no such pole the face is flagged.

#include <algorithm>
#include <cmath>
#include <vector>

#include "cad_geom/numerics.h"
#include "geom_api.h"
#include "oracle_impl.h"

namespace cadoracle {

using cadgeom::CurvePoint;
using cadgeom::Vec2;

namespace {

/** A piece of a loop in (u, v): its coedge between p-curve parameters, the whole periods added to it. */
struct Piece {
  int coedge, loop;
  double t0, t1;
  double ou = 0, ov = 0;
};

/** How many times a span that doesn't converge is bisected at most (integrateSplit). */
constexpr int kBisections = 12;
/** Gauss-Legendre panels G starts from per span of the profile, and at most. */
constexpr int kGaussPanels = 2, kMaxGaussPanels = 256;

/** 16-point Gauss-Legendre's nodes on [-1, 1] and weights, by Newton on the Legendre polynomial. */
struct Gauss16 {
  double x[16], w[16];
  Gauss16() {
    const int n = 16;
    for (int i = 0; i < n; i++) {
      double z = std::cos(M_PI * (i + 0.75) / (n + 0.5)), dp = 0;
      for (int it = 0; it < 100; it++) {
        double p0 = 1, p1 = z;
        for (int k = 2; k <= n; k++) {
          const double p2 = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k;
          p0 = p1, p1 = p2;
        }
        dp = n * (z * p1 - p0) / (z * z - 1);
        const double dz = p1 / dp;
        z -= dz;
        if (std::fabs(dz) < 1e-16) break;
      }
      x[i] = z, w[i] = 2 / ((1 - z * z) * dp * dp);
    }
  }
};
const Gauss16 kGauss16;

/** The integral of f over [a, b] by m equal panels of 16-point Gauss-Legendre. */
/**
 * The integral of f over [a, b] by quadrature::integrate, bisected where it doesn't converge (up to kBisections
 * deep): a projected p-curve is fitted in pieces whose joints are kinks, or tiny jumps, at parameters the caller
 * doesn't know, and each bisection confines one to a span half as long.
 */
template <class F>
Estimate integrateSplit(const F& f, double a, double b, double absTol, double relTol, int depth = 0) {
  Estimate e = cadgeom::quadrature::integrate(f, a, b, absTol, relTol);
  if (e.status != Status::noConvergence || depth >= kBisections) return e;
  const double m = (a + b) / 2;
  Estimate l = integrateSplit(f, a, m, absTol / 2, relTol, depth + 1);
  Estimate r = integrateSplit(f, m, b, absTol / 2, relTol, depth + 1);
  return {l.value + r.value, l.error + r.error,
    l.status != Status::ok ? l.status : r.status};
}

template <class F> double gauss(const F& f, double a, double b, int m) {
  const double h = (b - a) / m;
  double sum = 0;
  for (int j = 0; j < m; j++) {
    const double c = a + (j + 0.5) * h;
    for (int i = 0; i < 16; i++) sum += kGauss16.w[i] * f(c + kGauss16.x[i] * h / 2);
  }
  return sum * h / 2;
}

} // namespace

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

  double info[7];
  if (int32_t r = cg_face_info(h, f, NAN, info)) return fail(Status::invalidModel, faceStatusWhy(r));
  const double Pu = info[1], Pv = info[2];
  std::vector<double> poleV;
  {
    const double* sc = cg_scratch();
    for (int i = 0; i < static_cast<int>(info[4]); i++)
      if (sc[2 * i] == 0) poleV.push_back(sc[2 * i + 1]);
  }
  if (info[6] > 0) m.flags |= flagProjectedBoundary;
  const int32_t np = cg_face_pieces(h, f);
  if (np < 0) return fail(Status::invalidModel, faceStatusWhy(-np));
  std::vector<int> loopOf(model.coedges(), -1);
  for (int l = model.faceFirstLoop(f); l < model.faceFirstLoop(f) + model.faceLoopCount(f); l++)
    for (int k = model.loopFirst(l); k < model.loopFirst(l) + model.loopCount(l); k++)
      if (model.loopKind(l) == CBR_LOOP_EDGE) loopOf[k] = l;
  std::vector<Piece> pieces;
  {
    const double* sc = cg_scratch();
    for (int i = 0; i < np; i++) {
      const int c = static_cast<int>(sc[3 * i]);
      pieces.push_back({c, c >= 0 && c < model.coedges() ? loopOf[c] : -1, sc[3 * i + 1], sc[3 * i + 2]});
    }
  }
  if (pieces.empty()) {
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

  // (u, v) and (u', v') on a piece, its periods added.
  bool evalFailed = false;
  auto at = [&](const Piece& p, double t, Vec2& uv, Vec2& d) {
    double out[6];
    uint8_t st = 0;
    if (cg_coedge_eval(h, p.coedge, &t, 1, 1, out, &st) != 0 || st != 0) evalFailed = true;
    uv = {out[0] + p.ou, out[1] + p.ov}, d = {out[3], out[4]};
  };
  // Each loop's pieces unwrapped: a piece's start brought within half a period of the previous piece's end.
  auto reduce = [](double d, double period) { return period > 0 ? period * std::round(d / period) : 0.0; };
  double windU = 0, windV = 0;
  for (size_t i = 0; i < pieces.size(); i++) {
    Vec2 a, b, d;
    const bool first = i == 0 || pieces[i - 1].loop != pieces[i].loop;
    if (!first) {
      at(pieces[i - 1], pieces[i - 1].t1, b, d);
      at(pieces[i], pieces[i].t0, a, d);
      pieces[i].ou = reduce(b.x - a.x, Pu), pieces[i].ov = reduce(b.y - a.y, Pv);
    }
    const bool last = i + 1 == pieces.size() || pieces[i + 1].loop != pieces[i].loop;
    if (last) {
      size_t j = i;
      while (j > 0 && pieces[j - 1].loop == pieces[i].loop) j--;
      at(pieces[i], pieces[i].t1, b, d);
      at(pieces[j], pieces[j].t0, a, d);
      // The whole periods a loop closes across are its winding.
      windU += Pu > 0 ? std::round((b.x - a.x) / Pu) : 0;
      windV += Pv > 0 ? std::round((b.y - a.y) / Pv) : 0;
    }
  }
  if (evalFailed) return fail(Status::invalidModel, "a p-curve not evaluated");
  if (windV != 0) m.flags |= flagWinds;

  // H(u, v), and v0.
  const Vec3 D{R[0], R[1], R[2]}, A{R[0], R[1], R[2]}, axis{R[3], R[4], R[5]};
  const double mag = R[3];
  // An absolute tolerance from the face's size (its edges' vertices' box), for integrals that cancel to about 0.
  Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
  for (const Piece& p : pieces) {
    const int e = model.coedgeEdge(p.coedge);
    for (int v : {model.edgeStart(e), model.edgeEnd(e)}) {
      if (v < 0) continue;
      const Vec3 q = model.vertexPoint(v);
      lo = {std::fmin(lo.x, q.x), std::fmin(lo.y, q.y), std::fmin(lo.z, q.z)};
      hi = {std::fmax(hi.x, q.x), std::fmax(hi.y, q.y), std::fmax(hi.z, q.z)};
    }
  }
  const double size = std::isfinite(lo.x) ? norm(hi - lo) : 1;
  // (Raised below to the scale H's integrals add up from, once H is known.)
  double absTol = options.relTol * size * size;
  Vec2 start, d0;
  at(pieces[0], pieces[0].t0, start, d0);
  // v0 on a pole where there is one, so H is 0 along it and the loop's run along that pole row (the way round it
  // goes is ambiguous by a turn) adds nothing, and a face bounded by loops winding the angle and that pole needs no
  // term for it. With a second pole, the same ambiguity there, and a winding face's pole being the other one, are
  // multiples of the whole surface's area: reduced modulo it below.
  double v0 = start.y;
  if (!extrusion && poleV.empty() && model.curveKind(model.surfaceInts(s)[0]) == CBR_CURVE_LINE) {
    // A line through the axis is a pole cad-geom doesn't list (the line's domain is unbounded): where its distance
    // from the axis, linear in t, vanishes.
    CurvePoint q;
    C->eval(0, 1, q);
    const Vec3 Ax{R[0], R[1], R[2]}, ax{R[3], R[4], R[5]}, w = q.p - Ax;
    const Vec3 w0 = w - dot(w, ax) * ax, d = q.d1 - dot(q.d1, ax) * ax;
    const double dd = dot(d, d);
    if (dd > 0) {
      const double t = -dot(w0, d) / dd;
      if (norm(w0 + t * d) <= 1e-9 * (norm(w0) + norm(d))) poleV.push_back(t);
    }
  }
  if (!extrusion && !poleV.empty()) v0 = poleV[0];
  if (windU != 0 && (extrusion || poleV.empty())) m.flags |= flagWinds;
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

  // The scale the loops' integrals add up from: a turn (or the loops' extent in u) at H's largest at the pieces' ends.
  {
    double hMax = 0, uMin = INFINITY, uMax = -INFINITY;
    for (const Piece& p : pieces) {
      for (double t : {p.t0, p.t1}) {
        Vec2 uv, d;
        at(p, t, uv, d);
        hMax = std::fmax(hMax, std::fabs(H(uv)));
        uMin = std::fmin(uMin, uv.x), uMax = std::fmax(uMax, uv.x);
      }
    }
    absTol = std::fmax(absTol, options.relTol * hMax * std::fmax(uMax - uMin, Pu));
  }
  double sum = 0, error = 0, spanU = 0;
  Status status = Status::ok;
  auto add = [&](const Estimate& e) {
    sum += e.value, error += e.error;
    if (e.status != Status::ok && status == Status::ok) status = e.status;
  };
  // A straight run from a to b in (u, v).
  auto segment = [&](Vec2 a, Vec2 b) {
    if (norm(b - a) <= 1e-12 * (1 + norm(a))) return;
    add(cadgeom::quadrature::integrate([&](double x) { return H(a + x * (b - a)) * (b.x - a.x); }, 0, 1, absTol,
      options.relTol));
  };
  for (size_t i = 0; i < pieces.size(); i++) {
    const Piece& p = pieces[i];
    std::vector<double> br;
    const int pc = model.coedgePcurve(p.coedge);
    // Cut where the p-curve is less smooth: its own breaks, or a projection's, which is in its edge's curve's
    // parameter, that curve's (an extrusion's profile copy: the profile's knots, where C' and so H may kink).
    const Range span{std::fmin(p.t0, p.t1), std::fmax(p.t0, p.t1)};
    const Curve* own = pc >= 0 ? curve(pc) : curve(model.edgeCurve(model.coedgeEdge(p.coedge)));
    if (own) own->breaks(span, br);
    else br = {span.lo, span.hi};
    if (p.t1 < p.t0) std::reverse(br.begin(), br.end());
    for (size_t k = 0; k + 1 < br.size(); k++) {
      add(integrateSplit([&](double t) {
        Vec2 uv, d;
        at(p, t, uv, d);
        return H(uv) * d.x;
      }, br[k], br[k + 1], absTol, options.relTol));
    }
    // The gap to the next piece of the loop (or back to its first), less whole periods.
    size_t j = i + 1;
    if (j == pieces.size() || pieces[j].loop != p.loop) {
      j = i;
      while (j > 0 && pieces[j - 1].loop == p.loop) j--;
    }
    Vec2 a, b, d, s0;
    at(p, p.t1, a, d);
    at(p, p.t0, s0, d);
    spanU += std::fabs(a.x - s0.x);
    at(pieces[j], pieces[j].t0, b, d);
    b = {b.x + reduce(a.x - b.x, Pu), b.y + reduce(a.y - b.y, Pv)};
    segment(a, b);
  }
  if (evalFailed) return fail(Status::invalidModel, "a p-curve not evaluated");
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
  m.area = {sum, error + gError * (spanU + std::fabs(windU) * Pu), status};
  return m;
}

} // namespace cadoracle
