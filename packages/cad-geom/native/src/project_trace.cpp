// Tracing by continuation (docs/own-tessellator.md, "Tracing by continuation"): the feet of the curve's points on the
// surface followed along the curve, so every sample is on one branch, never projected alone. A foot (u, v) of C(t)
// solves F = ((S - C) . S_u, (S - C) . S_v) = 0; by the implicit function theorem it moves at d(u, v)/dt = H^-1 (C' .
// S_u, C' . S_v), H the Hessian of |S - C|^2 / 2 (the first fundamental form plus (S - C) . the second partials).
// Each step predicts along that tangent and corrects by damped Newton (project.cpp's footFrom), and is halved where
// the correction is large against the step or the foot jumps in 3D (another branch near). A fold (H singular) is
// reported. Seeds: a known end, else the curve's samples inverted globally (invertSurface), the most central unique
// one;
// the same samples check the trace afterwards (a nearer foot elsewhere, or an ambiguous one, is reported). The range
// is first split where the curve passes through a pole or apex (Surface::singularities), the trace stopping where the
// form degenerates and the free parameter carried on at its rate there, the pieces joined by a jump along the pole
// line. Then each segment's feet are a 2D line if they're affine in t (checked between samples), else fitted
// (numerics.h's fit::curve2), both against a 3D tolerance: tol, or a quarter of the curve's distance from the surface
// where that's more (invalidModel whatever the p-curve), so its p-curve is as near as it allows without its feet
// fitted ever finer. The fit's (u, v) tolerance comes from it and is tightened while the 3D error measured exceeds
// tol and can still come down: within the curve's own distance from the surface plus a quarter of it is as near as
// any p-curve gets, and a tightening that gains less than a quarter of it ends the fitting (that distance is
// sampled, the curve farther between).
#include <algorithm>
#include <cmath>
#include <functional>

#include "cad_brep.h"
#include "cad_geom/numerics.h"
#include "project_impl.h"

namespace cadgeom {
namespace project {

long traceFits = 0;

namespace {

struct Node {
  double t;
  Vec2 uv, duv;
};

struct Frame2 {
  double a, b, c;  // the first fundamental form
  double ha, hb, hc;  // the Hessian
  Vec2 rhs;  // (C' . S_u, C' . S_v)
};

Frame2 forms(const Job& job, double t, Vec2 uv) {
  CurvePoint q;
  SurfacePoint sp;
  job.c.eval(t, 1, q);
  job.s.eval(uv.x, uv.y, 2, sp);
  const Vec3 d = sp.p - q.p;
  Frame2 f;
  f.a = dot(sp.du, sp.du), f.b = dot(sp.du, sp.dv), f.c = dot(sp.dv, sp.dv);
  f.ha = f.a + dot(d, sp.duu), f.hb = f.b + dot(d, sp.duv), f.hc = f.c + dot(d, sp.dvv);
  f.rhs = {dot(q.d1, sp.du), dot(q.d1, sp.dv)};
  return f;
}

/** The ratio of the form's smaller eigenvalue to its larger: near 0 at a pole or apex. */
double conditioning(double a, double b, double c) {
  const double m = 0.5 * (a + c), r = std::hypot(0.5 * (a - c), b);
  return m + r > 0 ? (m - r) / (m + r) : 0;
}

/** The feet's rate d(u, v)/dt; `fold` where H is singular (the first fundamental form taken instead). */
Vec2 rate(const Job& job, double t, Vec2 uv, bool& fold) {
  const Frame2 f = forms(job, t, uv);
  double a = f.ha, b = f.hb, c = f.hc;
  const double det = a * c - b * b, scale = f.a * f.c;
  fold = !(det > 1e-10 * scale);
  if (fold) a = f.a, b = f.b, c = f.c;
  const double mu = 1e-14 * (a + c) + 1e-300;
  a += mu, c += mu;
  const double d = a * c - b * b;
  return {(c * f.rhs.x - b * f.rhs.y) / d, (a * f.rhs.y - b * f.rhs.x) / d};
}

Vec3 pointOf(const Surface& s, Vec2 uv) {
  SurfacePoint sp;
  s.eval(uv.x, uv.y, 0, sp);
  return sp.p;
}
Vec3 curveAt(const Curve& c, double t) {
  CurvePoint q;
  c.eval(t, 0, q);
  return q.p;
}

/** A segment of the range between pole crossings, traced. */
struct Segment {
  Range t;
  const Singularity* poleLo = nullptr;
  const Singularity* poleHi = nullptr;
  std::vector<Node> nodes;
  bool ok = false;
};

/**
 * From node `from` toward tEnd (either way), appending nodes; stops early (returns true) at a pole end when the form
 * degenerates, the end node then extrapolated: the free parameter at its rate, the fixed one the pole line's.
 */
bool march(const Job& job, Node from, double tEnd, const Singularity* poleEnd, std::vector<Node>& out,
  std::vector<double>& folds) {
  const double span = job.r.hi - job.r.lo;
  double t = from.t;
  Vec2 uv = from.uv, duv = from.duv;
  const double dir = tEnd > t ? 1 : -1;
  double h = std::fabs(tEnd - t) / 8;
  // Breaks of the curve to step onto exactly (its derivatives jump there).
  std::vector<double> stops;
  for (double b : job.breaks)
    if ((b - t) * dir > 0 && (tEnd - b) * dir > 0) stops.push_back(b);
  if (dir < 0) std::reverse(stops.begin(), stops.end());
  stops.push_back(tEnd);
  size_t next = 0;
  int guard = 0;
  while (next < stops.size() && guard++ < 200000) {
    const double stop = stops[next];
    double tn = t + dir * h;
    if ((tn - stop) * dir >= 0) tn = stop;
    Vec2 guess = uv + (tn - t) * duv;
    Vec2 uvc = guess;
    const Vec3 cp = curveAt(job.c, tn), c0 = curveAt(job.c, t);
    footFrom(job.s, job.dom, cp, uvc, 12);
    const Vec3 sp = pointOf(job.s, uvc), sg = pointOf(job.s, guess), s0 = pointOf(job.s, uv);
    const double chord = norm(cp - c0);
    // The predictor good to a tenth of the step, and no jump: the new foot no farther from the last than the curve
    // moved, give or take the tolerance.
    bool good = norm(sp - sg) <= 0.1 * chord + 0.5 * job.tol && norm(sp - s0) <= 2 * chord + 2 * job.tol;
    // A foot on a pole line, the curve farther than tol from the pole: Newton stuck there (the pole's free parameter
    // has no gradient), not a foot (a curve passing near a pole, the predictor overshooting onto its line). A smaller
    // step keeps the guess off it. (A pole the curve reaches is within tol of it, so never refused here.)
    if (good)
      for (const Singularity& g : job.sing) {
        if (g.kind == Singularity::normalVanishes || (g.isoU ? uvc.x : uvc.y) != g.at) continue;
        if (norm(sp - cp) > job.tol) good = false;
      }
    if (!good) {
      h *= 0.5;
      if (h < 1e-13 * span) return false;
      continue;
    }
    bool fold = false;
    Vec2 d = rate(job, tn, uvc, fold);
    if (fold) folds.push_back(tn);
    const Frame2 f = forms(job, tn, uvc);
    if (poleEnd && conditioning(f.a, f.b, f.c) < 1e-8) {
      // Near the pole: carry the free parameter on at the last node's rate, the fixed one onto the pole line.
      const Node& last = out.empty() ? from : out.back();
      Vec2 end = last.uv + (tEnd - last.t) * last.duv;
      (poleEnd->isoU ? end.x : end.y) = poleEnd->at;
      out.push_back({tEnd, end, last.duv});
      return true;
    }
    if (norm(sp - s0) > 0.1 * chord + job.tol && norm(sp - sg) > 0.01 * chord + job.tol) {
      // Accepted but not easily: keep the step.
    } else {
      h *= 1.5;
    }
    // At most an eighth of the range a step, so the nodes follow the curve's shape.
    h = std::min(h, span / 8);
    t = tn, uv = uvc, duv = d;
    out.push_back({t, uv, duv});
    if (t == stop) next++;
  }
  return next >= stops.size();
}

/** The foot on the traced branch at t: the nodes' cubic Hermite interpolant, corrected by Newton. */
Vec2 footAt(const Job& job, const std::vector<Node>& nodes, double t) {
  auto it = std::lower_bound(nodes.begin(), nodes.end(), t, [](const Node& n, double x) { return n.t < x; });
  if (it == nodes.begin()) return nodes.front().uv;
  if (it == nodes.end()) return nodes.back().uv;
  const Node& b = *it;
  const Node& a = *(it - 1);
  const double h = b.t - a.t, s = h > 0 ? (t - a.t) / h : 0;
  const double h00 = (1 + 2 * s) * (1 - s) * (1 - s), h10 = s * (1 - s) * (1 - s), h01 = s * s * (3 - 2 * s),
               h11 = s * s * (s - 1);
  Vec2 uv = h00 * a.uv + (h10 * h) * a.duv + h01 * b.uv + (h11 * h) * b.duv;
  if (s == 0 || s == 1) return s == 0 ? a.uv : b.uv;
  footFrom(job.s, job.dom, curveAt(job.c, t), uv, 12);
  return uv;
}

/** The B-spline in the model's form (distinct knots and multiplicities), as a piece over t. */
PcurvePiece fromBSpline(const BSpline& b, Range t) {
  PcurvePiece p;
  p.t = t;
  p.kind = CBR_CURVE_BSPLINE;
  std::vector<double> knots;
  std::vector<int32_t> mults;
  for (double k : b.knots) {
    if (!knots.empty() && k == knots.back()) mults.back()++;
    else knots.push_back(k), mults.push_back(1);
  }
  const int n = b.poleCount();
  p.ints = {b.degree, n, static_cast<int32_t>(knots.size()), 0, 0, 0, 0};
  p.ints.insert(p.ints.end(), mults.begin(), mults.end());
  p.reals = knots;
  p.reals.insert(p.reals.end(), b.poles.begin(), b.poles.end());
  build(p);
  return p;
}

} // namespace

void trace(const Job& job, Pcurve& out) {
  out.method = PcurveMethod::traced;
  const Range r = job.r;
  const double span = r.hi - r.lo;
  // Where the curve passes through a pole or apex: the range splits there.
  std::vector<std::pair<double, const Singularity*>> cuts;
  for (const Singularity& g : job.sing) {
    if (g.kind == Singularity::normalVanishes) continue;
    CurveInversion ci = invertCurve(job.c, g.point, r, job.tol);
    if (ci.status != Status::ok || !(ci.distance <= job.tol)) continue;
    cuts.push_back({ci.t, &g});
    for (double a : ci.alternatives) cuts.push_back({a, &g});
    // A pole at both ends of the range is found once: the other end checked directly.
    for (double e : {r.lo, r.hi})
      if (norm(curveAt(job.c, e) - g.point) <= job.tol) cuts.push_back({e, &g});
  }
  std::sort(cuts.begin(), cuts.end(), [](auto& a, auto& b) { return a.first < b.first; });
  std::vector<std::pair<double, const Singularity*>> merged;
  for (auto& c : cuts)
    if (merged.empty() || c.first - merged.back().first > 1e-9 * span) merged.push_back(c);
  std::vector<Segment> segs;
  {
    double lo = r.lo;
    const Singularity* plo = nullptr;
    for (auto& c : merged) {
      if (c.first <= r.lo + 1e-9 * span) {
        plo = c.second;
        continue;
      }
      if (c.first >= r.hi - 1e-9 * span) break;
      segs.push_back({{lo, c.first}, plo, c.second, {}, false});
      lo = c.first, plo = c.second;
    }
    const Singularity* phi =
      !merged.empty() && merged.back().first >= r.hi - 1e-9 * span ? merged.back().second : nullptr;
    segs.push_back({{lo, r.hi}, plo, phi, {}, false});
  }
  // The whole range at one pole: no p-curve.
  if (segs.size() == 1 && segs[0].poleLo && segs[0].poleLo == segs[0].poleHi
    && norm(curveAt(job.c, 0.5 * (r.lo + r.hi)) - segs[0].poleLo->point) <= job.tol) {
    out.status = Status::singular;
    return;
  }

  std::vector<double> folds;
  std::vector<std::pair<double, SurfaceInversion>> checks;
  bool allOk = true;
  for (Segment& sg : segs) {
    // Seeds: a known end off a pole, else the most central unique global inversion.
    Node seed{NAN, {}, {}};
    if (sg.t.lo == r.lo && job.ends && job.ends->hasStart && !sg.poleLo) {
      seed.t = r.lo, seed.uv = job.ends->start;
    } else if (sg.t.hi == r.hi && job.ends && job.ends->hasEnd && !sg.poleHi) {
      seed.t = r.hi, seed.uv = job.ends->end;
    }
    const bool known = !std::isnan(seed.t);
    constexpr int K = 9;
    int bestScore = -1;
    for (int i = 0; i < K; i++) {
      const double t = sg.t.lo + (sg.t.hi - sg.t.lo) * (i + 0.5) / K;
      SurfaceInversion inv = invertSurface(job.s, curveAt(job.c, t), job.dom.u, job.dom.v, job.tol);
      if (inv.status != Status::ok) continue;
      checks.push_back({t, inv});
      const int central = K - std::abs(2 * i + 1 - K);
      const int score = (inv.certainty == Certainty::unique ? 4 * K : 0) + (inv.atSingularity ? 0 : 2 * K)
        + (inv.onSeamU || inv.onSeamV ? 0 : K) + central;
      if (!known && score > bestScore) seed.t = t, seed.uv = inv.uv, bestScore = score;
    }
    if (std::isnan(seed.t)) {
      allOk = false;
      continue;
    }
    footFrom(job.s, job.dom, curveAt(job.c, seed.t), seed.uv, 30);
    bool fold = false;
    seed.duv = rate(job, seed.t, seed.uv, fold);
    if (fold) folds.push_back(seed.t);
    std::vector<Node> back, fwd;
    bool okB = seed.t <= sg.t.lo || march(job, seed, sg.t.lo, sg.poleLo, back, folds);
    bool okF = seed.t >= sg.t.hi || march(job, seed, sg.t.hi, sg.poleHi, fwd, folds);
    std::reverse(back.begin(), back.end());
    sg.nodes = back;
    sg.nodes.push_back(seed);
    sg.nodes.insert(sg.nodes.end(), fwd.begin(), fwd.end());
    // The pole ends' nodes: their fixed parameter on the pole line exactly.
    sg.ok = okB && okF && sg.nodes.size() >= 2 && sg.nodes.front().t == sg.t.lo && sg.nodes.back().t == sg.t.hi;
    allOk = allOk && sg.ok;
  }
  if (!allOk) {
    out.status = Status::noConvergence;
    return;
  }
  // Consecutive segments meet at a pole: the next one taken whole periods on to continue the fixed parameter, its
  // free one to the copy nearest the incoming (ties upward).
  for (size_t k = 1; k < segs.size(); k++) {
    const Vec2 a = segs[k - 1].nodes.back().uv, b = segs[k].nodes.front().uv;
    double du = 0, dv = 0;
    if (job.dom.uPeriod > 0) du = job.dom.uPeriod * std::floor((a.x - b.x) / job.dom.uPeriod + 0.5);
    if (job.dom.vPeriod > 0) dv = job.dom.vPeriod * std::floor((a.y - b.y) / job.dom.vPeriod + 0.5);
    for (Node& n : segs[k].nodes) n.uv = n.uv + Vec2{du, dv};
  }

  // The global checks: a foot nearer than the traced one by more than tol, or another within tol, is a second branch.
  auto mark = [&](double t) {
    out.certainty = Certainty::ambiguous;
    out.tAmbiguous.push_back(t);
  };
  out.offSurface = 0;
  for (auto& [t, inv] : checks) {
    for (const Segment& sg : segs) {
      if (t < sg.t.lo || t > sg.t.hi) continue;
      const Vec2 uv = footAt(job, sg.nodes, t);
      const Vec3 c = curveAt(job.c, t), f = pointOf(job.s, uv);
      const double d = norm(f - c);
      out.offSurface = std::max(out.offSurface, d);
      if (inv.distance < d - job.tol) mark(t);
      else if (inv.certainty == Certainty::ambiguous) {
        for (Vec2 alt : inv.alternatives)
          if (norm(pointOf(job.s, alt) - f) > job.tol) {
            mark(t);
            break;
          }
      }
    }
  }
  for (double t : folds) mark(t);
  std::sort(out.tAmbiguous.begin(), out.tAmbiguous.end());
  out.tAmbiguous.erase(std::unique(out.tAmbiguous.begin(), out.tAmbiguous.end()), out.tAmbiguous.end());

  // Each segment a line where the feet are affine in t, else fitted.
  bool anyFit = false;
  out.status = Status::ok;
  out.pieces.clear();
  for (size_t k = 0; k < segs.size(); k++) {
    const Segment& sg = segs[k];
    for (const Node& n : sg.nodes) {
      const double d = norm(pointOf(job.s, n.uv) - curveAt(job.c, n.t));
      out.offSurface = std::max(out.offSurface, d);
    }
    if (k > 0) {
      PcurvePiece jump;
      jump.t = {sg.t.lo, sg.t.lo};
      jump.poleLine = true;
      jump.from = segs[k - 1].nodes.back().uv, jump.to = sg.nodes.front().uv;
      jump.certainty = Certainty::unique;
      if (std::fabs(jump.from.x - jump.to.x) > 0 || std::fabs(jump.from.y - jump.to.y) > 0)
        out.pieces.push_back(std::move(jump));
    }
    // The p-curve's 3D tolerance against the feet, for the line and the fit: tol, or a quarter of the curve's distance
    // from the surface where that's more (the curve then off by over 4 tol: invalidModel whatever the p-curve), so the
    // p-curve is as near as the curve allows without its feet fitted ever finer (feet clamped where the curve runs
    // past the surface's edge have corners, which a fit only follows by halving its spans there round after round).
    const double fitTol = std::max(job.tol, 0.25 * out.offSurface);
    const Vec2 a = sg.nodes.front().uv, b = sg.nodes.back().uv;
    const double w = sg.t.hi - sg.t.lo;
    const Vec2 vel = (1 / w) * (b - a);
    bool affine = norm(vel) > 0;
    for (const Node& n : sg.nodes) {
      if (!affine) break;
      const Vec2 l = a + (n.t - sg.t.lo) * vel;
      affine = norm(pointOf(job.s, l) - pointOf(job.s, n.uv)) <= 0.25 * fitTol;
    }
    if (affine) {
      PcurvePiece p = linePiece(sg.t, a, vel);
      p.certainty = Certainty::unique;
      const double e = measure(job, p);
      if (e <= job.tol || e <= out.offSurface + 0.25 * fitTol) {
        p.error = e;
        out.pieces.push_back(std::move(p));
        continue;
      }
    }
    anyFit = true;
    // The (u, v) tolerance: half the fit's through the largest stretch at any node, tightened while the 3D error
    // measured is over tol and over the curve's distance from the surface plus a quarter of the fit's tolerance, and
    // while each tightening gains a quarter of it.
    double tuv = kInf;
    for (const Node& n : sg.nodes) tuv = std::min(tuv, uvTol(job.s, n.uv, fitTol));
    tuv *= 0.5;
    const std::vector<Node>& nodes = sg.nodes;
    std::function<Vec2(double)> f = [&](double t) { return footAt(job, nodes, t); };
    PcurvePiece best;
    double bestErr = kInf;
    for (int attempt = 0; attempt < 4; attempt++) {
      BSpline bs;
      double fitErr = 0;
      traceFits++;
      const Status st = fit::curve2(f, sg.t, 3, tuv, bs, fitErr);
      if (st != Status::ok && st != Status::noConvergence) break;
      PcurvePiece p = fromBSpline(bs, sg.t);
      if (!p.curve) break;
      const double e = measure(job, p), before = bestErr;
      if (e < bestErr) bestErr = e, best = std::move(p);
      if (bestErr <= job.tol || bestErr <= out.offSurface + 0.25 * fitTol || st != Status::ok) break;
      // Tightening that gains less than a quarter of it: the curve is off the surface between the samples too.
      if (!(e < before - 0.25 * fitTol)) break;
      tuv *= 0.25;
    }
    if (!best.curve) {
      out.status = Status::noConvergence;
      out.pieces.clear();
      return;
    }
    best.error = bestErr;
    best.certainty = Certainty::unique;
    for (double t : out.tAmbiguous)
      if (t >= sg.t.lo && t <= sg.t.hi) best.certainty = Certainty::ambiguous;
    out.pieces.push_back(std::move(best));
  }
  if (!anyFit) out.method = PcurveMethod::affineFeet;
}

} // namespace project
} // namespace cadgeom
