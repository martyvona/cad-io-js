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
// point that does neither; a triangle no point improves is final. The segments it wanted split are collected
// (mesh2d_impl.h). Quality near the boundary is so limited by the boundary's own spacing.
#include <algorithm>
#include <cmath>
#include <queue>
#include <set>
#include <unordered_set>

#include "cdt.h"
#include "mesh2d_impl.h"

namespace tesscadio {

namespace {

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
    bool operator<(const Item& o) const { return key < o.key || (key == o.key && seq > o.seq); }
  };
  std::priority_queue<Item> queue;
  int64_t seq = 0;
  std::set<std::pair<int32_t, uint32_t>> finals;
  const double minAngle = std::clamp(options.minAngle, 0.0, M_PI / 3), minSine = detSin(minAngle);
  // (l / 2) / tan(minAngle / 2), the off-centre's height over its edge, as a factor of l.
  const double offHeight = minAngle > 0 ? 0.5 * detCos(0.5 * minAngle) / detSin(0.5 * minAngle) : 1e300;
  auto consider = [&](int32_t t) {
    const cdt::Tri& R = T.tris()[t];
    if (R.dead || !R.inside || R.v[2] == kGhost) return;
    Vec2 p[3];
    corners(t, p);
    Quality q = quality(average(metricAt(R.v[0]), metricAt(R.v[1]), metricAt(R.v[2])), p);
    bool accepted = field.accept(p);
    double key = std::max({q.longest / std::sqrt(2.0), minSine / std::max(q.sine, 1e-300), accepted ? 0.0 : 2.0});
    if (key > 1) queue.push({key, seq++, t, R.gen});
  };
  for (int32_t t = 0; t < static_cast<int32_t>(T.tris().size()); t++) consider(t);
  int steiner = 0;
  std::vector<int32_t> created;
  std::vector<std::pair<int32_t, int32_t>> hits;
  std::unordered_set<uint64_t> wanted;
  while (!queue.empty()) {
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
    auto acceptable = [&](Vec2 q, int32_t& at, bool record) {
      at = T.locate(q, it.t);
      const cdt::Tri& W = T.tris()[at];
      if (W.v[2] == kGhost || !W.inside) return false;
      T.cavityConstraints(q, at, hits, mapAt(q));
      bool clear = true;
      for (auto [u, v] : hits) {
        Vec2 U = T.points()[u], V = T.points()[v];
        Metric2 Ms = average(metricAt(u), metricAt(v), M);
        if (mdot(Ms, sub(q, U), sub(q, V)) <= 0) {
          clear = false;
          if (record) {
            wanted.insert((static_cast<uint64_t>(std::min(u, v)) << 32) | static_cast<uint32_t>(std::max(u, v)));
          }
        }
      }
      return clear;
    };
    int32_t at = -1;
    double f = 1;
    bool placed = acceptable(c, at, true);
    for (int k = 0; k < 12 && !placed; k++) {
      f *= 0.5;
      Vec2 q{g.x + (c.x - g.x) * f, g.y + (c.y - g.y) * f};
      if (acceptable(q, at, false)) c = q, placed = true;
    }
    // Too near a vertex of where it lands (a tenth of the triangle's shortest edge, or of a unit in the metric if
    // that's shorter): no improvement, the triangle final. Relative, since angles and the caller's criteria ask for
    // triangles below the metric's size (they end by meeting them, by the fixed boundary's limits, or by maxPoints).
    if (placed) {
      double floor = 0.1 * std::min(1.0, l[s]);
      for (int32_t w : T.tris()[at].v)
        if (w >= 0 && mlen(M, sub(c, T.points()[w])) < floor) placed = false;
    }
    if (!placed || f < 0.05) {
      D.refused++;
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
    for (int32_t t : created) consider(t);
  }
  D.finalTriangles = static_cast<int>(finals.size());
  for (uint64_t k : wanted) {
    D.splitWanted.push_back(static_cast<int32_t>(k >> 32));
    D.splitWanted.push_back(static_cast<int32_t>(k & 0xffffffffu));
  }
  // Sorted pairs, so the report doesn't depend on the set's order.
  std::vector<std::pair<int32_t, int32_t>> sw;
  for (size_t i = 0; i + 1 < D.splitWanted.size(); i += 2) sw.push_back({D.splitWanted[i], D.splitWanted[i + 1]});
  std::sort(sw.begin(), sw.end());
  D.splitWanted.clear();
  for (auto [u, v] : sw) D.splitWanted.insert(D.splitWanted.end(), {u, v});

  out.points = T.points();
  for (int32_t t = 0; t < static_cast<int32_t>(T.tris().size()); t++) {
    const cdt::Tri& R = T.tris()[t];
    if (R.dead || !R.inside || R.v[2] == kGhost) continue;
    Vec2 p[3];
    corners(t, p);
    int32_t index = static_cast<int32_t>(out.triangles.size() / 3);
    out.triangles.insert(out.triangles.end(), {R.v[0], R.v[1], R.v[2]});
    if (!field.accept(p)) out.rejected.push_back(index);
  }
  return out;
}

Mesh2 mesh2(const Domain2& domain, const SizeField& field, const MeshOptions& options) {
  return mesh2Detailed(domain, field, options, nullptr);
}

} // namespace tesscadio
