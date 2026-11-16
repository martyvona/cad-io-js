// The exact table: p-curves in closed form, from the model's rows (PcurveSource). On a plane, every curve: the plane's
// (u, v) is an affine map of 3D (Part 42's PLANE: S(u, v) = o + u x + v y), so a line, conic, B-spline or polyline maps
// by its points, directions and control points (weights, knots kept) and stays the same kind with the same
// parameter, a conic only where it runs counterclockwise in (u, v) (a 2D placement's y is its x turned +90 degrees);
// other kinds are their 3D curve mapped (kind 0). On a cylinder, cone, sphere or torus (their Part 42
// parameterizations, docs/brep-reference.md): a circle coaxial with the surface is u = phase +/- t at fixed v, a line
// along a cylinder's or cone's generatrix and a meridian circle of a sphere or torus fixed u, linear v; each detected
// within the tolerance, then verified against the curve (project.cpp's measure), and left to tracing where that fails.
// A cone's generatrix through its apex and a sphere's meridian over a pole change u there, and are left to tracing,
// which splits at them.
#include <algorithm>
#include <cmath>

#include "cad_brep.h"
#include "project_impl.h"

namespace cadgeom {
namespace project {

namespace {

struct Frame {
  Vec3 o, z, x, y;
};
Vec3 read3(const double* r) { return {r[0], r[1], r[2]}; }
Frame frameOf(const double* r) {
  Frame f{read3(r), read3(r + 3), read3(r + 6), {}};
  f.y = cross(f.z, f.x);
  return f;
}
Vec3 unit(Vec3 v) {
  const double n = norm(v);
  return n > 0 ? (1 / n) * v : v;
}


/** One exact piece as the result: measured, its status by the error (the feet's, so the curve's own distance). */
bool finish(const Job& job, Pcurve& out, PcurvePiece piece, PcurveMethod method, bool keepOnFailure) {
  if (!piece.curve) return false;
  piece.certainty = Certainty::unique;
  piece.error = measure(job, piece);
  if (!(piece.error <= job.tol) && !keepOnFailure) return false;
  out.method = method;
  out.certainty = Certainty::unique;
  out.offSurface = piece.error;
  out.error = piece.error;
  out.status = piece.error <= job.tol ? Status::ok : Status::invalidModel;
  out.pieces.clear();
  out.pieces.push_back(std::move(piece));
  return true;
}

bool onPlane(const Job& job, const Form& cf, const Frame& f, Pcurve& out) {
  PcurvePiece p;
  p.t = job.r;
  auto uv = [&](Vec3 q) { return Vec2{dot(q - f.o, f.x), dot(q - f.o, f.y)}; };
  auto vec2 = [&](Vec3 d) { return Vec2{dot(d, f.x), dot(d, f.y)}; };
  const int kind = cf.dim == 3 ? cf.kind : -1;
  const double* r = cf.reals;
  const int32_t* in = cf.ints;
  bool conic = kind == CBR_CURVE_CIRCLE || kind == CBR_CURVE_ELLIPSE || kind == CBR_CURVE_HYPERBOLA
    || kind == CBR_CURVE_PARABOLA;
  if (kind == CBR_CURVE_LINE) {
    const Vec2 a = uv(read3(r)), d = vec2(read3(r + 3));
    const double n = norm(d);
    if (n > 0) {
      p.kind = CBR_CURVE_LINE;
      p.reals = {a.x, a.y, d.x / n, d.y / n, r[6] * n};
    }
  } else if (conic && dot(read3(r + 3), f.z) > 0) {
    // Counterclockwise in (u, v): the 2D placement's x is the 3D one's image, its y the image of y = axis x x.
    const Vec2 o = uv(read3(r)), x = vec2(read3(r + 6));
    const double n = norm(x);
    if (n > 0) {
      p.kind = kind;
      p.reals = {o.x, o.y, x.x / n, x.y / n};
      const int extra = kind == CBR_CURVE_CIRCLE || kind == CBR_CURVE_PARABOLA ? 1 : 2;
      for (int i = 0; i < extra; i++) p.reals.push_back(r[9 + i]);
    }
  } else if (kind == CBR_CURVE_BSPLINE) {
    const int n = in[1], k = in[2];
    const bool rational = in[3] != 0;
    p.kind = CBR_CURVE_BSPLINE;
    p.ints.assign(in, in + 7 + k);
    p.reals.assign(r, r + k);
    for (int i = 0; i < n; i++) {
      const Vec2 q = uv(read3(r + k + 3 * i));
      p.reals.push_back(q.x), p.reals.push_back(q.y);
    }
    if (rational) p.reals.insert(p.reals.end(), r + k + 3 * n, r + k + 4 * n);
  } else if (kind == CBR_CURVE_POLYLINE) {
    p.kind = CBR_CURVE_POLYLINE;
    p.ints = {in[0]};
    for (int i = 0; i < in[0]; i++) {
      const Vec2 q = uv(read3(r + 3 * i));
      p.reals.push_back(q.x), p.reals.push_back(q.y);
    }
  }
  std::shared_ptr<const Curve> basis;
  if (p.reals.empty()) {
    // Any other kind (a clockwise conic, an offset, a composite): the 3D curve mapped (viewed, not owned: project.h).
    basis = std::shared_ptr<const Curve>(&job.c, [](const Curve*) {});
    p.kind = 0;
    const double a[9] = {f.x.x, f.x.y, f.x.z, f.y.x, f.y.y, f.y.z, f.o.x, f.o.y, f.o.z};
    std::copy(a, a + 9, p.affine);
    p.reals.clear(), p.ints.clear();
  }
  if (!build(p, basis)) return false;
  // The map is the orthogonal projection onto the plane: the feet themselves, so an error past tol is the curve
  // leaving the plane, which no other p-curve can mend.
  return finish(job, out, std::move(p), PcurveMethod::planeAffine, true);
}

/** Elementary iso-lines. */
bool isoLine(const Job& job, const Form& cform, int skind, const double* sr, Pcurve& out) {
  const Frame f = frameOf(sr);
  const int ck = cform.dim == 3 ? cform.kind : -1;
  const double* cr = cform.reals;
  const double tol = job.tol;
  auto radial = [&](Vec3 q) { return (q - f.o) - dot(q - f.o, f.z) * f.z; };
  auto angle = [&](Vec3 d) { return std::atan2(dot(d, f.y), dot(d, f.x)); };
  const double R = sr[9];
  if (ck == CBR_CURVE_CIRCLE) {
    const Frame cf = frameOf(cr);
    const double rc = cr[9];
    const Vec3 c = cf.o;
    // Coaxial: the axes parallel (a tilt of theta moves the circle's points by up to r theta) and the centre on the
    // surface's axis.
    if (rc * norm(cross(cf.z, f.z)) <= tol && norm(radial(c)) <= tol) {
      const double h = dot(c - f.o, f.z), s = dot(cf.z, f.z) > 0 ? 1 : -1;
      double phase = angle(cf.x), v0 = 0;
      bool fits = false;
      if (skind == CBR_SURFACE_CYLINDER) {
        fits = std::fabs(rc - R) <= tol, v0 = h;
      } else if (skind == CBR_SURFACE_CONE) {
        const double rho = R + h * std::tan(sr[10]);
        fits = std::fabs(std::fabs(rho) - rc) <= tol, v0 = h;
        if (rho < 0) phase += kPi;  // the other nappe: the surface's points there are at u + pi
      } else if (skind == CBR_SURFACE_SPHERE) {
        fits = std::fabs(std::hypot(h, rc) - R) <= tol, v0 = std::atan2(h, rc);
      } else if (skind == CBR_SURFACE_TORUS) {
        fits = std::fabs(std::hypot(h, rc - R) - sr[10]) <= tol, v0 = std::atan2(h, rc - R);
      }
      if (fits) {
        PcurvePiece p = linePiece(job.r, {phase + s * job.r.lo, v0}, {s, 0});
        if (finish(job, out, std::move(p), PcurveMethod::isoLine, false)) return true;
      }
    }
    // Meridians: a sphere's great circle through its poles, a torus's tube circle in a plane through the axis.
    if ((skind == CBR_SURFACE_SPHERE || skind == CBR_SURFACE_TORUS) && R * std::fabs(dot(cf.z, f.z)) <= tol) {
      const bool sphere = skind == CBR_SURFACE_SPHERE;
      Vec3 e = sphere ? unit(cross(f.z, cf.z)) : unit(radial(c));
      const double want = sphere ? R : sr[10];
      const bool placed = sphere ? norm(c - f.o) <= tol : std::fabs(dot(c - f.o, f.z)) <= tol
        && std::fabs(norm(radial(c)) - R) <= tol && norm(cross(cf.z, cross(e, f.z))) * rc <= tol;
      if (placed && std::fabs(rc - want) <= tol) {
        // In the plane's frame (e, z): the circle's angle from e is delta + s t.
        const double s = dot(cf.z, cross(e, f.z)) > 0 ? 1 : -1, delta = std::atan2(dot(cf.x, f.z), dot(cf.x, e));
        double u0 = angle(e);
        double th0 = delta + s * job.r.lo, vs = 1;
        if (sphere) {
          // The half the range's middle is on: in front (u0, latitude theta) or behind (u0 + pi, pi - theta).
          const double mid = delta + s * 0.5 * (job.r.lo + job.r.hi);
          const double k = std::floor((mid + 0.5 * kPi) / kTwoPi);
          th0 -= k * kTwoPi;
          const double m0 = mid - k * kTwoPi;
          if (m0 > 0.5 * kPi) u0 += kPi, th0 = kPi - th0, vs = -1;
          const double a = th0, b = th0 + vs * s * (job.r.hi - job.r.lo);
          const double slack = 1e-12;
          if (std::min(a, b) < -0.5 * kPi - slack || std::max(a, b) > 0.5 * kPi + slack) return false;  // over a pole
        }
        PcurvePiece p = linePiece(job.r, {u0, th0}, {0, vs * s});
        if (finish(job, out, std::move(p), PcurveMethod::isoLine, false)) return true;
      }
    }
    return false;
  }
  if (ck == CBR_CURVE_LINE && (skind == CBR_SURFACE_CYLINDER || skind == CBR_SURFACE_CONE)) {
    const Vec3 lp = read3(cr), ld = read3(cr + 3);
    const double mag = cr[6];
    const double dz = dot(ld, f.z) * mag;
    if (!(std::fabs(dz) > 0)) return false;
    const double v0 = dot(lp - f.o, f.z) + job.r.lo * dz, v1 = v0 + (job.r.hi - job.r.lo) * dz;
    double u0;
    if (skind == CBR_SURFACE_CYLINDER) {
      u0 = angle(radial(lp + (0.5 * (job.r.lo + job.r.hi) * mag) * ld));
    } else {
      const double k = std::tan(sr[10]), apex = -R / k;
      // Not across the apex: there u turns by pi.
      if ((v0 - apex) * (v1 - apex) < 0) return false;
      const double vm = 0.5 * (v0 + v1);
      const Vec3 q = lp + (0.5 * (job.r.lo + job.r.hi) * mag) * ld;
      u0 = angle(radial(q));
      if (R + vm * k < 0) u0 += kPi;
    }
    PcurvePiece p = linePiece(job.r, {u0, v0}, {0, dz});
    return finish(job, out, std::move(p), PcurveMethod::isoLine, false);
  }
  return false;
}

} // namespace

bool exact(const Job& job, Pcurve& out) {
  const Form& sf = job.surfaceForm;
  if (!sf.reals) return false;
  if (sf.kind == CBR_SURFACE_PLANE) return onPlane(job, job.curveForm, frameOf(sf.reals), out);
  if (!job.curveForm.reals) return false;
  if (sf.kind == CBR_SURFACE_CYLINDER || sf.kind == CBR_SURFACE_CONE || sf.kind == CBR_SURFACE_SPHERE
    || sf.kind == CBR_SURFACE_TORUS)
    return isoLine(job, job.curveForm, sf.kind, sf.reals, out);
  return false;
}

} // namespace project
} // namespace cadgeom
