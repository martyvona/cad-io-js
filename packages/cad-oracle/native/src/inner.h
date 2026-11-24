// The numeric inner integral the oracle's faceIntegral and free-form areas share: H(u, v) = -int_{v0}^{v} F(u, t) dt
// by a fixed composite Gauss-Legendre rule (smooth in v, so the outer quadrature can converge through it) whose panels
// are doubled until H at the loops' samples settles, and each component's floor for its absolute tolerance.
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <functional>
#include <unordered_map>
#include <vector>

#include "cad_oracle/oracle.h"
#include "quad.h"

namespace cadoracle {

/** Panels of the inner rule at most in a span; one not settled with these is integrated adaptively. */
constexpr int kMaxInnerPanels = 64;
/** An adaptive span's tolerance, as a fraction of its share of the outer integral's. */
constexpr double kAdaptiveShare = 0.1;
/** An adaptive span's pieces to start from, and a piece reported divergent split in 8 this many times at most. */
constexpr int kAdaptivePieces = 8;
constexpr int kAdaptiveSplits = 4;
/** Boundary points an integrand's default scale is probed around at most (floors). */
constexpr size_t kScaleSamples = 16;
/** Pieces a PieceCache holds at most (a few MB at a face's K); full, it starts again. */
constexpr size_t kMaxCachedPieces = size_t(1) << 16;

/**
 * Inner pieces' integrals by (u, the piece's ends, its panels), kept across H's calls on one face: the outer rules
 * of the loops' segments over one span of u's breaks share their nodes, and H from a band's bottom repeats every
 * whole piece between the cuts below. Only for an F that is fixed while it's kept (freeIntegral clears it when a
 * band run starts, its F giving zeros once a strip turns unsound).
 */
struct PieceCache {
  struct Key {
    double u, a, b;
    int m;
    bool operator==(const Key& o) const { return u == o.u && a == o.a && b == o.b && m == o.m; }
  };
  struct Hash {
    size_t operator()(const Key& k) const {
      const std::hash<double> h;
      return ((h(k.u) * 31 + h(k.a)) * 31 + h(k.b)) * 31 + static_cast<size_t>(k.m);
    }
  };
  std::unordered_map<Key, size_t, Hash> at;
  /** Each piece's K values (its -integral), at the index at gives. */
  std::vector<double> values;
  void clear() { at.clear(), values.clear(); }
};

/**
 * A face's integrand in (u, v): K components, the caller's then the area, F(u, t, out). H(u, v0, v) integrates it
 * along v by pieces between `cuts` (a profile's or a surface's breaks), each piece by the panels of the span of the
 * cuts it lies in (innerPanels sets them; a span's count changes only at a cut, so H stays as smooth in v as F).
 */
struct Inner {
  int K;
  std::function<void(double u, double t, double* out)> F;
  /**
   * Optional: F at n points t[i] of one u, point i's K values at out[i * K], as F gives them (a surface's row, its
   * fixed direction's basis found once); the fixed panels' nodes go through it, the adaptive ones through F.
   */
  std::function<void(double u, int n, const double* t, double* out)> Frow;
  /** The surface's point at (u, v). */
  std::function<Vec3(double u, double v)> P;
  /** Sorted (innerPanels sorts them). */
  std::vector<double> cuts;
  /**
   * Per span of the cuts (cuts.size() + 1 of them, the first below the first cut), its panels, or 0: adaptive
   * (Gauss-Kronrod to `adaptTol` per component, its nodes no longer smooth in v but its unevenness far below what the
   * outer rule resolves); empty: m in all.
   */
  std::vector<int> panels;
  std::vector<double> adaptTol;
  /** Optional: H's fixed-panel pieces kept there. */
  PieceCache* cache = nullptr;

  int span(double x) const { return static_cast<int>(std::upper_bound(cuts.begin(), cuts.end(), x) - cuts.begin()); }
  /** The pieces of [v0, v] between the cuts, in order from v0. */
  void pieces(double v0, double v, std::vector<double>& ends) const {
    ends.assign(1, v0);
    for (double c : cuts)
      if ((c - v0) * (c - v) < 0) ends.push_back(c);
    std::sort(ends.begin() + 1, ends.end(), [&](double a, double b) { return v > v0 ? a < b : a > b; });
    ends.push_back(v);
  }
  /**
   * Adds -int_a^b F(u, t) dt to out, by m panels of 16-point Gauss-Legendre (m 0: adaptively, its error estimates
   * added to err if given); f K scratch values.
   */
  void piece(double u, double a, double b, int m, double* out, double* f, double* err = nullptr) const {
    if (m == 0) {
      // From kAdaptivePieces pieces, each adaptive; a piece whose halvings don't
      // yet shrink (integrate's divergence, an unresolved spike) is split again, up to kAdaptiveSplits times.
      Memo memo(K);
      auto fill = [&](double t, double* o) { F(u, t, o); };
      auto go = [&](auto&& self, double x0, double x1, int q, double tol, int depth) -> Estimate {
        const Estimate e = cadgeom::quadrature::integrate([&](double t) { return memo.at(t, fill)[q]; }, x0, x1, tol,
          0);
        if (std::isfinite(e.error) || depth >= kAdaptiveSplits) return e;
        Estimate sum{0, 0, Status::ok};
        for (int k = 0; k < 8; k++) {
          const Estimate p = self(self, x0 + (x1 - x0) * k / 8, x0 + (x1 - x0) * (k + 1) / 8, q, tol / 8, depth + 1);
          sum.value += p.value, sum.error += p.error;
        }
        return sum;
      };
      for (int q = 0; q < K; q++) {
        for (int k = 0; k < kAdaptivePieces; k++) {
          const Estimate e = go(go, a + (b - a) * k / kAdaptivePieces, a + (b - a) * (k + 1) / kAdaptivePieces, q,
            adaptTol[q] / kAdaptivePieces, 0);
          out[q] -= e.value;
          if (err) err[q] += e.error;
        }
      }
      return;
    }
    const double h = (b - a) / m;
    if (Frow) {
      std::vector<double> ts(16 * static_cast<size_t>(m)), fs(ts.size() * K);
      for (int j = 0; j < m; j++) {
        const double c = a + (j + 0.5) * h;
        for (int i = 0; i < 16; i++) ts[16 * j + i] = c + kGauss16.x[i] * h / 2;
      }
      Frow(u, static_cast<int>(ts.size()), ts.data(), fs.data());
      for (int j = 0; j < m; j++)
        for (int i = 0; i < 16; i++)
          for (int q = 0; q < K; q++) out[q] -= kGauss16.w[i] * fs[(16 * j + i) * static_cast<size_t>(K) + q] * h / 2;
      return;
    }
    for (int j = 0; j < m; j++) {
      const double c = a + (j + 0.5) * h;
      for (int i = 0; i < 16; i++) {
        F(u, c + kGauss16.x[i] * h / 2, f);
        for (int q = 0; q < K; q++) out[q] -= kGauss16.w[i] * f[q] * h / 2;
      }
    }
  }
  /** -int_{v0}^{v} F(u, t) dt: each piece by its span's panels (or m where none are set). */
  void H(double u, double v0, double v, int m, double* out) const {
    std::fill(out, out + K, 0.0);
    if (v == v0) return;
    std::vector<double> ends, f(K);
    pieces(v0, v, ends);
    for (size_t k = 0; k + 1 < ends.size(); k++) {
      const int mm = panels.empty() ? m : panels[span((ends[k] + ends[k + 1]) / 2)];
      if (!cache || mm == 0) {
        piece(u, ends[k], ends[k + 1], mm, out, f.data());
        continue;
      }
      const PieceCache::Key key{u, ends[k], ends[k + 1], mm};
      auto it = cache->at.find(key);
      size_t i;
      if (it != cache->at.end()) {
        i = it->second;
      } else {
        if (cache->at.size() >= kMaxCachedPieces) cache->clear();
        i = cache->values.size();
        cache->values.resize(i + K, 0.0);
        piece(u, ends[k], ends[k + 1], mm, cache->values.data() + i, f.data());
        cache->at.emplace(key, i);
      }
      for (int q = 0; q < K; q++) out[q] += cache->values[i + q];
    }
  }
};

/**
 * The inner rule's panels for H at the samples (u, v0, v), per span of the cuts (in.panels): each span's doubled from
 * 2 until its pieces of the samples' H settle, every component within its share (by the spans used) of relTol of its
 * largest H over the samples, or of its floor (floors) over the samples' extent in u (a turn when they have none),
 * the share of the outer integral's tolerance: a component that is rounding on the face never settles relative to
 * itself. Only the spans where F needs them get many (a patch nearly folding in one span); spans no sample's H
 * reaches take the most any needed. err the last change, per component, summed over the spans; returns the most
 * panels.
 */
inline int innerPanels(Inner& in, const std::vector<std::array<double, 3>>& samples, double relTol,
  const std::vector<double>& floor, std::vector<double>& err) {
  double uLo = INFINITY, uHi = -INFINITY;
  for (const auto& s : samples) uLo = std::fmin(uLo, s[0]), uHi = std::fmax(uHi, s[0]);
  const double uSpan = uHi > uLo ? uHi - uLo : 2 * M_PI;
  const int K = in.K;
  std::sort(in.cuts.begin(), in.cuts.end());
  const int nS = static_cast<int>(in.cuts.size()) + 1;
  in.panels.assign(nS, 1);
  in.adaptTol.assign(K, 0);
  std::vector<char> used(nS, 0), done(nS, 0);
  std::vector<double> spanErr(static_cast<size_t>(nS) * K), scale(K), a(K), b(K), h(K), f(K), ends;
  for (;;) {
    std::fill(spanErr.begin(), spanErr.end(), 0.0);
    std::fill(scale.begin(), scale.end(), 0.0);
    for (const auto& s : samples) {
      if (s[2] == s[1]) continue;
      in.pieces(s[1], s[2], ends);
      std::fill(h.begin(), h.end(), 0.0);
      for (size_t k = 0; k + 1 < ends.size(); k++) {
        const int sp = in.span((ends[k] + ends[k + 1]) / 2), m = in.panels[sp];
        used[sp] = 1;
        std::fill(a.begin(), a.end(), 0.0), std::fill(b.begin(), b.end(), 0.0);
        in.piece(s[0], ends[k], ends[k + 1], m, a.data(), f.data());
        in.piece(s[0], ends[k], ends[k + 1], 2 * m, b.data(), f.data());
        for (int q = 0; q < K; q++) {
          double& e = spanErr[static_cast<size_t>(sp) * K + q];
          e = std::fmax(e, std::fabs(b[q] - a[q]));
          h[q] += b[q];
        }
      }
      for (int q = 0; q < K; q++) scale[q] = std::fmax(scale[q], std::fabs(h[q]));
    }
    int nUsed = 0;
    for (int sp = 0; sp < nS; sp++) nUsed += used[sp];
    bool all = true;
    for (int sp = 0; sp < nS; sp++) {
      if (!used[sp] || done[sp]) continue;
      bool settled = true;
      for (int q = 0; q < K; q++) {
        settled &= spanErr[static_cast<size_t>(sp) * K + q] <= relTol * std::fmax(scale[q], floor[q] / uSpan) /
          std::max(nUsed, 1) + 1e-300;
      }
      if (settled) done[sp] = 1;
      else if (2 * in.panels[sp] >= kMaxInnerPanels) done[sp] = 2;
      else in.panels[sp] *= 2, all = false;
    }
    if (all) {
      for (int q = 0; q < K; q++) {
        in.adaptTol[q] = kAdaptiveShare * relTol * std::fmax(scale[q], floor[q] / uSpan) / std::max(nUsed, 1) +
          1e-300;
      }
      break;
    }
  }
  // The finer of each span's last pair (its change is the error), or adaptive where that didn't settle (its
  // estimates the error); spans no sample reaches, the most panels.
  int most = 1;
  std::fill(err.begin(), err.end(), 0.0);
  for (int sp = 0; sp < nS; sp++) {
    if (!used[sp]) continue;
    if (done[sp] == 2) {
      in.panels[sp] = 0;
      continue;
    }
    in.panels[sp] *= 2, most = std::max(most, in.panels[sp]);
    for (int q = 0; q < K; q++) err[q] += spanErr[static_cast<size_t>(sp) * K + q];
  }
  for (int sp = 0; sp < nS; sp++)
    if (!used[sp]) in.panels[sp] = most;
  // An adaptive span's error: its estimates' largest over the samples.
  std::vector<double> adaptErr(K);
  std::fill(h.begin(), h.end(), 0.0);
  for (const auto& s : samples) {
    if (s[2] == s[1]) continue;
    in.pieces(s[1], s[2], ends);
    std::fill(adaptErr.begin(), adaptErr.end(), 0.0);
    for (size_t k = 0; k + 1 < ends.size(); k++) {
      if (in.panels[in.span((ends[k] + ends[k + 1]) / 2)] != 0) continue;
      std::fill(a.begin(), a.end(), 0.0);
      in.piece(s[0], ends[k], ends[k + 1], 0, a.data(), f.data(), adaptErr.data());
    }
    for (int q = 0; q < K; q++) h[q] = std::fmax(h[q], adaptErr[q]);
  }
  for (int q = 0; q < K; q++) err[q] += h[q];
  return most;
}

/**
 * Per component, the floor of the scale its absolute tolerance is set from (closed.h's and swept.h's): the caller's
 * scale (else the integrand's size near the face, below) times the size squared of the samples' box; the area's that
 * size squared. Near the face, not on it: a component can vanish on a face but for rounding (a volume's on a plane
 * through its c, a moment's n_x on a face normal to x), and a tolerance relative to rounding is never met, so the
 * default is the largest |f| at the samples' points moved by up to the box's size along each axis, n a unit vector
 * along each axis.
 */
inline std::vector<double> floors(const Integrand& g, const Inner& in,
  const std::vector<std::array<double, 3>>& samples) {
  const int k = in.K - 1;
  std::vector<Vec3> points;
  Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
  for (const auto& s : samples) {
    const Vec3 q = in.P(s[0], s[2]);
    points.push_back(q);
    lo = {std::fmin(lo.x, q.x), std::fmin(lo.y, q.y), std::fmin(lo.z, q.z)};
    hi = {std::fmax(hi.x, q.x), std::fmax(hi.y, q.y), std::fmax(hi.z, q.z)};
  }
  const double size = std::fmax(norm(hi - lo), 1e-300);
  std::vector<double> out(in.K, size * size), near(k, 0), f(k);
  if (static_cast<int>(g.scale.size()) == k) {
    for (int c = 0; c < k; c++) near[c] = std::fabs(g.scale[c]);
  } else {
    const Vec3 axes[3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    const size_t step = std::max<size_t>(1, points.size() / kScaleSamples);
    for (size_t i = 0; i < points.size(); i += step) {
      for (int d = 0; d < 7; d++) {
        const Vec3 p = d == 0 ? points[i] : points[i] + (d % 2 ? size : -size) * axes[(d - 1) / 2];
        for (const Vec3& n : axes) {
          g.f(p, n, f.data());
          for (int c = 0; c < k; c++) {
            if (std::isfinite(f[c])) near[c] = std::fmax(near[c], std::fabs(f[c]));
          }
        }
      }
    }
  }
  for (int c = 0; c < k; c++) out[c] *= near[c];
  return out;
}

} // namespace cadoracle
