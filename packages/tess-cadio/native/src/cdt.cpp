// cdt.h's triangulation (sources in its header).
#include "cdt.h"

#include <algorithm>
#include <cstdint>
#include <random>
#include <unordered_map>

#include "cad_geom/predicates.h"

namespace tesscadio {
namespace cdt {

namespace {

int sgn(double x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }
uint64_t key(int32_t a, int32_t b) {
  return (static_cast<uint64_t>(static_cast<uint32_t>(a)) << 32) | static_cast<uint32_t>(b);
}

/** Interleaved bits of a point's grid cell (2^16 a side over the box): an order that keeps neighbours close. */
uint64_t morton(Vec2 p, Vec2 lo, Vec2 span) {
  auto cell = [](double x) {
    double c = std::clamp(x, 0.0, 1.0) * 65535.0;
    return static_cast<uint32_t>(c);
  };
  uint32_t x = cell(span.x > 0 ? (p.x - lo.x) / span.x : 0), y = cell(span.y > 0 ? (p.y - lo.y) / span.y : 0);
  uint64_t m = 0;
  for (int i = 0; i < 16; i++) m |= (uint64_t((x >> i) & 1) << (2 * i)) | (uint64_t((y >> i) & 1) << (2 * i + 1));
  return m;
}

} // namespace

Triangulation::Triangulation(std::vector<Vec2> points) : pts_(std::move(points)) {}

uint32_t Triangulation::fresh() const {
  mark_.resize(tris_.size(), 0);
  if (++stamp_ == 0) std::fill(mark_.begin(), mark_.end(), 0), stamp_ = 1;
  return stamp_;
}

bool Triangulation::firstConstraint(Vec2 from, Vec2 to, int32_t t, std::pair<int32_t, int32_t>& out) const {
  // Each step leaves the triangle by the edge the segment crosses: `to` strictly right of it (outside, the triangle
  // counterclockwise) and the edge's ends not both strictly on one side of the segment's line. A triangle visited
  // twice (a walk along an edge through a vertex) ends the walk.
  std::vector<int32_t> seen;
  for (int step = 0; step < 1 << 20 && t >= 0; step++) {
    const Tri& T = tris_[t];
    if (T.v[2] == kGhost) return false;
    if (std::find(seen.begin(), seen.end(), t) != seen.end()) return false;
    seen.push_back(t);
    int exit = -1;
    for (int i = 0; i < 3 && exit < 0; i++) {
      int32_t a = T.v[(i + 1) % 3], b = T.v[(i + 2) % 3];
      if (orient(a, b, to) >= 0) continue;
      int sa = sgn(cadgeom::orient2d(from, to, pts_[a])), sb = sgn(cadgeom::orient2d(from, to, pts_[b]));
      if (sa * sb <= 0) exit = i;
    }
    if (exit < 0) return false;
    if (T.c[exit] != kFree) {
      out = {T.v[(exit + 1) % 3], T.v[(exit + 2) % 3]};
      return true;
    }
    t = T.n[exit];
  }
  return false;
}

int Triangulation::orient(int32_t a, int32_t b, int32_t c) const {
  return sgn(cadgeom::orient2d(pts_[a], pts_[b], pts_[c]));
}
int Triangulation::orient(int32_t a, int32_t b, Vec2 c) const {
  return sgn(cadgeom::orient2d(pts_[a], pts_[b], c));
}

bool Triangulation::inCircleSoS(int32_t a, int32_t b, int32_t c, int32_t d) const {
  double s = cadgeom::incircle(pts_[a], pts_[b], pts_[c], pts_[d]);
  if (s != 0) return s > 0;
  // An exact tie: each point's lifted height raised by its own infinitesimal, the earliest point's the largest. Raising
  // d's puts it above the paraboloid's plane through a, b, c (outside); raising a's moves that plane up at d by d's
  // barycentric coordinate for a, so d is inside where orient(b, c, d) > 0 (abc counterclockwise); and so on in order.
  int32_t q[4] = {a, b, c, d};
  std::sort(q, q + 4, [&](int32_t x, int32_t y) { return rank_[x] < rank_[y]; });
  for (int32_t x : q) {
    int o = x == d ? -1 : x == a ? orient(b, c, d) : x == b ? orient(c, a, d) : orient(a, b, d);
    if (o != 0) return o > 0;
  }
  return false;
}

bool Triangulation::inCircle(int32_t t, int32_t d) const {
  const Tri& T = tris_[t];
  if (T.v[2] == kGhost) {
    // Outside the hull: the open half-plane beyond the hull edge, and the edge's own open segment.
    int o = orient(T.v[0], T.v[1], d);
    if (o != 0) return o > 0;
    Vec2 u = pts_[T.v[0]], v = pts_[T.v[1]], p = pts_[d];
    double s = (p.x - u.x) * (v.x - u.x) + (p.y - u.y) * (v.y - u.y);
    double l = (v.x - u.x) * (v.x - u.x) + (v.y - u.y) * (v.y - u.y);
    return s > 0 && s < l;
  }
  return inCircleSoS(T.v[0], T.v[1], T.v[2], d);
}

int32_t Triangulation::newTri(int32_t a, int32_t b, int32_t c) {
  // A ghost keeps its ghost last.
  if (a == kGhost) std::swap(a, b), std::swap(b, c);
  else if (b == kGhost) std::swap(b, c), std::swap(a, b);
  int32_t t;
  if (!free_.empty()) {
    t = free_.back();
    free_.pop_back();
  } else {
    t = static_cast<int32_t>(tris_.size());
    tris_.push_back({});
  }
  Tri& T = tris_[t];
  uint32_t gen = T.gen + 1;
  T = Tri{{a, b, c}, {-1, -1, -1}, {kFree, kFree, kFree}, false, true, gen};
  for (int32_t v : {a, b, c})
    if (v >= 0) vtri_[v] = t;
  return t;
}

void Triangulation::kill(int32_t t) {
  tris_[t].dead = true;
  tris_[t].gen++;
  free_.push_back(t);
}

void Triangulation::link(const std::vector<int32_t>& created, const std::vector<std::pair<int32_t, int>>& outside) {
  std::unordered_map<uint64_t, std::pair<int32_t, int>> edges;
  for (int32_t t : created)
    for (int i = 0; i < 3; i++) edges[key(tris_[t].v[(i + 1) % 3], tris_[t].v[(i + 2) % 3])] = {t, i};
  for (int32_t t : created)
    for (int i = 0; i < 3; i++) {
      auto it = edges.find(key(tris_[t].v[(i + 2) % 3], tris_[t].v[(i + 1) % 3]));
      if (it != edges.end()) tris_[t].n[i] = it->second.first;
    }
  for (auto [o, j] : outside) {
    const Tri& O = tris_[o];
    auto it = edges.find(key(O.v[(j + 2) % 3], O.v[(j + 1) % 3]));
    if (it == edges.end()) continue;
    auto [t, i] = it->second;
    tris_[t].n[i] = o;
    tris_[t].c[i] = O.c[j];
    tris_[o].n[j] = t;
  }
  last_ = created.empty() ? last_ : created.back();
}

int32_t Triangulation::triOf(int32_t v) const {
  int32_t t = vtri_[v];
  if (t >= 0 && !tris_[t].dead) {
    const Tri& T = tris_[t];
    if (T.v[0] == v || T.v[1] == v || T.v[2] == v) return t;
  }
  for (int32_t k = 0; k < static_cast<int32_t>(tris_.size()); k++) {
    const Tri& T = tris_[k];
    if (!T.dead && (T.v[0] == v || T.v[1] == v || T.v[2] == v)) return vtri_[v] = k;
  }
  return -1;
}

std::pair<int32_t, int> Triangulation::findEdge(int32_t a, int32_t b) const {
  int32_t t0 = triOf(a), t = t0;
  if (t < 0) return {-1, -1};
  // Round a's star by the edges through it.
  for (size_t guard = 0; guard <= tris_.size(); guard++) {
    const Tri& T = tris_[t];
    int i = T.v[0] == a ? 0 : T.v[1] == a ? 1 : 2;
    if (T.v[(i + 1) % 3] == b) return {t, (i + 2) % 3};
    t = T.n[(i + 2) % 3];
    if (t == t0 || t < 0) break;
  }
  return {-1, -1};
}

int32_t Triangulation::locate(Vec2 p, int32_t hint) const {
  int32_t t = hint >= 0 && hint < static_cast<int32_t>(tris_.size()) && !tris_[hint].dead ? hint : last_;
  if (tris_[t].dead) {
    for (t = 0; tris_[t].dead; t++) {}
  }
  int32_t from = -1;
  uint32_t r = 0x9e3779b9u;
  // A remembering stochastic walk (Devillers, Pion and Teillaud): never straight back, edges tried from a varying
  // first one, so it ends in a constrained (not Delaunay) triangulation too.
  for (size_t steps = 0; steps < 4 * tris_.size() + 16; steps++) {
    const Tri& T = tris_[t];
    if (T.v[2] == kGhost) {
      // Outside the hull: done if p is beyond this hull edge, else back in across it.
      if (orient(T.v[0], T.v[1], p) > 0) return t;
      from = t, t = T.n[2];
      continue;
    }
    r = r * 1664525u + 1013904223u;
    int first = static_cast<int>(r >> 30) % 3, next = -1;
    for (int k = 0; k < 3; k++) {
      int i = (first + k) % 3;
      if (T.n[i] == from) continue;
      if (orient(T.v[(i + 1) % 3], T.v[(i + 2) % 3], p) < 0) {
        next = i;
        break;
      }
    }
    if (next < 0) {
      // Not across any edge but (maybe) the one we came by: check it too, then p is in t.
      for (int i = 0; i < 3; i++)
        if (T.n[i] == from && orient(T.v[(i + 1) % 3], T.v[(i + 2) % 3], p) < 0) next = i;
      if (next < 0) return t;
    }
    from = t, t = T.n[next];
  }
  // A walk that didn't end (it shouldn't): every triangle tried.
  for (int32_t k = 0; k < static_cast<int32_t>(tris_.size()); k++) {
    const Tri& T = tris_[k];
    if (T.dead || T.v[2] == kGhost) continue;
    if (orient(T.v[0], T.v[1], p) >= 0 && orient(T.v[1], T.v[2], p) >= 0 && orient(T.v[2], T.v[0], p) >= 0) return k;
  }
  return t;
}

bool Triangulation::build(int32_t duplicate[2]) {
  int32_t n = static_cast<int32_t>(pts_.size());
  duplicate[0] = duplicate[1] = -1;
  vtri_.assign(n, -1);
  rank_.assign(n, 0);
  if (n < 3) return false;
  // The order: shuffled by a fixed seed (Fisher-Yates on mt19937's output: the same everywhere), then in rounds of
  // doubling size (a biased randomized insertion order, Amenta, Choi and Rote), each round along a Morton curve.
  std::vector<int32_t> order(n);
  for (int32_t i = 0; i < n; i++) order[i] = i;
  std::mt19937 rng(20261115u);
  for (int32_t i = n - 1; i > 0; i--) std::swap(order[i], order[rng() % static_cast<uint32_t>(i + 1)]);
  Vec2 lo = pts_[0], hi = pts_[0];
  for (Vec2 p : pts_) lo = {std::min(lo.x, p.x), std::min(lo.y, p.y)}, hi = {std::max(hi.x, p.x), std::max(hi.y, p.y)};
  Vec2 span{hi.x - lo.x, hi.y - lo.y};
  for (int32_t start = 0, size = 1; start < n; start += size, size *= 2) {
    int32_t end = std::min(n, start + size);
    std::stable_sort(order.begin() + start, order.begin() + end,
      [&](int32_t a, int32_t b) { return morton(pts_[a], lo, span) < morton(pts_[b], lo, span); });
  }
  for (int32_t i = 0; i < n; i++) rank_[order[i]] = static_cast<uint32_t>(i);
  // The first triangle: the first point, the next distinct one, the first not collinear with them.
  int32_t a = order[0], b = -1, c = -1;
  for (int32_t i = 1; i < n && b < 0; i++) {
    if (pts_[order[i]].x == pts_[a].x && pts_[order[i]].y == pts_[a].y) {
      duplicate[0] = a, duplicate[1] = order[i];
      return false;
    }
    b = order[i];
  }
  for (int32_t i = 1; i < n && c < 0; i++)
    if (order[i] != b && orient(a, b, order[i]) != 0) c = order[i];
  if (c < 0) return false;
  if (orient(a, b, c) < 0) std::swap(b, c);
  std::vector<int32_t> created = {newTri(a, b, c), newTri(c, b, kGhost), newTri(a, c, kGhost), newTri(b, a, kGhost)};
  link(created, {});
  last_ = created[0];
  for (int32_t i = 0; i < n; i++) {
    int32_t v = order[i];
    if (v == a || v == b || v == c) continue;
    int32_t t = locate(pts_[v], last_);
    for (int32_t w : tris_[t].v)
      if (w >= 0 && pts_[w].x == pts_[v].x && pts_[w].y == pts_[v].y) {
        duplicate[0] = w, duplicate[1] = v;
        return false;
      }
    std::vector<int32_t> made;
    // Inserting an existing index: its triangle's cavity, as insertPoint does for a new one.
    std::vector<int32_t> cavity{t}, stack{t};
    std::vector<std::pair<int32_t, int>> outside;
    std::vector<std::pair<int32_t, int32_t>> bnd;
    uint32_t st = fresh();
    mark_[t] = st;
    while (!stack.empty()) {
      int32_t u = stack.back();
      stack.pop_back();
      for (int k = 0; k < 3; k++) {
        int32_t w = tris_[u].n[k];
        if (mark_[w] == st) continue;
        if (inCircle(w, v)) {  // (no constrained edges yet)
          mark_[w] = st, cavity.push_back(w), stack.push_back(w);
          continue;
        }
        int j = tris_[w].n[0] == u ? 0 : tris_[w].n[1] == u ? 1 : 2;
        outside.push_back({w, j});
        bnd.push_back({tris_[u].v[(k + 1) % 3], tris_[u].v[(k + 2) % 3]});
      }
    }
    for (int32_t u : cavity) kill(u);
    for (auto [x, y] : bnd) made.push_back(newTri(x, y, v));
    link(made, outside);
  }
  return true;
}

void Triangulation::cavity(Vec2 p, int32_t t, const Map2& raw, std::vector<int32_t>& cav,
  std::vector<std::pair<int32_t, int>>& outside, std::vector<std::pair<int32_t, int32_t>>& bnd) const {
  // The map scaled to l11 = 1 (the incircle's sign doesn't change under a uniform scale): an isotropic metric's is
  // then the identity, so its test is exact on the points themselves. Scaled points round, which near-cocircular
  // points (a refinement's cluster where boundary samples nearly meet) turn into cavities not Delaunay.
  const Map2 map = {1, raw.l12 / raw.l11, raw.l22 / raw.l11};
  Vec2 mp = map(p);
  auto holds = [&](int32_t w) {
    const Tri& W = tris_[w];
    if (W.v[2] == kGhost) return false;
    return cadgeom::incircle(map(pts_[W.v[0]]), map(pts_[W.v[1]]), map(pts_[W.v[2]]), mp) > 0;
  };
  uint32_t st = fresh();
  auto in = [&](int32_t u) { return mark_[u] == st; };
  cav = {t};
  mark_[t] = st;
  for (size_t h = 0; h < cav.size(); h++) {
    int32_t u = cav[h];
    for (int k = 0; k < 3; k++) {
      int32_t w = tris_[u].n[k];
      if (in(w) || tris_[u].c[k] != kFree || !tris_[w].inside || !holds(w)) continue;
      mark_[w] = st, cav.push_back(w);
    }
  }
  // Star-shaped from p: a boundary edge p doesn't see strictly (its triangle in the cavity on the far side) takes that
  // triangle out, until none is left (the seed, holding p, always stays).
  for (bool changed = true; changed;) {
    changed = false;
    for (int32_t u : cav) {
      if (!in(u) || u == t) continue;
      for (int k = 0; k < 3; k++) {
        int32_t w = tris_[u].n[k];
        if (in(w)) continue;
        if (cadgeom::orient2d(pts_[tris_[u].v[(k + 1) % 3]], pts_[tris_[u].v[(k + 2) % 3]], p) <= 0) {
          mark_[u] = 0, changed = true;
          break;
        }
      }
    }
  }
  std::vector<int32_t> kept;
  for (int32_t u : cav)
    if (in(u)) kept.push_back(u);
  cav = kept;
  outside.clear(), bnd.clear();
  for (int32_t u : cav)
    for (int k = 0; k < 3; k++) {
      int32_t w = tris_[u].n[k];
      if (in(w)) continue;
      int j = tris_[w].n[0] == u ? 0 : tris_[w].n[1] == u ? 1 : 2;
      outside.push_back({w, j});
      bnd.push_back({tris_[u].v[(k + 1) % 3], tris_[u].v[(k + 2) % 3]});
    }
}

int32_t Triangulation::insertPoint(Vec2 p, int32_t t, std::vector<int32_t>& created, const Map2& map) {
  created.clear();
  for (int32_t w : tris_[t].v)
    if (w >= 0 && pts_[w].x == p.x && pts_[w].y == p.y) return -1;
  std::vector<int32_t> cav;
  std::vector<std::pair<int32_t, int>> outside;
  std::vector<std::pair<int32_t, int32_t>> bnd;
  cavity(p, t, map, cav, outside, bnd);
  int32_t v = static_cast<int32_t>(pts_.size());
  pts_.push_back(p);
  rank_.push_back(static_cast<uint32_t>(rank_.size()));
  vtri_.push_back(-1);
  for (int32_t u : cav) kill(u);
  for (auto [x, y] : bnd) created.push_back(newTri(x, y, v));
  link(created, outside);
  return v;
}

size_t Triangulation::cavityConstraints(Vec2 p, int32_t t, std::vector<std::pair<int32_t, int32_t>>& out,
  const Map2& map) const {
  out.clear();
  std::vector<int32_t> cav;
  std::vector<std::pair<int32_t, int>> outside;
  std::vector<std::pair<int32_t, int32_t>> bnd;
  cavity(p, t, map, cav, outside, bnd);
  for (size_t i = 0; i < outside.size(); i++) {
    auto [w, j] = outside[i];
    if (tris_[w].c[j] != kFree) out.push_back(bnd[i]);
  }
  return cav.size();
}

void Triangulation::retriangulate(int32_t a, int32_t b, const std::vector<int32_t>& chain,
  std::vector<int32_t>& created) {
  if (chain.empty()) return;
  // The chain vertex whose circle through a and b holds no other (the pseudo-polygon's Delaunay triangle on ab).
  size_t k = 0;
  for (size_t i = 1; i < chain.size(); i++)
    if (inCircleSoS(a, b, chain[k], chain[i])) k = i;
  int32_t c = chain[k];
  created.push_back(newTri(a, b, c));
  retriangulate(a, c, std::vector<int32_t>(chain.begin(), chain.begin() + k), created);
  retriangulate(c, b, std::vector<int32_t>(chain.begin() + k + 1, chain.end()), created);
}

bool Triangulation::insertSegment(int32_t a, int32_t b, uint8_t flags, int32_t other[2]) {
  other[0] = other[1] = -1;
  auto [e, ei] = findEdge(a, b);
  if (e >= 0) {
    tris_[e].c[ei] = flags;
    int32_t o = tris_[e].n[ei];
    for (int j = 0; j < 3; j++)
      if (tris_[o].n[j] == e) tris_[o].c[j] = flags;
    return true;
  }
  // The triangle round a whose far edge the segment crosses.
  int32_t t0 = triOf(a), t = t0, cur = -1, x = -1, y = -1;
  for (size_t guard = 0; guard <= tris_.size() && cur < 0; guard++) {
    const Tri& T = tris_[t];
    int i = T.v[0] == a ? 0 : T.v[1] == a ? 1 : 2;
    int32_t p = T.v[(i + 1) % 3], q = T.v[(i + 2) % 3];
    if (p != kGhost && q != kGhost) {
      int op = orient(a, p, b), oq = orient(a, q, b);
      // A vertex on the segment: along a's edge to it, short of b.
      auto onSegment = [&](int32_t w) {
        Vec2 A = pts_[a], B = pts_[b], W = pts_[w];
        double s = (W.x - A.x) * (B.x - A.x) + (W.y - A.y) * (B.y - A.y);
        double l = (B.x - A.x) * (B.x - A.x) + (B.y - A.y) * (B.y - A.y);
        return s > 0 && s < l;
      };
      if (op == 0 && onSegment(p)) {
        other[0] = p;
        return false;
      }
      if (op > 0 && oq < 0) cur = t, x = p, y = q;
    }
    t = T.n[(i + 2) % 3];
    if (t == t0) break;
  }
  if (cur < 0) return false;
  // March across the triangles the segment cuts: x on its right, y on its left.
  std::vector<int32_t> cut{cur}, left{y}, right{x};
  for (size_t guard = 0; guard <= tris_.size(); guard++) {
    const Tri& T = tris_[cur];
    int i = 0;
    while (!((T.v[(i + 1) % 3] == x && T.v[(i + 2) % 3] == y))) i++;
    if (T.c[i] != kFree) {
      other[0] = x, other[1] = y;
      return false;
    }
    int32_t nb = T.n[i];
    const Tri& N = tris_[nb];
    int32_t z = N.v[0] != x && N.v[0] != y ? N.v[0] : N.v[1] != x && N.v[1] != y ? N.v[1] : N.v[2];
    cut.push_back(nb);
    if (z == b) break;
    int o = orient(a, b, z);
    if (o == 0) {
      other[0] = z;
      return false;
    }
    if (o > 0) left.push_back(z), y = z;
    else right.push_back(z), x = z;
    // The next edge crossed, from x (right) to y (left), is an edge of the triangle just entered.
    cur = nb;
  }
  // The cut triangles' outer edges, then the two pseudo-polygons retriangulated.
  uint32_t st = fresh();
  auto isCut = [&](int32_t u) { return mark_[u] == st; };
  for (int32_t u : cut) mark_[u] = st;
  std::vector<std::pair<int32_t, int>> outside;
  for (int32_t u : cut)
    for (int k = 0; k < 3; k++) {
      int32_t w = tris_[u].n[k];
      if (isCut(w)) continue;
      int j = tris_[w].n[0] == u ? 0 : tris_[w].n[1] == u ? 1 : 2;
      outside.push_back({w, j});
    }
  for (int32_t u : cut) kill(u);
  std::vector<int32_t> created;
  retriangulate(a, b, left, created);
  std::vector<int32_t> rr(right.rbegin(), right.rend());
  retriangulate(b, a, rr, created);
  link(created, outside);
  auto [f, fi] = findEdge(a, b);
  if (f < 0) return false;
  tris_[f].c[fi] = flags;
  int32_t o = tris_[f].n[fi];
  for (int j = 0; j < 3; j++)
    if (tris_[o].n[j] == f) tris_[o].c[j] = flags;
  return true;
}

void Triangulation::label() {
  // Breadth first from the ghosts (outside), a triangle's side the same as its neighbour's but across a boundary edge.
  std::vector<int8_t> side(tris_.size(), -1);
  std::vector<int32_t> queue;
  for (int32_t t = 0; t < static_cast<int32_t>(tris_.size()); t++)
    if (!tris_[t].dead && tris_[t].v[2] == kGhost) side[t] = 0, queue.push_back(t);
  for (size_t h = 0; h < queue.size(); h++) {
    int32_t t = queue[h];
    for (int k = 0; k < 3; k++) {
      int32_t w = tris_[t].n[k];
      if (w < 0 || side[w] >= 0) continue;
      side[w] = static_cast<int8_t>(tris_[t].c[k] == kBoundary ? 1 - side[t] : side[t]);
      queue.push_back(w);
    }
  }
  for (int32_t t = 0; t < static_cast<int32_t>(tris_.size()); t++)
    if (!tris_[t].dead) tris_[t].inside = side[t] == 1;
}

} // namespace cdt
} // namespace tesscadio
