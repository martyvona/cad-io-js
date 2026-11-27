// folds.h: folds inside a face, the signed Jacobian's sign changes on a grid over the face's box, joined into
// polylines and clipped to the face.
#include "cad_geom/folds.h"

#include <algorithm>
#include <cmath>
#include <map>

namespace cadgeom {

namespace {

/** The grid's lines over r: the breaks inside it and each span between them cut into equal pieces. */
std::vector<double> gridLines(Range r, const std::vector<double>& breaks) {
  std::vector<double> b{r.lo};
  for (double x : breaks)
    if (x > b.back() && x < r.hi) b.push_back(x);
  b.push_back(r.hi);
  const int spans = static_cast<int>(b.size()) - 1;
  std::vector<double> out;
  if (spans * 8 > 512) {
    for (int i = 0; i <= 512; i++) out.push_back(r.lo + (r.hi - r.lo) * i / 512);
    return out;
  }
  const int per = std::max(8, (64 + spans - 1) / spans);
  for (int k = 0; k < spans; k++)
    for (int i = 0; i < per; i++) out.push_back(b[k] + (b[k + 1] - b[k]) * i / per);
  out.push_back(r.hi);
  return out;
}

struct Node {
  Vec2 uv;
  Vec3 p;
  bool knife = false;
  double turn = 0, depth = 0;
};

} // namespace

std::vector<Fold> findFolds(const Surface& s, Range ru, Range rv,
  const std::function<void(const Vec2*, int, int*)>& inside, const std::function<double(Vec2)>& uvTol) {
  std::vector<Fold> out;
  auto finite = [](Range r) { return std::isfinite(r.lo) && std::isfinite(r.hi) && r.lo < r.hi; };
  if (!finite(ru) || !finite(rv)) return out;
  std::vector<double> bu, bv;
  s.breaks(ru, rv, bu, bv);
  const std::vector<double> us = gridLines(ru, bu), vs = gridLines(rv, bv);
  const int nu = static_cast<int>(us.size()), nv = static_cast<int>(vs.size());
  // S_u x S_v at the grid's nodes, by rows (evalRow: a B-spline's v basis once a row). A node where it vanishes (a
  // fold along a grid line, a knot line among them) or that doesn't evaluate is moved 1e-6 of its cell into the
  // grid, so the fold falls between it and a neighbour; zero where that fails too.
  std::vector<Vec3> J(static_cast<size_t>(nu) * nv);
  std::vector<Vec2> X(J.size());
  {
    std::vector<SurfacePoint> row(nu);
    std::vector<Status> st(nu);
    for (int j = 0; j < nv; j++) {
      s.evalRow(false, vs[j], nu, us.data(), 1, row.data(), st.data());
      for (int i = 0; i < nu; i++) {
        Vec2 x{us[i], vs[j]};
        Vec3 g = st[i] == Status::ok ? cross(row[i].du, row[i].dv) : Vec3{0, 0, 0};
        const double big = st[i] == Status::ok ? std::max(dot(row[i].du, row[i].du), dot(row[i].dv, row[i].dv)) : 0;
        if (!(norm(g) > 1e-14 * big)) {
          x = {us[i] + 1e-6 * (i + 1 < nu ? us[i + 1] - us[i] : us[i - 1] - us[i]),
            vs[j] + 1e-6 * (j + 1 < nv ? vs[j + 1] - vs[j] : vs[j - 1] - vs[j])};
          SurfacePoint q;
          g = s.eval(x.x, x.y, 1, q) == Status::ok ? cross(q.du, q.dv) : Vec3{0, 0, 0};
        }
        J[j * nu + i] = g, X[j * nu + i] = x;
      }
    }
  }
  auto unit = [](Vec3 g) {
    const double n = norm(g);
    return n > 0 ? (1 / n) * g : Vec3{0, 0, 0};
  };
  // The surface's own pole and apex lines: the normal turns back across them too, but they're its singularities.
  std::vector<Singularity> sing;
  s.singularities(sing);
  const SurfaceDomain dom = s.domain();
  auto onSingularity = [&](Vec2 m) {
    for (const Singularity& g : sing) {
      if (g.kind == Singularity::normalVanishes) continue;
      const double P = g.isoU ? dom.uPeriod : dom.vPeriod;
      double d = (g.isoU ? m.x : m.y) - g.at;
      if (P > 0) d -= P * std::round(d / P);
      if (std::fabs(d) <= 4 * uvTol(m) + 1e-12 * (1 + std::fabs(g.at))) return true;
    }
    return false;
  };
  // A grid edge's crossing (dir 0 along u at row j from column i, dir 1 along v at column i from row j), if any.
  std::map<std::tuple<int, int, int>, int> at;
  // Each grid line's crossings, in order along it (the grid edges are visited in that order).
  std::map<std::pair<int, int>, std::vector<int>> line;
  std::vector<Node> nodes;
  auto cross_ = [&](int dir, int i, int j) {
    const int i1 = dir ? i : i + 1, j1 = dir ? j + 1 : j;
    const Vec3 na = unit(J[j * nu + i]), nb = unit(J[j1 * nu + i1]);
    if (!(dot(na, na) > 0 && dot(nb, nb) > 0) || dot(na, nb) >= 0) return;
    Vec2 a = X[j * nu + i], b = X[j1 * nu + i1];
    SurfacePoint q;
    for (int it = 0; it < 60 && std::hypot(b.x - a.x, b.y - a.y) > uvTol(a); it++) {
      const Vec2 m{0.5 * (a.x + b.x), 0.5 * (a.y + b.y)};
      if (s.eval(m.x, m.y, 1, q) != Status::ok) return;
      (dot(cross(q.du, q.dv), na) > 0 ? a : b) = m;
    }
    const Vec2 m{0.5 * (a.x + b.x), 0.5 * (a.y + b.y)};
    if (onSingularity(m) || s.eval(m.x, m.y, 1, q) != Status::ok) return;
    const double su = norm(q.du), sv = norm(q.dv), big = std::max(su, sv), g = norm(cross(q.du, q.dv));
    // (A C0 crease: the normal jumps, the Jacobian doesn't vanish.)
    if (!(big > 0) || !(g <= 1e-2 * big * big)) return;
    Node n;
    n.uv = m, n.p = q.p;
    n.knife = std::min(su, sv) >= 0.1 * big && g <= 1e-2 * su * sv;
    n.turn = std::acos(std::clamp(dot(na, nb), -1.0, 1.0));
    at[{dir, i, j}] = static_cast<int>(nodes.size());
    nodes.push_back(n);
    line[{dir, dir ? i : j}].push_back(static_cast<int>(nodes.size()) - 1);
  };
  for (int j = 0; j < nv; j++)
    for (int i = 0; i + 1 < nu; i++) cross_(0, i, j);
  for (int j = 0; j + 1 < nv; j++)
    for (int i = 0; i < nu; i++) cross_(1, i, j);
  if (nodes.empty()) return out;
  // A crossing's depth: the 3D distance to the next crossing either way along its grid line, the reversed stretch's
  // other side (the nearer of the two); 0 with none.
  for (const auto& [key, ks] : line)
    for (size_t k = 0; k < ks.size(); k++) {
      double d = INFINITY;
      if (k > 0) d = std::min(d, norm(nodes[ks[k]].p - nodes[ks[k - 1]].p));
      if (k + 1 < ks.size()) d = std::min(d, norm(nodes[ks[k]].p - nodes[ks[k + 1]].p));
      nodes[ks[k]].depth = std::isfinite(d) ? d : 0;
    }
  // Joined across each cell: its crossed edges paired (two: together; four: the pairing with the shorter joins;
  // three: the nearest two).
  std::vector<std::vector<int>> nbr(nodes.size());
  auto link = [&](int a, int b) { nbr[a].push_back(b), nbr[b].push_back(a); };
  auto dist = [&](int a, int b) { return std::hypot(nodes[a].uv.x - nodes[b].uv.x, nodes[a].uv.y - nodes[b].uv.y); };
  for (int j = 0; j + 1 < nv; j++)
    for (int i = 0; i + 1 < nu; i++) {
      std::vector<int> c;
      for (auto k : {std::tuple{0, i, j}, std::tuple{1, i + 1, j}, std::tuple{0, i, j + 1}, std::tuple{1, i, j}}) {
        auto f = at.find(k);
        if (f != at.end()) c.push_back(f->second);
      }
      if (c.size() == 2) link(c[0], c[1]);
      else if (c.size() == 4) {
        if (dist(c[0], c[1]) + dist(c[2], c[3]) <= dist(c[0], c[3]) + dist(c[1], c[2]))
          link(c[0], c[1]), link(c[2], c[3]);
        else link(c[0], c[3]), link(c[1], c[2]);
      } else if (c.size() == 3) {
        int a = 0, b = 1;
        for (int x = 0; x < 3; x++)
          for (int y = x + 1; y < 3; y++)
            if (dist(c[x], c[y]) < dist(c[a], c[b])) a = x, b = y;
        link(c[a], c[b]);
      }
    }
  // The nodes' sides, then chains through nodes inside the face, from ends first (then what's left: closed loops).
  std::vector<Vec2> pts(nodes.size());
  for (size_t k = 0; k < nodes.size(); k++) pts[k] = nodes[k].uv;
  std::vector<int> side(nodes.size());
  inside(pts.data(), static_cast<int>(pts.size()), side.data());
  std::vector<bool> used(nodes.size(), false);
  auto in = [&](int k) { return side[k] == 0; };
  auto degree = [&](int k) {
    int d = 0;
    for (int x : nbr[k]) d += in(x);
    return d;
  };
  auto chain = [&](int start) {
    std::vector<int> c{start};
    used[start] = true;
    for (int cur = start;;) {
      int next = -1;
      for (int x : nbr[cur])
        if (in(x) && !used[x]) { next = x; break; }
      if (next < 0) break;
      used[next] = true, c.push_back(next), cur = next;
    }
    Fold f;
    int knives = 0;
    for (size_t k = 0; k < c.size(); k++) {
      const Node& n = nodes[c[k]];
      f.uv.push_back(n.uv), knives += n.knife, f.turn = std::max(f.turn, n.turn), f.depth = std::max(f.depth, n.depth);
      if (k) f.length += norm(n.p - nodes[c[k - 1]].p);
    }
    f.knife = 2 * knives > static_cast<int>(c.size());
    out.push_back(std::move(f));
  };
  for (int pass = 0; pass < 2; pass++)
    for (size_t k = 0; k < nodes.size(); k++)
      if (in(static_cast<int>(k)) && !used[k] && (pass || degree(static_cast<int>(k)) <= 1)) chain(static_cast<int>(k));
  return out;
}

} // namespace cadgeom
