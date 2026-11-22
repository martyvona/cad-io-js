// Planes, cylinders, cones, spheres and tori by ISO 10303-42's parameterizations as docs/brep-reference.md gives
// them. Each is the placement's origin plus f(v) E(u) + g(v) z with E(u) = cos u x + sin u y (a plane: u x + v y), so
// every partial S^(k,l) is f^(l)(v) E^(k)(u) + [k = 0] g^(l)(v) z, exact to any order, and the origin enters the
// point alone (surface.h's precision rule). Boxes in closed form: each coordinate of E^(k) is a sinusoid in u (its
// range exact, sinusoid()) times an interval of f^(l) over v (independent variables: the product's range exact), plus
// g^(l)'s interval times z, widened by the rounding of the functions evaluated. Feet in closed form, in the meridian
// plane through the point (on a cone, its two generators there; on a torus, its two tube circles), each kept only
// where it is a minimum in u too (on the point's side of the axis); a point on the axis, at a sphere's centre or a
// tube's centre has a continuum of feet, sampled.
#include <algorithm>
#include <cmath>

#include "surface_impl.h"

namespace cadgeom {
namespace surfaces {

Interval sinusoid(double A, double B, Range r) {
  double R = std::hypot(A, B), T = maxNum(std::fabs(r.lo), std::fabs(r.hi));
  double m = 8 * kEps * R * (1 + (std::isfinite(T) ? T : 0));
  if (!finite(r) || !(r.hi - r.lo < kTwoPi)) return {-R - m, R + m};
  auto f = [&](double t) { return A * std::cos(t) + B * std::sin(t); };
  double lo = minNum(f(r.lo), f(r.hi)), hi = maxNum(f(r.lo), f(r.hi));
  double phi = std::atan2(B, A);  // f(phi + j pi) = (-1)^j R
  for (double j = std::ceil((r.lo - phi) / kPi); phi + j * kPi <= r.hi; j++) {
    if (std::fmod(std::fabs(j), 2.0) == 0) hi = R;
    else lo = -R;
  }
  return {lo - m, hi + m};
}

namespace {

struct Frame {
  Vec3 o, x, y, z;
};
Frame readFrame(const double* r) {
  Vec3 o = read3(r), z = read3(r + 3), x = read3(r + 6);
  return {o, x, cross(z, x), z};
}

/** The k-th derivative of E(u) = cos u x + sin u y. */
Vec3 E(const Frame& f, double u, int k) {
  double A = 1, B = 0;
  turn(A, B, k);
  // A cos u + B sin u for x's coefficient; y's is the same turned once back: (sin u)^(k).
  double cx = A * std::cos(u) + B * std::sin(u);
  double A2 = 0, B2 = 1;
  turn(A2, B2, k);
  double cy = A2 * std::cos(u) + B2 * std::sin(u);
  return cx * f.x + cy * f.y;
}

/** The box of E^(k) over ru, coordinate by coordinate. */
Box3 EBox(const Frame& f, Range ru, int k) {
  Box3 b;
  for (int i = 0; i < 3; i++) {
    double A = coord(f.x, i), B = coord(f.y, i);
    turn(A, B, k);
    coord(b, i) = sinusoid(A, B, ru);
  }
  return b;
}

/** cos^(l) or (sin) sin^(l) at v, and over a range. */
double trig(double v, int l, bool sine) {
  double A = sine ? 0 : 1, B = sine ? 1 : 0;
  turn(A, B, l);
  return A * std::cos(v) + B * std::sin(v);
}
Interval trigRange(Range rv, int l, bool sine) {
  double A = sine ? 0 : 1, B = sine ? 1 : 0;
  turn(A, B, l);
  return sinusoid(A, B, rv);
}

/** The origin added to an order-0 box, with its rounding. */
Box3 shifted(Box3 b, Vec3 o) {
  b = b + pointBox(o);
  return widen(b, 4 * kEps * maxAbs(o));
}

/** v reduced into [0, period). */
double reduce(double x, double period) {
  double r = x - period * std::floor(x / period);
  return r >= period ? 0.0 : r;
}

/** Whether a range covers a whole period (a few ulps short by rounding still does). */
bool whole(Range r, double period) { return r.hi - r.lo >= period * (1 - 8 * kEps); }

/** n samples of u over a period, for a continuum of feet round the axis. */
void ring(double v, std::vector<Vec2>& out, int n = 8) {
  for (int j = 0; j < n; j++) out.push_back({kTwoPi * j / n, v});
}

/** The s in [lo, hi] where a + b s lies in r (an empty range, lo > hi, where none does). */
Range linearIn(double a, double b, Range r, double lo, double hi) {
  if (b == 0) return a >= r.lo && a <= r.hi ? Range{lo, hi} : Range{1, 0};
  double s0 = (r.lo - a) / b, s1 = (r.hi - a) / b;
  if (s0 > s1) std::swap(s0, s1);
  return {maxNum(lo, s0), minNum(hi, s1)};
}

class Plane final : public SurfaceImpl {
public:
  explicit Plane(const double* r) : f_(readFrame(r)) {}
  SurfaceDomain domain() const override { return {{-kInf, kInf}, {-kInf, kInf}, 0, 0}; }
  Status derivs(double u, double v, int order, Vec3* out) const override {
    for (int i = 0; i < pidx(0, order) + 1; i++) out[i] = {};
    out[0] = f_.o + (u * f_.x + v * f_.y);
    if (order >= 1) out[pidx(1, 0)] = f_.x, out[pidx(0, 1)] = f_.y;
    return Status::ok;
  }
  Status normal(double, double, Vec3& out) const override {
    out = f_.z;
    return Status::ok;
  }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    us = {ru.lo, ru.hi}, vs = {rv.lo, rv.hi};
  }
  Status derivBox(Range ru, Range rv, int k, int l, Box3& out) const override {
    if (k + l >= 2) return out = pointBox({}), Status::ok;
    if (k + l == 1) return out = pointBox(k ? f_.x : f_.y), Status::ok;
    if (!finite(ru) || !finite(rv)) return out = entireBox(), Status::outOfDomain;
    Box3 b = scaled({ru.lo, ru.hi}, f_.x) + scaled({rv.lo, rv.hi}, f_.y);
    out = shifted(b, f_.o);
    return Status::ok;
  }
  void singularities(std::vector<Singularity>& out) const override { out.clear(); }
  void within(Vec3 p, double d, Range& ru, Range& rv) const override {
    // |S - p| >= |u - (p - o) . x| and likewise in v.
    Vec3 q = p - f_.o;
    double e = d * (1 + 1e-12) + 4 * kEps * norm(q);
    ru = {dot(q, f_.x) - e, dot(q, f_.x) + e}, rv = {dot(q, f_.y) - e, dot(q, f_.y) + e};
  }
  bool lineClosedForm(Vec3 o, Vec3 ud, double sLo, double sHi, Range ru, Range rv, double tol,
    LineIntersection& out) const override {
    // The signed distance to the plane is linear along the line, a + b s; (u, v) too.
    const Vec3 q = o - f_.o;
    const double a = dot(q, f_.z), b = dot(ud, f_.z), r = 4 * kEps * (norm(q) + maxNum(std::fabs(sLo), std::fabs(sHi)));
    const Range su = linearIn(dot(q, f_.x), dot(ud, f_.x), ru, sLo, sHi);
    const Range sv = linearIn(dot(q, f_.y), dot(ud, f_.y), rv, sLo, sHi);
    const Range in{maxNum(su.lo, sv.lo), minNum(su.hi, sv.hi)};
    out = LineIntersection{};
    out.status = Status::ok;
    if (std::fabs(a + b * sLo) <= tol + r && std::fabs(a + b * sHi) <= tol + r) {
      // Within tol all along: an overlap where it's over the rectangle.
      if (in.lo <= in.hi) out.overlaps.push_back(in);
      return true;
    }
    if (b == 0) return true;
    // Within tol over [w.lo, w.hi], crossing at s0; that over the rectangle.
    const double s0 = -a / b, w0 = (-tol - r - a) / b, w1 = (tol + r - a) / b;
    const Range w{maxNum(in.lo, minNum(w0, w1)), minNum(in.hi, maxNum(w0, w1))};
    if (!(w.lo <= w.hi)) return true;
    const double sc = std::clamp(s0, w.lo, w.hi);
    const Vec3 p = o + sc * ud;
    LineHit h{sc, {dot(p - f_.o, f_.x), dot(p - f_.o, f_.y)}, p, b, false, {sc, sc}};
    // (A crossing within tol of the segment's or the rectangle's end is that end's, as the search keeps it.)
    if (std::fabs(b) >= kLineMargin && s0 >= in.lo - tol && s0 <= in.hi + tol) out.crossings.push_back(h);
    else {
      // Too oblique for tol to place the crossing along the line, or crossing outside the rectangle within tol of the
      // surface there: a contact over the stretch within tol.
      h.span = w;
      out.tangencies.push_back(h);
    }
    return true;
  }
  bool footCandidates(Vec3 p, Range ru, Range rv, double, std::vector<Vec2>& out) const override {
    // |S - p|^2 is (u - a)^2 + (v - b)^2 plus a constant: its minimum over a rectangle the clamped (a, b).
    Vec3 q = p - f_.o;
    out = {{std::clamp(dot(q, f_.x), ru.lo, ru.hi), std::clamp(dot(q, f_.y), rv.lo, rv.hi)}};
    return true;
  }

private:
  Frame f_;
};

/** o + (r + v k) E(u) + v z. */
class Cone final : public SurfaceImpl {
public:
  Cone(const double* r, double radius, double k) : f_(readFrame(r)), r_(radius), k_(k) {}
  SurfaceDomain domain() const override { return {{0, kTwoPi}, {-kInf, kInf}, kTwoPi, 0}; }
  Status derivs(double u, double v, int order, Vec3* out) const override {
    for (int n = 0; n <= order; n++)
      for (int l = 0; l <= n; l++) {
        int k = n - l;
        double f = l == 0 ? r_ + v * k_ : l == 1 ? k_ : 0;
        Vec3 s = f == 0 ? Vec3{} : f * E(f_, u, k);
        if (k == 0 && l <= 1) s = s + (l == 0 ? v : 1.0) * f_.z;
        out[pidx(k, l)] = s;
      }
    out[0] = out[0] + f_.o;
    return Status::ok;
  }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    us = {ru.lo, ru.hi}, vs = {rv.lo, rv.hi};
  }
  Status derivBox(Range ru, Range rv, int k, int l, Box3& out) const override {
    if (l >= 2) return out = pointBox({}), Status::ok;
    if (l == 0 && !finite(rv)) return out = entireBox(), Status::outOfDomain;
    Interval f = l == 0 ? Interval::hull(r_ + rv.lo * k_, r_ + rv.hi * k_) : Interval::point(k_);
    f = widen(f, 4 * kEps * (std::fabs(r_) + (l == 0 ? maxNum(std::fabs(rv.lo), std::fabs(rv.hi)) : 0)
      * std::fabs(k_)));
    Box3 b = f * EBox(f_, ru, k);
    if (k == 0) b = b + (l == 0 ? scaled({rv.lo, rv.hi}, f_.z) : pointBox(f_.z));
    out = k == 0 && l == 0 ? shifted(b, f_.o) : b;
    return Status::ok;
  }
  void singularities(std::vector<Singularity>& out) const override {
    out.clear();
    if (k_ != 0) out.push_back({Singularity::apex, false, apex(), f_.o + apex() * f_.z});
  }
  bool lineClosedForm(Vec3 o, Vec3 ud, double sLo, double sHi, Range ru, Range rv, double tol,
    LineIntersection& out) const override {
    // In a meridian plane the surface is the generator rho = |r + k h| (h = v, the axial coordinate), a point's
    // distance from it |phi| / sqrt(1 + k^2) with phi = rho - |r + k h|. Along the line rho is convex and h linear, so
    // phi is convex on each side of the apex's height (its least value by golden section, the most at the ends):
    // - within T = tol sqrt(1 + k^2) all along: the segment lies in the surface, an overlap;
    // - a cylinder's (phi exactly the distance there): more than tol out all along, or more than tol in, no contact.
    // Anything else is searched (on a cone near its apex the other nappe is nearer than phi says).
    const Vec3 q = o - f_.o;
    const double h0 = dot(q, f_.z), hd = dot(ud, f_.z);
    const Vec3 c0 = q - h0 * f_.z, cd = ud - hd * f_.z;
    auto phi = [&](double s) { return norm(c0 + s * cd) - std::fabs(r_ + k_ * (h0 + s * hd)); };
    const double T = tol * std::sqrt(1 + k_ * k_);
    const double r = 16 * kEps * (norm(q) + maxNum(std::fabs(sLo), std::fabs(sHi)) + std::fabs(r_));
    std::vector<double> cuts{sLo};
    if (k_ != 0 && hd != 0) {
      const double sa = (apex() - h0) / hd;
      if (sa > sLo && sa < sHi) cuts.push_back(sa);
    }
    cuts.push_back(sHi);
    double least = kInf, most = -kInf;
    for (size_t i = 0; i + 1 < cuts.size(); i++) {
      double lo = cuts[i], hi = cuts[i + 1];
      most = maxNum(most, maxNum(phi(lo), phi(hi)));
      least = minNum(least, minNum(phi(lo), phi(hi)));
      const double g = 0.6180339887498949;
      double a = hi - g * (hi - lo), b = lo + g * (hi - lo), fa = phi(a), fb = phi(b);
      for (int it = 0; it < 200 && hi - lo > 1e-13 * (std::fabs(lo) + std::fabs(hi) + 1); it++) {
        if (fa < fb) hi = b, b = a, fb = fa, a = hi - g * (hi - lo), fa = phi(a);
        else lo = a, a = b, fa = fb, b = lo + g * (hi - lo), fb = phi(b);
      }
      least = minNum(least, phi(0.5 * lo + 0.5 * hi));
    }
    out = LineIntersection{};
    out.status = Status::ok;
    if (k_ == 0 && (least > tol + r || most < -tol - r)) return true;
    if (!(least >= -T - r && most <= T + r)) return false;
    // v = h is linear along the line; u, the angle in the meridian plane (turned by pi past the apex), nearly
    // constant: the segment kept where v is in rv, u judged at its middle.
    Range sv = linearIn(h0, hd, rv, sLo, sHi);
    if (sv.lo <= sv.hi) {
      const double sm = 0.5 * sv.lo + 0.5 * sv.hi, hm = h0 + sm * hd;
      const Vec3 cm = c0 + sm * cd;
      double u = std::atan2(dot(cm, f_.y), dot(cm, f_.x));
      if (r_ + k_ * hm < 0) u += kPi;
      u = ru.lo + reduce(u - ru.lo, kTwoPi);
      if (u <= ru.hi) out.overlaps.push_back(sv);
    }
    return true;
  }
  void within(Vec3 p, double d, Range& ru, Range& rv) const override {
    // The axial coordinate of S is v: |S - p| >= |v - (p - o) . z|.
    double c = dot(p - f_.o, f_.z), e = d * (1 + 1e-12) + 4 * kEps * norm(p - f_.o);
    ru = {0, kTwoPi}, rv = {c - e, c + e};
  }
  bool footCandidates(Vec3 p, Range ru, Range rv, double tol, std::vector<Vec2>& out) const override {
    if (!whole(ru, kTwoPi)) return false;
    out.clear();
    Vec3 q = p - f_.o;
    double qx = dot(q, f_.x), qy = dot(q, f_.y), z = dot(q, f_.z), rho = std::hypot(qx, qy);
    double up = std::atan2(qy, qx);
    auto keep = [&](double u, double v) { out.push_back({reduce(u - ru.lo, kTwoPi) + ru.lo, v}); };
    if (k_ == 0) {
      // A cylinder: the generator at the point's angle; on the axis every angle.
      double v = std::clamp(z, rv.lo, rv.hi);
      if (rho <= 1e-15 * (r_ + std::fabs(z))) ring(v, out);
      else keep(up, v);
      return true;
    }
    // In the meridian plane, coordinates (s along E(up), z): the generators (r + v k, v) at u = up and
    // (-(r + v k), v) at u = up + pi; each foot the projection onto its line, clamped to rv (the squared distance is
    // convex along it), kept where its radius puts it on the point's side (else it's a maximum in u); the apex too.
    double den = 1 + k_ * k_;
    double v1 = std::clamp((z + k_ * (rho - r_)) / den, rv.lo, rv.hi);
    double v2 = std::clamp((z - k_ * (rho + r_)) / den, rv.lo, rv.hi);
    bool axis = rho <= 1e-15 * (std::fabs(r_) + std::fabs(z) + 1);
    if (axis) {
      // Every angle: the feet are circles (the generator at u = 0 standing for them all), or the apex.
      if (r_ + v1 * k_ >= 0) ring(v1, out);
      if (r_ + v2 * k_ <= 0) ring(v2, out);
    } else {
      if (r_ + v1 * k_ >= 0) keep(up, v1);
      if (r_ + v2 * k_ <= 0) keep(up + kPi, v2);
    }
    double va = apex();
    if (va >= rv.lo && va <= rv.hi) keep(up, va);
    (void)tol;
    return true;
  }

  char footFamily(Vec3 p) const override {
    Vec3 q = p - f_.o;
    double z = dot(q, f_.z), rho = std::hypot(dot(q, f_.x), dot(q, f_.y));
    double axis = k_ == 0 ? 1e-15 * (r_ + std::fabs(z)) : 1e-15 * (std::fabs(r_) + std::fabs(z) + 1);
    return rho <= axis ? 'u' : 0;
  }

private:
  double apex() const { return -r_ / k_; }
  Frame f_;
  double r_, k_;
};

class Sphere final : public SurfaceImpl {
public:
  explicit Sphere(const double* r) : f_(readFrame(r)), R_(r[9]) {}
  SurfaceDomain domain() const override { return {{0, kTwoPi}, {-kHalfPi, kHalfPi}, kTwoPi, 0}; }
  Status derivs(double u, double v, int order, Vec3* out) const override {
    Status s = v < -kHalfPi || v > kHalfPi ? Status::outOfDomain : Status::ok;
    v = std::clamp(v, -kHalfPi, kHalfPi);
    for (int n = 0; n <= order; n++)
      for (int l = 0; l <= n; l++) {
        int k = n - l;
        Vec3 t = (R_ * trig(v, l, false)) * E(f_, u, k);
        if (k == 0) t = t + (R_ * trig(v, l, true)) * f_.z;
        out[pidx(k, l)] = t;
      }
    out[0] = out[0] + f_.o;
    return s;
  }
  Status normal(double u, double v, Vec3& out) const override {
    // The outward radial direction, a limit at the poles too (where S_u vanishes).
    v = std::clamp(v, -kHalfPi, kHalfPi);
    out = std::cos(v) * E(f_, u, 0) + std::sin(v) * f_.z;
    return std::fabs(v) == kHalfPi ? Status::singular : Status::ok;
  }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    us = {ru.lo, ru.hi}, vs = {rv.lo, rv.hi};
  }
  Status derivBox(Range ru, Range rv, int k, int l, Box3& out) const override {
    rv = {maxNum(rv.lo, -kHalfPi), minNum(rv.hi, kHalfPi)};
    Interval R = Interval::point(R_);
    Box3 b = (R * trigRange(rv, l, false)) * EBox(f_, ru, k);
    if (k == 0) b = b + scaled(R * trigRange(rv, l, true), f_.z);
    out = k == 0 && l == 0 ? shifted(b, f_.o) : b;
    return Status::ok;
  }
  void singularities(std::vector<Singularity>& out) const override {
    out = {{Singularity::pole, false, -kHalfPi, f_.o - R_ * f_.z}, {Singularity::pole, false, kHalfPi,
      f_.o + R_ * f_.z}};
  }
  bool footCandidates(Vec3 p, Range ru, Range rv, double, std::vector<Vec2>& out) const override {
    if (!whole(ru, kTwoPi)) return false;
    out.clear();
    Vec3 q = p - f_.o;
    double qx = dot(q, f_.x), qy = dot(q, f_.y), z = dot(q, f_.z), rho = std::hypot(qx, qy);
    if (norm(q) <= 1e-15 * R_) {
      // The centre: every point. Samples over the sphere.
      for (double v : {-kHalfPi / 2, 0.0, kHalfPi / 2}) ring(v, out, 4);
      out.push_back({0, kHalfPi}), out.push_back({0, -kHalfPi});
      return true;
    }
    double v = std::atan2(z, rho);
    if (v < rv.lo || v > rv.hi) return false;
    // On the axis the pole: u arbitrary (0).
    out.push_back({rho == 0 ? ru.lo : reduce(std::atan2(qy, qx) - ru.lo, kTwoPi) + ru.lo, v});
    return true;
  }

private:
  Frame f_;
  double R_;
};

/** o + (R + r cos v) E(u) + r sin v z; a spindle torus (R < r) crosses its axis where R + r cos v = 0. */
class Torus final : public SurfaceImpl {
public:
  explicit Torus(const double* r) : f_(readFrame(r)), R_(r[9]), r_(r[10]) {}
  SurfaceDomain domain() const override { return {{0, kTwoPi}, {0, kTwoPi}, kTwoPi, kTwoPi}; }
  Status derivs(double u, double v, int order, Vec3* out) const override {
    for (int n = 0; n <= order; n++)
      for (int l = 0; l <= n; l++) {
        int k = n - l;
        Vec3 t = ((l == 0 ? R_ : 0) + r_ * trig(v, l, false)) * E(f_, u, k);
        if (k == 0) t = t + (r_ * trig(v, l, true)) * f_.z;
        out[pidx(k, l)] = t;
      }
    out[0] = out[0] + f_.o;
    return Status::ok;
  }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    us = {ru.lo, ru.hi}, vs = {rv.lo, rv.hi};
  }
  Status derivBox(Range ru, Range rv, int k, int l, Box3& out) const override {
    Interval f = Interval::point(r_) * trigRange(rv, l, false);
    if (l == 0) f = f + Interval::point(R_);
    Box3 b = widen(f, 4 * kEps * (R_ + r_)) * EBox(f_, ru, k);
    if (k == 0) b = b + scaled(Interval::point(r_) * trigRange(rv, l, true), f_.z);
    out = k == 0 && l == 0 ? shifted(b, f_.o) : b;
    return Status::ok;
  }
  void singularities(std::vector<Singularity>& out) const override {
    out.clear();
    if (!(R_ <= r_)) return;
    // R + r cos v = 0: the tube crosses the axis (a horn torus, R = r, touches it once, at v = pi).
    double a = std::acos(-R_ / r_);
    for (double v : R_ == r_ ? std::vector<double>{kPi} : std::vector<double>{a, kTwoPi - a})
      out.push_back({Singularity::apex, false, v, f_.o + (r_ * std::sin(v)) * f_.z});
  }
  bool footCandidates(Vec3 p, Range ru, Range rv, double, std::vector<Vec2>& out) const override {
    if (!whole(ru, kTwoPi) || !whole(rv, kTwoPi)) return false;
    out.clear();
    Vec3 q = p - f_.o;
    double qx = dot(q, f_.x), qy = dot(q, f_.y), z = dot(q, f_.z), rho = std::hypot(qx, qy);
    auto V = [&](double v) { return reduce(v - rv.lo, kTwoPi) + rv.lo; };
    auto U = [&](double u) { return reduce(u - ru.lo, kTwoPi) + ru.lo; };
    double size = R_ + r_ + std::fabs(z);
    if (rho <= 1e-15 * size) {
      // On the axis: the point (0, z) of the meridian plane against the tube circle about (R, 0); every u.
      double v = std::atan2(z, -R_);
      if (std::hypot(R_, z) <= 1e-15 * size) {
        for (int j = 0; j < 8; j++) ring(kTwoPi * j / 8, out, 4);
      } else {
        ring(V(v), out);
      }
      return true;
    }
    double up = std::atan2(qy, qx);
    // At u = up the tube circle about (R, 0) of the meridian plane, the point at (rho, z); at u = up + pi the circle
    // about (R, 0) seen from (-rho, z). Each nearest point kept where R + r cos v puts it on the point's side.
    if (std::hypot(rho - R_, z) <= 1e-15 * size) {
      for (int j = 0; j < 8; j++) out.push_back({U(up), V(kTwoPi * j / 8)});
    } else {
      double v1 = std::atan2(z, rho - R_);
      if (R_ + r_ * std::cos(v1) >= 0) out.push_back({U(up), V(v1)});
    }
    double v2 = std::atan2(z, -rho - R_);
    if (R_ + r_ * std::cos(v2) <= 0) out.push_back({U(up + kPi), V(v2)});
    // Where the tube crosses the axis, the apex points (the nearest axis point of the surface).
    std::vector<Singularity> s;
    singularities(s);
    for (const Singularity& g : s) out.push_back({U(up), V(g.at)});
    return true;
  }
  char footFamily(Vec3 p) const override {
    Vec3 q = p - f_.o;
    double z = dot(q, f_.z), rho = std::hypot(dot(q, f_.x), dot(q, f_.y)), size = R_ + r_ + std::fabs(z);
    if (rho <= 1e-15 * size) return std::hypot(R_, z) <= 1e-15 * size ? 0 : 'u';
    return std::hypot(rho - R_, z) <= 1e-15 * size ? 'v' : 0;
  }

private:
  Frame f_;
  double R_, r_;
};

} // namespace

std::unique_ptr<SurfaceImpl> makePlane(const double* r) { return std::make_unique<Plane>(r); }
std::unique_ptr<SurfaceImpl> makeCone(const double* r, double radius, double k) {
  return std::make_unique<Cone>(r, radius, k);
}
std::unique_ptr<SurfaceImpl> makeSphere(const double* r) { return std::make_unique<Sphere>(r); }
std::unique_ptr<SurfaceImpl> makeTorus(const double* r) { return std::make_unique<Torus>(r); }

} // namespace surfaces
} // namespace cadgeom
