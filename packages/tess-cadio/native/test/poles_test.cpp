// poles.h on test models whose poles' cases and rings follow from their geometry: the case by where the face's
// boundary is, smooth or apex-like by the surface, the clearance, the straight length and the floor in closed form,
// the fans checked against the criteria here (accepted at the ring, some refused at twice it where nothing else
// stops it), one reach per pole across faces.
#include "../src/poles.h"

#include <tess_cadio/criteria.h>
#include <tess_cadio/edges.h>

#include <cad_geom/tolerance.h>

#include <cmath>
#include <cstdio>
#include <memory>
#include <vector>

#include "brep_models.h"
#include "check.h"
#include "tess_models.h"

using namespace tesscadio;
using cadgeom::Vec2;
using cadgeom::Vec3;
using Case = PoleRing::Case;

namespace {

/** A model's faces set up as PartMesher sets them up (a rough sampling for the boxes, the criteria, the edges at
 * their spacing), and each face's poles. */
struct Setup {
  cadgeom::Model m;
  cadgeom::Tolerances tols;
  std::vector<std::unique_ptr<cadgeom::Surface>> surfaces;
  std::vector<std::unique_ptr<SurfaceCriteria>> criteria;
  std::unique_ptr<EdgeMesh> em;
  std::vector<std::vector<PoleRing>> rings;
  double d, angle;
  Setup(const char* name, double deflection, double ang)
    : m(load(name)), tols(m), d(deflection), angle(ang) {
    const int nf = m.faces();
    surfaces.resize(nf), criteria.resize(nf), rings.resize(nf);
    for (int f = 0; f < nf; f++) {
      cadgeom::Status st;
      surfaces[f] = closedSurface(m, tols, f, st);
    }
    EdgeOptions eo;
    eo.deflection = d, eo.angle = angle;
    EdgeOptions rough = eo;
    rough.deflection *= 10, rough.angle = 0;
    EdgeMesh first(m, rough);
    std::vector<double> spacing(nf, INFINITY);
    for (int f = 0; f < nf; f++) {
      if (!surfaces[f]) continue;
      FaceBoundary fb = first.face(f);
      cadgeom::Box2 box{{INFINITY, -INFINITY}, {INFINITY, -INFINITY}};
      for (const auto& l : fb.loops)
        for (const BoundaryPoint& p : l) {
          box.x.lo = std::fmin(box.x.lo, p.uv.x), box.x.hi = std::fmax(box.x.hi, p.uv.x);
          box.y.lo = std::fmin(box.y.lo, p.uv.y), box.y.hi = std::fmax(box.y.hi, p.uv.y);
        }
      cadgeom::Status st;
      criteria[f] = makeCriteria(m, f, *surfaces[f], box, Deflections{d, angle}, st);
      if (criteria[f]) spacing[f] = criteria[f]->edgeSpacing();
    }
    em = std::make_unique<EdgeMesh>(m, eo, spacing);
    for (int f = 0; f < nf; f++)
      if (surfaces[f] && criteria[f])
        rings[f] = facePoles(m, f, *surfaces[f], em->face(f), *em, *criteria[f], tols.face(f), d, angle);
  }
  static cadgeom::Model load(const char* name) {
    if (const tessfixtures::Model* t = tessfixtures::model(name)) return cadgeom::Model(t->data, t->size);
    const fixtures::Model* f = fixtures::model(name);
    return cadgeom::Model(f ? f->data : nullptr, f ? f->size : 0);
  }
  /** Face f's ring at the pole at z = poleZ. */
  const PoleRing* at(int f, double poleZ) const {
    for (const PoleRing& r : rings[f])
      if (std::fabs(r.pole.z - poleZ) < 1e-9) return &r;
    return nullptr;
  }
  /** Whether every fan triangle of face f's ring at offset r passes the criteria, checked here. */
  bool fansPass(int f, const PoleRing& ring, double r) const {
    for (auto run : ring.runs) {
      const int pieces = ringPieces(*surfaces[f], ring, run, r, d, angle);
      for (int j = 0; j < pieces; j++) {
        const double qa = run.first + (run.second - run.first) * j / pieces;
        const double qb = run.first + (run.second - run.first) * (j + 1) / pieces;
        auto uv = [&](double off, double q) { return ring.isoU ? Vec2{ring.at + ring.side * off, q}
                                                               : Vec2{q, ring.at + ring.side * off}; };
        Vec2 t[3] = {uv(r, qa), uv(r, qb), uv(0, 0.5 * (qa + qb))};
        if (cadgeom::cross(t[1] - t[0], t[2] - t[0]) < 0) std::swap(t[1], t[2]);
        if (!(ring.smooth ? criteria[f]->accept(t) : criteria[f]->acceptDeviation(t))) return false;
      }
    }
    return true;
  }
};

bool near(double a, double b, double rel) { return std::fabs(a - b) <= rel * std::fmax(std::fabs(a), std::fabs(b)); }

} // namespace

TEST_CASE("a pole's case by where the face's boundary is, smooth or apex-like by the normals just off it") {
  // thinBand: a band about a sphere's equator, both poles outside it. spheres: a whole sphere (no loops: natural),
  // and a hemisphere (its north pole a vertex loop, no edge there: clear; its south outside). cap: its north clear,
  // its south outside. luneQuarter: both poles between its meridians (through), a sphere's (smooth). cone: its apex
  // a degenerate edge and its seam's end (through), normals a right angle apart round it (its semi-angle pi / 4).
  // bsplineApex: an apex row (apex-like).
  Setup band("thinBand", 0.1, 0.26);
  REQUIRE(band.rings[0].size() == 2u);
  for (const PoleRing& r : band.rings[0]) CHECK(r.kase == Case::outside);
  Setup sph("spheres", 0.1, 0.26);
  REQUIRE(sph.rings[0].size() == 2u && sph.rings[1].size() == 2u);
  for (const PoleRing& r : sph.rings[0]) CHECK(r.kase == Case::natural && r.smooth);
  REQUIRE(sph.at(1, 1) && sph.at(1, -1));
  CHECK(sph.at(1, 1)->kase == Case::clear);
  CHECK(sph.at(1, -1)->kase == Case::outside);
  Setup cap("cap", 0.1, 0.26);
  REQUIRE(cap.at(0, 1) && cap.at(0, -1));
  CHECK(cap.at(0, 1)->kase == Case::clear && cap.at(0, 1)->smooth);
  CHECK(cap.at(0, -1)->kase == Case::outside);
  Setup lune("luneQuarter", 0.1, 0.26);
  REQUIRE(lune.rings[0].size() == 2u);
  for (const PoleRing& r : lune.rings[0]) {
    CHECK(r.kase == Case::through && r.smooth);
    CHECK_EQ(static_cast<int>(r.through.size()), 2);
    CHECK(r.spread < 1e-3);
  }
  Setup cone("cone", 0.1, 0.26);
  REQUIRE(cone.rings[0].size() == 1u);
  CHECK(cone.rings[0][0].kase == Case::through && !cone.rings[0][0].smooth);
  CHECK(std::fabs(cone.rings[0][0].spread - M_PI / 2) < 1e-3);
  Setup apex("bsplineApex", 0.1, 0.26);
  REQUIRE(!apex.rings[0].empty());
  CHECK(!apex.rings[0][0].smooth && apex.rings[0][0].spread > 0.26);
  // Its fans judged by their deviation alone (its rulings straight, the fans flat along them): passing out to half
  // the clearance, not halved for their normals.
  CHECK(near(apex.rings[0][0].reach, apex.rings[0][0].clearance, 1e-6));
}

TEST_CASE("a ring's radius: half the clearance, the through curves' straight length, the fans passing; its floor") {
  // cap: half the clearance to its circle at colatitude pi / 4 reaches 2 sin(pi / 16) from the pole, and its fans
  // pass within it. cone: half its generator (the base circle sqrt 2 from the apex), its flat fans passing there.
  Setup cap("cap", 0.1, 0.26);
  const PoleRing& c = *cap.at(0, 1);
  CHECK(near(c.clearance, 2 * std::sin(M_PI / 16), 1e-9));
  CHECK(c.reach <= c.clearance * (1 + 1e-9) && !c.floored);
  CHECK(cap.fansPass(0, c, c.radius));
  Setup cone("cone", 0.1, 0.26);
  const PoleRing& k = cone.rings[0][0];
  CHECK(near(k.clearance, M_SQRT1_2, 1e-9));
  CHECK(near(k.reach, M_SQRT1_2, 1e-6));
  CHECK(cone.fansPass(0, k, k.radius));
  // luneQuarter: its meridians (unit circles) straight within d out to the chord whose arc bows d, 2 sin(acos(1 -
  // d)); the clearance to the equator (half the offset range) sqrt 2; the fans halved in until they pass, refused at
  // twice the radius.
  Setup lune("luneQuarter", 0.1, 0.26);
  for (const PoleRing& r : lune.rings[0]) {
    CHECK(std::fabs(r.straight - 2 * std::sin(std::acos(0.9))) < 1e-4);
    CHECK(near(r.clearance, M_SQRT2, 1e-9));
    CHECK(r.reach < r.straight && !r.floored);
    CHECK(lune.fansPass(0, r, r.radius));
    CHECK(!lune.fansPass(0, r, 2 * r.radius));
  }
  // poleLens: its arcs (radius 1 circles) straight within d out to 2 sin(acos(1 - d)), short of where the fans on
  // the radius 10 sphere would pass: the straight rule sets the ring there.
  Setup lens("poleLens", 0.1, 0.26);
  const PoleRing& l = *lens.at(0, 10);
  CHECK(l.kase == Case::through && !l.floored);
  CHECK(std::fabs(l.straight - 2 * std::sin(std::acos(0.9))) < 1e-4);
  CHECK(near(l.reach, l.straight, 1e-6));
  CHECK(lens.fansPass(0, l, 2 * l.radius));
  CHECK(lens.at(0, -10)->kase == Case::outside);
  // At an angle of 0.01 no fan passes down to d: the floor, d.
  Setup fine("luneQuarter", 0.1, 0.01);
  for (const PoleRing& r : fine.rings[0]) {
    CHECK(r.floored);
    CHECK(near(r.reach, 0.1, 1e-6));
  }
  // tinyCap: its circle 0.01 rad from the pole, its clearance under 2 d: the floor half the clearance, not d (which
  // is past the circle).
  Setup tiny("tinyCap", 0.1, 0.26);
  const PoleRing& t = *tiny.at(0, 1);
  CHECK(near(t.clearance, 2 * std::sin(0.0025), 1e-6));
  CHECK(near(t.floor, t.clearance, 1e-12));
  CHECK(near(t.reach, t.clearance, 1e-6));
  CHECK(t.floored && t.floor < 0.1);
}

TEST_CASE("incident to the pole: any part of an edge within the tolerance of it, and only that part out from it") {
  // passBy: a great circle 5e-4 from the north pole (tolerance 1e-3), no sample near it: incident there, through;
  // straight within d both ways from its nearest approach, out to the chord whose arc bows d; the circle out from
  // there not clearance (the offset range's half, sqrt 2).
  Setup pass("passBy", 0.1, 0.26);
  const PoleRing& p = *pass.at(0, 1);
  CHECK(p.kase == Case::through);
  CHECK_EQ(static_cast<int>(p.through.size()), 1);
  CHECK(std::fabs(p.straight - 2 * std::sin(std::acos(0.9))) < 1e-4);
  CHECK(near(p.clearance, M_SQRT2, 1e-9));
  // Its south pole is 5e-4 from the circle's vertex, where the closed edge starts and ends: incident both ways round,
  // none of it clearance.
  const PoleRing& q = *pass.at(0, -1);
  CHECK(q.kase == Case::through);
  CHECK(near(q.clearance, M_SQRT2, 1e-9));
  // curlBack: the small circle's arc leaves the pole and comes back to q, 0.153 from it; that later part is
  // clearance: half q's colatitude c, as a reach 2 sin(c / 4); the meridian from q is incident all the way.
  Setup curl("curlBack", 0.1, 0.26);
  const PoleRing& c = *curl.at(0, 1);
  CHECK(c.kase == Case::through);
  const double chord = 2 * std::sin(0.3) * std::sin(M_PI / 12), colat = 2 * std::asin(chord / 2);
  CHECK(near(c.clearance, 2 * std::sin(colat / 4), 1e-6));
  CHECK(near(c.straight, chord, 1e-6));
}

TEST_CASE("a ring's pieces: each chord within the deflection of the ring, each turning at most the angle") {
  // cap's ring at its radius, with no angle (the deflection alone) and with 0.05: every piece's chord within d of the
  // ring at 64 points along it, the ring's tangent turning at most the angle over a piece (as its 64 chords turn).
  Setup cap("cap", 0.1, 0.26);
  const PoleRing& c = *cap.at(0, 1);
  for (double angle : {0.0, 0.05}) {
    const auto run = c.runs[0];
    for (double d : {0.1, 1e-3}) {
      const int pieces = ringPieces(*cap.surfaces[0], c, run, c.radius, d, angle);
      double worst = 0, turn = 0;
      for (int j = 0; j < pieces; j++) {
        auto q = [&](double f) { return run.first + (run.second - run.first) * (j + f) / pieces; };
        auto p = [&](double f) {
          cadgeom::SurfacePoint sp;
          cadgeom::Vec2 uv = c.isoU ? Vec2{c.at + c.side * c.radius, q(f)} : Vec2{q(f), c.at + c.side * c.radius};
          cap.surfaces[0]->eval(uv.x, uv.y, 0, sp);
          return sp.p;
        };
        Vec3 a = p(0), b = p(1), dv = b - a;
        double piece = 0;
        Vec3 prev = p(1.0 / 64) - a;
        for (int k = 1; k < 64; k++) {
          Vec3 x = p(k / 64.0);
          double w = std::clamp(cadgeom::dot(x - a, dv) / cadgeom::dot(dv, dv), 0.0, 1.0);
          worst = std::fmax(worst, cadgeom::norm(x - (a + w * dv)));
          Vec3 next = p((k + 1) / 64.0) - x;
          if (k > 1) piece += std::atan2(cadgeom::norm(cadgeom::cross(prev, next)), cadgeom::dot(prev, next));
          prev = next;
        }
        turn = std::fmax(turn, piece);
      }
      CHECK(worst <= d);
      if (angle > 0) CHECK(turn <= angle * (1 + 1e-6));
    }
  }
}

TEST_CASE("a ring's cuts exact all together or not at all: not where an edge's approaches spread past the reach") {
  // A ring at one of the cube's corners, reach 0.3, its three edges approaching at that corner: every cut exact. One
  // edge given a second approach 0.25 along it (within the reach): still. At 0.5 along (an edge running along the
  // pole past the reach): none of the ring's cuts exact, the others' too.
  cadgeom::Model m = Setup::load("cube");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 1e-3;
  o.maxSpacing = 0.1;
  EdgeMesh em(m, o);
  const Vec3 corner = em.edge(0).points.front();
  PoleRing ring;
  ring.pole = corner;
  ring.reach = 0.3;
  int first = -1;
  for (int e = 0; e < m.edges(); e++) {
    const EdgeSamples& s = em.edge(e);
    for (bool front : {true, false})
      if (cadgeom::norm((front ? s.points.front() : s.points.back()) - corner) == 0) {
        ring.approaches.push_back({e, front ? s.t.front() : s.t.back()});
        if (first < 0) first = e;
      }
  }
  REQUIRE(ring.approaches.size() == 3u);
  auto all = [&](bool want) {
    const std::vector<RingCut> cuts = ringCuts(em, ring);
    bool same = !cuts.empty();
    for (const RingCut& c : cuts) same = same && c.exact == want;
    return same;
  };
  CHECK(all(true));
  // (Approaches of different edges far apart are no edge's spread: an edge away from the corner, at its start.)
  for (int e = 0; e < m.edges(); e++) {
    const EdgeSamples& s = em.edge(e);
    if (cadgeom::norm(s.points.front() - corner) < 0.9 || cadgeom::norm(s.points.back() - corner) < 0.9) continue;
    ring.approaches.push_back({e, s.t.front()});
    CHECK(all(true));
    ring.approaches.pop_back();
    break;
  }
  // (The first edge's parameter at a distance x from the corner along it: the cube's edges are unit lines.)
  const EdgeSamples& s = em.edge(first);
  const bool front = cadgeom::norm(s.points.front() - corner) == 0;
  auto along = [&](double x) { return front ? s.t.front() + x * (s.t.back() - s.t.front())
    : s.t.back() + x * (s.t.front() - s.t.back()); };
  ring.approaches.push_back({first, along(0.25)});
  CHECK(all(true));
  ring.approaches.back().second = along(0.5);
  CHECK(all(false));
}

TEST_CASE("a pole whose row reaches as far as its ring (the ring on the row): no fan (the case outside), its extent "
  "kept; a row nearly as long whose ring stands off it keeps its ring") {
  // poleRowFan (VW #2452's #298974): its pole a B-spline row 0.12 long at 0.123, its reach at the 0.1 floor. A true
  // pole's row is a point: seamCone's apex keeps its ring, extent 0.
  Setup row("poleRowFan", 0.1, 15 * M_PI / 180);
  REQUIRE(row.rings[0].size() == 1u);
  const PoleRing& r = row.rings[0][0];
  CHECK(r.kase == Case::outside);
  CHECK(r.radius == 0 && r.reach == 0);
  // (Over the face's run along the row, v from 0 to 1: 0.11 of the row's 0.12.)
  CHECK(r.extent > 0.1 && r.extent < 0.13);
  // poleRowShort (LMP1 #172880's #1065578): a row 2.2e-5 long, a pole but for rounding, at a reach of 0.1: its ring.
  Setup tiny("poleRowShort", 0.1, 15 * M_PI / 180);
  REQUIRE(tiny.rings[0].size() == 1u);
  CHECK(tiny.rings[0][0].kase != Case::outside);
  CHECK(tiny.rings[0][0].radius > 0);
  CHECK(tiny.rings[0][0].extent > 1e-6 && tiny.rings[0][0].extent < 1e-4);
  // poleRowNear (LMP1 #172535's #1050721): rows 0.195 and 0.182 long at reaches of 0.1954 and 0.1845, each ring off
  // its row.
  Setup near("poleRowNear", 0.1, 15 * M_PI / 180);
  REQUIRE(near.rings[0].size() == 2u);
  for (const PoleRing& q : near.rings[0]) {
    CHECK(q.kase != Case::outside);
    CHECK(q.radius > 1e-4);
    CHECK(q.extent > 0.9 * q.reach);
    CHECK(q.extent < q.reach);
  }
  Setup cone("seamCone", 0.1, 15 * M_PI / 180);
  bool ringed = false;
  for (const PoleRing& q : cone.rings[0])
    ringed = ringed || (q.kase != Case::outside && q.radius > 0 && q.extent < 1e-9);
  CHECK(ringed);
}

TEST_CASE("one reach per pole across its faces: the least any asks, each face's radius for it") {
  // poleLunes: the unit sphere's lune and a radius 3 sphere's meet at (0, 0, 1); the flatter one's fans pass farther
  // out. Shared, both reach the unit one's; their south poles (apart) keep their own.
  Setup s("poleLunes", 0.1, 0.26);
  REQUIRE(s.at(0, 1) && s.at(1, 1) && s.at(0, -1) && s.at(1, -5));
  const double small = s.at(0, 1)->wanted, big = s.at(1, 1)->wanted, south = s.at(1, -5)->wanted;
  CHECK(small < big);
  std::vector<const cadgeom::Surface*> sp{s.surfaces[0].get(), s.surfaces[1].get()};
  shareRings(sp, s.rings, s.tols.part());
  CHECK_EQ(s.at(0, 1)->reach, small);
  CHECK(near(s.at(1, 1)->reach, small, 1e-9));
  CHECK(near(ringReach(*s.surfaces[1], *s.at(1, 1), s.at(1, 1)->radius), small, 1e-9));
  CHECK_EQ(s.at(1, -5)->reach, south);
  // Shrunk at the shared pole (a split another face asked inside): both rings to the new reach, each face's radius
  // for it; the south poles as they were. A reach no less than theirs changes nothing.
  const Vec3 pole = s.at(0, 1)->pole;
  // (Face 1's shared reach is the unit one's within rounding, maybe a hair above it.)
  CHECK(shrinkRings(sp, s.rings, s.tols.part(), pole, std::max(s.at(0, 1)->reach, s.at(1, 1)->reach)).empty());
  const std::vector<int> faces = shrinkRings(sp, s.rings, s.tols.part(), pole, 0.5 * small);
  CHECK((faces == std::vector<int>{0, 1}));
  for (int f : {0, 1}) {
    CHECK_EQ(s.at(f, 1)->reach, 0.5 * small);
    CHECK(near(ringReach(*s.surfaces[f], *s.at(f, 1), s.at(f, 1)->radius), 0.5 * small, 1e-9));
  }
  CHECK_EQ(s.at(1, -5)->reach, south);
}
