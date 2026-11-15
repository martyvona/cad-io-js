// Interval arithmetic for the bounds that must hold: pruning in global searches and guaranteed deflections (the only
// places the project uses intervals; everything else is floating point with error estimates). WebAssembly has no
// rounding modes, so outward rounding is in software: each result computed to nearest, then widened by one ulp each
// way, which encloses the exact result of an operation correctly rounded to nearest (+, -, *, /, sqrt). Library
// functions (sin, cos, exp, ...) aren't correctly rounded: widen them by the bound their implementation documents.
#pragma once

#include <algorithm>
#include <cmath>
#include <limits>

#include "vec.h"

namespace cadgeom {

/** A closed interval [lo, hi] holding the exact value; empty when lo > hi (NaN ends: unknown, the whole line). */
struct Interval {
  double lo = 0, hi = 0;

  static Interval point(double x) { return {x, x}; }
  static Interval hull(double a, double b) { return {std::min(a, b), std::max(a, b)}; }
  static Interval entire() {
    return {-std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity()};
  }
  double mid() const { return 0.5 * lo + 0.5 * hi; }
  double width() const { return hi - lo; }
  bool contains(double x) const { return lo <= x && x <= hi; }
  /** The largest |x| over the interval. */
  double mag() const { return std::max(std::fabs(lo), std::fabs(hi)); }
};

namespace interval_detail {
inline double down(double x) { return std::nextafter(x, -std::numeric_limits<double>::infinity()); }
inline double up(double x) { return std::nextafter(x, std::numeric_limits<double>::infinity()); }
} // namespace interval_detail

inline Interval operator+(Interval a, Interval b) {
  return {interval_detail::down(a.lo + b.lo), interval_detail::up(a.hi + b.hi)};
}
inline Interval operator-(Interval a, Interval b) {
  return {interval_detail::down(a.lo - b.hi), interval_detail::up(a.hi - b.lo)};
}
inline Interval operator-(Interval a) { return {-a.hi, -a.lo}; }
/** The product; 0 times an infinite end is 0 (the limit every point of the other interval gives). */
inline Interval operator*(Interval a, Interval b) {
  auto m = [](double x, double y) { return x == 0 || y == 0 ? 0.0 : x * y; };
  double p[4] = {m(a.lo, b.lo), m(a.lo, b.hi), m(a.hi, b.lo), m(a.hi, b.hi)};
  return {interval_detail::down(*std::min_element(p, p + 4)), interval_detail::up(*std::max_element(p, p + 4))};
}
/** Division; a divisor containing 0 gives the entire line, and so does an infinite end over an infinite end. */
inline Interval operator/(Interval a, Interval b) {
  if (b.lo <= 0 && b.hi >= 0) return Interval::entire();
  double q[4] = {a.lo / b.lo, a.lo / b.hi, a.hi / b.lo, a.hi / b.hi};
  for (double x : q)
    if (std::isnan(x)) return Interval::entire();
  return {interval_detail::down(*std::min_element(q, q + 4)), interval_detail::up(*std::max_element(q, q + 4))};
}
/** The square root of the interval's nonnegative part. */
inline Interval sqrt(Interval a) {
  return {a.hi < 0 ? 1.0 : interval_detail::down(std::sqrt(std::max(a.lo, 0.0))),
    a.hi < 0 ? 0.0 : interval_detail::up(std::sqrt(a.hi))};
}
/** a^2, tighter than a * a when a contains 0. */
inline Interval sqr(Interval a) {
  double l = std::fabs(a.lo), h = std::fabs(a.hi);
  double lo = (a.lo <= 0 && a.hi >= 0) ? 0.0 : interval_detail::down(std::min(l, h) * std::min(l, h));
  return {lo, interval_detail::up(std::max(l, h) * std::max(l, h))};
}

/** An axis-aligned box in (u, v) or 3D: the enclosures bounds() return. */
struct Box2 {
  Interval x, y;
};
struct Box3 {
  Interval x, y, z;
};

} // namespace cadgeom
