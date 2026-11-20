// Lines and conics (circles, ellipses, hyperbolas, parabolas), 2D and 3D, by ISO 10303-42's parameterizations as
// docs/brep-reference.md gives them. Each is the placement's origin plus a combination of its x and y with
// coefficients in t (a cos t, b sin t; a cosh t, b sinh t; f t^2, 2 f t), so every derivative is the same combination
// of the coefficients' derivatives, exact to any order, and the origin enters the point alone. Bounds in closed form:
// a coordinate of a conic is A cos t + B sin t (extremes where t = atan2(B, A) + j pi), A cosh t + B sinh t (one
// extreme, where tanh t = -B / A), or a quadratic, so a box over a range is its values at the ends and at the
// extremes inside, widened by the rounding of the functions evaluated (a few ulps, with the argument's own).
#include <algorithm>
#include <cmath>

#include "curve_impl.h"

namespace cadgeom {
namespace curves {

namespace {

constexpr double kPi = 3.141592653589793;

/** A placement's origin, x and y (2D: y is x turned +90 degrees; 3D: z x x). */
struct Frame {
  Vec3 o, x, y;
};
Frame readFrame(const double* r, int dim) {
  if (dim == 3) {
    Vec3 o = readVec(r, 3), z = readVec(r + 3, 3), x = readVec(r + 6, 3);
    return {o, x, cross(z, x)};
  }
  Vec3 o = readVec(r, 2), x = readVec(r + 2, 2);
  return {o, x, {-x.y, x.x, 0}};
}
int frameReals(int dim) { return dim == 3 ? 9 : 4; }

double coord(Vec3 v, int i) { return i == 0 ? v.x : i == 1 ? v.y : v.z; }
Interval& coord(Box3& b, int i) { return i == 0 ? b.x : i == 1 ? b.y : b.z; }

/** The range of A cos t + B sin t over r, widened by its rounding. */
Interval sinusoid(double A, double B, Range r) {
  double R = std::hypot(A, B), T = maxNum(std::fabs(r.lo), std::fabs(r.hi));
  double m = 8 * kEps * R * (1 + T);
  if (!(r.hi - r.lo < kTwoPi)) return {-R - m, R + m};
  auto f = [&](double t) { return A * std::cos(t) + B * std::sin(t); };
  double lo = minNum(f(r.lo), f(r.hi)), hi = maxNum(f(r.lo), f(r.hi));
  double phi = std::atan2(B, A);  // f(phi + j pi) = (-1)^j R
  for (double j = std::ceil((r.lo - phi) / kPi); phi + j * kPi <= r.hi; j++) {
    if (std::fmod(std::fabs(j), 2.0) == 0) hi = R;
    else lo = -R;
  }
  return {lo - m, hi + m};
}

/** The range of A cosh t + B sinh t over a finite r, widened by its rounding. */
Interval hyperbolic(double A, double B, Range r) {
  auto f = [&](double t) { return A * std::cosh(t) + B * std::sinh(t); };
  double lo = minNum(f(r.lo), f(r.hi)), hi = maxNum(f(r.lo), f(r.hi));
  if (std::fabs(B) < std::fabs(A)) {
    double t = std::atanh(-B / A);
    if (t > r.lo && t < r.hi) lo = minNum(lo, f(t)), hi = maxNum(hi, f(t));
  }
  double T = maxNum(std::fabs(r.lo), std::fabs(r.hi));
  double m = 8 * kEps * (std::fabs(A) + std::fabs(B)) * std::cosh(T) * (1 + T);
  return {lo - m, hi + m};
}

class Line final : public CurveImpl {
public:
  Line(const double* r, int dim) : dim_(dim), p_(readVec(r, dim)), d_(r[2 * dim] * readVec(r + dim, dim)) {}
  int dim() const override { return dim_; }
  CurveDomain domain() const override { return {{-kInf, kInf}, 0}; }
  Status derivs(double t, int order, Vec3* out) const override {
    out[0] = p_ + t * d_;
    for (int k = 1; k <= order; k++) out[k] = k == 1 ? d_ : Vec3{};
    return Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status derivBox(Range r, int order, Box3& out) const override {
    if (order >= 1) {
      out = order == 1 ? widen(pointBox(d_), 0) : pointBox({});
      return Status::ok;
    }
    if (!finite(r)) {
      out = entireBox();
      return Status::outOfDomain;
    }
    Vec3 a = p_ + r.lo * d_, b = p_ + r.hi * d_;
    out = widen(hull(pointBox(a), b), 4 * kEps * (maxAbs(a) + maxAbs(b)));
    return Status::ok;
  }
  Status derivBoundN(Range, int order, double& out) const override {
    out = order == 1 ? norm(d_) * (1 + 4 * kEps) : 0.0;
    return Status::ok;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }
  Range within(Vec3 p, double d) const override {
    double T = (d + norm(p - p_)) / norm(d_) * (1 + 1e-12);
    return {-T, T};
  }
  bool exactLength(double t0, double t1, double& out) const override {
    out = norm(d_) * (t1 - t0);
    return true;
  }

private:
  int dim_;
  Vec3 p_, d_;
};

/** Circles and ellipses: o + a cos t x + b sin t y. */
class Ellipse final : public CurveImpl {
public:
  Ellipse(const double* r, int dim, double a, double b) : dim_(dim), f_(readFrame(r, dim)), a_(a), b_(b) {}
  int dim() const override { return dim_; }
  CurveDomain domain() const override { return {{0, kTwoPi}, kTwoPi}; }
  Status derivs(double t, int order, Vec3* out) const override {
    double c = std::cos(t), s = std::sin(t);
    // The k-th derivative of (cos, sin) is (cos, sin) turned by k quarter turns.
    double C[4] = {c, -s, -c, s}, S[4] = {s, c, -s, -c};
    out[0] = f_.o + (a_ * c) * f_.x + (b_ * s) * f_.y;
    for (int k = 1; k <= order; k++) out[k] = (a_ * C[k % 4]) * f_.x + (b_ * S[k % 4]) * f_.y;
    return Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status derivBox(Range r, int order, Box3& out) const override {
    if (!finite(r)) {
      r = {0, kTwoPi};
    }
    // The order-k derivative's coordinate i is A cos t + B sin t, (A, B) turned by k quarter turns: (B, -A) each.
    for (int i = 0; i < 3; i++) {
      double A = a_ * coord(f_.x, i), B = b_ * coord(f_.y, i);
      for (int k = 0; k < order; k++) {
        double t = A;
        A = B, B = -t;
      }
      Interval v = sinusoid(A, B, r);
      if (order == 0) {
        double o = coord(f_.o, i);
        v = {v.lo + o - 4 * kEps * std::fabs(o), v.hi + o + 4 * kEps * std::fabs(o)};
      }
      coord(out, i) = v;
    }
    return Status::ok;
  }
  Status derivBoundN(Range r, int order, double& out) const override {
    // |C^(k)|^2 = a^2 cos^2 + b^2 sin^2 (k even) or a^2 sin^2 + b^2 cos^2 (k odd): extremes at multiples of pi / 2.
    if (!(r.hi - r.lo < kTwoPi) || !finite(r)) {
      out = maxNum(a_, b_) * (1 + 8 * kEps);
      return Status::ok;
    }
    auto g = [&](double t) {
      double c = std::cos(t), s = std::sin(t);
      return order % 2 == 0 ? std::hypot(a_ * c, b_ * s) : std::hypot(a_ * s, b_ * c);
    };
    double m = maxNum(g(r.lo), g(r.hi));
    for (double j = std::ceil(r.lo / (kPi / 2)); j * (kPi / 2) <= r.hi; j++) m = maxNum(m, g(j * (kPi / 2)));
    out = m * (1 + 8 * kEps) + 8 * kEps * maxNum(a_, b_);
    return Status::ok;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }
  bool footCandidates(Vec3 p, Range r, double tol, std::vector<double>& out) const override {
    if (a_ != b_ || !finite(r)) return false;
    // A circle: the foot at the angle of p's projection on its plane, phi (or the range's ends); every point when
    // p is so near the axis that the distances differ by at most tol (|C(t) - p|^2 varies by 4 r rho over t).
    Vec3 q = p - f_.o;
    double qx = dot(q, f_.x), qy = dot(q, f_.y), rho = std::hypot(qx, qy), d = norm(q);
    out = {r.lo, r.hi};
    if (2 * a_ * rho <= tol * maxNum(d, a_)) {
      for (int k = 1; k < 8; k++) out.push_back(r.lo + (r.hi - r.lo) * k / 8);
      return true;
    }
    double phi = std::atan2(qy, qx);
    for (double t = phi + kTwoPi * std::ceil((r.lo - phi) / kTwoPi); t <= r.hi; t += kTwoPi) out.push_back(t);
    return true;
  }
  bool exactLength(double t0, double t1, double& out) const override {
    if (a_ != b_) return false;
    out = a_ * (t1 - t0);
    return true;
  }

private:
  int dim_;
  Frame f_;
  double a_, b_;
};

/** o + a cosh t x + b sinh t y: one branch. */
class Hyperbola final : public CurveImpl {
public:
  Hyperbola(const double* r, int dim)
    : dim_(dim), f_(readFrame(r, dim)), a_(r[frameReals(dim)]), b_(r[frameReals(dim) + 1]) {}
  int dim() const override { return dim_; }
  CurveDomain domain() const override { return {{-kInf, kInf}, 0}; }
  Status derivs(double t, int order, Vec3* out) const override {
    double c = std::cosh(t), s = std::sinh(t);
    out[0] = f_.o + (a_ * c) * f_.x + (b_ * s) * f_.y;
    for (int k = 1; k <= order; k++)
      out[k] = k % 2 ? (a_ * s) * f_.x + (b_ * c) * f_.y : (a_ * c) * f_.x + (b_ * s) * f_.y;
    return Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status derivBox(Range r, int order, Box3& out) const override {
    if (!finite(r)) {
      out = entireBox();
      return Status::outOfDomain;
    }
    for (int i = 0; i < 3; i++) {
      double A = a_ * coord(f_.x, i), B = b_ * coord(f_.y, i);
      // Odd orders swap the roles: a sinh t x + b cosh t y.
      Interval v = order % 2 ? hyperbolic(B, A, r) : hyperbolic(A, B, r);
      if (order == 0) {
        double o = coord(f_.o, i);
        v = {v.lo + o - 4 * kEps * std::fabs(o), v.hi + o + 4 * kEps * std::fabs(o)};
      }
      coord(out, i) = v;
    }
    return Status::ok;
  }
  Status derivBoundN(Range r, int order, double& out) const override {
    // Both a^2 cosh^2 + b^2 sinh^2 and a^2 sinh^2 + b^2 cosh^2 grow with |t|.
    double T = maxNum(std::fabs(r.lo), std::fabs(r.hi));
    if (!std::isfinite(T)) {
      out = kInf;
      return Status::outOfDomain;
    }
    double c = std::cosh(T), s = std::sinh(T);
    out = (order % 2 ? std::hypot(a_ * s, b_ * c) : std::hypot(a_ * c, b_ * s)) * (1 + 8 * kEps * (1 + T));
    return Status::ok;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }
  Range within(Vec3 p, double d) const override {
    // |C - o|^2 = a^2 cosh^2 + b^2 sinh^2 >= min(a, b)^2 cosh^2 t.
    double T = std::acosh(maxNum(1.0, (d + norm(p - f_.o)) / minNum(a_, b_))) * (1 + 1e-12) + 1e-12;
    return {-T, T};
  }

private:
  int dim_;
  Frame f_;
  double a_, b_;
};

/** o + f (t^2 x + 2 t y). */
class Parabola final : public CurveImpl {
public:
  Parabola(const double* r, int dim) : dim_(dim), f_(readFrame(r, dim)), fd_(r[frameReals(dim)]) {}
  int dim() const override { return dim_; }
  CurveDomain domain() const override { return {{-kInf, kInf}, 0}; }
  Status derivs(double t, int order, Vec3* out) const override {
    out[0] = f_.o + (fd_ * t * t) * f_.x + (2 * fd_ * t) * f_.y;
    for (int k = 1; k <= order; k++)
      out[k] = k == 1 ? (2 * fd_ * t) * f_.x + (2 * fd_) * f_.y : k == 2 ? (2 * fd_) * f_.x : Vec3{};
    return Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status derivBox(Range r, int order, Box3& out) const override {
    if (order >= 2) {
      out = order == 2 ? widen(pointBox((2 * fd_) * f_.x), 4 * kEps * 2 * std::fabs(fd_)) : pointBox({});
      return Status::ok;
    }
    if (!finite(r)) {
      out = entireBox();
      return Status::outOfDomain;
    }
    double T = maxNum(std::fabs(r.lo), std::fabs(r.hi));
    for (int i = 0; i < 3; i++) {
      // Coordinate i: al t^2 + be t (the point's), 2 al t + be (the tangent's).
      double al = fd_ * coord(f_.x, i), be = 2 * fd_ * coord(f_.y, i);
      auto f = [&](double t) { return order == 0 ? al * t * t + be * t : 2 * al * t + be; };
      double lo = minNum(f(r.lo), f(r.hi)), hi = maxNum(f(r.lo), f(r.hi));
      if (order == 0 && al != 0) {
        double t = -be / (2 * al);
        if (t > r.lo && t < r.hi) lo = minNum(lo, f(t)), hi = maxNum(hi, f(t));
      }
      double m = 8 * kEps * (std::fabs(al) * T * T + std::fabs(be) * T + 2 * std::fabs(al) * T + std::fabs(be));
      Interval v{lo - m, hi + m};
      if (order == 0) {
        double o = coord(f_.o, i);
        v = {v.lo + o - 4 * kEps * std::fabs(o), v.hi + o + 4 * kEps * std::fabs(o)};
      }
      coord(out, i) = v;
    }
    return Status::ok;
  }
  Status derivBoundN(Range r, int order, double& out) const override {
    double T = maxNum(std::fabs(r.lo), std::fabs(r.hi));
    out = order == 1 ? 2 * std::fabs(fd_) * std::hypot(T, 1.0) * (1 + 8 * kEps)
      : order == 2 ? 2 * std::fabs(fd_) * (1 + 4 * kEps) : 0;
    return std::isfinite(out) ? Status::ok : Status::outOfDomain;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }
  Range within(Vec3 p, double d) const override {
    // |C - o| = |f| sqrt(t^4 + 4 t^2) >= |f| t^2.
    double T = std::sqrt((d + norm(p - f_.o)) / std::fabs(fd_)) * (1 + 1e-12) + 1e-12;
    return {-T, T};
  }

private:
  int dim_;
  Frame f_;
  double fd_;
};

} // namespace

std::unique_ptr<CurveImpl> makeLine(const double* r, int dim) { return std::make_unique<Line>(r, dim); }
std::unique_ptr<CurveImpl> makeEllipse(const double* r, int dim, double a, double b) {
  return std::make_unique<Ellipse>(r, dim, a, b);
}
std::unique_ptr<CurveImpl> makeHyperbola(const double* r, int dim) { return std::make_unique<Hyperbola>(r, dim); }
std::unique_ptr<CurveImpl> makeParabola(const double* r, int dim) { return std::make_unique<Parabola>(r, dim); }

} // namespace curves
} // namespace cadgeom
