// Tracing by continuation (docs/own-tessellator.md, "Tracing by continuation"): the feet of the curve's points on the
// surface followed along the curve, so every sample is on one branch, never projected alone. A foot (u, v) of C(t)
// solves F = ((S - C) . S_u, (S - C) . S_v) = 0; by the implicit function theorem it moves at d(u, v)/dt = H^-1 (C' .
// S_u, C' . S_v), H the Hessian of |S - C|^2 / 2 (the first fundamental form plus (S - C) . the second partials). Each
// step predicts along that tangent and corrects by damped Newton (project.cpp's footFrom), and is halved where the
// correction is large against the step or the foot jumps in 3D (another branch near). A fold (H singular) is reported.
// Seeds: a known end; else an end vertex's one foot from the end search (PcurveEnds' cache: not a pole's, the vertex
// within tol of the curve's end); else the curve's samples inverted globally (invertSurface), the most central unique
// one; the same samples check the trace afterwards (a nearer foot elsewhere, or an ambiguous one, is reported). The
// range is first split where the curve passes through a pole or apex (Surface::singularities), the trace stopping where
// the form degenerates and the free parameter carried on at its rate there, the pieces joined by a jump along the pole
// line. Then each segment's feet are a 2D line if they're affine in t (checked between samples), else fitted
// (numerics.h's fit::curve2), both against a 3D tolerance: tol, or a quarter of the curve's distance from the surface
// where that's more (invalidModel whatever the p-curve), so its p-curve is as near as it allows without its feet fitted
// ever finer. The fit is judged in 3D (its points on the surface against the feet's), at a tolerance from it tightened
// while the 3D error measured exceeds tol and can still come down: within the curve's own distance from the surface
// plus a quarter of it is as near as any p-curve gets, and a tightening that gains less than a quarter of it ends the
// fitting (that distance is sampled, the curve farther between).
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

/** Where and why a march stopped short. */
struct Stop {
  StopWhy why = StopWhy::none;
  double t = NAN, distance = NAN;
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

/** The feet's rate d(u, v)/dt with the surface's partials at `at` (uv, or beside it); `fold` where H is singular. */
Vec2 rateAt(const Job& job, double t, Vec2 at, bool& fold) {
  const Frame2 f = forms(job, t, at);
  double a = f.ha, b = f.hb, c = f.hc;
  const double det = a * c - b * b, scale = f.a * f.c;
  fold = !(det > 1e-10 * scale);
  if (fold) a = f.a, b = f.b, c = f.c;
  const double mu = 1e-14 * (a + c) + 1e-300;
  a += mu, c += mu;
  const double d = a * c - b * b;
  return {(c * f.rhs.x - b * f.rhs.y) / d, (a * f.rhs.y - b * f.rhs.x) / d};
}

/**
 * The feet's rate d(u, v)/dt (the first fundamental form taken where H is singular: `fold`), leaving uv as t moves by
 * `dir` (0: either way). On a break of the surface (a knot: a C0 one is a crease, where the partials jump and the
 * evaluation gives one side's), the side the feet move into: the partials just below and just above the break, and
 * the side whose rate moves into it where the evaluation's own doesn't (a polyline extrusion's corner: the next
 * span's S_u is across the curve, its rate there 0).
 */
Vec2 rate(const Job& job, double t, Vec2 uv, bool& fold, double dir = 0) {
  Vec2 r = rateAt(job, t, uv, fold);
  if (dir == 0) return r;
  for (int k = 0; k < 2; k++) {
    const std::vector<double>& bs = k ? job.vBreaks : job.uBreaks;
    if (bs.empty()) continue;
    const Range dom = k ? job.dom.v : job.dom.u;
    const double period = k ? job.dom.vPeriod : job.dom.uPeriod, x = k ? uv.y : uv.x;
    double xr = period > 0 ? dom.lo + std::fmod(std::fmod(x - dom.lo, period) + period, period) : x;
    if (period > 0 && xr >= dom.hi - 1e-12 * (1 + std::fabs(dom.hi))) xr -= period;  // just below the seam
    auto it = std::lower_bound(bs.begin(), bs.end(), xr - 1e-12 * (1 + std::fabs(xr)));
    if (it == bs.end() || std::fabs(*it - xr) > 1e-12 * (1 + std::fabs(xr))) continue;
    // Beside it by a little of the narrower neighbouring span, in uv's own (unreduced) coordinates (round the period
    // from the seam).
    const double lo = it != bs.begin() ? *(it - 1) : period > 0 ? (bs.size() > 1 ? bs.back() : *it) - period : dom.lo;
    const double hi = it + 1 != bs.end() ? *(it + 1) : period > 0 ? bs.front() + period : dom.hi;
    const double step = minNum(1e-9 * (dom.hi - dom.lo), 0.25 * minNum(*it - lo, hi - *it));
    const double base = x + (*it - xr);
    Vec2 below = uv, above = uv;
    (k ? below.y : below.x) = base - step, (k ? above.y : above.x) = base + step;
    bool fb = false, fa = false;
    const Vec2 rb = rateAt(job, t, below, fb), ra = rateAt(job, t, above, fa);
    const double tiny = 1e-9 * (std::fabs(r.x) + std::fabs(r.y) + std::fabs(rb.x) + std::fabs(rb.y) + std::fabs(ra.x)
      + std::fabs(ra.y));
    const double mb = dir * (k ? rb.y : rb.x), ma = dir * (k ? ra.y : ra.x), m = dir * (k ? r.y : r.x);
    const bool intoBelow = mb < -tiny, intoAbove = ma > tiny;
    // The evaluation's own already moves into its side (its partials are that side's): kept.
    if ((m > tiny && intoAbove) || (m < -tiny && intoBelow)) continue;
    if (intoBelow && !intoAbove) r = rb, fold = fb;
    else if (intoAbove && !intoBelow) r = ra, fold = fa;
  }
  return r;
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
 * degenerates, the end node then extrapolated: the free parameter at its rate, the fixed one the pole line's. False
 * where it can't go on, `stop` saying where (its last node) and why: the reason the last step was refused at the
 * smallest step, the corrector's failure told apart by the last node's form (degenerate) or Hessian (fold).
 */
bool march(const Job& job, Node from, double tEnd, const Singularity* poleEnd, std::vector<Node>& out,
  std::vector<double>& folds, Stop& stop) {
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
  StopWhy refused = StopWhy::noConvergence;
  bool lastFold = false;
  {
    // Leaving the first node the way the march goes (on a crease, the side it goes into).
    bool f0 = false;
    duv = rate(job, t, uv, f0, dir);
    lastFold = f0;
  }
  auto stopHere = [&](StopWhy why) {
    if (why == StopWhy::noConvergence) {
      const Frame2 f = forms(job, t, uv);
      if (conditioning(f.a, f.b, f.c) < 1e-8) why = StopWhy::degenerate;
      else if (lastFold) why = StopWhy::fold;
    }
    stop = {why, t, norm(pointOf(job.s, uv) - curveAt(job.c, t))};
  };
  while (next < stops.size() && guard++ < 200000) {
    const double target = stops[next];
    double tn = t + dir * h;
    if ((tn - target) * dir >= 0) tn = target;
    Vec2 guess = uv + (tn - t) * duv;
    Vec2 uvc = guess;
    const Vec3 cp = curveAt(job.c, tn), c0 = curveAt(job.c, t);
    footFrom(job.s, job.dom, cp, uvc, 12);
    // Beside a pole the rate in the free (periodic) direction is huge and the feet swing round there: a step can jump
    // across the swing, or Newton land whole turns off, at one place in 3D, so the checks below pass it. Refused: a
    // correction in a periodic direction past both a sixteenth of the period and a quarter of the predicted move
    // there. Smaller steps follow the swing.
    auto slips = [&](double c, double g, double last, double period) {
      return period > 0 && std::fabs(c - g) > 0.0625 * period && std::fabs(c - g) > 0.25 * std::fabs(g - last);
    };
    const bool slipped = slips(uvc.x, guess.x, uv.x, job.dom.uPeriod) || slips(uvc.y, guess.y, uv.y, job.dom.vPeriod);
    const Vec3 sp = pointOf(job.s, uvc), sg = pointOf(job.s, guess), s0 = pointOf(job.s, uv);
    const double chord = norm(cp - c0);
    // The predictor good to a tenth of the step, and no jump: the new foot no farther from the last than the curve
    // moved, give or take the tolerance.
    const bool near = norm(sp - s0) <= 2 * chord + 2 * job.tol;
    bool good = norm(sp - sg) <= 0.1 * chord + 0.5 * job.tol && near && !slipped;
    refused = near ? StopWhy::noConvergence : StopWhy::jump;
    // A foot on a pole line, the curve farther than tol from the pole: Newton stuck there (the pole's free parameter
    // has no gradient), not a foot (a curve passing near a pole, the predictor overshooting onto its line). A smaller
    // step keeps the guess off it. (A pole the curve reaches is within tol of it, so never refused here.)
    if (good)
      for (const Singularity& g : job.sing) {
        if (g.kind == Singularity::normalVanishes || (g.isoU ? uvc.x : uvc.y) != g.at) continue;
        if (norm(sp - cp) > job.tol) good = false, refused = StopWhy::poleLine;
      }
    if (!good) {
      h *= 0.5;
      if (h < 1e-13 * span) {
        stopHere(refused);
        return false;
      }
      continue;
    }
    bool fold = false;
    Vec2 d = rate(job, tn, uvc, fold, dir);
    if (fold) folds.push_back(tn);
    lastFold = fold;
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
    if (t == target) next++;
  }
  if (next < stops.size()) stopHere(StopWhy::noConvergence);
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
  // The first stop along the range, and the feet's distance from the curve where the trace had them.
  Stop first;
  double reached = 0;
  auto note = [&](const Stop& s) {
    if (s.why != StopWhy::none && !(s.t >= first.t)) first = s;
  };
  for (Segment& sg : segs) {
    // Seeds: a known end off a pole; else an end vertex's one foot (the end search's), not a pole's, where the
    // vertex is the curve's end (within tol); else the most central unique global inversion.
    Node seed{NAN, {}, {}};
    auto searched = [&](bool start, Vec2& uv) {
      const PcurveEnds& e = *job.ends;
      if (!e.cache || !(start ? e.checkStart : e.checkEnd)) return false;
      const Vec3 vp = start ? e.startPoint : e.endPoint, cp = curveAt(job.c, start ? r.lo : r.hi);
      if (norm(vp - cp) > job.tol) return false;
      const std::vector<EndFoot>& f = e.cache->feet(start ? e.startKey : e.endKey, job.s, vp, job.tol);
      if (f.size() != 1 || f[0].kind == EndFoot::Kind::pole) return false;
      uv = f[0].uv;
      return true;
    };
    if (sg.t.lo == r.lo && job.ends && !sg.poleLo && (job.ends->hasStart || searched(true, seed.uv))) {
      seed.t = r.lo;
      if (job.ends->hasStart) seed.uv = job.ends->start;
    } else if (sg.t.hi == r.hi && job.ends && !sg.poleHi && (job.ends->hasEnd || searched(false, seed.uv))) {
      seed.t = r.hi;
      if (job.ends->hasEnd) seed.uv = job.ends->end;
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
      note({StopWhy::noConvergence, sg.t.lo, NAN});
      continue;
    }
    footFrom(job.s, job.dom, curveAt(job.c, seed.t), seed.uv, 30);
    bool fold = false;
    seed.duv = rate(job, seed.t, seed.uv, fold);
    if (fold) folds.push_back(seed.t);
    std::vector<Node> back, fwd;
    Stop sb, sf;
    bool okB = seed.t <= sg.t.lo || march(job, seed, sg.t.lo, sg.poleLo, back, folds, sb);
    bool okF = seed.t >= sg.t.hi || march(job, seed, sg.t.hi, sg.poleHi, fwd, folds, sf);
    note(sb), note(sf);
    std::reverse(back.begin(), back.end());
    sg.nodes = back;
    sg.nodes.push_back(seed);
    sg.nodes.insert(sg.nodes.end(), fwd.begin(), fwd.end());
    // The pole ends' nodes: their fixed parameter on the pole line exactly.
    sg.ok = okB && okF && sg.nodes.size() >= 2 && sg.nodes.front().t == sg.t.lo && sg.nodes.back().t == sg.t.hi;
    if (okB && okF && !sg.ok) note({StopWhy::noConvergence, sg.nodes.empty() ? sg.t.lo : sg.nodes.back().t, NAN});
    for (const Node& n : sg.nodes) reached = std::max(reached, norm(pointOf(job.s, n.uv) - curveAt(job.c, n.t)));
    allOk = allOk && sg.ok;
  }
  if (!allOk) {
    out.stopped = true;
    out.stopAt = first.t, out.stopDistance = first.distance;
    out.stopWhy = first.why == StopWhy::none ? StopWhy::noConvergence : first.why;
    out.offSurface = reached;
    out.status = reached > job.tol ? Status::invalidModel : Status::noConvergence;
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
    // The fit judged in 3D: the spline's point on the surface against the foot's, to the fit's tolerance where the
    // curve is within tol of the surface (its error is measured after, between samples too), to a quarter of it where
    // it's farther (invalidModel: its error, which healing grows the edge's tolerance to, stays near the curve's own
    // distance), tightened while the error measured is over tol and over the curve's distance from the surface plus
    // a quarter of the fit's tolerance, and while each tightening gains a quarter of it. (Judged in (u, v), at the
    // tolerance the surface's largest stretch gives, a direction it hardly stretches in, beside a pole, a collapsed
    // side or a degenerate corner, asked far more than its 3D effect, of feet barely determined there: fits ran to
    // their cap.)
    double tol3 = out.offSurface > job.tol ? 0.25 * fitTol : fitTol;
    const std::vector<Node>& nodes = sg.nodes;
    std::function<Vec2(double)> f = [&](double t) { return footAt(job, nodes, t); };
    const std::function<double(Vec2, Vec2)> in3d = [&](Vec2 a, Vec2 b) {
      return norm(pointOf(job.s, a) - pointOf(job.s, b));
    };
    PcurvePiece best;
    double bestErr = kInf;
    for (int attempt = 0; attempt < 5; attempt++) {
      BSpline bs;
      double fitErr = 0;
      traceFits++;
      const Status st = fit::curve2(f, sg.t, 3, tol3, bs, fitErr, in3d);
      if (st != Status::ok && st != Status::noConvergence) break;
      PcurvePiece p = fromBSpline(bs, sg.t);
      if (!p.curve) break;
      double worstT = NAN;
      const double e = measure(job, p, &worstT), before = bestErr;
      if (e > job.tol && !(out.offSurface + 0.25 * fitTol >= e)) {
        // The curve's own distance from its foot where the fit is worst (projectForms' offSurface does the same):
        // a curve off the surface there by about the error stops the tightening now, not a round later.
        const LocalFoot lf = localFoot(job.s, curveAt(job.c, worstT), at(p, worstT));
        if (lf.status == Status::ok) out.offSurface = std::max(out.offSurface, lf.distance);
      }
      if (e < bestErr) bestErr = e, best = std::move(p);
      // (No p-curve beats the curve's own distance from the surface; where that's within tol, one within tol is
      // there, so only a curve farther off than tol stops at its distance, and only once fitted to a quarter of the
      // fit's tolerance, as such a curve is from the start: found that far off by the first fit, it is refitted so.)
      if (bestErr <= job.tol || st != Status::ok
        || (out.offSurface > job.tol && tol3 <= 0.25 * fitTol && bestErr <= out.offSurface + 0.25 * fitTol))
        break;
      // Tightening that gains less than a quarter of it: the curve is off the surface between the samples too.
      if (!(e < before - 0.25 * fitTol)) break;
      // Below the fit's own error too, or a fit whose samples miss its worst comes back the same.
      tol3 = std::min(0.25 * tol3, 0.25 * fitErr);
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
