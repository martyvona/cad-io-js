// The free-form engine (free.h says how the integral works) and the area through it (|n| its one component).

#include "free.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <vector>

#include "cad_geom/numerics.h"
#include "cad_geom/surface.h"
#include "geom_api.h"
#include "quad.h"
#include "swept.h"

namespace cadoracle {

using cadgeom::Range;
using cadgeom::SurfaceDomain;
using cadgeom::SurfacePoint;
using cadgeom::Vec2;

namespace {

/** Samples per span of a segment's breaks, where it's searched for crossings of rows and of the outer breaks. */
constexpr int kCrossSamples = 16;
/** Bisections of a crossing's parameter at most. */
constexpr int kCrossBisections = 60;
/** Bands at most (doubled from 4) where H's strips aren't sound. */
constexpr int kMaxBands = 64;
/** A gap runs along a pole row where its ends' b are within this of the row's, relative to the loops' extent in b. */
constexpr double kOnRow = 1e-7;
/** Points per segment for the loops' samples (their extent, the inner rule's panels, the floors). */
constexpr int kSamples = 8;

/** A piece of a loop in (u, v): a piece of the face API's, or a straight gap from A to B (parameter 0 to 1). */
struct Seg {
  int loop = 0;
  bool straight = false;
  SweptPiece piece{};
  Vec2 A, B;
  double lo() const { return straight ? 0 : piece.t0; }
  double hi() const { return straight ? 1 : piece.t1; }
};

/** The frame (a, t): a the outer parameter, t = (b - b0) dir the inner one from b0. */
struct Frame {
  bool swap = false;
  double b0 = 0, dir = 1;
  Vec2 ab(Vec2 uv) const { return swap ? Vec2{uv.y, uv.x} : uv; }
  Vec2 uvOf(double a, double t) const {
    const double b = b0 + dir * t;
    return swap ? Vec2{b, a} : Vec2{a, b};
  }
};

/** A point of a segment in the frame: (a, t) and their rates. */
struct At {
  double a = 0, t = 0, da = 0, dt = 0;
};

/** A row's crossing by a loop: where in a (reduced into a period where a is periodic), and its way (+1 up in t). */
struct Crossing {
  double a;
  int s;
};

} // namespace

FreeTotals freeIntegral(Oracle::Impl& I, int f, int K, int area,
  const std::function<void(Vec3 p, Vec3 n, double* out)>& fn,
  const std::function<std::vector<double>(const Inner& in, const std::vector<std::array<double, 3>>& samples)>&
    floorFor,
  double relTol) {
  FreeTotals T;
  T.value.assign(K, 0), T.error.assign(K, 0);
  auto fail = [&](Status st, const char* why) {
    T.status = st, T.why = why;
    return T;
  };
  const Model& model = I.model;
  const int s = model.faceSurface(f);
  Status st = Status::ok;
  std::unique_ptr<cadgeom::Surface> S = cadgeom::makeSurface(model, s, st);
  if (!S) return fail(st == Status::ok ? Status::invalidModel : st, "a surface kind not supported");
  const double tol = I.tols.face(f);
  S = cadgeom::closeInFact(std::move(S), tol);
  // An offset folds where its normal turns against its basis's: H's strips must not cross such a place.
  std::unique_ptr<cadgeom::Surface> basis;
  if (model.surfaceKind(s) == CBR_SURFACE_OFFSET) {
    basis = cadgeom::makeSurface(model, model.surfaceInts(s)[0], st);
    if (basis) basis = cadgeom::closeInFact(std::move(basis), tol);
  }
  double info[16];
  if (int32_t r = cg_face_info(I.h, f, NAN, info)) return fail(Status::invalidModel, faceStatusWhy(r));
  const double Pu = info[1], Pv = info[2];
  std::vector<double> poleU, poleV;
  {
    const double* sc = cg_scratch();
    for (int i = 0; i < static_cast<int>(info[4]); i++) (sc[2 * i] == 0 ? poleV : poleU).push_back(sc[2 * i + 1]);
  }
  if (info[6] > 0) T.flags |= flagProjectedBoundary;
  if (info[7] + info[8] > 0) T.flags |= flagEdgesPlaced;
  const SurfaceDomain dom = S->domain();
  Frame fr;
  fr.swap = Pv > 0 && !(Pu > 0);
  const double Pa = fr.swap ? Pv : Pu, Pb = fr.swap ? Pu : Pv;
  const Range ra = fr.swap ? dom.v : dom.u, rb = fr.swap ? dom.u : dom.v;
  std::vector<double> poles = fr.swap ? poleU : poleV;
  std::sort(poles.begin(), poles.end());
  // The face is on each piece's left in (u, v); swapped, on its right in (a, b).
  const double sigma = fr.swap ? -1 : 1;
  // The surface's breaks: the outer direction's split the loops, the inner direction's cut H's rule.
  std::vector<double> aBreaks, bBreaks;
  {
    std::vector<double> us, vs;
    S->breaks(dom.u, dom.v, us, vs);
    for (double x : fr.swap ? vs : us)
      if (std::isfinite(x)) aBreaks.push_back(x);
    for (double x : fr.swap ? us : vs)
      if (std::isfinite(x)) bBreaks.push_back(x);
  }

  bool bad = false;
  Inner in;
  in.K = K;
  in.F = [&](double a, double t, double* o) {
    // Once a strip isn't sound the run is thrown away (bands follow): cut it short, not through the fold.
    if (bad) {
      std::fill(o, o + K, 0.0);
      return;
    }
    const Vec2 uv = fr.uvOf(a, t);
    SurfacePoint q;
    if (S->eval(uv.x, uv.y, 1, q) == Status::singular) bad = true;
    const Vec3 n = cross(q.du, q.dv);
    if (basis) {
      SurfacePoint qb;
      if (basis->eval(uv.x, uv.y, 1, qb) == Status::ok && dot(n, cross(qb.du, qb.dv)) <= 0) bad = true;
    }
    fn(q.p, n, o);
  };
  in.P = [&](double a, double t) {
    const Vec2 uv = fr.uvOf(a, t);
    SurfacePoint q;
    S->eval(uv.x, uv.y, 0, q);
    return q.p;
  };
  // H's cuts: the inner direction's breaks in t, over a turn either side where it's periodic.
  auto setCuts = [&](double tLo, double tHi) {
    in.cuts.clear();
    for (double x : bBreaks) {
      const double t = (x - fr.b0) * fr.dir;
      if (Pb > 0) {
        for (double k = std::floor((tLo - t) / Pb) - 1; k <= std::ceil((tHi - t) / Pb) + 1; k++) {
          in.cuts.push_back(t + k * Pb);
        }
      } else {
        in.cuts.push_back(t);
      }
    }
  };
  // The integral over [a0, a1] of g(a, out), per component, cut at the outer direction's breaks (where F kinks
  // along a), the components' rules sharing their nodes.
  auto alongA = [&](const std::function<void(double a, double* o)>& g, double a0, double a1,
    const std::vector<double>& absTol, std::vector<Estimate>& out) {
    std::vector<double> ends{a0, a1};
    for (double x : aBreaks) {
      if (Pa > 0) {
        for (double k = std::ceil((a0 - x) / Pa); x + k * Pa < a1; k++) ends.push_back(x + k * Pa);
      } else if (x > a0 && x < a1) {
        ends.push_back(x);
      }
    }
    std::sort(ends.begin(), ends.end());
    ends.erase(std::unique(ends.begin(), ends.end()), ends.end());
    Memo memo(K);
    out.assign(K, Estimate{0, 0, Status::ok});
    for (int c = 0; c < K; c++) {
      for (size_t k = 0; k + 1 < ends.size(); k++) {
        // The tolerance shared out by length, so the spans' errors sum to it.
        const Estimate e = integrateSplit([&](double a) { return memo.at(a, g)[c]; }, ends[k], ends[k + 1],
          absTol[c] * (ends[k + 1] - ends[k]) / (a1 - a0), relTol);
        out[c].value += e.value, out[c].error += e.error;
        if (e.status != Status::ok && out[c].status == Status::ok) out[c].status = e.status;
      }
    }
  };

  const LoopPieces L = loopPieces(I, f, Pu, Pv);
  if (*L.why) return fail(L.status, L.why);

  if (L.pieces.empty()) {
    // Bounded by nothing: the whole surface where its domain is finite (or periodic) both ways; else unbounded.
    const double a0 = ra.lo, a1 = Pa > 0 ? ra.lo + Pa : ra.hi, b1 = Pb > 0 ? rb.lo + Pb : rb.hi;
    if (!std::isfinite(a0) || !std::isfinite(a1) || !std::isfinite(rb.lo) || !std::isfinite(b1)) {
      T.flags |= flagNoLoops;
      return T;
    }
    fr.b0 = rb.lo, fr.dir = 1;
    const double t1 = b1 - rb.lo;
    setCuts(0, t1);
    std::vector<std::array<double, 3>> samples;
    for (int i = 0; i <= kSamples; i++)
      for (int j = 0; j <= kSamples; j++) samples.push_back({a0 + (a1 - a0) * i / kSamples, 0, t1 * j / kSamples});
    const std::vector<double> fl = floorFor(in, samples);
    std::vector<double> innerErr(K), absTol(K);
    const int m = innerPanels(in, {{a0 + 0.3 * (a1 - a0), 0, t1}, {a0 + 0.7 * (a1 - a0), 0, t1}}, relTol, fl,
      innerErr);
    for (int c = 0; c < K; c++) absTol[c] = relTol * fl[c];
    std::vector<Estimate> w;
    alongA([&](double a, double* o) {
      in.H(a, t1, 0, m, o);
    }, a0, a1, absTol, w);
    for (int c = 0; c < K; c++) {
      T.value[c] = w[c].value, T.error[c] = w[c].error + innerErr[c] * (a1 - a0);
      if (w[c].status != Status::ok && T.status == Status::ok) T.status = w[c].status;
    }
    return T;
  }

  // The loops as segments: each piece, then the gap to the next piece of its loop (or back to its first) less whole
  // periods, run straight in (u, v).
  std::vector<Seg> segs;
  std::vector<double> windA, windB;
  {
    bool ok = true;
    const auto& P = L.pieces;
    int loop = 0;
    for (size_t i = 0; i < P.size(); i++) {
      if (i > 0 && P[i].loop != P[i - 1].loop) loop++;
      Seg g;
      g.loop = loop, g.piece = P[i];
      segs.push_back(g);
      size_t j = i + 1;
      if (j == P.size() || P[j].loop != P[i].loop) {
        j = i;
        while (j > 0 && P[j - 1].loop == P[i].loop) j--;
      }
      Vec2 a, b, d;
      ok &= pieceAt(I.h, P[i], P[i].t1, a, d);
      ok &= pieceAt(I.h, P[j], P[j].t0, b, d);
      b = {b.x + reducePeriods(a.x - b.x, Pu), b.y + reducePeriods(a.y - b.y, Pv)};
      if (norm(b - a) > 1e-12 * (1 + norm(a))) {
        Seg gap;
        gap.loop = loop, gap.straight = true, gap.A = a, gap.B = b;
        segs.push_back(gap);
      }
    }
    if (!ok) return fail(Status::invalidModel, "a p-curve not evaluated");
    for (size_t l = 0; l < L.windU.size(); l++) {
      windA.push_back(fr.swap ? L.windV[l] : L.windU[l]), windB.push_back(fr.swap ? L.windU[l] : L.windV[l]);
    }
  }
  bool ok = true;
  auto segAt = [&](const Seg& g, double x, Vec2& uv, Vec2& d) {
    if (g.straight) {
      uv = g.A + x * (g.B - g.A), d = g.B - g.A;
      return;
    }
    ok &= pieceAt(I.h, g.piece, x, uv, d);
  };
  auto at = [&](const Seg& g, double x) {
    Vec2 uv, d;
    segAt(g, x, uv, d);
    const Vec2 ab = fr.ab(uv), dab = fr.ab(d);
    return At{ab.x, (ab.y - fr.b0) * fr.dir, dab.x, dab.y * fr.dir};
  };
  // The loops' samples in (a, b).
  double bLo = INFINITY, bHi = -INFINITY, aLo = INFINITY, aHi = -INFINITY;
  std::vector<Vec2> abSamples;
  for (const Seg& g : segs) {
    for (int j = 0; j <= kSamples; j++) {
      Vec2 uv, d;
      segAt(g, j == kSamples ? g.hi() : g.lo() + (g.hi() - g.lo()) * j / kSamples, uv, d);
      const Vec2 ab = fr.ab(uv);
      abSamples.push_back(ab);
      bLo = std::fmin(bLo, ab.y), bHi = std::fmax(bHi, ab.y), aLo = std::fmin(aLo, ab.x), aHi = std::fmax(aHi, ab.x);
    }
  }
  if (!ok) return fail(Status::invalidModel, "a p-curve not evaluated");
  // Each coedge's ends on the surface against its edge's vertices (either way round: a run of pieces that comes back
  // to where it started is off at one end whichever), over the loops' size (their points' box).
  {
    Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
    for (const Vec2& p : abSamples) {
      const Vec2 uv = fr.swap ? Vec2{p.y, p.x} : p;
      SurfacePoint q;
      S->eval(uv.x, uv.y, 0, q);
      lo = {std::fmin(lo.x, q.p.x), std::fmin(lo.y, q.p.y), std::fmin(lo.z, q.p.z)};
      hi = {std::fmax(hi.x, q.p.x), std::fmax(hi.y, q.p.y), std::fmax(hi.z, q.p.z)};
    }
    const double size = norm(hi - lo);
    auto surf = [&](const SweptPiece& p, double t) {
      Vec2 uv, d;
      pieceAt(I.h, p, t, uv, d);
      SurfacePoint q;
      S->eval(uv.x, uv.y, 0, q);
      return q.p;
    };
    const auto& P = L.pieces;
    double worst = NAN;
    for (size_t i = 0; i < P.size();) {
      size_t j = i;
      while (j + 1 < P.size() && P[j + 1].coedge == P[i].coedge && P[j + 1].loop == P[i].loop) j++;
      const int e = model.coedgeEdge(P[i].coedge), vs = model.edgeStart(e), ve = model.edgeEnd(e);
      if (vs >= 0 && ve >= 0) {
        const Vec3 a = surf(P[i], P[i].t0), b = surf(P[j], P[j].t1);
        const Vec3 A = model.vertexPoint(vs), B = model.vertexPoint(ve);
        const double off = std::fmin(std::fmax(norm(a - A), norm(b - B)), std::fmax(norm(a - B), norm(b - A)));
        if (!(worst >= off)) worst = off;
      }
      i = j + 1;
    }
    if (std::isfinite(worst) && size > 0) {
      T.offSurface = worst / size;
      if (T.offSurface > kOffSurface) T.flags |= flagOffSurface;
    }
  }

  // b0 and the way t runs; whether the result is known modulo the whole surface's, and its inner extent then.
  double wEff = 0;
  for (double w : windA) wEff += sigma * w;
  bool modulo = false;
  double whole0 = 0, whole1 = 0;
  const double bSpan = std::fmax(bHi - bLo, 1e-300);
  if (Pb > 0) {
    // Both periodic: the cut in the middle of the largest gap between the loops' b, reduced into a period.
    std::vector<double> r;
    for (const Vec2& p : abSamples) r.push_back(p.y - Pb * std::floor((p.y - rb.lo) / Pb));
    std::sort(r.begin(), r.end());
    // Near the gap's top, just below the face's lowest b there, so H's strips stay short (a cut far from the face
    // makes the loops' integrals large and cancelling).
    double best = r.front() + Pb - r.back(), c = r.front() - best / 64;
    for (size_t i = 0; i + 1 < r.size(); i++) {
      if (r[i + 1] - r[i] > best) best = r[i + 1] - r[i], c = r[i + 1] - best / 64;
    }
    fr.b0 = c, fr.dir = 1;
    modulo = true, whole0 = 0, whole1 = Pb;
  } else {
    const double eps = kOnRow * (bSpan + std::fabs(bLo) + std::fabs(bHi));
    double top = NAN, bottom = NAN;
    for (double p : poles) {
      if (p >= bHi - eps && !(top <= p)) top = p;
      if (p <= bLo + eps && !(bottom >= p)) bottom = p;
    }
    fr.b0 = bLo, fr.dir = 1;
    if (std::fabs(wEff) > 1.5) {
      T.flags |= flagWinds;
    } else if (wEff > 0.5) {
      if (std::isfinite(top)) fr.b0 = top, fr.dir = -1;
      else T.flags |= flagWinds;
    } else if (wEff < -0.5) {
      if (std::isfinite(bottom)) fr.b0 = bottom;
      else T.flags |= flagWinds;
    }
    if (Pa > 0 && poles.size() >= 2 && poles.back() - poles.front() > eps) {
      modulo = true;
      whole0 = (poles.front() - fr.b0) * fr.dir, whole1 = (poles.back() - fr.b0) * fr.dir;
      if (whole0 > whole1) std::swap(whole0, whole1);
    }
  }
  const double sigmaT = sigma * fr.dir;
  double tLo = INFINITY, tHi = -INFINITY;
  for (const Vec2& p : abSamples) {
    const double t = (p.y - fr.b0) * fr.dir;
    tLo = std::fmin(tLo, t), tHi = std::fmax(tHi, t);
  }
  setCuts(std::fmin(tLo, whole0), std::fmax(tHi, whole1));
  // The outer breaks as rows of a, over the loops' extent (and a turn either side where a is periodic).
  std::vector<double> aRows;
  for (double x : aBreaks) {
    if (Pa > 0) {
      for (double k = std::floor((aLo - x) / Pa) - 1; k <= std::ceil((aHi - x) / Pa) + 1; k++) {
        aRows.push_back(x + k * Pa);
      }
    } else {
      aRows.push_back(x);
    }
  }
  std::sort(aRows.begin(), aRows.end());
  auto reduceA = [&](double a) { return Pa > 0 ? a - Pa * std::floor((a - ra.lo) / Pa) : a; };

  // One evaluation with n bands (1: the plain method; free.h).
  struct Run {
    std::vector<double> value, error;
    Status status = Status::ok;
    const char* why = "";
  };
  auto run = [&](int n) {
    Run R;
    R.value.assign(K, 0), R.error.assign(K, 0);
    auto add = [&](int c, const Estimate& e, double sign) {
      R.value[c] += sign * e.value, R.error[c] += e.error;
      if (e.status != Status::ok && R.status == Status::ok) R.status = e.status;
    };
    const double tFar = std::fmax(tHi, 0);
    // Bands' rows away from the loops' extreme rows (an iso-row of the boundary there).
    const double delta = Pb > 0 ? Pb / n : n > 1 ? tFar / (n - 0.381966) : INFINITY;
    auto bandOf = [&](double t) {
      if (n == 1 && !(Pb > 0)) return 0.0;
      const double q = std::floor(t / delta);
      return Pb > 0 ? q : std::clamp(q, 0.0, n - 1.0);
    };
    auto bottom = [&](double q) { return q == 0 ? 0.0 : q * delta; };
    // Rows of t crossed by the loops: the cut's copies, and the bands' rows.
    std::vector<double> tRows;
    if (Pb > 0) {
      for (double q = std::floor(tLo / delta) - 1; q <= std::ceil(tHi / delta) + 1; q++) tRows.push_back(q * delta);
    } else {
      for (int q = 1; q < n; q++) tRows.push_back(q * delta);
    }
    // Samples for the inner rule's panels and the floors: (a, the band's bottom, t).
    std::vector<std::array<double, 3>> samples;
    for (const Vec2& p : abSamples) {
      const double t = (p.y - fr.b0) * fr.dir;
      samples.push_back({p.x, bottom(bandOf(t)), t});
    }
    const std::vector<double> fl = floorFor(in, samples);
    std::vector<double> innerErr(K);
    const int m = innerPanels(in, samples, relTol, fl, innerErr);
    std::vector<double> absTol(K), hv(K), hMax(K, 0);
    for (const auto& q : samples) {
      in.H(q[0], q[1], q[2], m, hv.data());
      for (int c = 0; c < K; c++) hMax[c] = std::fmax(hMax[c], std::fabs(hv[c]));
    }
    // Never finer than H itself: the inner rule's error over the loops' extent in a (which the result's error
    // carries), else the outer rule chases its unevenness where F nearly kinks (a patch nearly folding).
    for (int c = 0; c < K; c++) {
      absTol[c] = std::fmax(relTol * std::fmax(fl[c], hMax[c] * std::fmax(aHi - aLo, Pa)),
        2 * innerErr[c] * (aHi - aLo));
    }
    double aTravel = 0;
    // Each loop: its segments split where they cross a row (of a or t) or a break of their own, each piece
    // integrated on its band's H; where the band changes, the rows between are crossed.
    std::map<double, std::vector<Crossing>> crossings;
    size_t i0 = 0;
    while (i0 < segs.size()) {
      size_t i1 = i0;
      while (i1 < segs.size() && segs[i1].loop == segs[i0].loop) i1++;
      double firstQ = NAN, lastQ = NAN, lastA = 0;
      auto cross = [&](double q1, double q2, double a) {
        const int sgn = q2 > q1 ? 1 : -1;
        for (double q = std::fmin(q1, q2) + 1; q <= std::fmax(q1, q2); q++) {
          const double row = Pb > 0 ? q - n * std::floor(q / n) : q;
          crossings[row].push_back({reduceA(a), sgn});
        }
      };
      for (size_t i = i0; i < i1; i++) {
        const Seg& g = segs[i];
        std::vector<double> br;
        if (g.straight) {
          br = {0, 1};
        } else {
          const Range span{std::fmin(g.piece.t0, g.piece.t1), std::fmax(g.piece.t0, g.piece.t1)};
          // Where the p-curve is less smooth: its own breaks, or a projection's pieces' (a fit's knots) and its edge's
          // curve's (the projection is in that curve's parameter, and kinks where the curve does).
          const int32_t nb = cg_coedge_breaks(I.h, g.piece.coedge, span.lo, span.hi);
          if (nb >= 2) br.assign(cg_scratch(), cg_scratch() + nb);
          else br = {span.lo, span.hi};
          if (model.coedgePcurve(g.piece.coedge) < 0) {
            if (const Curve* own = I.curve(model.edgeCurve(model.coedgeEdge(g.piece.coedge)))) {
              std::vector<double> more;
              own->breaks(span, more);
              for (double x : more) br.push_back(std::clamp(x, span.lo, span.hi));
              std::sort(br.begin(), br.end());
              br.erase(std::unique(br.begin(), br.end()), br.end());
            }
          }
          if (g.piece.t1 < g.piece.t0) std::reverse(br.begin(), br.end());
        }
        // Split points: the breaks, and where a row of a or t lies between two samples' coordinates (bisected).
        std::vector<double> cuts = br;
        auto rowsBetween = [&](const std::vector<double>& rows, double x1, double x2, auto&& coord, double y1,
          double y2) {
          const double lo = std::fmin(x1, x2), hi = std::fmax(x1, x2);
          if (!(hi - lo > 1e-12 * (1 + std::fabs(lo)))) return;
          // Rows in [lo, hi] but the first sample's: a sample on a row splits there once.
          for (auto it = std::lower_bound(rows.begin(), rows.end(), lo); it != rows.end() && *it <= hi; ++it) {
            if (*it == x1) continue;
            if (*it == x2) {
              cuts.push_back(y2);
              continue;
            }
            double p = y1, q = y2, fp = x1 - *it;
            for (int k = 0; k < kCrossBisections && std::fabs(q - p) > 1e-15 * (std::fabs(p) + std::fabs(q)); k++) {
              const double mid = (p + q) / 2, fm = coord(mid) - *it;
              if ((fm < 0) == (fp < 0)) p = mid, fp = fm;
              else q = mid;
            }
            cuts.push_back((p + q) / 2);
          }
        };
        for (size_t k = 0; k + 1 < br.size(); k++) {
          At prev = at(g, br[k]);
          double xPrev = br[k];
          for (int j = 1; j <= kCrossSamples; j++) {
            const double x = j == kCrossSamples ? br[k + 1] : br[k] + (br[k + 1] - br[k]) * j / kCrossSamples;
            const At cur = at(g, x);
            rowsBetween(aRows, prev.a, cur.a, [&](double y) { return at(g, y).a; }, xPrev, x);
            rowsBetween(tRows, prev.t, cur.t, [&](double y) { return at(g, y).t; }, xPrev, x);
            prev = cur, xPrev = x;
          }
        }
        std::sort(cuts.begin(), cuts.end());
        cuts.erase(std::unique(cuts.begin(), cuts.end()), cuts.end());
        if (g.hi() < g.lo()) std::reverse(cuts.begin(), cuts.end());
        for (size_t k = 0; k + 1 < cuts.size(); k++) {
          const double x0 = cuts[k], x1 = cuts[k + 1];
          const At mid = at(g, (x0 + x1) / 2), e0 = at(g, x0), e1 = at(g, x1);
          const double q = bandOf(mid.t), t0 = bottom(q);
          aTravel += std::fabs(e1.a - e0.a);
          if (std::isnan(firstQ)) firstQ = q;
          else if (q != lastQ) cross(lastQ, q, e0.a);
          lastQ = q, lastA = e1.a;
          Memo memo(K);
          auto hda = [&](double x, double* o) {
            const At p = at(g, x);
            in.H(p.a, t0, p.t, m, o);
            for (int c = 0; c < K; c++) o[c] *= p.da;
          };
          for (int c = 0; c < K; c++) {
            add(c, integrateSplit([&](double x) { return memo.at(x, hda)[c]; }, x0, x1, absTol[c], relTol), 1);
          }
        }
      }
      // Closing the loop: its first band, the loop's winding in t's periods of bands on.
      if (!std::isnan(firstQ)) {
        const double closeQ = firstQ + (Pb > 0 ? n * fr.dir * windB[segs[i0].loop] : 0);
        if (closeQ != lastQ) cross(lastQ, closeQ, lastA);
      }
      i0 = i1;
    }
    // The rows' stretches inside the face: W, the band's inner integral below the row, along each.
    auto W = [&](double row) {
      const double top = row * delta, low = Pb > 0 || row > 1 ? (row - 1) * delta : 0;
      return [&in, top, low, m](double a, double* o) {
        in.H(a, top, low, m, o);
      };
    };
    std::vector<Estimate> e;
    const bool periodicRows = Pb > 0;
    const int rows = periodicRows ? n : n - 1;
    for (int r = 0; r < rows; r++) {
      const double row = periodicRows ? r : r + 1;
      const auto w = W(row == 0 ? n : row);
      auto it = crossings.find(row);
      if (it == crossings.end() || it->second.empty()) {
        // No crossings: outside, unless a is periodic and the row lies in the face (the face API's classification).
        if (!(Pa > 0)) continue;
        int side = -1;
        for (double frac : {0.382, 0.618, 0.146, 0.854}) {
          const Vec2 uv = fr.uvOf(ra.lo + frac * Pa, row * delta);
          double p[2] = {uv.x, uv.y}, tolUv;
          uint8_t sd = 0, sst = 0;
          if (cg_face_classify(I.h, f, p, 1, NAN, &sd, &sst, &tolUv) != 0 || sst != 0 || sd == 2) continue;
          side = sd;
          break;
        }
        if (side < 0) {
          R.status = Status::noConvergence, R.why = "a row not classified";
          continue;
        }
        if (side == 0) {
          alongA(w, ra.lo, ra.lo + Pa, absTol, e);
          for (int c = 0; c < K; c++) add(c, e[c], sigmaT);
          aTravel += Pa;
        }
        continue;
      }
      std::vector<Crossing> x = it->second;
      std::sort(x.begin(), x.end(), [](const Crossing& p, const Crossing& q) { return p.a < q.a; });
      // A stretch inside starts where the loop crosses against sigmaT's way and ends at the next crossing.
      const size_t N = x.size();
      bool alternate = N % 2 == 0;
      for (size_t k = 0; k + 1 < N && alternate; k++) alternate = x[k].s != x[k + 1].s;
      if (!alternate || (!(Pa > 0) && x[0].s == sigmaT)) {
        R.status = Status::noConvergence, R.why = "a row's crossings not paired";
        continue;
      }
      for (size_t k = 0; k < N; k++) {
        if (x[k].s == sigmaT) continue;
        const size_t j = (k + 1) % N;
        const double a0 = x[k].a, a1 = j > k ? x[j].a : x[j].a + Pa;
        alongA(w, a0, a1, absTol, e);
        for (int c = 0; c < K; c++) add(c, e[c], sigmaT);
        aTravel += a1 - a0;
      }
    }
    for (int c = 0; c < K; c++) R.error[c] += innerErr[c] * aTravel;
    return R;
  };

  Run R;
  for (int n = 1;; n = n == 1 ? 4 : 2 * n) {
    bad = false;
    R = run(n);
    if (!ok) return fail(Status::invalidModel, "a p-curve not evaluated");
    if (!bad || n >= kMaxBands) {
      if (n > 1) T.flags |= flagCells;
      if (bad && R.status == Status::ok) R.status = Status::singular, R.why = "the surface not sound near the face";
      break;
    }
  }
  for (int c = 0; c < K; c++) T.value[c] = sigmaT * R.value[c], T.error[c] = R.error[c];
  T.status = R.status, T.why = R.why;
  if (modulo) {
    // The whole surface's integral: a turn of a, across the inner direction's extent (pole to pole, or a period).
    std::vector<double> innerErr(K), absTol(K);
    const double a0 = ra.lo, a1 = ra.lo + Pa;
    // Its error enters the face's: tolerances from the face's floors, not the whole surface's.
    std::vector<std::array<double, 3>> faceSamples;
    for (const Vec2& p : abSamples) faceSamples.push_back({p.x, 0, (p.y - fr.b0) * fr.dir});
    const std::vector<double> fl = floorFor(in, faceSamples);
    const int m = innerPanels(in, {{a0 + 0.3 * Pa, whole0, whole1}, {a0 + 0.7 * Pa, whole0, whole1}}, relTol, fl,
      innerErr);
    for (int c = 0; c < K; c++) absTol[c] = relTol * fl[c];
    std::vector<Estimate> w;
    alongA([&](double a, double* o) { in.H(a, whole1, whole0, m, o); }, a0, a1, absTol, w);
    const double j = std::floor(T.value[area] / w[area].value + 1e-12);
    for (int c = 0; c < K; c++) {
      T.value[c] -= j * w[c].value, T.error[c] += std::fabs(j) * (w[c].error + innerErr[c] * Pa);
    }
    if (T.value[area] > w[area].value / 2 * (1 + 1e-9)) T.flags |= flagSphereSide;
  }
  return T;
}

static FreeTotals freeArea(Oracle::Impl& I, int f, double relTol) {
  return freeIntegral(I, f, 1, 0, [](Vec3, Vec3 n, double* o) { o[0] = norm(n); },
    [](const Inner& in, const std::vector<std::array<double, 3>>& samples) {
      Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
      for (const auto& s : samples) {
        const Vec3 q = in.P(s[0], s[2]);
        lo = {std::fmin(lo.x, q.x), std::fmin(lo.y, q.y), std::fmin(lo.z, q.z)};
        hi = {std::fmax(hi.x, q.x), std::fmax(hi.y, q.y), std::fmax(hi.z, q.z)};
      }
      const double size = std::isfinite(lo.x) ? norm(hi - lo) : 1;
      return std::vector<double>{size * size};
    }, relTol);
}

FaceMeasure Oracle::Impl::freeForm(int f) {
  FaceMeasure m;
  m.offSurface = NAN;
  m.method = Method::freeForm;
  const FreeTotals T = freeArea(*this, f, options.relTol);
  m.flags = T.flags;
  m.offSurface = T.offSurface;
  if (*T.why && T.status != Status::ok && T.status != Status::noConvergence && T.status != Status::singular) {
    m.area = {NAN, INFINITY, T.status};
    m.why = T.why;
    return m;
  }
  m.why = T.why;
  double a = T.value[0];
  if (a < 0 && !(m.flags & flagSphereSide)) m.flags |= flagOrientation, a = -a;
  m.area = {a, T.error[0], T.status};
  return m;
}

} // namespace cadoracle
