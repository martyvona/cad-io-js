// mesh2d.h: the domain's points triangulated (cdt.h), its loops and interior segments recovered as constrained edges,
// the outside and holes labelled away, then Delaunay refinement in the caller's metric with the boundary fixed.
// Refinement (Ruppert, "A Delaunay refinement algorithm for quality 2-dimensional mesh generation", J. Algorithms 18,
// 1995; Chew, "Guaranteed-quality mesh generation for curved surfaces", 1993; Shewchuk 2002, cdt.h) inserts, for a bad
// triangle, its circumcentre in the triangle's own metric (Borouchaki, George, Hecht, Laug and Saltel, "Delaunay mesh
// generation governed by metric specifications", Finite Elements in Analysis and Design 25, 1997: lengths and angles
// measured in M, the metric averaged over the triangle's vertices), pulled in to Ungor's off-centre where that's nearer
// ("Off-centers: a new type of Steiner points for computing size-optimal quality-guaranteed Delaunay
// triangulations", LATIN 2004). A triangle is bad where an edge is longer than sqrt 2 in the metric, its smallest
// angle there is under the minimum, or the caller's accept() refuses it. Decisions use no C library function that
// isn't correctly rounded (sqrt is; sin, tan and acos aren't, and differ between targets), so every target meshes
// alike.
// The boundary can't be split, so a candidate that would encroach a constrained segment (inside its diametral circle
// in the metric) or fall outside the domain is moved back along the ray from the triangle's centroid to the last
// point that does neither; a triangle no point improves is final. A segment is reported to split (Mesh2::splitWanted)
// where a triangle refused for encroaching it (or for a candidate outside the domain: the segment the ray from the
// centroid crosses first) is still in the mesh at the end and either the segment is longer than
// sqrt 2 in the metric or accept() still refuses the triangle: a segment within the size isn't reported for the
// angles or lengths of the triangles on it (splitting it wouldn't end that: the next one along would be wanted), so a
// domain fine enough reports nothing. Quality near the boundary is so limited by the boundary's own spacing.
#include <algorithm>
#include <map>
#include <cmath>
#include <queue>
#include <set>
#include <tuple>

#include "cdt.h"
#include "mesh2d_impl.h"

namespace tesscadio {

namespace {

/**
 * A refused candidate's cavity (triangles) past which it isn't moved toward the centroid again. Over the corpus
 * subset's ordinary faces no cavity reached 512 triangles and no refused first try 256; those that pass 1,024 are a
 * long fixed segment opposite an arc's cocircular samples, where every halving's cavity is the whole mesh too and
 * each refused triangle cost 13 of them (as1_motor's 29 m half-discs, 20,000 arc samples: hours).
 */
constexpr size_t kHalvingCavity = 1024;
/**
 * A refused triangle whose candidates encroach only segments shorter than its longest edge over this (in the metric)
 * is broken from inside instead of asking them split; a segment longer than kLongSegment x a refused triangle's
 * longest edge is asked split.
 */
constexpr double kShortSegment = 4;
constexpr double kLongSegment = 4;
/**
 * Times a triangle that survives the point inserted for it is queued again before it's left as it is: each time
 * another point is placed for it, so it can't loop.
 */
constexpr int kRequeues = 3;

using cdt::kBoundary;
using cdt::kGhost;
using cdt::kInterior;

Metric2 average(Metric2 a, Metric2 b, Metric2 c) {
  return {(a.a + b.a + c.a) / 3, (a.b + b.b + c.b) / 3, (a.c + b.c + c.c) / 3};
}
double mdot(const Metric2& M, Vec2 u, Vec2 v) {
  return M.a * u.x * v.x + M.b * (u.x * v.y + u.y * v.x) + M.c * u.y * v.y;
}
double mlen(const Metric2& M, Vec2 u) { return std::sqrt(std::max(0.0, mdot(M, u, u))); }
Vec2 sub(Vec2 a, Vec2 b) { return {a.x - b.x, a.y - b.y}; }
/** A segment's key, its points sorted: the same whichever way it runs. */
uint64_t pairKey(int32_t u, int32_t v) {
  return (static_cast<uint64_t>(std::min(u, v)) << 32) | static_cast<uint32_t>(std::max(u, v));
}

/**
 * sin and cos by their Taylor series, for |x| <= pi / 2: only +, -, *, / (correctly rounded everywhere), so the
 * thresholds below are the same bits on every target, where the C library's sin and tan aren't (macOS's and
 * Emscripten's differ in the last place, and refinement's decisions with them).
 */
double detSin(double x) {
  double term = x, sum = x;
  for (int k = 1; k < 14; k++) term *= -x * x / ((2 * k) * (2 * k + 1)), sum += term;
  return sum;
}
double detCos(double x) {
  double term = 1, sum = 1;
  for (int k = 1; k < 14; k++) term *= -x * x / ((2 * k - 1) * (2 * k)), sum += term;
  return sum;
}

/**
 * A triangle's measures in metric M: its longest edge and the sine of its smallest angle (the least of its corners'
 * sines: an angle over pi / 2 has the sine of the other two's sum, at least theirs), by the metric's cross product
 * sqrt(det M) (u x v) and square roots alone, which round alike everywhere.
 */
struct Quality {
  double longest, sine;
};
Quality quality(const Metric2& M, const Vec2 p[3]) {
  double l[3], sine = 1, area = std::sqrt(std::max(0.0, M.a * M.c - M.b * M.b));
  for (int i = 0; i < 3; i++) l[i] = mlen(M, sub(p[(i + 2) % 3], p[(i + 1) % 3]));  // opposite vertex i
  for (int i = 0; i < 3; i++) {
    Vec2 u = sub(p[(i + 1) % 3], p[i]), v = sub(p[(i + 2) % 3], p[i]);
    double cross = std::fabs(u.x * v.y - u.y * v.x) * area;
    sine = std::min(sine, cross / std::max(1e-300, mlen(M, u) * mlen(M, v)));
  }
  return {std::max({l[0], l[1], l[2]}), sine};
}

/** The circumcentre in metric M: equidistant from the three points in it (a 2 x 2 solve). */
bool circumcentre(const Metric2& M, const Vec2 p[3], Vec2& out) {
  // 2 (p_i - p_0)^T M c = p_i^T M p_i - p_0^T M p_0, i = 1, 2, relative to p_0 (c = p_0 + x).
  Vec2 u = sub(p[1], p[0]), v = sub(p[2], p[0]);
  double a11 = 2 * (M.a * u.x + M.b * u.y), a12 = 2 * (M.b * u.x + M.c * u.y);
  double a21 = 2 * (M.a * v.x + M.b * v.y), a22 = 2 * (M.b * v.x + M.c * v.y);
  double b1 = mdot(M, u, u), b2 = mdot(M, v, v), det = a11 * a22 - a12 * a21;
  if (!(std::fabs(det) > 0)) return false;
  out = {p[0].x + (b1 * a22 - b2 * a12) / det, p[0].y + (a11 * b2 - a21 * b1) / det};
  return std::isfinite(out.x) && std::isfinite(out.y);
}

} // namespace

Mesh2 mesh2Detailed(const Domain2& domain, const SizeField& field, const MeshOptions& options, Mesh2Detail* detail) {
  Mesh2 out;
  Mesh2Detail local;
  Mesh2Detail& D = detail ? *detail : local;
  D = {};
  out.status = Status::invalidModel;
  int32_t n = static_cast<int32_t>(domain.points.size());
  auto valid = [&](int32_t i) { return i >= 0 && i < n; };
  for (const auto& loop : domain.loops) {
    if (loop.size() < 3) return out;
    for (int32_t i : loop)
      if (!valid(i)) return out;
  }
  if (domain.segments.size() % 2) return out;
  for (int32_t i : domain.segments)
    if (!valid(i)) return out;

  cdt::Triangulation T(domain.points);
  int32_t dup[2];
  if (!T.build(dup)) {
    if (dup[0] >= 0) out.rejected = {dup[0], dup[1]};
    return out;
  }
  // The boundary, then the interior segments; every failure named (the segment and what stops it).
  bool ok = true;
  auto constrain = [&](int32_t a, int32_t b, uint8_t flags) {
    int32_t other[2];
    if (a == b || T.insertSegment(a, b, flags, other)) return;
    ok = false;
    out.rejected.insert(out.rejected.end(), {a, b});
    if (other[0] >= 0 && other[1] >= 0) out.rejected.insert(out.rejected.end(), {other[0], other[1]});
    else if (other[0] >= 0) out.rejected.insert(out.rejected.end(), {other[0], other[0]});
  };
  for (const auto& loop : domain.loops)
    for (size_t k = 0; k < loop.size(); k++) constrain(loop[k], loop[(k + 1) % loop.size()], kBoundary);
  for (size_t k = 0; k + 1 < domain.segments.size(); k += 2)
    constrain(domain.segments[k], domain.segments[k + 1], kInterior);
  if (!ok) return out;
  // Segments the caller can't split (Domain2::frozen): their encroachment doesn't refuse a point.
  std::set<uint64_t> frozen;
  {
    size_t k = 0;
    auto add = [&](int32_t a, int32_t b) {
      if (k < domain.frozen.size() && domain.frozen[k] && a != b) frozen.insert(pairKey(a, b));
      k++;
    };
    for (const auto& loop : domain.loops)
      for (size_t i = 0; i < loop.size(); i++) add(loop[i], loop[(i + 1) % loop.size()]);
    for (size_t i = 0; i + 1 < domain.segments.size(); i += 2) add(domain.segments[i], domain.segments[i + 1]);
  }
  T.label();
  out.status = Status::ok;

  // Refinement: the worst triangle first (by how far it is from good), each queued with its generation so a
  // replaced one is skipped.
  std::vector<Metric2> metric;
  auto metricAt = [&](int32_t v) {
    while (static_cast<int32_t>(metric.size()) <= v) metric.push_back(field.metric(T.points()[metric.size()]));
    return metric[v];
  };
  auto corners = [&](int32_t t, Vec2 p[3]) {
    for (int i = 0; i < 3; i++) p[i] = T.points()[T.tris()[t].v[i]];
  };
  struct Item {
    double key;
    int64_t seq;
    int32_t t;
    uint32_t gen;
    // What queued it (Mesh2Detail::inserted's index).
    uint8_t cause;
    bool operator<(const Item& o) const { return key < o.key || (key == o.key && seq > o.seq); }
  };
  std::priority_queue<Item> queue;
  int64_t seq = 0;
  std::set<std::pair<int32_t, uint32_t>> finals;
  // Per triangle, how often it survived the point inserted for it (kRequeues).
  std::map<std::pair<int32_t, uint32_t>, int> survived;
  const double minAngle = std::clamp(options.minAngle, 0.0, kMaxMinAngle), minSine = detSin(minAngle);
  // (l / 2) / tan(minAngle / 2), the off-centre's height over its edge, as a factor of l.
  const double offHeight = minAngle > 0 ? 0.5 * detCos(0.5 * minAngle) / detSin(0.5 * minAngle) : 1e300;
  auto consider = [&](int32_t t) {
    const cdt::Tri& R = T.tris()[t];
    if (R.dead || !R.inside || R.v[2] == kGhost) return;
    Vec2 p[3];
    corners(t, p);
    Quality q = quality(average(metricAt(R.v[0]), metricAt(R.v[1]), metricAt(R.v[2])), p);
    bool accepted = field.accept(p);
    // (Thinness alone doesn't queue a triangle the criteria accept that is within their refinement floor: with the
    // boundary fixed, nothing else ends refinement for angle beside a long boundary segment, which drives points into
    // its corner without end: ohmm-ap203's plates, 200,000 points into one.)
    double thin = accepted && field.belowFloor(p) ? 0.0 : minSine / std::max(q.sine, 1e-300);
    double key = std::max({q.longest / std::sqrt(2.0), thin, accepted ? 0.0 : 2.0});
    if (key <= 1) return;
    uint8_t cause = q.longest / std::sqrt(2.0) >= thin ? 0 : 1;
    if (!accepted)
      cause = detail && options.refusalKinds ? static_cast<uint8_t>(2 + std::clamp(field.refusalKind(p), 0, 7)) : 2;
    queue.push({key, seq++, t, R.gen, cause});
  };
  int steiner = 0;
  std::vector<int32_t> created;
  {
    // The seeds along a Morton curve, each where it lands from the last one's triangle: in their own order (a mesh's
    // Steiner points by its refinement queue) each walk crosses the mesh, and a face's millions take thousands of
    // seconds. A heartbeat every 1024, the loop's only one.
    int32_t hint = 0;
    uint32_t seeded = 0;
    for (int32_t i : cdt::mortonOrder(domain.seeds)) {
      if (steiner >= options.maxPoints) break;
      if (options.onWork && (++seeded & 1023) == 0) options.onWork();
      const Vec2 q = domain.seeds[i];
      if (hint >= static_cast<int32_t>(T.tris().size()) || T.tris()[hint].dead) hint = 0;
      while (T.tris()[hint].dead) hint++;
      const int32_t at = T.locate(q, hint);
      const cdt::Tri& W = T.tris()[at];
      if (W.v[2] == kGhost || !W.inside) continue;
      Metric2 Mq = field.metric(q);
      double l11 = std::sqrt(std::max(Mq.a, 1e-300)), l12 = Mq.b / l11;
      if (T.insertPoint(q, at, created, {l11, l12, std::sqrt(std::max(Mq.c - l12 * l12, 1e-300))}) < 0) continue;
      steiner++;
      D.inserted[10]++;
      if (!created.empty()) hint = created[0];
    }
  }
  for (int32_t t = 0; t < static_cast<int32_t>(T.tris().size()); t++) consider(t);
  std::vector<std::pair<int32_t, int32_t>> hits;
  // Each refusal for encroachment: the segment (its sorted point pair) and the triangle refused, as it was.
  std::vector<std::tuple<uint64_t, int32_t, uint32_t>> wanted;
  std::vector<uint64_t> encroached;
  uint32_t work = 0;
  while (!queue.empty()) {
    if (options.onWork && (++work & 1023) == 0) options.onWork();
    Item it = queue.top();
    queue.pop();
    const cdt::Tri& R = T.tris()[it.t];
    if (R.dead || R.gen != it.gen) continue;
    Vec2 p[3];
    corners(it.t, p);
    Metric2 M = average(metricAt(R.v[0]), metricAt(R.v[1]), metricAt(R.v[2]));
    Vec2 c;
    if (!circumcentre(M, p, c)) {
      finals.insert({it.t, it.gen});
      continue;
    }
    // Ungor's off-centre: no farther from the shortest edge's middle than where the new triangle on it is just good,
    // its smallest angle (at the new point) minAngle, so its height there (l / 2) / tan(minAngle / 2).
    double l[3];
    for (int i = 0; i < 3; i++) l[i] = mlen(M, sub(p[(i + 2) % 3], p[(i + 1) % 3]));
    int s = l[0] <= l[1] && l[0] <= l[2] ? 0 : l[1] <= l[2] ? 1 : 2;
    Vec2 a = p[(s + 1) % 3], b = p[(s + 2) % 3], m{0.5 * (a.x + b.x), 0.5 * (a.y + b.y)};
    double h = mlen(M, sub(c, m)), hmax = offHeight * l[s];
    if (h > hmax && h > 0) c = {m.x + (c.x - m.x) * hmax / h, m.y + (c.y - m.y) * hmax / h};
    // Placed where it neither leaves the domain nor encroaches a constrained segment: back along the ray from the
    // centroid by halving where it does (the centroid is inside the triangle, so in the domain).
    Vec2 g{(p[0].x + p[1].x + p[2].x) / 3, (p[0].y + p[1].y + p[2].y) / 3};
    // The candidate's cavity is Delaunay in its own metric (mapped by the metric's Cholesky factor there).
    auto mapAt = [&](Vec2 q) {
      Metric2 Mq = field.metric(q);
      double l11 = std::sqrt(std::max(Mq.a, 1e-300)), l12 = Mq.b / l11;
      return cdt::Map2{l11, l12, std::sqrt(std::max(Mq.c - l12 * l12, 1e-300))};
    };
    // Whether a candidate is clear, and its cavity in triangles (none where it leaves the domain).
    struct Verdict {
      bool clear;
      size_t cavity;
    };
    auto acceptable = [&](Vec2 q, int32_t& at, bool record) -> Verdict {
      at = T.locate(q, it.t);
      const cdt::Tri& W = T.tris()[at];
      if (W.v[2] == kGhost || !W.inside) {
        // Outside the domain: the boundary segment the ray from the centroid crosses first is the one in the way.
        std::pair<int32_t, int32_t> e;
        if (record && T.firstConstraint(g, q, it.t, e)) encroached.push_back(pairKey(e.first, e.second));
        return {false, 0};
      }
      const size_t cavity = T.cavityConstraints(q, at, hits, mapAt(q));
      bool clear = true;
      for (auto [u, v] : hits) {
        if (!frozen.empty() && frozen.count(pairKey(u, v))) continue;
        Vec2 U = T.points()[u], V = T.points()[v];
        Metric2 Ms = average(metricAt(u), metricAt(v), M);
        if (mdot(Ms, sub(q, U), sub(q, V)) <= 0) {
          clear = false;
          if (record) encroached.push_back(pairKey(u, v));
        }
      }
      return {clear, cavity};
    };
    int32_t at = -1;
    double f = 1;
    encroached.clear();
    const Verdict first = acceptable(c, at, true);
    bool placed = first.clear;
    // No halvings after a refusal whose cavity passed kHalvingCavity: the halvings' cavities are as large (each a
    // search of that many triangles), and such cavities come from a fixed segment far longer than the triangles,
    // opposite cocircular boundary points (an arc's samples), which every candidate encroaches.
    const int halvings = !placed && first.cavity > kHalvingCavity ? 0 : 12;
    if (halvings == 0) D.halvingsSkipped++;
    for (int k = 0; k < halvings && !placed; k++) {
      f *= 0.5;
      Vec2 q{g.x + (c.x - g.x) * f, g.y + (c.y - g.y) * f};
      if (acceptable(q, at, false).clear) c = q, placed = true;
    }
    // Too near a vertex of where it lands (a tenth of the triangle's shortest edge, or of a unit in the metric if
    // that's shorter): no improvement, the triangle final. Relative, since angles and the caller's criteria ask for
    // triangles below the metric's size (they end by meeting them, by the fixed boundary's limits, or by maxPoints).
    bool nearVertex = false;
    if (placed) {
      double floor = 0.1 * std::min(1.0, l[s]);
      for (int32_t w : T.tris()[at].v)
        if (w >= 0 && mlen(M, sub(c, T.points()[w])) < floor) placed = false, nearVertex = true;
    }
    // A triangle only a much shorter segment stands in the way of (each one it encroached shorter in the metric than
    // its longest edge over kShortSegment) is broken from inside instead, at its centroid where that's clear:
    // splitting such a segment, once a round, would leave the triangle as it is for many rounds (arm's half cylinder:
    // fans of slivers 28 mm long over a fixed arc's 1.5 mm segments). So is one whose candidate lands on a vertex
    // already there (a regular grid's cocircular points, a sine sheet's: else final, refused, its face past the
    // deflection).
    if ((!placed || f < 0.05) && (!encroached.empty() || nearVertex)) {
      double longest = std::max({l[0], l[1], l[2]});
      bool shortOnly = true;
      for (uint64_t k : encroached) {
        int32_t u = static_cast<int32_t>(k >> 32), v = static_cast<int32_t>(k & 0xffffffffu);
        shortOnly = shortOnly && kShortSegment * mlen(M, sub(T.points()[v], T.points()[u])) < longest;
      }
      // (The centroid too near a corner, as placements are: a flat triangle's is about a third of its height from
      // the obtuse corner.)
      if (shortOnly && acceptable(g, at, false).clear) {
        c = g, placed = true, f = 1;
        bool near = false;
        double floor = 0.1 * std::min(1.0, l[s]);
        for (int32_t w : T.tris()[at].v) near = near || (w >= 0 && mlen(M, sub(c, T.points()[w])) < floor);
        if (near) placed = false;
        else D.brokenInside++;
      }
    }
    // Still nothing (a long sliver's circumcentre leaves the domain or crowds its boundary, whose splits don't cure
    // it): where the criteria refuse it for its distance from the surface, broken at the point they find farthest,
    // inside it, cleared and kept from its corners as any candidate is.
    if (!placed || f < 0.05) {
      Vec2 w;
      int32_t atW;
      if (field.worstPoint(p, w) && acceptable(w, atW, false).clear) {
        // (Kept a tenth of the triangle's least height in the metric from a vertex, not of its shortest edge as the
        // other candidates are: a sliver's every inside point is within its height of a corner.)
        bool near = false;
        const double area = 0.5 * std::fabs(cross(sub(p[1], p[0]), sub(p[2], p[0]))) * std::sqrt(M.a * M.c - M.b * M.b);
        double floor = 0.1 * std::min(1.0, 2 * area / std::max({l[0], l[1], l[2]}));
        for (int32_t v : T.tris()[atW].v) near = near || (v >= 0 && mlen(M, sub(w, T.points()[v])) < floor);
        if (!near) c = w, at = atW, placed = true, f = 1, D.brokenWorst++;
      }
    }
    if (!placed || f < 0.05) {
      D.refused++;
      // No segment the first candidate named that can be split (none, or each frozen: it left the domain across
      // one): the segments its centroid encroaches named instead, since they are what refused the halvings; else the
      // triangle asks for nothing while refused (arm's half cylinder beside its corners).
      bool noneSplittable = true;
      for (uint64_t k : encroached) noneSplittable = noneSplittable && frozen.count(k);
      if (noneSplittable) {
        int32_t at2;
        acceptable(g, at2, true);
      }
      for (uint64_t k : encroached) wanted.push_back({k, it.t, it.gen});
      finals.insert({it.t, it.gen});
      continue;
    }
    // The cap counts points inserted: reached only when another is wanted (a refinement that would have ended on
    // the cap's last point is ok), and then the mesh as it is, valid, with noConvergence.
    if (steiner >= options.maxPoints) {
      out.status = Status::noConvergence;
      break;
    }
    if (T.insertPoint(c, at, created, mapAt(c)) < 0) {
      D.refused++;
      finals.insert({it.t, it.gen});
      continue;
    }
    steiner++;
    D.inserted[it.cause]++;
    for (int32_t t : created) consider(t);
    // Its point placed outside it (a sliver's usually is), the cavity from where it landed stopped short of it by a
    // constrained edge: still there, unchanged, its refusal standing. Queued again, kRequeues times at most.
    if (!T.tris()[it.t].dead && T.tris()[it.t].gen == it.gen) {
      if (++survived[{it.t, it.gen}] <= kRequeues) consider(it.t), D.requeued++;
      else D.requeuesSpent++;
    }
  }
  D.finalTriangles = static_cast<int>(finals.size());
  if (detail && out.status == Status::ok)
    for (int32_t t = 0; t < static_cast<int32_t>(T.tris().size()); t++) {
      const cdt::Tri& R = T.tris()[t];
      if (R.dead || !R.inside || R.v[2] == kGhost || finals.count({t, R.gen})) continue;
      if (auto s = survived.find({t, R.gen}); s != survived.end() && s->second > kRequeues) continue;
      const size_t before = queue.size();
      consider(t);
      if (queue.size() > before) D.leftUnjudged++, queue.pop();
    }
  // The segments to split: those whose refused triangle is still there, unchanged, and either the segment itself
  // longer than sqrt 2 in its endpoints' metric or the triangle still refused by accept().
  std::set<uint64_t> split;
  for (auto [k, t, gen] : wanted) {
    const cdt::Tri& R = T.tris()[t];
    if (R.dead || R.gen != gen || split.count(k) || frozen.count(k)) continue;
    int32_t u = static_cast<int32_t>(k >> 32), v = static_cast<int32_t>(k & 0xffffffffu);
    Metric2 Mu = metricAt(u), Mv = metricAt(v);
    Metric2 Ms{0.5 * (Mu.a + Mv.a), 0.5 * (Mu.b + Mv.b), 0.5 * (Mu.c + Mv.c)};
    Vec2 p[3];
    corners(t, p);
    // And a segment longer than kLongSegment x the refused triangle's longest edge (in its metric): one the triangle's
    // candidates keep running into, too long beside it to leave fixed (a plane's chord of 2 under its arc's 20,000
    // samples: a fan of slivers to its ends, none ever split).
    double longest = 0;
    for (int i = 0; i < 3; i++) longest = std::max(longest, mlen(Ms, sub(p[(i + 1) % 3], p[i])));
    const double seg = mlen(Ms, sub(T.points()[v], T.points()[u]));
    if (seg > std::sqrt(2.0) || !field.accept(p) || seg > kLongSegment * longest) split.insert(k);
  }
  // In segment order, each once: the domain's segments numbered as SplitWanted says.
  int32_t segment = 0;
  auto report = [&](int32_t a, int32_t b) {
    int32_t i = segment++;
    if (a == b || !split.erase(pairKey(a, b))) return;
    Vec2 A = domain.points[a], B = domain.points[b], e = sub(B, A);
    // The metric's middle where the size h varies linearly from a to b: h(f) = sqrt(h_a h_b), so
    // f = sqrt(h_a) / (sqrt(h_a) + sqrt(h_b)), h at an end |e| over e's length in the metric there.
    double la = mlen(metricAt(a), e), lb = mlen(metricAt(b), e), f = 0.5;
    if (la > 0 && lb > 0 && std::isfinite(la) && std::isfinite(lb)) f = std::sqrt(lb) / (std::sqrt(la) + std::sqrt(lb));
    out.splitWanted.push_back({i, a, b, f, {A.x + f * e.x, A.y + f * e.y}});
  };
  for (const auto& loop : domain.loops)
    for (size_t k = 0; k < loop.size(); k++) report(loop[k], loop[(k + 1) % loop.size()]);
  for (size_t k = 0; k + 1 < domain.segments.size(); k += 2) report(domain.segments[k], domain.segments[k + 1]);

  out.points = T.points();
  for (int32_t t = 0; t < static_cast<int32_t>(T.tris().size()); t++) {
    const cdt::Tri& R = T.tris()[t];
    if (R.dead || !R.inside || R.v[2] == kGhost) continue;
    Vec2 p[3];
    corners(t, p);
    int32_t index = static_cast<int32_t>(out.triangles.size() / 3);
    out.triangles.insert(out.triangles.end(), {R.v[0], R.v[1], R.v[2]});
    if (!field.accept(p)) out.rejected.push_back(index);
    if (!detail) continue;
    const Quality q = quality(average(metricAt(R.v[0]), metricAt(R.v[1]), metricAt(R.v[2])), p);
    if (!(q.sine < minSine)) continue;
    uint8_t flags = 0;
    if (R.v[0] < n && R.v[1] < n && R.v[2] < n) flags |= kThinBoundary;
    for (int i = 0; i < 3; i++)
      if (frozen.count(pairKey(R.v[(i + 1) % 3], R.v[(i + 2) % 3]))) flags |= kThinFrozen;
    if (field.belowFloor(p)) flags |= kThinFloor;
    D.thin.push_back(index), D.thinAngle.push_back(std::asin(std::clamp(q.sine, 0.0, 1.0)));
    D.thinFlags.push_back(flags);
  }
  return out;
}

Mesh2 mesh2(const Domain2& domain, const SizeField& field, const MeshOptions& options) {
  return mesh2Detailed(domain, field, options, nullptr);
}

} // namespace tesscadio
