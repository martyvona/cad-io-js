// part.h on whole parts, each checked by what a part's mesh must be, from the model alone: every model edge's final
// samples in every face that uses it (the same points, the consecutive ones joined by a triangle's side), a closed
// shell's mesh closed and consistently oriented (each side of a triangle used by exactly one other, the other way),
// normals unit and finite (a sphere's pole included) and on the side the triangles face, triangles within the
// deflection of the surface, the faces' areas against their closed forms, the same mesh twice.
#include <tess_cadio/part.h>

#include <cad_geom/surface.h>

#include <cmath>
#include <cstdio>
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
         Case{"bsplineTube", 0, 20 * M_PI, 2, {0, 0, 0}, true}, Case{"bsplineDome", 0, 2 * M_PI, 1, {0, 0, 0}, false},
         Case{"bsplineTubeTinyArc", 0, 20 * M_PI, 2, {0, 0, 0}, true},
         Case{"tubeGapFaceTolerance", 0, 20 * M_PI, 2, {0, 0, 0}, true},
         Case{"tubeGapUncertainty", 0, 20 * M_PI, 2, {0, 0, 0}, true},
         Case{"tubeGapBySize", 0, 20 * M_PI, 2, {0, 0, 0}, true},
         Case{"cap", 0, 2 * M_PI * (1 - M_SQRT1_2), 1, {}, false},
         Case{"luneQuarter", 0, M_PI, 1, {}, false}}) {
    cadgeom::Model m = load(c.model);
    REQUIRE(m.ok());
    for (double d : {0.05, 0.01}) {
      PartMesher pm(m, options(d, 0.26));
      const FaceMesh& fm = pm.face(c.face);
      if (fm.status != cadgeom::Status::ok) std::printf("  %s: status %d\n", c.model, int(fm.status));
      REQUIRE(fm.status == cadgeom::Status::ok);
      Vec3 pole = c.centre + Vec3{0, 0, c.radius};
      Stats s = stats(fm, [&](Vec3 p) {
        Vec3 q = p - c.centre;
        return std::fabs((c.cylinder ? std::hypot(q.x, q.y) : cadgeom::norm(q)) - c.radius);
      }, c.cylinder ? nullptr : &pole, c.near);
      CHECK_EQ(s.badNormals, 0);
      CHECK_EQ(s.facing, 0);
      if (!(s.worst <= d * (1 + 1e-9))) std::printf("  %s: %g from the surface at %g\n", c.model, s.worst, d);
      CHECK(s.worst <= d * (1 + 1e-9));
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

TEST_CASE("a tube open at its seam by more than its tolerance: not closed in fact, not meshed as if it were") {
  // (tubeGapOpen: open by 1e-5, its tolerance 1e-9 of its size; the loops don't close in (u, v) without a period.)
  cadgeom::Model m = load("tubeGapOpen");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.01, 0.26));
  const FaceMesh& fm = pm.face(0);
  CHECK(fm.status != cadgeom::Status::ok);
  CHECK(fm.triangles.empty());
}

TEST_CASE("a sphere's pole: its normal the limit, never NaN; the whole sphere (no loops) unsupported") {
  cadgeom::Model m = load("spheres");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.01, 0.26));
  CHECK(pm.face(0).status == cadgeom::Status::unsupported);
  CHECK(pm.face(0).triangles.empty());
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

TEST_CASE("the provisional criteria: the spacing from the curvature, accept() refusing triangles turned over") {
  auto criteria = [](const char* name, int f, cadgeom::Box2 box, double d, double angle,
    std::unique_ptr<cadgeom::Surface>& s) {
    static std::vector<cadgeom::Model> keep;
    keep.push_back(load(name));
    cadgeom::Status st;
    s = cadgeom::makeSurface(keep.back(), keep.back().faceSurface(f), st);
    return makeCriteria(keep.back(), f, *s, box, Deflections{d, angle}, st);
  };
  std::unique_ptr<cadgeom::Surface> s;
  // A cylinder of radius 2: curvature 1 / 2, so a chord of sqrt(8 d r) = 0.4 at d 0.01; with the angle 0.1, the
  // normal's turn r h / r^2... h = 0.1 r = 0.2 first.
  auto c = criteria("seamCylinder", 0, {{0, 2 * M_PI}, {0, 5}}, 0.01, 1.0, s);
  REQUIRE(c);
  CHECK(c->edgeSpacing() <= 0.4 * (1 + 1e-9) && c->edgeSpacing() >= 0.38);
  c = criteria("seamCylinder", 0, {{0, 2 * M_PI}, {0, 5}}, 0.01, 0.1, s);
  CHECK(c->edgeSpacing() <= 0.2 * (1 + 1e-9) && c->edgeSpacing() >= 0.19);
  // A twisted bilinear patch, curved by S_uv alone (|S_uv| 1, |S_u|, |S_v| at least 1): h at most sqrt(8 d).
  auto t = criteria("twisted", 0, {{0, 1}, {0, 1}}, 0.01, 1.0, s);
  REQUIRE(t);
  CHECK(t->edgeSpacing() <= std::sqrt(0.08) * (1 + 1e-9) && t->edgeSpacing() >= 0.2);
  // The unit sphere up to its pole: curvature 1 everywhere (the normal's component of S'', not S'' itself, whose
  // ratio to |S_u|^2 grows towards the pole), so h = sqrt(8 d) at d 0.01.
  auto sp = criteria("spheres", 1, {{0, 2 * M_PI}, {0, M_PI / 2}}, 0.01, 1.0, s);
  REQUIRE(sp);
  CHECK(sp->edgeSpacing() <= std::sqrt(0.08) * (1 + 1e-9) && sp->edgeSpacing() >= 0.27);
  // On the unit sphere near its pole: a triangle wide in u, its far corner nearer the pole, turned over in 3D (its
  // facet's normal against the surface's), refused, though within the deflection and its corners' normals close; one
  // not turned over, accepted; one with two corners on the pole line (a facet of rounding) accepted.
  auto h = criteria("spheres", 1, {{0, 2 * M_PI}, {0, M_PI / 2}}, 1.0, 0.5, s);
  REQUIRE(h);
  const Vec2 over[3] = {{0, 1.5}, {3, 1.5}, {1.5, 1.55}}, fine[3] = {{0, 1.5}, {2.5, 1.5}, {1.25, 1.56}};
  const Vec2 pole[3] = {{1, M_PI / 2}, {1.2, M_PI / 2}, {1.1, M_PI / 2 - 0.01}};
  CHECK(!h->accept(over));
  CHECK(h->accept(fine));
  CHECK(h->accept(pole));
}

TEST_CASE("the split rounds: edges sampled 4 times coarser than the faces want, split until they're not") {
  for (const char* name : {"seamCylinder", "band", "spheres", "twisted"}) {
    cadgeom::Model m = load(name);
    PartOptions o = options(0.01, 0.26);
    o.edgeSpacingScale = 4;
    PartMesher pm(m, o);
    CHECK(pm.rounds() >= 1);
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
