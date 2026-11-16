// project.h: every p-curve of the reference shapes at every variant (near, far, scaled, mirrored, moved) made again
// from its 3D curve, with the exact table and without it (tracing alone), and compared with the model's; curves
// traced against closed forms (a plane section of a cylinder, circles on a sphere through and past its poles) moved,
// turned and scaled; the exact table on every entry (opposite axes, a cone's other nappe, a sphere's far half, a
// torus's inner side, conics running either way on a plane) against each surface's closed-form inverse; the error
// measure against dense sampling; seams, the seam rule, known ends, a curve off its surface, a fold.
#include <cad_geom/project.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>

#include "../src/curve_impl.h"
#include "../src/project_impl.h"
#include "../src/surface_impl.h"
#include "brep_models.h"
#include "check.h"

using namespace cadgeom;

namespace {

constexpr double kPi = 3.141592653589793, kTwoPi = 6.283185307179586;

Vec2 uvAt(const PcurvePiece& p, double t) {
  if (p.poleLine || !p.curve) return p.from;
  CurvePoint q;
  p.curve->eval(t, 0, q);
  return {q.p.x, q.p.y};
}
/** The piece of `pieces` holding t (not a pole jump). */
const PcurvePiece* pieceAt(const std::vector<PcurvePiece>& pieces, double t) {
  for (const PcurvePiece& p : pieces)
    if (!p.poleLine && t >= p.t.lo && t <= p.t.hi) return &p;
  return nullptr;
}

/** A frame: rotation Q (columns), origin, scale; applied to points and directions given in the shape's own frame. */
struct Place {
  double Q[9];
  Vec3 T;
  double s;
  Vec3 dir(Vec3 v) const {
    return {Q[0] * v.x + Q[3] * v.y + Q[6] * v.z, Q[1] * v.x + Q[4] * v.y + Q[7] * v.z,
      Q[2] * v.x + Q[5] * v.y + Q[8] * v.z};
  }
  Vec3 point(Vec3 p) const { return T + s * dir(p); }
};
Place place(std::mt19937& rng, double scale, Vec3 T) {
  std::normal_distribution<double> n;
  double q[4] = {n(rng), n(rng), n(rng), n(rng)}, l = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  const double w = q[0] / l, x = q[1] / l, y = q[2] / l, z = q[3] / l;
  Place P{{1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 2 * (x * y - w * z),
            1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 2 * (x * z + w * y), 2 * (y * z - w * x),
            1 - 2 * (x * x + y * y)},
    T, scale};
  return P;
}
/** A placement's 9 reals (origin, axis, x) from the shape's frame through P. */
std::vector<double> frame(const Place& P, Vec3 o, Vec3 z, Vec3 x) {
  const Vec3 a = P.point(o), b = P.dir(z), c = P.dir(x);
  return {a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z};
}

} // namespace

TEST_CASE("reference shapes: every p-curve made again from its 3D curve, with the table and by tracing") {
  int compared = 0, exactCount = 0, tracedCount = 0, seamUses = 0;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    const Model m(ref.data, ref.size);
    REQUIRE(m.ok());
    const double tol = std::isfinite(m.uncertainty()) && m.uncertainty() > 0 ? m.uncertainty() : 1e-7 * ref.scale;
    struct SeamUse {
      int face, edge;
      bool twin;
      double at;
    };
    std::vector<SeamUse> seams;
    for (int f = 0; f < m.faces(); f++) {
      Status st;
      std::unique_ptr<Surface> s0 = makeSurface(m, m.faceSurface(f), st);
      if (!s0) continue;
      std::unique_ptr<Surface> s = closeInFact(std::move(s0), tol);
      const SurfaceDomain dom = s->domain();
      for (int l = m.faceFirstLoop(f); l < m.faceFirstLoop(f) + m.faceLoopCount(f); l++) {
        if (m.loopKind(l) != CBR_LOOP_EDGE) continue;
        for (int c = m.loopFirst(l); c < m.loopFirst(l) + m.loopCount(l); c++) {
          const int pc = m.coedgePcurve(c), e = m.coedgeEdge(c), ci = m.edgeCurve(e);
          if (pc < 0 || ci < 0) continue;
          const double* rg = m.f64(CBR_COEDGE_RANGE) + 2 * c;
          if (!std::isfinite(rg[0]) || !std::isfinite(rg[1])) continue;
          const Range r{std::fmin(rg[0], rg[1]), std::fmax(rg[0], rg[1])};
          std::unique_ptr<Curve> c3 = makeCurve(m, ci, st), p2 = makeCurve(m, pc, st);
          REQUIRE(c3 && p2);
          const PcurveSource src{&m, ci, m.faceSurface(f)};
          for (int withTable = 0; withTable < 2; withTable++) {
            const std::string where = std::string(ref.file) + " face " + std::to_string(f) + " coedge "
              + std::to_string(c) + (withTable ? " (table)" : " (traced)");
            Pcurve p = projectCurve(*c3, r, *s, tol, nullptr, withTable ? &src : nullptr);
            CHECK(p.status == Status::ok);
            CHECK(p.error <= tol);
            if (p.status != Status::ok) {
              std::printf("    %s: status %d method %d error %g tol %g\n", where.c_str(), static_cast<int>(p.status),
                static_cast<int>(p.method), p.error, tol);
              continue;
            }
            const int sk = m.surfaceKind(m.faceSurface(f));
            if (withTable && sk >= CBR_SURFACE_PLANE && sk <= CBR_SURFACE_TORUS) {
              // Every p-curve of these shapes on a plane or an elementary surface is in the table.
              CHECK(p.method == PcurveMethod::planeAffine || p.method == PcurveMethod::isoLine);
              if (p.method != PcurveMethod::planeAffine && p.method != PcurveMethod::isoLine)
                std::printf("    %s: method %d\n", where.c_str(), static_cast<int>(p.method));
              exactCount++;
            } else {
              tracedCount++;
            }
            // The model's p-curve, a whole number of periods apart, or the seam's other copy.
            bool matches = false;
            for (int sideIndex = 0; sideIndex < 2; sideIndex++) {
              const std::vector<PcurvePiece>* side = sideIndex == 0 ? &p.pieces : &p.seamTwin;
              if (side->empty()) continue;
              bool all = true;
              double du = 0, dv = 0;
              for (int k = 0; k <= 8 && all; k++) {
                const double t = r.lo + (r.hi - r.lo) * k / 8;
                const PcurvePiece* q = pieceAt(*side, t);
                if (!q) continue;
                CurvePoint w;
                p2->eval(t, 0, w);
                const Vec2 ours = uvAt(*q, t);
                if (k == 0) {
                  if (dom.uPeriod > 0) du = dom.uPeriod * std::round((w.p.x - ours.x) / dom.uPeriod);
                  if (dom.vPeriod > 0) dv = dom.vPeriod * std::round((w.p.y - ours.y) / dom.vPeriod);
                }
                SurfacePoint sp;
                s->eval(ours.x, ours.y, 1, sp);
                const double stretch = std::fmax(norm(sp.du), norm(sp.dv));
                const double uvt = 100 * tol / stretch + 1e-9;
                all = std::fabs(ours.x + du - w.p.x) <= uvt && std::fabs(ours.y + dv - w.p.y) <= uvt;
              }
              matches = matches || all;
            }
            CHECK(matches);
            if ((p.seamU || p.seamV) && withTable) {
              // The seam rule against the model's: of an edge's two uses by the face, the one it gives the higher
              // copy has the model's p-curve the higher (u for a seam in u).
              const bool forward = (m.coedgeOrientation(c) == 0) == m.edgeSameSense(e);
              CurvePoint w;
              p2->eval(0.5 * (r.lo + r.hi), 0, w);
              seams.push_back({f, e, seamUseTakesTwin(p, forward, m.faceSameSense(f)), p.seamU ? w.p.x : w.p.y});
            }
            if (!matches) std::printf("    %s: differs from the model's p-curve\n", where.c_str());
            compared++;
          }
        }
      }
    }
    for (size_t a = 0; a < seams.size(); a++)
      for (size_t b = a + 1; b < seams.size(); b++) {
        if (seams[a].face != seams[b].face || seams[a].edge != seams[b].edge) continue;
        CHECK(seams[a].twin != seams[b].twin);
        const SeamUse& hi = seams[a].twin ? seams[a] : seams[b];
        const SeamUse& lo = seams[a].twin ? seams[b] : seams[a];
        CHECK(hi.at > lo.at);
        if (!(hi.at > lo.at))
          std::printf("    %s face %d edge %d: the seam rule's copies the other way round\n", ref.file, hi.face,
            hi.edge);
        seamUses += 2;
      }
  }
  CHECK(compared > 400);
  CHECK(exactCount > 150);
  CHECK(tracedCount > 200);
  CHECK(seamUses > 40);
}

TEST_CASE("a plane section of a cylinder, traced, against its closed form, moved, turned and scaled") {
  std::mt19937 rng(7);
  for (double scale : {1e-3, 1.0, 1e3})
    for (Vec3 T : {Vec3{0, 0, 0}, Vec3{1e6, -2e6, 3e5}}) {
      const Place P = place(rng, scale, T);
      const double R = 2 * scale, th = 0.6, tol = std::fmax(1e-7 * scale, 1e-14 * norm(T));
      std::vector<double> sr = frame(P, {0, 0, 0}, {0, 0, 1}, {1, 0, 0});
      sr.push_back(R);
      std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr.data(), R, 0), tol);
      // The section by the plane through the origin with normal (sin th, 0, cos th): an ellipse with semi-axes
      // R / cos th along (cos th, 0, -sin th) and R along y; C(t) = (R cos t, R sin t, -R tan th cos t), so on the
      // cylinder u = t, v = -R tan th cos t.
      std::vector<double> er = frame(P, {0, 0, 0}, {std::sin(th), 0, std::cos(th)}, {std::cos(th), 0, -std::sin(th)});
      std::unique_ptr<Curve> el = curves::makeEllipse(er.data(), 3, R / std::cos(th), R);
      for (Range r : {Range{0, kTwoPi}, Range{0.3, 2.1}, Range{-1, 4}}) {
        Pcurve p = projectCurve(*el, r, *cyl, tol);
        if (p.status != Status::ok || p.certainty != Certainty::unique)
          std::printf("    scale %g T %g [%g, %g]: status %d certainty %d error %g off %g pieces %zu amb %zu %g\n",
            scale, T.x, r.lo, r.hi, static_cast<int>(p.status), static_cast<int>(p.certainty), p.error, p.offSurface,
            p.pieces.size(), p.tAmbiguous.size(), p.tAmbiguous.empty() ? 0.0 : p.tAmbiguous[0]);
        CHECK(p.status == Status::ok);
        CHECK(p.method == PcurveMethod::traced);
        CHECK(p.certainty == Certainty::unique);
        CHECK(p.error <= tol);
        REQUIRE(p.pieces.size() == 1);
        // u in the domain at the start, then continuous: t plus a constant number of periods.
        const Vec2 a = uvAt(p.pieces[0], r.lo);
        CHECK(a.x >= -1e-12 && a.x < kTwoPi);
        const double k = std::round((a.x - r.lo) / kTwoPi) * kTwoPi;
        for (int i = 0; i <= 64; i++) {
          const double t = r.lo + (r.hi - r.lo) * i / 64;
          const Vec2 q = uvAt(p.pieces[0], t);
          CHECK_NEAR(q.x, t + k, 0, 10 * tol / R);
          CHECK_NEAR(q.y, -R * std::tan(th) * std::cos(t), 0, 10 * tol);
        }
      }
    }
}

TEST_CASE("circles on a sphere: past the poles, through one, and a meridian through both") {
  std::mt19937 rng(11);
  for (double scale : {1e-3, 1.0, 1e3})
    for (Vec3 T : {Vec3{0, 0, 0}, Vec3{-4e5, 1e6, 2e6}}) {
      const Place P = place(rng, scale, T);
      const double R = 3 * scale, tol = std::fmax(1e-7 * scale, 1e-14 * norm(T));
      std::vector<double> sr = frame(P, {0, 0, 0}, {0, 0, 1}, {1, 0, 0});
      sr.push_back(R);
      std::unique_ptr<Surface> sph = closeInFact(surfaces::makeSphere(sr.data()), tol);
      const Vec3 o = P.point({0, 0, 0});
      // A circle of the plane at distance d from the centre with normal n tilted by `tilt` from the axis; it passes
      // through the north pole where d = R cos tilt. A meridian (tilt pi / 2) starts and ends at the south pole and
      // passes the north one.
      struct Case {
        double tilt, d;
        int poles;
      };
      for (Case cs : {Case{0.7, 0.5, 0}, Case{0.4, std::cos(0.4), 1}, Case{0.5 * kPi, 0, 1}}) {
        const Vec3 n{std::sin(cs.tilt), 0, std::cos(cs.tilt)}, x{std::cos(cs.tilt), 0, -std::sin(cs.tilt)};
        std::vector<double> cr = frame(P, (cs.d * R / scale) * n, n, x);
        const double rc = R * std::sqrt(1 - cs.d * cs.d);
        std::unique_ptr<Curve> circ = curves::makeEllipse(cr.data(), 3, rc, rc);
        const Range r{0, kTwoPi};
        Pcurve p = projectCurve(*circ, r, *sph, tol);
        const std::string where = "scale " + std::to_string(scale) + " tilt " + std::to_string(cs.tilt);
        CHECK(p.status == Status::ok);
        CHECK(p.error <= tol);
        int poles = 0;
        for (const PcurvePiece& q : p.pieces) {
          if (!q.poleLine) continue;
          poles++;
          CHECK_NEAR(std::fabs(q.from.y), 0.5 * kPi, 0, 1e-12);
          CHECK_NEAR(q.from.y, q.to.y, 0, 0);
          // Along the pole line to the nearer copy of the outgoing u: half a turn at most.
          CHECK(std::fabs(q.to.x - q.from.x) <= kPi + 1e-9);
        }
        CHECK_EQ(poles, cs.poles);
        if (cs.poles > 0) {
          // Started a turn on: the pieces after a pole follow the incoming u, not their seed's.
          PcurveEnds ends;
          ends.hasStart = true, ends.start = uvAt(p.pieces.front(), r.lo) + Vec2{2 * kTwoPi, 0};
          Pcurve q = projectCurve(*circ, r, *sph, tol, &ends);
          CHECK(q.status == Status::ok);
          for (const PcurvePiece& j : q.pieces)
            if (j.poleLine) CHECK(std::fabs(j.to.x - j.from.x) <= kPi + 1e-9);
        }
        if (poles != cs.poles || p.status != Status::ok)
          std::printf("    %s: status %d error %g pieces %zu poles %d\n", where.c_str(), static_cast<int>(p.status),
            p.error, p.pieces.size(), poles);
        // Every point's foot is the closed form's (latitude from the axis, longitude from x and y), within tol in 3D
        // (the longitude's error in radians grows towards the poles, where it matters less).
        for (int i = 0; i <= 40; i++) {
          const double t = r.lo + (r.hi - r.lo) * (i + 0.5) / 41;
          const PcurvePiece* q = pieceAt(p.pieces, t);
          REQUIRE(q);
          CurvePoint c;
          circ->eval(t, 0, c);
          const Vec3 d = c.p - o;
          const Vec3 ax = P.dir({0, 0, 1}), xx = P.dir({1, 0, 0}), yy = P.dir({0, 1, 0});
          const double lat = std::atan2(dot(d, ax), std::hypot(dot(d, xx), dot(d, yy)));
          const double lon = std::atan2(dot(d, yy), dot(d, xx));
          const Vec2 uv = uvAt(*q, t);
          CHECK_NEAR(uv.y, lat, 0, 10 * tol / R);
          CHECK_NEAR(R * std::cos(lat) * std::remainder(uv.x - lon, kTwoPi), 0, 0, 10 * tol);
        }
      }
    }
}

TEST_CASE("a generatrix on a cylinder's seam: both copies, and the seam rule") {
  const double R = 2, tol = 1e-7;
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, R};
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr, R, 0), tol);
  const double lr[7] = {R, 0, -1, 0, 0, 1, 1};
  std::unique_ptr<Curve> line = curves::makeLine(lr, 3);
  Pcurve p = projectCurve(*line, {0, 3}, *cyl, tol);
  CHECK(p.status == Status::ok);
  CHECK(p.method == PcurveMethod::affineFeet);
  CHECK(p.seamU);
  CHECK(!p.seamV);
  REQUIRE(p.pieces.size() == 1 && p.seamTwin.size() == 1);
  const Vec2 a = uvAt(p.pieces[0], 1), b = uvAt(p.seamTwin[0], 1);
  CHECK_NEAR(a.x, 0, 0, 1e-9);
  CHECK_NEAR(b.x, kTwoPi, 0, 1e-9);
  CHECK_NEAR(a.y, 0, 0, 1e-9);
  // Going up (+v) with the face's sense the surface's, the material is to the left (-u): below u = 2 pi, so the
  // higher copy; going down, the lower; a reversed face the other way round.
  CHECK(seamUseTakesTwin(p, true, true));
  CHECK(!seamUseTakesTwin(p, false, true));
  CHECK(!seamUseTakesTwin(p, true, false));
  CHECK(seamUseTakesTwin(p, false, false));
}

TEST_CASE("known ends: the unwrapping follows the start, and an end a period off is reported") {
  const double R = 2, tol = 1e-7;
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, R};
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr, R, 0), tol);
  // A circle at height 1, tilted so it isn't an iso-line: traced.
  const double th = 0.3;
  const double cr[9] = {0, 0, 1, std::sin(th), 0, std::cos(th), std::cos(th), 0, -std::sin(th)};
  std::unique_ptr<Curve> el = curves::makeEllipse(cr, 3, R / std::cos(th), R);
  PcurveEnds ends;
  ends.hasStart = true, ends.start = {kTwoPi, 1 - R * std::tan(th)};
  Pcurve p = projectCurve(*el, {0, kTwoPi}, *cyl, tol, &ends);
  CHECK(p.status == Status::ok);
  CHECK(p.certainty == Certainty::unique);
  REQUIRE(!p.pieces.empty());
  CHECK_NEAR(uvAt(p.pieces.front(), 0).x, kTwoPi, 0, 1e-9);
  CHECK_NEAR(uvAt(p.pieces.back(), kTwoPi).x, 2 * kTwoPi, 0, 1e-9);
  // The end said to be where it started, as if the curve didn't go round: ambiguous at the end.
  ends.hasEnd = true, ends.end = ends.start;
  Pcurve q = projectCurve(*el, {0, kTwoPi}, *cyl, tol, &ends);
  CHECK(q.certainty == Certainty::ambiguous);
  REQUIRE(!q.tAmbiguous.empty());
  CHECK_EQ(q.tAmbiguous.back(), kTwoPi);
}

TEST_CASE("a curve off its surface: invalidModel, its distance measured") {
  const double R = 2, tol = 1e-7;
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, R};
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr, R, 0), tol);
  const double th = 0.3;
  const double cr[9] = {0, 0, 1, std::sin(th), 0, std::cos(th), std::cos(th), 0, -std::sin(th)};
  std::unique_ptr<Curve> el = curves::makeEllipse(cr, 3, R / std::cos(th) + 1e-5, R + 1e-5);
  Pcurve p = projectCurve(*el, {0, 1}, *cyl, tol);
  CHECK(p.status == Status::invalidModel);
  CHECK(p.offSurface > 5e-6 && p.offSurface < 2e-5);
  CHECK(!p.pieces.empty());
}

TEST_CASE("bad arguments") {
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, 2};
  std::unique_ptr<Surface> cyl = surfaces::makeCone(sr, 2, 0);
  const double lr[7] = {2, 0, 0, 0, 0, 1, 1};
  std::unique_ptr<Curve> line = curves::makeLine(lr, 3);
  CHECK(projectCurve(*line, {1, 1}, *cyl, 1e-7).status == Status::invalidModel);
  CHECK(projectCurve(*line, {0, 1}, *cyl, 0).status == Status::invalidModel);
  CHECK(projectCurve(*line, {0, INFINITY}, *cyl, 1e-7).status == Status::invalidModel);
}

namespace {

/** The surface's (u, v) of a point on it, in closed form from its placement (an oracle independent of the table). */
Vec2 inverse(int kind, const std::vector<double>& sr, Vec3 p) {
  const Vec3 o{sr[0], sr[1], sr[2]}, z{sr[3], sr[4], sr[5]}, x{sr[6], sr[7], sr[8]}, y = cross(z, x), d = p - o;
  const double a = dot(d, x), b = dot(d, y), c = dot(d, z);
  switch (kind) {
  case CBR_SURFACE_PLANE: return {a, b};
  case CBR_SURFACE_CYLINDER: return {std::atan2(b, a), c};
  case CBR_SURFACE_CONE:
    return sr[9] + c * std::tan(sr[10]) < 0 ? Vec2{std::atan2(-b, -a), c} : Vec2{std::atan2(b, a), c};
  case CBR_SURFACE_SPHERE: return {std::atan2(b, a), std::atan2(c, std::hypot(a, b))};
  case CBR_SURFACE_TORUS: return {std::atan2(b, a), std::atan2(c, std::hypot(a, b) - sr[9])};
  }
  return {NAN, NAN};
}

std::unique_ptr<Surface> surfaceOf(int kind, const std::vector<double>& sr) {
  switch (kind) {
  case CBR_SURFACE_PLANE: return surfaces::makePlane(sr.data());
  case CBR_SURFACE_CYLINDER: return surfaces::makeCone(sr.data(), sr[9], 0);
  case CBR_SURFACE_CONE: return surfaces::makeCone(sr.data(), sr[9], std::tan(sr[10]));
  case CBR_SURFACE_SPHERE: return surfaces::makeSphere(sr.data());
  case CBR_SURFACE_TORUS: return surfaces::makeTorus(sr.data());
  }
  return nullptr;
}

std::unique_ptr<Curve> curveOf(int kind, const std::vector<double>& cr, const std::vector<int32_t>& ci) {
  Status st;
  switch (kind) {
  case CBR_CURVE_LINE: return curves::makeLine(cr.data(), 3);
  case CBR_CURVE_CIRCLE: return curves::makeEllipse(cr.data(), 3, cr[9], cr[9]);
  case CBR_CURVE_ELLIPSE: return curves::makeEllipse(cr.data(), 3, cr[9], cr[10]);
  case CBR_CURVE_HYPERBOLA: return curves::makeHyperbola(cr.data(), 3);
  case CBR_CURVE_PARABOLA: return curves::makeParabola(cr.data(), 3);
  case CBR_CURVE_BSPLINE: return curves::makeBSpline(cr.data(), ci.data(), 3, st);
  case CBR_CURVE_POLYLINE: return curves::makePolyline(cr.data(), ci[0], 3);
  }
  return nullptr;
}

struct TableCase {
  const char* name;
  int skind;
  std::vector<double> surface;  // in the shape's frame: placement (origin, axis, x) then the kind's reals
  int ckind;
  std::vector<double> curve;  // likewise: a placement or points first, as the kind's layout
  std::vector<int32_t> ints;
  Range r;
  PcurveMethod method;
  int kind2;  // the p-curve's kind expected (0: the 3D curve mapped)
};

/** The reals moved by P: `points` points first, then `dirs` directions, then lengths scaled (`lengths` of them). */
std::vector<double> moved(const Place& P, const std::vector<double>& v, int points, int dirs, int lengths) {
  std::vector<double> out = v;
  int i = 0;
  for (int k = 0; k < points; k++, i += 3) {
    const Vec3 q = P.point({v[i], v[i + 1], v[i + 2]});
    out[i] = q.x, out[i + 1] = q.y, out[i + 2] = q.z;
  }
  for (int k = 0; k < dirs; k++, i += 3) {
    const Vec3 q = P.dir({v[i], v[i + 1], v[i + 2]});
    out[i] = q.x, out[i + 1] = q.y, out[i + 2] = q.z;
  }
  for (int k = 0; k < lengths; k++, i++) out[i] *= P.s;
  return out;
}

} // namespace

TEST_CASE("the exact table: every entry, against the surfaces' closed-form inverses, moved, turned and scaled") {
  const double c3 = std::cos(0.3), s3 = std::sin(0.3), c7 = std::cos(0.7), s7 = std::sin(0.7);
  const double R = 2, a = 0.4, ta = std::tan(a);
  // Surfaces in their own frames; curves on them (placement origin, axis, x then radii; a line's point, direction,
  // magnitude; B-spline and polyline points).
  const std::vector<double> cyl{0, 0, 0, 0, 0, 1, 1, 0, 0, R}, cone{0, 0, 0, 0, 0, 1, 1, 0, 0, R, a},
    sph{0, 0, 0, 0, 0, 1, 1, 0, 0, R}, tor{0, 0, 0, 0, 0, 1, 1, 0, 0, R, 0.5}, pl{0, 0, 0, 0, 0, 1, 1, 0, 0};
  const double hs = 0.8, rs = std::sqrt(R * R - hs * hs);  // a parallel of the sphere
  const double ht = 0.5 * std::sin(0.9);                   // a torus parallel at v = 0.9 (outer) or pi - 0.9 (inner)
  const double vn = -2.0 * R / ta;                          // a height on the cone's other nappe: radius -R there
  const std::vector<TableCase> cases = {
    {"cylinder coaxial", CBR_SURFACE_CYLINDER, cyl, CBR_CURVE_CIRCLE, {0, 0, 1.5, 0, 0, 1, c3, s3, 0, R}, {},
      {0.7, 2.9}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"cylinder coaxial, axis opposite", CBR_SURFACE_CYLINDER, cyl, CBR_CURVE_CIRCLE,
      {0, 0, -1, 0, 0, -1, c7, s7, 0, R}, {}, {-1, 5.5}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"cylinder generatrix", CBR_SURFACE_CYLINDER, cyl, CBR_CURVE_LINE, {R * c3, R * s3, 0, 0, 0, -1, 2.5}, {},
      {0.5, 1.5}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"cone coaxial", CBR_SURFACE_CONE, cone, CBR_CURVE_CIRCLE, {0, 0, 1, 0, 0, 1, c3, s3, 0, R + ta}, {},
      {0.7, 2.9}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"cone coaxial, other nappe", CBR_SURFACE_CONE, cone, CBR_CURVE_CIRCLE, {0, 0, vn, 0, 0, -1, c3, s3, 0, R}, {},
      {0.2, 1.9}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"cone generatrix", CBR_SURFACE_CONE, cone, CBR_CURVE_LINE,
      {R * c3, R * s3, 0, ta * c3 / std::hypot(ta, 1), ta * s3 / std::hypot(ta, 1), 1 / std::hypot(ta, 1), 1.5}, {},
      {0.3, 1.2}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"cone generatrix, other nappe", CBR_SURFACE_CONE, cone, CBR_CURVE_LINE,
      {R * c3, R * s3, 0, ta * c3 / std::hypot(ta, 1), ta * s3 / std::hypot(ta, 1), 1 / std::hypot(ta, 1), 1.5}, {},
      {-12, -9}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"sphere parallel", CBR_SURFACE_SPHERE, sph, CBR_CURVE_CIRCLE, {0, 0, hs, 0, 0, 1, c3, s3, 0, rs}, {},
      {0.7, 2.9}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"sphere parallel, axis opposite", CBR_SURFACE_SPHERE, sph, CBR_CURVE_CIRCLE,
      {0, 0, -hs, 0, 0, -1, c7, s7, 0, rs}, {}, {0, 6.2}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"sphere meridian, near half", CBR_SURFACE_SPHERE, sph, CBR_CURVE_CIRCLE, {0, 0, 0, -s3, c3, 0, c3, s3, 0, R},
      {}, {-1.2, 1.4}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"sphere meridian, far half", CBR_SURFACE_SPHERE, sph, CBR_CURVE_CIRCLE, {0, 0, 0, -s3, c3, 0, c3, s3, 0, R},
      {}, {1.8, 4.5}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"sphere meridian, axis opposite", CBR_SURFACE_SPHERE, sph, CBR_CURVE_CIRCLE,
      {0, 0, 0, s7, -c7, 0, c7, s7, 0, R}, {}, {0.1, 1.5}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"torus parallel, outer", CBR_SURFACE_TORUS, tor, CBR_CURVE_CIRCLE,
      {0, 0, ht, 0, 0, 1, c3, s3, 0, R + 0.5 * std::cos(0.9)}, {}, {0.7, 2.9}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"torus parallel, inner, axis opposite", CBR_SURFACE_TORUS, tor, CBR_CURVE_CIRCLE,
      {0, 0, -ht, 0, 0, -1, c3, s3, 0, R - 0.5 * std::cos(0.9)}, {}, {0.7, 2.9}, PcurveMethod::isoLine,
      CBR_CURVE_LINE},
    {"torus meridian", CBR_SURFACE_TORUS, tor, CBR_CURVE_CIRCLE, {R * c3, R * s3, 0, -s3, c3, 0, c3, s3, 0, 0.5}, {},
      {-2, 3}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"torus meridian, axis opposite", CBR_SURFACE_TORUS, tor, CBR_CURVE_CIRCLE,
      {R * c7, R * s7, 0, s7, -c7, 0, 0, 0, 1, 0.5}, {}, {1, 6}, PcurveMethod::isoLine, CBR_CURVE_LINE},
    {"plane line", CBR_SURFACE_PLANE, pl, CBR_CURVE_LINE, {1, 2, 0, c3, s3, 0, 1.7}, {}, {-1, 2},
      PcurveMethod::planeAffine, CBR_CURVE_LINE},
    {"plane circle", CBR_SURFACE_PLANE, pl, CBR_CURVE_CIRCLE, {1, -1, 0, 0, 0, 1, c3, s3, 0, 1.5}, {}, {0.5, 4},
      PcurveMethod::planeAffine, CBR_CURVE_CIRCLE},
    {"plane circle, clockwise", CBR_SURFACE_PLANE, pl, CBR_CURVE_CIRCLE, {1, -1, 0, 0, 0, -1, c3, s3, 0, 1.5}, {},
      {0.5, 4}, PcurveMethod::planeAffine, 0},
    {"plane ellipse", CBR_SURFACE_PLANE, pl, CBR_CURVE_ELLIPSE, {1, -1, 0, 0, 0, 1, c3, s3, 0, 1.5, 0.5}, {},
      {0.5, 4}, PcurveMethod::planeAffine, CBR_CURVE_ELLIPSE},
    {"plane hyperbola", CBR_SURFACE_PLANE, pl, CBR_CURVE_HYPERBOLA, {1, -1, 0, 0, 0, 1, c3, s3, 0, 1.5, 0.5}, {},
      {-1, 1.5}, PcurveMethod::planeAffine, CBR_CURVE_HYPERBOLA},
    {"plane parabola", CBR_SURFACE_PLANE, pl, CBR_CURVE_PARABOLA, {1, -1, 0, 0, 0, 1, c3, s3, 0, 0.7}, {},
      {-1, 1.5}, PcurveMethod::planeAffine, CBR_CURVE_PARABOLA},
    // A rational quadratic: a quarter circle, weights 1, 1/sqrt 2, 1 (knots 0, 1).
    {"plane rational B-spline", CBR_SURFACE_PLANE, pl, CBR_CURVE_BSPLINE,
      {0, 1, 2, 0, 0, 2, 2, 0, 0, 2, 0, 1, 0.7071067811865476, 1}, {2, 3, 2, 1, 2, 2, 0, 3, 3}, {0, 1},
      PcurveMethod::planeAffine, CBR_CURVE_BSPLINE},
    {"plane polyline", CBR_SURFACE_PLANE, pl, CBR_CURVE_POLYLINE, {0, 0, 0, 1, 0, 0, 1, 2, 0, -1, 1, 0}, {4},
      {0.5, 2.5}, PcurveMethod::planeAffine, CBR_CURVE_POLYLINE},
  };
  std::mt19937 rng(5);
  int checked = 0;
  for (double scale : {1e-3, 1.0, 1e3})
    for (Vec3 T : {Vec3{0, 0, 0}, Vec3{-7e5, 1e6, 3e5}})
      for (const TableCase& tc : cases) {
        const Place P = place(rng, scale, T);
        const double tol = std::fmax(1e-7 * scale, 1e-14 * norm(T));
        // The surface's placement moved, its lengths scaled (a cone's angle not).
        const int slen = tc.skind == CBR_SURFACE_PLANE ? 0 : tc.skind == CBR_SURFACE_TORUS ? 2 : 1;
        const std::vector<double> sr = moved(P, tc.surface, 1, 2, slen);
        std::vector<double> cr;
        std::vector<int32_t> ci = tc.ints;
        if (tc.ckind == CBR_CURVE_LINE) {
          cr = moved(P, tc.curve, 1, 1, 1);
        } else if (tc.ckind == CBR_CURVE_BSPLINE) {
          const int k = tc.ints[2], n = tc.ints[1];
          cr = tc.curve;
          std::vector<double> pts(tc.curve.begin() + k, tc.curve.begin() + k + 3 * n);
          pts = moved(P, pts, n, 0, 0);
          std::copy(pts.begin(), pts.end(), cr.begin() + k);
        } else if (tc.ckind == CBR_CURVE_POLYLINE) {
          cr = moved(P, tc.curve, tc.ints[0], 0, 0);
        } else {
          const int lens = tc.ckind == CBR_CURVE_CIRCLE || tc.ckind == CBR_CURVE_PARABOLA ? 1 : 2;
          cr = moved(P, tc.curve, 1, 2, lens);
        }
        std::unique_ptr<Surface> surf = closeInFact(surfaceOf(tc.skind, sr), tol);
        std::unique_ptr<Curve> curve = curveOf(tc.ckind, cr, ci);
        REQUIRE(surf && curve);
        const std::string where = std::string(tc.name) + " at scale " + std::to_string(scale) + (T.x ? " far" : "");
        Pcurve p = project::projectForms(*curve, tc.r, *surf, tol, nullptr, {tc.ckind, 3, cr.data(), ci.data()},
          {tc.skind, 3, sr.data(), nullptr});
        CHECK(p.status == Status::ok);
        CHECK(p.method == tc.method);
        CHECK(p.certainty == Certainty::unique);
        CHECK(p.error <= tol);
        if (p.status != Status::ok || p.method != tc.method || p.pieces.size() != 1) {
          std::printf("    %s: status %d method %d pieces %zu error %g tol %g\n", where.c_str(),
            static_cast<int>(p.status), static_cast<int>(p.method), p.pieces.size(), p.error, tol);
          continue;
        }
        CHECK_EQ(p.pieces[0].kind, tc.kind2);
        const SurfaceDomain dom = surf->domain();
        double du = NAN;
        for (int i = 0; i <= 16; i++) {
          const double t = tc.r.lo + (tc.r.hi - tc.r.lo) * i / 16;
          CurvePoint q;
          curve->eval(t, 0, q);
          const Vec2 want = inverse(tc.skind, sr, q.p), got = uvAt(p.pieces[0], t);
          // One shift by whole periods for the whole p-curve (it's continuous), the oracle's atan2 jumping.
          const double ut = 20 * tol / scale;
          if (dom.uPeriod > 0) {
            const double k = std::round((want.x - got.x) / dom.uPeriod);
            if (std::isnan(du)) du = k;
            CHECK_NEAR(got.x + k * dom.uPeriod, want.x, 0, ut);
          } else {
            CHECK_NEAR(got.x, want.x, 0, ut + 1e-15 * norm(T));
          }
          const double kv = dom.vPeriod > 0 ? std::round((want.y - got.y) / dom.vPeriod) * dom.vPeriod : 0;
          CHECK_NEAR(got.y + kv, want.y, 0, tc.skind == CBR_SURFACE_PLANE ? ut + 1e-15 * norm(T) : ut);
        }
        // Continuity: the line's u has no jumps the oracle doesn't (the shift found at the start fits the end).
        if (dom.uPeriod > 0) {
          CurvePoint q;
          curve->eval(tc.r.hi, 0, q);
          const double k = std::round((inverse(tc.skind, sr, q.p).x - uvAt(p.pieces[0], tc.r.hi).x) / dom.uPeriod);
          const double span = (tc.r.hi - tc.r.lo);
          CHECK(std::fabs(k - du) <= std::ceil(span / dom.uPeriod) + 1);
        }
        checked++;
      }
  CHECK_EQ(checked, 6 * static_cast<int>(cases.size()));
}

TEST_CASE("the error measure: the largest deviation between samples, against dense sampling") {
  // A plane section of a cylinder (u = t, v = -k cos t) against the p-curve u = t, v = 0.2: the error |0.2 + k cos t|
  // has its largest peak at t = 0 and a lower one at pi, neither on an evenly spaced sample.
  const double R = 2, th = 0.6, tol = 1e-7;
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, R};
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr, R, 0), tol);
  const double er[9] = {0, 0, 0, std::sin(th), 0, std::cos(th), std::cos(th), 0, -std::sin(th)};
  std::unique_ptr<Curve> el = curves::makeEllipse(er, 3, R / std::cos(th), R);
  for (Range r : {Range{-1.3, 3.7}, Range{-0.71, 4.0}, Range{0.4, 3.0}}) {
    project::Job job{*el, r, *cyl, tol, nullptr, {}, {}, cyl->domain(), {}, {}};
    el->breaks(job.r, job.breaks);
    PcurvePiece p = project::linePiece(r, {r.lo, 0.2}, {1, 0});
    double dense = 0;
    for (int i = 0; i <= 200000; i++) {
      const double t = r.lo + (r.hi - r.lo) * i / 200000;
      const Vec2 uv = uvAt(p, t);
      SurfacePoint sp;
      CurvePoint c;
      cyl->eval(uv.x, uv.y, 0, sp), el->eval(t, 0, c);
      dense = std::fmax(dense, norm(sp.p - c.p));
    }
    CHECK_NEAR(project::measure(job, p), dense, 1e-9, 0);
  }
}

/**
 * A surface made periodic with period 1 in u or v by reducing that parameter into [0, 1) (as a false closure of a
 * sliver did: its two sides 0.03 apart, about its whole extent across).
 */
struct Wrapped : Surface {
  std::unique_ptr<Surface> s;
  bool inU;
  Wrapped(std::unique_ptr<Surface> base, bool u) : s(std::move(base)), inU(u) {}
  SurfaceDomain domain() const override {
    SurfaceDomain d = s->domain();
    (inU ? d.uPeriod : d.vPeriod) = 1;
    return d;
  }
  Status eval(double u, double v, int order, SurfacePoint& out) const override {
    return inU ? s->eval(u - std::floor(u), v, order, out) : s->eval(u, v - std::floor(v), order, out);
  }
  Status normal(double u, double v, Vec3& out) const override { return s->normal(u, v, out); }
  void breaks(Range ru, Range rv, std::vector<double>& us, std::vector<double>& vs) const override {
    s->breaks(ru, rv, us, vs);
  }
  Status bound(Range ru, Range rv, Box3& out) const override { return s->bound(ru, rv, out); }
  Status derivBound(Range ru, Range rv, int order, double out[3]) const override {
    return s->derivBound(ru, rv, order, out);
  }
  void singularities(std::vector<Singularity>& out) const override { s->singularities(out); }
};

TEST_CASE("footFrom on a periodic direction: the foot within half a period of its start") {
  // An extrusion along z of a quadratic arc 0.03 wide, made periodic across the arc. From just past the seam,
  // Newton's steps run round the period and land whole periods off (the same point); the foot must come back within
  // half a period of where it started, or a traced branch jumps between copies and its fit can't converge.
  const double w = 0.03;
  for (bool inU : {false, true}) {
    std::vector<double> r = {0, 1, 0, 1};
    if (!inU)
      for (double z : {0.0, 10.0}) r.insert(r.end(), {0, 0, z, w / 2, w, z, w, 0, z});
    else
      for (double x : {0.0, w / 2, w})
        for (double z : {0.0, 10.0}) r.insert(r.end(), {x, x == w / 2 ? w : 0, z});
    const int32_t inV[] = {1, 2, 2, 3, 2, 2, 0, 0, 0, 0, 0, 2, 2, 3, 3}, inUs[] = {2, 1, 3, 2, 2, 2, 0, 0, 0, 0, 0, 3,
      3, 2, 2};
    Status st;
    std::unique_ptr<Surface> base = surfaces::makeBSpline(r.data(), inU ? inUs : inV, st);
    REQUIRE(base);
    const Wrapped s(std::move(base), inU);
    double moved = 0;
    for (double off : {0.0, 0.005, 0.02})
      for (double x0 : {-1e-3, -1e-2, 1e-3, 0.999})
        for (double z : {1.0, 5.0}) {
          Vec2 uv = inU ? Vec2{x0, z / 10} : Vec2{z / 10, x0};
          project::footFrom(s, s.domain(), {0, -off, z}, uv, 12);
          moved = std::fmax(moved, std::fabs((inU ? uv.x : uv.y) - x0));
        }
    CHECK(moved <= 0.5);
  }
}

TEST_CASE("a parabolic trough: past its symmetry plane the traced foot is the farther one, and said so") {
  // The extrusion along z of y = x^2 over [-2, 2] (a quadratic Bezier: poles (-2, 4), (0, -4), (2, 4)): a point at
  // (x, 2) has two nearest feet, at x = +/- sqrt(3 / 2) where x = 0; the line y = 2 crosses that plane at t = 0.5.
  const double tol = 1e-7;
  std::vector<double> r = {0, 1, 0, 1};
  for (double px : {-2.0, 0.0, 2.0})
    for (double z : {-1.0, 1.0}) r.insert(r.end(), {px, px == 0 ? -4.0 : 4.0, z});
  const int32_t in[] = {2, 1, 3, 2, 2, 2, 0, 0, 0, 0, 0, 3, 3, 2, 2};
  Status st;
  std::unique_ptr<Surface> trough = surfaces::makeBSpline(r.data(), in, st);
  REQUIRE(trough);
  const double lr[7] = {-0.3, 2, 0.2, 1, 0, 0, 0.6};
  std::unique_ptr<Curve> line = curves::makeLine(lr, 3);
  Pcurve p = projectCurve(*line, {0, 1}, *trough, tol);
  CHECK(p.certainty == Certainty::ambiguous);
  bool past = false;
  for (double t : p.tAmbiguous) past = past || t > 0.6;
  CHECK(past);
}

TEST_CASE("a line through a cylinder's axis: the fold there and the nearer foot past it are ambiguous") {
  const double R = 2, tol = 1e-7;
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, R};
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr, R, 0), tol);
  // From x = -1.5 to 1.5 at y = 0.5 z = 0 ... through the axis at t = 1.5 when y = 0.
  const double lr[7] = {-1.5, 0, 0, 1, 0, 0, 1};
  std::unique_ptr<Curve> line = curves::makeLine(lr, 3);
  Pcurve p = projectCurve(*line, {0, 3}, *cyl, tol);
  CHECK(p.certainty == Certainty::ambiguous);
  CHECK(p.status == Status::invalidModel);
  bool past = false;
  for (double t : p.tAmbiguous) past = past || t > 1.8;
  CHECK(past);
}
