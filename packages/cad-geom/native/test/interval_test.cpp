// interval.h and dd.h. Double-double: TwoSum and TwoProd exact (checked in 128-bit integers), the operations against
// known constants and each other. Intervals: each operation encloses the exact result, on exactly representable
// cases, random point and wide intervals, infinities and zeros; the exact result of + - * from double-double (exact
// for two doubles), of / and sqrt by the sign of an fma residual (exact: rounding keeps a sign), never by a value
// that could itself be off.
#include <cad_geom/dd.h>
#include <cad_geom/interval.h>

#include <cmath>
#include <cstdint>
#include <limits>
#include <cstdio>
#include <vector>
#include <random>
#include <cstring>

#include "check.h"

using namespace cadgeom;

namespace {

struct Rng {
  uint64_t s;
  uint64_t next() {
    uint64_t z = (s += 0x9e3779b97f4a7c15ull);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
    return z ^ (z >> 31);
  }
  /** A double of random sign, mantissa and exponent in [2^lo, 2^hi). */
  double any(int lo = -30, int hi = 30) {
    double m = 1 + (next() >> 12) * 0x1.0p-52;
    int e = lo + static_cast<int>(next() % (hi - lo));
    return (next() & 1 ? -1 : 1) * std::ldexp(m, e);
  }
};

const double inf = std::numeric_limits<double>::infinity();

/** lo <= exact (a DD) <= hi. */
bool encloses(Interval r, DD exact) { return dd::compare(exact, r.lo) >= 0 && dd::compare(exact, r.hi) <= 0; }

/** The interval is at most `ulps` ulps wider each way than the correctly rounded hull of the values. */
bool tight(Interval r, double lo, double hi, int ulps = 1) {
  for (int k = 0; k < ulps; k++) lo = std::nextafter(lo, -inf), hi = std::nextafter(hi, inf);
  return r.lo >= lo && r.hi <= hi;
}

/** The sign of a - q * b, exactly (one rounding keeps the sign; zero only if exact, barring underflow). */
int residualSign(double a, double q, double b) {
  double r = std::fma(-q, b, a);
  return (r > 0) - (r < 0);
}

} // namespace

// ---- Double-double ----

TEST_CASE("twoSum and twoProd are exact (128-bit integer check)") {
  Rng r{1};
  for (int i = 0; i < 20000; i++) {
    // Integers below 2^53, scaled by 2^k with k >= 0 small enough that the exact result fits 127 bits.
    auto integer = [&](int k) {
      return std::ldexp(static_cast<double>(r.next() >> 11) * (r.next() & 1 ? -1 : 1), k);
    };
    double a = integer(static_cast<int>(r.next() % 60)), b = integer(static_cast<int>(r.next() % 60));
    DD s = dd::twoSum(a, b);
    CHECK_EQ(s.hi, a + b);
    CHECK((__int128)a + (__int128)b == (__int128)s.hi + (__int128)s.lo);
    double c = integer(0), d = integer(0);
    DD p = dd::twoProd(c, d);
    CHECK_EQ(p.hi, c * d);
    CHECK((__int128)c * (__int128)d == (__int128)p.hi + (__int128)p.lo);
    if (std::fabs(a) >= std::fabs(b)) {
      DD f = dd::fastTwoSum(a, b);
      CHECK((__int128)a + (__int128)b == (__int128)f.hi + (__int128)f.lo);
    }
  }
}

TEST_CASE("double-double: known constants, normalization, round trips") {
  DD third = dd::div(dd::from(1), dd::from(3));
  CHECK_EQ(third.hi, 0.3333333333333333);
  CHECK_NEAR(third.lo, 1.850371707708594e-17, 1e-14, 0);
  DD root2 = dd::sqrt(dd::from(2));
  CHECK_EQ(root2.hi, 1.4142135623730951);
  CHECK_NEAR(root2.lo, -9.667293313452913e-17, 1e-14, 0);
  // pi to 32 digits, as the sum of its two nearest doubles.
  DD pi{3.141592653589793, 1.2246467991473532e-16};
  DD back = dd::mul(dd::div(pi, dd::from(7)), dd::from(7));
  CHECK(std::fabs((back.hi - pi.hi) + (back.lo - pi.lo)) < 1e-31);
  DD sq = dd::mul(root2, root2);
  CHECK(std::fabs((sq.hi - 2) + sq.lo) < 4e-32);
  DD three = dd::mul(third, dd::from(3));
  CHECK(std::fabs((three.hi - 1) + three.lo) < 4e-32);
  // 1 + 2^-80 survives in double-double, not in double.
  DD tiny = dd::add(dd::from(1), dd::from(0x1.0p-80));
  CHECK_EQ(tiny.hi, 1.0);
  CHECK_EQ(tiny.lo, 0x1.0p-80);
  CHECK_EQ(dd::toDouble(dd::sub(tiny, dd::from(1))), 0x1.0p-80);
  CHECK_EQ(dd::compare(tiny, 1.0), 1);
  CHECK_EQ(dd::compare(dd::neg(tiny), -1.0), -1);
  CHECK_EQ(dd::compare(dd::from(2), 2.0), 0);
  // Two sums that cancel exactly, leaving the low parts: 2^-60 + 2^-114 kept whole.
  DD cancel = dd::add({1, 0x1.0p-60}, {-1, 0x1.0p-114});
  CHECK_EQ(cancel.hi, 0x1.0p-60);
  CHECK_EQ(cancel.lo, 0x1.0p-114);
  CHECK_EQ(dd::sqrt(dd::from(0)).hi, 0.0);
  CHECK(std::isnan(dd::sqrt(dd::from(-1)).hi));
}

TEST_CASE("double-double: random sums, products and quotients within a few u^2 of each other's inverses") {
  Rng r{2};
  for (int i = 0; i < 5000; i++) {
    DD a = dd::add(dd::from(r.any()), dd::from(r.any(-80, -40)));
    DD b = dd::add(dd::from(r.any()), dd::from(r.any(-80, -40)));
    if (b.hi == 0) continue;
    DD s = dd::add(a, b), back = dd::sub(s, b);
    double scale = std::max(std::fabs(a.hi), std::fabs(b.hi));
    CHECK(std::fabs((back.hi - a.hi) + (back.lo - a.lo)) <= 8 * 0x1.0p-106 * scale);
    DD q = dd::div(a, b), m = dd::mul(q, b);
    CHECK(std::fabs((m.hi - a.hi) + (m.lo - a.lo)) <= 16 * 0x1.0p-106 * std::fabs(a.hi));
    DD x = dd::from(std::fabs(r.any())), root = dd::sqrt(x), sq = dd::mul(root, root);
    CHECK(std::fabs((sq.hi - x.hi) + sq.lo) <= 16 * 0x1.0p-106 * x.hi);
  }
}

// ---- Intervals ----

TEST_CASE("intervals: the outward steps are nextafter's, at zeros, infinities, NaN, subnormals and random doubles") {
  const double inf = std::numeric_limits<double>::infinity(), dmin = std::numeric_limits<double>::denorm_min();
  const double nmin = std::numeric_limits<double>::min(), dmax = std::numeric_limits<double>::max();
  std::vector<double> xs = {0.0, -0.0, inf, -inf, dmin, -dmin, nmin, -nmin, dmax, -dmax, 1.0, -1.0, 0.1, -0.1,
    1e-310, -1e-310, 3e300, -3e300};
  std::mt19937_64 rng(11);
  for (int i = 0; i < 2000; i++) {
    uint64_t b = rng();
    double x;
    std::memcpy(&x, &b, sizeof x);
    if (std::isfinite(x)) xs.push_back(x);
  }
  int bad = 0;
  for (double x : xs) {
    const double u = interval_detail::up(x), d = interval_detail::down(x);
    const double nu = std::nextafter(x, inf), nd = std::nextafter(x, -inf);
    uint64_t a, b, c, e;
    std::memcpy(&a, &u, 8), std::memcpy(&b, &nu, 8), std::memcpy(&c, &d, 8), std::memcpy(&e, &nd, 8);
    if ((a != b || c != e) && bad++ < 5)
      std::printf("  %.17g: up %.17g / %.17g, down %.17g / %.17g\n", x, u, nu, d, nd);
  }
  CHECK_EQ(bad, 0);
  CHECK(std::isnan(interval_detail::up(std::nan(""))));
  CHECK(std::isnan(interval_detail::down(std::nan(""))));
}

TEST_CASE("intervals: exactly representable cases, tight to one ulp") {
  Interval a{1, 2}, b{3, 4};
  Interval s = a + b, d = a - b, m = a * b, q = b / a, n = -a, r = sqrt(Interval{4, 9}), p = sqr(Interval{-3, 2});
  CHECK(s.lo <= 4 && s.hi >= 6 && tight(s, 4, 6));
  CHECK(d.lo <= -3 && d.hi >= -1 && tight(d, -3, -1));
  CHECK(m.lo <= 3 && m.hi >= 8 && tight(m, 3, 8));
  CHECK(q.lo <= 1.5 && q.hi >= 4 && tight(q, 1.5, 4));
  CHECK(n.lo == -2 && n.hi == -1);
  CHECK(r.lo <= 2 && r.hi >= 3 && tight(r, 2, 3));
  CHECK(p.lo == 0 && p.hi >= 9 && tight(p, 0, 9));
  Interval mixed = Interval{-2, 3} * Interval{-5, 4};
  CHECK(mixed.lo <= -15 && mixed.hi >= 12 && tight(mixed, -15, 12));
  Interval squareNeg = sqr(Interval{-4, -2});
  CHECK(squareNeg.lo <= 4 && squareNeg.hi >= 16 && tight(squareNeg, 4, 16));
  CHECK(Interval::point(2.5).lo == 2.5 && Interval::point(2.5).hi == 2.5);
  CHECK(Interval::hull(3, -1).lo == -1 && Interval::hull(3, -1).hi == 3);
  const Interval mixedSign{-3, 2}, oneThree{1, 3};
  CHECK_EQ(mixedSign.mag(), 3.0);
  CHECK_EQ(oneThree.mid(), 2.0);
  CHECK_EQ(oneThree.width(), 2.0);
  CHECK(oneThree.contains(3) && !oneThree.contains(3.5));
}

TEST_CASE("intervals: random points and wide intervals enclose the exact results") {
  Rng r{3};
  for (int i = 0; i < 20000; i++) {
    double x = r.any(), y = r.any(), x2 = r.any(), y2 = r.any();
    Interval a = Interval::hull(x, x2), b = Interval::hull(y, y2);
    Interval s = a + b, d = a - b, m = a * b;
    // Every corner's exact result (the extremes of + - * over a box are at corners).
    for (double u : {a.lo, a.hi})
      for (double v : {b.lo, b.hi}) {
        CHECK(encloses(s, dd::twoSum(u, v)));
        CHECK(encloses(d, dd::twoSum(u, -v)));
        CHECK(encloses(m, dd::twoProd(u, v)));
      }
    // Points: and tight.
    Interval px = Interval::point(x), py = Interval::point(y);
    Interval ps = px + py, pm = px * py;
    CHECK(encloses(ps, dd::twoSum(x, y)) && tight(ps, x + y, x + y));
    CHECK(encloses(pm, dd::twoProd(x, y)) && tight(pm, x * y, x * y));
    // Quotients: lo <= x / y <= hi by the residuals' signs (y > 0 here: the sign flips for y < 0).
    Interval pq = px / py;
    int sy = y > 0 ? 1 : -1;
    CHECK(residualSign(x, pq.lo, y) * sy >= 0);
    CHECK(residualSign(x, pq.hi, y) * sy <= 0);
    CHECK(tight(pq, x / y, x / y));
    Interval wq = a / b;
    if (!(b.lo <= 0 && b.hi >= 0))
      for (double u : {a.lo, a.hi})
        for (double v : {b.lo, b.hi}) {
          int sv = v > 0 ? 1 : -1;
          CHECK(residualSign(u, wq.lo, v) * sv >= 0);
          CHECK(residualSign(u, wq.hi, v) * sv <= 0);
        }
    // Square roots: lo^2 <= |x| <= hi^2, exactly by fma.
    double ax = std::fabs(x);
    Interval rt = sqrt(Interval::point(ax));
    CHECK(std::fma(rt.lo, rt.lo, -ax) <= 0);
    CHECK(std::fma(rt.hi, rt.hi, -ax) >= 0);
    CHECK(tight(rt, std::sqrt(ax), std::sqrt(ax)));
    Interval sq = sqr(px);
    CHECK(encloses(sq, dd::twoProd(x, x)));
  }
}

TEST_CASE("intervals: zeros, infinities, overflow, underflow and division by an interval holding 0") {
  Interval zero = Interval::point(0), all = Interval::entire(), pos{1, inf};
  Interval z = zero * all;
  CHECK(z.lo <= 0 && z.hi >= 0 && std::isfinite(z.lo) && std::isfinite(z.hi));
  Interval zp = zero * pos;
  CHECK(zp.lo <= 0 && zp.hi >= 0 && !std::isnan(zp.lo) && !std::isnan(zp.hi));
  Interval pp = pos * pos;
  CHECK(pp.lo <= 1 && pp.hi == inf);
  Interval ratio = pos / pos;
  CHECK(ratio.lo <= 0 && ratio.hi == inf);
  Interval nanFirst = Interval{-inf, 1} / Interval{-inf, -1};  // -inf / -inf at the first corner
  CHECK(!std::isnan(nanFirst.lo) && !std::isnan(nanFirst.hi) && nanFirst.lo <= -1 && nanFirst.hi == inf);
  Interval byZero = Interval{1, 2} / Interval{-1, 1};
  CHECK(byZero.lo == -inf && byZero.hi == inf);
  Interval byEdge = Interval{1, 2} / Interval{0, 1};
  CHECK(byEdge.lo == -inf && byEdge.hi == inf);
  const double big = std::numeric_limits<double>::max();
  Interval over = Interval::point(big) + Interval::point(big);
  CHECK(over.hi == inf && over.lo <= big * 2);
  Interval tiny = Interval::point(0x1.0p-1074) * Interval::point(0.5);
  CHECK(tiny.lo <= 0 && tiny.hi > 0);  // the exact 2^-1075 rounds to 0: widened past it
  Interval neg = sqrt(Interval{-4, -1});
  CHECK(neg.lo > neg.hi);  // empty
  Interval half = sqrt(Interval{-1, 4});
  CHECK(half.lo <= 0 && half.hi >= 2 && tight(half, 0, 2));
  Interval inv = Interval::point(1) / Interval::point(3);
  CHECK(residualSign(1, inv.lo, 3) >= 0 && residualSign(1, inv.hi, 3) <= 0);
}
