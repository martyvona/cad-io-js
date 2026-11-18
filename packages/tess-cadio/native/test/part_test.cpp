// part.h on whole parts, each checked by what a part's mesh must be, from the model alone: every model edge's final
// samples in every face that uses it (the same points, the consecutive ones joined by a triangle's side), a closed
// shell's mesh closed and consistently oriented (each side of a triangle used by exactly one other, the other way),
// normals unit and finite (a sphere's pole included) and on the side the triangles face, triangles within the
// deflection of the surface, the faces' areas against their closed forms, the same mesh twice.
#include <tess_cadio/edges.h>
#include <tess_cadio/part.h>

#include <cad_geom/surface.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <random>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <tuple>

#include "brep_models.h"
#include "check.h"
#include "tess_models.h"

using namespace tesscadio;
using cadgeom::Vec3;

namespace {

cadgeom::Model load(const char* name) {
  if (const tessfixtures::Model* t = tessfixtures::model(name)) return cadgeom::Model(t->data, t->size);
  const fixtures::Model* f = fixtures::model(name);
  return cadgeom::Model(f ? f->data : nullptr, f ? f->size : 0);
}

/** A test model's bytes with every coedge's p-curve removed (-1): what the projection must make again. */
std::vector<uint8_t> withoutPcurves(const char* name) {
  const tessfixtures::Model* t = tessfixtures::model(name);
  const fixtures::Model* f = t ? nullptr : fixtures::model(name);
  const uint8_t* data = t ? t->data : f ? f->data : nullptr;
  std::vector<uint8_t> b(data, data + (t ? t->size : f ? f->size : 0));
  cadgeom::Model m(b.data(), b.size());
  if (m.ok()) {
    int32_t* pc = const_cast<int32_t*>(m.i32(CBR_COEDGE_PCURVE));
    for (int c = 0; c < m.coedges(); c++) pc[c] = -1;
  }
  return b;
}

using Key = std::tuple<double, double, double>;
Key key(Vec3 p) { return {p.x, p.y, p.z}; }

/** The faces using each model edge (by its loops), each face once. */
std::map<int, std::vector<int>> edgeFaces(const cadgeom::Model& m) {
  std::map<int, std::vector<int>> out;
  for (int f = 0; f < m.faces(); f++)
    for (int i = 0; i < m.faceLoopCount(f); i++) {
      int l = m.faceFirstLoop(f) + i;
      if (m.loopKind(l) != CBR_LOOP_EDGE) continue;
      for (int k = 0; k < m.loopCount(l); k++) {
        std::vector<int>& fs = out[m.coedgeEdge(m.loopFirst(l) + k)];
        if (fs.empty() || fs.back() != f) fs.push_back(f);
      }
    }
  return out;
}

/** Each model edge's samples in each of its faces: every point there, every span a triangle's side. */
int sharedEdges(const cadgeom::Model& m, const PartMesher& pm, const char* what) {
  int bad = 0;
  // Per face, once: its vertices by point (a seam's points and a closed edge's vertex are at several: any of them),
  // its triangles' sides.
  std::vector<std::map<Key, std::vector<int>>> ats(m.faces());
  std::vector<std::set<std::pair<int, int>>> sideSets(m.faces());
  for (int f = 0; f < m.faces(); f++) {
    const FaceMesh& fm = pm.face(f);
    for (size_t i = 0; i < fm.points.size(); i++) ats[f][key(fm.points[i])].push_back(static_cast<int>(i));
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
      for (int k = 0; k < 3; k++) {
        int a = fm.triangles[t + k], b = fm.triangles[t + (k + 1) % 3];
        sideSets[f].insert({std::min(a, b), std::max(a, b)});
      }
  }
  for (auto& [e, fs] : edgeFaces(m)) {
    const EdgeSamples& s = pm.edges().edge(e);
    for (int f : fs) {
      const FaceMesh& fm = pm.face(f);
      if (fm.status != cadgeom::Status::ok) continue;
      const std::map<Key, std::vector<int>>& at = ats[f];
      const std::set<std::pair<int, int>>& sides = sideSets[f];
      int missing = 0, unjoined = 0;
      for (size_t i = 0; i < s.points.size(); i++) {
        auto it = at.find(key(s.points[i]));
        if (it == at.end()) {
          missing++;
          continue;
        }
        // (A span from a point to itself, an edge of no length's, is no side: no gap, as openEdges has it.)
        if (i + 1 < s.points.size() && key(s.points[i + 1]) != key(s.points[i])) {
          auto jt = at.find(key(s.points[i + 1]));
          bool joined = false;
          if (jt != at.end())
            for (int a : it->second)
              for (int b : jt->second) joined = joined || sides.count({std::min(a, b), std::max(a, b)});
          if (!joined) unjoined++;
        }
      }
      if (missing || unjoined) {
        std::printf("  %s: edge %d in face %d: %d samples missing, %d spans no triangle's side\n", what, e, f, missing,
          unjoined);
        bad++;
      }
    }
  }
  return bad;
}

/** A closed shell: every directed side by 3D points used once, and its reverse once. */
int closedAndOriented(const PartMesher& pm, int nf) {
  std::map<std::pair<Key, Key>, int> uses;
  for (int f = 0; f < nf; f++) {
    const FaceMesh& fm = pm.face(f);
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
      for (int k = 0; k < 3; k++)
        uses[{key(fm.points[fm.triangles[t + k]]), key(fm.points[fm.triangles[t + (k + 1) % 3]])}]++;
  }
  int bad = 0;
  for (auto& [side, n] : uses) {
    auto rev = uses.find({side.second, side.first});
    if (n != 1 || rev == uses.end() || rev->second != 1) bad++;
  }
  return bad;
}

/** Whether triangle t (an index into triangles / 3) has a corner within `near` of `pole` (at it, by default). */
bool atPole(const FaceMesh& fm, int32_t t, Vec3 pole, double near = 1e-12) {
  for (int k = 0; k < 3; k++)
    if (cadgeom::norm(fm.points[fm.triangles[3 * t + k]] - pole) < near) return true;
  return false;
}

struct Stats {
  double area = 0, worst = 0;
  int badNormals = 0, facing = 0;
};
/**
 * A face's mesh: its area, its triangles' worst distance from the surface (by `dist`, the surface's own measure),
 * normals not unit or not finite, triangles facing against their corners' normals.
 */
template <class Dist> Stats stats(const FaceMesh& fm, Dist dist, const Vec3* pole = nullptr, double near = 1e-12) {
  Stats s;
  for (const Vec3& n : fm.normals)
    if (!std::isfinite(n.x) || !std::isfinite(n.y) || !std::isfinite(n.z) || std::fabs(cadgeom::norm(n) - 1) > 1e-9)
      s.badNormals++;
  for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
    Vec3 a = fm.points[fm.triangles[t]], b = fm.points[fm.triangles[t + 1]], c = fm.points[fm.triangles[t + 2]];
    Vec3 g = cadgeom::cross(b - a, c - a);
    s.area += 0.5 * cadgeom::norm(g);
    Vec3 nsum = fm.normals[fm.triangles[t]] + fm.normals[fm.triangles[t + 1]] + fm.normals[fm.triangles[t + 2]];
    // (A pole's fan's slivers aside: poleFanOnly.)
    if (cadgeom::dot(g, nsum) <= 0 && !(pole && atPole(fm, static_cast<int32_t>(t / 3), *pole, near))) s.facing++;
    for (double u : {1. / 3, 0.5}) {
      Vec3 p = u == 0.5 ? 0.5 * (a + b) : (1.0 / 3) * (a + b + c);
      s.worst = std::fmax(s.worst, dist(p));
    }
  }
  return s;
}

/**
 * The face's refused triangles other than those in a pole's fan (a corner at `pole`): slivers there, skewed or turned
 * over in 3D, that refinement in (u, v) can't reach until poles are meshed as fans.
 */
int poleFanOnly(const FaceMesh& fm, Vec3 pole, double near = 1e-12) {
  int bad = 0;
  for (int32_t t : fm.rejected)
    if (!atPole(fm, t, pole, near)) {
      std::printf("  triangle %d refused, away from the pole\n", t);
      bad++;
    }
  return bad;
}

PartOptions options(double linear, double angular) {
  PartOptions o;
  o.d.linear = linear;
  o.d.angular = angular;
  return o;
}

} // namespace

TEST_CASE("the cube: six squares, closed and outward, each edge's samples in both its faces") {
  cadgeom::Model m = load("cube");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 0.26));
  for (int f = 0; f < m.faces(); f++) {
    REQUIRE(pm.face(f).status == cadgeom::Status::ok);
    Stats s = stats(pm.face(f), [](Vec3) { return 0.0; });
    CHECK_EQ(s.badNormals, 0);
    CHECK_EQ(s.facing, 0);
  }
  CHECK_EQ(sharedEdges(m, pm, "cube"), 0);
  CHECK_EQ(closedAndOriented(pm, m.faces()), 0);
  // Outward: each face's normal away from the cube's centre.
  for (int f = 0; f < m.faces(); f++) {
    const FaceMesh& fm = pm.face(f);
    Vec3 c{0, 0, 0};
    for (const Vec3& p : fm.points) c = c + p;
    c = (1.0 / fm.points.size()) * c;
    CHECK(cadgeom::dot(fm.normals[0], c - Vec3{0.5, 0.5, 0.5}) > 0);
  }
}

TEST_CASE("curved faces (a seam cylinder, a band, a hemisphere, a cap, a lune): within the deflection, to area") {
  struct Case {
    const char* model;
    int face;
    double area, radius;
    Vec3 centre;
    bool cylinder;
    // How near the pole the fan's slivers reach: a boundary through the pole or passing near it (offPoleArc's 7e-4
    // from it) has them about the pole, not only at it.
    double near = 1e-12;
  };
  for (Case c : {Case{"seamCylinder", 0, 20 * M_PI, 2, {0, 0, 0}, true}, Case{"band", 0, 20 * M_PI, 2, {0, 0, 0}, true},
         Case{"bore", 0, 20 * M_PI, 2, {0, 0, 0}, true}, Case{"bandHoleAtVertex", 0, 20 * M_PI - 2, 2, {}, true},
         Case{"bandHoleOnCut", 0, 20 * M_PI - 2, 2, {}, true},
         Case{"spheres", 1, 2 * M_PI, 1, {10, 0, 0}, false},
         Case{"halfCap", 0, M_PI * 0.6, 1, {0, 0, 0}, false, 0.1},
         Case{"meridianHemisphere", 0, 2 * M_PI, 1, {0, 0, 0}, false, 0.1},
         Case{"meridianHemisphereLoose", 0, 2 * M_PI * 3.81 * 3.81, 3.81, {0, 0, 0}, false, 0.4},
         Case{"offPoleArc", 0, M_PI, 1, {0, 0, 0}, false, 0.1},
         Case{"offPoleArcLoose", 0, M_PI, 1, {0, 0, 0}, false, 0.1},
         Case{"bsplineTube", 0, 20 * M_PI, 2, {0, 0, 0}, true}, Case{"bsplineDome", 0, 2 * M_PI, 1, {0, 0, 0}, false},
         Case{"bsplineTubeTinyArc", 0, 20 * M_PI, 2, {0, 0, 0}, true},
         Case{"tubeGapFaceTolerance", 0, 20 * M_PI, 2, {0, 0, 0}, true},
         Case{"tubeGapUncertainty", 0, 20 * M_PI, 2, {0, 0, 0}, true},
         Case{"tubeGapBySize", 0, 20 * M_PI, 2, {0, 0, 0}, true},
         Case{"cap", 0, 2 * M_PI * (1 - M_SQRT1_2), 1, {}, false},
         Case{"luneQuarter", 0, M_PI, 1, {}, false}}) {
    // As given, and with its p-curves removed where it has any: projected from the edges' curves instead.
    const std::vector<uint8_t> bare = withoutPcurves(c.model);
    for (bool strip : {false, true}) {
      cadgeom::Model given = load(c.model);
      REQUIRE(given.ok());
      bool any = false;
      for (int co = 0; co < given.coedges(); co++) any = any || given.coedgePcurve(co) >= 0;
      if (strip && !any) continue;
      cadgeom::Model m = strip ? cadgeom::Model(bare.data(), bare.size()) : given;
      REQUIRE(m.ok());
      for (double d : {0.05, 0.01}) {
        PartMesher pm(m, options(d, 0.26));
        const FaceMesh& fm = pm.face(c.face);
        if (strip) {
          int projected = 0;
          for (int co = 0; co < m.coedges(); co++) projected += pm.edges().coedge(co).projected;
          if (!projected) std::printf("  %s without p-curves: none projected\n", c.model);
          CHECK(projected > 0);
        }
        if (fm.status != cadgeom::Status::ok)
          std::printf("  %s%s: status %d\n", c.model, strip ? " without p-curves" : "", int(fm.status));
        REQUIRE(fm.status == cadgeom::Status::ok);
        Vec3 pole = c.centre + Vec3{0, 0, c.radius};
        Stats s = stats(fm, [&](Vec3 p) {
          Vec3 q = p - c.centre;
          return std::fabs((c.cylinder ? std::hypot(q.x, q.y) : cadgeom::norm(q)) - c.radius);
        }, c.cylinder ? nullptr : &pole, c.near);
        CHECK_EQ(s.badNormals, 0);
        CHECK_EQ(s.facing, 0);
        // The deflection, plus the boundary's own distance from the surface (an edge off its surface: offPoleArc's arc
        // up to 7e-4 inside its sphere, its chords judged by the edges against the curve).
        double gap = 0;
        for (int co = 0; co < m.coedges(); co++) gap = std::fmax(gap, pm.edges().coedge(co).gap);
        if (!(s.worst <= (d + gap) * (1 + 1e-9)))
          std::printf("  %s: %g from the surface at %g (the boundary %g off it)\n", c.model, s.worst, d, gap);
        CHECK(s.worst <= (d + gap) * (1 + 1e-9));
        // Chords inside a convex surface: the area under its own, by at most about the deflection over the radius.
        if (!(s.area < c.area && s.area > c.area * (1 - 2.5 * d / c.radius)))
          std::printf("  %s: area %.9g want %.9g at %g\n", c.model, s.area, c.area, d);
        CHECK(s.area < c.area && s.area > c.area * (1 - 2.5 * d / c.radius));
        CHECK_EQ(sharedEdges(m, pm, c.model), 0);
        // Nothing refused, but slivers in a pole's fan (until poles are meshed as fans).
        int fanless = poleFanOnly(fm, pole, c.near);
        if (fanless || s.facing)
          std::printf("  %s at %g: %d refused away from the pole, %d facing\n", c.model, d, fanless, s.facing);
        CHECK_EQ(fanless, 0);
      }
    }
  }
}

TEST_CASE("a band narrower than its circles' chords bow (thinBand): its circles split until nothing is refused") {
  // (Each triangle spans the band, every corner on the boundary: refinement's candidates leave the domain, naming the
  // circle they cross, which the rounds split.)
  cadgeom::Model m = load("thinBand");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 15 * M_PI / 180));
  const FaceMesh& fm = pm.face(0);
  REQUIRE(fm.status == cadgeom::Status::ok);
  CHECK(fm.rejected.empty());
  CHECK_EQ(fm.splitsWanted, 0);
  double area = 0;
  for (size_t t = 0; t < fm.triangles.size(); t += 3) {
    Vec3 a = fm.points[fm.triangles[t]], b = fm.points[fm.triangles[t + 1]], c = fm.points[fm.triangles[t + 2]];
    area += 0.5 * cadgeom::norm(cadgeom::cross(b - a, c - a));
    // Every facet facing out, within the angle of the surface's normal at its centroid.
    Vec3 n = cadgeom::cross(b - a, c - a), g = (1.0 / 3) * (a + b + c);
    CHECK(cadgeom::dot(n, g) >= std::cos(15 * M_PI / 180) * cadgeom::norm(n) * cadgeom::norm(g));
  }
  // (Facets across a strip this narrow tilt up to the angle off the surface, so up to 1 / cos 15 degrees wider.)
  double want = 2 * M_PI * 4.5 * 0.003;
  if (!(area <= want / std::cos(15 * M_PI / 180) && area > 0.99 * want))
    std::printf("  thinBand: area %.9g want %.9g\n", area, want);
  CHECK(area <= want / std::cos(15 * M_PI / 180) && area > 0.99 * want);
}

TEST_CASE("a tube open at its seam by more than its tolerance: not closed in fact, not meshed as if it were") {
  // (tubeGapOpen: open by 3e-5, its tolerance 1e-5 with no uncertainty; the loops don't close in (u, v) without a
  // period.)
  cadgeom::Model m = load("tubeGapOpen");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.01, 0.26));
  const FaceMesh& fm = pm.face(0);
  CHECK(fm.status != cadgeom::Status::ok);
  CHECK(fm.triangles.empty());
}

TEST_CASE("a sphere's pole: its normal the limit, never NaN; the whole sphere (no loops) its natural extent") {
  cadgeom::Model m = load("spheres");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.01, 0.26));
  CHECK(pm.face(0).status == cadgeom::Status::ok);
  CHECK(!pm.face(0).triangles.empty());
  const FaceMesh& h = pm.face(1);
  REQUIRE(h.status == cadgeom::Status::ok);
  int poles = 0;
  for (size_t i = 0; i < h.points.size(); i++) {
    if (cadgeom::norm(h.points[i] - Vec3{10, 0, 1}) > 1e-12) continue;
    poles++;
    CHECK(std::isfinite(h.normals[i].x) && cadgeom::norm(h.normals[i] - Vec3{0, 0, 1}) < 0.05);
  }
  CHECK(poles >= 1);
}

TEST_CASE("splits: a boundary too coarse for the face's criteria split until none is wanted, both faces meeting") {
  // The seam cylinder at a tight deflection, its angle loose: the circles' spacing from their own curvature alone
  // would do, but the face's criteria ask more of the seam's neighbours; whatever is asked, the rounds end with no
  // split wanted and the edges shared.
  cadgeom::Model m = load("seamCylinder");
  PartMesher pm(m, options(0.002, 1.0));
  REQUIRE(pm.face(0).status == cadgeom::Status::ok);
  CHECK_EQ(pm.face(0).splitsWanted, 0);
  CHECK(pm.face(0).rejected.empty());
  CHECK_EQ(sharedEdges(m, pm, "split cylinder"), 0);
  CHECK(pm.rounds() < 4);
}

TEST_CASE("the criteria's metric: sizes from the principal curvatures, every direction within them, graded") {
  auto criteria = [](const char* name, int f, cadgeom::Box2 box, double d, double angle,
    std::unique_ptr<cadgeom::Surface>& s) {
    static std::vector<cadgeom::Model> keep;
    keep.push_back(load(name));
    cadgeom::Status st;
    s = cadgeom::makeSurface(keep.back(), keep.back().faceSurface(f), st);
    return makeCriteria(keep.back(), f, *s, box, Deflections{d, angle}, st);
  };
  std::unique_ptr<cadgeom::Surface> s;
  // A cylinder of radius 2: round it the size is sqrt(6 d r) = 0.346 at d 0.01 (or angle r, 0.2 at 0.1), along it
  // the face's extent (its box's diagonal in 3D, about 7.55): u's metric |S_u|^2 / h^2, v's 1 / extent^2.
  for (double angle : {1.0, 0.1}) {
    auto c = criteria("seamCylinder", 0, {{0, 2 * M_PI}, {0, 5}}, 0.01, angle, s);
    REQUIRE(c);
    double h = std::min(std::sqrt(0.06 * 2), angle * 2);
    for (Vec2 p : {Vec2{0.3, 1}, Vec2{4, 4.5}}) {
      tesscadio::Metric2 M = c->metric(p);
      CHECK_NEAR(M.a, 4 / (h * h), 1e-6, 0);
      CHECK(std::fabs(M.b) <= 1e-9 * M.a);
      CHECK(M.c > 0 && M.c < 1 / 49.0 && M.c > 1 / 64.0);
    }
  }
  // Every direction at random points of curved surfaces: its metric length at least what its normal curvature k_n
  // asks, |S' d| sqrt(|k_n| / (6 d)) and |S' d| |k_n| / angle (k_n = II(d) / I(d), from the surface independently).
  struct Face {
    const char* name;
    int face;
    cadgeom::Box2 box;
  };
  std::mt19937 rng(5);
  std::uniform_real_distribution<double> u01(0, 1);
  int checked = 0;
  for (Face fc : {Face{"seamCylinder", 0, {{0, 2 * M_PI}, {0, 5}}}, Face{"twisted", 0, {{0, 1}, {0, 1}}},
         Face{"spheres", 1, {{0, 2 * M_PI}, {0, 1.4}}}, Face{"bumpPatch", 0, {{0, 4}, {0, 4}}},
         Face{"torusOuterHalf", 0, {{0, 2 * M_PI}, {-M_PI / 2, M_PI / 2}}}}) {
    const double d = 0.01, angle = 0.26;
    auto c = criteria(fc.name, fc.face, fc.box, d, angle, s);
    REQUIRE(c);
    for (int k = 0; k < 300; k++) {
      Vec2 p{fc.box.x.lo + u01(rng) * (fc.box.x.hi - fc.box.x.lo),
        fc.box.y.lo + u01(rng) * (fc.box.y.hi - fc.box.y.lo)};
      double th = 2 * M_PI * u01(rng);
      Vec2 dir{std::cos(th), std::sin(th)};
      cadgeom::SurfacePoint q;
      REQUIRE(s->eval(p.x, p.y, 2, q) == cadgeom::Status::ok);
      Vec3 t = dir.x * q.du + dir.y * q.dv, n = cadgeom::cross(q.du, q.dv);
      double nl = cadgeom::norm(n), l = cadgeom::norm(t);
      if (!(nl > 1e-9) || !(l > 1e-9)) continue;
      Vec3 second = (dir.x * dir.x) * q.duu + (2 * dir.x * dir.y) * q.duv + (dir.y * dir.y) * q.dvv;
      double kn = std::fabs(cadgeom::dot(second, (1 / nl) * n)) / (l * l);
      tesscadio::Metric2 M = c->metric(p);
      double L = std::sqrt(M.a * dir.x * dir.x + 2 * M.b * dir.x * dir.y + M.c * dir.y * dir.y);
      double want = std::max(l * std::sqrt(kn / (6 * d)), l * kn / angle);
      if (!(L >= want * (1 - 1e-6))) std::printf("  %s at (%g, %g): %g < %g\n", fc.name, p.x, p.y, L, want);
      CHECK(L >= want * (1 - 1e-6));
      checked++;
    }
  }
  CHECK(checked > 1000);
  // Graded on the bump: between neighbouring points the size (along u) changes by at most the growth over their
  // distance, give or take the grid's interpolation; and the flat sides' size far below the extent (the bump's
  // curvature graded out to them), the bump's own the curvature's.
  {
    auto c = criteria("bumpPatch", 0, {{0, 4}, {0, 4}}, 0.01, 0.26, s);
    REQUIRE(c);
    auto sizeU = [&](Vec2 p) {
      tesscadio::Metric2 M = c->metric(p);
      cadgeom::SurfacePoint q;
      s->eval(p.x, p.y, 1, q);
      return cadgeom::norm(q.du) / std::sqrt(M.a);
    };
    double worst = 0;
    for (int i = 0; i < 40; i++) {
      Vec2 p{0.1 * i, 2}, q{0.1 * (i + 1), 2};
      cadgeom::SurfacePoint a, b;
      s->eval(p.x, p.y, 0, a), s->eval(q.x, q.y, 0, b);
      double dist = cadgeom::norm(b.p - a.p), hp = sizeU(p), hq = sizeU(q);
      worst = std::max(worst, (std::max(hp, hq) - std::min(hp, hq)) / dist);
    }
    if (!(worst <= 0.5 * 1.5)) std::printf("  bump: size's growth per unit length up to %g\n", worst);
    CHECK(worst <= 0.5 * 1.5);
    CHECK(sizeU({0.05, 0.05}) < 0.5 * 14.1);
  }
  // Bounded on planes, cylinders, B-splines, spheres, cones and tori, sampled elsewhere (makeCriteria says why).
  CHECK(criteria("seamCylinder", 0, {{0, 2 * M_PI}, {0, 5}}, 0.01, 0.26, s)->bounded());
  CHECK(criteria("spheres", 1, {{0, 2 * M_PI}, {0, 1.4}}, 0.01, 0.26, s)->bounded());
  CHECK(criteria("torusOuterHalf", 0, {{0, 2 * M_PI}, {-M_PI / 2, M_PI / 2}}, 0.01, 0.26, s)->bounded());
  CHECK(criteria("bumpPatch", 0, {{0, 4}, {0, 4}}, 0.01, 0.26, s)->bounded());
  CHECK(criteria("twisted", 0, {{0, 1}, {0, 1}}, 0.01, 0.26, s)->bounded());
  // Random triangles on a cylinder, a sphere, a torus and two B-splines: none accepted on the bounded ones (all but
  // the torus)
  // whose deviation, sampled densely (its barycentric grid against the surface's nearest point), is over the
  // deflection.
  {
    std::mt19937 rng(11);
    std::uniform_real_distribution<double> u01(0, 1);
    int over = 0, accepted = 0;
    for (Face fc : {Face{"seamCylinder", 0, {{0, 2 * M_PI}, {0, 5}}}, Face{"spheres", 1, {{0, 2 * M_PI}, {0, 1.4}}},
           Face{"torusOuterHalf", 0, {{0, 2 * M_PI}, {-M_PI / 2, M_PI / 2}}}, Face{"bumpPatch", 0, {{0, 4}, {0, 4}}},
           Face{"bsplineDome", 0, {{0, 4}, {0, 1}}}, Face{"cone", 0, {{0, 2 * M_PI}, {-0.5, 0}}},
           Face{"torusOuterHalf", 0, {{0, 2 * M_PI}, {M_PI / 2, 3 * M_PI / 2}}}}) {
      const double d = 0.01, angle = 0.5;
      auto c = criteria(fc.name, fc.face, fc.box, d, angle, s);
      REQUIRE(c);
      // (Fewer on the B-splines, whose inversions the dense deviation needs are slower.)
      for (int k = 0; k < (fc.name[0] == 'b' ? 150 : 3000); k++) {
        Vec2 o{fc.box.x.lo + u01(rng) * (fc.box.x.hi - fc.box.x.lo),
          fc.box.y.lo + 0.1 + u01(rng) * (fc.box.y.hi - fc.box.y.lo - 0.2)};
        double r = 0.02 + 0.3 * u01(rng);
        Vec2 t[3];
        for (int i = 0; i < 3; i++) t[i] = {o.x + r * (u01(rng) - 0.5), o.y + r * (u01(rng) - 0.5)};
        if ((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[2].x - t[0].x) * (t[1].y - t[0].y) <= 0) std::swap(t[1], t[2]);
        Vec3 p[3];
        for (int i = 0; i < 3; i++) {
          cadgeom::SurfacePoint q;
          s->eval(t[i].x, t[i].y, 0, q);
          p[i] = q.p;
        }
        double dev = 0;
        cadgeom::SurfaceDomain dom = s->domain();
        for (int i = 0; i <= 8; i++)
          for (int j = 0; i + j <= 8; j++) {
            double b0 = i / 8.0, b1 = j / 8.0, b2 = 1 - b0 - b1;
            Vec3 x = b0 * p[0] + b1 * p[1] + b2 * p[2];
            dev = std::fmax(dev, cadgeom::invertSurface(*s, x, dom.u, dom.v, 1e-12).distance);
          }
        bool ok = c->accept(t);
        accepted += ok;
        if (dev > d * (1 + 1e-9) && c->bounded()) {
          over++;
          if (ok) std::printf("  %s: accepted at deviation %g\n", fc.name, dev);
          CHECK(!ok);
        }
      }
    }
    CHECK(over > 100);
    CHECK(accepted > 100);
  }
  // What sampling misses, the bounds don't: acute triangles on the sphere and the cylinder, scaled about their
  // centroid until their dense deviation is just over the deflection, their deepest point (on the sphere the
  // circumcentre) off the centroid and the edges' middles, so that sampled there they'd pass: refused. And on the
  // sphere (exact) every triangle whose dense deviation is under 0.8 of it and that isn't turned over accepted
  // (angle 0: the deviation alone).
  {
    std::mt19937 rng(13);
    std::uniform_real_distribution<double> u01(0, 1);
    int missed = 0, under = 0, sampledOver = 0;
    int atThreshold = 0;
    for (Face fc : {Face{"spheres", 1, {{0, 2 * M_PI}, {0, 1.2}}}, Face{"seamCylinder", 0, {{0, 2 * M_PI}, {0, 5}}},
           Face{"cone", 0, {{0.5, 5.8}, {-0.5, 0}}}, Face{"torusOuterHalf", 0, {{0.5, 5.8}, {-0.8, 0.8}}},
           Face{"torusOuterHalf", 0, {{0.5, 5.8}, {2.0, 4.3}}},
           Face{"bumpPatch", 0, {{0.3, 3.7}, {0.3, 3.7}}}, Face{"bsplineDome", 0, {{0.2, 3.8}, {0.1, 0.9}}},
           Face{"halfBump", 0, {{1.2, 2.4}, {1, 3}}}}) {
      // (halfBump's triangles straddle its knot u = 2, curved below it, a plane above: their bound must be the
      // largest piece's, not one piece's.)
      const double d = 0.01;
      auto c = criteria(fc.name, fc.face, fc.box, d, 0, s);
      REQUIRE(c);
      cadgeom::SurfaceDomain dom = s->domain();
      auto at = [&](Vec2 x) {
        cadgeom::SurfacePoint q;
        s->eval(x.x, x.y, 0, q);
        return q.p;
      };
      const int g = fc.name[0] == 'b' || fc.name[0] == 'h' ? 8 : 24;
      auto deviations = [&](const Vec2 t[3], double& dense, double& sampled) {
        Vec3 p[3] = {at(t[0]), at(t[1]), at(t[2])};
        dense = 0, sampled = 0;
        for (int i = 0; i <= g; i++)
          for (int j = 0; i + j <= g; j++) {
            double b0 = double(i) / g, b1 = double(j) / g;
            Vec3 x = b0 * p[0] + b1 * p[1] + (1 - b0 - b1) * p[2];
            dense = std::fmax(dense, cadgeom::invertSurface(*s, x, dom.u, dom.v, 1e-12).distance);
          }
        const double wts[4][3] = {{1. / 3, 1. / 3, 1. / 3}, {0.5, 0.5, 0}, {0, 0.5, 0.5}, {0.5, 0, 0.5}};
        for (const auto& b : wts) {
          Vec2 uv{b[0] * t[0].x + b[1] * t[1].x + b[2] * t[2].x, b[0] * t[0].y + b[1] * t[1].y + b[2] * t[2].y};
          sampled = std::fmax(sampled, cadgeom::norm(at(uv) - (b[0] * p[0] + b[1] * p[1] + b[2] * p[2])));
        }
      };
      // (Fewer on the B-splines, whose inversions the dense deviation needs are slower.)
      const bool spline = fc.name[0] == 'b' || fc.name[0] == 'h';
      for (int k = 0; k < (spline ? 25 : 600); k++) {
        // (Acute ones, and every other one obtuse: its third corner near its longest side, where the deepest point is
        // on that side rather than inside.)
        Vec2 o{fc.box.x.lo + 0.5 + (fc.box.x.hi - fc.box.x.lo - 1) * u01(rng),
          fc.box.y.lo + 0.1 + (fc.box.y.hi - fc.box.y.lo - 0.2) * u01(rng)}, e[3];
        for (int i = 0; i < 3; i++) {
          double a = 2 * M_PI * (i + 0.3 * (u01(rng) - 0.5)) / 3;
          e[i] = {std::cos(a), std::sin(a) * (0.3 + u01(rng))};
        }
        if (k % 2) e[0] = {-1, 0}, e[1] = {1, 0.1 * (u01(rng) - 0.5)}, e[2] = {u01(rng) - 0.5, 0.1 + 0.2 * u01(rng)};
        // (On the torus, every third long in u: on its inner half a chord round the axis leaves the tube, where the
        // bound needs its Hessian's terms and its lower side.)
        if (fc.name[0] == 't' && k % 3 == 0)
          e[0] = {-1, 0}, e[1] = {1, 0.05 * (u01(rng) - 0.5)}, e[2] = {0.4 * (u01(rng) - 0.5), 0.03 + 0.05 * u01(rng)};
        // The scale where the dense deviation is 1.02 d, by bisection.
        double lo = 0, hi = 0.5, dense = 0, sampled = 0;
        Vec2 t[3];
        auto place = [&](double r) {
          for (int i = 0; i < 3; i++) t[i] = {o.x + r * e[i].x, o.y + r * e[i].y};
          if ((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[2].x - t[0].x) * (t[1].y - t[0].y) <= 0) std::swap(t[1], t[2]);
          deviations(t, dense, sampled);
        };
        place(hi);
        if (dense < 1.02 * d) continue;
        for (int it = 0; it < (spline ? 12 : 40); it++) {
          double mid = 0.5 * (lo + hi);
          place(mid);
          (dense > 1.02 * d ? hi : lo) = mid;
        }
        place(hi);
        // Accepted over the deflection only where judged by sampling, and said: criteria of its own judging it alone
        // then aren't bounded() (near a pole, where the bounds overstate, the distance is sampled).
        auto sampledHere = [&]() {
          std::unique_ptr<cadgeom::Surface> s2;
          auto c2 = criteria(fc.name, fc.face, fc.box, d, 0, s2);
          return c2->accept(t) && !c2->bounded();
        };
        if (sampled <= d && dense > d) {
          missed++;
          if (c->accept(t)) {
            sampledOver++;
            CHECK(sampledHere());
          }
        }
        // (Every bounded surface's triangle over the deflection refused, wherever on it the deepest point is.)
        if (dense > d) {
          atThreshold++;
          if (c->accept(t)) {
            sampledOver++;
            if (!sampledHere()) std::printf("  %s: accepted at deviation %g, bounded\n", fc.name, dense);
            CHECK(sampledHere());
          }
        }
        place(0.7 * hi);
        Vec3 p[3] = {at(t[0]), at(t[1]), at(t[2])}, g = cadgeom::cross(p[1] - p[0], p[2] - p[0]), nn;
        bool over = false;
        for (int i = 0; i < 3; i++) over = over || (s->normal(t[i].x, t[i].y, nn) == cadgeom::Status::ok &&
          cadgeom::dot(g, nn) <= 0);
        // (Tight where the bound is the distance's own: the sphere, the cone, the torus's outer half; on its inner
        // half the two-sided bound with the Hessian's terms, within 2.5 x.)
        bool inner = fc.name[0] == 't' && fc.box.y.lo > 1.5;
        double tight = fc.face == 1 || fc.name[0] == 'c' || fc.name[0] == 't' ? (inner ? 0.4 : 0.8) : 0;
        if (tight > 0 && dense < tight * d && !over) {
          under++;
          if (!c->accept(t)) std::printf("  %s: refused at deviation %g\n", fc.name, dense);
          CHECK(c->accept(t));
        }
      }
    }
    // (Those few, near the dome's pole.)
    if (missed < 5 || under < 100 || sampledOver > 4)
      std::printf("  missed %d, under %d, accepted over by sampling %d\n", missed, under, sampledOver);
    CHECK(sampledOver <= 4);
    CHECK(missed >= 5);
    CHECK(under >= 100);
    CHECK(atThreshold >= 120);
  }
  // Tight across a B-spline's knots: triangles on the bump straddling its knot lines (u, v = 1, 2, 3), where its bound
  // is the spans' hulls unless the criteria cut the box there, accepted wherever their dense deviation is under half
  // the deflection (angle 0: the deviation alone).
  {
    auto c = criteria("bumpPatch", 0, {{0, 4}, {0, 4}}, 0.01, 0, s);
    REQUIRE(c && c->bounded());
    std::mt19937 rng(14);
    std::uniform_real_distribution<double> u01(0, 1);
    int under = 0;
    for (int k = 0; k < 600; k++) {
      Vec2 o{1.0 + std::floor(3 * u01(rng)), 0.3 + 3.4 * u01(rng)};
      if (k % 2) std::swap(o.x, o.y);
      double r = 0.02 + 0.1 * u01(rng);
      Vec2 t[3];
      for (int i = 0; i < 3; i++) t[i] = {o.x + r * (u01(rng) - 0.5), o.y + r * (u01(rng) - 0.5)};
      if ((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[2].x - t[0].x) * (t[1].y - t[0].y) <= 0) std::swap(t[1], t[2]);
      Vec3 p[3];
      for (int i = 0; i < 3; i++) {
        cadgeom::SurfacePoint q;
        s->eval(t[i].x, t[i].y, 0, q);
        p[i] = q.p;
      }
      Vec3 g = cadgeom::cross(p[1] - p[0], p[2] - p[0]), nn;
      bool over = false;
      for (int i = 0; i < 3; i++) over = over || (s->normal(t[i].x, t[i].y, nn) == cadgeom::Status::ok &&
        cadgeom::dot(g, nn) <= 0);
      // (|S(x) - L(x)| at the barycentric (u, v), an upper bound on the distance: enough to require acceptance.)
      double dev = 0;
      for (int i = 0; i <= 12; i++)
        for (int j = 0; i + j <= 12; j++) {
          double b0 = i / 12.0, b1 = j / 12.0, b2 = 1 - b0 - b1;
          cadgeom::SurfacePoint q;
          s->eval(b0 * t[0].x + b1 * t[1].x + b2 * t[2].x, b0 * t[0].y + b1 * t[1].y + b2 * t[2].y, 0, q);
          dev = std::fmax(dev, cadgeom::norm(q.p - (b0 * p[0] + b1 * p[1] + b2 * p[2])));
        }
      if (over || dev >= 0.5 * 0.01) continue;
      under++;
      if (!c->accept(t)) std::printf("  bump: refused across a knot at deviation %g\n", dev);
      CHECK(c->accept(t));
    }
    CHECK(under > 200);
  }
  // Long thin triangles along a cone's generators (what its metric asks for): accepted wherever their dense deviation
  // is under 0.8 of the deflection.
  {
    auto c = criteria("cone", 0, {{0, 2 * M_PI}, {-0.5, 0}}, 0.01, 0, s);
    std::mt19937 rng(15);
    std::uniform_real_distribution<double> u01(0, 1);
    cadgeom::SurfaceDomain dom = s->domain();
    int under = 0;
    for (int k = 0; k < 300; k++) {
      double u = 6 * u01(rng), v = -0.45 + 0.1 * u01(rng), du = 0.05 + 0.2 * u01(rng), dv = 0.2 + 0.25 * u01(rng);
      Vec2 t[3] = {{u, v}, {u + du, v}, {u + du * u01(rng), v + dv}};
      Vec3 p[3];
      for (int i = 0; i < 3; i++) {
        cadgeom::SurfacePoint q;
        s->eval(t[i].x, t[i].y, 0, q);
        p[i] = q.p;
      }
      double dev = 0;
      for (int i = 0; i <= 12; i++)
        for (int j = 0; i + j <= 12; j++) {
          double b0 = i / 12.0, b1 = j / 12.0;
          dev = std::fmax(dev, cadgeom::invertSurface(*s, b0 * p[0] + b1 * p[1] + (1 - b0 - b1) * p[2], dom.u, dom.v,
            1e-12).distance);
        }
      if (dev >= 0.8 * 0.01) continue;
      under++;
      if (!c->accept(t)) std::printf("  cone, along its lines: refused at deviation %g\n", dev);
      CHECK(c->accept(t));
    }
    CHECK(under > 100);
  }
  // Tight where the surface's bound is: on the cylinder (|S_uu| = r exactly, S_uv = S_vv = 0) a triangle's bound is
  // the largest of r du^2 / 2 over its points' barycentric spread, its true deviation within a few percent of it, so
  // accept() takes every triangle whose dense deviation is under 0.8 of the deflection (angle 0: the deviation alone).
  {
    auto c = criteria("seamCylinder", 0, {{0, 2 * M_PI}, {0, 5}}, 0.01, 0, s);
    std::mt19937 rng(12);
    std::uniform_real_distribution<double> u01(0, 1);
    int under = 0;
    for (int k = 0; k < 2000; k++) {
      Vec2 o{1 + 4 * u01(rng), 1 + 3 * u01(rng)};
      Vec2 t[3];
      for (int i = 0; i < 3; i++) t[i] = {o.x + 0.25 * (u01(rng) - 0.5), o.y + 2 * (u01(rng) - 0.5)};
      if ((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[2].x - t[0].x) * (t[1].y - t[0].y) <= 0) std::swap(t[1], t[2]);
      Vec3 p[3];
      for (int i = 0; i < 3; i++) {
        cadgeom::SurfacePoint q;
        s->eval(t[i].x, t[i].y, 0, q);
        p[i] = q.p;
      }
      double dev = 0;
      cadgeom::SurfaceDomain dom = s->domain();
      for (int i = 0; i <= 16; i++)
        for (int j = 0; i + j <= 16; j++) {
          double b0 = i / 16.0, b1 = j / 16.0;
          Vec3 x = b0 * p[0] + b1 * p[1] + (1 - b0 - b1) * p[2];
          dev = std::fmax(dev, cadgeom::invertSurface(*s, x, dom.u, dom.v, 1e-12).distance);
        }
      if (dev >= 0.8 * 0.01) continue;
      under++;
      if (!c->accept(t)) std::printf("  cylinder: refused at deviation %g\n", dev);
      CHECK(c->accept(t));
    }
    CHECK(under > 500);
  }
  // A triangle too small to judge (1e-12 across, under 1e-4 of the deflection): accepted though its corners, in
  // (u, v) the wrong way round, give it a facet turned over (refinement would chase such a spot to its point cap).
  {
    auto c = criteria("seamCylinder", 0, {{0, 2 * M_PI}, {0, 5}}, 0.01, 0.26, s);
    const Vec2 tiny[3] = {{1, 2}, {1, 2 + 1e-12}, {1 + 1e-12, 2}};
    CHECK(c->accept(tiny));
    // (Its bigger copy, 3e-4 in (u, v), about 6e-4 mm across, turned over the same way, refused.)
    const Vec2 big[3] = {{1, 2}, {1, 2 + 3e-4}, {1 + 3e-4, 2}};
    CHECK(!c->accept(big));
  }
  // On the unit sphere near its pole: a triangle wide in u, its far corner nearer the pole, turned over in 3D (its
  // facet's normal against the surface's), refused, though within the deflection and its corners' normals close; one
  // not turned over, accepted; one with two corners on the pole line (a facet of rounding) accepted.
  auto h = criteria("spheres", 1, {{0, 2 * M_PI}, {0, M_PI / 2}}, 1.0, 0.5, s);
  REQUIRE(h);
  const Vec2 over[3] = {{0, 1.5}, {3, 1.5}, {1.5, 1.55}}, fine[3] = {{0, 1.5}, {1, 1.5}, {0.5, 1.53}};
  const Vec2 pole[3] = {{1, M_PI / 2}, {1.2, M_PI / 2}, {1.1, M_PI / 2 - 0.01}};
  CHECK(!h->accept(over));
  CHECK(h->accept(fine));
  CHECK(h->accept(pole));
}

// A crease between knots a hair apart (kinkStrip, 1e-4 of u wide, its second partial about 1e4 there): every triangle
// across it whose dense deviation is just over the deflection refused by the bounds, none judged by sampling (the face
// stays bounded), and those under kTight of it accepted, where the strip's maxima over its square alone would refuse
// all of them (the bound within 1.1 x the deviation for most, 3.6 x with a corner on the crease and the triangle thin along it).
// Across a v-crease too, and with the crease anywhere in the triangle.
TEST_CASE("the criteria's bounds across a narrow knot span: a proof by its width, tight enough to accept") {
  const double d = 0.01, kTight = 0.25;
  // (The quadratic's second partial uniform across its crease, the cubic's not: the bound tight on both.)
  for (const char* name : {"kinkStrip", "kinkStripV", "kinkStripQuadratic"}) {
    const bool inV = name[9] == 'V';
    static std::vector<cadgeom::Model> keep;
    keep.push_back(load(name));
    cadgeom::Status st;
    auto s = cadgeom::makeSurface(keep.back(), keep.back().faceSurface(0), st);
    REQUIRE(s);
    auto c = makeCriteria(keep.back(), 0, *s, {{0, 1}, {0, 1}}, Deflections{d, 0}, st);
    REQUIRE(c && c->bounded());
    auto at = [&](Vec2 x) {
      cadgeom::SurfacePoint q;
      s->eval(x.x, x.y, 0, q);
      return q.p;
    };
    // The dense deviation: a barycentric grid, and the flat's points over the crease (x or y = 5, the deepest there).
    // (x = 10 u and y = 10 v exactly, the surface's slope at most 0.05: the gap in z to S(x / 10, y / 10) is within
    // 0.13% above the distance, so over 1.02 d by it is over d.)
    auto dense = [&](const Vec2 t[3]) {
      Vec3 p[3] = {at(t[0]), at(t[1]), at(t[2])};
      double dev = 0;
      auto from = [&](Vec3 x) { dev = std::fmax(dev, std::fabs(x.z - at({x.x / 10, x.y / 10}).z)); };
      const int g = 24;
      for (int i = 0; i <= g; i++)
        for (int j = 0; i + j <= g; j++)
          from(double(i) / g * p[0] + double(j) / g * p[1] + (1 - double(i + j) / g) * p[2]);
      auto w = [&](const Vec3& x) { return inV ? x.y - 5 : x.x - 5; };
      std::vector<Vec3> cross;
      for (int i = 0; i < 3; i++) {
        const Vec3 &a = p[i], &b = p[(i + 1) % 3];
        if ((w(a) <= 0) != (w(b) <= 0)) cross.push_back(a + (w(a) / (w(a) - w(b))) * (b - a));
      }
      if (cross.size() == 2)
        for (int k = 0; k <= 40; k++) from(cross[0] + (k / 40.0) * (cross[1] - cross[0]));
      return dev;
    };
    std::mt19937 rng(inV ? 22 : name[9] == 'Q' ? 23 : 21);
    std::uniform_real_distribution<double> u01(0, 1);
    int over = 0, under = 0;
    for (int k = 0; k < 120; k++) {
      // Corners about a centre off the crease by up to a third of the size (k % 3 == 2: a corner on the crease),
      // the shapes acute, obtuse or long across it.
      Vec2 e[3];
      for (int i = 0; i < 3; i++) {
        double a = 2 * M_PI * (i + 0.3 * (u01(rng) - 0.5)) / 3 + u01(rng);
        e[i] = {std::cos(a), std::sin(a) * (0.3 + u01(rng))};
      }
      if (k % 4 == 1) e[0] = {-1, 0}, e[1] = {1, 0.1 * (u01(rng) - 0.5)}, e[2] = {u01(rng) - 0.5, 0.1 + 0.2 * u01(rng)};
      if (k % 4 == 3) e[0] = {-1, -0.05}, e[1] = {0.3, 0.05 * u01(rng)}, e[2] = {0.6, 0.08};
      double off = (u01(rng) - 0.5) * 0.66, along = 0.15 + 0.7 * u01(rng);
      for (Vec2& x : e)
        if (inV) x = {x.y, x.x};
      // (The corner on the crease the middle one across it, the others either side.)
      auto across = [&](int i) { return inV ? e[i].y : e[i].x; };
      int mid = 0;
      for (int i = 0; i < 3; i++)
        if ((across(i) - across((i + 1) % 3)) * (across(i) - across((i + 2) % 3)) <= 0) mid = i;
      Vec2 t[3];
      auto place = [&](double r) {
        Vec2 o = inV ? Vec2{along, 0.5 + off * r} : Vec2{0.5 + off * r, along};
        if (k % 3 == 2) o = inV ? Vec2{along, 0.5 - r * e[mid].y} : Vec2{0.5 - r * e[mid].x, along};
        for (int i = 0; i < 3; i++) t[i] = {o.x + r * e[i].x, o.y + r * e[i].y};
        if ((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[2].x - t[0].x) * (t[1].y - t[0].y) <= 0) std::swap(t[1], t[2]);
        return dense(t);
      };
      // The scale where the dense deviation is 1.02 d, by bisection (the triangle within the face).
      double lo = 0, hi = 0.12;
      if (place(hi) < 1.02 * d) continue;
      for (int it = 0; it < 14; it++) {
        double mid = 0.5 * (lo + hi);
        (place(mid) > 1.02 * d ? hi : lo) = mid;
      }
      double dev = place(hi);
      if (dev > d) {
        over++;
        if (c->accept(t)) std::printf("  %s: accepted at deviation %g\n", name, dev);
        CHECK(!c->accept(t));
      }
      // (Its deviation linear in its size, the crease's: 0.9 x kTight of it lands just under kTight d.)
      dev = place(0.9 * kTight * hi);
      if (dev < kTight * d && dev > 0) {
        under++;
        if (!c->accept(t)) std::printf("  %s: refused at deviation %g (%g of d)\n", name, dev, dev / d);
        CHECK(c->accept(t));
      }
    }
    CHECK(over >= 100);
    CHECK(under >= 100);
    // (Judged by the bounds throughout: none sampled.)
    CHECK(c->bounded());
  }
}

TEST_CASE("edges allowed 4 times coarser than the faces want: split until they're not, every triangle accepted") {
  for (const char* name : {"seamCylinder", "band", "spheres", "twisted"}) {
    cadgeom::Model m = load(name);
    PartOptions o = options(0.01, 0.26);
    o.edgeSpacingScale = 4;
    PartMesher pm(m, o);
    CHECK_EQ(sharedEdges(m, pm, name), 0);
    for (int f = 0; f < m.faces(); f++) {
      const FaceMesh& fm = pm.face(f);
      if (fm.status != cadgeom::Status::ok) continue;
      if (fm.splitsWanted) std::printf("  %s: face %d still wants %d after %d rounds\n", name, f, fm.splitsWanted,
        pm.rounds());
      CHECK_EQ(fm.splitsWanted, 0);
    }
    // Every triangle accepted at the end but slivers in a pole's fan.
    for (int f = 0; f < m.faces(); f++) {
      int n = poleFanOnly(pm.face(f), Vec3{10, 0, 1});
      if (n) std::printf("  %s face %d: %d refused after %d rounds, %d splits wanted\n", name, f, n, pm.rounds(),
        pm.face(f).splitsWanted);
      CHECK_EQ(n, 0);
    }
  }
}

TEST_CASE("split rounds: a band's hole of straight edges, the triangles beside them split until accepted") {
  // (The metric along a cylinder's axis is its extent, so the hole's axial edges stay one span; the triangles round
  // the band next to them, wider than its angle allows, ask them split.)
  cadgeom::Model m = load("bandHoleAtVertex");
  PartMesher pm(m, options(0.01, 0.26));
  REQUIRE(pm.face(0).status == cadgeom::Status::ok);
  CHECK(pm.rounds() >= 1);
  CHECK(pm.face(0).rejected.empty());
  CHECK_EQ(pm.face(0).splitsWanted, 0);
}

TEST_CASE("a cusp: a one-span arc's chord across its tangent neighbour's samples, split until it isn't, the area") {
  // cuspPocket: the boundary crosses itself at the cusp until the bottom arc's span there is a quarter of it; the
  // crossing spans asked split each round (mirrored, the mesher names the two the other way round). The plane's
  // mesh is its boundary's polygon: the bottom arc's samples (at their parameters, from the arc's own equation),
  // the corners, the polyline's points. With no split rounds the face fails, wanting its splits.
  for (const char* name : {"cuspPocket", "cuspPocketMirrored"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    const double sx = std::strcmp(name, "cuspPocket") == 0 ? 1 : -1;
    PartMesher pm(m, options(0.3, 0.12));
    const FaceMesh& fm = pm.face(0);
    if (fm.status != cadgeom::Status::ok) std::printf("  %s: %s\n", name, fm.cause.c_str());
    REQUIRE(fm.status == cadgeom::Status::ok);
    CHECK(pm.rounds() >= 2);
    const std::vector<double>& t = pm.edges().edge(0).t;
    REQUIRE(t.size() >= 3u);
    CHECK(t[1] <= 0.025 + 1e-12);
    CHECK_EQ(fm.splitsWanted, 0);
    std::vector<std::pair<double, double>> poly;
    for (double x : t) poly.push_back({sx * 200 * std::sin(x), 200 - 200 * std::cos(x)});
    poly.push_back({sx * 200 * std::sin(0.1), 3});
    poly.push_back({sx * 2 * std::sin(0.7), 3});
    for (int k = 24; k >= 1; k--) poly.push_back({sx * 2 * std::sin(0.7 * k / 24), 2 - 2 * std::cos(0.7 * k / 24)});
    double want = 0;
    for (size_t i = 0; i < poly.size(); i++) {
      auto [x0, y0] = poly[i];
      auto [x1, y1] = poly[(i + 1) % poly.size()];
      want += 0.5 * (x0 * y1 - x1 * y0);
    }
    want = std::fabs(want);
    double area = 0;
    for (size_t k = 0; k + 2 < fm.triangles.size(); k += 3) {
      Vec3 a = fm.points[fm.triangles[k]], b = fm.points[fm.triangles[k + 1]], c = fm.points[fm.triangles[k + 2]];
      area += 0.5 * cadgeom::norm(cadgeom::cross(b - a, c - a));
    }
    if (std::fabs(area - want) > 1e-9 * want) std::printf("  %s: area %.12g want %.12g\n", name, area, want);
    CHECK(std::fabs(area - want) <= 1e-9 * want);
    PartOptions none = options(0.3, 0.12);
    none.maxSplitRounds = 0;
    PartMesher p0(m, none);
    CHECK(p0.face(0).status == cadgeom::Status::invalidModel);
    CHECK(p0.face(0).splitsWanted >= 1);
  }
}

TEST_CASE("a boundary touching itself at a vertex: a flower hole, lobes; one point there, inside and out right") {
  // flowerHole's hole passes each of 4 vertices twice; lobes' loop its two vertices twice; slitFromCorner's internal
  // edge starts at a vertex of its loop. Every triangle's centroid in the region (the annulus less the five discs;
  // the disc and its two lobes; the square), the area within the chords' 1e-3 (over it where a hole's chords cut
  // inside its circles).
  struct Case {
    const char* model;
    double area;
    bool (*inside)(double, double);
  };
  for (Case c : {Case{"flowerHole", 45.25 * M_PI,
                   [](double x, double y) {
                     if (std::hypot(x, y) >= 9.5 || std::hypot(x, y) <= 3) return false;
                     for (int k = 0; k < 4; k++) {
                       const double cx = 6 * std::cos(k * M_PI / 2), cy = 6 * std::sin(k * M_PI / 2);
                       if (std::hypot(x - cx, y - cy) <= 3) return false;
                     }
                     return true;
                   }},
         Case{"lobes", 27 * M_PI, [](double x, double y) {
                return std::hypot(x, y) < 5 || std::hypot(x - 6, y) < 1 || std::hypot(x + 6, y) < 1;
              }},
         Case{"slitFromCorner", 1, [](double x, double y) { return x > 0 && x < 1 && y > 0 && y < 1; }}}) {
    cadgeom::Model m = load(c.model);
    REQUIRE(m.ok());
    PartMesher pm(m, options(1e-3, 0.1));
    const FaceMesh& fm = pm.face(0);
    if (fm.status != cadgeom::Status::ok) std::printf("  %s: %s\n", c.model, fm.cause.c_str());
    REQUIRE(fm.status == cadgeom::Status::ok);
    double area = 0;
    int outside = 0;
    for (size_t k = 0; k + 2 < fm.triangles.size(); k += 3) {
      Vec3 a = fm.points[fm.triangles[k]], b = fm.points[fm.triangles[k + 1]], d = fm.points[fm.triangles[k + 2]];
      area += 0.5 * cadgeom::norm(cadgeom::cross(b - a, d - a));
      outside += !c.inside((a.x + b.x + d.x) / 3, (a.y + b.y + d.y) / 3);
      CHECK(cadgeom::cross(b - a, d - a).z > 0);
    }
    if (outside || !(std::fabs(area - c.area) < 1e-3 * c.area))
      std::printf("  %s: area %.9g want %.9g, %d centroids outside\n", c.model, area, c.area, outside);
    CHECK_EQ(outside, 0);
    CHECK(std::fabs(area - c.area) < 1e-3 * c.area);
    CHECK_EQ(sharedEdges(m, pm, c.model), 0);
  }
}

TEST_CASE("a loop touching itself at a vertex before a pole's fan (lunePinch): the fan's chain the loop's own") {
  // The lune and its cap: every triangle's centroid, pushed out to the sphere, in the lune (longitude 0.5 to 1.5)
  // or the cap (within 0.2 rad of its centre); the area 2 + 2 pi (1 - cos 0.2) within 2e-3; a fan at each pole.
  cadgeom::Model m = load("lunePinch");
  REQUIRE(m.ok());
  PartMesher pm(m, options(1e-3, 0.1));
  const FaceMesh& fm = pm.face(0);
  if (fm.status != cadgeom::Status::ok) std::printf("  lunePinch: %s\n", fm.cause.c_str());
  REQUIRE(fm.status == cadgeom::Status::ok);
  const Vec3 C{std::cos(0.3), std::sin(0.3), 0};
  double area = 0;
  int outside = 0;
  for (size_t k = 0; k + 2 < fm.triangles.size(); k += 3) {
    Vec3 a = fm.points[fm.triangles[k]], b = fm.points[fm.triangles[k + 1]], d = fm.points[fm.triangles[k + 2]];
    area += 0.5 * cadgeom::norm(cadgeom::cross(b - a, d - a));
    Vec3 g = (1.0 / 3) * (a + b + d);
    g = (1 / cadgeom::norm(g)) * g;
    double lon = std::atan2(g.y, g.x);
    bool in = (lon > 0.5 - 1e-9 && lon < 1.5 + 1e-9) || std::acos(std::clamp(cadgeom::dot(g, C), -1.0, 1.0)) < 0.2;
    outside += !in;
  }
  const double want = 2 + 2 * M_PI * (1 - std::cos(0.2));
  if (outside || !(area < want && area > want * (1 - 2e-3)))
    std::printf("  lunePinch: area %.9g want %.9g, %d centroids outside\n", area, want, outside);
  CHECK_EQ(outside, 0);
  CHECK(area < want && area > want * (1 - 2e-3));
  for (Vec3 pole : {Vec3{0, 0, 1}, Vec3{0, 0, -1}}) {
    int fan = 0;
    for (size_t t = 0; t < fm.triangles.size() / 3; t++) fan += atPole(fm, static_cast<int32_t>(t), pole);
    CHECK(fan >= 2);
  }
  CHECK_EQ(sharedEdges(m, pm, "lunePinch"), 0);
}

TEST_CASE("faces of either sense: a fold and inside-out faces used reversed, normals out and triangles about them") {
  // The fold: both faces up (+z); reversedUses: two closed cubes, normals away from each cube's centre.
  cadgeom::Model f = load("fold");
  PartMesher pf(f, options(0.01, 0.26));
  for (int i = 0; i < f.faces(); i++) {
    REQUIRE(pf.face(i).status == cadgeom::Status::ok);
    CHECK_EQ(stats(pf.face(i), [](Vec3) { return 0.0; }).facing, 0);
    for (const Vec3& n : pf.face(i).normals) CHECK(n.z > 0.5);
  }
  CHECK_EQ(sharedEdges(f, pf, "fold"), 0);
  cadgeom::Model r = load("reversedUses");
  PartMesher pr(r, options(0.01, 0.26));
  CHECK_EQ(closedAndOriented(pr, r.faces()), 0);
  for (int i = 0; i < r.faces(); i++) {
    const FaceMesh& fm = pr.face(i);
    REQUIRE(fm.status == cadgeom::Status::ok);
    CHECK_EQ(stats(fm, [](Vec3) { return 0.0; }).facing, 0);
    // The unit cube's faces out from its centre (the other cube's, closed and oriented alike, as the first is).
    Vec3 c{0, 0, 0};
    for (const Vec3& p : fm.points) c = c + p;
    c = (1.0 / fm.points.size()) * c;
    if (c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1 && c.z >= 0 && c.z <= 1)
      CHECK(cadgeom::dot(fm.normals[0], c - Vec3{0.5, 0.5, 0.5}) > 0);
  }
}

TEST_CASE("edges take the profile's angle: an arc on a plane, whose face asks nothing of it, in spans of 0.1 rad") {
  // A quarter arc of radius 1 at deflection 0.1 (sqrt(8 r d) = 0.89: 2 spans) and angle 0.05: a chord turns from its
  // tangents by half its arc, so at least (pi / 2) / 0.1 spans.
  cadgeom::Model m = load("arcSegment");
  PartMesher pm(m, options(0.1, 0.05));
  CHECK(pm.edges().edge(0).t.size() - 1 >= 16u);
}

TEST_CASE("real data: an edge against its sameSense flag meshed; an edge of no length fails its face, not the part") {
  cadgeom::Model w = load("wrongSense");
  REQUIRE(w.ok());
  PartMesher pw(w, options(0.1, 0.26));
  REQUIRE(pw.face(0).status == cadgeom::Status::ok);
  CHECK(std::fabs(stats(pw.face(0), [](Vec3) { return 0.0; }).area - 1) < 1e-12);
  CHECK_EQ(sharedEdges(w, pw, "wrongSense"), 0);
  // The last edge runs down its line: its samples from (0, 1) to (0, 0).
  const EdgeSamples& e3 = pw.edges().edge(3);
  CHECK(e3.status == cadgeom::Status::ok && e3.points.front().y == 1 && e3.points.back().y == 0);
  cadgeom::Model z = load("zeroEdge");
  REQUIRE(z.ok());
  PartMesher pz(z, options(0.1, 0.26));
  CHECK(pz.edges().edge(4).status == cadgeom::Status::invalidModel);
  CHECK(pz.face(0).status == cadgeom::Status::invalidModel);
  CHECK(pz.face(0).triangles.empty());
}

TEST_CASE("a band's cut in the span through its circles' vertex (nist_ftc_10's bore at the medium profile)") {
  // The loop's closing point carries the closed edge's other end sample: the cut's crossing must still be found in
  // the one span (not across the whole circle, half a turn off, the band then covered once and a strip again).
  cadgeom::Model m = load("nistBore");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 15 * M_PI / 180));
  const FaceMesh& fm = pm.face(0);
  REQUIRE(fm.status == cadgeom::Status::ok);
  Stats s = stats(fm, [](Vec3 p) { return std::fabs(std::hypot(p.x - 14, p.y - 23) - 5); });
  const double band = 2 * M_PI * 5 * 10;
  CHECK(s.area < band && s.area > band * (1 - 2.5 * 0.1 / 5));
  CHECK(s.worst <= 0.1 * (1 + 1e-9));
  CHECK_EQ(s.facing, 0);
}

TEST_CASE("p-curves parameterized against Part 42 (their own range, a squared parameter): by inversion, the square") {
  cadgeom::Model m = load("offPcurves");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 0.26));
  REQUIRE(pm.face(0).status == cadgeom::Status::ok);
  CHECK(std::fabs(stats(pm.face(0), [](Vec3) { return 0.0; }).area - 1) < 1e-9);
  // Sampled inside (spans of 0.2): the two off ones by inversion, on the edge's points; the right ones through their
  // p-curves.
  EdgeOptions eo;
  eo.deflection = 0.1;
  eo.maxSpacing = 0.2;
  EdgeMesh em(m, eo);
  for (int c = 0; c < 4; c++) {
    CHECK_EQ(em.coedge(c).fromPcurve, c >= 2);
    CHECK(em.coedge(c).gap < 1e-9);
  }
}

TEST_CASE("progress: the phases before meshing in order; each face as its meshing starts and as a long one goes; "
  "the pass's counts") {
  // cap at 0.001 mm and 0.05 rad: refined to some 3,600 triangles, so its row reports again as it goes (mesh2d.h's
  // onWork); the first pass's reports count its faces done, of all of them, in order; a split round counts its own.
  cadgeom::Model m = load("cap");
  REQUIRE(m.ok());
  PartOptions o = options(0.001, 0.05);
  std::vector<PartProgress> seen;
  o.progress = [&](const PartProgress& p) { seen.push_back(p); };
  PartMesher pm(m, o);
  REQUIRE(!seen.empty());
  std::map<int, int> perRow;
  int lastDone = -1;
  bool ordered = true;
  for (const PartProgress& p : seen) {
    if (p.phase != PartProgress::meshing || p.round != 0) continue;
    perRow[p.row]++;
    ordered = ordered && p.facesDone >= lastDone && p.facesTotal == m.faces() && p.facesDone == p.row;
    lastDone = p.facesDone;
  }
  int most = 0;
  for (auto& [row, n] : perRow) most = std::max(most, n);
  if (most < 2 || !ordered)
    std::printf("  %zu reports, the most for one row %d, ordered %d\n", seen.size(), most, ordered);
  CHECK(most >= 2);
  CHECK(ordered);
  CHECK_EQ(static_cast<int>(perRow.size()), m.faces());
  for (const PartProgress& p : seen)
    if (p.phase == PartProgress::meshing && p.round > 0) CHECK(p.facesTotal >= 1 && p.facesDone < p.facesTotal);
  // Before meshing, each phase in order (surfaces, the boxes' edges, criteria, the edges), each counting up to its
  // total, a use's report naming its face.
  int phase = 0;
  bool inOrder = true, counted = true, named = false;
  for (const PartProgress& p : seen) {
    if (p.phase == PartProgress::meshing || p.phase == PartProgress::splitting) break;
    inOrder = inOrder && p.phase >= phase;
    phase = p.phase;
    counted = counted && p.facesDone < p.facesTotal;
    named = named || (p.phase == PartProgress::edges && p.row == 0);
  }
  CHECK(inOrder);
  CHECK(counted);
  CHECK_EQ(phase, static_cast<int>(PartProgress::edges));
  CHECK(named);
  // The cube's six faces: one report each in the first pass, row k with k faces done of 6.
  cadgeom::Model cube = load("cube");
  REQUIRE(cube.ok());
  PartOptions oc = options(0.1, 0.5);
  std::vector<PartProgress> faces;
  oc.progress = [&](const PartProgress& p) {
    if (p.phase == PartProgress::meshing) faces.push_back(p);
  };
  PartMesher pc(cube, oc);
  REQUIRE(faces.size() == 6u);
  for (int k = 0; k < 6; k++) {
    CHECK_EQ(faces[k].row, k);
    CHECK_EQ(faces[k].facesDone, k);
    CHECK_EQ(faces[k].facesTotal, 6);
    CHECK_EQ(faces[k].round, 0);
  }
}

TEST_CASE("natural extents: a whole sphere (no loops, or a vertex loop off its poles), a whole torus, a B-spline ball "
  "periodic in v; closed meshes") {
  // Each to its area (chords inside a convex surface: under it by at most about 2.5 d / r of it), within the
  // deflection of its surface, every side shared by two triangles (by their 3D points: the cuts' copies and the
  // poles' fans meet), a vertex loop's point among the mesh's.
  struct Case {
    const char* model;
    int face;
    double area, radius;
    Vec3 vertex;
    bool torus;
  };
  for (Case c : {Case{"spheres", 0, 4 * M_PI, 1, {NAN, 0, 0}, false},
         Case{"wholeSphereVertex", 0, 4 * M_PI, 1, {0, 1, 0}, false},
         Case{"wholeTorus", 0, 12 * M_PI * M_PI, 1, {4, 0, 0}, true},
         Case{"bsplineBall", 0, 4 * M_PI, 1, {NAN, 0, 0}, false}})
    for (auto [d, a] : {std::pair{0.01, 0.26}, std::pair{0.1, 0.2618}}) {
      cadgeom::Model m = load(c.model);
      REQUIRE(m.ok());
      PartMesher pm(m, options(d, a));
      const FaceMesh& fm = pm.face(c.face);
      if (fm.status != cadgeom::Status::ok) std::printf("  %s: status %d\n", c.model, int(fm.status));
      REQUIRE(fm.status == cadgeom::Status::ok);
      Stats s = stats(fm, [&](Vec3 p) {
        if (!c.torus) return std::fabs(cadgeom::norm(p) - 1);
        return std::fabs(std::hypot(std::hypot(p.x, p.y) - 3, p.z) - 1);
      });
      if (!(s.worst <= d * (1 + 1e-9)) || !(s.area < c.area && s.area > c.area * (1 - 2.5 * d / c.radius)))
        std::printf("  %s at %g: %g from the surface, area %.9g want %.9g\n", c.model, d, s.worst, s.area, c.area);
      CHECK(s.worst <= d * (1 + 1e-9));
      CHECK(s.area < c.area && s.area > c.area * (1 - 2.5 * d / c.radius));
      CHECK_EQ(s.facing, 0);
      std::map<std::pair<Key, Key>, int> sides;
      for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
        for (int k = 0; k < 3; k++) {
          Key x = key(fm.points[fm.triangles[t + k]]), y = key(fm.points[fm.triangles[t + (k + 1) % 3]]);
          sides[x < y ? std::pair{x, y} : std::pair{y, x}]++;
        }
      int open = 0;
      for (auto& [side, n] : sides) open += n != 2;
      if (open) std::printf("  %s at %g: %d sides not shared by two triangles\n", c.model, d, open);
      CHECK_EQ(open, 0);
      if (std::isfinite(c.vertex.x)) {
        bool found = false;
        for (Vec3 p : fm.points) found = found || cadgeom::norm(p - c.vertex) < 1e-12;
        CHECK(found);
      }
    }
}

TEST_CASE("bsplineApex's ring fixed by the pole-ring rule, the mesher outside it: each triangle within d and angle") {
  // The B-spline cone's apex fans pass out to half its clearance (its rulings straight), so the ring is large and
  // fixed: the mesher's requests to split it are ignored. Every triangle (refused ones too, which accept()'s bound
  // overstates there at 0.001) within the deflection of the surface at its centroid and sides' middles (by
  // inversion, cad-geom's, not the criteria's), its corners' normals within the angle of one another but where a
  // corner is the apex (a fan's, its normal arbitrary).
  for (auto [d, a] : {std::pair{0.01, 0.26}, std::pair{0.1, 0.2618}, std::pair{0.001, 0.1}}) {
    cadgeom::Model m = load("bsplineApex");
    REQUIRE(m.ok());
    PartMesher pm(m, options(d, a));
    const FaceMesh& fm = pm.face(0);
    REQUIRE(fm.status == cadgeom::Status::ok);
    cadgeom::Status st;
    std::unique_ptr<cadgeom::Surface> s = closedSurface(m, cadgeom::Tolerances(m), 0, st);
    const cadgeom::SurfaceDomain dom = s->domain();
    int far = 0, turned = 0;
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
      const int32_t* v = &fm.triangles[t];
      Vec3 p[3] = {fm.points[v[0]], fm.points[v[1]], fm.points[v[2]]};
      for (Vec3 q : {(1.0 / 3) * (p[0] + p[1] + p[2]), 0.5 * (p[0] + p[1]), 0.5 * (p[1] + p[2]), 0.5 * (p[2] + p[0])})
        far += cadgeom::invertSurface(*s, q, dom.u, dom.v, 1e-12).distance > d * (1 + 1e-9);
      bool apex = false;
      for (const Vec3& q : p) apex = apex || cadgeom::norm(q) < 1e-12;
      if (apex) continue;
      for (int i = 0; i < 3; i++) {
        const Vec3 &na = fm.normals[v[i]], &nb = fm.normals[v[(i + 1) % 3]];
        turned += std::atan2(cadgeom::norm(cadgeom::cross(na, nb)), cadgeom::dot(na, nb)) > a * (1 + 1e-9);
      }
    }
    if (far || turned)
      std::printf("  bsplineApex at %g: %d points beyond d, %d corner pairs beyond the angle (%zu refused of %zu)\n", d,
        far, turned, fm.rejected.size(), fm.triangles.size() / 3);
    CHECK_EQ(far, 0);
    CHECK_EQ(turned, 0);
    CHECK_EQ(sharedEdges(m, pm, "bsplineApex"), 0);
    // Its fans, at an apex-like pole, judged by their deviation alone: none refused.
    int fans = 0;
    for (int32_t r : fm.rejected)
      for (int k = 0; k < 3; k++) fans += cadgeom::norm(fm.points[fm.triangles[3 * r + k]]) < 1e-12;
    CHECK_EQ(fans, 0);
  }
}

TEST_CASE("one ring per pole across faces: poleLunes' two lunes meet at a pole, both rings at the smaller's reach") {
  // The unit sphere's lune and a radius 3 sphere's meet at (0, 0, 1). Each face's fan corners other than the pole,
  // those nearest it (its ring): the same distance from the pole in both faces, the unit lune's own reach (a lune on
  // its own sphere, luneQuarter, gives it alone).
  auto ringReach = [](const FaceMesh& fm, Vec3 pole) {
    double near = INFINITY, far = 0;
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
      bool at = false;
      for (int k = 0; k < 3; k++) at = at || cadgeom::norm(fm.points[fm.triangles[t + k]] - pole) < 1e-12;
      if (!at) continue;
      for (int k = 0; k < 3; k++) {
        double r = cadgeom::norm(fm.points[fm.triangles[t + k]] - pole);
        if (r < 1e-12) continue;
        near = std::fmin(near, r), far = std::fmax(far, r);
      }
    }
    return std::pair{near, far};
  };
  cadgeom::Model m = load("poleLunes");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 0.26));
  REQUIRE(pm.face(0).status == cadgeom::Status::ok && pm.face(1).status == cadgeom::Status::ok);
  const Vec3 north{0, 0, 1};
  auto [a0, a1] = ringReach(pm.face(0), north);
  auto [b0, b1] = ringReach(pm.face(1), north);
  cadgeom::Model l = load("luneQuarter");
  PartMesher pl(l, options(0.1, 0.26));
  auto [c0, c1] = ringReach(pl.face(0), north);
  if (std::fabs(a1 - b1) > 1e-9 || std::fabs(a1 - c1) > 1e-9)
    std::printf("  poleLunes: rings reach %.9g (unit), %.9g (radius 3); luneQuarter's %.9g\n", a1, b1, c1);
  CHECK(std::fabs(a1 - b1) <= 1e-9);
  CHECK(std::fabs(a1 - c1) <= 1e-9);
  CHECK(a0 > 0.5 * a1 && b0 > 0.5 * b1);
}

TEST_CASE("a smooth pole's fans are held to the angle: luneQuarter's at 0.01 rad, its ring at the floor d, refused") {
  // No fan passes the angle down to d there (the rings floored, poles_test), so the fans' normals, a sphere's, are
  // judged and refused, counted in rejected: every one at a pole.
  cadgeom::Model m = load("luneQuarter");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 0.01));
  const FaceMesh& fm = pm.face(0);
  REQUIRE(fm.status == cadgeom::Status::ok);
  int atPole = 0;
  for (int32_t r : fm.rejected)
    for (int k = 0; k < 3; k++) atPole += std::fabs(std::fabs(fm.points[fm.triangles[3 * r + k]].z) - 1) < 1e-12;
  if (atPole == 0) std::printf("  luneQuarter at 0.01 rad: %zu refused, none at a pole\n", fm.rejected.size());
  CHECK(atPole > 0);
}

TEST_CASE("accept() holds every triangle to the angle, at an apex too; acceptDeviation() judges a fan's there") {
  // bsplineApex's row v = 0 is its apex, its normal's limit there depending on u (about 70 degrees across); the
  // dome's v = 1 a sphere's pole, one limit. A triangle within 0.1 of each point, its corners' normals further apart
  // than the angle (0.05) and its deviation well within: refused by accept() at both (outside a pole's ring every
  // check applies), taken by acceptDeviation() (a fan's at an apex-like pole is judged by its deviation alone).
  struct Judged {
    bool accepted, deviation;
  };
  auto judge = [](const char* name, cadgeom::Box2 box, const Vec2 (&t)[3], Vec3 point, double& spread, bool near) {
    cadgeom::Model m = load(name);
    cadgeom::Status st;
    std::unique_ptr<cadgeom::Surface> s = cadgeom::makeSurface(m, m.faceSurface(0), st);
    auto c = makeCriteria(m, 0, *s, box, Deflections{0.1, 0.05}, st);
    spread = 0;
    Vec3 n[3];
    double far = 0;
    for (int i = 0; i < 3; i++) {
      cadgeom::SurfacePoint q;
      s->eval(t[i].x, t[i].y, 1, q);
      n[i] = cadgeom::cross(q.du, q.dv);
      n[i] = (1 / cadgeom::norm(n[i])) * n[i];
      far = std::fmax(far, cadgeom::norm(q.p - point));
    }
    for (int i = 0; i < 3; i++)
      for (int j = i + 1; j < 3; j++) spread = std::fmax(spread, std::acos(std::clamp(cadgeom::dot(n[i], n[j]), -1.0,
        1.0)));
    REQUIRE((far < 0.08) == near);
    return Judged{c->accept(t), c->acceptDeviation(t)};
  };
  double spread;
  const Vec2 atApex[3] = {{0, 0.02}, {1, 0.02}, {0.5, 0.04}};
  Judged apex = judge("bsplineApex", {{0, 1}, {0, 1}}, atApex, {0, 0, 0}, spread, true);
  if (apex.accepted || !apex.deviation || spread < 0.5)
    std::printf("  at the apex: accepted %d, by deviation %d, spread %g\n", apex.accepted, apex.deviation, spread);
  CHECK(spread > 0.5);
  CHECK(!apex.accepted);
  CHECK(apex.deviation);
  const Vec2 pastApex[3] = {{0, 0.05}, {1, 0.05}, {0.5, 0.12}};
  Judged past = judge("bsplineApex", {{0, 1}, {0, 1}}, pastApex, {0, 0, 0}, spread, false);
  CHECK(!past.accepted);
  const Vec2 atPole[3] = {{0, 0.97}, {4. / 3, 0.97}, {8. / 3, 0.97}};
  Judged pole = judge("bsplineDome", {{0, 4}, {0, 1}}, atPole, {0, 0, 1}, spread, true);
  if (pole.accepted || !pole.deviation || spread < 0.06)
    std::printf("  at the pole: accepted %d, by deviation %d, spread %g\n", pole.accepted, pole.deviation, spread);
  CHECK(spread > 0.06);
  CHECK(!pole.accepted);
  CHECK(pole.deviation);
}

TEST_CASE("poles as fans: one point per pole, pieces of 22.5 degrees at most, none refused; split rounds off: the "
  "ring under a hole beside the pole, cut into the meridians, nothing refused at it") {
  // Each triangle with a corner at a pole (in 3D): that corner the pole's own point (one per pole), the angle there
  // at most a fan's piece (22.5 degrees about the pole, a sphere's azimuth), none refused, no open edges.
  struct Fanned {
    int poles = 0, poleTriangles = 0, refusedAtPole = 0, slivers = 0;
    double widest = 0;
  };
  auto fanned = [](const cadgeom::Model& m, const PartMesher& pm, int f) {
    Fanned r;
    const FaceMesh& fm = pm.face(f);
    cadgeom::Status st;
    std::unique_ptr<cadgeom::Surface> s = closedSurface(m, cadgeom::Tolerances(m), f, st);
    std::vector<cadgeom::Singularity> sing;
    if (s) s->singularities(sing);
    std::set<int32_t> refused(fm.rejected.begin(), fm.rejected.end());
    for (const cadgeom::Singularity& g : sing) {
      if (g.kind == cadgeom::Singularity::normalVanishes) continue;
      std::set<int32_t> at;
      for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
        for (int k = 0; k < 3; k++) {
          int32_t v = fm.triangles[t + k];
          if (cadgeom::norm(fm.points[v] - g.point) > 1e-9) continue;
          at.insert(v);
          r.poleTriangles++;
          Vec3 a = fm.points[fm.triangles[t + (k + 1) % 3]] - g.point;
          Vec3 b = fm.points[fm.triangles[t + (k + 2) % 3]] - g.point;
          double angle = std::atan2(cadgeom::norm(cadgeom::cross(a, b)), cadgeom::dot(a, b));
          if (refused.count(static_cast<int32_t>(t / 3))) {
            r.refusedAtPole++;
            // A sliver: its smallest angle under 5 degrees.
            Vec3 p[3] = {fm.points[fm.triangles[t]], fm.points[fm.triangles[t + 1]], fm.points[fm.triangles[t + 2]]};
            double least = M_PI;
            for (int i = 0; i < 3; i++) {
              Vec3 x = p[(i + 1) % 3] - p[i], y = p[(i + 2) % 3] - p[i];
              least = std::fmin(least, std::atan2(cadgeom::norm(cadgeom::cross(x, y)), cadgeom::dot(x, y)));
            }
            r.slivers += least < 5 * M_PI / 180;
          } else {
            r.widest = std::fmax(r.widest, angle);
          }
        }
      r.poles += static_cast<int>(at.size());
    }
    return r;
  };
  // (Not offPoleArc and offPoleRest: their arc's sample at the top inverts to the pole, the edge 7e-4 off its sphere,
  // its copies on the pole's row in (u, v) but not at the pole in 3D: no fan made there.)
  for (const char* name : {"halfCap", "meridianHemisphere", "luneQuarter", "cap", "bsplineDome",
         "meridianHemisphereLoose", "poleHole"})
    for (auto [d, a] : {std::pair{0.01, 0.05}, std::pair{0.1, 0.2618}, std::pair{0.001, 0.1}}) {
      cadgeom::Model m = load(name);
      REQUIRE(m.ok());
      PartMesher pm(m, options(d, a));
      REQUIRE(pm.face(0).status == cadgeom::Status::ok);
      Fanned r = fanned(m, pm, 0);
      // (luneQuarter and the meridian hemispheres have both poles, the rest one. A B-spline's u isn't quite its
      // azimuth about the pole: a tenth to spare there.)
      bool two = std::strcmp(name, "luneQuarter") == 0 || std::strncmp(name, "meridianHemisphere", 18) == 0;
      int want = two ? 2 : 1;
      double piece = 22.5 * M_PI / 180 * (name[0] == 'b' ? 1.1 : 1 + 1e-6);
      if (r.poles != want || r.refusedAtPole || r.widest > piece)
        std::printf("  %s at %g, %g: %d pole points, %d of %d at them refused, widest %g deg\n", name, d, a, r.poles,
          r.refusedAtPole, r.poleTriangles, r.widest * 180 / M_PI);
      CHECK_EQ(r.poles, want);
      CHECK_EQ(r.refusedAtPole, 0);
      CHECK(r.widest <= piece);
      CHECK_EQ(sharedEdges(m, pm, name), 0);
      // (The dome's triangles near its pole judged by the surface's distance there: none refused at all. But at d
      // 0.001 with its equator projected (no p-curve): up to 22, the near-pole fallback (criteria.cpp's
      // nearestDeviation, sampled, not bounded) being sensitive to a boundary moved by 3e-7 far off: a t4-criteria
      // open item.)
      if (name[0] == 'b') CHECK(pm.face(0).rejected.size() <= (d == 0.001 ? 22u : 0u));
    }
  // Split rounds off: poleHole's ring under its hole (its near side 0.045 from the pole), fixed and cut into the
  // meridians before any face is meshed, so its ends are the meridians' crossings of it: nothing refused at the pole
  // even with no rounds to bring the ends in.
  for (const char* name : {"poleHole"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    PartOptions o = options(0.001, 0.1);  // (the edges' spacing by the deflection wider than the fan's radius)
    o.maxSplitRounds = 0;
    PartMesher pm(m, o);
    if (pm.face(0).status != cadgeom::Status::ok) std::printf("  %s: status %d\n", name, int(pm.face(0).status));
    REQUIRE(pm.face(0).status == cadgeom::Status::ok);
    Fanned r = fanned(m, pm, 0);
    if (r.refusedAtPole) std::printf("  %s, no rounds: %d at the pole refused\n", name, r.refusedAtPole);
    CHECK_EQ(r.refusedAtPole, 0);
    CHECK_EQ(sharedEdges(m, pm, name), 0);
  }
}

TEST_CASE("cut placements: off a pole line, off a line crossed thrice, into a one-span arc, the face's way round v") {
  struct Case {
    const char* model;
    double area, slack;
  };
  // (Medium profile: the notch's 0.2 rad arc one span, its only crossing of u = 0 from the junction before it.)
  for (Case c : {Case{"offPoleRest", 3 * M_PI, 0.02}, Case{"wigglyBand", 20 * M_PI - 0.9, 0.01},
         Case{"notchBand", 20 * M_PI - 0.2, 0.01}, Case{"torusOuterHalf", 2 * M_PI * (3 * M_PI + 2), 0.01}}) {
    cadgeom::Model m = load(c.model);
    REQUIRE(m.ok());
    PartMesher pm(m, options(0.1, 15 * M_PI / 180));
    const FaceMesh& fm = pm.face(0);
    if (fm.status != cadgeom::Status::ok) std::printf("  %s: status %d\n", c.model, int(fm.status));
    REQUIRE(fm.status == cadgeom::Status::ok);
    double area = stats(fm, [](Vec3) { return 0.0; }).area;
    if (!(area < c.area && area > c.area * (1 - c.slack)))
      std::printf("  %s: area %.9g want %.9g\n", c.model, area, c.area);
    CHECK(area < c.area && area > c.area * (1 - c.slack));
    CHECK_EQ(sharedEdges(m, pm, c.model), 0);
  }
}

TEST_CASE("an edge off its surface, its feet nearly affine (Iron.step #47's kind): projected within 0.05 d of "
  "its feet, the mesh as inversion's") {
  cadgeom::Model m = load("affineFeetOff");
  REQUIRE(m.ok());
  cadgeom::Status st;
  std::unique_ptr<cadgeom::Surface> s = closedSurface(m, cadgeom::Tolerances(m), 0, st);
  REQUIRE(s);
  const cadgeom::SurfaceDomain dom = s->domain();
  for (double d : {0.1, 0.05}) {
    PartOptions o = options(d, 15 * M_PI / 180);
    PartMesher on(m, o);
    o.projectMissingPcurves = false;
    PartMesher off(m, o);
    const EdgeMesh& em = on.edges();
    CHECK(em.projections().withinMesh >= 1);
    // The side 1.5e-3 above the surface: each sample's (u, v) against its point's foot on the surface.
    const CoedgeSamples& cs = em.coedge(0);
    REQUIRE(cs.projected);
    const EdgeSamples& es = em.edge(m.coedgeEdge(0));
    double worst = 0;
    for (size_t i = 0; i < cs.uv.size(); i++) {
      cadgeom::SurfaceInversion inv = cadgeom::invertSurface(*s, es.points[cs.index[i]], dom.u, dom.v, 1e-9);
      cadgeom::SurfacePoint q;
      s->eval(cs.uv[i].x, cs.uv[i].y, 0, q);
      worst = std::fmax(worst, cadgeom::norm(q.p - inv.foot));
    }
    size_t a = on.face(0).triangles.size() / 3, b = off.face(0).triangles.size() / 3;
    if (!(worst <= 0.05 * d) || a > 1.1 * b || a < 0.9 * b)
      std::printf("  affineFeetOff at %g: %g from its feet, %zu triangles against inversion's %zu\n", d, worst, a, b);
    CHECK(worst <= 0.05 * d);
    CHECK(a <= 1.1 * b && a >= 0.9 * b);
  }
}

TEST_CASE("the same part twice: the same points, normals and triangles, bit for bit") {
  for (const char* name : {"cube", "seamCylinder", "spheres", "band"}) {
    cadgeom::Model m = load(name);
    PartMesher a(m, options(0.01, 0.26)), b(m, options(0.01, 0.26));
    for (int f = 0; f < m.faces(); f++) {
      const FaceMesh &x = a.face(f), &y = b.face(f);
      bool same = x.status == y.status && x.triangles == y.triangles && x.points.size() == y.points.size();
      for (size_t i = 0; same && i < x.points.size(); i++)
        same = key(x.points[i]) == key(y.points[i]) && key(x.normals[i]) == key(y.normals[i]);
      CHECK(same);
    }
  }
}
