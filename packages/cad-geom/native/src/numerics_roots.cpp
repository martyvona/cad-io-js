// numerics.h's root isolation for polynomials in Bernstein form on [0, 1]: Descartes' rule of signs on the Bernstein
// coefficients (the number of sign changes bounds the roots in the open interval and has their parity; zero changes:
// no root; one: exactly one, simple) with de Casteljau subdivision at the midpoint (the "Bernstein subdivision" root
// isolation of Lane and Riesenfeld, "Bounds on a polynomial", BIT 21, 1981; Mourrain, Rouillier and Roy, "The
// Bernstein basis and real root isolation", 2005). A zero coefficient is skipped when counting: at an end it's a root
// there, factored out (t q(t) has q's signs in its coefficients), so it isn't counted again.
// A single root is narrowed by bisection on the sign of the value until its interval is tol wide (changes 1). An
// interval that reaches tol with two or more sign changes may hold a multiple root or several close ones: it's
// reported as one interval with its changes, and the status is noConvergence (the roots there weren't separated). A
// root exactly at a subdivision point, or an end, is a point interval: changes 1, or 2 if the derivative vanishes
// there as well (a multiple root; its exact multiplicity isn't sought).
#include <algorithm>
#include <cmath>

#include "cad_geom/numerics.h"

namespace cadgeom {
namespace roots {

namespace {

int signChanges(const std::vector<double>& b) {
  int changes = 0, last = 0;
  for (double x : b) {
    int s = (x > 0) - (x < 0);
    if (s != 0) {
      if (last != 0 && s != last) changes++;
      last = s;
    }
  }
  return changes;
}

/** b's polynomial split at the midpoint into left and right Bernstein coefficients (de Casteljau). */
void split(const std::vector<double>& b, std::vector<double>& left, std::vector<double>& right) {
  const size_t n = b.size();
  std::vector<double> w = b;
  left.resize(n);
  right.resize(n);
  left[0] = w[0];
  right[n - 1] = w[n - 1];
  for (size_t r = 1; r < n; r++) {
    for (size_t i = 0; i + r < n; i++) w[i] = 0.5 * (w[i] + w[i + 1]);
    left[r] = w[0];
    right[n - 1 - r] = w[n - 1 - r];
  }
}

/** The value at s in [0, 1] (de Casteljau). */
double value(const std::vector<double>& b, double s) {
  std::vector<double> w = b;
  for (size_t r = 1; r < w.size(); r++)
    for (size_t i = 0; i + r < w.size(); i++) w[i] = (1 - s) * w[i] + s * w[i + 1];
  return w[0];
}

struct Isolator {
  double tol;
  std::vector<RootInterval> out;

  void interval(const std::vector<double>& b, double lo, double hi) {
    int v = signChanges(b);
    if (v == 0) return;
    if (v == 1) return narrow(b, lo, hi);
    if (hi - lo <= tol) {
      out.push_back({{lo, hi}, v});
      return;
    }
    std::vector<double> left, right;
    split(b, left, right);
    double mid = 0.5 * (lo + hi);
    interval(left, lo, mid);
    if (left.back() == 0) {
      // The derivative at mid is proportional to the last two left coefficients' difference.
      out.push_back({{mid, mid}, left[left.size() - 2] == 0 ? 2 : 1});
    }
    interval(right, mid, hi);
  }

  /**
   * One simple root in (lo, hi): bisection on b's sign. Near each end b has the sign of its first (last) nonzero
   * coefficient, which an end root found on a split leaves zero.
   */
  void narrow(const std::vector<double>& b, double lo, double hi) {
    double s0 = 0, s1 = 1;
    const bool rising = *std::find_if(b.rbegin(), b.rend(), [](double x) { return x != 0; }) > 0;
    while ((s1 - s0) * (hi - lo) > tol) {
      double sm = 0.5 * (s0 + s1);
      if (sm <= s0 || sm >= s1) break;
      double fm = value(b, sm);
      if (fm == 0) {
        s0 = s1 = sm;
        break;
      }
      if ((fm > 0) == rising) s1 = sm; else s0 = sm;
    }
    out.push_back({{lo + s0 * (hi - lo), lo + s1 * (hi - lo)}, 1});
  }
};

} // namespace

std::vector<RootInterval> bernstein(const std::vector<double>& coeffs, double tol, Status& status) {
  status = Status::ok;
  if (coeffs.empty() || !(tol > 0)) {
    status = Status::invalidModel;
    return {};
  }
  for (double c : coeffs)
    if (!std::isfinite(c)) {
      status = Status::invalidModel;
      return {};
    }
  if (std::all_of(coeffs.begin(), coeffs.end(), [](double c) { return c == 0; })) {
    status = Status::singular;
    return {};
  }
  Isolator iso{tol, {}};
  const size_t n = coeffs.size();
  // Roots at the ends first; the subdivision then sees only interior ones. A zero next to an end's zero: a multiple
  // root there.
  if (coeffs[0] == 0) iso.out.push_back({{0, 0}, n > 1 && coeffs[1] == 0 ? 2 : 1});
  iso.interval(coeffs, 0, 1);
  if (n > 1 && coeffs[n - 1] == 0) iso.out.push_back({{1, 1}, coeffs[n - 2] == 0 ? 2 : 1});
  for (const RootInterval& r : iso.out)
    if (r.changes > 1) status = Status::noConvergence;
  return iso.out;
}

} // namespace roots
} // namespace cadgeom
