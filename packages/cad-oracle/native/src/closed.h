// Integrals over faces on planes, cylinders, cones, spheres and tori by Green's theorem in the surface's (u, v): the
// integral of F du dv over the face is oint H du with dH/dv = -F. The boundary is each edge's 3D curve between its
// vertices' parameters (the face API's edgeParams), each point mapped to (u, v) by the surface's closed-form inverse
// and du/dt by the chain rule from the curve's derivative, so u is never unwrapped and a loop winding the axis needs
// nothing of its own. Each edge's integral is adaptive Gauss-Kronrod per span of its curve (the error the quadrature's
// estimate). At a joint the loop runs straight in (u, v) from one edge's end to the next's start: zero where they meet,
// the pole row at a sphere's pole or a cone's apex, where u is the limit along each edge's tangent. H is zero at a
// cone's apex and at the sphere's pole each edge comes nearer (its north or south: near a pole u' is the rounding of x
// y' - y x' over the squared distance from the axis, which only H zero there keeps integrable); at the other the jump
// in u is ambiguous by 2 pi, which changes the sum by the integral over the whole sphere, so spheres' results are
// reduced modulo it (by the area's). A torus's v is unwrapped along each loop against samples of it (H isn't periodic
// in v), each loop by itself, so where a loop winds u the result is known modulo the whole torus's integral and is
// reduced modulo it like a sphere's (ClosedTotals::windsU); a loop winding v is flagged (flagWinds). A plane's frame
// is moved to the face's first edge point (closedFace), so a small face far from its plane's origin neither cancels in
// H nor rounds in its points. The area (area_closed.cpp) and other integrands (integral.cpp) differ only in H.
#pragma once

#include <cmath>
#include <functional>
#include <vector>

#include "oracle_impl.h"

namespace cadoracle {

using cadgeom::CurvePoint;

constexpr double kTwoPi = 2 * M_PI;
/**
 * A point within this of the axis, relative to the radius (a cone's: its extent from its origin to its apex), is the
 * pole or apex: a thin cone's radius at v = 0 is no scale for its points (cnc-box-ap242.step #92's spikes, apex
 * vertices 2-4e-9 off the axis, would otherwise get a u of their own).
 */
constexpr double kSamePoint = 1e-9;
/** Samples per span of an edge's curve where it's searched for crossings of a sphere's axis. */
constexpr int kCrossingSamples = 32;
/** Points per edge for the loops' size (a closed edge's ends are one point). */
constexpr int kSizeSamples = 8;
/** A torus's v sampled this many times per span of an edge's curve, to unwrap it along a loop. */
constexpr int kUnwrapSamples = 16;

inline double wrapAngle(double d) { return d - kTwoPi * std::round(d / kTwoPi); }

/** An elementary surface: its frame and numbers, (u, v) of points, and the surface at (u, v), all in closed form. */
struct Elementary {
  int kind = 0;
  Vec3 o, x, y, z;
  /** Cylinder, sphere: the radius; cone: the radius at v = 0 and the semi-angle; torus: R, r. */
  double a = 0, b = 0, tanB = 0, sinB = 0;

  Vec3 local(Vec3 p) const {
    Vec3 q = p - o;
    return {dot(q, x), dot(q, y), dot(q, z)};
  }
  Vec3 dir(Vec3 d) const { return {dot(d, x), dot(d, y), dot(d, z)}; }
  bool periodicU() const { return kind != CBR_SURFACE_PLANE; }
  bool atPole(Vec3 q) const {
    const double rho = std::hypot(q.x, q.y);
    if (kind == CBR_SURFACE_CONE) return rho < kSamePoint * (1 + std::fabs(a) + std::fabs(a / tanB));
    if (kind == CBR_SURFACE_SPHERE) return rho < kSamePoint * a;
    return false;
  }
  /** v where H is zero: a cone's apex, a sphere's pole (south or north), else 0. */
  double vZero(bool south) const {
    switch (kind) {
      case CBR_SURFACE_CONE: return -a / tanB;
      case CBR_SURFACE_SPHERE: return south ? -M_PI / 2 : M_PI / 2;
      default: return 0;
    }
  }
  /**
   * (u, v) of the local point q, and their rates along the local direction dq. u is the angle of q about the axis:
   * on a cone's far nappe (rho < 0) the surface's own u is that plus pi (eval's `u` takes this one).
   */
  void uv(Vec3 q, Vec3 dq, double& u, double& v, double& du, double& dv) const {
    if (kind == CBR_SURFACE_PLANE) {
      u = q.x, v = q.y, du = dq.x, dv = dq.y;
      return;
    }
    const double r2 = q.x * q.x + q.y * q.y, rho = std::sqrt(r2);
    u = std::atan2(q.y, q.x);
    du = r2 > 0 ? (q.x * dq.y - q.y * dq.x) / r2 : 0;
    const double drho = rho > 0 ? (q.x * dq.x + q.y * dq.y) / rho : 0;
    if (kind == CBR_SURFACE_CYLINDER || kind == CBR_SURFACE_CONE) {
      v = q.z, dv = dq.z;
    } else {
      const double w = kind == CBR_SURFACE_SPHERE ? rho : rho - a, d = w * w + q.z * q.z;
      v = std::atan2(q.z, w), dv = d > 0 ? (w * dq.z - q.z * drho) / d : 0;
    }
  }
  /**
   * The surface at uv()'s (u, v), in model coordinates: the point and S_u x S_v in the surface's own
   * parameterization (its orientation, whatever the sign of a cone's rho).
   */
  void eval(double u, double v, Vec3& p, Vec3& n) const {
    const Vec3 X = x, Y = y, Z = z;
    if (kind == CBR_SURFACE_PLANE) {
      p = o + u * X + v * Y, n = cross(X, Y);
      return;
    }
    auto radial = [&](double w) { return std::cos(w) * X + std::sin(w) * Y; };
    auto tangent = [&](double w) { return -std::sin(w) * X + std::cos(w) * Y; };
    Vec3 su, sv;
    switch (kind) {
      case CBR_SURFACE_CYLINDER:
        p = o + a * radial(u) + v * Z, su = a * tangent(u), sv = Z;
        break;
      case CBR_SURFACE_CONE: {
        const double rho = a + v * tanB, w = rho < 0 ? u + M_PI : u;
        p = o + rho * radial(w) + v * Z, su = rho * tangent(w), sv = tanB * radial(w) + Z;
        break;
      }
      case CBR_SURFACE_SPHERE:
        p = o + a * std::cos(v) * radial(u) + a * std::sin(v) * Z, su = a * std::cos(v) * tangent(u);
        sv = -a * std::sin(v) * radial(u) + a * std::cos(v) * Z;
        break;
      default:
        p = o + (a + b * std::cos(v)) * radial(u) + b * std::sin(v) * Z, su = (a + b * std::cos(v)) * tangent(u);
        sv = -b * std::sin(v) * radial(u) + b * std::cos(v) * Z;
    }
    n = cross(su, sv);
  }
  /** The local point's distance from the surface (a cone's both nappes). */
  double off(Vec3 q) const {
    switch (kind) {
      case CBR_SURFACE_PLANE: return std::fabs(q.z);
      case CBR_SURFACE_CYLINDER: return std::fabs(std::hypot(q.x, q.y) - a);
      case CBR_SURFACE_CONE: {
        const double h = std::hypot(q.x, q.y), zz = q.z + a / tanB, c = std::cos(b);
        return std::fmin(std::fabs(h * c - zz * sinB), std::fabs(h * c + zz * sinB));
      }
      case CBR_SURFACE_SPHERE: return std::fabs(norm(q) - a);
      default: return std::fabs(std::hypot(std::hypot(q.x, q.y) - a, q.z) - b);
    }
  }
};

/** An edge of a loop as it's run: its curve from ta to tb, for the coedge `coedge` (a sphere's cut into several). */
struct Run {
  const Curve* curve;
  double ta, tb;
  int coedge = -1;
};

/** A face on an elementary surface, as the engine takes it: its surface and its edge loops as runs. */
struct ClosedFace {
  Elementary E;
  std::vector<std::vector<Run>> loops;
  /** Where the face can't be taken (static storage); empty when it can. */
  const char* why = "";
};

/**
 * The face's surface and loops (each edge's run split where it crosses a sphere's axis, so the jump in u there is a
 * joint's), or why not.
 */
ClosedFace closedFace(Oracle::Impl& I, int face);

/**
 * H over the face, K components: H(u, v, south, out) with dH/dv = -F (south: on a sphere, zero at its south pole,
 * else at its north; elsewhere ignored); meridian(ua, ub, out) adds int_{ua}^{ub} (H_N - H_S)(u) du (spheres only:
 * how a run integrated on the south's H gets the north's).
 */
struct Antiderivative {
  int k = 1;
  std::function<void(double u, double v, bool south, double* out)> H;
  std::function<void(double ua, double ub, double* out)> meridian;
  /** Per component, a floor for the scale each run's absolute tolerance is set from (the area's: the box's area). */
  std::vector<double> floor;
};

/** The engine's totals, signed as the loops run in (u, v) (the face's sense not applied), with what it measured. */
struct ClosedTotals {
  std::vector<double> value, error;
  Status status = Status::ok;
  uint32_t flags = 0;
  /** The largest distance of a loop's point from the surface, over the loops' size. */
  double offSurface = 0;
  /** Per run, in the loops' order: its coedge and the largest distance of its sampled points from the surface. */
  std::vector<std::pair<int, double>> runOff;
  /**
   * A torus's loop winds its u: each loop's v is unwrapped by itself, so such a loop may sit a turn of v off the
   * others, which moves the result by whole multiples of the whole torus's integral (callers reduce modulo it).
   */
  bool windsU = false;
  /**
   * A torus's loops, in order: the whole turns of v each winds, and u at its start (where its v is unwrapped from):
   * a loop winding v takes the seam's term (seamTerm).
   */
  std::vector<double> loopWindV, loopStartU;
};

ClosedTotals closedIntegral(const ClosedFace& face, const Antiderivative& A, double relTol);

} // namespace cadoracle
