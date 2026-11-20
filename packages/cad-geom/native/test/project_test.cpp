// project.h: every p-curve of the reference shapes at every variant (near, far, scaled, mirrored, moved) made again
// from its 3D curve, with the exact table and without it (tracing alone), and compared with the model's; curves
// traced against closed forms (a plane section of a cylinder, circles on a sphere through and past its poles) moved,
// turned and scaled; the exact table on every entry (opposite axes, a cone's other nappe, a sphere's far half, a
// torus's inner side, conics running either way on a plane) against each surface's closed-form inverse; the error
// measure against dense sampling; seams, the seam rule, known ends, curves off their surface (how often they're
// fitted, and one past its surface's edge), a fold.
#include <cad_geom/numerics.h>
#include <cad_geom/project.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>
#include <tuple>

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

TEST_CASE("a curve off its surface by more than tol: fitted once, not ever tighter") {
  // The ellipse 1e-5 off the cylinder, traced (no forms for the table): its feet a sine in (u, v), fitted. No p-curve
  // gets within tol, so tightening the fit's tolerance (four attempts) would only spend time; the fit's tolerance a
  // quarter of the distance (100 tol here).
  const double R = 2, tol = 1e-7;
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, R};
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr, R, 0), tol);
  const double th = 0.3;
  const double cr[9] = {0, 0, 1, std::sin(th), 0, std::cos(th), std::cos(th), 0, -std::sin(th)};
  std::unique_ptr<Curve> el = curves::makeEllipse(cr, 3, R / std::cos(th) + 1e-5, R + 1e-5);
  const long before = project::traceFits;
  Pcurve p = project::projectForms(*el, {0, 1}, *cyl, tol, nullptr, {}, {});
  const long fits = project::traceFits - before;
  CHECK(p.status == Status::invalidModel);
  CHECK(p.method == PcurveMethod::traced);
  CHECK(p.offSurface > 5e-6 && p.offSurface < 2e-5);
  CHECK(p.error <= p.offSurface + 0.25 * (0.25 * p.offSurface));
  CHECK_EQ(fits, 1);
  if (fits != 1) std::printf("    fits %ld error %g offSurface %g\n", fits, p.error, p.offSurface);
}

namespace {

// A helix round a cylinder of radius kR whose radius has a narrow bump, R + a + w exp(-((t - t0) / s)^2), and
// whose angle wiggles, t + q sin mt (about 6e-6 along the surface, so a tighter fit follows the feet a little
// closer): the test below.
class Bump final : public Curve {
public:
  int dim() const override { return 3; }
  CurveDomain domain() const override { return {{0, 1}, 0}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    const double f = t + kQ * std::sin(kM * t), f1 = 1 + kQ * kM * std::cos(kM * t);
    const double f2 = -kQ * kM * kM * std::sin(kM * t), c = std::cos(f), s = std::sin(f);
    const double z = (t - kT0) / kS, g = std::exp(-z * z), r = kR + kA + kW * g;
    const double r1 = kW * g * (-2 * z / kS), r2 = kW * g * (4 * z * z - 2) / (kS * kS);
    out.p = {r * c, r * s, kH * t};
    if (order >= 1) out.d1 = {r1 * c - r * s * f1, r1 * s + r * c * f1, kH};
    if (order >= 2)
      out.d2 = {r2 * c - 2 * r1 * s * f1 - r * c * f1 * f1 - r * s * f2,
        r2 * s + 2 * r1 * c * f1 - r * s * f1 * f1 + r * c * f2, 0};
    return t < 0 || t > 1 ? Status::outOfDomain : Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status bound(Range r, Box3& out) const override {
    const double m = kR + kA + kW;
    out = {Interval::hull(-m, m), Interval::hull(-m, m), Interval::hull(kH * r.lo, kH * r.hi)};
    return Status::ok;
  }
  Status derivBound(Range, int order, double& out) const override {
    // |g'| <= 2 / s and |g''| <= 2 / s^2 (e^-z^2 times 2z and 4z^2 - 2 at most).
    const double m = kR + kA + kW, f1 = 1 + kQ * kM, f2 = kQ * kM * kM, d1 = 2 * kW / kS, d2 = 2 * kW / (kS * kS);
    out = order == 1 ? d1 + m * f1 + kH : d2 + 2 * d1 * f1 + m * f1 * f1 + m * f2;
    return Status::ok;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }
  static constexpr double kR = 2, kA = 1e-5, kW = 1e-5, kT0 = 0.3, kS = 0.01, kH = 0.5, kQ = 3e-6, kM = 10;
};

} // namespace

TEST_CASE("a curve farther off its surface between the samples: offSurface where the error is worst, one fit") {
  // A helix round a cylinder whose radius has a narrow bump (1e-5 high, 0.01 wide in t): its feet don't move with
  // it, and it falls between the trace's nodes (1e-5 off), so the error measured is its peak (2e-5). The curve's
  // distance there from its foot is that peak too, so offSurface is, and the fit stops at its first round (no
  // tightening can beat the curve's own distance).
  const double tol = 1e-7;
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, Bump::kR};
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr, Bump::kR, 0), tol);
  Bump w;
  const long before = project::traceFits;
  Pcurve p = project::projectForms(w, {0, 1}, *cyl, tol, nullptr, {}, {});
  const long fits = project::traceFits - before;
  CHECK(p.status == Status::invalidModel);
  CHECK(p.error > 1.99e-5 && p.error < 2.01e-5);
  CHECK(p.offSurface > 0.99 * p.error && p.offSurface <= p.error * (1 + 1e-9));
  CHECK_EQ(fits, 1);
  if (fits != 1) std::printf("    fits %ld error %g offSurface %g\n", fits, p.error, p.offSurface);
}

namespace {

// A helix round a cylinder of radius 2, 1e-5 off it (radius 2 + 1e-5), its angle wiggling: t + q sin mt.
class OffHelix final : public Curve {
public:
  OffHelix(double q, double m) : q_(q), m_(m) {}
  int dim() const override { return 3; }
  CurveDomain domain() const override { return {{0, 1}, 0}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    const double f = t + q_ * std::sin(m_ * t), f1 = 1 + q_ * m_ * std::cos(m_ * t);
    const double f2 = -q_ * m_ * m_ * std::sin(m_ * t), c = std::cos(f), s = std::sin(f), r = 2 + 1e-5;
    out.p = {r * c, r * s, 0.5 * t};
    if (order >= 1) out.d1 = {-r * s * f1, r * c * f1, 0.5};
    if (order >= 2) out.d2 = {-r * c * f1 * f1 - r * s * f2, -r * s * f1 * f1 + r * c * f2, 0};
    return t < 0 || t > 1 ? Status::outOfDomain : Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status bound(Range r, Box3& out) const override {
    const double m = 2 + 1e-5;
    out = {Interval::hull(-m, m), Interval::hull(-m, m), Interval::hull(0.5 * r.lo, 0.5 * r.hi)};
    return Status::ok;
  }
  Status derivBound(Range, int order, double& out) const override {
    const double m = 2 + 1e-5, f1 = 1 + q_ * m_, f2 = q_ * m_ * m_;
    out = order == 1 ? m * f1 + 0.5 : m * f1 * f1 + m * f2;
    return Status::ok;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }

private:
  double q_, m_;
};

} // namespace

TEST_CASE("a curve 1000 tol off its surface: its line and its fit judged by a quarter of that distance") {
  // At tol 1e-8 the helix is 1000 tol off. Its feet wiggle along the surface by 2q (in 3D): by 4e-7, within a
  // quarter of the p-curve's tolerance (a quarter of 1e-5) of a line, so the line is taken, though 1.6e-8 farther
  // than the distance (over tol / 4); by 4e-6 they're fitted, once, the fit 4e-8 farther (over tol / 4 too).
  const double tol = 1e-8;
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, 2};
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr, 2, 0), tol);
  for (auto [q, m, method, n] : {std::tuple{2e-7, 10.0, PcurveMethod::affineFeet, 0L},
         std::tuple{2e-6, 20.0, PcurveMethod::traced, 1L}}) {
    OffHelix h(q, m);
    const long before = project::traceFits;
    Pcurve p = project::projectForms(h, {0, 1}, *cyl, tol, nullptr, {}, {});
    const long fits = project::traceFits - before;
    CHECK(p.status == Status::invalidModel);
    CHECK(p.method == method);
    CHECK_EQ(fits, n);
    CHECK(p.offSurface > 0.99e-5 && p.offSurface < 1.01e-5);
    CHECK(p.error > p.offSurface + 0.25 * tol);
    CHECK(p.error <= p.offSurface + 0.25 * (0.25 * p.offSurface));
    if (p.method != method || fits != n)
      std::printf("    q %g: method %d fits %ld error - offSurface %g\n", q, static_cast<int>(p.method), fits,
        p.error - p.offSurface);
  }
}

TEST_CASE("a curve past its surface's edge: its feet clamped there, fitted at a quarter of its distance, few rounds") {
  // A circle 0.01 above a flat unit square, radius 0.6 about its centre, over t in [0.3, 1.2]: past the u = 1 edge,
  // then inside, then past v = 1. Its feet sit on the edges there, with corners where they leave them; fitted at tol
  // the fit halves its spans at the corners round after round (18 rounds to 263 spans), at a quarter of the curve's
  // distance from the surface (0.074 at t = 0.3) in a few.
  const double tol = 1e-6;
  const int32_t in[] = {1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 0, 2, 2, 2, 2};
  const double r[] = {0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0};
  Status st;
  std::unique_ptr<Surface> sq = surfaces::makeBSpline(r, in, st);
  REQUIRE(sq);
  const double cr[9] = {0.5, 0.5, 0.01, 0, 0, 1, 1, 0, 0};
  std::unique_ptr<Curve> c = curves::makeEllipse(cr, 3, 0.6, 0.6);
  const long f0 = project::traceFits, r0 = fit::curve2Rounds;
  Pcurve p = project::projectForms(*c, {0.3, 1.2}, *sq, tol, nullptr, {}, {});
  const long fits = project::traceFits - f0, rounds = fit::curve2Rounds - r0;
  CHECK(p.status == Status::invalidModel);
  CHECK(p.method == PcurveMethod::traced);
  CHECK_NEAR(p.offSurface, std::hypot(0.5 + 0.6 * std::cos(0.3) - 1, 0.01), 0, 1e-9);
  CHECK_EQ(fits, 1);
  CHECK(rounds >= 1 && rounds <= 6);
  // The p-curve within half the fit's tolerance of the feet: S(p(t)) against the square's nearest point to C(t)
  // (its x and y clamped to the square), at 61 parameters.
  REQUIRE(p.pieces.size() == 1);
  double worst = 0;
  for (int k = 0; k <= 60; k++) {
    const double t = 0.3 + 0.9 * k / 60;
    const Vec2 uv = uvAt(p.pieces[0], t);
    SurfacePoint sp;
    CurvePoint q;
    sq->eval(uv.x, uv.y, 0, sp);
    c->eval(t, 0, q);
    const Vec3 foot{std::clamp(q.p.x, 0.0, 1.0), std::clamp(q.p.y, 0.0, 1.0), 0};
    worst = std::max(worst, norm(sp.p - foot));
  }
  CHECK(worst <= 0.5 * (0.25 * p.offSurface));
  CHECK(p.error <= p.offSurface + 0.5 * (0.25 * p.offSurface));
  if (!(rounds <= 6 && fits == 1)) std::printf("    fits %ld rounds %ld worst %g\n", fits, rounds, worst);
}

TEST_CASE("a curve leaving its surface within a span its samples miss: invalidModel, the span and distance given") {
  // A flat bilinear patch 10 x 10 at z = 0 and a cubic on it from (1, 1) to (9, 9) whose first knot span, 1e-6 wide,
  // has a stray pole 3e7 above the patch (bug24383 #11's edges): the curve rises 3e7 x 4/9 there and comes back, far
  // between any samples. A second, 2e7 in the last span (1e-6 wide too), takes the curve 2e7 x 4/9 up: its hull is
  // farther than the first's peak, its curve isn't, so the span given is the first. The controls: the same curve
  // without the stray poles, and one whose hull leaves the patch's box by 0.4 while the curve leaves it by 0.05.
  const double tol = 0.1;
  const int32_t si[] = {1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 0, 2, 2, 2, 2};
  const double sr[] = {0, 1, 0, 1, 0, 0, 0, 0, 10, 0, 10, 0, 0, 10, 10, 0};
  Status st;
  std::unique_ptr<Surface> patch = surfaces::makeBSpline(sr, si, st);
  REQUIRE(patch);
  const int32_t cin[] = {3, 10, 4, 0, 0, 0, 0, 4, 3, 3, 4};
  auto curve = [&](double z1, double z2) {
    const double cr[] = {0, 1e-6, 1 - 1e-6, 1, 1, 1, 0, 1, 1, z1, 1, 1, 0, 1, 1, 0, 4, 4, 0, 6, 6, 0, 9, 9, 0, 9, 9,
      0, 9, 9, z2, 9, 9, 0};
    return curves::makeBSpline(cr, cin, 3, st);
  };
  std::unique_ptr<Curve> spike = curve(3e7, 2e7), clean = curve(0, 0);
  REQUIRE(spike);
  REQUIRE(clean);
  Pcurve p = project::projectForms(*spike, {0, 1}, *patch, tol, nullptr, {}, {});
  CHECK(p.status == Status::invalidModel);
  CHECK(std::fabs(p.offSurface - 3e7 * 4 / 9) <= 0.01 * 3e7 * 4 / 9);
  CHECK(p.offSpan.lo == 0);
  CHECK(p.offSpan.hi == 1e-6);
  CHECK(p.error >= p.offSurface);
  if (!(std::fabs(p.offSurface - 3e7 * 4 / 9) <= 0.01 * 3e7 * 4 / 9))
    std::printf("    offSurface %g span [%g, %g]\n", p.offSurface, p.offSpan.lo, p.offSpan.hi);
  Pcurve q = project::projectForms(*clean, {0, 1}, *patch, tol, nullptr, {}, {});
  CHECK(q.status == Status::ok);
  CHECK(std::isnan(q.offSpan.lo));
  CHECK(q.offSurface <= tol);
  // From (9, 1) to (9, 9), its middle poles at x = 10.4: x reaches 9 + 1.4 x 3/4 = 10.05.
  const int32_t bin[] = {3, 4, 2, 0, 0, 0, 0, 4, 4};
  const double br[] = {0, 1, 9, 1, 0, 10.4, 3, 0, 10.4, 7, 0, 9, 9, 0};
  std::unique_ptr<Curve> bulge = curves::makeBSpline(br, bin, 3, st);
  REQUIRE(bulge);
  Pcurve b = project::projectForms(*bulge, {0, 1}, *patch, tol, nullptr, {}, {});
  CHECK(std::isnan(b.offSpan.lo));
  CHECK(b.offSurface <= tol);
  CHECK(b.status != Status::invalidModel);
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

namespace {

// C(t) = S(a + t (b - a) + w t (1 - t) n) + (0, 0, dz): a curve on the surface (its (u, v) a bowed line, n the
// line's direction turned), lifted dz in z, t in [0, 1].
class OnSurface final : public Curve {
public:
  OnSurface(const Surface& s, Vec2 a, Vec2 b, double w, double dz) : s_(s), a_(a), b_(b), w_(w), dz_(dz) {}
  int dim() const override { return 3; }
  CurveDomain domain() const override { return {{0, 1}, 0}; }
  Status eval(double t, int order, CurvePoint& out) const override {
    const Vec2 d = b_ - a_, n{-d.y, d.x};
    const Vec2 q = a_ + t * d + (w_ * t * (1 - t)) * n, q1 = d + (w_ * (1 - 2 * t)) * n, q2 = (-2 * w_) * n;
    SurfacePoint sp;
    s_.eval(q.x, q.y, 2, sp);
    out.p = sp.p + Vec3{0, 0, dz_};
    if (order >= 1) out.d1 = q1.x * sp.du + q1.y * sp.dv;
    if (order >= 2)
      out.d2 = q1.x * q1.x * sp.duu + 2 * q1.x * q1.y * sp.duv + q1.y * q1.y * sp.dvv + q2.x * sp.du + q2.y * sp.dv;
    return t < 0 || t > 1 ? Status::outOfDomain : Status::ok;
  }
  void breaks(Range r, std::vector<double>& out) const override { out = {r.lo, r.hi}; }
  Status bound(Range, Box3& out) const override {
    Status st = s_.bound({0, 1}, {0, 1}, out);
    out.z = out.z + Interval::point(dz_);
    return st;
  }
  Status derivBound(Range, int order, double& out) const override {
    out = order == 1 ? 4000 : 8000;
    return Status::ok;
  }
  void singular(Range, std::vector<double>& out) const override { out.clear(); }

private:
  const Surface& s_;
  Vec2 a_, b_;
  double w_, dz_;
};

} // namespace

TEST_CASE("a fit on a surface stretched 1e5 times more one way: judged in 3D, not by the long way's (u, v) tolerance") {
  // A twisted bilinear patch 0.01 across (u) and 1000 along (v), a bowed curve on it lifted 6e-4, at tol 0.038 (VW
  // #2404's proportions). Judged in (u, v) at the tolerance the long side's stretch gives, the fit asked u for 1e5
  // times what its 3D effect needs (16 rounds); judged in 3D, one.
  const double tol = 0.038;
  const int32_t in[] = {1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 0, 2, 2, 2, 2};
  const double r[] = {0, 1, 0, 1, 0, 0, 0, 0, 1000, 0, 0.01, 0, 0, 0.01, 1000, 50};
  Status st;
  std::unique_ptr<Surface> strip = surfaces::makeBSpline(r, in, st);
  REQUIRE(strip);
  OnSurface c(*strip, {0.1, 0}, {0.9, 1}, 0.3, 6e-4);
  const long f0 = project::traceFits, r0 = fit::curve2Rounds;
  Pcurve p = project::projectForms(c, {0, 1}, *strip, tol, nullptr, {}, {});
  const long rounds = fit::curve2Rounds - r0;
  CHECK(p.status == Status::ok);
  CHECK(p.method == PcurveMethod::traced);
  CHECK(p.error <= tol);
  CHECK_EQ(project::traceFits - f0, 1);
  CHECK(rounds <= 3);
  if (!(rounds <= 3)) std::printf("    rounds %ld\n", rounds);
}

TEST_CASE("a great circle passing close to a sphere's poles, at a coarse tolerance: the march not stuck on a pole") {
  // LMP1 #172878's edge on its sphere (radius 10, moved to the origin): a great circle whose axis is 0.035 from the
  // equator's plane, over [1.332, pi] from beside the north pole. At tol 0.2 a march step from near the pole
  // overshot onto its line, where Newton has no gradient in u and stays, and the step passed (the predictor's slack
  // is the tolerance's): nodes 2.4 off the curve, invalidModel. Rejected there, the trace goes round the pole.
  const double tol = 0.2;
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, 10};
  std::unique_ptr<Surface> sph = closeInFact(surfaces::makeSphere(sr), tol);
  const double cr[9] = {0, 0, 0, -0.8089590548665507, 0.5868046581769529, -0.035292218565090794,
    -0.587170444453497, -0.8094633216893048, 0};
  std::unique_ptr<Curve> circ = curves::makeEllipse(cr, 3, 10, 10);
  Pcurve p = project::projectForms(*circ, {1.332136618329816, 3.1415926535887757}, *sph, tol, nullptr, {}, {});
  CHECK(p.status == Status::ok);
  CHECK(p.offSurface < 1e-9);
  CHECK(p.error <= tol);
  CHECK(p.certainty == Certainty::unique);
}

TEST_CASE("the exact table on a plane: a short arc of a circle tilted from it maps, not as the circle") {
  // A circle 16 m across whose plane is 4 degrees from the face's plane z = 0, near t = pi / 2 running along the
  // line the planes share, so 6e-5 rad of it (about 1 mm) stays within 2e-6 of the face (LMP1 #173171's edge 1). The
  // circle mapped as a 2D circle lies off its projection, an ellipse; the table maps the 3D curve instead: ok.
  const double R = 16000, th = 4 * kPi / 180, tol = 1e-5;
  const double cr[10] = {0, 0, R * std::sin(th), 0, std::sin(th), std::cos(th), 1, 0, 0, R};
  const double pr[9] = {0, 0, 0, 0, 0, 1, 1, 0, 0};
  std::unique_ptr<Curve> circle = curves::makeEllipse(cr, 3, R, R);
  std::unique_ptr<Surface> plane = surfaces::makePlane(pr);
  const Range r{0.5 * kPi - 3e-5, 0.5 * kPi + 3e-5};
  Pcurve p = project::projectForms(*circle, r, *plane, tol, nullptr, {CBR_CURVE_CIRCLE, 3, cr, nullptr},
    {CBR_SURFACE_PLANE, 3, pr, nullptr});
  CHECK(p.status == Status::ok);
  CHECK(p.method == PcurveMethod::planeAffine);
  CHECK(p.error <= tol);
  CHECK(p.offSurface < 3e-6);
  REQUIRE(p.pieces.size() == 1);
  CHECK_EQ(p.pieces[0].kind, 0);
  // The same circle in the face's plane (not tilted) stays a circle.
  const double flat[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, R};
  std::unique_ptr<Curve> inPlane = curves::makeEllipse(flat, 3, R, R);
  Pcurve q = project::projectForms(*inPlane, r, *plane, tol, nullptr, {CBR_CURVE_CIRCLE, 3, flat, nullptr},
    {CBR_SURFACE_PLANE, 3, pr, nullptr});
  CHECK(q.status == Status::ok);
  REQUIRE(q.pieces.size() == 1);
  CHECK_EQ(q.pieces[0].kind, CBR_CURVE_CIRCLE);
}

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
  // One smooth span with two bumps: a Bezier of degree n over a flat patch, its height H at pole 1 (a narrow bump at
  // t = 1 / n, the highest, 0.37 H) and k H at pole n / 2 (a broad one at the middle). Degree 60, k = 2: at a
  // spacing of 1 / 16 the narrow one's samples are under half the worst sample (the broad one's), so only 64 samples
  // a span find it. Degree 200, k = 4: narrower than 1 / 64, its nearest sample is over half the worst but under the
  // broad one's, so only refining every local maximum within half of the worst finds it.
  const int32_t fi[] = {1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 0, 2, 2, 2, 2};
  const double fr[] = {0, 1, 0, 1, 0, 0, 0, 0, 10, 0, 10, 0, 0, 10, 10, 0};
  Status st;
  std::unique_ptr<Surface> flat = surfaces::makeBSpline(fr, fi, st);
  REQUIRE(flat);
  const double H = 1e-3;
  for (auto [n, k] : {std::pair<int, double>{60, 2}, std::pair<int, double>{200, 4}}) {
    std::vector<double> cr = {0, 1};
    for (int i = 0; i <= n; i++) cr.insert(cr.end(), {10.0 * i / n, 5, i == 1 ? H : i == n / 2 ? k * H : 0});
    const int32_t ci[] = {n, n + 1, 2, 0, 0, 0, 0, n + 1, n + 1};
    std::unique_ptr<Curve> bumps = curves::makeBSpline(cr.data(), ci, 3, st);
    REQUIRE(bumps);
    project::Job job{*bumps, {0, 1}, *flat, 1e-7, nullptr, {}, {}, flat->domain(), {}, {}};
    bumps->breaks(job.r, job.breaks);
    PcurvePiece line = project::linePiece({0, 1}, {0, 0.5}, {1, 0});
    double dense = 0;
    for (int i = 0; i <= 20000; i++) {
      CurvePoint c;
      bumps->eval(i / 20000.0, 0, c);
      dense = std::fmax(dense, std::fabs(c.p.z));
    }
    const double m = project::measure(job, line);
    CHECK(m >= dense * (1 - 1e-9));
    CHECK(m <= dense * (1 + 1e-4));
    CHECK(dense > 0.3 * H);
    if (!(m >= dense * (1 - 1e-9))) std::printf("    degree %d: measured %g, dense %g\n", n, m, dense);
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

TEST_CASE("the end search: a pole, a seam's pair, a point, a family; searched once per key, its feet kept") {
  const double tol = 1e-3, R = 5;
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, 10};
  std::unique_ptr<Surface> sph = closeInFact(surfaces::makeSphere(sr), tol);
  const double cr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, R};
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(cr, R, 0), tol);
  EndSearchCache cache;
  // The sphere's north pole: one foot, its free coordinate u over the period.
  const std::vector<EndFoot>& pole = cache.feet(1, *sph, {0, 0, 10 + 1e-5}, tol);
  REQUIRE(pole.size() == 1);
  CHECK(pole[0].kind == EndFoot::Kind::pole);
  CHECK(pole[0].poleU);
  CHECK(std::fabs(pole[0].freeHi - pole[0].freeLo - 2 * kPi) < 1e-12);
  CHECK(pole[0].certainty == Certainty::unique);
  CHECK(std::fabs(pole[0].distance - 1e-5) < 1e-9);
  // On the cylinder's seam: a pair a period apart; off it, a point.
  const std::vector<EndFoot>& seam = cache.feet(2, *cyl, {R + 1e-4, 1e-6, 3}, tol);
  REQUIRE(seam.size() == 1);
  CHECK(seam[0].kind == EndFoot::Kind::seamPair);
  CHECK(std::fabs(std::fabs(seam[0].twin.x - seam[0].uv.x) - 2 * kPi) < 1e-9);
  CHECK(seam[0].twin.y == seam[0].uv.y);
  // The other copy at the seam's other end: a period on from a foot at its start (a hair past the range's end, as
  // a seam's p-curve's twin is).
  const SurfaceDomain cd = cyl->domain();
  CHECK(std::fabs(seam[0].uv.x - cd.u.lo) < 1e-6);
  CHECK(std::fabs(seam[0].twin.x - (cd.u.lo + cd.uPeriod)) < 1e-6);
  const std::vector<EndFoot>& point = cache.feet(3, *cyl, {R * std::cos(1.0), R * std::sin(1.0), 3}, tol);
  REQUIRE(point.size() == 1);
  CHECK(point[0].kind == EndFoot::Kind::point);
  CHECK(std::fabs(point[0].uv.x - 1) < 1e-9);
  CHECK(std::fabs(point[0].uv.y - 3) < 1e-9);
  // On its axis every u is a foot: several, apart by more than the tolerance (0.5 here), ambiguous.
  const std::vector<EndFoot>& axis = cache.feet(4, *cyl, {0, 0, 3}, 0.5);
  CHECK(axis.size() > 2);
  for (const EndFoot& k : axis) CHECK(k.certainty == Certainty::ambiguous);
  // Asked again at a smaller tol, the same key isn't searched again; the vector others hold stays as it was.
  const EndFoot kept = point[0];
  const long r0 = cache.searches();
  const std::vector<EndFoot>& again = cache.feet(3, *cyl, {R * std::cos(1.0), R * std::sin(1.0), 3}, tol / 10);
  CHECK(cache.searches() == r0);
  CHECK(&again == &point);
  CHECK(pole.size() == 1);
  CHECK(pole[0].kind == EndFoot::Kind::pole);
  CHECK(again[0].uv.x == kept.uv.x);
  // At a larger tol it is.
  cache.feet(3, *cyl, {R * std::cos(1.0), R * std::sin(1.0), 3}, tol * 10);
  CHECK(cache.searches() == r0 + 1);
  // Below a trough's vertex, on the line where the search splits its rectangles: two of its leaves polish to the
  // one foot, one foot.
  std::vector<double> r = {0, 1, 0, 1};
  for (double px : {-2.0, 0.0, 2.0})
    for (double z : {-1.0, 1.0}) r.insert(r.end(), {px, px == 0 ? -4.0 : 4.0, z});
  const int32_t in[] = {2, 1, 3, 2, 2, 2, 0, 0, 0, 0, 0, 3, 3, 2, 2};
  Status st;
  std::unique_ptr<Surface> trough = surfaces::makeBSpline(r.data(), in, st);
  REQUIRE(trough);
  const std::vector<EndFoot>& vertex = cache.feet(5, *trough, {0, -3, 0}, 0.3);
  REQUIRE(vertex.size() == 1);
  CHECK(vertex[0].certainty == Certainty::unique);
  CHECK(std::fabs(vertex[0].distance - 3) < 1e-9);
}

TEST_CASE("traced ends against the end search: the same foot, a seam pair's other copy, periods over, different, off") {
  // Quarter arcs exactly on a cylinder of radius 5 (rational quadratics in x, y, rising in z), its seam at angle 0:
  // from 3 pi / 2 to the seam (the trace arrives at 2 pi, the search's foot at 0, its twin 2 pi), and from 7 pi / 4
  // across it to pi / 4 (the trace's end unwrapped a period past the search's foot).
  const double R = 5, tol = 1e-6;
  const double cr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, R};
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(cr, R, 0), tol);
  Status st;
  auto arc = [&](double a) {
    const double w = std::sqrt(0.5), c = std::cos(a), s = std::sin(a);
    const int32_t in[] = {2, 3, 2, 1, 0, 0, 0, 3, 3};
    const double r[] = {0, 1, R * c, R * s, 0, R * (c - s), R * (s + c), 1, R * -s, R * c, 2, 1, w, 1};
    return curves::makeBSpline(r, in, 3, st);
  };
  auto ends = [&](EndSearchCache& cache, const Curve& c, uint64_t key) {
    PcurveEnds e;
    CurvePoint a, b;
    c.eval(0, 0, a), c.eval(1, 0, b);
    e.cache = &cache, e.checkStart = e.checkEnd = true, e.startKey = key, e.endKey = key + 1;
    e.startPoint = a.p, e.endPoint = b.p;
    return e;
  };
  EndSearchCache cache;
  std::unique_ptr<Curve> toSeam = arc(1.5 * kPi), across = arc(1.75 * kPi);
  REQUIRE(toSeam);
  REQUIRE(across);
  const PcurveEnds e1 = ends(cache, *toSeam, 10), e2 = ends(cache, *across, 20);
  Pcurve p = projectCurve(*toSeam, {0, 1}, *cyl, tol, &e1);
  CHECK(p.status == Status::ok);
  CHECK((p.method == PcurveMethod::traced || p.method == PcurveMethod::affineFeet));
  CHECK(p.endCheck[0] == EndCheck::same);
  CHECK(p.endCheck[1] == EndCheck::seamOther);
  CHECK(p.certainty == Certainty::unique);
  Pcurve q = projectCurve(*across, {0, 1}, *cyl, tol, &e2);
  CHECK(q.status == Status::ok);
  CHECK(q.endCheck[0] == EndCheck::same);
  CHECK(q.endCheck[1] == EndCheck::periods);
  CHECK(q.endAlternatives[1].empty());
  // Its end vertex elsewhere on the cylinder (a model's gap: the vertex off the curve's end): vertexOff, the
  // vertex's foot given, the trace still unique.
  PcurveEnds wrong = e1;
  wrong.endKey = 12, wrong.endPoint = {-R, 0, 1};
  Pcurve w = projectCurve(*toSeam, {0, 1}, *cyl, tol, &wrong);
  CHECK(w.endCheck[0] == EndCheck::same);
  CHECK(w.endCheck[1] == EndCheck::vertexOff);
  CHECK(w.certainty == Certainty::unique);
  CHECK(w.tAmbiguous.empty());
  REQUIRE(w.endAlternatives[1].size() == 1);
  CHECK(std::fabs(w.endAlternatives[1][0].x - kPi) < 1e-6);
  // Off by 2 tol, still a gap.
  wrong.endKey = 13, wrong.endPoint = {R + 2 * tol, 0, 1};
  CHECK(projectCurve(*toSeam, {0, 1}, *cyl, tol, &wrong).endCheck[1] == EndCheck::vertexOff);
  // Without a cache, unchecked.
  Pcurve u = projectCurve(*toSeam, {0, 1}, *cyl, tol);
  CHECK(u.endCheck[0] == EndCheck::unchecked);
  CHECK(u.endCheck[1] == EndCheck::unchecked);
  // The trough (as above): its line's start has one foot, the traced one; past the symmetry plane the trace keeps
  // the farther foot, so its end isn't the search's one foot there: different, ambiguous at t = 1, that foot given.
  std::vector<double> r = {0, 1, 0, 1};
  for (double px : {-2.0, 0.0, 2.0})
    for (double z : {-1.0, 1.0}) r.insert(r.end(), {px, px == 0 ? -4.0 : 4.0, z});
  const int32_t in[] = {2, 1, 3, 2, 2, 2, 0, 0, 0, 0, 0, 3, 3, 2, 2};
  std::unique_ptr<Surface> trough = surfaces::makeBSpline(r.data(), in, st);
  REQUIRE(trough);
  const double lr[7] = {-0.3, 2, 0.2, 1, 0, 0, 0.6};
  std::unique_ptr<Curve> line = curves::makeLine(lr, 3);
  const PcurveEnds e3 = ends(cache, *line, 30);
  Pcurve d = projectCurve(*line, {0, 1}, *trough, 1e-7, &e3);
  CHECK(d.endCheck[0] == EndCheck::same);
  CHECK(d.endCheck[1] == EndCheck::different);
  CHECK(d.certainty == Certainty::ambiguous);
  REQUIRE(d.endAlternatives[1].size() == 1);
  // Its foot on the near side, x > 0 (u = (x + 2) / 4 along the trough's Bezier), the trace's on the far.
  CHECK(d.endAlternatives[1][0].x > 0.5);
  CHECK(project::at(d.pieces.back(), 1).x < 0.5);
  bool atEnd = false;
  for (double t : d.tAmbiguous) atEnd = atEnd || t == 1;
  CHECK(atEnd);
  // The line ending just past the trough's symmetry plane (x = 0.01): no check sample past it, so the trace is
  // otherwise unique, but its end (on the far foot) isn't its vertex's nearest: different, which alone makes it
  // ambiguous.
  const double sr2[7] = {-0.3, 2, 0.2, 1, 0, 0, 0.31};
  std::unique_ptr<Curve> shortLine = curves::makeLine(sr2, 3);
  const PcurveEnds e4 = ends(cache, *shortLine, 50);
  Pcurve d2 = projectCurve(*shortLine, {0, 1}, *trough, 1e-7, &e4);
  CHECK(d2.endCheck[1] == EndCheck::different);
  CHECK(d2.certainty == Certainty::ambiguous);
  CHECK(d2.tAmbiguous.size() == 1);
  // Seeded from the end search: the line from x = -0.3 to 0.9, its central sample (x = 0.3) nearer the x > 0 foot,
  // its start's one foot on the x < 0 side. The trace starts there (the start the vertex's foot), not from the
  // sample (whose branch would end at the start's farther foot); its end is then the farther one.
  const double lr3[7] = {-0.3, 2, 0.2, 1, 0, 0, 1.2};
  std::unique_ptr<Curve> longLine = curves::makeLine(lr3, 3);
  const PcurveEnds e5 = ends(cache, *longLine, 60);
  Pcurve d3 = projectCurve(*longLine, {0, 1}, *trough, 1e-7, &e5);
  CHECK(d3.endCheck[0] == EndCheck::same);
  CHECK(d3.endCheck[1] == EndCheck::different);
  REQUIRE(!d3.pieces.empty());
  CHECK(project::at(d3.pieces.front(), 0).x < 0.5);
  // Not seeded from an end: one with two feet (x = 0, the trough's symmetry plane, heading to x = 0.6: the central
  // sample's branch, x > 0, not the lower foot's), or one whose vertex is off the curve's end (by 0.5, its foot on
  // the far branch: the central sample's, x < 0). The other end unchecked.
  const double lr4[7] = {0, 2, 0.2, 1, 0, 0, 0.6};
  std::unique_ptr<Curve> fromPlane = curves::makeLine(lr4, 3);
  PcurveEnds e6 = ends(cache, *fromPlane, 70);
  e6.checkEnd = false;
  REQUIRE(cache.feet(70, *trough, e6.startPoint, 1e-7).size() == 2);
  Pcurve d4 = projectCurve(*fromPlane, {0, 1}, *trough, 1e-7, &e6);
  REQUIRE(!d4.pieces.empty());
  CHECK(project::at(d4.pieces.front(), 0.5).x > 0.5);
  const double lr5[7] = {-0.9, 2, 0.2, 1, 0, 0, 1.2};
  std::unique_ptr<Curve> offStart = curves::makeLine(lr5, 3);
  PcurveEnds e7 = ends(cache, *offStart, 80);
  e7.checkEnd = false, e7.startPoint = {1.4, 2.5, 0.2};
  Pcurve d5 = projectCurve(*offStart, {0, 1}, *trough, 1e-7, &e7);
  REQUIRE(!d5.pieces.empty());
  CHECK(d5.endCheck[0] == EndCheck::vertexOff);
  CHECK(project::at(d5.pieces.front(), 0).x < 0.5);
  if (d2.endCheck[1] != EndCheck::different || d2.tAmbiguous.size() != 1)
    std::printf("    short line: check %d certainty %d ambiguous %zu\n", int(d2.endCheck[1]), int(d2.certainty),
      d2.tAmbiguous.size());
  // A small circle on a sphere of radius 10 through its north pole and the equator's points at u = 1.5 and 1.5 + pi / 2
  // (equilateral: its centre their centroid), traced from the first to the pole: the end search's foot there a pole's
  // (its u 0), the trace's u past pi from it (1.5 + 3 pi / 4), the same foot all the same.
  {
    const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, 10};
    std::unique_ptr<Surface> sph = closeInFact(surfaces::makeSphere(sr), tol);
    const double f = 1.5;
    const Vec3 a{10 * std::cos(f), 10 * std::sin(f), 0}, b{-10 * std::sin(f), 10 * std::cos(f), 0}, pole{0, 0, 10};
    const Vec3 ctr = (1.0 / 3) * (a + b + pole), n = (1 / norm(ctr)) * ctr, x = (1 / norm(a - ctr)) * (a - ctr);
    const Vec3 y{n.y * x.z - n.z * x.y, n.z * x.x - n.x * x.z, n.x * x.y - n.y * x.x};
    const double tp = std::atan2(dot(pole - ctr, y), dot(pole - ctr, x)), rad = norm(a - ctr);
    const double cc[9] = {ctr.x, ctr.y, ctr.z, n.x, n.y, n.z, x.x, x.y, x.z};
    std::unique_ptr<Curve> circ = curves::makeEllipse(cc, 3, rad, rad);
    REQUIRE(circ);
    const double t1 = tp > 0 ? tp : tp + 2 * kPi;
    PcurveEnds pe;
    pe.cache = &cache, pe.checkStart = pe.checkEnd = true, pe.startKey = 40, pe.endKey = 41;
    pe.startPoint = a, pe.endPoint = pole;
    Pcurve k = projectCurve(*circ, {0, t1}, *sph, tol, &pe);
    const std::vector<EndFoot>& pf = cache.feet(41, *sph, pole, tol);
    REQUIRE(pf.size() == 1);
    CHECK(pf[0].kind == EndFoot::Kind::pole);
    REQUIRE(!k.pieces.empty());
    CHECK(std::fabs(project::at(k.pieces.back(), t1).x - pf[0].uv.x) > kPi);
    CHECK(k.endCheck[0] == EndCheck::same);
    CHECK(k.endCheck[1] == EndCheck::same);
  }
  if (p.endCheck[1] != EndCheck::seamOther || q.endCheck[1] != EndCheck::periods
    || d.endCheck[1] != EndCheck::different)
    std::printf("    checks %d %d / %d %d / %d %d; methods %d %d %d\n", int(p.endCheck[0]), int(p.endCheck[1]),
      int(q.endCheck[0]), int(q.endCheck[1]), int(d.endCheck[0]), int(d.endCheck[1]), int(p.method), int(q.method),
      int(d.method));
}

TEST_CASE("a trace from a crease leaves along the span it goes into; beside a pole its feet don't slip whole turns") {
  // A polyline's extrusion with a right angle at u = 1 (degree 1: (0, 0) to (10, 0) to (10, 10), z 0 to 3), as
  // trj3_s1-al and trj5_k1-al's faces: from the corner along either leg, seeded there, and back into it. At u = 1 the
  // evaluation gives the second leg's S_u, across the first leg, so a rate from it doesn't move along the first.
  const double tol = 1e-6;
  const int32_t si[] = {1, 1, 3, 2, 3, 2, 0, 0, 0, 0, 0, 2, 1, 2, 2, 2};
  const double sr[] = {0, 1, 2, 0, 1, 0, 0, 0, 0, 0, 3, 10, 0, 0, 10, 0, 3, 10, 10, 0, 10, 10, 3};
  Status st;
  std::unique_ptr<Surface> bend = surfaces::makeBSpline(sr, si, st);
  REQUIRE(bend);
  struct Leg {
    const char* name;
    double line[7];
    bool atStart;
    double u0, u1;
  };
  for (const Leg& g : {Leg{"along the first leg", {10, 0, 1, -1, 0, 0, 10}, true, 1, 0},
         Leg{"along the second", {10, 0, 1, 0, 1, 0, 10}, true, 1, 2},
         Leg{"into the corner along the first", {0, 0, 1, 1, 0, 0, 10}, false, 0, 1}}) {
    std::unique_ptr<Curve> line = curves::makeLine(g.line, 3);
    PcurveEnds e;
    (g.atStart ? e.hasStart : e.hasEnd) = true;
    (g.atStart ? e.start : e.end) = {1, 1.0 / 3};
    Pcurve p = projectCurve(*line, {0, 1}, *bend, tol, &e);
    CHECK(p.status == Status::ok);
    CHECK(p.error <= tol);
    REQUIRE(!p.pieces.empty());
    const Vec2 mid = project::at(p.pieces.front(), 0.5);
    CHECK(std::fabs(mid.x - 0.5 * (g.u0 + g.u1)) < 1e-6);
    CHECK(std::fabs(mid.y - 1.0 / 3) < 1e-6);
    if (!(p.status == Status::ok) || !(std::fabs(mid.x - 0.5 * (g.u0 + g.u1)) < 1e-6))
      std::printf("    %s: status %d error %g mid (%g, %g)\n", g.name, int(p.status), p.error, mid.x, mid.y);
  }
  // A closed square's extrusion (degree 1, its corners at u = 0, 1, 2, 3; z 0 to 3), closed in fact so u is periodic,
  // a corner on its seam u = 0 (as trj3_s1-al #6704 face #1306's coedges 87 and 89): from that corner along the last
  // leg (u from 4, or 0, down), seeded there; and a local foot from it. The seam is a break too.
  {
    const int32_t qi[] = {1, 1, 5, 2, 5, 2, 0, 0, 0, 0, 0, 2, 1, 1, 1, 2, 2, 2};
    const double qr[] = {0, 1, 2, 3, 4, 0, 1, 0, 0, 0, 0, 0, 3, 10, 0, 0, 10, 0, 3, 10, 10, 0, 10, 10, 3, 0, 10, 0, 0,
      10, 3, 0, 0, 0, 0, 0, 3};
    std::unique_ptr<Surface> box = closeInFact(surfaces::makeBSpline(qr, qi, st), tol);
    REQUIRE(box);
    REQUIRE(box->domain().uPeriod == 4);
    const double down[7] = {0, 0, 1, 0, 1, 0, 10};
    std::unique_ptr<Curve> leg = curves::makeLine(down, 3);
    // (From the seam's value itself and from a hair below its other end, which reduces to just under the period.)
    for (double u0 : {0.0, 4 - 1e-14}) {
      PcurveEnds e;
      e.hasStart = true, e.start = {u0, 1.0 / 3};
      Pcurve p = projectCurve(*leg, {0, 1}, *box, tol, &e);
      CHECK(p.status == Status::ok);
      CHECK(p.error <= tol);
      REQUIRE(!p.pieces.empty());
      const double mid = project::at(p.pieces.front(), 0.5).x;
      CHECK(std::fabs(std::remainder(mid - 3.5, 4.0)) < 1e-6);
      if (!(p.status == Status::ok) || !(std::fabs(std::remainder(mid - 3.5, 4.0)) < 1e-6))
        std::printf("    seam corner from %.17g: status %d error %g mid u %g\n", u0, int(p.status), p.error, mid);
    }
    for (double start : {0.0, 4.0, 4 - 1e-14}) {
      LocalFoot f = localFoot(*box, {0, 2, 1}, {start, 1.0 / 3});
      CHECK(f.status == Status::ok);
      CHECK(std::fabs(std::remainder(f.uv.x - 3.8, 4.0)) < 1e-9);
      CHECK(f.distance < 1e-9);
    }
    // Along the first leg from a hair below the seam's other end: the evaluation there gives the last leg's S_u,
    // across the first, so the seam is found as a break from below.
    const double along[7] = {0, 0, 1, 1, 0, 0, 10};
    std::unique_ptr<Curve> first = curves::makeLine(along, 3);
    PcurveEnds ea;
    ea.hasStart = true, ea.start = {4 - 1e-14, 1.0 / 3};
    Pcurve pa = projectCurve(*first, {0, 1}, *box, tol, &ea);
    CHECK(pa.status == Status::ok);
    CHECK(pa.error <= tol);
    LocalFoot fa = localFoot(*box, {2, 0, 1}, {4 - 1e-14, 1.0 / 3});
    CHECK(fa.status == Status::ok);
    CHECK(std::fabs(std::remainder(fa.uv.x - 0.2, 4.0)) < 1e-9);
    CHECK(fa.distance < 1e-9);
  }
  // A great circle of a sphere of radius 10 passing 3e-3 beside its north pole (tilted 3e-4 from a meridian), from
  // (0, -10, 0) over the top, seeded at its start: the feet's u swings by pi beside the pole, where Newton's steps in
  // u are huge and could land whole turns on (the same point in 3D).
  const double sp[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, 10};
  std::unique_ptr<Surface> sph = closeInFact(surfaces::makeSphere(sp), 1e-5);
  const double dl = 3e-4;
  const Vec3 a{0, -10, 0}, c{10 * std::sin(dl), 0, 10 * std::cos(dl)};
  Vec3 n{a.y * c.z - a.z * c.y, a.z * c.x - a.x * c.z, a.x * c.y - a.y * c.x};
  n = (1 / norm(n)) * n;
  const double gc[9] = {0, 0, 0, n.x, n.y, n.z, 0, -1, 0};
  std::unique_ptr<Curve> great = curves::makeEllipse(gc, 3, 10, 10);
  REQUIRE(great);
  PcurveEnds ge;
  ge.hasStart = true, ge.start = {1.5 * kPi, 0};
  Pcurve q = projectCurve(*great, {0, kPi}, *sph, 1e-5, &ge);
  CHECK(q.status == Status::ok);
  CHECK(q.error <= 1e-5);
  double far = 0;
  for (int i = 0; i <= 64; i++) {
    const double t = kPi * i / 64;
    for (const PcurvePiece& k : q.pieces)
      if (t >= k.t.lo && t <= k.t.hi) far = std::fmax(far, std::fabs(project::at(k, t).x - 1.5 * kPi));
  }
  // u from 3 pi / 2 to pi / 2 (or 5 pi / 2): within a turn of the start.
  CHECK(far < 2 * kPi);
  if (!(q.status == Status::ok) || !(far < 2 * kPi))
    std::printf("    near pass: status %d error %g farthest u from the start %g\n", int(q.status), q.error, far);
}

// as1_motor #9410 face #9576 coedge 22 (the corpus): a degree-8 curve of 37 poles about 9.2e-4 off its cylinder
// (radius 2000), at its part's uncertainty 1e-3.
const double kMotorCurveR[] = {
    0.0, 0.165647338201, 0.368132933061, 0.724351783416, 0.872667147468, 1.0, 26000.0, 0.0, 42000.0, 26000.0,
    -114.8593700252, 42000.0, 25999.42004739, -220.3289353976, 41992.46051089, 25998.42652421, -315.5219937196,
    41979.54546801, 25997.18947108, -401.1724017452, 41963.30244576, 25995.81169684, -478.2920170648, 41944.99629709,
    25994.35760063, -548.4049200214, 41925.44384793, 25992.83449122, -613.5893361066, 41904.7178713, 25989.20731895,
    -752.9827225542, 41854.62992364, 25987.11780848, -823.3538163494, 41825.31715302, 25984.96291713, -889.1157100965,
    41794.54051335, 25982.75945369, -951.0368735839, 41762.44728225, 25980.51976241, -1009.679076901, 41729.12860462,
    25978.2530431, -1065.517823516, 41694.63197181, 25975.96467443, -1118.876289489, 41658.94542223, 25969.59995656,
    -1260.162348664, 41557.02541939, 25965.49627375, -1343.315539754, 41488.34648749, 25961.36793468, -1421.200887696,
    41415.72945185, 25957.2331865, -1494.527734853, 41338.71190918, 25953.11108152, -1563.832954342, 41256.81791074,
    25949.02572471, -1629.346075575, 41169.02461037, 25945.00271348, -1691.219371057, 41074.30574482, 25939.45528501,
    -1773.484374543, 40925.87634277, 25937.84506207, -1796.979403466, 40880.54076817, 25936.25756198, -1819.791245418,
    40833.28860351, 25934.69760955, -1841.885595952, 40783.82333402, 25933.17194364, -1863.201625114, 40731.82546878,
    25931.68972664, -1883.648188424, 40676.91456872, 25930.26433408, -1903.082862946, 40618.51337423, 25927.75915252,
    -1936.891975885, 40501.61341725, 25926.68341288, -1951.264073174, 40445.3877704, 25925.67118514, -1964.673095387,
    40385.35912177, 25924.73850098, -1976.927211152, 40320.12932072, 25923.92387011, -1987.544531562, 40248.88015864,
    25923.2995741, -1995.634310458, 40171.19892769, 25922.96270096, -2000.001301818, 40087.34837362, 25922.96279363,
    -2000.0, 40000.0};
const int32_t kMotorCurveI[] = {
    8, 37, 6, 0, 0, 0, 0, 9, 7, 7, 7, 7, 9};
const double kMotorCylR[10] = {38500.0, 0.0, 40000.0, -1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 2000.0};
// bug32239 #116154 face #13824 coedge 2157 (the corpus): a cubic of 38 poles on a 2 x 58 B-spline surface, at its
// part's uncertainty 2.54e-4.
const double k32239CurveR[] = {
    0.0, 0.06249999999999907, 0.09374999999999907, 0.12499999999999908, 0.24999999999997263, 0.3749999999999462,
    0.43749999999993056, 0.4687499999999258, 0.49999999999992106, 0.6249999999999136, 0.6874999999999147,
    0.7187499999999124, 0.7343749999999113, 0.7499999999999102, 0.7812499999999121, 0.8124999999999141,
    0.8437499999999161, 0.8749999999999181, 0.9062499999999201, 0.9218749999999214, 0.9296874999999221,
    0.9374999999999227, 1.0, -57.62064705882353, 16.82211376822255, 9.876605702820019, -57.62109857711031,
    16.809799745071146, 9.897579294824238, -57.621949674072894, 16.79358975376787, 9.92505597740325,
    -57.623061500334124, 16.780829417635456, 9.946591042203202, -57.62386065768578, 16.773093815101912,
    9.959630172571998, -57.62412141968754, 16.7707465109018, 9.96358277757799, -57.627247945268145,
    16.749601184552095, 9.999140329830057, -57.63218754333284, 16.73062556460011, 10.03087671884685,
    -57.64602373733391, 16.691097100436796, 10.096514107123548, -57.6582205270035, 16.662512746747566,
    10.143651099071336, -57.675634492246786, 16.631082931614845, 10.195019556664803, -57.683779986771505,
    16.618030057231397, 10.216261366676132, -57.68936195346868, 16.609421461792596, 10.230251121054112,
    -57.69165745623139, 16.60598131025911, 10.235835493102282, -57.709227053509444, 16.580840586861523,
    10.276577452125393, -57.732021437545306, 16.552821303661496, 10.321663957799968, -57.76160890336593,
    16.524000459228827, 10.36767269489661, -57.777151140720946, 16.510568401966765, 10.389035982398394,
    -57.78397249339699, 16.50502261774911, 10.397840734749275, -57.788555704916426, 16.501372398995592,
    10.403632659186284, -57.79002260236921, 16.500214489707464, 10.405469438300555, -57.79953193837888,
    16.492949112631234, 10.416984390849144, -57.80571355355937, 16.48871128944257, 10.423689265982501,
    -57.81776089960186, 16.481454257671512, 10.435159962963246, -57.82232925116512, 16.478982246453565,
    10.439062525768943, -57.83633958716811, 16.473073086283193, 10.448384822058259, -57.84386729467691,
    16.470479507867005, 10.452472145381936, -57.85996778870917, 16.46601691281296, 10.45950076227397,
    -57.87031860813938, 16.463853526294326, 10.462905141704802, -57.88495319438742, 16.46143063485945,
    10.466716695950907, -57.897160044128874, 16.45988366577335, 10.469149227135514, -57.91355546142419,
    16.45855237634985, 10.471241863428967, -57.92104366010726, 16.45808333798161, 10.471979027532036,
    -57.92613836840059, 16.457793209218455, 10.47243498884675, -57.9298693768394, 16.45760708055064,
    10.47272748806555, -57.94352744934223, 16.456975706608187, 10.47371966041098, -57.96173364076056,
    16.456504091879964, 10.47446062668002, -57.98600551470587, 16.45612214081291, 10.475060664580756};
const int32_t k32239CurveI[] = {
    3, 38, 23, 0, 0, 0, 0, 4, 1, 2, 2, 2, 1, 1, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 1, 1, 2, 2, 4};
const double k32239SurfR[] = {
    0.0, 1.0, 0.0, 0.0625, 0.09375, 0.109375, 0.125, 0.25, 0.375, 0.4375, 0.46875, 0.484375, 0.5, 0.625, 0.6875,
    0.71875, 0.734375, 0.7421875, 0.75, 0.78125, 0.796875, 0.8125, 0.84375, 0.859375, 0.875, 0.90625, 0.921875,
    0.9296875, 0.93359375, 0.9375, 1.0, -57.62064705882353, 16.82211376822255, 9.876605702820019, -57.62109843653827,
    16.809803578818716, 9.897572765077099, -57.62166576406797, 16.798998862061087, 9.915887294658212,
    -57.62269068056301, 16.78508873287028, 9.939402950461583, -57.62306130690154, 16.780834731034016,
    9.946582079441372, -57.623660727669616, 16.775031583522278, 9.956363873682257, -57.62386778146902,
    16.77319350295294, 9.959459984391762, -57.62429638282126, 16.769710490784583, 9.965323553376127,
    -57.624434401295716, 16.76863074994521, 9.967140598323933, -57.627245312867075, 16.74961101112503,
    9.999123805664155, -57.63219014288681, 16.73062048198523, 10.030885158576883, -57.64602113777995,
    16.691102183051672, 10.096505667393519, -57.65415103111602, 16.672048537230147, 10.127926138233217,
    -57.668167464954436, 16.644560586888698, 10.172991906106462, -57.673143208539614, 16.63557999096548,
    10.18766965836258, -57.68106222237596, 16.622386173235732, 10.209172369186172, -57.683777793397816,
    16.618034411361787, 10.216254285618954, -57.68796499954527, 16.611576516110933, 10.226748963419382,
    -57.68937970986354, 16.609435508830327, 10.23022582315298, -57.69224708037161, 16.605176821977697,
    10.237136856834256, -57.69341530941901, 16.603466176312395, 10.239911409398504, -57.70921990583088,
    16.580849079717247, 10.276563688974099, -57.72441258801549, 16.562173881911203, 10.30661452608155,
    -57.74891783935352, 16.53636521096317, 10.347934149414606, -57.757372294476376, 16.52812956738607,
    10.361081194854348, -57.77048303417594, 16.516333609825793, 10.379866598353036, -57.77492479024502,
    16.51249453529754, 10.38597253504934, -57.78169468860244, 16.506876060607535, 10.394898119702722,
    -57.78396919876388, 16.505026591481716, 10.397834427620772, -57.7874077800695, 16.502287514003104,
    10.402180616467422, -57.78855844318195, 16.501380342519514, 10.403619633896467, -57.79086870809466,
    16.49957772335458, 10.406478253773791, -57.791609035083454, 16.49900268373949, 10.407390038989682,
    -57.7995257648617, 16.49295275178566, 10.416978623125031, -57.805704293283625, 16.488716755713728,
    10.423680619157267, -57.81473980281551, 16.48327398639694, 10.432283644747063, -57.81771292547596,
    16.481611584779625, 10.434909648638484, -57.82358174309653, 16.478591183188975, 10.439678751001733,
    -57.82583771641409, 16.477503116816056, 10.441396001987824, -57.83632782467163, 16.473076765473017,
    10.448379017765152, -57.843849650932206, 16.470485031272403, 10.452463441872629, -57.85592502145639,
    16.46713808776747, 10.457734906310291, -57.860082250153354, 16.466112544006652, 10.459349529019685,
    -57.868660917925055, 16.464241915954087, 10.46229386965583, -57.873992134286226, 16.463246035851586,
    10.463860810928423, -57.88492343521773, 16.46143417002749, 10.466711134626715, -57.893046455460514,
    16.460404626672773, 10.468330042556142, -57.90648421525737, 16.459128235695477, 10.47033667984703,
    -57.9111723400951, 16.45874742469412, 10.470935270654214, -57.918517834709874, 16.45824322167847,
    10.47172774637027, -57.92101855080782, 16.45808632283658, 10.471974336472913, -57.924847951794284,
    16.45786773137166, 10.472317871182923, -57.92613747326304, 16.457797660344383, 10.472427991008932,
    -57.92874262514705, 16.457663104407484, 10.472639447509358, -57.930633186660074, 16.457571925114618,
    10.47278273306232, -57.94344700110288, 16.45697697230238, 10.473717671436297, -57.96165319252126,
    16.45650535784282, 10.474458637876323, -57.98600551470587, 16.45612214081291, 10.475060664580756,
    -57.62064705882353, 16.71259479837735, 9.812304884442284, -57.62109843653827, 16.700364753435792,
    9.83313544238777, -57.62166576406797, 16.68963037988621, 9.851330736750283, -57.62269068056301, 16.67581081143232,
    9.874693295836183, -57.62306130690154, 16.67158450492051, 9.881825685695008, -57.623660727669616,
    16.665819138317055, 9.891543796379636, -57.62386778146902, 16.66399302441809, 9.894619750118379,
    -57.62429638282126, 16.6605326881102, 9.9004451448255, -57.624434401295716, 16.659459976833592, 9.902250360053593,
    -57.627245312867075, 16.640564064438017, 9.934025343387697, -57.63219014288681, 16.62169717155564,
    9.965579916659063, -57.64602113777995, 16.582436153214097, 10.030773208621426, -57.65415103111602,
    16.563506554565887, 10.061989119104092, -57.668167464954436, 16.536197562234474, 10.10676149005108,
    -57.673143208539614, 16.527275433732633, 10.12134368402428, -57.68106222237596, 16.514167513253728,
    10.142706403240949, -57.683777793397816, 16.50984408316282, 10.149742213446954, -57.68796499954527,
    16.50342823150084, 10.16016856652212, -57.68937970986354, 16.501301163069712, 10.16362279045016,
    -57.69224708037161, 16.497070202042945, 10.170488830422576, -57.69341530941901, 16.495370693393692,
    10.173245319493565, -57.70921990583088, 16.472900843521167, 10.20965897745734, -57.72441258801549,
    16.454347229034173, 10.23951417109404, -57.74891783935352, 16.428706583287624, 10.280564786462689,
    -57.757372294476376, 16.420524557181732, 10.29362623915868, -57.77048303417594, 16.40880539622016,
    10.312289341853344, -57.77492479024502, 16.404991315666702, 10.318355526357614, -57.78169468860244,
    16.399409419587958, 10.327223001735907, -57.78396919876388, 16.397571991276756, 10.330140193065949,
    -57.7874077800695, 16.394850746333812, 10.334458086412296, -57.78855844318195, 16.393949480914568,
    10.335887735238288, -57.79086870809466, 16.392158597551493, 10.338727744309118, -57.791609035083454,
    16.391587301683895, 10.339633593423343, -57.7995257648617, 16.385576757307888, 10.349159751880729,
    -57.805704293283625, 16.38136833933538, 10.355818115126295, -57.81473980281551, 16.375961004714668,
    10.364365131434909, -57.81771292547596, 16.37430942602455, 10.366974038946827, -57.82358174309653,
    16.371308688506755, 10.371712092466565, -57.82583771641409, 16.370227705899286, 10.373418163433215,
    -57.83632782467163, 16.365830171947803, 10.380355716868243, -57.843849650932206, 16.363255311016726,
    10.384413549672939, -57.85592502145639, 16.359930157508565, 10.389650694680668, -57.860082250153354,
    16.358911290464942, 10.391254805523463, -57.868660917925055, 16.357052840980426, 10.394179977275261,
    -57.873992134286226, 16.356063444472344, 10.395736717107274, -57.88492343521773, 16.35426337464971,
    10.398568484010655, -57.893046455460514, 16.35324053405121, 10.400176852174917, -57.90648421525737,
    16.351972452911, 10.402170425420943, -57.9111723400951, 16.35159412114793, 10.402765119152559,
    -57.918517834709874, 16.351093200703996, 10.403552435521503, -57.92101855080782, 16.350937323338943,
    10.403797420219833, -57.924847951794284, 16.35072015499554, 10.404138718375743, -57.92613747326304,
    16.35065054015985, 10.4042481212758, -57.92874262514705, 16.350516860238166, 10.404458201106303,
    -57.930633186660074, 16.350426274560483, 10.404600553810614, -57.94344700110288, 16.349835195138954,
    10.405529405346218, -57.961653192521226, 16.34936665108603, 10.40626554778598, -57.98600551470587,
    16.348985928958655, 10.406863655045724};
const int32_t k32239SurfI[] = {
    1, 3, 2, 58, 2, 29, 0, 0, 0, 0, 0, 2, 2, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 4};

TEST_CASE("the fit's tightening: a curve off its surface by under tol, and a fit whose samples miss its worst") {
  // The motor's curve is off its cylinder by about 0.92 tol, so a p-curve within tol exists and the tightening goes
  // on to it (it stops at the curve's distance only where that's past tol). bug32239's first fit is within its own
  // estimate (5.9e-5) but 8.8e-4 off where measured, so the next round asks less than that estimate (a round at
  // tol / 4 alone would come back the same fit).
  Status st;
  struct Case {
    const char* name;
    const double *cr, *sr;
    const int32_t *ci, *si;
    double tol;
    bool cylinder;
  };
  for (const Case& c : {Case{"motor", kMotorCurveR, kMotorCylR, kMotorCurveI, nullptr, 1e-3, true},
         Case{"bug32239", k32239CurveR, k32239SurfR, k32239CurveI, k32239SurfI, 2.54e-4, false}}) {
    std::unique_ptr<Curve> cv = curves::makeBSpline(c.cr, c.ci, 3, st);
    REQUIRE(cv);
    std::unique_ptr<Surface> s0 =
      c.cylinder ? surfaces::makeCone(c.sr, c.sr[9], 0) : surfaces::makeBSpline(c.sr, c.si, st);
    REQUIRE(s0);
    std::unique_ptr<Surface> sf = closeInFact(std::move(s0), c.tol);
    const Range r = cv->domain().range;
    Pcurve p = projectCurve(*cv, r, *sf, c.tol);
    CHECK(p.status == Status::ok);
    CHECK(p.error <= c.tol);
    if (!(p.status == Status::ok))
      std::printf("    %s: status %d error %g offSurface %g\n", c.name, int(p.status), p.error, p.offSurface);
  }
}

// 2.stp #327 face #3127 coedge 333 (the corpus): a cubic of 19 poles 1.17e-3 off a rational 2 x 183 B-spline
// surface, at its part's uncertainty 1e-3.
const double k2stpCurveR[] = {
    0.0, 0.0347931765367004, 0.0722217416336851, 0.112285599899514, 0.154984632845143, 0.200318701647516,
    0.248287649154177, 0.375544733077373, 0.502801851894884, 0.557958161212391, 0.626480273973786, 0.686957550403645,
    0.747434045119667, 0.784762578704308, 0.839306825935, 0.911056973046492, 1.0, -2.99999713513109e-08, 2.5,
    5.65000000138564, 0.0455274380448201, 2.49927773503239, 5.64787484605683, 0.140030825250598, 2.49777849756475,
    5.64346356676686, 0.286494015420731, 2.48497618919823, 5.63633389544187, 0.44218198081213, 2.46240390939282,
    5.6285317078548, 0.606191179033284, 2.42743722237892, 5.62003044972009, 0.777366606663666, 2.37842148365925,
    5.61084601270555, 1.04834144172619, 2.27885574501461, 5.59566380394337, 1.40002053588091, 2.09144116323554,
    5.57473255389825, 1.71459767656529, 1.83172677018951, 5.55303878335612, 1.93552039818095, 1.58855164202268,
    5.53616325574977, 2.07979131075698, 1.39496014797666, 5.52455803628417, 2.20723582626848, 1.18193038197491,
    5.51271380890481, 2.29633720417659, 0.99462374200022, 5.50304698804788, 2.3680113483695, 0.808527455541763,
    5.49323866787359, 2.42999860561727, 0.603504701994374, 5.48216587186212, 2.48701473899373, 0.326793743203245,
    5.46739691851403, 2.49537347381923, 0.116433532441911, 5.45619836261032, 2.5, 0.0, 5.45000000685949};
const int32_t k2stpCurveI[] = {
    3, 19, 17, 0, 0, 0, 0, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4};
const double k2stpSurfR[] = {
    0.0, 1.0, 0.0, 0.00980392156862745, 0.0196078431372549, 0.0294117647058824, 0.0392156862745098,
    0.0490196078431373, 0.0588235294117647, 0.0686274509803922, 0.0784313725490196, 0.0882352941176471,
    0.0980392156862745, 0.107843137254902, 0.117647058823529, 0.127450980392157, 0.137254901960784, 0.147058823529412,
    0.156862745098039, 0.166666666666667, 0.176470588235294, 0.186274509803922, 0.196078431372549, 0.205882352941176,
    0.215686274509804, 0.225490196078431, 0.235294117647059, 0.245098039215686, 0.254901960784314, 0.264705882352941,
    0.274509803921569, 0.284313725490196, 0.294117647058824, 0.303921568627451, 0.313725490196078, 0.323529411764706,
    0.333333333333333, 0.343137254901961, 0.352941176470588, 0.362745098039216, 0.372549019607843, 0.382352941176471,
    0.392156862745098, 0.401960784313726, 0.411764705882353, 0.42156862745098, 0.431372549019608, 0.441176470588235,
    0.450980392156863, 0.46078431372549, 0.470588235294118, 0.480392156862745, 0.490196078431373, 0.5,
    0.509803921568627, 0.519607843137255, 0.529411764705882, 0.53921568627451, 0.549019607843137, 0.558823529411765,
    0.568627450980392, 0.57843137254902, 0.588235294117647, 0.598039215686274, 0.607843137254902, 0.617647058823529,
    0.627450980392157, 0.637254901960784, 0.647058823529412, 0.656862745098039, 0.666666666666667, 0.676470588235294,
    0.686274509803922, 0.696078431372549, 0.705882352941177, 0.715686274509804, 0.725490196078431, 0.735294117647059,
    0.745098039215686, 0.754901960784314, 0.764705882352941, 0.774509803921569, 0.784313725490196, 0.794117647058823,
    0.803921568627451, 0.813725490196078, 0.823529411764706, 0.833333333333333, 0.843137254901961, 0.852941176470588,
    0.862745098039216, 0.872549019607843, 0.882352941176471, 0.883870473227216, 0.0, 2.5, 0.05, -1.443375673, 2.5,
    0.116666667, -2.165063509, 1.25, 0.183333333, -2.886751346, 0.0, 0.25, -2.165063509, -1.25, 0.316666667,
    -1.443375673, -2.5, 0.383333333, 0.0, -2.5, 0.45, 1.443375673, -2.5, 0.516666667, 2.165063509, -1.25, 0.583333333,
    2.886751346, 0.0, 0.65, 2.165063509, 1.25, 0.716666667, 1.443375673, 2.5, 0.783333333, 0.0, 2.5, 0.85,
    -1.443375673, 2.5, 0.916666667, -2.165063509, 1.25, 0.983333333, -2.886751346, 0.0, 1.05, -2.165063509, -1.25,
    1.116666667, -1.443375673, -2.5, 1.183333333, 0.0, -2.5, 1.25, 1.443375673, -2.5, 1.316666667, 2.165063509, -1.25,
    1.383333333, 2.886751346, 0.0, 1.45, 2.165063509, 1.25, 1.516666667, 1.443375673, 2.5, 1.583333333, 0.0, 2.5,
    1.65, -1.443375673, 2.5, 1.716666667, -2.165063509, 1.25, 1.783333333, -2.886751346, 0.0, 1.85, -2.165063509,
    -1.25, 1.916666667, -1.443375673, -2.5, 1.983333333, 0.0, -2.5, 2.05, 1.443375673, -2.5, 2.116666667, 2.165063509,
    -1.25, 2.183333333, 2.886751346, 0.0, 2.25, 2.165063509, 1.25, 2.316666667, 1.443375673, 2.5, 2.383333333, 0.0,
    2.5, 2.45, -1.443375673, 2.5, 2.516666667, -2.165063509, 1.25, 2.583333333, -2.886751346, 0.0, 2.65, -2.165063509,
    -1.25, 2.716666667, -1.443375673, -2.5, 2.783333333, 0.0, -2.5, 2.85, 1.443375673, -2.5, 2.916666667, 2.165063509,
    -1.25, 2.983333333, 2.886751346, 0.0, 3.05, 2.165063509, 1.25, 3.116666667, 1.443375673, 2.5, 3.183333333, 0.0,
    2.5, 3.25, -1.443375673, 2.5, 3.316666667, -2.165063509, 1.25, 3.383333333, -2.886751346, 0.0, 3.45, -2.165063509,
    -1.25, 3.516666667, -1.443375673, -2.5, 3.583333333, 0.0, -2.5, 3.65, 1.443375673, -2.5, 3.716666667, 2.165063509,
    -1.25, 3.783333333, 2.886751346, 0.0, 3.85, 2.165063509, 1.25, 3.916666667, 1.443375673, 2.5, 3.983333333, 0.0,
    2.5, 4.05, -1.443375673, 2.5, 4.116666667, -2.165063509, 1.25, 4.183333333, -2.886751346, 0.0, 4.25, -2.165063509,
    -1.25, 4.316666667, -1.443375673, -2.5, 4.383333333, 0.0, -2.5, 4.45, 1.443375673, -2.5, 4.516666667, 2.165063509,
    -1.25, 4.583333333, 2.886751346, 0.0, 4.65, 2.165063509, 1.25, 4.716666667, 1.443375673, 2.5, 4.783333333, 0.0,
    2.5, 4.85, -1.443375673, 2.5, 4.916666667, -2.165063509, 1.25, 4.983333333, -2.886751346, 0.0, 5.05, -2.165063509,
    -1.25, 5.116666667, -1.443375673, -2.5, 5.183333333, 0.0, -2.5, 5.25, 1.443375673, -2.5, 5.316666667, 2.165063509,
    -1.25, 5.383333333, 2.886751346, 0.0, 5.45, 2.165063509, 1.25, 5.516666667, 1.443375673, 2.5, 5.583333333, 0.0,
    2.5, 5.65, -1.443375673, 2.5, 5.716666667, -2.165063509, 1.25, 5.783333333, -2.886751346, 0.0, 5.85, -2.165063509,
    -1.25, 5.916666667, -1.443375673, -2.5, 5.983333333, 0.0, -2.5, 6.05, 1.443375673, -2.5, 6.116666667, 2.165063509,
    -1.25, 6.183333333, 2.886751346, 0.0, 6.25, 2.165063509, 1.25, 6.316666667, 1.443375673, 2.5, 6.38333333300001,
    0.0, 2.5, 6.45, -1.443375673, 2.5, 6.516666667, -2.165063509, 1.25, 6.583333333, -2.886751346, 0.0, 6.65,
    -2.165063509, -1.25, 6.716666667, -1.443375673, -2.5, 6.783333333, 0.0, -2.5, 6.85, 1.443375673, -2.5,
    6.91666666700001, 2.165063509, -1.25, 6.983333333, 2.886751346, 0.0, 7.05000000000001, 2.165063509, 1.25,
    7.116666667, 1.443375673, 2.5, 7.18333333300001, 0.0, 2.5, 7.25, -1.443375673, 2.5, 7.316666667, -2.165063509,
    1.25, 7.383333333, -2.886751346, 0.0, 7.45, -2.165063509, -1.25, 7.516666667, -1.443375673, -2.5, 7.583333333,
    0.0, -2.5, 7.65, 1.443375673, -2.5, 7.716666667, 2.165063509, -1.25, 7.783333333, 2.886751346, 0.0,
    7.85000000000001, 2.165063509, 1.25, 7.916666667, 1.443375673, 2.5, 7.98333333300001, 0.0, 2.5, 8.05,
    -1.443375673, 2.5, 8.116666667, -2.165063509, 1.25, 8.183333333, -2.886751346, 0.0, 8.25, -2.165063509, -1.25,
    8.316666667, -1.443375673, -2.5, 8.383333333, 0.0, -2.5, 8.45, 1.443375673, -2.5, 8.516666667, 2.165063509, -1.25,
    8.583333333, 2.886751346, 0.0, 8.65, 2.165063509, 1.25, 8.716666667, 1.443375673, 2.5, 8.783333333, 0.0, 2.5,
    8.85, -1.443375673, 2.5, 8.916666667, -2.165063509, 1.25, 8.983333333, -2.886751346, 0.0, 9.05, -2.165063509,
    -1.25, 9.116666667, -1.443375673, -2.5, 9.183333333, 0.0, -2.5, 9.25, 1.443375673, -2.5, 9.316666667, 2.165063509,
    -1.25, 9.383333333, 2.886751346, 0.0, 9.45, 2.165063509, 1.25, 9.516666667, 1.443375673, 2.5, 9.583333333, 0.0,
    2.5, 9.65, -1.443375673, 2.5, 9.71666666700001, -2.165063509, 1.25, 9.783333333, -2.886751346, 0.0,
    9.84999999999999, -2.165063509, -1.25, 9.916666667, -1.443375673, -2.5, 9.983333333, 0.0, -2.5, 10.05,
    1.443375673, -2.5, 10.116666667, 2.165063509, -1.25, 10.183333333, 2.886751346, 0.0, 10.25, 2.165063509, 1.25,
    10.316666667, 1.443375673, 2.5, 10.383333333, 0.0, 2.5, 10.45, -1.443375673, 2.5, 10.516666667, -2.165063509,
    1.25, 10.583333333, -2.886751346, 0.0, 10.65, -2.165063509, -1.25, 10.716666667, -1.443375673, -2.5, 10.783333333,
    0.0, -2.5, 10.85, 1.443375673, -2.5, 10.916666667, 2.165063509, -1.25, 10.983333333, 2.886751346, 0.0, 11.05,
    2.165063509, 1.25, 11.116666667, 1.443375673, 2.5, 11.183333333, 0.0, 2.5, 11.25, -1.443375673, 2.5, 11.316666667,
    -2.165063509, 1.25, 11.383333333, -2.886751346, 0.0, 11.45, -2.165063509, -1.25, 11.516666667, -1.443375673, -2.5,
    11.583333333, 0.0, -2.5, 11.65, 1.443375673, -2.5, 11.716666667, 2.165063509, -1.25, 11.783333333, 2.886751346,
    0.0, 11.85, 2.165063509, 1.25, 11.916666667, 1.443375673, 2.5, 11.983333333, 0.0, 2.5, 12.05, -0.197582747, 2.5,
    12.059125956, -0.392712522, 2.468962712, 12.068966275, 0.0, 1.980384758, 0.35, -1.143375673, 1.980384758,
    0.416666667, -1.715063509, 0.990192379, 0.483333333, -2.286751346, 0.0, 0.550000000000001, -1.715063509,
    -0.990192379, 0.616666667, -1.143375673, -1.980384758, 0.683333333000001, 0.0, -1.980384758, 0.75, 1.143375673,
    -1.980384758, 0.816666667, 1.715063509, -0.990192379, 0.883333333, 2.286751346, 0.0, 0.95, 1.715063509,
    0.990192379, 1.016666667, 1.143375673, 1.980384758, 1.083333333, 0.0, 1.980384758, 1.15, -1.143375673,
    1.980384758, 1.216666667, -1.715063509, 0.990192379, 1.283333333, -2.286751346, 0.0, 1.35, -1.715063509,
    -0.990192379, 1.416666667, -1.143375673, -1.980384758, 1.483333333, 0.0, -1.980384758, 1.55, 1.143375673,
    -1.980384758, 1.616666667, 1.715063509, -0.990192379, 1.683333333, 2.286751346, 0.0, 1.75, 1.715063509,
    0.990192379, 1.816666667, 1.143375673, 1.980384758, 1.883333333, 0.0, 1.980384758, 1.95, -1.143375673,
    1.980384758, 2.016666667, -1.715063509, 0.990192379, 2.083333333, -2.286751346, 0.0, 2.15, -1.715063509,
    -0.990192379, 2.216666667, -1.143375673, -1.980384758, 2.283333333, 0.0, -1.980384758, 2.35, 1.143375673,
    -1.980384758, 2.416666667, 1.715063509, -0.990192379, 2.483333333, 2.286751346, 0.0, 2.55, 1.715063509,
    0.990192379, 2.616666667, 1.143375673, 1.980384758, 2.683333333, 0.0, 1.980384758, 2.75, -1.143375673,
    1.980384758, 2.816666667, -1.715063509, 0.990192379, 2.883333333, -2.286751346, 0.0, 2.95, -1.715063509,
    -0.990192379, 3.016666667, -1.143375673, -1.980384758, 3.083333333, 0.0, -1.980384758, 3.15, 1.143375673,
    -1.980384758, 3.216666667, 1.715063509, -0.990192379, 3.283333333, 2.286751346, 0.0, 3.35, 1.715063509,
    0.990192379, 3.416666667, 1.143375673, 1.980384758, 3.483333333, 0.0, 1.980384758, 3.55, -1.143375673,
    1.980384758, 3.616666667, -1.715063509, 0.990192379, 3.683333333, -2.286751346, 0.0, 3.75, -1.715063509,
    -0.990192379, 3.816666667, -1.143375673, -1.980384758, 3.883333333, 0.0, -1.980384758, 3.95, 1.143375673,
    -1.980384758, 4.016666667, 1.715063509, -0.990192379, 4.083333333, 2.286751346, 0.0, 4.15, 1.715063509,
    0.990192379, 4.216666667, 1.143375673, 1.980384758, 4.283333333, 0.0, 1.980384758, 4.35, -1.143375673,
    1.980384758, 4.416666667, -1.715063509, 0.990192379, 4.483333333, -2.286751346, 0.0, 4.55, -1.715063509,
    -0.990192379, 4.616666667, -1.143375673, -1.980384758, 4.683333333, 0.0, -1.980384758, 4.75, 1.143375673,
    -1.980384758, 4.816666667, 1.715063509, -0.990192379, 4.883333333, 2.286751346, 0.0, 4.95, 1.715063509,
    0.990192379, 5.016666667, 1.143375673, 1.980384758, 5.083333333, 0.0, 1.980384758, 5.15, -1.143375673,
    1.980384758, 5.216666667, -1.715063509, 0.990192379, 5.283333333, -2.286751346, 0.0, 5.35, -1.715063509,
    -0.990192379, 5.416666667, -1.143375673, -1.980384758, 5.483333333, 0.0, -1.980384758, 5.55, 1.143375673,
    -1.980384758, 5.616666667, 1.715063509, -0.990192379, 5.683333333, 2.286751346, 0.0, 5.75000000000001,
    1.715063509, 0.990192379, 5.816666667, 1.143375673, 1.980384758, 5.88333333300001, 0.0, 1.980384758, 5.95,
    -1.143375673, 1.980384758, 6.016666667, -1.715063509, 0.990192379, 6.083333333, -2.286751346, 0.0, 6.15,
    -1.715063509, -0.990192379, 6.216666667, -1.143375673, -1.980384758, 6.283333333, 0.0, -1.980384758, 6.35,
    1.143375673, -1.980384758, 6.41666666700001, 1.715063509, -0.990192379, 6.483333333, 2.286751346, 0.0,
    6.55000000000001, 1.715063509, 0.990192379, 6.616666667, 1.143375673, 1.980384758, 6.683333333, 0.0, 1.980384758,
    6.75, -1.143375673, 1.980384758, 6.816666667, -1.715063509, 0.990192379, 6.883333333, -2.286751346, 0.0, 6.95,
    -1.715063509, -0.990192379, 7.016666667, -1.143375673, -1.980384758, 7.083333333, 0.0, -1.980384758, 7.15,
    1.143375673, -1.980384758, 7.216666667, 1.715063509, -0.990192379, 7.283333333, 2.286751346, 0.0,
    7.35000000000001, 1.715063509, 0.990192379, 7.416666667, 1.143375673, 1.980384758, 7.48333333300001, 0.0,
    1.980384758, 7.55, -1.143375673, 1.980384758, 7.616666667, -1.715063509, 0.990192379, 7.683333333, -2.286751346,
    0.0, 7.75, -1.715063509, -0.990192379, 7.816666667, -1.143375673, -1.980384758, 7.883333333, 0.0, -1.980384758,
    7.95, 1.143375673, -1.980384758, 8.016666667, 1.715063509, -0.990192379, 8.083333333, 2.286751346, 0.0, 8.15,
    1.715063509, 0.990192379, 8.216666667, 1.143375673, 1.980384758, 8.283333333, 0.0, 1.980384758, 8.35,
    -1.143375673, 1.980384758, 8.416666667, -1.715063509, 0.990192379, 8.483333333, -2.286751346, 0.0, 8.55,
    -1.715063509, -0.990192379, 8.616666667, -1.143375673, -1.980384758, 8.683333333, 0.0, -1.980384758, 8.75,
    1.143375673, -1.980384758, 8.816666667, 1.715063509, -0.990192379, 8.883333333, 2.286751346, 0.0, 8.95,
    1.715063509, 0.990192379, 9.016666667, 1.143375673, 1.980384758, 9.083333333, 0.0, 1.980384758, 9.15,
    -1.143375673, 1.980384758, 9.21666666700001, -1.715063509, 0.990192379, 9.283333333, -2.286751346, 0.0,
    9.35000000000001, -1.715063509, -0.990192379, 9.416666667, -1.143375673, -1.980384758, 9.48333333299999, 0.0,
    -1.980384758, 9.55, 1.143375673, -1.980384758, 9.616666667, 1.715063509, -0.990192379, 9.683333333, 2.286751346,
    0.0, 9.75, 1.715063509, 0.990192379, 9.816666667, 1.143375673, 1.980384758, 9.883333333, 0.0, 1.980384758, 9.95,
    -1.143375673, 1.980384758, 10.016666667, -1.715063509, 0.990192379, 10.083333333, -2.286751346, 0.0, 10.15,
    -1.715063509, -0.990192379, 10.216666667, -1.143375673, -1.980384758, 10.283333333, 0.0, -1.980384758, 10.35,
    1.143375673, -1.980384758, 10.416666667, 1.715063509, -0.990192379, 10.483333333, 2.286751346, 0.0, 10.55,
    1.715063509, 0.990192379, 10.616666667, 1.143375673, 1.980384758, 10.683333333, 0.0, 1.980384758, 10.75,
    -1.143375673, 1.980384758, 10.816666667, -1.715063509, 0.990192379, 10.883333333, -2.286751346, 0.0, 10.95,
    -1.715063509, -0.990192379, 11.016666667, -1.143375673, -1.980384758, 11.083333333, 0.0, -1.980384758, 11.15,
    1.143375673, -1.980384758, 11.216666667, 1.715063509, -0.990192379, 11.283333333, 2.286751346, 0.0, 11.35,
    1.715063509, 0.990192379, 11.416666667, 1.143375673, 1.980384758, 11.483333333, 0.0, 1.980384758, 11.55,
    -1.143375673, 1.980384758, 11.616666667, -1.715063509, 0.990192379, 11.683333333, -2.286751346, 0.0, 11.75,
    -1.715063509, -0.990192379, 11.816666667, -1.143375673, -1.980384758, 11.883333333, 0.0, -1.980384758, 11.95,
    1.143375673, -1.980384758, 12.016666667, 1.715063509, -0.990192379, 12.083333333, 2.286751346, 0.0, 12.15,
    1.715063509, 0.990192379, 12.216666667, 1.143375673, 1.980384758, 12.283333333, 0.0, 1.980384758, 12.35,
    -0.156515945, 1.980384758, 12.359125956, -0.311088757, 1.955798449, 12.368966275, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.979262304138234, 0.964944512374751,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0,
    0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439, 1.0, 0.866025403784439,
    1.0, 0.979262304138234, 0.964944512374751};
const int32_t k2stpSurfI[] = {
    1, 2, 2, 183, 2, 92, 1, 0, 0, 0, 0, 2, 2, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3};

TEST_CASE("the fit's tightening: a curve its nodes put within tol, found farther off by its first fit, refitted") {
  // Its nodes are within tol (1e-3), so the first fit is at the full tolerance; that fit finds the curve 1.17e-3 off
  // where it's worst, and the stop at the curve's own distance waits for a fit at a quarter of the tolerance, as one
  // that far off is fitted from the start: its error stays near its distance (1.18e-3), not 1.41e-3 (healing grows
  // the edge's tolerance to the error).
  Status st;
  std::unique_ptr<Curve> cv = curves::makeBSpline(k2stpCurveR, k2stpCurveI, 3, st);
  REQUIRE(cv);
  std::unique_ptr<Surface> s0 = surfaces::makeBSpline(k2stpSurfR, k2stpSurfI, st);
  REQUIRE(s0);
  std::unique_ptr<Surface> sf = closeInFact(std::move(s0), 1e-3);
  Pcurve p = projectCurve(*cv, cv->domain().range, *sf, 1e-3);
  CHECK(p.status == Status::invalidModel);
  CHECK(p.offSurface > 1.1e-3);
  CHECK(p.error <= 1.02 * p.offSurface);
  if (!(p.error <= 1.02 * p.offSurface))
    std::printf("    2.stp: status %d error %g offSurface %g\n", int(p.status), p.error, p.offSurface);
}

// OCC623 #11 face #4146 coedge 52 (the corpus): its edge curve, a cubic of 20 poles 2e-5 off its cylinder in places
// (radius 0.75 about z through (3.875, 3.25)), at its part's uncertainty 2e-5.
const double kOccCurveR[] = {
    -0.303208896236, -0.278878014744, -0.254610299193, -0.228042987796, -0.201227543758, -0.174231696996,
    -0.146601120314, -0.117858203202, -0.06111724993026, -0.004376296658798, 4.273668147854, 2.61473335686,
    0.599930816178, 4.273668147854, 2.61473335686, 0.585678885322, 4.276483920208, 2.616490337827, 0.569020678578,
    4.284685710114, 2.621763320389, 0.542925538101, 4.291386018135, 2.626154874126, 0.528656109, 4.304794518204,
    2.63530605132, 0.505678614342, 4.314190060928, 2.641956344567, 0.492702509032, 4.330714481677, 2.654238908481,
    0.47268342009, 4.341073714597, 2.662289577048, 0.461683842704, 4.358664537856, 2.676677582059, 0.444637546827,
    4.36937060298, 2.685870313988, 0.43520154296, 4.387410925922, 2.702198468266, 0.420437052211, 4.398320586842,
    2.712600190261, 0.412194772147, 4.416669879027, 2.731087558666, 0.399275651131, 4.427741656551, 2.742887336575,
    0.392077098592, 4.454656447688, 2.773318182885, 0.375926909209, 4.47345911437, 2.796922328222, 0.366396836028,
    4.508315273001, 2.847080090812, 0.353372503209, 4.524363531453, 2.873650980944, 0.349930816072, 4.537702742171,
    2.898823298724, 0.349930816178};
const int32_t kOccCurveI[] = {3, 20, 10, 0, 0, 0, 0, 4, 2, 2, 2, 2, 2, 2, 2, 2, 4};
const double kOccCylR[10] = {3.875, 3.25, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.75};

TEST_CASE("offSurface where the error is worst: OCC623's curve off its cylinder, however the trace is seeded") {
  // Traced from its central sample its nodes fall where the curve is farthest off; seeded at its start they don't
  // (offSurface 1.9e-5 from them, under tol), while the error (2.2e-5) is the curve's own distance: invalidModel
  // both ways, offSurface the distance where the error is worst.
  const double tol = 2e-5;
  Status st;
  std::unique_ptr<Curve> cv = curves::makeBSpline(kOccCurveR, kOccCurveI, 3, st);
  REQUIRE(cv);
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(kOccCylR, kOccCylR[9], 0), tol);
  REQUIRE(cyl);
  const Range cd = cv->domain().range;
  Pcurve central = projectCurve(*cv, {cd.lo, cd.hi}, *cyl, tol);
  REQUIRE(!central.pieces.empty());
  PcurveEnds e;
  e.hasStart = true, e.start = project::at(central.pieces.front(), cd.lo);
  Pcurve seeded = projectCurve(*cv, {cd.lo, cd.hi}, *cyl, tol, &e);
  for (const Pcurve* p : {&central, &seeded}) {
    CHECK(p->status == Status::invalidModel);
    CHECK(p->error > tol);
    CHECK(p->offSurface > tol);
    CHECK(p->offSurface <= p->error * (1 + 1e-6));
    CHECK(p->offSurface >= 0.95 * p->error);
    if (!(p->status == Status::invalidModel))
      std::printf("    occ623 %s: status %d error %g offSurface %g\n", p == &central ? "central" : "seeded",
        int(p->status), p->error, p->offSurface);
  }
}

// The corpus's stopped traces (pcurve_corpus), as fixtures: bug25287_bad_tess_face_plus #2134's coedge 750 (its curve
// a cubic 18 poles, its face #5924 a 28 x 3 B-spline) and bug24383_224013 #11's coedge 7966 (the curve with a stray
// pole in its first knot span, 61 poles; its face #11346 a 3 x 3 B-spline).
const double kFoldCurveR[] = {
    0, 0.12500000000000000, 0.25000000000000000, 0.37500000000000000, 0.50000000000000000, 0.62500000000000000,
    0.75000000000000000, 0.87500000000000000, 1, -38.141429257671923, 344.90640046906083, 211.03489949670342,
    -38.392697473475600, 345.18149633719349, 210.99150896917604, -38.685924240734735, 345.41851212703330,
    210.95010297648750, -39.330242962809116, 345.79532573418300, 210.87493880207830, -39.681248219156281,
    345.93507284807362, 210.84119073432558, -40.409765241150666, 346.10483177683358, 210.78436100588993,
    -40.787178978744912, 346.13482074922075, 210.76128699212202, -41.534785347790603, 346.08235332101958,
    210.72787069065626, -41.904877382557906, 345.99990398036215, 210.71753289940108, -42.604758094506785,
    345.72989930912109, 210.71051650336966, -42.934452596890196, 345.54238030992224, 210.71383884270824,
    -43.524057980406845, 345.07896922701997, 210.73384942077914, -43.783889525208870, 344.80313949915001,
    210.75053496692095, -44.210525424950987, 344.18773793509257, 210.79578413564502, -44.377272372465704,
    343.84824890632802, 210.82434166957341, -44.602809526041618, 343.13585647021182, 210.89078542461738,
    -44.661569384194145, 342.76304892121522, 210.92866270517050, -44.663710245551044, 342.39019120108782,
    210.96951277335216};
const int32_t kFoldCurveI[] = {
    3, 18, 9, 0, 0, 0, 0, 4, 2, 2, 2, 2, 2, 2, 2, 4};
const double kFoldSurfR[] = {
    0.022440034716238066, 0.022479560843288886, 0.022931540128710466, 0.023383519414132047, 0.023835498699553627,
    0.024739457270396788, 0.025643415841239948, 0.026095395126661529, 0.026547374412083109, 0.027451332982926270,
    0.028398290284559174, 0.029581986911600303, 0.030765683538641432, 0.033133076792723690, 0.035500470046805947,
    0.037867863300888205, 0.040235256554970462, 0.042602649809052720, 0, 1, -44.663704532832938, 342.39020482408307,
    210.96940376819666, -44.636749020230809, 351.15740829857771, 211.20550791110520, -38.141430490193457,
    344.90640604591857, 211.03487654823391, -44.664393902409657, 342.39164131717706, 210.98255772331834,
    -44.635787869583709, 351.15033507778884, 211.18976007870580, -38.142180621259470, 344.90737629137340,
    211.03764580194348, -44.672954788660824, 342.41049114445724, 211.14590916404484, -44.623935979953252,
    351.06117961169019, 210.99463650203634, -38.151792243842820, 344.91996671761052, 211.07203557893544,
    -44.689077672478831, 342.47011165266747, 211.45355211397660, -44.602552068359117, 350.85547450280842,
    210.62050518377859, -38.176960259352249, 344.95660580145619, 211.13680251576704, -44.711881628291508,
    342.61733822592140, 211.88867751185953, -44.578851674276883, 350.50335025290769, 210.12099808957527,
    -38.231057278821055, 345.04274944375055, 211.22840786268813, -44.740299565311645, 342.88175299968913,
    212.43092405252401, -44.552346692491476, 349.98778348964720, 209.50198130283110, -38.322453294491055,
    345.19546334856170, 211.34256502914445, -44.772742504593225, 343.33364909433857, 213.04997221150771,
    -44.533261581645490, 349.33198132205496, 208.87747089129573, -38.471703223661642, 345.45696612886422,
    211.47289095735098, -44.799348978164048, 343.88514191601831, 213.55765397049092, -44.521716629104148,
    348.72991597919270, 208.48765511905864, -38.649220249727733, 345.78518535950968, 211.57977132766393,
    -44.818003454696481, 344.37958073731750, 213.91360258704469, -44.523860243953145, 348.37527412424646,
    208.38363417655839, -38.806699762698926, 346.08896184304029, 211.65470787851623, -44.834512482847153,
    344.89331845335960, 214.22861360976879, -44.529212477497552, 348.10601770101545, 208.40976687599297,
    -38.969284777951003, 346.41179681928594, 211.72102598856779, -44.844807165925914, 345.29772580446308,
    214.42504786475183, -44.538792230243502, 348.00573923902891, 208.58593504847806, -39.096085631421772,
    346.67497975581784, 211.76238056854413, -44.857321476635633, 345.86455034357107, 214.66383513795662,
    -44.559856120445808, 348.00522587991571, 208.98785801659818, -39.272258929553168, 347.05403422372535,
    211.81265157348091, -44.862891397918240, 346.16246797847037, 214.77011556728974, -44.570748765665783,
    348.05253918413632, 209.19570206905917, -39.364010811097764, 347.25854140637267, 211.83502640077666,
    -44.873822304726765, 346.84406061096138, 214.97868969422413, -44.594104773483878, 348.24898100706747,
    209.64136124651594, -39.570856954858144, 347.74051140822064, 211.87893674305784, -44.878710985980028,
    347.22547782070967, 215.07197128944037, -44.606371115082403, 348.41473168362131, 209.87541698735964,
    -39.684503106175057, 348.01978926371220, 211.89857497383792, -44.886768707713777, 347.99231292055322,
    215.22572177923379, -44.628574426639233, 348.82777116355771, 210.29908141002960, -39.906062016371223,
    348.60178649591541, 211.93094349784550, -44.889933307788965, 348.37774114113540, 215.28610594583031,
    -44.638666603654499, 349.07276569691652, 210.49165161926462, -40.013970928541660, 348.90452079401115,
    211.94365595412219, -44.897541982604807, 349.53841147706231, 215.43128811000381, -44.665037289662621,
    349.87697684664380, 210.99483428324754, -40.323426524962294, 349.84737078403009, 211.97422062004978,
    -44.900126165212157, 350.31798056241490, 215.48059725156071, -44.678966357778840, 350.53147192782052,
    211.26061673622775, -40.510685892579410, 350.52288754541445, 211.98460149227893, -44.903112015124321,
    351.88219627390947, 215.53757066186364, -44.698893003503784, 351.93416118835790, 211.64083978677175,
    -40.813677959327173, 351.94978165384998, 211.99659589408870, -44.903521826377109, 352.66686543011809,
    215.54539032639445, -44.705499744579633, 352.69437549720863, 211.76690391661305, -40.928822964421144,
    352.70109684843987, 211.99824213954633, -44.903914632382495, 354.23476435329775, 215.55288551147510,
    -44.712718637915124, 354.22948623288238, 211.90464860671545, -41.060777834583412, 354.23643339901633,
    211.99982007302032, -44.903911612713159, 355.01871582616900, 215.55282789275154, -44.713564896425360,
    355.02402559430084, 211.92079618125922, -41.077421509852861, 355.02052109515103, 211.99980794281279,
    -44.903767456549467, 356.58662016479900, 215.55007722928792, -44.709879332318089, 356.57541306950941,
    211.85047142864559, -41.008171021038102, 356.57164219643499, 211.99922885589487, -44.903618923530153,
    357.37086503932932, 215.54724305044354, -44.705230645137441, 357.35246795023471, 211.76176919338639,
    -40.922415218385083, 357.33828654869978, 211.99863218642270, -44.901849259504822, 358.93796428126075,
    215.51347584928493, -44.689657871951418, 358.81306581834235, 211.46462297921511, -40.667889211998620,
    358.80891216614901, 211.99152330232477, -44.900215616566349, 359.72043352397293, 215.48230408507678,
    -44.678274018421192, 359.51064918829604, 211.24740611412315, -40.499612274281262, 359.51257656462548,
    211.98495382677029, -44.896571866761107, 360.49998260412804, 215.41277719698709, -44.663450315313334,
    360.10216206192877, 210.96455300895687, -40.306510674471731, 360.17150022742629, 211.97032358587327,
    0.99999999999999956, 0.36856728534217736, 0.99999999999999956, 0.99999999999999956, 0.36869380901473714,
    0.99999999999999956, 0.99999999999999956, 0.37030792541284324, 0.99999999999999956, 1, 0.37437142511462262, 1,
    0.99999999999999967, 0.38249496433684910, 0.99999999999999967, 1, 0.39601493174345825, 1, 0.99999999999999956,
    0.41728796609701058, 0.99999999999999956, 1.0000000000000004, 0.44261039194688201, 1.0000000000000004,
    1.0000000000000002, 0.46422914234612755, 1.0000000000000002, 0.99999999999999678, 0.48639882416545205,
    0.99999999999999678, 1.0000000000000002, 0.50324507393563012, 1.0000000000000002, 1, 0.52571074787294814, 1, 1,
    0.53705128861004692, 1, 1, 0.56189674526928135, 1, 1, 0.57505445336600669, 1, 1, 0.59996871217327552, 1, 1,
    0.61172467158679567, 1, 1, 0.64463873718957454, 1, 1, 0.66344485081986360, 1, 1, 0.69312260721476404, 1, 1,
    0.70395817083114842, 1, 1, 0.71632113333598113, 1, 1, 0.71784702526679744, 1, 1, 0.71139837512945148, 1, 1,
    0.70342931180719637, 1, 1, 0.67894927030382446, 1, 1, 0.66247550071656924, 1, 1, 0.64253595786369910, 1};
const int32_t kFoldSurfI[] = {
    3, 2, 28, 3, 18, 2, 1, 0, 0, 0, 0, 4, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 4, 3, 3};
const double kFoldRange[2] = {0, 0.9999999999999991};
const double kPoleCurveR[] = {
    0, 0.0000021547518898197301, 0.000029154752792886999, 0.00013715475710346999, 0.00035315476995213200,
    0.00078515482948764896, 0.0025131577760319599, 0.0094253429068184603, 0.011153345853351400, 0.011585345912922901,
    0.011693345917221499, 0.011720345918251600, 0.011747345919246300, 0.013475348865760999, 0.027300828766533801,
    0.034213013897185902, 0.089604005154813898, 0.31720301743859097, 0.54480201682757301, 0.77240100814961599, 1,
    -4.8318221069331502, -13.559537282627099, -99.302836626376404, -30313711.473375201, -30313720.201090399,
    -30313805.944389801, -4.8318239501869904, -13.559536816010100, -99.302836296286102, -4.8318248718251304,
    -13.559536582724000, -99.302836131271903, -4.8318281394140303, -13.559535755628200, -99.302835546228295,
    -4.8318314069925803, -13.559534928562799, -99.302834961083704, -4.8318346745916498, -13.559534101574499,
    -99.302834375944997, -4.8318477449879804, -13.559530793621100, -99.302832035389798, -4.8318608155486400,
    -13.559527486652900, -99.302829694359801, -4.8318738862652397, -13.559524180657499, -99.302827352826895,
    -4.8319000276986896, -13.559517568666701, -99.302822669760999, -4.8319261697874900, -13.559510960614199,
    -99.302817984790806, -4.8319523125310697, -13.559504356502799, -99.302813297921801, -4.8320045980202799,
    -13.559491148279500, -99.302803924183394, -4.8320568861278499, -13.559477955812000, -99.302794542832004,
    -4.8321091768306399, -13.559464779094300, -99.302785153847395, -4.8323183398057399, -13.559412072182500,
    -99.302747597879701, -4.8325275445810902, -13.559359617301199, -99.302709919940298, -4.8327367901063596,
    -13.559307414711901, -99.302672120214694, -4.8335737827025902, -13.559098601736499, -99.302520919416196,
    -4.8344114413174397, -13.558893822136200, -99.302367767391004, -4.8352496987299300, -13.558693092343299,
    -99.302212676427501, -4.8354592604552904, -13.558642910524400, -99.302173904172804, -4.8356688604810998,
    -13.558592981598400, -99.302135010584095, -4.8358784977526303, -13.558543305810501, -99.302095995844397,
    -4.8359309070294403, -13.558530886873299, -99.302086242167107, -4.8359833186473100, -13.558518483753200,
    -99.302076480913598, -4.8360357325910099, -13.558506096455901, -99.302066712091303, -4.8360488360762899,
    -13.558502999631701, -99.302064269885804, -4.8360619397069602, -13.558499903796100, -99.302061827206600,
    -4.8360750434830697, -13.558496808949601, -99.302059384054800, -4.8360783194270898, -13.558496035238001,
    -99.302058773266793, -4.8360815952100999, -13.558495261332400, -99.302058161861098, -4.8360848711724200,
    -13.558494487744600, -99.302057551014400, -4.8360881471347303, -13.558493714156800, -99.302056940167702,
    -4.8360914232749499, -13.558492940884699, -99.302056329875398, -4.8360946992552902, -13.558492167420299,
    -99.302055718969100, -4.8363043621721600, -13.558442665657600, -99.302016620935902, -4.8365140624469198,
    -13.558393417011001, -99.301977401740402, -4.8367237990258900, -13.558344421724801, -99.301938061572699,
    -4.8384017800363202, -13.557952438789400, -99.301623323653502, -4.8400821860674403, -13.557576650838600,
    -99.301300823167594, -4.8417644776991402, -13.557217178482500, -99.300970663597198, -4.8426055897589304,
    -13.557037449517500, -99.300805590436795, -4.8434472068906000, -13.556861791586700, -99.300638596192499,
    -4.8442892615487301, -13.556690218775501, -99.300469694240306, -4.8510313921979096, -13.555316476230900,
    -99.299117336625798, -4.8578081163764999, -13.554203742493200, -99.297641170699293, -4.8645846139466604,
    -13.553357733470300, -99.296048777907998, -4.8920572852929398, -13.549927919233300, -99.289593041245297,
    -4.9200029143181503, -13.550939141916301, -99.281064120684107, -4.9461072516151496, -13.556307571634900,
    -99.271168092738407, -4.9722115874514996, -13.561676001053099, -99.261272065346503, -4.9971946186684599,
    -13.571549700697100, -99.249735976375405, -5.0189874445346998, -13.585110957389400, -99.237514978064894,
    -5.0407802696269801, -13.598672213600100, -99.225293980188496, -5.0599839610236996, -13.616295060482500,
    -99.212050997598098, -5.0750082415111599, -13.636520125994901, -99.198882648974802, -5.0900325220189098,
    -13.656745191534601, -99.185714300333700, -5.1012917803080304, -13.680130308767700, -99.172257388161100,
    -5.1078536603145404, -13.704738988497200, -99.159626382676706};
const int32_t kPoleCurveI[] = {
    3, 61, 21, 0, 0, 0, 0, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4};
const double kPoleSurfR[] = {
    0, 1, 0, 1, -4.8318221069318099, -13.559537282627200, -99.302836626376205, -4.8318221069318099,
    -13.559537282627200, -99.302836626376205, -4.8318221069318099, -13.559537282627200, -99.302836626376205,
    -4.8318221069318099, -13.559537282627200, -99.302836626376205, -4.9544123672650402, -13.528504964792599,
    -99.280886516485197, -4.9538397957603904, -13.527724947362200, -99.279078826439900, -4.9532672242557396,
    -13.526944929931700, -99.277271136394504, -4.9526946527510898, -13.526164912501301, -99.275463446349207,
    -5.0786197355380702, -13.595104510816100, -99.215898954155804, -5.0776128395374096, -13.593562897502700,
    -99.212500011627498, -5.0765332112353496, -13.592092004670500, -99.209091245396607, -5.0753820044938402,
    -13.590693404348301, -99.205676298610101, -5.1078536602139897, -13.704738988158001, -99.159626382804603,
    -5.1068176082595800, -13.703171166109300, -99.156052205845697, -5.1056896996977299, -13.701634491653399,
    -99.152490992943598, -5.1044712582800500, -13.700130768283300, -99.148946923658301};
const int32_t kPoleSurfI[] = {
    3, 3, 4, 4, 2, 2, 0, 0, 0, 0, 0, 4, 4, 4, 4};
const double kPoleRange[2] = {1.0552681618335185e-23, 0.9999999999999991};

TEST_CASE("traces that stop short say where and why: a fold 0.26 off the curve, a pole line 1 over a pole") {
  Status st;
  struct Case {
    const char* name;
    const double *cr, *sr;
    const int32_t *ci, *si;
    const double* range;
    double tol, at, distance;
    StopWhy why;
  };
  // bug25287's curve is up to 0.39 off its face midway (a model defect: global inversion at 41 points), the feet
  // folding where it stops.
  for (const Case& c : {Case{"fold", kFoldCurveR, kFoldSurfR, kFoldCurveI, kFoldSurfI, kFoldRange, 1e-5,
         0.2046295844161735, 0.260115457581517, StopWhy::fold}}) {
    std::unique_ptr<Curve> cv = curves::makeBSpline(c.cr, c.ci, 3, st);
    std::unique_ptr<Surface> sf = closeInFact(surfaces::makeBSpline(c.sr, c.si, st), c.tol);
    REQUIRE(cv);
    REQUIRE(sf);
    Pcurve p = project::projectForms(*cv, {c.range[0], c.range[1]}, *sf, c.tol, nullptr, {}, {});
    CHECK(p.stopped);
    CHECK(p.stopWhy == c.why);
    CHECK(p.status == Status::invalidModel);
    CHECK(p.pieces.empty());
    CHECK(std::fabs(p.stopAt - c.at) <= 1e-6 * (c.range[1] - c.range[0]));
    CHECK(std::fabs(p.stopDistance - c.distance) <= 1e-3 * c.distance);
    CHECK(p.offSurface >= p.stopDistance);
    if (!(p.stopWhy == c.why) || !(std::fabs(p.stopAt - c.at) <= 1e-6))
      std::printf("    %s: stopped %d why %d at %.17g distance %g\n", c.name, p.stopped, int(p.stopWhy), p.stopAt,
        p.stopDistance);
  }
  // A line 1 over a sphere's north pole (radius 10, x from -1 to 1 at z = 11): its feet run straight through the
  // pole, where a corrected foot is on the pole line with the curve farther than tol from it, so refused; the trace
  // stops where its foot comes within tol of the pole (x = -tol 11 / 10), the curve 1 off.
  {
    const double tol = 1e-3;
    const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, 10};
    std::unique_ptr<Surface> sph = closeInFact(surfaces::makeSphere(sr), tol);
    const double lr[7] = {-1, 0, 11, 1, 0, 0, 2};
    std::unique_ptr<Curve> line = curves::makeLine(lr, 3);
    Pcurve p = project::projectForms(*line, {0, 1}, *sph, tol, nullptr, {}, {});
    CHECK(p.stopped);
    CHECK(p.stopWhy == StopWhy::poleLine);
    CHECK(p.status == Status::invalidModel);
    CHECK(p.pieces.empty());
    CHECK(p.stopAt > 0.499);
    CHECK(p.stopAt < 0.5);
    CHECK(std::fabs(p.stopDistance - 1) < 1e-3);
    CHECK(p.offSurface >= p.stopDistance);
    if (!(p.stopWhy == StopWhy::poleLine) || !(p.stopAt > 0.499 && p.stopAt < 0.5))
      std::printf("    pole line: stopped %d why %d at %.17g distance %g status %d\n", p.stopped, int(p.stopWhy),
        p.stopAt, p.stopDistance, int(p.status));
  }
  // bug24383's stray pole takes the curve 1.2e7 out within its first 2.2e-6. Its face's side at u = 1, collapsed
  // within tol but 0.012 long, isn't a pole (closeInFact: under 10 x tol), so the trace doesn't stop there; the
  // spans' hulls still find the curve leaving the surface: invalidModel, offSurface the stray pole's.
  {
    std::unique_ptr<Curve> cv = curves::makeBSpline(kPoleCurveR, kPoleCurveI, 3, st);
    std::unique_ptr<Surface> sf = closeInFact(surfaces::makeBSpline(kPoleSurfR, kPoleSurfI, st), 0.0508);
    REQUIRE(cv);
    REQUIRE(sf);
    Pcurve p = project::projectForms(*cv, {kPoleRange[0], kPoleRange[1]}, *sf, 0.0508, nullptr, {}, {});
    CHECK(p.status == Status::invalidModel);
    CHECK(p.offSurface > 1e7);
    CHECK(p.offSpan.hi < 3e-6);
  }
}

TEST_CASE("localFoot: continued from a nearby foot, held along a side (its own step there), off a crease, at a pole") {
  // A cylinder of radius 5: from (0.9, 1.8), p 1 outside it at u = 1, v = 2.
  const double cr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, 5};
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(cr, 5, 0), 1e-7);
  LocalFoot a = localFoot(*cyl, {6 * std::cos(1.0), 6 * std::sin(1.0), 2}, {0.9, 1.8});
  CHECK(a.status == Status::ok);
  CHECK(a.side == -1);
  // (Converged where the step left is within 1e-6 of the distance: the foot that near.)
  CHECK(std::fabs(a.uv.x - 1) < 1e-6);
  CHECK(std::fabs(a.uv.y - 2) < 1e-6);
  CHECK(std::fabs(a.distance - 1) < 1e-9);
  CHECK(norm(a.point - Vec3{5 * std::cos(1.0), 5 * std::sin(1.0), 2}) < 5e-6);
  CHECK(a.iterations > 0);
  // Started a period over, it stays there (continued, not reduced).
  LocalFoot b = localFoot(*cyl, {6 * std::cos(1.0), 6 * std::sin(1.0), 2}, {0.9 + 2 * kPi, 1.8});
  CHECK(b.status == Status::ok);
  CHECK(std::fabs(b.uv.x - 1 - 2 * kPi) < 1e-6);
  // A flat patch 10 x 10 over [0, 1]^2: p past its u = 1 side, the foot held along it at v = 0.5.
  const int32_t si[] = {1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 0, 2, 2, 2, 2};
  const double sr[] = {0, 1, 0, 1, 0, 0, 0, 0, 10, 0, 10, 0, 0, 10, 10, 0};
  Status st;
  std::unique_ptr<Surface> patch = surfaces::makeBSpline(sr, si, st);
  REQUIRE(patch);
  LocalFoot c = localFoot(*patch, {12, 5, 1}, {0.8, 0.4});
  CHECK(c.status == Status::ok);
  CHECK(c.side == 1);
  CHECK(c.uv.x == 1);
  CHECK(std::fabs(c.uv.y - 0.5) < 1e-6);
  CHECK(std::fabs(c.distance - std::sqrt(5.0)) < 1e-9);
  // Past its v = 0 side.
  LocalFoot d = localFoot(*patch, {4, -3, 0}, {0.5, 0.5});
  CHECK(d.status == Status::ok);
  CHECK(d.side == 2);
  CHECK(std::fabs(d.uv.x - 0.4) < 1e-6);
  // A parallelogram (S_u (10, 0, 0), S_v (5, 10, 0)): beyond a side the free foot's other coordinate isn't the held
  // one's, so the step along the side is its own. Past u = 1: the free foot (1.15, 0.5), held (1, 0.56).
  const double kr[] = {0, 1, 0, 1, 0, 0, 0, 5, 10, 0, 10, 0, 0, 15, 10, 0};
  std::unique_ptr<Surface> skew = surfaces::makeBSpline(kr, si, st);
  REQUIRE(skew);
  LocalFoot f = localFoot(*skew, {14, 5, 1}, {0.8, 0.4});
  CHECK(f.status == Status::ok);
  CHECK(f.side == 1);
  CHECK(std::fabs(f.uv.y - 0.56) < 1e-6);
  CHECK(std::fabs(f.distance - std::sqrt(2.8)) < 1e-9);
  // Past u = 0: the free foot (-0.45, 0.5), held (0, 0.32).
  LocalFoot g = localFoot(*skew, {-2, 5, 1}, {0.2, 0.4});
  CHECK(g.status == Status::ok);
  CHECK(g.side == 0);
  CHECK(g.uv.x == 0);
  CHECK(std::fabs(g.uv.y - 0.32) < 1e-6);
  CHECK(std::fabs(g.distance - std::sqrt(17.2)) < 1e-9);
  // From the corner of a polyline's extrusion with a right angle at u = 1 (as trj3_s1-al #6704 face #1306): along
  // either leg on its side v = 1, and beside the first. At u = 1 the evaluation gives the second leg's S_u, across
  // the first, so the step of the first leg's side it heads into.
  {
    const int32_t bi[] = {1, 1, 3, 2, 3, 2, 0, 0, 0, 0, 0, 2, 1, 2, 2, 2};
    const double br[] = {0, 1, 2, 0, 1, 0, 0, 0, 0, 0, 3, 10, 0, 0, 10, 0, 3, 10, 10, 0, 10, 10, 3};
    std::unique_ptr<Surface> bend = surfaces::makeBSpline(br, bi, st);
    REQUIRE(bend);
    for (double along : {0.53, 2.0, 4.0}) {
      LocalFoot g1 = localFoot(*bend, {10 - along, 0, 3}, {1, 1});
      CHECK(g1.status == Status::ok);
      CHECK(std::fabs(g1.uv.x - (1 - along / 10)) < 1e-9);
      CHECK(g1.distance < 1e-9);
      CHECK(g1.iterations > 0);
      LocalFoot g2 = localFoot(*bend, {10, along, 3}, {1, 1});
      CHECK(g2.status == Status::ok);
      CHECK(std::fabs(g2.uv.x - (1 + along / 10)) < 1e-9);
      LocalFoot g3 = localFoot(*bend, {10 - along, -0.5, 1.5}, {1, 1});
      CHECK(g3.status == Status::ok);
      CHECK(std::fabs(g3.uv.x - (1 - along / 10)) < 1e-6);
      CHECK(std::fabs(g3.uv.y - 0.5) < 1e-6);
      CHECK(std::fabs(g3.distance - 0.5) < 1e-9);
      if (!(std::fabs(g1.uv.x - (1 - along / 10)) < 1e-9))
        std::printf("    bend at %g: (%g, %g) after %d, distance %g\n", along, g1.uv.x, g1.uv.y, g1.iterations,
          g1.distance);
    }
    // Its second leg 1e-6 long: the evaluation's S_u at the corner is 1e-7 of the first leg's, so a step judged by it
    // looks like nothing (under 1e-6 of the distance); judged by the first leg's own, it isn't.
    const double sr2[] = {0, 1, 2, 0, 1, 0, 0, 0, 0, 0, 3, 10, 0, 0, 10, 0, 3, 10, 1e-6, 0, 10, 1e-6, 3};
    std::unique_ptr<Surface> hook = surfaces::makeBSpline(sr2, bi, st);
    REQUIRE(hook);
    LocalFoot h = localFoot(*hook, {8, 0, 3}, {1, 1});
    CHECK(h.status == Status::ok);
    CHECK(std::fabs(h.uv.x - 0.8) < 1e-9);
    CHECK(h.distance < 1e-9);
  }
  // A sphere from its north pole, where S_u vanishes: singular, not a foot.
  const double ssr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, 10};
  std::unique_ptr<Surface> sph = closeInFact(surfaces::makeSphere(ssr), 1e-7);
  LocalFoot e = localFoot(*sph, {1, 0, 11}, {0, kPi / 2});
  CHECK(e.status == Status::singular);
}
