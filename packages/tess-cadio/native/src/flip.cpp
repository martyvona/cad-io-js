// flip.h's rule.
#include "flip.h"

#include <algorithm>
#include <cmath>
#include <map>

namespace tesscadio {

int flipTurned(const std::vector<cadgeom::Vec2>& uv, std::vector<int32_t>& T, std::vector<int32_t>& rejected,
  const std::set<std::pair<int32_t, int32_t>>& fixed, const TrianglePredicate& turned,
  const TrianglePredicate& accepted, const TrianglePredicate& barred) {
  const size_t nt = T.size() / 3;
  std::vector<size_t> candidates;
  for (size_t t = 0; t < nt; t++)
    if (turned(T[3 * t], T[3 * t + 1], T[3 * t + 2])) candidates.push_back(t);
  if (candidates.empty()) return 0;
  auto key = [](int32_t a, int32_t b) { return std::pair<int32_t, int32_t>{std::min(a, b), std::max(a, b)}; };
  std::set<size_t> refused(rejected.begin(), rejected.end());
  // Each edge's triangles.
  std::map<std::pair<int32_t, int32_t>, std::vector<size_t>> by;
  for (size_t t = 0; t < nt; t++)
    for (int k = 0; k < 3; k++) by[key(T[3 * t + k], T[3 * t + (k + 1) % 3])].push_back(t);
  auto usable = [&](size_t t) { return !barred(T[3 * t], T[3 * t + 1], T[3 * t + 2]); };
  auto area2 = [&](int32_t a, int32_t b, int32_t c) {
    const cadgeom::Vec2 p = uv[a], q = uv[b], r = uv[c];
    return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  };
  int flips = 0;
  for (size_t t : candidates) {
    const int32_t v[3] = {T[3 * t], T[3 * t + 1], T[3 * t + 2]};
    // (Still turned: a flip before may have rewritten it.)
    if (!usable(t) || !turned(v[0], v[1], v[2])) continue;
    for (int k = 0; k < 3; k++) {
      // The edge (a, b), c opposite; the neighbour (b, a, d) across it: (a, b) becomes (c, d).
      const int32_t a = v[k], b = v[(k + 1) % 3], c = v[(k + 2) % 3];
      const auto e = key(a, b);
      if (fixed.count(e)) continue;
      auto it = by.find(e);
      if (it == by.end() || it->second.size() != 2) continue;
      const size_t u = it->second[0] == t ? it->second[1] : it->second[0];
      if (!usable(u)) continue;
      int32_t d = -1;
      for (int j = 0; j < 3; j++)
        if (T[3 * u + j] != a && T[3 * u + j] != b) d = T[3 * u + j];
      if (d < 0 || by.count(key(c, d))) continue;
      if (!(area2(c, a, d) > 0) || !(area2(c, d, b) > 0)) continue;
      if (turned(c, a, d) || turned(c, d, b) || !accepted(c, a, d) || !accepted(c, d, b)) continue;
      for (const auto& old : {key(b, c), key(c, a)}) {
        auto& w = by[old];
        w.erase(std::remove(w.begin(), w.end(), t), w.end());
      }
      for (const auto& old : {key(b, d), key(d, a)}) {
        auto& w = by[old];
        w.erase(std::remove(w.begin(), w.end(), u), w.end());
      }
      by.erase(e);
      T[3 * t] = c, T[3 * t + 1] = a, T[3 * t + 2] = d;
      T[3 * u] = c, T[3 * u + 1] = d, T[3 * u + 2] = b;
      for (const auto& now : {key(c, a), key(a, d), key(d, c)}) by[now].push_back(t);
      for (const auto& now : {key(d, b), key(b, c)}) by[now].push_back(u);
      by[key(c, d)].push_back(u);
      if (refused.erase(t) + refused.erase(u)) rejected.assign(refused.begin(), refused.end());
      flips++;
      break;
    }
  }
  return flips;
}

std::vector<size_t> sectorKeep(double ta, const std::vector<double>& th, double tb, double minTurn) {
  auto wrap = [](double t) {
    while (t > M_PI) t -= 2 * M_PI;
    while (t <= -M_PI) t += 2 * M_PI;
    return t;
  };
  std::vector<size_t> all(th.size());
  for (size_t j = 0; j < th.size(); j++) all[j] = j;
  if (th.empty()) return all;
  double total = wrap(th.front() - ta) + wrap(tb - th.back());
  for (size_t j = 0; j + 1 < th.size(); j++) total += wrap(th[j + 1] - th[j]);
  if (total == 0) return all;
  const double sigma = total > 0 ? 1 : -1;
  std::vector<size_t> kept;
  double turn = 0, last = 0;
  for (size_t j = 0; j < th.size(); j++) {
    turn += wrap(th[j] - (j ? th[j - 1] : ta));
    if (sigma * (turn - last) > minTurn && sigma * (total - turn) > minTurn) kept.push_back(j), last = turn;
  }
  return kept;
}

int foldedEdges(const std::vector<int32_t>& T, const std::vector<int32_t>& weld, const std::vector<char>& near) {
  std::map<std::pair<int32_t, int32_t>, int> uses;
  std::set<std::pair<int32_t, int32_t>> tried;
  for (size_t t = 0; t + 2 < T.size(); t += 3)
    for (int k = 0; k < 3; k++) {
      const int32_t a = T[t + k], b = T[t + (k + 1) % 3];
      if (weld[a] == weld[b]) continue;
      uses[{weld[a], weld[b]}]++;
      if (near[a] || near[b]) tried.insert({std::min(weld[a], weld[b]), std::max(weld[a], weld[b])});
    }
  int folded = 0;
  for (auto [a, b] : tried) {
    auto ab = uses.find({a, b}), ba = uses.find({b, a});
    const int n1 = ab == uses.end() ? 0 : ab->second, n2 = ba == uses.end() ? 0 : ba->second;
    folded += n1 >= 2 || n2 >= 2;
  }
  return folded;
}

bool collapseVertex(const UvOf& uv, std::vector<int32_t>& T, int32_t C, int32_t E,
  const std::set<std::pair<int32_t, int32_t>>& fixed, std::vector<size_t>& gone) {
  gone.clear();
  for (auto [a, b] : fixed)
    if (a == C || b == C) return false;
  cadgeom::Vec2 uC, uE;
  if (!uv(C, uC) || !uv(E, uE)) return false;
  std::vector<size_t> atC;
  std::set<int32_t> nC, nE;
  for (size_t t = 0; t + 2 < T.size(); t += 3) {
    const bool hasC = T[t] == C || T[t + 1] == C || T[t + 2] == C;
    const bool hasE = T[t] == E || T[t + 1] == E || T[t + 2] == E;
    if (hasC) atC.push_back(t / 3);
    for (int k = 0; k < 3; k++) {
      if (hasC) nC.insert(T[t + k]);
      if (hasE) nE.insert(T[t + k]);
    }
  }
  int common = 0;
  for (int32_t x : nC)
    if (x != C && x != E && nE.count(x)) common++;
  if (common != 2) return false;
  // (Twice the signed area in (u, v), C at `at`.)
  auto area2 = [&](size_t t, cadgeom::Vec2 at, bool& known) {
    cadgeom::Vec2 p[3];
    for (int k = 0; k < 3; k++) {
      if (T[3 * t + k] == C) p[k] = at;
      else if (!uv(T[3 * t + k], p[k])) known = false;
    }
    return (p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[1].y - p[0].y) * (p[2].x - p[0].x);
  };
  std::vector<size_t> kept;
  for (size_t t : atC) {
    if (T[3 * t] == E || T[3 * t + 1] == E || T[3 * t + 2] == E) {
      gone.push_back(t);
      continue;
    }
    bool known = true;
    const double before = area2(t, uC, known), after = area2(t, uE, known);
    if (!known || !(before * after > 0)) return gone.clear(), false;
    kept.push_back(t);
  }
  if (gone.size() != 2) return gone.clear(), false;
  for (size_t t : kept)
    for (int k = 0; k < 3; k++)
      if (T[3 * t + k] == C) T[3 * t + k] = E;
  std::sort(gone.rbegin(), gone.rend());
  return true;
}

int windingFaults(const std::vector<int32_t>& T, const std::vector<int32_t>& weld) {
  std::map<std::pair<int32_t, int32_t>, int> uses;
  for (size_t t = 0; t + 2 < T.size(); t += 3) {
    const int32_t a = weld[T[t]], b = weld[T[t + 1]], c = weld[T[t + 2]];
    if (a == b || b == c || c == a) continue;
    uses[{a, b}]++, uses[{b, c}]++, uses[{c, a}]++;
  }
  int faults = 0;
  for (const auto& [e, n] : uses) {
    if (e.first > e.second) continue;
    auto back = uses.find({e.second, e.first});
    const int m = back == uses.end() ? 0 : back->second;
    faults += n >= 2 || m >= 2;
  }
  for (const auto& [e, n] : uses)
    if (e.first > e.second && !uses.count({e.second, e.first})) faults += n >= 2;
  return faults;
}

}  // namespace tesscadio
