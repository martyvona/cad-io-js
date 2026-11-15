// numerics.h's quadrature: globally adaptive Gauss-Kronrod, the 7-point Gauss rule embedded in the 15-point Kronrod
// rule (the scheme of Piessens, de Doncker-Kapenga, Ueberhuber and Kahaner, "QUADPACK", Springer 1983, routine QAG;
// the nodes and weights are QUADPACK's qk15 table, checked in numerics_test.cpp against the rules' defining
// exactness: K15 integrates degree 22 exactly, G7 degree 13, both weight sets sum to 2). The interval with the
// largest error estimate is halved until the total is within tolerance.
// The error estimate of a piece is the larger of two. |K15 - G7|: the Gauss rule's error, a bound on the Kronrod
// value's for smooth integrands (not QUADPACK's sharper (200 |K - G| / resasc)^1.5, which can claim less than the
// true error), floored at 50 ulp of the integral of |f| for rounding. And the tail a halving shows: a piece's value
// against its halves' sum, d, measures what the rule missed there; where f has an endpoint singularity |K - G|
// misses it too (x^-0.9: 30 times too small), but the d of successive halvings shrink geometrically, ratio rho, and
// the error still left is about d rho / (1 - rho), taken twice over (a pure geometric tail is the limit the rule's
// halvings approach from below: x^-0.99 falls short of it by 1 %); rho >= 1 (not shrinking: 1 / x isn't
// integrable) is an infinite error, unless d is already at the rounding floor. A piece too narrow for its nodes to be placed (64 ulp of where it
// is) isn't halved again, and its error is at least its whole value: nothing finer can be learned there. The estimate
// is a sum over the pieces, so it covers what the rules can see: an integrand wild between the nodes of every piece
// (a narrow spike missed by all of them) can still fool it, as it can any quadrature that only samples.
#include <cmath>
#include <limits>
#include <algorithm>
#include <vector>

#include "cad_geom/numerics.h"

namespace cadgeom {
namespace quadrature {

namespace {

// QUADPACK's qk15: the Kronrod abscissae (the Gauss ones are xgk[1], xgk[3], xgk[5] and 0) and weights.
constexpr double xgk[8] = {0.991455371120812639206854697526329, 0.949107912342758524526189684047851,
  0.864864423359769072789712788640926, 0.741531185599394439863864773280788, 0.586087235467691130294144845693013,
  0.405845151377397166906606412076961, 0.207784955007898467600689403773245, 0.0};
constexpr double wgk[8] = {0.022935322010529224963732008058970, 0.063092092629978553290700663189204,
  0.104790010322250183839876322541518, 0.140653259715525918745189590510238, 0.169004726639267902826583426598550,
  0.190350578064785409913256402421014, 0.204432940075298892414161999234649, 0.209482141084727828012999174891714};
constexpr double wg[4] = {0.129484966168869693270611432679082, 0.279705391489276667901467771423780,
  0.381830050505118944950369775488975, 0.417959183673469387755102040816327};

struct Piece {
  double a, b, value, error, rounding;
  double change = -1;  // |value - its parent's| over the halving that made it; -1 for the whole range
  bool operator<(const Piece& o) const { return error < o.error; }
};

/** K15 and its error estimate on [a, b]; false if f wasn't finite at a node. */
bool rule(const std::function<double(double)>& f, double a, double b, Piece& out) {
  const double c = 0.5 * (a + b), h = 0.5 * (b - a);
  double fc = f(c);
  double k = wgk[7] * fc, g = wg[3] * fc, mag = wgk[7] * std::fabs(fc);
  bool finite = std::isfinite(fc);
  for (int j = 0; j < 7; j++) {
    double x = h * xgk[j], f1 = f(c - x), f2 = f(c + x);
    finite = finite && std::isfinite(f1) && std::isfinite(f2);
    k += wgk[j] * (f1 + f2);
    mag += wgk[j] * (std::fabs(f1) + std::fabs(f2));
    if (j % 2 == 1) g += wg[j / 2] * (f1 + f2);
  }
  const double rounding = 50 * std::numeric_limits<double>::epsilon() * mag * std::fabs(h);
  out = {a, b, k * h, std::fmax(std::fabs((k - g) * h), rounding), rounding};
  return finite;
}

} // namespace

Estimate integrate(const std::function<double(double)>& f, double a, double b, double absTol, double relTol,
  int maxEval) {
  const double nan = std::numeric_limits<double>::quiet_NaN(), inf = std::numeric_limits<double>::infinity();
  if (!std::isfinite(a) || !std::isfinite(b)) return {nan, inf, Status::outOfDomain};
  if (a == b) return {0, 0, Status::ok};
  if (a > b) {
    Estimate e = integrate(f, b, a, absTol, relTol, maxEval);
    return {-e.value, e.error, e.status};
  }
  std::vector<Piece> pieces;  // a heap, largest error first
  std::vector<Piece> done;    // too narrow to halve
  Piece whole;
  if (!rule(f, a, b, whole)) return {nan, inf, Status::singular};
  pieces.push_back(whole);
  int evals = 15;
  double value = whole.value, error = whole.error;
  auto reached = [&] { return error <= std::fmax(absTol, relTol * std::fabs(value)); };
  // An infinite error in a piece that won't be halved again can't come down: no point going on.
  auto hopeless = [&] {
    for (const Piece& q : done)
      if (std::isinf(q.error)) return true;
    return false;
  };
  while (!reached() && !pieces.empty() && evals + 30 <= maxEval && !hopeless()) {
    std::pop_heap(pieces.begin(), pieces.end());
    Piece p = pieces.back();
    pieces.pop_back();
    double m = 0.5 * (p.a + p.b);
    const double where = std::fmax(std::fabs(p.a), std::fabs(p.b));
    if (p.b - p.a <= 64 * (std::nextafter(where, inf) - where)) {
      p.error = std::fmax(p.error, std::fabs(p.value));
      done.push_back(p);
      continue;
    }
    Piece l, r;
    bool finite = rule(f, p.a, m, l) && rule(f, m, p.b, r);
    evals += 30;
    if (!finite) {
      // At an end of the range a node can round onto it (1 - x = 0 for x near 1): the piece is kept as it is, its
      // estimate standing. Anywhere else f really isn't finite at a node.
      if (p.a != a && p.b != b) return {nan, inf, Status::singular};
      p.error = std::fmax(p.error, std::fabs(p.value));
      done.push_back(p);
      continue;
    }
    const double d = std::fabs(p.value - (l.value + r.value));
    const double rho = p.change > 0 ? d / p.change : 0.5;
    const double tail = d <= l.rounding + r.rounding ? 0 : rho < 1 ? 2 * d * rho / (1 - rho) : inf;
    l.change = r.change = d;
    l.error = std::fmax(l.error, tail);
    r.error = std::fmax(r.error, tail);
    pieces.push_back(l);
    std::push_heap(pieces.begin(), pieces.end());
    pieces.push_back(r);
    std::push_heap(pieces.begin(), pieces.end());
    // The sums again from the pieces, not by differences, so rounding doesn't accumulate.
    value = error = 0;
    for (const std::vector<Piece>* v : {&done, &pieces})
      for (const Piece& q : *v) value += q.value, error += q.error;
  }
  return {value, error, reached() ? Status::ok : Status::noConvergence};
}

} // namespace quadrature
} // namespace cadgeom
