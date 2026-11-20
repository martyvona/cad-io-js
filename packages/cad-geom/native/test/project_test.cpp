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

TEST_CASE("a curve farther off its surface between the samples: the fit stops when tightening gains too little") {
  // A helix round a cylinder whose radius has a narrow bump (1e-5 high, 0.01 wide in t): its feet don't move with
  // it, and it falls between the samples offSurface is taken at, so the error measured (its peak, 2e-5) stays over
  // offSurface (1e-5) + a quarter of the fit's tolerance. The angle's wiggle makes the second fit differ from the
  // first, nearer by about 3e-8 (over 0, under a quarter of the fit's tolerance), and that ends it.
  const double tol = 1e-7;
  const double sr[10] = {0, 0, 0, 0, 0, 1, 1, 0, 0, Bump::kR};
  std::unique_ptr<Surface> cyl = closeInFact(surfaces::makeCone(sr, Bump::kR, 0), tol);
  Bump w;
  const long before = project::traceFits;
  Pcurve p = project::projectForms(w, {0, 1}, *cyl, tol, nullptr, {}, {});
  const long fits = project::traceFits - before;
  CHECK(p.status == Status::invalidModel);
  CHECK(p.offSurface > 1e-5 && p.offSurface < 1.1e-5);
  CHECK(p.error > p.offSurface + 0.25 * (0.25 * p.offSurface));
  CHECK(p.error > 1.99e-5 && p.error < 2.01e-5);
  CHECK_EQ(fits, 2);
  if (fits != 2) std::printf("    fits %ld error %g offSurface %g\n", fits, p.error, p.offSurface);
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
