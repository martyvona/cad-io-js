// Double-double arithmetic: a value as the unevaluated sum hi + lo of two doubles with |lo| <= ulp(hi) / 2, about
// 106 bits, for the places where double precision runs short (residuals, sums that cancel, a reference to check
// intervals against). Built on error-free transformations: TwoSum (Knuth, TAOCP vol. 2, 4.2.2; a + b = s + e exactly),
// FastTwoSum (Dekker 1971, for |a| >= |b|) and TwoProd by fma (a * b = p + e exactly, barring overflow and
// underflow). The operations follow Hida, Li and Bailey, "Library for double-double and quad-double arithmetic"
// (2007; the accurate "IEEE" addition): + and - of two dd within 2 u^2 relative, * within about 4 u^2, / and sqrt by a
// Newton correction within a few u^2 (u = 2^-53). Needs fma correctly rounded, which C++ and WebAssembly give.
#pragma once

#include <cmath>

namespace cadgeom {

struct DD {
  double hi = 0, lo = 0;
};

namespace dd {

/** a + b = s + e exactly. */
inline DD twoSum(double a, double b) {
  double s = a + b, bb = s - a, e = (a - (s - bb)) + (b - bb);
  return {s, e};
}
/** a + b = s + e exactly, for |a| >= |b| (or a = 0). */
inline DD fastTwoSum(double a, double b) {
  double s = a + b;
  return {s, b - (s - a)};
}
/** a * b = p + e exactly. */
inline DD twoProd(double a, double b) {
  double p = a * b;
  return {p, std::fma(a, b, -p)};
}

inline DD from(double a) { return {a, 0}; }
inline double toDouble(DD a) { return a.hi + a.lo; }

inline DD add(DD a, DD b) {
  DD s = twoSum(a.hi, b.hi), t = twoSum(a.lo, b.lo);
  s.lo += t.hi;
  s = fastTwoSum(s.hi, s.lo);
  s.lo += t.lo;
  return fastTwoSum(s.hi, s.lo);
}
inline DD neg(DD a) { return {-a.hi, -a.lo}; }
inline DD sub(DD a, DD b) { return add(a, neg(b)); }
inline DD mul(DD a, DD b) {
  DD p = twoProd(a.hi, b.hi);
  p.lo += a.hi * b.lo + a.lo * b.hi;
  return fastTwoSum(p.hi, p.lo);
}
inline DD div(DD a, DD b) {
  double q1 = a.hi / b.hi;
  DD r = sub(a, mul(b, from(q1)));
  double q2 = r.hi / b.hi;
  r = sub(r, mul(b, from(q2)));
  double q3 = r.hi / b.hi;
  DD q = fastTwoSum(q1, q2);
  return add(q, from(q3));
}
/** The square root, a >= 0 (NaN otherwise). */
inline DD sqrt(DD a) {
  if (a.hi <= 0) return {a.hi == 0 ? 0.0 : std::sqrt(a.hi), 0};
  double x = std::sqrt(a.hi);
  // One Newton step on x^2 = a, the residual in double-double.
  DD r = sub(a, twoProd(x, x));
  return fastTwoSum(x, r.hi / (2 * x));
}

/** -1, 0 or 1 as a < b, a == b, a > b (both normalized). */
inline int compare(DD a, DD b) {
  if (a.hi != b.hi) return a.hi < b.hi ? -1 : 1;
  if (a.lo != b.lo) return a.lo < b.lo ? -1 : 1;
  return 0;
}
/** -1, 0 or 1 as a < x, a == x, a > x. */
inline int compare(DD a, double x) { return compare(a, from(x)); }

} // namespace dd
} // namespace cadgeom
