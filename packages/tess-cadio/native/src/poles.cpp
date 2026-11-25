// poles.h: a face's poles by case and the ring each gets.
#include "poles.h"

#include "cad_geom/curve.h"

#include <algorithm>
#include <cmath>
#include <memory>
#include <set>

namespace tesscadio {

using namespace cadgeom;

namespace {

constexpr double kInf = std::numeric_limits<double>::infinity();

double fixedOf(Vec2 p, bool isoU) { return isoU ? p.x : p.y; }
double freeOf(Vec2 p, bool isoU) { return isoU ? p.y : p.x; }
Vec2 uvOf(double fixed, double fr, bool isoU) { return isoU ? Vec2{fixed, fr} : Vec2{fr, fixed}; }

Vec3 at(const Surface& s, Vec2 uv) {
  SurfacePoint p;
  s.eval(uv.x, uv.y, 0, p);
  return p.p;
}

/** The ring's point at offset r, free coordinate q. */
Vec3 ringPoint(const Surface& s, const PoleRing& ring, double r, double q) {
  return at(s, uvOf(ring.at + ring.side * r, q, ring.isoU));
}

/** The fixed coordinate's range on the face's side of the row: how far an offset may go. */
double offsetRange(const Surface& s, const PoleRing& ring) {
  const SurfaceDomain dom = s.domain();
  const Range R = ring.isoU ? dom.u : dom.v;
  return ring.side > 0 ? R.hi - ring.at : ring.at - R.lo;
}

} // namespace

double ringReach(const Surface& s, const PoleRing& ring, double r) {
  double most = 0;
  for (auto [q0, q1] : ring.runs)
    for (int j = 0; j <= 16; j++)
      most = std::max(most, norm(ringPoint(s, ring, r, q0 + (q1 - q0) * j / 16) - ring.pole));
  return most;
}

double ringRadius(const Surface& s, const PoleRing& ring, double reach) {
  const double range = offsetRange(s, ring);
  // Doubled out from 1e-9 until the ring reaches that far (or the domain ends), then halved in.
  double lo = 0, hi = std::isfinite(range) ? std::min(range, 1e-9) : 1e-9;
  while (ringReach(s, ring, hi) < reach) {
    lo = hi;
    if (std::isfinite(range) && hi >= range) return range;
    hi = std::isfinite(range) ? std::min(2 * hi, range) : 2 * hi;
    if (!(hi < 1e300)) return hi;
  }
  for (int it = 0; it < 80; it++) {
    double mid = 0.5 * (lo + hi);
    (ringReach(s, ring, mid) < reach ? lo : hi) = mid;
  }
  return hi;
}

int ringPieces(const Surface& s, const PoleRing& ring, std::pair<double, double> run, double r, double deflection,
  double angle) {
  auto [q0, q1] = run;
  // The tangent's turn along the ring, as its chords between 64 points turn.
  constexpr int kN = 64;
  std::vector<Vec3> p(kN + 1);
  for (int j = 0; j <= kN; j++) p[j] = ringPoint(s, ring, r, q0 + (q1 - q0) * j / kN);
  double turn = 0;
  for (int j = 1; j < kN; j++) {
    Vec3 a = p[j] - p[j - 1], b = p[j + 1] - p[j];
    if (norm(a) > 0 && norm(b) > 0) turn += std::atan2(norm(cross(a, b)), dot(a, b));
  }
  int m = std::max(1, angle > 0 ? static_cast<int>(std::ceil(turn / angle)) : 1);
  // Then doubled until each piece's chord is within the deflection of the ring at its middle and quarters.
  auto within = [&](int pieces) {
    for (int j = 0; j < pieces; j++) {
      double qa = q0 + (q1 - q0) * j / pieces, qb = q0 + (q1 - q0) * (j + 1) / pieces;
      Vec3 a = ringPoint(s, ring, r, qa), b = ringPoint(s, ring, r, qb), d = b - a;
      double l2 = dot(d, d);
      for (double f : {0.25, 0.5, 0.75}) {
        Vec3 x = ringPoint(s, ring, r, qa + f * (qb - qa));
        double w = l2 > 0 ? std::clamp(dot(x - a, d) / l2, 0.0, 1.0) : 0;
        if (norm(x - (a + w * d)) > deflection) return false;
      }
    }
    return true;
  };
  while (m < (1 << 14) && !within(m)) m *= 2;
  return m;
}

std::vector<PoleRing> facePoles(const Model& m, int f, const Surface& s, const FaceBoundary& fb, const EdgeMesh& em,
  const SurfaceCriteria& criteria, double tol, double deflection, double angle) {
  std::vector<PoleRing> out;
  std::vector<Singularity> sing;
  s.singularities(sing);
  const SurfaceDomain dom = s.domain();
  bool edgeLoops = false;
  for (int i = 0; i < m.faceLoopCount(f); i++)
    edgeLoops = edgeLoops || m.loopKind(m.faceFirstLoop(f) + i) == CBR_LOOP_EDGE;
  for (size_t g = 0; g < sing.size(); g++) {
    const Singularity& S = sing[g];
    if (S.kind == Singularity::normalVanishes) continue;
    PoleRing ring;
    ring.singularity = static_cast<int>(g);
    ring.isoU = S.isoU, ring.at = S.at, ring.pole = S.point;
    const Range fixedR = S.isoU ? dom.u : dom.v;
    // The face's side of the row: its boundary's, by the point nearest the row off it (an apex inside the fixed
    // coordinate's range, a revolved line's, has the surface on both sides: by the domain's nearer end it would be
    // whichever end the infinite range happens to give). The domain's nearer end where no point says.
    ring.side = std::fabs(S.at - fixedR.lo) <= std::fabs(S.at - fixedR.hi) ? 1 : -1;
    {
      double nearest = kInf;
      for (const auto& L : fb.loops)
        for (const BoundaryPoint& p : L) {
          const double off = fixedOf(p.uv, S.isoU) - S.at;
          if (std::fabs(off) > 1e-9 * (1 + std::fabs(S.at)) && std::fabs(off) < nearest)
            nearest = std::fabs(off), ring.side = off > 0 ? 1 : -1;
        }
    }
    const double period = S.isoU ? dom.vPeriod : dom.uPeriod;
    auto onRow = [&](const BoundaryPoint& p) {
      return std::fabs(fixedOf(p.uv, S.isoU) - S.at) <= 1e-12 * (1 + std::fabs(S.at));
    };
    // The runs along the row: each loop's consecutive points on it (cyclically), from the first's free coordinate to
    // the last's.
    for (const auto& L : fb.loops) {
      const int n = static_cast<int>(L.size());
      int start = -1;
      for (int i = 0; i < n && start < 0; i++)
        if (!onRow(L[i])) start = i;
      if (start < 0) continue;  // (a loop wholly on the row: a pole's vertex loop, nothing to span)
      for (int k = 0; k < n;) {
        const int i = (start + k) % n;
        if (!onRow(L[i])) {
          k++;
          continue;
        }
        int len = 0;
        while (k + len < n && onRow(L[(start + k + len) % n])) len++;
        const double a = freeOf(L[i].uv, S.isoU), b = freeOf(L[(start + k + len - 1) % n].uv, S.isoU);
        if (a != b) ring.runs.push_back({std::min(a, b), std::max(a, b)});
        k += len;
      }
    }
    // (No boundary along the row: the region doesn't reach it. A face with no loops has its natural extent's, the
    // pole lines among them.)
    if (ring.runs.empty()) {
      out.push_back(ring);
      continue;
    }
    // The curves incident to the pole: each portion of a boundary edge that comes within tol of it (its nearest
    // approach on a span, by golden section on the curve, not only at samples), with the samples out from there while
    // they get farther from the pole, which the straight rule governs rather than the clearance; a later part of the
    // edge that comes back near the pole counts toward the clearance as any boundary does. Model edges are the
    // through curves; pseudo-edges (a cut, the face's own) are only kept out of the clearance.
    std::set<int> through;
    std::set<std::pair<int, int>> incident;      // (edge, sample) kept out of the clearance
    std::vector<std::pair<int, double>> approach;  // (model edge, parameter of its nearest approach)
    std::set<int> edgesSeen;
    for (const auto& L : fb.loops)
      for (const BoundaryPoint& p : L)
        if ((p.kind == BoundaryPoint::edgeSample || p.kind == BoundaryPoint::pseudoSample) && p.edgeIndex >= 0)
          edgesSeen.insert(p.edgeIndex);
    for (int e : edgesSeen) {
      const EdgeSamples& es = em.edge(e);
      const int n = static_cast<int>(es.t.size());
      if (n < 2) continue;
      auto dist = [&](double t) { return norm(em.point(e, t) - S.point); };
      std::vector<double> ds(n);
      for (int j = 0; j < n; j++) ds[j] = norm(es.points[j] - S.point);
      for (int j = 0; j + 1 < n; j++) {
        // A span the pole may come within tol of: its chord within tol plus half its length of the pole.
        const Vec3 a = es.points[j], b = es.points[j + 1], dv = b - a;
        const double l2 = dot(dv, dv), w = l2 > 0 ? std::clamp(dot(S.point - a, dv) / l2, 0.0, 1.0) : 0;
        if (norm(S.point - (a + w * dv)) > tol + 0.5 * std::sqrt(l2)) continue;
        double lo = es.t[j], hi = es.t[j + 1];
        const double g = 0.5 * (std::sqrt(5.0) - 1);
        double x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = dist(x1), f2 = dist(x2);
        for (int it = 0; it < 80; it++) {
          if (f1 < f2) hi = x2, x2 = x1, f2 = f1, x1 = hi - g * (hi - lo), f1 = dist(x1);
          else lo = x1, x1 = x2, f1 = f2, x2 = lo + g * (hi - lo), f2 = dist(x2);
        }
        double tm = 0.5 * (lo + hi), dm = dist(tm);
        // (The ends themselves: the golden section keeps inside the span.)
        if (ds[j] <= dm) tm = es.t[j], dm = ds[j];
        if (ds[j + 1] < dm) tm = es.t[j + 1], dm = ds[j + 1];
        if (dm > tol) continue;
        // A span next to one already found at the same approach (its end shared): once.
        bool again = false;
        for (auto [e2, t2] : approach) again = again || (e2 == e && t2 == tm);
        if (again) continue;
        if (!em.isPseudo(e)) through.insert(e), approach.push_back({e, tm});
        else approach.push_back({-1 - e, tm});
        ring.approaches.push_back({e, tm});
        // The samples out from the approach both ways while they get farther. (A closed edge's approach at its vertex
        // is found on both spans beside it, at its first parameter and its last: walked out from each.)
        auto walk = [&](int k, int step) {
          for (double last = dm; k >= 0 && k < n && !(ds[k] < last); k += step) {
            incident.insert({e, k});
            last = ds[k];
          }
        };
        walk(j, -1);
        walk(j + 1, 1);
      }
    }
    ring.through.assign(through.begin(), through.end());
    if (!edgeLoops) ring.kase = PoleRing::Case::natural;
    else ring.kase = through.empty() ? PoleRing::Case::clear : PoleRing::Case::through;
    // Smooth or apex-like: the normals' spread at a thousandth of the deflection from the pole, over the runs.
    {
      const double r = ringRadius(s, ring, 1e-3 * deflection);
      std::vector<Vec3> ns;
      for (auto [q0, q1] : ring.runs)
        for (int j = 0; j <= 16; j++) {
          Vec2 uv = uvOf(S.at + ring.side * r, q0 + (q1 - q0) * j / 16, S.isoU);
          Vec3 nn;
          Status st = s.normal(uv.x, uv.y, nn);
          if ((st == Status::ok || st == Status::singular) && std::isfinite(norm(nn)) && norm(nn) > 0.5)
            ns.push_back(nn);
        }
      for (size_t i = 0; i < ns.size(); i++)
        for (size_t j = i + 1; j < ns.size(); j++)
          ring.spread = std::max(ring.spread, std::atan2(norm(cross(ns[i], ns[j])), dot(ns[i], ns[j])));
      ring.smooth = ring.spread <= angle;
    }
    // The clearance: the fixed-coordinate distance to the nearest boundary point away from the pole, within the runs'
    // free ranges on the face's side (all of them where a run spans a period), but the incident curves'; half of it,
    // and at most half the offset range, as a reach.
    bool whole = false;
    for (auto [q0, q1] : ring.runs) whole = whole || (period > 0 && q1 - q0 >= period * (1 - 1e-12));
    double clear = kInf;
    auto consider = [&](const BoundaryPoint& p) {
      if (onRow(p)) return;
      if ((p.kind == BoundaryPoint::edgeSample || p.kind == BoundaryPoint::pseudoSample) &&
        incident.count({p.edgeIndex, p.sample}))
        return;
      const double df = (fixedOf(p.uv, S.isoU) - S.at) * ring.side;
      if (!(df > 0)) return;
      bool in = whole;
      for (auto [q0, q1] : ring.runs) {
        double q = freeOf(p.uv, S.isoU);
        if (period > 0) q = q0 + std::fmod(std::fmod(q - q0, period) + period, period);
        in = in || (q >= q0 && q <= q1);
      }
      if (in) clear = std::min(clear, df);
    };
    for (const auto& L : fb.loops)
      for (const BoundaryPoint& p : L) consider(p);
    for (const auto& c : fb.interior)
      for (const BoundaryPoint& p : c) consider(p);
    // And each model edge's nearest approach to the pole on its curve (global inversion, branch and bound), its foot on
    // the surface judged as a boundary point: the edges are sampled to their own rules here, and the rounds' splits
    // can later put samples where a span's chord passed outside the ring (LMP1 #1072177's arc, its two ends outside,
    // its curve 26% nearer the pole than the ring), segments the ring's, never split, would then cross. Not the
    // incident curves (within tol of the pole: through it, cut into the ring). The face's edges from the model's
    // loops, not the boundary points' labels: a one-span edge between two vertices has neither end labelled with it
    // (each junction carries the edge before it), #1072177's arc among them.
    std::set<int> faceEdges;
    for (int i = 0; i < m.faceLoopCount(f); i++) {
      const int l = m.faceFirstLoop(f) + i;
      if (m.loopKind(l) == CBR_LOOP_EDGE)
        for (int k = 0; k < m.loopCount(l); k++) faceEdges.insert(m.coedgeEdge(m.loopFirst(l) + k));
    }
    for (int e : faceEdges) {
      if (em.isPseudo(e) || e >= m.edges() || m.edgeCurve(e) < 0) continue;
      const EdgeSamples& es = em.edge(e);
      if (es.t.size() < 2) continue;
      Status st;
      const std::unique_ptr<Curve> c = makeCurve(m, m.edgeCurve(e), st);
      if (!c) continue;
      const Range r{std::min(es.t.front(), es.t.back()), std::max(es.t.front(), es.t.back())};
      const CurveInversion ci = invertCurve(*c, S.point, r, tol);
      if (ci.status != Status::ok) continue;
      CurvePoint q;
      if (c->eval(ci.t, 0, q) != Status::ok || !(norm(q.p - S.point) > tol)) continue;
      const SurfaceDomain D = s.domain();
      const SurfaceInversion si = invertSurface(s, q.p, D.u, D.v, tol);
      if (si.status != Status::ok) continue;
      BoundaryPoint near;
      near.kind = BoundaryPoint::vertexPoint, near.uv = si.uv, near.point = q.p;
      consider(near);
    }
    const double half = 0.5 * std::min(clear, offsetRange(s, ring));
    ring.clearance = std::isfinite(half) ? ringReach(s, ring, half) : kInf;
    // The through edges' straight length: how far from each nearest approach (both ways along the edge, but past
    // its ends) the curve stays within the deflection of its chord from there (32 points along each chord tried; the
    // largest such length by halving).
    for (auto [e, t0] : approach) {
      if (e < 0) continue;
      const EdgeSamples& es = em.edge(e);
      const Vec3 p0 = em.point(e, t0);
      for (double t1 : {es.t.front(), es.t.back()}) {
        if (t1 == t0) continue;
        auto straight = [&](double fr) {
          const Vec3 p1 = em.point(e, t0 + fr * (t1 - t0)), dv = p1 - p0;
          const double l2 = dot(dv, dv);
          for (int k = 1; k < 32; k++) {
            const Vec3 q = em.point(e, t0 + fr * (t1 - t0) * k / 32);
            const double w = l2 > 0 ? std::clamp(dot(q - p0, dv) / l2, 0.0, 1.0) : 0;
            if (norm(q - (p0 + w * dv)) > deflection) return false;
          }
          return true;
        };
        double lo = 0, hi = 1;
        if (straight(1)) lo = 1;
        else
          for (int it = 0; it < 50; it++) {
            const double mid = 0.5 * (lo + hi);
            (straight(mid) ? lo : hi) = mid;
          }
        ring.straight = std::min(ring.straight, norm(em.point(e, t0 + lo * (t1 - t0)) - S.point));
      }
    }
    // The fans at offset r: each run's ring in its pieces, each piece's ends and the pole (at the piece's middle on
    // the row), judged by the criteria: their normals only at a smooth pole.
    auto passes = [&](double r) {
      for (auto run : ring.runs) {
        const int pieces = ringPieces(s, ring, run, r, deflection, angle);
        auto [q0, q1] = run;
        for (int j = 0; j < pieces; j++) {
          const double qa = q0 + (q1 - q0) * j / pieces, qb = q0 + (q1 - q0) * (j + 1) / pieces;
          Vec2 t[3] = {uvOf(S.at + ring.side * r, qa, S.isoU), uvOf(S.at + ring.side * r, qb, S.isoU),
            uvOf(S.at, 0.5 * (qa + qb), S.isoU)};
          if (cross(t[1] - t[0], t[2] - t[0]) < 0) std::swap(t[1], t[2]);
          if (!(ring.smooth ? criteria.acceptFan(t) : criteria.acceptDeviation(t))) return false;
        }
      }
      return true;
    };
    // The floor: the deflection, but half the clearance where that's less (a ring at d would come nearer the
    // boundary than half its clearance, or cross it).
    ring.floor = std::min(deflection, ring.clearance);
    const double want = std::min(ring.clearance, ring.straight);
    double r;
    if (!(want > ring.floor)) {
      r = ringRadius(s, ring, ring.floor), ring.floored = true;
    } else {
      r = ringRadius(s, ring, want);
      for (int it = 0; it < 60 && !passes(r); it++) {
        r *= 0.5;
        if (ringReach(s, ring, r) < ring.floor) {
          r = ringRadius(s, ring, ring.floor), ring.floored = true;
          break;
        }
      }
    }
    ring.radius = r;
    ring.wanted = ring.reach = ringReach(s, ring, r);
    out.push_back(ring);
  }
  return out;
}

std::vector<RingCut> ringCuts(const EdgeMesh& em, const PoleRing& ring) {
  std::vector<RingCut> cuts;
  if (!(ring.reach > 0)) return cuts;
  for (auto [e, t0] : ring.approaches) {
    const EdgeSamples& es = em.edge(e);
    if (es.t.size() < 2) continue;
    auto dist = [&](double t) { return norm(em.point(e, t) - ring.pole); };
    for (double t1 : {es.t.front(), es.t.back()}) {
      if (t1 == t0) continue;
      // The first point out from the approach at the reach: marched in sixty-fourths to the first past it, then
      // halved in between; the edge's end where none is (a closed edge's end may be the pole itself again).
      double crossing = t1, lo = t0, hi = NAN;
      for (int k = 1; k <= 64 && std::isnan(hi); k++) {
        const double t = t0 + (t1 - t0) * k / 64;
        if (dist(t) >= ring.reach) hi = t;
        else lo = t;
      }
      if (!std::isnan(hi)) {
        for (int it = 0; it < 80; it++) {
          const double mid = 0.5 * (lo + hi);
          (dist(mid) < ring.reach ? lo : hi) = mid;
        }
        crossing = hi;
      }
      cuts.push_back({e, t0, crossing});
    }
  }
  // Exact (RingCut::exact) where every edge's cut can be: no edge with approaches farther apart than the reach (one
  // running along the pole: LMP1 #172440's #1042701, approaches over 0.14 at a reach of 0.1, whose crossings from
  // inside it fall beside its other approaches' samples). An edge whose approach is already at the reach (its
  // crossing there) meets the ring as it is. Cut on some of its edges and not others, a ring inside the tolerance
  // leaves a chord off its row between the two, and the fan and the mesher don't meet (#1042701 refined to its cap);
  // cut on none, it is as before, the edges' spans from the pole whole (#1041642's 1.46 long, crossing the edge
  // beside it).
  bool exact = !cuts.empty();
  for (size_t i = 0; i < ring.approaches.size() && exact; i++)
    for (size_t j = i + 1; j < ring.approaches.size() && exact; j++) {
      const auto [ei, ti] = ring.approaches[i];
      const auto [ej, tj] = ring.approaches[j];
      if (ei == ej && norm(em.point(ei, ti) - em.point(ej, tj)) > ring.reach) exact = false;
    }
  for (RingCut& c : cuts) c.exact = exact;
  return cuts;
}

void shareRings(const std::vector<const Surface*>& surfaces, std::vector<std::vector<PoleRing>>& rings, double tol) {
  // Each pole's rings (face, index), by its point.
  std::vector<std::vector<std::pair<int, int>>> groups;
  std::vector<Vec3> points;
  for (int f = 0; f < static_cast<int>(rings.size()); f++)
    for (int k = 0; k < static_cast<int>(rings[f].size()); k++) {
      const PoleRing& r = rings[f][k];
      if (r.kase == PoleRing::Case::outside) continue;
      size_t g = 0;
      while (g < points.size() && norm(points[g] - r.pole) > tol) g++;
      if (g == points.size()) points.push_back(r.pole), groups.emplace_back();
      groups[g].push_back({f, k});
    }
  for (const auto& group : groups) {
    double least = kInf;
    for (auto [f, k] : group) least = std::min(least, rings[f][k].wanted);
    for (auto [f, k] : group) {
      PoleRing& r = rings[f][k];
      if (r.wanted == least) {
        r.reach = least;
        continue;
      }
      r.radius = ringRadius(*surfaces[f], r, least);
      r.reach = ringReach(*surfaces[f], r, r.radius);
    }
  }
}

std::vector<int> shrinkRings(const std::vector<const Surface*>& surfaces, std::vector<std::vector<PoleRing>>& rings,
  double tol, Vec3 pole, double reach) {
  std::vector<int> changed;
  for (int f = 0; f < static_cast<int>(rings.size()); f++) {
    bool any = false;
    for (PoleRing& r : rings[f]) {
      if (r.kase == PoleRing::Case::outside || norm(r.pole - pole) > tol || !(r.reach > reach)) continue;
      r.radius = ringRadius(*surfaces[f], r, reach);
      r.reach = reach;
      any = true;
    }
    if (any) changed.push_back(f);
  }
  return changed;
}

} // namespace tesscadio
