// Quadrature the oracle's sources share: cad-geom's adaptive Gauss-Kronrod bisected where it doesn't converge, and a
// fixed composite Gauss-Legendre rule, smooth in its ends, for inner integrals the outer quadrature sees as functions.
#pragma once

#include <cmath>
#include <unordered_map>
#include <vector>

#include "cad_geom/numerics.h"
#include "cad_geom/result.h"

namespace cadoracle {

using cadgeom::Estimate;
using cadgeom::Status;

/** How many times a span that doesn't converge is bisected at most (integrateSplit). */
constexpr int kBisections = 12;
/** Gauss-Legendre panels G starts from per span of the profile, and at most. */
constexpr int kGaussPanels = 2, kMaxGaussPanels = 256;

/** 16-point Gauss-Legendre's nodes on [-1, 1] and weights, by Newton on the Legendre polynomial. */
struct Gauss16 {
  double x[16], w[16];
  Gauss16() {
    const int n = 16;
    for (int i = 0; i < n; i++) {
      double z = std::cos(M_PI * (i + 0.75) / (n + 0.5)), dp = 0;
      for (int it = 0; it < 100; it++) {
        double p0 = 1, p1 = z;
        for (int k = 2; k <= n; k++) {
          const double p2 = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k;
          p0 = p1, p1 = p2;
        }
        dp = n * (z * p1 - p0) / (z * z - 1);
        const double dz = p1 / dp;
        z -= dz;
        if (std::fabs(dz) < 1e-16) break;
      }
      x[i] = z, w[i] = 2 / ((1 - z * z) * dp * dp);
    }
  }
};
inline const Gauss16 kGauss16;

/** The integral of f over [a, b] by m equal panels of 16-point Gauss-Legendre. */
/**
 * The integral of f over [a, b] by quadrature::integrate, bisected where it doesn't converge (up to kBisections
 * deep): a projected p-curve is fitted in pieces whose joints are kinks, or tiny jumps, at parameters the caller
 * doesn't know, and each bisection confines one to a span half as long. An absTol below f's rounding repeats the
 * failure at every level, 2^kBisections times: the caller's must be above it.
 */
template <class F>
Estimate integrateSplit(const F& f, double a, double b, double absTol, double relTol, int depth = 0) {
  Estimate e = cadgeom::quadrature::integrate(f, a, b, absTol, relTol);
  if (e.status != Status::noConvergence || depth >= kBisections) return e;
  const double m = (a + b) / 2;
  Estimate l = integrateSplit(f, a, m, absTol / 2, relTol, depth + 1);
  Estimate r = integrateSplit(f, m, b, absTol / 2, relTol, depth + 1);
  return {l.value + r.value, l.error + r.error,
    l.status != Status::ok ? l.status : r.status};
}

/**
 * K components' values by their parameter, for integrals taken one component at a time over one curve: their
 * adaptive rules share most of their nodes, and each value costs a numeric inner integral.
 */
class Memo {
public:
  explicit Memo(int k) : k_(k) {}
  template <class G> const double* at(double t, const G& fill) {
    auto [it, fresh] = map_.try_emplace(t);
    if (fresh) {
      it->second.resize(k_);
      fill(t, it->second.data());
    }
    return it->second.data();
  }
  void clear() { map_.clear(); }

private:
  int k_;
  std::unordered_map<double, std::vector<double>> map_;
};

template <class F> double gauss(const F& f, double a, double b, int m) {
  const double h = (b - a) / m;
  double sum = 0;
  for (int j = 0; j < m; j++) {
    const double c = a + (j + 0.5) * h;
    for (int i = 0; i < 16; i++) sum += kGauss16.w[i] * f(c + kGauss16.x[i] * h / 2);
  }
  return sum * h / 2;
}


} // namespace cadoracle
