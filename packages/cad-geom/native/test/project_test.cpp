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

TEST_CASE("withinTolOnly: a trace whose feet pass 2 tol stops before its fit; otherwise the same result") {
  // OffHelix 1e-5 off its cylinder, traced (its angle wiggling). At tol 1e-8 the curve is 1000 tol off: invalidModel
  // at once, no pieces, no fit, offSurface its distance. At 1e-4 (within tol) and 6e-6 (1.67 tol off, within the
  // margin: the feet can stand a little farther than the nearest points) the result is the full one's.
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, 2};
  OffHelix h(2e-6, 20.0);
  {
    std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr, 2, 0), 1e-8);
    const long before = project::traceFits;
    Pcurve p = projectCurve(h, {0, 1}, *cyl, 1e-8, nullptr, nullptr, true);
    CHECK(p.status == Status::invalidModel);
    CHECK(p.pieces.empty());
    CHECK_EQ(project::traceFits - before, 0L);
    CHECK(p.offSurface > 0.99e-5 && p.offSurface < 1.01e-5);
  }
  for (double tol : {1e-4, 6e-6}) {
    std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr, 2, 0), tol);
    Pcurve full = projectCurve(h, {0, 1}, *cyl, tol), only = projectCurve(h, {0, 1}, *cyl, tol, nullptr, nullptr, true);
    CHECK(only.status == full.status);
    CHECK_EQ(only.pieces.size(), full.pieces.size());
    CHECK(only.error == full.error);
    CHECK(only.offSurface == full.offSurface);
    CHECK(!full.pieces.empty());
  }
}

namespace {

// LMP1 #172428 face #1039682 coedge #227897 (the user's models): a cubic of 229 poles along the v = 1 side of a
// B-spline of 46 x 2 poles, within 0.022 mm of it (tol 0.1136, the part's uncertainty). Near u = 0 the surface's
// u runs very unevenly (|S_u| 13 at u = 0.00044, 916 at 0.0011), so beside the corner a foot along the side is a
// local minimum of the distance that isn't the curve's: marched from its start vertex's foot the feet stayed
// there, 558 mm off by the end.
const double kLmpCurveR[] = {
    0.0, 0.0009765625, 0.00146484375, 0.001953125, 0.002197265625, 0.00244140625, 0.0029296875, 0.00341796875,
    0.00390625, 0.00439453125, 0.0048828125, 0.005859375, 0.0068359375, 0.00732421875, 0.0078125, 0.00830078125,
    0.0087890625, 0.009765625, 0.01171875, 0.0126953125, 0.013671875, 0.0146484375, 0.01513671875, 0.015625,
    0.01611328125, 0.0166015625, 0.017578125, 0.01953125, 0.0234375, 0.025390625, 0.02734375, 0.029296875,
    0.0302734375, 0.03076171875, 0.03125, 0.03173828125, 0.0322265625, 0.033203125, 0.03515625, 0.037109375,
    0.0390625, 0.04296875, 0.046875, 0.05078125, 0.0546875, 0.056640625, 0.05859375, 0.060546875, 0.0615234375,
    0.06201171875, 0.0625, 0.06298828125, 0.0634765625, 0.064453125, 0.06640625, 0.068359375, 0.0703125, 0.07421875,
    0.078125, 0.0859375, 0.09375, 0.1015625, 0.109375, 0.11328125, 0.1171875, 0.119140625, 0.12109375, 0.123046875,
    0.1240234375, 0.125, 0.1259765625, 0.126953125, 0.12890625, 0.130859375, 0.1328125, 0.13671875, 0.140625,
    0.1484375, 0.15625, 0.1640625, 0.171875, 0.1875, 0.203125, 0.21875, 0.234375, 0.2421875, 0.24609375, 0.25,
    0.25390625, 0.2578125, 0.265625, 0.28125, 0.2890625, 0.296875, 0.30078125, 0.3046875, 0.30859375, 0.310546875,
    0.3115234375, 0.3125, 0.3134765625, 0.314453125, 0.31640625, 0.3203125, 0.32421875, 0.328125, 0.3359375,
    0.34375, 0.3515625, 0.359375, 0.36328125, 0.3671875, 0.369140625, 0.37109375, 0.373046875, 0.3740234375,
    0.37451171875, 0.375, 0.37548828125, 0.3759765625, 0.376953125, 0.37890625, 0.380859375, 0.3828125, 0.38671875,
    0.390625, 0.3984375, 0.40625, 0.4140625, 0.421875, 0.4375, 0.453125, 0.4609375, 0.46875, 0.4765625, 0.48046875,
    0.484375, 0.48828125, 0.4921875, 0.494140625, 0.49609375, 0.4970703125, 0.498046875, 0.4990234375,
    0.49951171875, 0.499755859375, 0.5, 0.500244140625, 0.50048828125, 0.5009765625, 0.501953125, 0.5029296875,
    0.50390625, 0.505859375, 0.5078125, 0.51171875, 0.515625, 0.51953125, 0.5234375, 0.53125, 0.5390625, 0.546875,
    0.5625, 0.578125, 0.5859375, 0.59375, 0.6015625, 0.609375, 0.61328125, 0.6171875, 0.619140625, 0.62109375,
    0.623046875, 0.6240234375, 0.62451171875, 0.625, 0.62548828125, 0.6259765625, 0.626953125, 0.62890625,
    0.630859375, 0.6328125, 0.63671875, 0.640625, 0.6484375, 0.65625, 0.6640625, 0.671875, 0.6875, 0.703125,
    0.7109375, 0.71875, 0.7265625, 0.73046875, 0.734375, 0.73828125, 0.7421875, 0.744140625, 0.74609375,
    0.7470703125, 0.748046875, 0.7490234375, 0.74951171875, 0.75, 0.75048828125, 0.7509765625, 0.751953125,
    0.7529296875, 0.75390625, 0.755859375, 0.7578125, 0.76171875, 0.765625, 0.76953125, 0.7734375, 0.78125,
    0.7890625, 0.796875, 0.8125, 0.828125, 0.84375, 0.859375, 0.875, 0.90625, 0.9375, 0.96875, 1.0,
    -945.444315971491, 449.5, 84.1683197111345, -945.436731243286, 449.5, 84.2581443005959, -945.356231631162,
    449.5, 84.4246889375442, -945.097992251659, 449.5, 84.7210702096187, -944.894817444251, 449.5, 84.9194321520066,
    -944.656566386385, 449.5, 85.12882089684621, -944.540882011147, 449.5, 85.2256903436799, -944.365851686268,
    449.5, 85.3657399923562, -944.1482923939179, 449.5, 85.5287155588138, -943.875166210415, 449.5,
    85.7213030990073, -943.697492223553, 449.5, 85.84014322634299, -943.408710713672, 449.5, 86.0255742894784,
    -943.03453407603, 449.5, 86.24946854770441, -942.6143193012861, 449.5, 86.4812877359991, -942.2682462394299,
    449.5, 86.66209378888209, -941.967803622976, 449.5, 86.81293242215429, -941.770386622131, 449.5,
    86.9091867687918, -941.4637016908221, 449.5, 87.05619403249621, -940.928821231461, 449.5, 87.3038400832981,
    -940.2743984280851, 449.5, 87.5888375564392, -939.5862400791069, 449.5, 87.8709402572332, -939.053408617998,
    449.5, 88.0812631883366, -938.5896755501029, 449.5, 88.2574937696789, -938.220658490872, 449.5,
    88.3941427501671, -937.909549074874, 449.5, 88.50706780692411, -937.707999749967, 449.5, 88.5790798210015,
    -937.397002533509, 449.5, 88.6890675135805, -936.8624857096311, 449.5, 88.8743187482994, -935.7468277137559,
    449.5, 89.2470357527381, -934.4001137376739, 449.5, 89.66534077393109, -932.9747996993, 449.5, 90.078576066685,
    -931.866376792805, 449.5, 90.3858583510852, -930.914169082895, 449.5, 90.6386806809979, -930.223590442416,
    449.5, 90.8161896444746, -929.835366279962, 449.5, 90.914494095656, -929.5102060740869, 449.5,
    90.99586336501369, -929.3033633596181, 449.5, 91.04717058826529, -928.984359524628, 449.5, 91.1259061691445,
    -928.441476292542, 449.5, 91.2584903163006, -927.644226450547, 449.5, 91.4494910798045, -926.673389826777,
    449.5, 91.6760799889743, -925.3527800783689, 449.5, 91.9765498059119, -923.656337478708, 449.5,
    92.34820047880089, -921.546438534574, 449.5, 92.7881515543175, -919.3627326345279, 449.5, 93.2219887860316,
    -917.4811683273771, 449.5, 93.5784812943797, -915.9393794383251, 449.5, 93.8605590019241, -914.763398142028,
    449.5, 94.0707900425116, -913.7716933205439, 449.5, 94.244094474365, -913.0621900084969, 449.5,
    94.3659576442351, -912.665729073919, 449.5, 94.4335047928729, -912.335452952746, 449.5, 94.4894186344602,
    -912.125483014731, 449.5, 94.52479222781369, -911.802614159498, 449.5, 94.5790271962092, -911.255271004279,
    449.5, 94.6704127620161, -910.4574659474149, 449.5, 94.8021422892635, -909.495509055035, 449.5,
    94.9585739833102, -908.1993824444729, 449.5, 95.16621141575921, -906.5572834369821, 449.5, 95.4234221900779,
    -903.8817030937901, 449.5, 95.8302157562164, -900.447461285766, 449.5, 96.32970308477131, -896.182550024017,
    449.5, 96.9147141201134, -891.773839192816, 449.5, 97.4853456139409, -887.980171188101, 449.5,
    97.94888014311701, -884.873163045777, 449.5, 98.3125366629487, -882.9017415391071, 449.5, 98.53678248451949,
    -881.3056834028849, 449.5, 98.71448147765639, -880.102248367969, 449.5, 98.84658348088129, -879.083641515886,
    449.5, 98.9567894623884, -878.2827784337491, 449.5, 99.04255370724701, -877.629290748341, 449.5,
    99.1119836906451, -877.166673512382, 449.5, 99.1608385892034, -876.482051158495, 449.5, 99.2328616775115,
    -875.64755602583, 449.5, 99.31999476000671, -874.633659805508, 449.5, 99.4248781816172, -873.281661606378,
    449.5, 99.5633940143568, -871.583797855525, 449.5, 99.73485771626301, -868.853598698618, 449.5,
    100.005276462987, -865.413860646754, 449.5, 100.336099062766, -861.24345028926, 449.5, 100.721516133815,
    -857.0301904338639, 449.5, 101.095376313977, -851.355433078353, 449.5, 101.578442144593, -844.154864620842,
    449.5, 102.153378683487, -835.343190712992, 449.5, 102.797048483268, -826.359155269087, 449.5, 103.394533991884,
    -818.733054491383, 449.5, 103.853736527245, -813.313312741182, 449.5, 104.15528101119199, -810.2051056158571,
    449.5, 104.321293588229, -807.834514209686, 449.5, 104.444374223892, -805.563040259946, 449.5, 104.558979721476,
    -802.5231858446759, 449.5, 104.70789065777001, -797.265920298561, 449.5, 104.953509436852, -791.362660249913,
    449.5, 105.201936011405, -785.572672635495, 449.5, 105.41766112511999, -781.99971983153, 449.5,
    105.538928506276, -779.1697474814811, 449.5, 105.62777774489, -777.059576886894, 449.5, 105.690380671244,
    -775.317661165181, 449.5, 105.73902923480901, -774.0946039320919, 449.5, 105.771547433351, -773.412735831404,
    449.5, 105.78923515536, -772.859140796181, 449.5, 105.803330532245, -772.471017060576, 449.5,
    105.81302693337399, -771.8892378660171, 449.5, 105.827307627566, -770.884995583782, 449.5, 105.851222330413,
    -769.396959295458, 449.5, 105.884667295528, -767.55505396501, 449.5, 105.922911683144, -765.013799520346, 449.5,
    105.971647339988, -761.68191652771, 449.5, 106.028214385125, -757.4336503251669, 449.5, 106.089168771204,
    -752.935795381504, 449.5, 106.14318682781399, -748.979451670394, 449.5, 106.18242416055699, -745.6896265486411,
    449.5, 106.210346384482, -743.58126464451, 449.5, 106.226354286299, -741.863828661015, 449.5, 106.238291309438,
    -740.558875111517, 449.5, 106.24681762931, -739.462453015899, 449.5, 106.25353968660501, -738.6801945402191,
    449.5, 106.258098809975, -738.2436298702461, 449.5, 106.260582260387, -737.88032580893, 449.5,
    106.26260816459799, -737.649471868645, 449.5, 106.263879166536, -737.295273085925, 449.5, 106.265820920914,
    -736.6965668886451, 449.5, 106.269064098378, -735.8288588083, 449.5, 106.273664026899, -734.7905902928579,
    449.5, 106.27900243249199, -733.402095054102, 449.5, 106.285923899695, -731.6624526639281, 449.5,
    106.294186479318, -728.868889422184, 449.5, 106.306584923994, -725.3586462657349, 449.5, 106.320538306271,
    -721.1168675820691, 449.5, 106.334812148422, -716.845662085457, 449.5, 106.346615436217, -711.111464335609,
    449.5, 106.359059200767, -703.870119929687, 449.5, 106.368437690201, -696.5306433491189, 449.5,
    106.369581239314, -690.600183151734, 449.5, 106.365555111598, -686.122898662045, 449.5, 106.360065033441,
    -682.367294811955, 449.5, 106.353431230475, -679.348093181803, 449.5, 106.346888950895, -677.076328813331,
    449.5, 106.341364608637, -674.7972170624599, 449.5, 106.335222690678, -672.891785132218, 449.5,
    106.329589601363, -671.363846789628, 449.5, 106.324774633899, -670.4071536276521, 449.5, 106.321635892503,
    -669.641333467418, 449.5, 106.31904933597, -669.065264329087, 449.5, 106.31706632917499, -668.58878082664,
    449.5, 106.315395933097, -668.247274766686, 449.5, 106.314181748919, -668.0641974787441, 449.5, 106.31352685335,
    -667.892700130637, 449.5, 106.31291002710901, -667.851753298084, 449.5, 106.312761881657, -667.751170654107,
    449.5, 106.312397607596, -667.595476175193, 449.5, 106.311829817545, -667.35926893096, 449.5, 106.310959288199,
    -667.0763034328761, 449.5, 106.309900706559, -666.69165516878, 449.5, 106.308441870116, -666.200727810757,
    449.5, 106.30654271627401, -665.392129218654, 449.5, 106.303337261636, -664.338746073451, 449.5,
    106.299020215057, -663.006249079036, 449.5, 106.293342597515, -661.605374155526, 449.5, 106.28716803162699,
    -659.646349295714, 449.5, 106.27827260356699, -657.026593612419, 449.5, 106.265910840472, -653.609324382415,
    449.5, 106.249088749016, -648.688216585404, 449.5, 106.22400866315799, -641.852927462803, 449.5,
    106.187688622711, -634.105765296145, 449.5, 106.144742001149, -627.3609131064261, 449.5, 106.106408763601,
    -622.0287092123469, 449.5, 106.07567084389801, -616.4229549220221, 449.5, 106.042945019771, -611.523489434399,
    449.5, 106.014016640082, -607.4672155162671, 449.5, 105.989880431174, -604.874871604654, 449.5,
    105.974380043061, -602.767215039095, 449.5, 105.96173374687599, -601.168242054687, 449.5, 105.95211790127699,
    -599.825120646526, 449.5, 105.944023027148, -598.870382537135, 449.5, 105.93825933574901, -598.333724479473,
    449.5, 105.935017284134, -597.899051836693, 449.5, 105.93238919089599, -597.582230699879, 449.5,
    105.930474979474, -597.119592683338, 449.5, 105.927685708083, -596.3309109690989, 449.5, 105.922944350914,
    -595.199593759149, 449.5, 105.91618239423501, -593.854822077302, 449.5, 105.90820808371001, -592.071692717606,
    449.5, 105.89771913867301, -589.864647141128, 449.5, 105.884896868271, -586.3786482023829, 449.5,
    105.864989303255, -582.106670835709, 449.5, 105.841248784569, -577.1169335596151, 449.5, 105.81458926633199,
    -572.2638850194171, 449.5, 105.789759172596, -565.975386398983, 449.5, 105.759091499861, -558.456458240899,
    449.5, 105.725330309289, -551.393121360778, 449.5, 105.697666972136, -546.0158068603411, 449.5,
    105.679195016684, -542.11949883081, 449.5, 105.6671704073, -538.986472303995, 449.5, 105.65867436232999,
    -536.548392306123, 449.5, 105.6527922076, -534.753994944192, 449.5, 105.648837923123, -532.993792695168, 449.5,
    105.64534100708501, -531.555351806394, 449.5, 105.6428079354, -530.4218633092261, 449.5, 105.641010351473,
    -529.720142889054, 449.5, 105.639981676505, -529.163973795939, 449.5, 105.639216966626, -528.746419588067,
    449.5, 105.63866910825199, -528.408390621128, 449.5, 105.63824563545799, -528.120749004961, 449.5,
    105.63790038926601, -527.955518465751, 449.5, 105.637705326311, -527.600097835414, 449.5, 105.637300886131,
    -527.1929162875069, 449.5, 105.63685925829199, -526.66153702134, 449.5, 105.636316768506, -526.0343047152401,
    449.5, 105.635735480043, -525.1954614975, 449.5, 105.63503403247, -524.1497200539769, 449.5, 105.634304126782,
    -522.479389857289, 449.5, 105.633445973788, -520.398280109135, 449.5, 105.632955665899, -517.9113788442489,
    449.5, 105.63329857529199, -515.435029706527, 449.5, 105.634572906703, -512.147257140935, 449.5,
    105.637513860436, -508.063860618474, 449.5, 105.643518535731, -503.205889243982, 449.5, 105.654449711751,
    -496.78473556499296, 449.5, 105.673992036605, -488.863557733462, 449.5, 105.70773386052299, -479.52656748356196,
    449.5, 105.76312631816299, -470.35800029575, 449.5, 105.833421044641, -461.35785619302, 449.5, 105.918618039983,
    -449.582228161321, 449.5, 106.05208372558201, -435.28375082285, 449.5, 106.25617150472901, -418.799270337348,
    449.5, 106.56068591514101, -402.988482172826, 449.5, 106.924809400987, -392.89708494373997, 449.5,
    107.20729777517501, -387.963668382684, 449.5, 107.358476808175,
};
const int32_t kLmpCurveI[] = {
    3, 229, 227, 0, 0, 0, 0, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4,
};
const double kLmpSurfR[] = {
    -1.44879780196906e-10, 0.000488281105190954, 0.00073242173022632, 0.000976562355261687, 0.00122070298029705,
    0.00146484360533242, 0.00195312485540315, 0.00244140610547389, 0.00292968735554462, 0.00390624985568609,
    0.00488281235582756, 0.00585937485596902, 0.00781249985625196, 0.00976562485653489, 0.0117187498568178,
    0.0156249998573837, 0.0195312498579496, 0.0234374998585154, 0.0312499998596472, 0.0390624998607789,
    0.0468749998619107, 0.0546874998630424, 0.0624999998641741, 0.0781249998664376, 0.0937499998687011,
    0.109374999870965, 0.124999999873228, 0.140624999875492, 0.156249999877755, 0.187499999882282,
    0.218749999886809, 0.249999999891336, 0.281249999895863, 0.31249999990039, 0.343749999904917, 0.374999999909444,
    0.437499999918498, 0.499999999927552, 0.562499999936605, 0.624999999945659, 0.687499999954713,
    0.749999999963767, 0.874999999981875, 0.999999999999983, 0.0, 1.0, -945.4443159803601, 408.0, 84.1683196059686,
    -945.4443159803601, 449.5, 84.1683196059686, -945.434341265781, 408.0, 84.2864484428452, -945.434341265781,
    449.5, 84.2864484428452, -945.4216422295581, 408.0, 84.2751329881941, -945.4216422295581, 449.5,
    84.2751329881941, -945.429414769181, 408.0, 84.2788170834981, -945.429414769181, 449.5, 84.2788170834981,
    -945.3271202625591, 408.0, 84.4154072489965, -945.3271202625591, 449.5, 84.4154072489965, -945.1740576141719,
    408.0, 84.6078261258167, -945.1740576141719, 449.5, 84.6078261258167, -945.055598110794, 408.0,
    84.7489384969629, -945.055598110794, 449.5, 84.7489384969629, -944.9444451258589, 408.0, 84.8652897072326,
    -944.9444451258589, 449.5, 84.8652897072326, -944.771483228778, 408.0, 85.0288977112068, -944.771483228778,
    449.5, 85.0288977112068, -944.500872404692, 408.0, 85.26069994365581, -944.500872404692, 449.5,
    85.26069994365581, -944.1028155124919, 408.0, 85.5665173358688, -944.1028155124919, 449.5, 85.5665173358688,
    -943.621066556315, 408.0, 85.89512215471811, -943.621066556315, 449.5, 85.89512215471811, -942.991570956925,
    408.0, 86.283652928326, -942.991570956925, 449.5, 86.283652928326, -942.178378587968, 408.0, 86.7161365746488,
    -942.178378587968, 449.5, 86.7161365746488, -941.14062580604, 408.0, 87.21274227478109, -941.14062580604, 449.5,
    87.21274227478109, -939.7452921585619, 408.0, 87.8206571217221, -939.7452921585619, 449.5, 87.8206571217221,
    -937.955172931942, 408.0, 88.5057703022247, -937.955172931942, 449.5, 88.5057703022247, -935.793656491732,
    408.0, 89.2404079829672, -935.793656491732, 449.5, 89.2404079829672, -932.910994553718, 408.0,
    90.12110553100621, -932.910994553718, 449.5, 90.12110553100621, -929.28571252849, 408.0, 91.0730615743756,
    -929.28571252849, 449.5, 91.0730615743756, -924.910127904066, 408.0, 92.0922074539544, -924.910127904066, 449.5,
    92.0922074539544, -920.533721319153, 408.0, 93.0066437855707, -920.533721319153, 449.5, 93.0066437855707,
    -916.151860578579, 408.0, 93.8344323011073, -916.151860578579, 449.5, 93.8344323011073, -910.3043795628411,
    408.0, 94.846126193834, -910.3043795628411, 449.5, 94.846126193834, -902.999191352249, 408.0, 95.987667969474,
    -902.999191352249, 449.5, 95.987667969474, -894.246687882728, 408.0, 97.1922160336527, -894.246687882728, 449.5,
    97.1922160336527, -885.503230967677, 408.0, 98.259137128825, -885.503230967677, 449.5, 98.259137128825,
    -876.766574953618, 408.0, 99.2156666272153, -876.766574953618, 449.5, 99.2156666272153, -868.036490803482,
    408.0, 100.09474258274, -868.036490803482, 449.5, 100.09474258274, -856.407659967605, 408.0, 101.174570580818,
    -856.407659967605, 449.5, 101.174570580818, -841.890332891761, 408.0, 102.357411359837, -841.890332891761,
    449.5, 102.357411359837, -824.496697857335, 408.0, 103.538368800022, -824.496697857335, 449.5, 103.538368800022,
    -807.1266755867609, 408.0, 104.51091728607, -807.1266755867609, 449.5, 104.51091728607, -789.777611586702,
    408.0, 105.296146434391, -789.777611586702, 449.5, 105.296146434391, -772.449085100165, 408.0, 105.858558470073,
    -772.449085100165, 449.5, 105.858558470073, -755.125248517072, 408.0, 106.150908394095, -755.125248517072,
    449.5, 106.150908394095, -732.0046594961041, 408.0, 106.310940434098, -732.0046594961041, 449.5,
    106.310940434098, -703.0843440503139, 408.0, 106.39408353673099, -703.0843440503139, 449.5, 106.39408353673099,
    -668.358364152281, 408.0, 106.334986834051, -668.358364152281, 449.5, 106.334986834051, -633.584360820432,
    408.0, 106.153267864652, -633.584360820432, 449.5, 106.153267864652, -598.748230038572, 408.0, 105.92915711433,
    -598.748230038572, 449.5, 105.92915711433, -563.840537925614, 408.0, 105.724051945276, -563.840537925614, 449.5,
    105.724051945276, -517.188344665098, 408.0, 105.56455482572099, -517.188344665098, 449.5, 105.56455482572099,
    -458.637643119722, 408.0, 105.74137006976001, -458.637643119722, 449.5, 105.74137006976001, -411.55854320091004,
    408.0, 106.635438257771, -411.55854320091004, 449.5, 106.635438257771, -387.96366838214703, 408.0,
    107.358476808181, -387.96366838214703, 449.5, 107.358476808181,
};
const int32_t kLmpSurfI[] = {
    3, 1, 46, 2, 44, 2, 0, 0, 0, 0, 10, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4, 2, 2,
};

// bug25166_piston #30604 coedge 58 (the corpus): a closed cubic of 124 poles over t in [0, 20] round a B-spline
// patch of degree 8 x 1, its joints at whole t (40 C1 or less smooth) turning the face's corners, its feet with
// them. A fit smooth through them runs out of spans rounding the corners (4.1e-2 at tol 1e-3: noConvergence).
const double kPistonCurveR[] = {
    0.0, 1.0, 1.0625, 1.125, 1.1875, 1.25, 1.3125, 1.375, 1.4375, 1.5, 1.5625, 1.625, 1.6875, 1.75, 1.8125, 1.875,
    1.9375, 2.0, 3.0, 4.0, 5.0, 5.5, 6.0, 7.0, 8.0, 8.5, 9.0, 10.0, 10.25, 10.5, 10.75, 11.0, 12.0, 12.5, 13.0,
    14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 3.68152712e-09, 9.0, 40.9999999, 3.68152712e-09, -7.83333333,
    40.9999999, -1.04870149e-08, -24.6666667, 40.9999999, 1.78500692e-08, -41.5, 40.9999999, 2.68343579, -41.5,
    41.0000798, 5.36681822, -41.5, 40.7357548, 7.99870186, -41.5, 40.2122215, 10.6305855, -41.5, 39.6886883,
    13.2108421, -41.5, 38.9059628, 15.6900199, -41.5, 37.8790553, 18.1691976, -41.5, 36.8521477, 20.5471744, -41.5,
    35.581105, 22.7783759, -41.5, 34.090274, 25.0095773, -41.5, 32.5994429, 27.093893, -41.5, 30.8888965, 28.991375,
    -41.5, 28.9914143, 30.8888571, -41.5, 27.0939321, 32.5994115, -41.5, 25.0096085, 34.0902535, -41.5, 22.7783963,
    35.5810955, -41.5, 20.5471841, 36.8521514, -41.5, 18.1691942, 37.8790604, -41.5, 15.6900083, 38.9059694, -41.5,
    13.2108225, 39.6886807, -41.5, 10.6305635, 40.2121939, -41.5, 7.99868431, 40.735707, -41.5, 5.36680513,
    40.9999961, -41.5, 2.68343567, 40.9999961, -41.5, 6.69514846e-08, 40.9999961, -41.5, -2.68343554, 40.735707,
    -41.5, -5.36680499, 40.2121939, -41.5, -7.99868418, 39.6886807, -41.5, -10.6305634, 38.9059694, -41.5,
    -13.2108223, 37.8790604, -41.5, -15.6900082, 36.8521514, -41.5, -18.169194, 35.5810956, -41.5, -20.5471839,
    34.0902535, -41.5, -22.7783962, 32.5994115, -41.5, -25.0096084, 30.8888571, -41.5, -27.093932, 28.9913751,
    -41.5, -28.9914142, 27.093893, -41.5, -30.8888964, 25.0095773, -41.5, -32.5994428, 22.7783759, -41.5,
    -34.0902739, 20.5471744, -41.5, -35.581105, 18.1691976, -41.5, -36.8521477, 15.6900199, -41.5, -37.8790552,
    13.2108421, -41.5, -38.9059628, 10.6305855, -41.5, -39.6886882, 7.99870187, -41.5, -40.2122215, 5.36681822,
    -41.5, -40.7357548, 2.68343579, -41.5, -41.0000798, 1.41685383e-08, -41.5, -40.9999999, 1.41685383e-08,
    -24.6666667, -40.9999999, 1.41685383e-08, -7.83333333, -40.9999999, 1.46757957e-08, 9.0, -40.9999999,
    1.42383908, 9.0, -41.0000423, 2.84767962, 9.0, -40.925811, 4.26380311, 9.0, -40.7777355, 4.6379281, 9.00004468,
    -40.7386155, 5.01101105, 8.89834314, -40.6939585, 5.33220272, 8.70690914, -40.651827, 6.56889797, 7.97018933,
    -40.4896066, 7.79452145, 7.22616862, -40.2717696, 9.01602921, 6.49731516, -39.9964075, 10.237537, 5.7684617,
    -39.7210454, 11.4549965, 5.05477549, -39.3881488, 12.6740344, 4.37872467, -38.9919054, 14.3484513, 3.4501223,
    -38.4476431, 16.0261251, 2.59357382, -37.7834542, 17.6959448, 1.86010325, -36.9845014, 19.4414441, 1.09338407,
    -36.1493384, 21.1776023, 0.463118575, -35.1657393, 22.8623778, 1.18684269e-08, -34.033996, 25.240388,
    9.72302827e-09, -32.4365743, 27.4502897, 7.65827919e-09, -30.5890576, 29.4438501, 5.61622105e-09, -28.5317642,
    31.4374105, 3.5741629e-09, -26.4744709, 33.2145016, 1.55479604e-09, -24.2075337, 34.7363366, -4.99837774e-10,
    -21.7804365, 34.7363399, -13.3333333, -21.7804312, 34.7363432, -26.6666667, -21.780426, 34.7363465, -40.0,
    -21.7804207, 36.7693712, -40.0, -18.53805, 38.3452724, -40.0, -15.0095158, 39.4029826, -40.0, -11.3315656,
    40.4606929, -40.0, -7.6536154, 40.9999965, -40.0, -3.82699986, 40.9999961, -40.0, 5.17435061e-06, 40.9999956,
    -40.0, 3.82701021, 40.460691, -40.0, 7.65362561, 39.4029798, -40.0, 11.3315755, 38.3452686, -40.0, 15.0095255,
    36.7693666, -40.0, 18.5380593, 34.7363411, -40.0, 21.7804295, 34.7363429, -26.6666667, 21.7804266, 34.7363448,
    -13.3333333, 21.7804237, 34.7363466, -5.93225469e-12, 21.7804207, 33.2145144, -5.93227444e-12, 24.2075158,
    31.4374268, -5.9323945e-12, 26.4744512, 29.4438703, 1.07667208e-11, 28.5317435, 27.4503137, 2.74658362e-11,
    30.5890358, 25.2404162, 6.08636038e-11, 32.4365521, 22.8624103, 1.27660105e-10, 34.0339742, 22.1466686,
    0.196745249, 34.5147728, 21.4214577, 0.423458684, 34.9691186, 20.690265, 0.678070138, 35.3965184, 19.556335,
    1.07292299, 36.0593278, 18.4085215, 1.5357627, 36.6570172, 17.2573046, 2.05545962, 37.1911974, 15.5690663,
    2.81758569, 37.9745629, 13.8750636, 3.7012888, 38.621488, 12.1838491, 4.65253484, 39.1478454, 11.233962,
    5.18681008, 39.4434791, 10.2839788, 5.74155827, 39.7013242, 9.33256167, 6.30759113, 39.9237337, 8.0061499,
    7.09671821, 40.2338045, 6.67611747, 7.9063157, 40.4755423, 5.33220272, 8.70690914, 40.651827, 5.01101253,
    8.89833305, 40.6939583, 4.63793681, 9.00005712, 40.7386146, 4.26380929, 9.0, 40.7777349, 2.84768377, 9.0,
    40.9258108, 1.42384116, 9.0, 41.0000423, 1.84079922e-08, 9.0, 40.9999999,
};
const int32_t kPistonCurveI[] = {
    3, 124, 42, 0, 0, 0, 0, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4,
};
const double kPistonSurfR[] = {
    1.09000009e-10, 1.0, 0.000237442157, 1.0, 1.40397334e-08, 9.00005712, -40.9999999, 1.40397334e-08, -41.5,
    -40.9999999, 16.1006146, 9.00005712, -41.0004791, 16.1006146, -41.5, -41.0004791, 32.2016759, 9.00005712,
    -33.7713177, 32.2016759, -41.5, -33.7713177, 44.5168381, 9.00005712, -19.3312819, 44.5168381, -41.5,
    -19.3312819, 49.2744207, 9.00005712, 8.64101975e-08, 49.2744207, -41.5, 8.64101975e-08, 44.5168381, 9.00005712,
    19.3312821, 44.5168381, -41.5, 19.3312821, 32.2016758, 9.00005712, 33.7713179, 32.2016758, -41.5, 33.7713179,
    16.1006146, 9.00005712, 41.0004791, 16.1006146, -41.5, 41.0004791, 3.68152712e-09, 9.00005712, 40.9999999,
    3.68152712e-09, -41.5, 40.9999999,
};
const int32_t kPistonSurfI[] = {
    8, 1, 9, 2, 2, 2, 0, 0, 0, 2, 0, 9, 9, 2, 2,
};

// bug25287_bad_tess_face_plus #2134 face #1468 coedge 278 (the corpus): a cubic of 22 poles past the side of a
// 2 x 3 B-spline of 26 x 3 poles by up to 3.2e-4. Healing grows its tolerance to about 3.6e-4; there it is within
// tol of its surface, and fitted whole it misses tol (3.7e-4: noConvergence), cut it meets it.
const double k25287CurveR[] = {
    0.001158474748503025, 0.0022748001005367755, 0.0033911254525705262, 0.004507450804604277, 0.005623776156638028,
    0.006740101508671778, 0.007298264184688723, 0.007856426860705668, 0.008414589536722613, 0.008972752212739557,
    0.010089077564773404, -30.881519696363743, 391.9052969235144, 219.8731554775056, -31.097615654878766,
    391.9494417653764, 220.17301062055552, -31.333002037220925, 391.99860216865596, 220.45742119682424,
    -31.837383024925725, 392.1128724688583, 220.9981626416782, -32.10750997048218, 392.1783192372135,
    221.25502430656536, -32.66112895333578, 392.33101314459765, 221.73673166057463, -32.945811293936146,
    392.4185681210668, 221.96274681577754, -33.5141381083852, 392.6248810179465, 222.40041324355846,
    -33.79775574060029, 392.7440177425062, 222.61190685610677, -34.339028636894724, 393.01745486998044,
    223.04780959052815, -34.59611584653639, 393.17233329455127, 223.2725968626244, -34.942996015465326,
    393.4185206333398, 223.64833845229109, -35.05196440531125, 393.50252265499563, 223.77997636855514,
    -35.25183513213713, 393.66615370000454, 224.05387298053313, -35.343386779152105, 393.74618239975666,
    224.19676008868805, -35.51139299186072, 393.8976328835025, 224.49600126840784, -35.587877873724146,
    393.96905186132983, 224.6523386325839, -35.72830593557577, 394.09864737018836, 224.97933517175912,
    -35.79196046271211, 394.1564803220051, 225.1495391105504, -35.96403811003486, 394.30080169022324,
    225.6676561082778, -36.055909502606326, 394.36007203238427, 226.02712805419108, -36.13545414034125,
    394.3746698394505, 226.399144466961,
};
const int32_t k25287CurveI[] = {
    3, 22, 11, 0, 0, 0, 0, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4,
};
const double k25287SurfR[] = {
    8.413408858487514e-17, 0.0030751229052123695, 0.004612684357818512, 0.006150245810424655, 0.007687807263030797,
    0.008456587989333868, 0.00922536871563694, 0.009994149441940011, 0.010762930168243083, 0.011147320531394618,
    0.011531710894546153, 0.011916101257697688, 0.012300491620849225, 0.0, 0.5305229422548599, -36.13545414034126,
    394.37466983945046, 226.39914446696082, -32.990175783645206, 394.31707316677864, 226.56605412008844,
    -30.856841486944816, 396.6348372640928, 226.59445337771493, -36.04779474641607, 394.35858283513835,
    225.98917674954035, -32.923509532737405, 394.3312680265121, 226.1598028282618, -30.803888928414658,
    396.6352412653572, 225.98055388838392, -35.9451303581334, 394.28879579053296, 225.58962924652295,
    -32.846768611252116, 394.29955620561014, 225.75586786276315, -30.74676501057427, 396.5610529650971,
    225.3764234787093, -35.735808500933146, 394.10631824459995, 224.99699989766523, -32.69385175393016,
    394.18793468482477, 225.12882989581158, -30.643964906518974, 396.34321297463356, 224.4652178854306,
    -35.65583923705075, 394.03166637286495, 224.7992978599495, -32.63620313980704, 394.13968585612827,
    224.91567682553094, -30.606633464115237, 396.2521884115143, 224.15976005062325, -35.469167677539204,
    393.8592270467384, 224.4124542031498, -32.50354868125602, 394.0241599660261, 224.48568011100642,
    -30.524507730631427, 396.0387770996248, 223.55728792670482, -35.362605182135084, 393.76143674381325,
    224.22279760090348, -32.4288179756839, 393.95712170982887, 224.2687960261655, -30.479814716621977,
    395.9167393890872, 223.25987859641742, -35.10446519091954, 393.5431267033787, 223.84287326646808,
    -32.2508149529129, 393.80492341713114, 223.81720823780296, -30.377519278901264, 395.6426959794056,
    222.6618406422831, -34.953480929038115, 393.4226099519329, 223.65314287405369, -32.14834675631717,
    393.72010199409715, 223.58383283919656, -30.320304525290222, 395.4912223922119, 222.36238627022982,
    -34.66535246912893, 393.22419585641603, 223.3529546379859, -31.9564542168104, 393.5787902465704,
    223.19865709534662, -30.216718452792634, 395.24111259151186, 221.8949114329098, -34.558750011915514,
    393.1550841592267, 223.25013198386537, -31.886387334699368, 393.52959570462195, 223.0649644390269,
    -30.179358692821157, 395.15434908801603, 221.7367025817027, -34.31811478645498, 393.01206338857685,
    223.03475954494408, -31.730168693652338, 393.42756245253906, 222.78147937098757, -30.09715468730304,
    394.97519711708367, 221.41243412318133, -34.18397367404118, 392.9380097680078, 222.9221353818871,
    -31.644152109343185, 393.37471665778804, 222.63185192586224, -30.052363510053482, 394.8827752187794,
    221.24638367197196, -33.87521680973368, 392.78458640413277, 222.67532760313486, -31.449021899539325,
    393.26521698189447, 222.30431678387538, -29.951855805177114, 394.69228722061894, 220.89760584684709,
    -33.70079678617492, 392.7052243970113, 222.541569421959, -31.340394719942694, 393.20869982545474,
    222.12732617542144, -29.89636797691403, 394.5944276142637, 220.7155675970275, -33.29000198616665,
    392.5406524973451, 222.2279985782553, -31.088985867288688, 393.09193248959787, 221.72238966141563,
    -29.76902383854192, 394.393703769202, 220.31923804521554, -33.05405949957653, 392.45550708362526,
    222.04967447941365, -30.94715193006485, 393.03191958551014, 221.49677352540687, -29.697619564120775,
    394.29117618945594, 220.10662441651309, -32.62541970898349, 392.32259505674676, 221.7020446249457,
    -30.69406275615656, 392.938986612942, 221.080654570493, -29.57090223658181, 394.1343803965136,
    219.73667984701842, -32.46988138226641, 392.2774113648246, 221.57243965459887, -30.603534956504664,
    392.90772744623985, 220.9298166466107, -29.525650555037803, 394.08193586234336, 219.60553415520064,
    -32.12639073150603, 392.1849591468988, 221.26794527949414, -30.40595193699471, 392.84433292794023,
    220.58858027405688, -29.42699912109063, 393.97659812154416, 219.31716178427143, -31.938305453504345,
    392.137688867376, 221.09338009165938, -30.299076060644047, 392.81224996484775, 220.398922551922,
    -29.373684706300722, 393.9237640503193, 219.16043693940185, -31.52264024934419, 392.0406101700859,
    220.6668990550842, -30.06580968839057, 392.7470242989778, 219.95667180880923, -29.25723906208052,
    393.81819063959466, 218.8053342881128, -31.29440432646666, 391.99077381420676, 220.41540435344876,
    -29.939409861932106, 392.7139436665882, 219.7051802927017, -29.19410720277909, 393.76549676406484,
    218.60769554236074, -30.80114140763879, 391.88829169864647, 219.77653300939664, -29.669358343639196,
    392.64610554801703, 219.0991950157897, -29.05862468841306, 393.66116773235234, 218.14406459194294,
    -30.534403922763175, 391.8355271686142, 219.38891475006255, -29.525153359726705, 392.61131310654764,
    218.7456487661134, -28.98601859595216, 393.60943125438575, 217.87870287652376, -30.27322216813145,
    391.7823583292655, 218.8883778562771, -29.383722480826844, 392.5751557796349, 218.3097212108348,
    -28.91379167737234, 393.5594157792897, 217.55807082841883, 1.0, 0.8411660045193528, 0.8508621662636817, 1.0,
    0.8429690557096632, 0.8525551485992633, 1.0, 0.8451522626055927, 0.8546050796991631, 1.0, 0.8498759290195528,
    0.8590403857187541, 1.0, 0.8517113046164708, 0.8607637191889508, 1.0, 0.8560565223273268, 0.8648436792412602,
    1.0, 0.8585632910575229, 0.8671974200570602, 1.0, 0.8646616541087322, 0.872923503141747, 1.0,
    0.8682421337501633, 0.8762854092364979, 1.0, 0.8750223500446797, 0.8826517212301483, 1.0, 0.8775232913765338,
    0.8849999903862925, 1.0, 0.8831269092457509, 0.8902615304462288, 1.0, 0.8862328554651816, 0.8931778714314547,
    1.0, 0.8932982754494947, 0.8998119766033927, 1.0, 0.8972549035372871, 0.9035270688298899, 1.0,
    0.9064109415185146, 0.9121241683739488, 1.0, 0.9116049158220721, 0.9170010719220248, 1.0, 0.9207958422885822,
    0.9256309301529231, 1.0, 0.9240960280258119, 0.9287296531327772, 1.0, 0.9312714597338136, 0.9354670542654249,
    1.0, 0.9351499524988367, 0.9391087810090426, 1.0, 0.9435525352948866, 0.9469984207061415, 1.0,
    0.948089877902907, 0.9512587772213317, 1.0, 0.9576378457713293, 0.9602238809459556, 1.0, 0.9626584819835319,
    0.9649380279797828, 1.0, 0.9674151830705473, 0.9694043520415929,
};
const int32_t k25287SurfI[] = {
    3, 2, 26, 3, 13, 2, 1, 0, 0, 0, 0, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 3, 3,
};

// bug31251_Albatros_d2_elisa_a #787 coedge 278 (the corpus): a cubic of 33 poles along the u = 1 side of a rational
// 2 x 3 B-spline of 3 x 12 poles, past it by up to 1.13e-4 (tol 1e-5). Just before its break at t = 0.75 its feet
// along the side bulge by 4.7e-7 in v over about 0.001 (|S_v| 986 there: 4.6e-4 in 3D): a cut piece's fit, ending
// there with few spans, misses it between its checks (5.6e-4 unless cut there too).
const double k278CurveR[] = {
    0.0, 0.124999999999998, 0.1874999999999972, 0.21874999999999678, 0.23437499999999659, 0.24218749999999648,
    0.2499999999999964, 0.3749999999999948, 0.43749999999999395, 0.4687499999999933, 0.48437499999999317,
    0.4921874999999931, 0.49609374999999306, 0.499999999999993, 0.6249999999999948, 0.6874999999999959,
    0.7187499999999967, 0.7343749999999971, 0.7421874999999973, 0.7460937499999972, 0.7480468749999971,
    0.7490234374999971, 0.7499999999999971, 1.0, -4.975440004399683, 13.938167965636685, 5.85216165128781,
    -5.190656259557583, 14.814732564195802, 5.939836993141139, -5.508592738247106, 16.166666659480505,
    6.0658033210485955, -5.870957256226088, 17.808825692241015, 6.202906300227949, -6.049995806268027,
    18.646130854795576, 6.268977406576994, -6.13897866772542, 19.068839847507206, 6.301390953904565,
    -6.176999174944333, 19.25087007539366, 6.315148991157035, -6.202320616159559, 19.37241672309669,
    6.324291331813835, -6.215366018880875, 19.43520445030272, 6.328990521179042, -6.423406741290885,
    20.439031741098635, 6.403766966979464, -6.703519445800809, 21.848604435583994, 6.500743589342386,
    -7.006168697031209, 23.479814231326213, 6.599579292894345, -7.151412968720445, 24.292096208846225,
    6.64551143931854, -7.222509684671485, 24.697406467513467, 6.66761733499966, -7.257676028800867,
    24.899853914323714, 6.678456641352395, -7.272665388838974, 24.98657260241595, 6.683056428177257,
    -7.282640081021013, 25.044375171500132, 6.686112829357825, -7.287261137609119, 25.07119478991856,
    6.687526847862539, -7.463029365772567, 26.0931426245123, 6.741224644410508, -7.6192636061768,
    27.058307445262976, 6.786284115192795, -7.831981653565922, 28.46733233219276, 6.844124081035158,
    -7.932933007243405, 29.162164189617073, 6.8706058523081035, -8.041182486054042, 29.95586033160522,
    6.897392618328545, -8.092917970611277, 30.348473146421327, 6.909777893283066, -8.118187476585737,
    30.54372073979415, 6.915720864322739, -8.13067255676229, 30.64107983297288, 6.9186302258157975,
    -8.136877664529175, 30.68969320368549, 6.920069411972283, -8.139528973710034, 30.710513324874455,
    6.920682889663462, -8.141294730170245, 30.72439025443488, 6.921091138250613, -8.142018566003136,
    30.730082299522532, 6.921258387444636, -8.409104801683018, 32.83238280900758, 6.982911350698646,
    -8.584370467653184, 34.708794792565634, 7.008779440734911, -8.666645352438879, 36.367504039500595,
    7.005041673122172,
};
const int32_t k278CurveI[] = {
    3, 33, 24, 0, 0, 0, 0, 4, 1, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 2, 2, 4,
};
const double k278SurfR[] = {
    0.0, 1.0, 7.045662616249666e-06, 0.0028911364460601414, 0.005775227229504033, 0.011543408796391817,
    0.0173115903632796, 0.023079771930167383, -10.000000000000002, 36.29373053633361, 8.891386938485118,
    -9.946001818548643, 35.321736961276386, 8.891535791095865, -9.865542222859617, 34.355023682012764,
    8.882105576622013, -9.67071516218459, 32.42766673727829, 8.849102308299598, -9.556033420552966,
    31.46706663797067, 8.825450783259432, -9.174083422133112, 28.59138749594232, 8.736622356487626,
    -8.869461996723896, 26.681399435855358, 8.653738697939426, -8.193980226557256, 22.878800543425207,
    8.448155649751397, -7.822531225224268, 20.985441814358115, 8.325330944710064, -7.019592675020358,
    17.21141163698543, 8.038897613449226, -6.5893618988651985, 15.332576199167963, 7.875760988617187,
    -6.120393537882133, 13.463140978221244, 7.687356164430412, -9.999987509800237, 36.29350570665237,
    7.475603830846851, -9.946584557265735, 35.33230278181391, 7.4801369022171205, -9.867094040248334,
    34.37335902160198, 7.474922326972942, -9.674277862757314, 32.45993318536978, 7.450192476185849,
    -9.560724291176705, 31.505346174288793, 7.4306170921091255, -9.182523820176504, 28.649026255430257,
    7.353931628148082, -8.880411696013416, 26.748203541371453, 7.2790111050234945, -8.209944567032563,
    22.963525396640566, 7.0889294544500325, -7.841168279896309, 21.078335230775043, 6.973766407198882,
    -7.044200709889073, 17.32179831573262, 6.702120185479641, -6.617172032992271, 15.451335947884598,
    6.546235430983489, -6.152351088277503, 13.590532451196205, 6.364156050183975, -8.666733115043673,
    36.36749843833126, 7.005072585232643, -8.620349319862127, 35.43319139290668, 7.007163754268603,
    -8.547967762229362, 34.495494504157115, 6.999704330659694, -8.369157481905859, 32.61801747590546,
    6.970693018143403, -8.26247028702754, 31.678201191540364, 6.949062656727992, -7.904232862114018,
    28.858384988360186, 6.866369533273876, -7.615071894809533, 26.977156263431674, 6.787673990889103,
    -6.9701030002973985, 23.22716954880504, 6.590634116747972, -6.613706860290268, 21.35726635476163,
    6.472166784126054, -5.841500556578545, 17.631239874172746, 6.194611487149729, -5.426802161129021,
    15.776529969653227, 6.036038786692305, -4.975440004399683, 13.938167965636683, 5.85216165128781, 1.0, 1.0, 1.0,
    1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.8161945184370656, 0.8170377517329547, 0.8178298532484682,
    0.8193744718665694, 0.820125995517956, 0.8223455364430478, 0.8237797765047045, 0.8265648555779613,
    0.8279164767521525, 0.8304859351556642, 0.8317088458896418, 0.8327474056670918, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
    1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
};
const int32_t k278SurfI[] = {
    2, 3, 3, 12, 2, 6, 1, 0, 0, 1, 0, 3, 3, 4, 2, 2, 2, 2, 4,
};

// bug31251_Albatros_d2_elisa_a #787 face #831 coedge 361 (the corpus): a cubic of 37 poles along the u = 1 side
// of a rational 2 x 3 B-spline of 3 x 52 poles, past it by up to 3.6e-4 on five stretches, off by up to 2.9e-5
// between them (tol 1e-5). Fitted whole, its clamped feet's corners took 972 poles.
const double kAlbCurveR[] = {
    0.0, 0.06250000000012096, 0.09375000000018022, 0.12500000000023948, 0.18750000000035377, 0.21875000000041092,
    0.23437500000043948, 0.24218750000045702, 0.25000000000047456, 0.37500000000069866, 0.4375000000008062,
    0.46875000000085537, 0.4843750000008752, 0.4921875000008804, 0.496093750000883, 0.5000000000008856,
    0.625000000000921, 0.6875000000009445, 0.7187500000009562, 0.7343750000009622, 0.7421875000009651,
    0.7460937500009608, 0.7500000000009565, 1.0, 0.19945604025149596, 134.4164748799651, 8.547205676281573,
    0.03798951696718654, 134.4105616608247, 8.58289726511382, -0.10598667364020355, 134.39767712396377,
    8.61363551700159, -0.2869659491476431, 134.36687760714884, 8.651656347250121, -0.3474149781630169,
    134.35428237779624, 8.664226169963637, -0.46855212187727363, 134.32443447159565, 8.68916083701655,
    -0.5306180778722781, 134.30673807716747, 8.701803578991028, -0.7088983079612496, 134.2493250281213,
    8.737761022906401, -0.8849324528628032, 134.17983465600147, 8.772547445185136, -1.0863728516760962,
    134.07762723981634, 8.811266261484965, -1.1861100433228027, 134.02123970287906, 8.830181471582845,
    -1.2286439377801992, 133.99594136658203, 8.838195156868805, -1.2569530680852585, 133.97882419815335,
    8.843517243129297, -1.2722860434424579, 133.9693892872304, 8.846393065191608, -1.491687333680057,
    133.8323748317498, 8.887462302263142, -1.6907281480175864, 133.67862305907954, 8.923499900346098,
    -1.9782111120209325, 133.41079991351188, 8.974379537916509, -2.119183362768579, 133.2675894690875,
    8.999023831154316, -2.2788304339298753, 133.08423759188804, 9.026532903048397, -2.357452203133484,
    132.98849339694556, 9.039994477541304, -2.3964630703283425, 132.93960423538857, 9.046654208832013,
    -2.413117769846308, 132.91843379527447, 9.049493384272981, -2.424206631630912, 132.90427173690858,
    9.051382861171463, -2.430561939685523, 132.8961119134421, 9.052465203225749, -2.5860628716139717,
    132.69564079641358, 9.07893739023717, -2.7272875257091225, 132.48722000309508, 9.102694431899131,
    -2.924971200673529, 132.1535519751811, 9.136011299640241, -3.020274576569417, 131.9814587517402,
    9.15208845165424, -3.1253098861628277, 131.7714797077953, 9.169931796694378, -3.1762944203955468,
    131.66418928167352, 9.17863692605896, -3.2014040098002012, 131.60996884257528, 9.182936797019373,
    -3.2120833240308064, 131.58660824881088, 9.184768458429849, -3.219184665401136, 131.57100712791862,
    9.185987106974816, -3.2232787349659673, 131.56196853366558, 9.186690120320417, -3.4169769906047898,
    131.132733609798, 9.219967186953262, -3.5645754102262117, 130.7120032770184, 9.246302600727654,
    -3.670180798868316, 130.29304446503355, 9.267549298194371,
};
const int32_t kAlbCurveI[] = {
    3, 37, 24, 0, 0, 0, 0, 4, 2, 2, 2, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 2, 2, 4,
};
const double kAlbSurfR[] = {
    0.0, 1.0, -0.0004873356590734167, -0.00015229239346042212, -6.853157705717347e-05, 1.5229239346075172e-05,
    0.00018275087215257246, 0.00026651168855582107, 0.00030839209675744537, 0.0003502725049590697,
    0.000517794137765567, 0.0008528374033785616, 0.00219301046583054, 0.003533183528282518, 0.004873356590734497,
    0.006213529653186475, 0.007553702715638454, 0.008893875778090431, 0.009228919043703427, 0.009312679860106674,
    0.009354560268308299, 0.009396440676509923, 0.009563962309316422, 0.009731483942122919, 0.009773364350324543,
    0.009815244758526166, 0.009899005574929415, 0.01023404884054241, -7.154891385289127, 130.02973199700503,
    6.336419086954939, -7.125819384240295, 130.13968222759254, 6.330742016624555, -7.096747558934919,
    130.24963179351872, 6.325052051566596, -7.060407997520834, 130.387067918064, 6.31792348107226,
    -7.053140096248651, 130.41455510133082, 6.3164969612639466, -7.0386043157392635, 130.46952938452833,
    6.313642310330322, -7.029121095525357, 130.5053948981364, 6.311745770250049, -7.021981726781856,
    130.53239597172188, 6.310477409467461, -7.016959965986043, 130.55138825768552, 6.310074600279877,
    -7.0090475784006125, 130.5813128864737, 6.310111070189288, -7.006346794658548, 130.59152724339768,
    6.310230000985217, -7.00220207983159, 130.6072025438415, 6.310565567518413, -7.00238897356433,
    130.60657340076318, 6.310704323811582, -6.994006064096559, 130.6380794240249, 6.311030511706471,
    -6.989757355811138, 130.6537057503921, 6.311216416836037, -6.968235469322589, 130.7312639662534,
    6.312258728057335, -6.950129413627125, 130.7915010306504, 6.31345348908986, -6.893391494603775,
    130.96834331023092, 6.31807183967357, -6.852350320778725, 131.08115134487102, 6.322529447445889,
    -6.6332645489749, 131.6294688479664, 6.351066140631203, -6.414899871792999, 132.02200303037412,
    6.393932448631004, -5.914498769889241, 132.76859768327589, 6.50287761484715, -5.63694899708997,
    133.11210702492866, 6.569452173965142, -5.041648234634241, 133.74900773682785, 6.71013152507893,
    -4.722753041096938, 134.04338306070082, 6.784137659803614, -4.04174158227639, 134.58667785931198,
    6.920716207172433, -3.6809052387186614, 134.8336420524897, 6.983385048251552, -2.938615573756903,
    135.2621254075342, 7.081183782415769, -2.5544337715372634, 135.4459391970865, 7.115958398200954,
    -1.7576957902349555, 135.7438593565052, 7.1387946918831595, -1.3421652893729494, 135.8577235864296,
    7.1262690518612875, -0.8248050476665837, 135.9423236870112, 7.07466313659051, -0.7211990742704594,
    135.95645609959965, 7.062523693336232, -0.5914893046600096, 135.97053385260074, 7.0449572059792915,
    -0.5655371069608474, 135.9731699088148, 7.041324335149778, -0.5265923704501637, 135.97685247198572,
    7.035693534715189, -0.5136080497132358, 135.97803473790998, 7.033786352769225, -0.48763372058556514,
    135.9803083594948, 7.029911140892509, -0.47916919369005734, 135.98103638530458, 7.0286380075560055,
    -0.39019010820981775, 135.9881930839777, 7.014957268484416, -0.31175399435698703, 135.9929885729454,
    7.002847412636807, -0.16097603667542504, 135.99890177895918, 6.979461583253677, -0.08520242527741849,
    136.00029540220683, 6.967657900841847, 0.00997488259611968, 135.99997411861293, 6.952763664800313,
    0.020203372869389294, 135.99989705377, 6.949777490010401, 0.04670895298006888, 135.99976199466062,
    6.943789236796994, 0.059959527079115615, 135.99969447639734, 6.940787347322161, 0.09970460272870783,
    135.99949195547543, 6.931758394905868, 0.1261924576398802, 135.9993569866848, 6.92570804800057,
    0.2585874369829023, 135.99868236843758, 6.895301146463034, 0.36436167854172774, 135.99814339608534,
    6.870479101359743, 0.46999435651454075, 135.99760514506997, 6.845161208587572, -7.112426400749715,
    130.19033445550662, 9.66433618459818, -7.083255332433152, 130.30065935823242, 9.66061982814486,
    -7.054093857603917, 130.41094797842166, 9.6568936755166, -7.0176510547734825, 130.5487745617314,
    9.65222340522506, -7.010360702588238, 130.57634665429083, 9.651288434094937, -6.995780004044638,
    130.6314908173749, 9.649417118511211, -6.986267392843223, 130.66746748761815, 9.648198311736119,
    -6.979108270080438, 130.69454327085495, 9.647264890997484, -6.974081866750295, 130.713553114868,
    9.646560571542903, -6.966174773419183, 130.74345772080204, 9.645385207116208, -6.963477725741432,
    130.75365794794007, 9.644973590876972, -6.959341624217199, 130.7693006728961, 9.644326950047397,
    -6.960049957508952, 130.76805205241254, 9.644489553067546, -6.949855244005529, 130.80166147341222,
    9.642692745052498, -6.944703551641193, 130.81831154534, 9.641792191119333, -6.918688757674129,
    130.90083573633942, 9.637279520809525, -6.897030638640543, 130.9646537624374, 9.633632408277318,
    -6.82981539584813, 131.15120893734414, 9.622582139002018, -6.781984401270533, 131.26928431138805,
    9.61506211944275, -6.530579454717879, 131.83851948142816, 9.576819528057069, -6.289814646306101,
    132.23652990650595, 9.544000807469452, -5.750661711649955, 132.98524065102194, 9.473693381050099,
    -5.457057460924525, 133.32530332530084, 9.436719174727399, -4.833943329993167, 133.95055075589366,
    9.357612048346752, -4.503235914934432, 134.2369242315246, 9.315391847151961, -3.7999283551076353,
    134.76122801408704, 9.221840730823848, -3.4291134287849614, 134.9971248370722, 9.170664882730756,
    -2.6672860496190394, 135.4006878534293, 9.058286474591046, -2.274309107710132, 135.57058839714873,
    8.9969302683887, -1.4571559996349592, 135.83647835441352, 8.858715280641505, -1.0316899743426133,
    135.93214334262387, 8.781508888905504, -0.49773515326997947, 135.9899394779507, 8.676100530648066,
    -0.39129503657357856, 135.99845367589347, 8.654680788379459, -0.25782957370364307, 136.0052020854995,
    8.627290053857552, -0.23115974543751963, 136.00635544891654, 8.62179024531854, -0.19112848176295943,
    136.00779038162267, 8.613494983352583, -0.17778479172193756, 136.0082194082205, 8.610723242467449,
    -0.1510914306031252, 136.00897848632846, 8.605165115177973, -0.14239480311118183, 136.00921209410902,
    8.603352436676312, -0.051038581586649395, 136.01112402560273, 8.58423746576828, 0.02933886917774869,
    136.01115781071027, 8.567197530254468, 0.1833844010438239, 136.0076279377412, 8.534064041703559,
    0.2605523311941201, 136.00414861258332, 8.517239667432763, 0.3572661921436377, 135.9975490486877,
    8.495863519890394, 0.36830038777303403, 135.9981233264037, 8.493425168172807, 0.39605139509568504,
    135.99798192122304, 8.487269523206178, 0.4099246461521002, 135.99791123011119, 8.484183570518347,
    0.45153836601203706, 135.99769918751812, 8.474901166780052, 0.4792713549882382, 135.99755787415015,
    8.468680489150367, 0.6179057321706284, 135.99685146306888, 8.437411340880214, 0.7286575625414458,
    135.99628712742577, 8.411878458618943, 0.8392501083754258, 135.99572360341836, 8.3858299768281,
    -3.9131816385819493, 129.32644780823009, 9.316253657351702, -3.8823524393673696, 129.43615688784737,
    9.310380421495562, -3.851523614858261, 129.54586519990772, 9.304492712939695, -3.812988052995922,
    129.68299962927802, 9.297114990619987, -3.8052809640625274, 129.71042646711356, 9.295638541823923,
    -3.789866833084438, 129.76528004668614, 9.292683835669632, -3.7797758291179235, 129.80105963779755,
    9.29075067245397, -3.772348500233869, 129.8280309713478, 9.289314072494825, -3.7676440153713084,
    129.84710944932974, 9.28836190079966, -3.7609445218480424, 129.87731677290031, 9.286942065525432,
    -3.758770862032659, 129.88765092884643, 9.286470183335384, -3.755597670741365, 129.90354357230487,
    9.285764401731079, -3.7545614758647776, 129.90890859464392, 9.285530256165147, -3.7524860466007786,
    129.9197580088042, 9.285059105222706, -3.751431690697083, 129.92523751528276, 9.28482042328758,
    -3.7460751182442094, 129.9529025733016, 9.28361142462412, -3.741518309860335, 129.97589004216124,
    9.282594333220969, -3.7269771490614425, 130.04718696849517, 9.279391341476952, -3.7161196044637124,
    130.09782401141152, 9.277053633813408, -3.655430153925747, 130.36391687766678, 9.264332404446895,
    -3.5862914560994192, 130.61691808934845, 9.25088801214207, -3.397178115222979, 131.1610897954371,
    9.216687246817308, -3.2808529062815137, 131.44797719383578, 9.1964589948201, -3.004121846339839,
    132.02185559218339, 9.149276790972557, -2.8429166979152822, 132.3100658793868, 9.122219420605536,
    -2.4655562438798064, 132.8663702686714, 9.058516847322363, -2.250321707205387, 133.13316771636408,
    9.021979621384538, -1.7787970726400018, 133.60917015636093, 8.939415106116135, -1.520162903612049,
    133.82010462359636, 8.893019560496903, -0.9584374296639432, 134.15889312209387, 8.787377131153024,
    -0.652987285098531, 134.28632715471622, 8.727527113946131, -0.2681707497947937, 134.37094921105592,
    8.647756758603137, -0.19090073532245433, 134.38423139938533, 8.631531429282154, -0.09413374731160777,
    134.39607306017035, 8.610939991449143, -0.07477143584705133, 134.39820338117443, 8.606806245556404,
    -0.04571858210298631, 134.401038067692, 8.600583078001609, -0.036032733354027, 134.40192283150233,
    8.598504930990597, -0.016658577822407233, 134.4035714719716, 8.594341232054964, -0.01034444630093592,
    134.40409001969192, 8.592983309338576, 0.05600658161316764, 134.40890751770823, 8.578676183520802,
    0.11417003902880346, 134.4120523102775, 8.56601031994174, 0.2253077539591141, 134.41574308417574,
    8.54154712136626, 0.28084108399529956, 134.41647533027847, 8.529197974670689, 0.35021327756953247,
    134.4159548722028, 8.513613316764685, 0.36408545031557826, 134.415810616312, 8.51048865657403,
    0.3918251112684893, 134.4155568707914, 8.504222734958816, 0.4056926226405478, 134.41543000749303,
    8.501081646739117, 0.44728820068238667, 134.41504944597847, 8.491634004668272, 0.4750093112882186,
    134.41479577614456, 8.485303073439793, 0.6135685064985409, 134.4135276161548, 8.453485963635481,
    0.7242675205528715, 134.4125136935631, 8.427512435147383, 0.8348183727732191, 134.4115003761904,
    8.401019774194422, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
    1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
    1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.6691058544594986, 0.6688865990314158,
    0.6686672565131792, 0.6683929691893182, 0.6683381062657665, 0.6682283694933275, 0.6681564027597872,
    0.6681039979337695, 0.6680725813919313, 0.6680305509159506, 0.6680173895560066, 0.6679988953245704,
    0.6679546337150146, 0.6680778662212219, 0.668139124021178, 0.6684436858689873, 0.6686818417925587,
    0.6693812873675187, 0.6698275629976257, 0.6719669029054586, 0.6733789807956261, 0.6758007965089392,
    0.6768040791072742, 0.6786837165660182, 0.6795551707538523, 0.6815130615959131, 0.6826011961641374,
    0.6854661059927887, 0.6872411628498425, 0.6922252393270476, 0.6954915207869071, 0.7008220266908965,
    0.7019507681840137, 0.7034442790860269, 0.7037471067855738, 0.7042076055834305, 0.7043621480036217,
    0.7046733293894609, 0.7047750183482125, 0.7058550636995802, 0.7068412385463118, 0.7088094133062336,
    0.7098330577422911, 0.7111621627381018, 0.7110042094480642, 0.7109795087662096, 0.7109671575857474,
    0.7109301015264439, 0.710905394129497, 0.710781840366068, 0.7106829436644074, 0.7105839933698324, 1.0, 1.0, 1.0,
    1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
    1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
    1.0, 1.0, 1.0, 1.0, 1.0,
};
const int32_t kAlbSurfI[] = {
    2, 3, 3, 52, 2, 26, 1, 0, 0, 0, 0, 3, 3, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 4,
};

} // namespace

namespace {

/** project::wholeFirstSpans set for a scope (0: segments past a side cut straight away), then put back. */
struct WholeFirst {
  int was;
  explicit WholeFirst(int n) : was(project::wholeFirstSpans) { project::wholeFirstSpans = n; }
  ~WholeFirst() { project::wholeFirstSpans = was; }
};

/** The flat unit square z = 0 as a bilinear B-spline: (u, v) is (x, y), its sides x and y = 0 and 1. */
std::unique_ptr<Surface> unitSquare() {
  const int32_t in[] = {1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 0, 2, 2, 2, 2};
  const double r[] = {0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0};
  Status st;
  return surfaces::makeBSpline(r, in, st);
}

/** The circle of radius rad about (0.5, 0.5, z) in the plane z, from +x. */
std::unique_ptr<Curve> squareCircle(double rad, double z) {
  const double cr[9] = {0.5, 0.5, z, 0, 0, 1, 1, 0, 0};
  return curves::makeEllipse(cr, 3, rad, rad);
}

/** The piece of p holding t (the last one at a join). */
const PcurvePiece& pieceAt(const Pcurve& p, double t) {
  for (const PcurvePiece& q : p.pieces)
    if (t >= q.t.lo && t <= q.t.hi) return q;
  return p.pieces.back();
}

/** p's pieces split at their B-splines' interior knots of multiplicity 3 (a cut segment's joins): the ranges cut. */
std::vector<Range> joins(const Pcurve& p) {
  std::vector<Range> out;
  for (const PcurvePiece& q : p.pieces) {
    double lo = q.t.lo;
    if (q.kind == CBR_CURVE_BSPLINE && q.ints[0] == 3)
      for (int i = 1; i + 1 < q.ints[2]; i++)
        if (q.ints[7 + i] >= 3) out.push_back({lo, q.reals[i]}), lo = q.reals[i];
    out.push_back({lo, q.t.hi});
  }
  return out;
}

/**
 * The checks every side-cut p-curve on the square passes: one piece, C0 at the cuts (knots of multiplicity 3); S(p(t))
 * against the square's nearest point to C(t) (x and y clamped) within the fit's tolerance (a quarter of the distance)
 * at 241 parameters; the error the largest distance within that too; ranges on a side exactly that side's line; the
 * cut parameters where C crosses a side line (x or y 0 or 1) within 1e-9, as `cuts` gives them.
 */
void sideChecks(const Pcurve& p, const Curve& c, const Surface& sq, Range r, const std::vector<double>& cuts) {
  REQUIRE(p.pieces.size() == 1);
  const std::vector<Range> rs = joins(p);
  REQUIRE(rs.size() == cuts.size() + 1);
  for (size_t k = 0; k < cuts.size(); k++) CHECK_NEAR(rs[k].hi, cuts[k], 0, 1e-9);
  double worst = 0, gap = 0;
  for (int k = 0; k <= 240; k++) {
    const double t = r.lo + (r.hi - r.lo) * k / 240;
    const Vec2 uv = uvAt(pieceAt(p, t), t);
    SurfacePoint sp;
    CurvePoint q;
    sq.eval(uv.x, uv.y, 0, sp);
    c.eval(t, 0, q);
    const Vec3 foot{std::clamp(q.p.x, 0.0, 1.0), std::clamp(q.p.y, 0.0, 1.0), 0};
    worst = std::max(worst, norm(sp.p - foot)), gap = std::max(gap, norm(q.p - foot));
  }
  CHECK(worst <= 0.25 * gap);
  CHECK(p.error >= gap * (1 - 1e-9) && p.error <= gap + 0.25 * gap);
  // On a side, every pole on its line: x or y exactly 0 or 1 at the range's middle and so all along.
  for (const Range& q : rs) {
    const Vec2 m = uvAt(p.pieces[0], 0.5 * (q.lo + q.hi));
    for (int axis = 0; axis < 2; axis++) {
      const double x = axis ? m.y : m.x;
      if (x != 0 && x != 1) continue;
      for (int k = 0; k <= 16; k++) {
        const Vec2 uv = uvAt(p.pieces[0], q.lo + (q.hi - q.lo) * k / 16);
        CHECK((axis ? uv.y : uv.x) == x);
      }
    }
  }
}

} // namespace

TEST_CASE("a curve ending at a pole, shorter than its tolerance: through the pole only at that end, traced") {
  // A flat triangle as a bilinear B-spline, its u = 1 row of poles one point (a pole at (1, 0.5, 0)): S(u, v) =
  // (u, v + u (0.5 - v), 0) on [0, 1]^2. The line along v = 0 from S(0.6, 0) to the pole is 0.45 long; at tol 1 both
  // its ends are within tol of the pole, but only its end passes through it.
  const int32_t in[] = {1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 0, 2, 2, 2, 2};
  const double r[] = {0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0.5, 0, 1, 0.5, 0};
  Status st;
  std::unique_ptr<Surface> tri = surfaces::makeBSpline(r, in, st);
  REQUIRE(tri);
  const double len = std::hypot(0.4, 0.2), lr[7] = {0.6, 0.3, 0, 0.4 / len, 0.2 / len, 0, len};
  std::unique_ptr<Curve> line = curves::makeLine(lr, 3);
  for (double tol : {1.0, 1e-6}) {
    Pcurve p = projectCurve(*line, {0, 1}, *tri, tol);
    CHECK(p.status == Status::ok);
    REQUIRE(!p.pieces.empty());
    CHECK_NEAR(uvAt(p.pieces.front(), 0).x, 0.6, 0, 1e-6);
    CHECK_NEAR(uvAt(p.pieces.front(), 0).y, 0, 0, 1e-6);
    CHECK_NEAR(uvAt(p.pieces.back(), 1).x, 1, 0, 1e-9);
  }
}

TEST_CASE("a curve past its surface's sides: cut where its feet reach and leave a side, joined there") {
  const WholeFirst cutNow(0);
  const double tol = 1e-6;
  std::unique_ptr<Surface> sq = unitSquare();
  REQUIRE(sq);
  // A circle of radius 0.6 about the square's centre, in its plane: past x = 1 for |t| < acos(5/6), past y = 1 for t in
  // (asin(5/6), pi - asin(5/6)), and so round. Its distance from the square is its distance past the sides.
  const double a = std::acos(5.0 / 6), b = std::asin(5.0 / 6);
  std::unique_ptr<Curve> c = squareCircle(0.6, 0);
  {
    // One crossing the other way: from inside to past x = 1, the largest gap at the end (the second range's).
    Pcurve p = project::projectForms(*c, {-0.9, -0.2}, *sq, tol, nullptr, {}, {});
    CHECK(p.status == Status::invalidModel);
    sideChecks(p, *c, *sq, {-0.9, -0.2}, {-a});
  }
  {
    // One crossing: from past x = 1 to inside.
    const long f0 = project::traceFits;
    Pcurve p = project::projectForms(*c, {0.2, 0.9}, *sq, tol, nullptr, {}, {});
    CHECK(p.status == Status::invalidModel);
    CHECK(p.method == PcurveMethod::traced);
    sideChecks(p, *c, *sq, {0.2, 0.9}, {a});
    CHECK(project::traceFits - f0 <= 2);
  }
  {
    // Eight, every side twice, on a circle of radius 0.52, from past x = 1 to past it again. (A circle of radius 0.6 so
    // traced stops along a long stretch on a side: the march's rate there is the unclamped foot's.)
    std::unique_ptr<Curve> c2 = squareCircle(0.52, 0);
    const double a2 = std::acos(0.5 / 0.52), b2 = std::asin(0.5 / 0.52);
    const Range r{0.1, kTwoPi - 0.1};
    Pcurve p = project::projectForms(*c2, r, *sq, tol, nullptr, {}, {});
    CHECK(p.status == Status::invalidModel);
    sideChecks(p, *c2, *sq, r, {a2, b2, M_PI - b2, M_PI - a2, M_PI + a2, M_PI + b2, kTwoPi - b2, kTwoPi - a2});
    // Five pieces on the sides: x = 1 at both ends, each other side once, each exactly its line.
    int onSides = 0;
    for (const Range& q : joins(p)) {
      const Vec2 m = uvAt(p.pieces[0], 0.5 * (q.lo + q.hi));
      onSides += m.x == 0 || m.x == 1 || m.y == 0 || m.y == 1;
    }
    CHECK_EQ(onSides, 5);
  }
  {
    // The same 0.01 above the square: off it everywhere, cut the same.
    std::unique_ptr<Curve> up = squareCircle(0.6, 0.01);
    Pcurve p = project::projectForms(*up, {0.2, 0.9}, *sq, tol, nullptr, {}, {});
    CHECK(p.status == Status::invalidModel);
    REQUIRE(joins(p).size() == 2);
    CHECK_NEAR(joins(p)[0].hi, a, 0, 1e-9);
    CHECK_NEAR(p.error, std::hypot(0.5 + 0.6 * std::cos(0.2) - 1, 0.01), 0, 0.25 * 0.01);
  }
}

TEST_CASE("a corpus curve along its surface's side, past it on stretches: cut there, few poles, the gap its error") {
  Status st;
  std::unique_ptr<Curve> c = curves::makeBSpline(kAlbCurveR, kAlbCurveI, 3, st);
  REQUIRE(c);
  std::unique_ptr<Surface> s = surfaces::makeBSpline(kAlbSurfR, kAlbSurfI, st);
  REQUIRE(s);
  const double tol = 1e-5;
  Pcurve p = project::projectForms(*c, c->domain().range, *s, tol, nullptr, {}, {});
  CHECK(p.status == Status::invalidModel);
  CHECK(p.method == PcurveMethod::traced);
  CHECK_NEAR(p.error, 3.6042e-4, 0, 1e-7);
  int poles = 0, onSide = 0;
  for (const PcurvePiece& q : p.pieces) poles += q.ints.size() > 1 ? q.ints[1] : 2;
  for (const Range& q : joins(p)) {
    bool all = true;
    for (int k = 0; k <= 16; k++) all = all && uvAt(pieceAt(p, q.lo), q.lo + (q.hi - q.lo) * k / 16).x == 1;
    onSide += all;
  }
  // On the side its feet are refined along it (footFrom's steps cut off at the side leave their v noisy: 699 poles
  // for the longest stretch alone).
  CHECK(poles <= 200);
  CHECK(onSide >= 3);
  if (!(poles <= 200 && onSide >= 3))
    std::printf("    poles %d on the side %d pieces %zu\n", poles, onSide, p.pieces.size());
}

TEST_CASE("a corpus curve past a side, a bump in its feet between a fit's checks: cut there, the error the gap") {
  Status st;
  std::unique_ptr<Curve> c = curves::makeBSpline(k278CurveR, k278CurveI, 3, st);
  REQUIRE(c);
  std::unique_ptr<Surface> s = surfaces::makeBSpline(k278SurfR, k278SurfI, st);
  REQUIRE(s);
  const double tol = 1e-5;
  Pcurve p = project::projectForms(*c, c->domain().range, *s, tol, nullptr, {}, {});
  CHECK(p.status == Status::invalidModel);
  CHECK(joins(p).size() >= 5);
  CHECK_NEAR(p.error, 1.1313e-4, 0, 2e-7);
  // Not cut (as before the cutting): fitted whole from footAt's feet, its spans fine enough near the bump, one piece.
  const WholeFirst never(1 << 20);
  Pcurve q = project::projectForms(*c, c->domain().range, *s, tol, nullptr, {}, {});
  CHECK(q.status == Status::invalidModel);
  CHECK_EQ(q.pieces.size(), size_t(1));
  CHECK_NEAR(q.error, 1.1313e-4, 0, 2e-7);
}

TEST_CASE("a corpus curve past a side, at a tolerance past its distance: cut, within tol, not a whole fit's miss") {
  Status st;
  std::unique_ptr<Curve> c = curves::makeBSpline(k25287CurveR, k25287CurveI, 3, st);
  REQUIRE(c);
  std::unique_ptr<Surface> s = surfaces::makeBSpline(k25287SurfR, k25287SurfI, st);
  REQUIRE(s);
  for (double tol : {3.6e-4, 1e-5}) {
    Pcurve p = project::projectForms(*c, c->domain().range, *s, tol, nullptr, {}, {});
    CHECK(p.status == (tol > 3.3e-4 ? Status::ok : Status::invalidModel));
    CHECK(p.error < 3.4e-4);
    if (!(p.error < 3.4e-4)) std::printf("    tol %g: status %d error %g\n", tol, int(p.status), p.error);
  }
}

TEST_CASE("a corpus curve with corners at its joints: fitted again cut there when a fit through them runs out") {
  Status st;
  std::unique_ptr<Curve> c = curves::makeBSpline(kPistonCurveR, kPistonCurveI, 3, st);
  REQUIRE(c);
  std::unique_ptr<Surface> s = surfaces::makeBSpline(kPistonSurfR, kPistonSurfI, st);
  REQUIRE(s);
  const double tol = 1e-3;
  Pcurve p = projectCurve(*c, c->domain().range, *s, tol);
  CHECK(p.status == Status::ok);
  CHECK(p.error <= tol);
  if (!(p.status == Status::ok && p.error <= tol)) std::printf("    status %d error %g\n", int(p.status), p.error);
  // Cut at its C1 joints: one piece, its knots of multiplicity 3 there.
  REQUIRE(p.pieces.size() == 1);
  CHECK(joins(p).size() > 10);
}

TEST_CASE("a corpus curve whose end seeds a spurious branch of feet: traced again from a global foot beating it") {
  Status st;
  std::unique_ptr<Curve> c = curves::makeBSpline(kLmpCurveR, kLmpCurveI, 3, st);
  REQUIRE(c);
  std::unique_ptr<Surface> s = closeInFact(surfaces::makeBSpline(kLmpSurfR, kLmpSurfI, st), 0.1136);
  REQUIRE(s);
  const double tol = 0.113609150404091;
  // Its vertices at its ends, searched as projectCoedge searches them: the trace seeded at its start's foot.
  EndSearchCache cache;
  PcurveEnds ends;
  CurvePoint a, b;
  c->eval(0, 0, a), c->eval(1, 0, b);
  ends.cache = &cache, ends.checkStart = ends.checkEnd = true, ends.startKey = 1, ends.endKey = 2;
  ends.startPoint = a.p, ends.endPoint = b.p;
  Pcurve p = projectCurve(*c, {0, 1}, *s, tol, &ends);
  CHECK(p.status == Status::ok);
  CHECK(p.error <= tol);
  REQUIRE(!p.pieces.empty());
  const Vec2 lo = uvAt(p.pieces.front(), 0), hi = uvAt(p.pieces.back(), 1);
  CHECK(std::fabs(lo.x) < 1e-9 && lo.y == 1 && std::fabs(hi.x - 1) < 1e-9 && hi.y == 1);
  CHECK(p.endCheck[0] == EndCheck::same && p.endCheck[1] == EndCheck::same);
  if (!(p.status == Status::ok && p.error <= tol))
    std::printf("    status %d error %g from (%g, %g) to (%g, %g)\n", int(p.status), p.error, lo.x, lo.y, hi.x, hi.y);
}

TEST_CASE("a curve past a skewed surface's side: its feet the side's nearest points, the error the gap") {
  const WholeFirst cutNow(0);
  // The skewed plane S(u, v) = (u + 0.95 v, v, 0) on [0, 1]^2: from a foot clamped to u = 1, the 2D Newton step goes
  // to the unclamped foot and the clamp back, its v that foot's, not the side's nearest point (along the side by 0.69
  // of the distance past it).
  const double tol = 1e-6;
  const int32_t in[] = {1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 0, 2, 2, 2, 2};
  const double r[] = {0, 1, 0, 1, 0, 0, 0, 0.95, 1, 0, 1, 0, 0, 1.95, 1, 0};
  Status st;
  std::unique_ptr<Surface> sk = surfaces::makeBSpline(r, in, st);
  REQUIRE(sk);
  // The distance past the side: to the line through (1, 0, 0) along (0.95, 1, 0).
  auto gapOf = [](Vec3 p) {
    const Vec3 a{1, 0, 0}, d = (1 / std::hypot(0.95, 1.0)) * Vec3{0.95, 1, 0}, w = p - a;
    return norm(w - dot(w, d) * d);
  };
  {
    // A line from S(0.9, 0.1) to S(1.1, 0.9), past u = 1 for t > 0.5: two lines, the error the gap at its end.
    const Vec3 a{0.9 + 0.95 * 0.1, 0.1, 0}, b{1.1 + 0.95 * 0.9, 0.9, 0};
    const double lr[7] = {a.x, a.y, 0, (b.x - a.x) / norm(b - a), (b.y - a.y) / norm(b - a), 0, norm(b - a)};
    std::unique_ptr<Curve> line = curves::makeLine(lr, 3);
    Pcurve p = project::projectForms(*line, {0, 1}, *sk, tol, nullptr, {}, {});
    CHECK(p.status == Status::invalidModel);
    CHECK(p.method == PcurveMethod::affineFeet);
    REQUIRE(joins(p).size() == 2);
    CHECK_NEAR(joins(p)[0].hi, 0.5, 0, 1e-9);
    CHECK_NEAR(p.error, gapOf(b), 1e-9, 0);
  }
  {
    // An arc past u = 1 throughout (its u from 1.011): one fitted piece on the side's line, the error the largest gap.
    const double cr[9] = {1.08 + 0.95 * 0.5, 0.5, 0, 0, 0, 1, 1, 0, 0};
    std::unique_ptr<Curve> arc = curves::makeEllipse(cr, 3, 0.05, 0.05);
    const Range rg{M_PI - 1, M_PI + 1};
    double gap = 0;
    for (int k = 0; k <= 2000; k++) {
      CurvePoint q;
      arc->eval(rg.lo + (rg.hi - rg.lo) * k / 2000, 0, q);
      gap = std::max(gap, gapOf(q.p));
    }
    Pcurve p = project::projectForms(*arc, rg, *sk, tol, nullptr, {}, {});
    CHECK(p.status == Status::invalidModel);
    CHECK(p.method == PcurveMethod::traced);
    REQUIRE(p.pieces.size() == 1);
    CHECK_NEAR(p.error, gap, 1e-6, 0);
    for (int k = 0; k <= 32; k++) CHECK(uvAt(p.pieces[0], rg.lo + (rg.hi - rg.lo) * k / 32).x == 1);
  }
}

TEST_CASE("a curve past two sides: cut only at the one it passes by more than a quarter of tol") {
  const WholeFirst cutNow(0);
  // On the unit square: a polyline past x = 1 by tol / 8 for y in [0.2, 0.4], then inside, then past y = 1 by up to
  // 0.05 (crossing y = 1 at t = 2 + 0.4 / 0.45). Within a quarter of tol along x = 1, so not cut there; one cut.
  const double tol = 1e-6;
  std::unique_ptr<Surface> sq = unitSquare();
  REQUIRE(sq);
  const double pr[12] = {1 + 0.125 * tol, 0.2, 0, 1 + 0.125 * tol, 0.4, 0, 0.8, 0.6, 0, 0.6, 1.05, 0};
  std::unique_ptr<Curve> pl = curves::makePolyline(pr, 4, 3);
  Pcurve p = project::projectForms(*pl, {0, 3}, *sq, tol, nullptr, {}, {});
  CHECK(p.status == Status::invalidModel);
  REQUIRE(joins(p).size() == 2);
  CHECK_NEAR(joins(p)[0].hi, 2 + 0.4 / 0.45, 0, 1e-9);
  CHECK_NEAR(p.error, 0.05, 1e-9, 0);
  // Its line past x = 1, in (u, v) (0.9, 0.1) to (1.1, 0.9): lines either side of t = 0.5, affine feet.
  const double lr[7] = {0.9, 0.1, 0, 0.2 / std::hypot(0.2, 0.8), 0.8 / std::hypot(0.2, 0.8), 0, std::hypot(0.2, 0.8)};
  std::unique_ptr<Curve> line = curves::makeLine(lr, 3);
  Pcurve q = project::projectForms(*line, {0, 1}, *sq, tol, nullptr, {}, {});
  CHECK(q.method == PcurveMethod::affineFeet);
  REQUIRE(joins(q).size() == 2);
  CHECK_NEAR(joins(q)[0].hi, 0.5, 0, 1e-9);
  CHECK_NEAR(q.error, 0.1, 1e-9, 0);
}

TEST_CASE("a curve past a side with mild corners: fitted whole first, as without the cutting") {
  // The circle of radius 0.6 past x = 1 then inside: its corner fits within 64 spans, so it stays one piece, the same
  // p-curve as with the cutting off altogether (wholeFirstSpans past any fit's cap).
  const double tol = 1e-6;
  std::unique_ptr<Surface> sq = unitSquare();
  REQUIRE(sq);
  std::unique_ptr<Curve> c = squareCircle(0.6, 0);
  Pcurve p = project::projectForms(*c, {0.2, 0.9}, *sq, tol, nullptr, {}, {});
  Pcurve q;
  {
    const WholeFirst never(1 << 20);
    q = project::projectForms(*c, {0.2, 0.9}, *sq, tol, nullptr, {}, {});
  }
  CHECK(p.status == Status::invalidModel);
  REQUIRE(p.pieces.size() == 1);
  REQUIRE(q.pieces.size() == 1);
  CHECK_EQ(joins(p).size(), size_t(1));
  CHECK(p.pieces[0].reals == q.pieces[0].reals);
  CHECK(p.error == q.error);
  // Cut straight away instead: two ranges, joined.
  const WholeFirst cutNow(0);
  CHECK_EQ(joins(project::projectForms(*c, {0.2, 0.9}, *sq, tol, nullptr, {}, {})).size(), size_t(2));
}

TEST_CASE("a curve past a side: wholly along it its line, touching it not cut, a seam not a side") {
  const WholeFirst cutNow(0);
  const double tol = 1e-6;
  std::unique_ptr<Surface> sq = unitSquare();
  REQUIRE(sq);
  // Wholly past x = 1 (a line at x = 1.05) and past y = 1 (y = 1.05): one piece, the side's line, off by 0.05.
  for (int axis = 0; axis < 2; axis++) {
    const double lr[7] = {axis ? 0.1 : 1.05, axis ? 1.05 : 0.1, 0, axis ? 1.0 : 0.0, axis ? 0.0 : 1.0, 0, 0.8};
    std::unique_ptr<Curve> line = curves::makeLine(lr, 3);
    Pcurve p = project::projectForms(*line, {0, 1}, *sq, tol, nullptr, {}, {});
    CHECK(p.status == Status::invalidModel);
    REQUIRE(p.pieces.size() == 1);
    for (int k = 0; k <= 8; k++) CHECK((axis ? uvAt(p.pieces[0], k / 8.0).y : uvAt(p.pieces[0], k / 8.0).x) == 1);
    CHECK_NEAR(p.error, 0.05, 0, 1e-9);
  }
  {
    // A circle of radius 0.5, 0.01 above: its feet touch x = 1 at t = 0 alone, no corner there: one piece.
    std::unique_ptr<Curve> c = squareCircle(0.5, 0.01);
    Pcurve p = project::projectForms(*c, {-1, 1}, *sq, tol, nullptr, {}, {});
    CHECK(p.status == Status::invalidModel);
    CHECK_EQ(p.pieces.size(), size_t(1));
    CHECK_NEAR(p.error, 0.01, 0, 0.25 * 0.01);
  }
  {
    // On a cylinder (u periodic, closed), an ellipse 1e-5 off it across the seam at u = 0: the seam's bound is no
    // side, so one fit, one piece.
    const double R = 2, ctol = 1e-7, th = 0.3;
    const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, R};
    std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr, R, 0), ctol);
    const double cr[9] = {0, 0, 1, std::sin(th), 0, std::cos(th), std::cos(th), 0, -std::sin(th)};
    std::unique_ptr<Curve> el = curves::makeEllipse(cr, 3, R / std::cos(th) + 1e-5, R + 1e-5);
    for (Range r : {Range{-1, 1}, Range{0, 1}}) {
      const long f0 = project::traceFits;
      Pcurve p = project::projectForms(*el, r, *cyl, ctol, nullptr, {}, {});
      CHECK(p.status == Status::invalidModel);
      CHECK_EQ(project::traceFits - f0, 1);
      CHECK_EQ(p.pieces.size(), size_t(1));
    }
  }
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
