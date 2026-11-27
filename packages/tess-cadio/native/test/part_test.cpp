// part.h on whole parts, each checked by what a part's mesh must be, from the model alone: every model edge's final
// samples in every face that uses it (the same points, the consecutive ones joined by a triangle's side), a closed
// shell's mesh closed and consistently oriented (each side of a triangle used by exactly one other, the other way),
// normals unit and finite (a sphere's pole included) and on the side the triangles face, triangles within the
// deflection of the surface, the faces' areas against their closed forms, the same mesh twice.
// The criteria's own tests are in part_criteria_test.cpp, the rounds', retries', defects' and caps' in
// part_rounds_test.cpp (three binaries, each well within the test runner's time limit under the sanitizers).

#include "part_common.h"

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
         Case{"seamHemisphere", 0, 2 * M_PI, 1, {0, 0, 0}, false},
         Case{"seamHemisphereBare", 0, 2 * M_PI, 1, {0, 0, 0}, false},
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

TEST_CASE("PartOptions::minAngle shapes the mesher's triangles: spheres' at 0.5 rad, fewer and thinner at 0") {
  CHECK_EQ(PartOptions{}.minAngle, 10 * M_PI / 180);
  // On the spheres model at d 0.01 the triangles' smallest 3D angle follows the target (0.20 rad at none, 0.26 at
  // 0.5), at the cost of a few more triangles.
  cadgeom::Model m = load("spheres");
  auto run = [&](double a, size_t& tris) {
    PartOptions o = options(0.01, 0.26);
    o.minAngle = a;
    PartMesher pm(m, o);
    double least = 10;
    tris = 0;
    for (int f = 0; f < m.faces(); f++) {
      const FaceMesh& fm = pm.face(f);
      REQUIRE(fm.status == cadgeom::Status::ok);
      for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
        const Vec3 p[3] = {fm.points[fm.triangles[t]], fm.points[fm.triangles[t + 1]], fm.points[fm.triangles[t + 2]]};
        for (int k = 0; k < 3; k++) {
          const Vec3 u = p[(k + 1) % 3] - p[k], v = p[(k + 2) % 3] - p[k];
          least = std::min(least, std::atan2(cadgeom::norm(cadgeom::cross(u, v)), cadgeom::dot(u, v)));
        }
      }
      tris += fm.triangles.size() / 3;
    }
    return least;
  };
  size_t none = 0, shaped = 0;
  const double leastNone = run(0, none), leastShaped = run(0.5, shaped);
  CHECK(leastShaped > leastNone + 0.03);
  CHECK(leastShaped > 0.25);
  CHECK(shaped > none);
}

TEST_CASE("a face's notes as flags: a capped refinement is capped, not an unsettled seam; luneOnSeam's by inversion") {
  {
    cadgeom::Model m = load("spheres");
    PartOptions o = options(1e-3, 0.26);
    o.maxPointsPerFace = 20;
    o.checkDeviation = false;  // (kept, however far: the cap's mesh is past d)
    o.failCapped = false;
    PartMesher pm(m, o);
    const FaceMesh& fm = pm.face(1);
    REQUIRE(fm.status == cadgeom::Status::ok);
    CHECK(fm.capped);
    CHECK(!fm.seamUnsettled);
    // Failed (without keepDefects, its mesh too far off for it anyway), said so, its triangles dropped.
    o.failCapped = true;
    o.keepDefects = false;
    PartMesher failed(m, o);
    const FaceMesh& ff = failed.face(1);
    CHECK(ff.status == cadgeom::Status::noConvergence);
    CHECK(ff.capped);
    CHECK(ff.cause.rfind("refinement stopped at its point cap, ", 0) == 0);
    CHECK(ff.triangles.empty());
    CHECK(ff.points.empty());
  }
  {
    cadgeom::Model m = load("luneOnSeam");
    PartOptions o = options(0.01, 0.02);
    o.projectMissingPcurves = false;
    PartMesher pm(m, o);
    const FaceMesh& fm = pm.face(0);
    REQUIRE(fm.status == cadgeom::Status::ok);
    CHECK(fm.seamUnsettled);
    CHECK(!fm.capped);
  }
}

TEST_CASE("an edge's inside sample within min(the part's tolerance, d / 10) of its vertex dropped from the edge "
  "(clampedCorner): "
  "the loop no longer reverses at the corner clamped onto the box's side, the face meshed") {
  // (The polyline's sample (1.03, 0.011) is 0.02 from the corner, within min(0.1, 0.05) at d = 0.5: kept,
  // both feet on u = 1 and the loop runs down to the corner and back up the side, refused as through its own point.)
  cadgeom::Model m = load("clampedCorner");
  REQUIRE(m.ok());
  EdgeOptions eo;
  eo.deflection = 0.5;
  EdgeMesh em(m, eo);
  CHECK_EQ(em.edge(0).points.size(), 2u);
  // Under a tolerance of 0.01 it's past the tolerance, so kept whatever d / 10 is.
  cadgeom::Model tight = load("clampedCornerTight");
  REQUIRE(tight.ok());
  EdgeMesh et(tight, eo);
  CHECK_EQ(et.edge(0).points.size(), 3u);
  // And at d = 0.1 past d / 10 (0.01) under the coarse tolerance: kept, the tolerance alone not enough to drop it.
  EdgeOptions fine = eo;
  fine.deflection = 0.1;
  EdgeMesh ef(m, fine);
  CHECK_EQ(ef.edge(0).points.size(), 3u);
  PartMesher pm(m, options(0.5, 0.26));
  const FaceMesh& fm = pm.face(0);
  if (fm.status != cadgeom::Status::ok) std::printf("  clampedCorner: %s\n", fm.cause.c_str());
  CHECK(fm.status == cadgeom::Status::ok);
}

TEST_CASE("an edge's sample stepping back along a side its feet are clamped onto dropped from the edge (sideWobble), "
  "the chord bridging it within the deflection: the loop no longer reverses there, the face meshed") {
  // (Its top edge's samples 0.8, 0.52, 0.53, 0.54, 0.5, 0.2 in u on v = 1: the loop turns back at 0.52 and 0.54 and
  // runs back between, all three dropped where 0.8 to 0.5 bridges them within d (0.53's point 0.0005 off it); at
  // d = 0.0002 kept. Inside the patch only the turns go, 0.53 kept: the loop no longer reverses either way.)
  cadgeom::Model m = load("sideWobble");
  REQUIRE(m.ok());
  EdgeOptions eo;
  eo.deflection = 0.1;
  EdgeMesh em(m, eo);
  CHECK_EQ(em.edge(0).points.size(), 3u);  // (the top edge, made first)
  eo.deflection = 0.0002;
  EdgeMesh fine(m, eo);
  CHECK_EQ(fine.edge(0).points.size(), 6u);
  PartMesher pm(m, options(0.1, 0.26));
  const FaceMesh& fm = pm.face(0);
  if (fm.status != cadgeom::Status::ok) std::printf("  sideWobble: %s\n", fm.cause.c_str());
  CHECK(fm.status == cadgeom::Status::ok);
  // And inside the patch (lineWobble, y = 0.9): the loop reverses on a line no side clamps it to, the same drop.
  cadgeom::Model w = load("lineWobble");
  REQUIRE(w.ok());
  eo.deflection = 0.1;
  EdgeMesh ew(w, eo);
  CHECK_EQ(ew.edge(0).points.size(), 4u);
}

TEST_CASE("a pole's ring inside every edge's approach to the pole (poleDip): its arc, one span with no sample of its "
  "own, its curve nearer the pole than its ends, counted by its nearest point; the face meshed") {
  // (At d = 0.1 with the angle all but off, the arc is one span: its two ends, labelled with the meridians, are all
  // the ring's clearance saw, the ring then outside the curve's dip and its pieces crossing the arc once it's split.)
  cadgeom::Model m = load("poleDip");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 3));
  const FaceMesh& fm = pm.face(0);
  if (fm.status != cadgeom::Status::ok) std::printf("  poleDip: %s\n", fm.cause.c_str());
  CHECK(fm.status == cadgeom::Status::ok);
}

TEST_CASE("a point ships (shippedAt) as float32 minus the output's origin, a boundary point as its own point") {
  // (pcurveNear's plane: (u, v) its (x, y) at z 0.)
  cadgeom::Model m = load("pcurveNear");
  REQUIRE(m.ok());
  cadgeom::Status st;
  auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
  auto c = makeCriteria(m, 0, *s, cadgeom::Box2{{-3, 3}, {-3, 3}}, Deflections{0.1, 0.26}, st);
  REQUIRE(c);
  float f[3];
  REQUIRE(c->shippedAt({1, 2}, f));
  CHECK((f[0] == 1 && f[1] == 2 && f[2] == 0));
  const double origin[3] = {0, -1, 0};
  c->setOutputOrigin(origin);
  REQUIRE(c->shippedAt({1, 2}, f));
  CHECK((f[0] == 1 && f[1] == 3 && f[2] == 0));
  c->setBoundaryPoints({{{1, 2}, Vec3{5, 5, 5}}});
  REQUIRE(c->shippedAt({1, 2}, f));
  CHECK((f[0] == 5 && f[1] == 6 && f[2] == 5));
  // (Far out, two points 1e-6 apart ship as one.)
  const double far[3] = {0, -3000, 0};
  c->setOutputOrigin(far);
  float g[3];
  REQUIRE(c->shippedAt({0.5, 0.5}, f));
  REQUIRE(c->shippedAt({0.5, 0.5 + 1e-6}, g));
  CHECK((f[0] == g[0] && f[1] == g[1] && f[2] == g[2]));
}

TEST_CASE("a boundary fold repaired: a corner convex in (u, v), concave in 3D, its (u, v) turned as its 3D point") {
  // cornerFold's corner point (0.994, 0.994) has its (u, v) at (1, 1) from its edges' p-curves: an ear there faced
  // against the plane. Repaired: its (u, v) onto the chord of (1, 0.99) and (0.99, 1), then a step to the point's
  // own, (0.994, 0.994) on the plane, within the face's tolerance; no triangle facing against the surface, its 3D
  // point kept.
  cadgeom::Model m = load("cornerFold");
  REQUIRE(m.ok());
  for (double d : {0.1, 0.01}) {
    PartMesher pm(m, options(d, 0.26));
    const FaceMesh& fm = pm.face(0);
    REQUIRE(fm.status == cadgeom::Status::ok);
    CHECK_EQ(fm.foldsRepaired, 1);
    FaceBoundary fb = pm.edges().face(0);
    bool kept = false;
    for (const BoundaryPoint& p : fb.loops[0])
      if (cadgeom::norm(p.point - Vec3{0.994, 0.994, 0}) < 1e-12) {
        kept = true;
        CHECK(std::hypot(p.uv.x - 0.994, p.uv.y - 0.994) < 1e-9);
      }
    CHECK(kept);
    int facing = 0;
    for (size_t t = 0; t < fm.triangles.size(); t += 3) {
      Vec3 a = fm.points[fm.triangles[t]], b = fm.points[fm.triangles[t + 1]], c = fm.points[fm.triangles[t + 2]];
      facing += cadgeom::cross(b - a, c - a).z < 0;
    }
    if (facing) std::printf("  cornerFold at %g: %d triangles facing against the plane\n", d, facing);
    CHECK_EQ(facing, 0);
  }  // cornerFoldTight: the move past its face's tolerance (0.001), not made.
  cadgeom::Model t = load("cornerFoldTight");
  REQUIRE(t.ok());
  PartMesher pt(t, options(0.1, 0.26));
  CHECK_EQ(pt.face(0).foldsRepaired, 0);
}

TEST_CASE("a strip whose ends are within the tolerance: refined past them (frozen), never asking them split") {
  // narrowStrip: 25 x 0.85 on a cylinder of radius 1.5 under an uncertainty of 1. Its ends' arcs are never split (the
  // floor), and every candidate in the two first triangles lies in an end's diametral circle: without frozen
  // segments the face stays those 2 triangles, both refused, the ends wanted split round after round.
  cadgeom::Model m = load("narrowStrip");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 0.26));
  const FaceMesh& fm = pm.face(0);
  CHECK(fm.status == cadgeom::Status::ok);
  CHECK(fm.triangles.size() / 3 > 20);
  CHECK(fm.rejected.size() <= 1);
  CHECK_EQ(fm.splitsWanted, 0);
  // narrowStripSmall at a deflection of 0.5: its ends' chords over the tolerance (0.001) but within the floor (0.05),
  // so also never split, also frozen; refined past them the same way.
  cadgeom::Model s = load("narrowStripSmall");
  REQUIRE(s.ok());
  PartMesher ps(s, options(0.5, 0.26));
  const FaceMesh& fs = ps.face(0);
  if (fs.splitsWanted || fs.triangles.size() / 3 <= 20)
    std::printf("  narrowStripSmall: %zu triangles, %zu refused, %d splits\n", fs.triangles.size() / 3,
      fs.rejected.size(), fs.splitsWanted);
  CHECK(fs.status == cadgeom::Status::ok);
  CHECK(fs.triangles.size() / 3 > 20);
  CHECK(fs.rejected.size() <= 1);
  CHECK_EQ(fs.splitsWanted, 0);
  // Its ends (the circles) kept whole at 0.5; at 0.3 (a floor of 0.03, under their chord) split, as the mesh asks.
  for (double d : {0.5, 0.3}) {
    PartMesher pd(s, options(d, 0.26));
    size_t most = 0;
    for (int e = 0; e < s.edges(); e++)
      if (s.curveKind(s.edgeCurve(e)) == CBR_CURVE_CIRCLE) most = std::max(most, pd.edges().edge(e).points.size());
    if ((most > 2) != (d < 0.4)) std::printf("  narrowStripSmall at %g: an end in %zu samples\n", d, most);
    CHECK_EQ(most > 2, d < 0.4);
  }
}

TEST_CASE("a face whose edge loops all lie within the tolerance of a pole: invalidModel, and said so") {
  // capWithinPole: a cap of radius 0.2 at a pole under an uncertainty of 1, its circle dropped as on the pole line;
  // not a face without loops (loopless's plane, which has none and no natural extent, keeps that cause).
  cadgeom::Model m = load("capWithinPole");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 0.26));
  const FaceMesh& fm = pm.face(0);
  CHECK(fm.status == cadgeom::Status::invalidModel);
  CHECK(fm.triangles.empty());
  const bool said = fm.cause.find("within the tolerance of a pole") != std::string::npos;
  if (!said) std::printf("  cause: %s\n", fm.cause.c_str());
  CHECK(said);
  cadgeom::Model l = load("loopless");
  REQUIRE(l.ok());
  PartMesher pl(l, options(0.1, 0.26));
  CHECK(pl.face(0).status == cadgeom::Status::unsupported);
  CHECK(pl.face(0).cause.find("no edge loops") != std::string::npos);
}

TEST_CASE("B-spline faces with no loops meshed over their knot rectangles: open, closed in u, with a pole side") {
  // looplessBsplines: a plane patch (area 2), a tube closed in fact (20 pi), a quarter cone with an apex row and its
  // u reversed (pi sqrt 2 / 4 each): every one meshed, its area under its own by at most about the deflection over
  // its radius, nothing refused, triangles facing as the surface does.
  cadgeom::Model m = load("looplessBsplines");
  REQUIRE(m.ok());
  const double want[4] = {2, 20 * M_PI, M_PI * M_SQRT2 / 4, M_PI * M_SQRT2 / 4}, radius[4] = {1e300, 2, 1, 1};
  for (double d : {0.05, 0.01}) {
    PartMesher pm(m, options(d, 0.26));
    for (int f = 0; f < 4; f++) {
      const FaceMesh& fm = pm.face(f);
      if (fm.status != cadgeom::Status::ok) std::printf("  looplessBsplines face %d: %s\n", f, fm.cause.c_str());
      REQUIRE(fm.status == cadgeom::Status::ok);
      double area = 0;
      int facing = 0;
      for (size_t t = 0; t < fm.triangles.size(); t += 3) {
        const Vec3 a = fm.points[fm.triangles[t]], b = fm.points[fm.triangles[t + 1]];
        const Vec3 c = fm.points[fm.triangles[t + 2]];
        const Vec3 g = cadgeom::cross(b - a, c - a);
        area += 0.5 * cadgeom::norm(g);
        facing += cadgeom::dot(g, fm.normals[fm.triangles[t]] + fm.normals[fm.triangles[t + 1]] +
          fm.normals[fm.triangles[t + 2]]) < 0;
      }
      const bool ok = area <= want[f] * (1 + 1e-9) && area > want[f] * (1 - std::min(0.5, 2.5 * d / radius[f]) - 1e-9);
      if (!ok) std::printf("  looplessBsplines face %d at %g: area %.9g want %.9g\n", f, d, area, want[f]);
      CHECK(ok);
      CHECK(fm.rejected.empty());
      CHECK_EQ(facing, 0);
      // The cones' apex rows as pole lines: their fans meet at one point there.
      if (f >= 2) {
        int apex = 0;
        for (const Vec3& p : fm.points) apex += cadgeom::norm(p) < 1e-12;
        CHECK_EQ(apex, 1);
      }
    }
    // Their pseudo-edges: the plane's four sides, the tube's bottom and top and its seam once, each cone's three
    // sides but its apex row.
    CHECK_EQ(pm.edges().edgeCount() - m.edges(), 4 + 3 + 3 + 3);
  }
}

TEST_CASE("a fold narrower than the tolerance: foldNormal its sides' normal there; the strip meshed, its normals "
  "the sides'; a tight fillet not one") {
  // pleatStrip: its section's normal reversed over v 0.45 to 0.55 (the surface running back 1.2e-3 there), its
  // tolerance 0.2. At v 0.5 the normal is reversed against the surface's 0.2 away on both sides, which agree: the
  // sides' mean, folded; at v 0.2 and 0.8 the surface's own.
  cadgeom::Model m = load("pleatStrip");
  REQUIRE(m.ok());
  cadgeom::Status st;
  auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
  REQUIRE(s);
  for (double v : {0.2, 0.5, 0.8}) {
    Vec3 plain, n;
    bool folded = true;
    REQUIRE(s->normal(0.5, v, plain) == cadgeom::Status::ok);
    REQUIRE(foldNormal(*s, 0.5, v, 0.2, n, &folded) == cadgeom::Status::ok);
    CHECK_EQ(folded, v == 0.5);
    if (v == 0.5) {
      CHECK(cadgeom::dot(n, plain) < 0);
      Vec3 a;
      REQUIRE(s->normal(0.5, 0.2, a) == cadgeom::Status::ok);
      CHECK(cadgeom::dot(n, a) > 0.99);
    } else {
      CHECK(cadgeom::norm(n - plain) == 0);
    }
  }
  // Meshed at medium: no runaway, no face failed or turned past the limits, the strip's area (0.6 x 190 and the
  // pleat's 3.5e-3 x 190 more: its section's length by the Bezier's arc), the vertices in the pleat its sides'.
  PartOptions o = options(0.1, 15 * M_PI / 180);
  PartMesher pm(m, o);
  const FaceMesh& fm = pm.face(0);
  REQUIRE(fm.status == cadgeom::Status::ok);
  CHECK(fm.triangles.size() / 3 < 1000);
  CHECK(fm.foldedNormals > 0);
  double area = 0;
  for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
    area += 0.5 * cadgeom::norm(cadgeom::cross(fm.points[fm.triangles[t + 1]] - fm.points[fm.triangles[t]],
      fm.points[fm.triangles[t + 2]] - fm.points[fm.triangles[t]]));
  CHECK(std::fabs(area - 190 * 0.6) < 0.01 * 190 * 0.6);
  CHECK_EQ(sharedEdges(m, pm, "pleatStrip"), 0);
  // thinTube: a half cylinder of radius 0.005 at a tolerance of 0.1, its sides at its ends facing apart: no fold.
  cadgeom::Model c = load("thinTube");
  REQUIRE(c.ok());
  auto tube = cadgeom::makeSurface(c, c.faceSurface(0), st);
  REQUIRE(tube);
  Vec3 n;
  bool folded = true;
  REQUIRE(foldNormal(*tube, M_PI / 2, 0.5, 0.1, n, &folded) == cadgeom::Status::ok);
  CHECK(!folded);
}

TEST_CASE("foldNormal on polyline sections: a fold only where the sides agree and both are against the point; its "
  "sides found by a step that shrinks to the tolerance") {
  cadgeom::Status st;
  auto at = [&](const cadgeom::Surface& s, double v) {
    Vec3 n;
    REQUIRE(s.normal(0.5, v, n) == cadgeom::Status::ok);
    return n;
  };
  auto verdict = [&](const cadgeom::Surface& s, Vec3& n) {
    bool folded = false;
    REQUIRE(foldNormal(s, 0.5, 0.5, 0.2, n, &folded) == cadgeom::Status::ok);
    return folded;
  };
  // foldSidesApart: the short leg's normal against both legs beside it, which are 120 degrees apart.
  cadgeom::Model apart = load("foldSidesApart");
  REQUIRE(apart.ok());
  auto a = cadgeom::makeSurface(apart, apart.faceSurface(0), st);
  REQUIRE(a);
  CHECK(cadgeom::dot(at(*a, 0.5), at(*a, 0.1)) < 0);
  CHECK(cadgeom::dot(at(*a, 0.5), at(*a, 0.9)) < 0);
  CHECK(cadgeom::dot(at(*a, 0.1), at(*a, 0.9)) < 0);
  Vec3 n;
  CHECK(!verdict(*a, n));
  CHECK(cadgeom::norm(n - at(*a, 0.5)) == 0);
  // foldOneSide: against the leg before it alone, the two legs agreeing.
  cadgeom::Model one = load("foldOneSide");
  REQUIRE(one.ok());
  auto o = cadgeom::makeSurface(one, one.faceSurface(0), st);
  REQUIRE(o);
  CHECK(cadgeom::dot(at(*o, 0.5), at(*o, 0.1)) < 0);
  CHECK(cadgeom::dot(at(*o, 0.5), at(*o, 0.9)) > 0);
  CHECK(cadgeom::dot(at(*o, 0.1), at(*o, 0.9)) > 0);
  CHECK(!verdict(*o, n));
  // foldStepFar: the short leg (v 0.4 to 0.6) between legs forward (0.2 to 0.4, 0.6 to 0.8), those between legs
  // back as the short one is; the first step lands past the domain's ends, on the long legs: shrunk, it finds the
  // forward legs, a fold, its normal theirs.
  cadgeom::Model far = load("foldStepFar");
  REQUIRE(far.ok());
  auto f = cadgeom::makeSurface(far, far.faceSurface(0), st);
  REQUIRE(f);
  CHECK(cadgeom::dot(at(*f, 0.5), at(*f, 0.1)) > 0.99);
  CHECK(verdict(*f, n));
  CHECK(cadgeom::dot(n, at(*f, 0.3)) > 0.99);
}

TEST_CASE("a fold's slivers accepted where thinner than the refinement floor across, not wider; LMP1 #1039663 "
  "pleated at its edge meshed, few turned") {
  // pleatStrip's criteria at a deflection of 1 (its floor 0.2, the uncertainty; the deviation bound within it): a
  // triangle from the fold (0.5, 0.5) to v 0.05 and 0.95 (x 0.08 and 0.52) 2 along y, 0.43 across, refused for its
  // normals; 0.05 along y, 0.05 across, accepted.
  cadgeom::Model m = load("pleatStrip");
  REQUIRE(m.ok());
  cadgeom::Status st;
  auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
  auto c = makeCriteria(m, 0, *s, cadgeom::Box2{{0, 1}, {0, 1}}, Deflections{1, 15 * M_PI / 180}, st);
  REQUIRE(c);
  const Vec2 wide[3] = {{0.5, 0.5}, {0.5 + 2.0 / 190, 0.05}, {0.5 + 2.0 / 190, 0.95}};
  const Vec2 thin[3] = {{0.5, 0.5}, {0.5 + 0.05 / 190, 0.05}, {0.5 + 0.05 / 190, 0.95}};
  CHECK(c->refusal(wide) == Refusal::normalFacet);
  CHECK(c->refusal(thin) == Refusal::none);
  // pleatAtEdge at medium, judged as shipped (the origin its vertices' box's centre): meshed, its slivers in the
  // fold kept rather than split (refined, without them accepted turned as shipped, it ships ten times the turned).
  cadgeom::Model e = load("pleatAtEdge");
  REQUIRE(e.ok());
  PartOptions o = options(0.1, 15 * M_PI / 180);
  o.minAngle = 10 * M_PI / 180;
  Vec3 lo{INFINITY, INFINITY, INFINITY}, hi{-INFINITY, -INFINITY, -INFINITY};
  for (int i = 0; i < e.vertices(); i++) {
    const Vec3 p = e.vertexPoint(i);
    lo = {std::fmin(lo.x, p.x), std::fmin(lo.y, p.y), std::fmin(lo.z, p.z)};
    hi = {std::fmax(hi.x, p.x), std::fmax(hi.y, p.y), std::fmax(hi.z, p.z)};
  }
  o.outputOrigin[0] = 0.5 * (lo.x + hi.x), o.outputOrigin[1] = 0.5 * (lo.y + hi.y);
  o.outputOrigin[2] = 0.5 * (lo.z + hi.z);
  PartMesher pm(e, o);
  const FaceMesh& fm = pm.face(0);
  if (fm.status != cadgeom::Status::ok) std::printf("  pleatAtEdge: %s\n", fm.cause.c_str());
  REQUIRE(fm.status == cadgeom::Status::ok);
  CHECK(fm.defectTurned <= 4);
  CHECK(fm.triangles.size() / 3 < 400);
  CHECK(fm.foldedNormals > 0);
}

TEST_CASE("a pole's fan that folds fails its face (failFoldedFans), said so; off, meshed; a row reaching as far as "
  "its ring gets no fan, one nearly as long keeps its fans") {
  // seamCone at 0.05 with its first fan triangle turned for the test (turnFirstFanTriangleForTests): its ring segment
  // used the same way as the mesher's triangle beside it, a fold, whatever consistentFans and apexCorners.
  cadgeom::Model m = load("seamCone");
  REQUIRE(m.ok());
  for (bool rules : {true, false}) {
    PartOptions o = options(0.05, 0.26);
    o.consistentFans = o.apexCorners = rules;
    CHECK(PartMesher(m, o).face(0).status == cadgeom::Status::ok);
    o.turnFirstFanTriangleForTests = true;
    PartMesher turned(m, o);
    const FaceMesh& fm = turned.face(0);
    CHECK(fm.status == cadgeom::Status::noConvergence);
    CHECK(fm.cause.find("a pole's fan folds over itself: ") != std::string::npos);
    CHECK(fm.triangles.empty());
    o.failFoldedFans = false;
    PartMesher kept(m, o);
    CHECK(kept.face(0).status == cadgeom::Status::ok);
    CHECK(!kept.face(0).triangles.empty());
  }
  // poleRowFan (VW #2452's #298974) at medium: no fan at its row-long pole, meshed, every edge of it used once
  // each way or once at the boundary.
  cadgeom::Model row = load("poleRowFan");
  REQUIRE(row.ok());
  PartMesher pm(row, options(0.1, 15 * M_PI / 180));
  CHECK(pm.face(0).status == cadgeom::Status::ok);
  CHECK(!pm.face(0).triangles.empty());
  CHECK_EQ(sharedEdges(row, pm, "poleRowFan"), 0);
  // poleRowNear (LMP1 #172535's #1050721) at medium: its rings off its rows, fans kept, none folding (failFoldedFans
  // would fail the face). (Its edges run along its rows, which its fans meet at their rings, not at the edges' samples:
  // sharedEdges doesn't apply.)
  cadgeom::Model near = load("poleRowNear");
  REQUIRE(near.ok());
  PartMesher nm(near, options(0.1, 15 * M_PI / 180));
  if (nm.face(0).status != cadgeom::Status::ok) std::printf("  poleRowNear: %s\n", nm.face(0).cause.c_str());
  CHECK(nm.face(0).status == cadgeom::Status::ok);
  CHECK(!nm.face(0).triangles.empty());
}

TEST_CASE("cones with a seam from the apex used both ways: within the deflection, to area, the jump a whole turn") {
  // The cad-brep cone (no seam p-curves) and seamCone (given, at u = 2 pi up and 0 down), with a degenerate edge at
  // the apex and without: the loop's jump across the apex a whole period (the seam's two uses either side), not a cut
  // on top of its seams. Projected and not. Radius 1 at z = 0, the apex (0, 0, -1): a point's distance from the
  // surface |hypot(x, y) - (1 + z)| / sqrt 2. Area pi sqrt 2. coneApexLoop: the apex a loop of its own, an edge with
  // no curve there, the pole (Turned: on a face whose sense is false, where the face's side wouldn't find it).
  // seamConeTurned: seamConeBare's loop on a face whose sense is false, meshed as that sense has it, the loop against
  // it said.
  const double area = M_PI * M_SQRT2;
  for (const char* name : {"cone", "seamCone", "seamConeBare", "coneApexLoop", "coneApexLoopTurned", "seamConeTurned"})
    for (bool project : {true, false})
      for (double d : {0.05, 0.01}) {
        cadgeom::Model m = load(name);
        REQUIRE(m.ok());
        PartOptions o = options(d, 0.26);
        o.projectMissingPcurves = project;
        PartMesher pm(m, o);
        const FaceMesh& fm = pm.face(0);
        if (fm.status != cadgeom::Status::ok)
          std::printf("  %s: status %d %s\n", name, int(fm.status), fm.cause.c_str());
        REQUIRE(fm.status == cadgeom::Status::ok);
        CHECK_EQ(fm.againstSense, std::strcmp(name, "seamConeTurned") == 0);
        const Vec3 apex{0, 0, -1};
        Stats st = stats(fm, [](Vec3 p) { return std::fabs(std::hypot(p.x, p.y) - (1 + p.z)) * M_SQRT1_2; }, &apex,
          1e-12);
        CHECK_EQ(st.badNormals, 0);
        CHECK_EQ(st.facing, 0);
        CHECK(st.worst <= d * (1 + 1e-9));
        if (!(st.area < area && st.area > area * (1 - 2.5 * d)))
          std::printf("  %s: area %.9g want %.9g at %g\n", name, st.area, area, d);
        CHECK(st.area < area && st.area > area * (1 - 2.5 * d));
        CHECK_EQ(sharedEdges(m, pm, name), 0);
        CHECK(fm.rejected.empty());
      }
}

TEST_CASE("a flat ring narrower than its circles' chords sag (thinRing): every crossing span split in one round, "
  "meshed within the rounds") {
  // (The circles' polygons cross each other many times in (u, v): mesh2 names every crossing, each a round splits;
  // the first pair alone a round wouldn't get through within maxSplitRounds.)
  cadgeom::Model m = load("thinRing");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 15 * M_PI / 180));
  const FaceMesh& fm = pm.face(0);
  if (fm.status != cadgeom::Status::ok) std::printf("  thinRing: %s, after %d rounds\n", fm.cause.c_str(), pm.rounds());
  REQUIRE(fm.status == cadgeom::Status::ok);
  double area = 0;
  for (size_t t = 0; t < fm.triangles.size(); t += 3) {
    Vec3 a = fm.points[fm.triangles[t]], b = fm.points[fm.triangles[t + 1]], c = fm.points[fm.triangles[t + 2]];
    area += 0.5 * cadgeom::cross(b - a, c - a).z;
  }
  // (Each circle's polygon inside it, by its sag: the ring's area, within the outer chords' and inner chords' loss.)
  const double want = M_PI * (1.002 * 1.002 - 1);
  if (!(std::fabs(area - want) < 0.02 * want)) std::printf("  thinRing: area %.9g want %.9g\n", area, want);
  CHECK(std::fabs(area - want) < 0.02 * want);
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

TEST_CASE("the same tube at 1e-3: its crossings, which splits don't mend, not asked to be split once they've grown "
  "1.5 x three times in a row: failed at its third round, not refined round after round") {
  // (At 1e-3 its cut runs through its edge's samples, the pairs the mesher names growing with each round's splits:
  // 191, 300, 514, 900. The rounds held to 8, so that asking every round shows in them.)
  cadgeom::Model m = load("tubeGapOpen");
  REQUIRE(m.ok());
  PartOptions o = options(1e-3, 0.1);
  o.maxSplitRounds = 8;
  PartMesher pm(m, o);
  const FaceMesh& fm = pm.face(0);
  CHECK(fm.status != cadgeom::Status::ok);
  CHECK(fm.triangles.empty());
  CHECK(fm.cause.rfind("its boundary in (u, v) through its own point", 0) == 0);
  CHECK_EQ(fm.splitsWanted, 0);
  CHECK_EQ(pm.rounds(), 3);
}

TEST_CASE("a strip narrower than its tolerance: the spans its crossings name split below the refinement floor, to a "
  "hundredth of it, until its sides' chords stay apart; edges that truly cross split no finer") {
  // narrowArcStrip: radii 1 and 1.001 at an uncertainty of 0.2 (the floor), d 0.1: the arcs' chords sag past 0.001
  // until about 0.09 long, under the floor.
  cadgeom::Model m = load("narrowArcStrip");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 15 * M_PI / 180));
  const FaceMesh& fm = pm.face(0);
  if (fm.status != cadgeom::Status::ok) std::printf("  narrowArcStrip: %s\n", fm.cause.c_str());
  REQUIRE(fm.status == cadgeom::Status::ok);
  CHECK(!fm.triangles.empty());
  CHECK_EQ(sharedEdges(m, pm, "narrowArcStrip"), 0);
  const double floor = refinementFloor(cadgeom::Tolerances(m).part(), 0.1);
  REQUIRE(floor == 0.2);
  double shortest = INFINITY;
  for (int e : {0, 1, 3}) {
    const auto& p = pm.edges().edge(e).points;
    for (size_t k = 0; k + 1 < p.size(); k++) shortest = std::fmin(shortest, cadgeom::norm(p[k + 1] - p[k]));
  }
  CHECK(shortest < floor);
  CHECK(shortest > 0.01 * floor / 2);
  // pentagramLoop: five line edges crossing each other in (u, v), the pairs named the same each round (no growth to
  // stop on): failed for its crossings, its spans split no finer than half a hundredth of the floor, the rounds
  // ending short of their cap.
  cadgeom::Model star = load("pentagramLoop");
  REQUIRE(star.ok());
  PartMesher ps(star, options(0.1, 15 * M_PI / 180));
  CHECK(ps.face(0).status == cadgeom::Status::invalidModel);
  CHECK(ps.face(0).cause.find("its boundary in (u, v) ") == 0);
  CHECK(ps.rounds() < 48);
  double finest = INFINITY;
  for (int e = 0; e < 5; e++) {
    const auto& p = ps.edges().edge(e).points;
    for (size_t k = 0; k + 1 < p.size(); k++) finest = std::fmin(finest, cadgeom::norm(p[k + 1] - p[k]));
  }
  CHECK(finest > 0.01 * floor / 2);
  CHECK(finest < floor);
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
  // Before meshing, each phase in order (surfaces, the edges, criteria), each counting up to its total, a use's report
  // naming its face.
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
  CHECK_EQ(phase, static_cast<int>(PartProgress::criteria));
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

TEST_CASE("apexSector: a cone face reaching its apex and crossing u's seam, meshed in (u, v) or its development "
  "(whichever its metric is nearer isotropic in): its boundary "
  "the edges' samples bit for bit, every triangle within d of the cone, nothing refused, in few rounds") {
  // (apexSector(2.5): seamCone's cone between the rulings at u = -2.5 and 2.5, from its apex to its base circle. Its
  // distance from the cone at a point: |rho - (z + 1)| / sqrt 2, rho the distance from the axis, z above -1.)
  cadgeom::Model m = load("apexSector");
  REQUIRE(m.ok());
  for (double d : {0.1, 0.01, 0.001}) {
    PartMesher pm(m, options(d, 0.26));
    const FaceMesh& fm = pm.face(0);
    REQUIRE(fm.status == cadgeom::Status::ok);
    CHECK(fm.rejected.empty());
    CHECK_EQ(fm.defectDeviation, 0.0);
    CHECK(pm.rounds() <= 2);
    int far = 0;
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
      const int32_t* v = &fm.triangles[t];
      Vec3 p[3] = {fm.points[v[0]], fm.points[v[1]], fm.points[v[2]]};
      for (Vec3 q : {(1.0 / 3) * (p[0] + p[1] + p[2]), 0.5 * (p[0] + p[1]), 0.5 * (p[1] + p[2]),
             0.5 * (p[2] + p[0])})
        far += std::fabs(std::hypot(q.x, q.y) - (q.z + 1)) * M_SQRT1_2 > d * (1 + 1e-9);
    }
    // (Each edge's samples among the mesh's points, bit for bit.)
    int missing = 0;
    for (int e = 0; e < m.edges(); e++)
      for (const Vec3& q : pm.edges().edge(e).points) {
        bool in = false;
        for (const Vec3& p : fm.points) in = in || (p.x == q.x && p.y == q.y && p.z == q.z);
        missing += !in;
      }
    if (far || missing || !fm.rejected.empty() || pm.rounds() > 2)
      std::printf("  apexSector at %g: %d points beyond d, %d samples missing, %zu refused, %d rounds\n", d, far,
        missing, fm.rejected.size(), pm.rounds());
    CHECK_EQ(far, 0);
    CHECK_EQ(missing, 0);
  }
}

TEST_CASE("the developed plane taken only where the face's metric is nearer isotropic there (PartOptions::develop): "
  "a cone to its apex, sized across by the angle, meshed as in (u, v) bit for bit; a vast half cylinder developed") {
  // (apexSector at d 0.1 and 15 degrees: across, the angle's size, about half |R|, is under the sag's sqrt(8 d |R|)
  // everywhere (|R| up to 1): a constant share of u, so (u, v) is the metric's uniform frame and its plane's stretch
  // grows as 1 / rho towards the apex. cylinderVast, radius 8000: across the sag's 80 mm, a hundredth of u, along
  // the same either way, so its plane divides the stretch by its radius.)
  auto mesh = [](const char* name, bool develop) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    PartOptions o = options(0.1, 0.26);
    o.develop = develop;
    PartMesher pm(m, o);
    std::vector<double> out;
    for (int f = 0; f < m.faces(); f++) {
      const FaceMesh& fm = pm.face(f);
      REQUIRE(fm.status == cadgeom::Status::ok);
      for (int32_t v : fm.triangles) out.push_back(v);
      for (const Vec3& p : fm.points) out.insert(out.end(), {p.x, p.y, p.z});
    }
    return out;
  };
  CHECK(mesh("apexSector", true) == mesh("apexSector", false));
  CHECK(mesh("cylinderVast", true) != mesh("cylinderVast", false));
}

TEST_CASE("shippedAt through the developed plane (PartOptions::develop): cylinderVast shipped far from the origin, "
  "no two of a face's vertices at one position as the output rounds them") {
  // (cylinderVast developed, shipped from an origin 1e10 away, where float32 is 1024 apart: the developed field asks
  // its positions at (u, v), mapped back from the plane. Its edges' samples weld among themselves there, as given; no
  // point of the mesher's ships where another vertex does.)
  cadgeom::Model m = load("cylinderVast");
  REQUIRE(m.ok());
  PartOptions o = options(0.1, 0.26);
  o.outputOrigin[0] = 1e10, o.outputOrigin[1] = o.outputOrigin[2] = 0;
  PartMesher pm(m, o);
  for (int f = 0; f < m.faces(); f++) {
    const FaceMesh& fm = pm.face(f);
    REQUIRE(fm.status == cadgeom::Status::ok);
    std::set<std::tuple<double, double, double>> samples;
    for (int e = 0; e < m.edges(); e++)
      for (const Vec3& q : pm.edges().edge(e).points) samples.insert({q.x, q.y, q.z});
    std::set<std::tuple<float, float, float>> at;
    auto shipped = [](const Vec3& p) {
      return std::tuple<float, float, float>{static_cast<float>(p.x - 1e10), static_cast<float>(p.y),
        static_cast<float>(p.z)};
    };
    for (const Vec3& p : fm.points)
      if (samples.count({p.x, p.y, p.z})) at.insert(shipped(p));
    int welded = 0;
    for (const Vec3& p : fm.points)
      if (!samples.count({p.x, p.y, p.z})) welded += !at.insert(shipped(p)).second;
    if (welded) std::printf("  cylinderVast far: face %d, %d vertices welded\n", f, welded);
    CHECK_EQ(welded, 0);
  }
}

TEST_CASE("crowds through the developed plane (PartOptions::develop): thinTube's mesher points kept out of the band "
  "about its boundary's segments as in (u, v)") {
  // (thinTube at d 0.1: a half cylinder of radius 0.005, its plane developed; the band a tenth of the floor, 0.001.
  // No point the mesher placed is within it of any edge's segment in 3D, developed or not.)
  cadgeom::Model m = load("thinTube");
  REQUIRE(m.ok());
  for (bool dev : {false, true}) {
    PartOptions o = options(0.1, 0.26);
    o.develop = dev;
    PartMesher pm(m, o);
    const FaceMesh& fm = pm.face(0);
    REQUIRE(fm.status == cadgeom::Status::ok);
    std::vector<std::pair<Vec3, Vec3>> segs;
    std::set<std::tuple<double, double, double>> boundary;
    for (int e = 0; e < m.edges(); e++) {
      const std::vector<Vec3>& P = pm.edges().edge(e).points;
      for (size_t j = 0; j + 1 < P.size(); j++) segs.push_back({P[j], P[j + 1]});
      for (const Vec3& q : P) boundary.insert({q.x, q.y, q.z});
    }
    double nearest = INFINITY;
    int mesher = 0;
    for (const Vec3& q : fm.points) {
      if (boundary.count({q.x, q.y, q.z})) continue;
      mesher++;
      for (auto [a, b] : segs) {
        const Vec3 ab = b - a;
        const double t = std::clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
        nearest = std::min(nearest, norm(q - (a + t * ab)));
      }
    }
    if (!(nearest > 0.001)) std::printf("  thinTube develop %d: a mesher point %g from a segment\n", int(dev), nearest);
    CHECK(mesher > 0);
    CHECK(nearest > 0.001);
  }
}

TEST_CASE("sectorWall: a split inside another face's pole ring shrinks the ring, whatever the faces' kinds: the wall "
  "within d") {
  // The flat sector's ring is wide (its fans flat), K bending through it: the cylinder's triangles on K's span inside
  // the ring sag off the cylinder. Its request shrinks the ring, the wall elementary or a B-spline (sectorWallSpline:
  // a free-form face asking at a free-form pole), so the wall meshes with nothing refused, every triangle within d of
  // the cylinder at its centroid and sides' middles (by the distance from its axis), the sector's on its plane.
  for (const char* name : {"sectorWall", "sectorWallSpline"})
    for (double d : {0.1, 0.01, 0.003, 0.001}) {
      cadgeom::Model m = load(name);
      REQUIRE(m.ok());
      PartMesher pm(m, options(d, 0.26));
      int far = 0;
      for (int f = 0; f < 2; f++) {
        const FaceMesh& fm = pm.face(f);
        REQUIRE(fm.status == cadgeom::Status::ok);
        CHECK(fm.rejected.empty());
        CHECK_EQ(fm.defectDeviation, 0.0);
        for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
          const int32_t* v = &fm.triangles[t];
          Vec3 p[3] = {fm.points[v[0]], fm.points[v[1]], fm.points[v[2]]};
          for (Vec3 q : {(1.0 / 3) * (p[0] + p[1] + p[2]), 0.5 * (p[0] + p[1]), 0.5 * (p[1] + p[2]),
                 0.5 * (p[2] + p[0])})
            far += (f == 0 ? std::fabs(q.z) : std::fabs(std::hypot(q.x - 0.5, q.y + 0.5) - M_SQRT1_2)) > d * (1 + 1e-9);
        }
      }
      if (far || pm.ringsShrunk() < 1)
        std::printf("  %s at %g: %d points beyond d, %d rings shrunk, %zu and %zu refused\n", name, d, far,
          pm.ringsShrunk(), pm.face(0).rejected.size(), pm.face(1).rejected.size());
      CHECK_EQ(far, 0);
      CHECK(pm.ringsShrunk() >= 1);
      CHECK_EQ(sharedEdges(m, pm, name), 0);
    }
}

TEST_CASE("bentApex's ring in pieces from end to end of its chain, not its run's: within d, its refinement unblocked") {
  // The boundary meets the apex's row over v 0.6 to 0.4, its curves crossing the ring near v 0.95 and 0.05: pieces
  // over the run alone would leave the ring a chord across most of v, which refinement asks to split and can't.
  // At d 0.05: every triangle within the deflection at its centroid and sides' middles (by inversion), nothing
  // refused, no round blocked by a ring's segment. (Finer, the triangles across from the ring want it split finer than
  // its own chords do, and it isn't: at 0.01, 6 rounds blocked.)
  for (double d : {0.05}) {
    cadgeom::Model m = load("bentApex");
    REQUIRE(m.ok());
    // (At 0.35 rad: at the 10-degree default one round's refinement asks a ring segment split, the mesh as good.)
    PartOptions o = options(d, 0.26);
    o.minAngle = 0.35;
    PartMesher pm(m, o);
    const FaceMesh& fm = pm.face(0);
    REQUIRE(fm.status == cadgeom::Status::ok);
    cadgeom::Status st;
    std::unique_ptr<cadgeom::Surface> s = closedSurface(m, cadgeom::Tolerances(m), 0, st);
    const cadgeom::SurfaceDomain dom = s->domain();
    int far = 0;
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
      const int32_t* v = &fm.triangles[t];
      Vec3 p[3] = {fm.points[v[0]], fm.points[v[1]], fm.points[v[2]]};
      for (Vec3 q : {(1.0 / 3) * (p[0] + p[1] + p[2]), 0.5 * (p[0] + p[1]), 0.5 * (p[1] + p[2]), 0.5 * (p[2] + p[0])})
        far += cadgeom::invertSurface(*s, q, dom.u, dom.v, 1e-12).distance > d * (1 + 1e-9);
    }
    if (far || fm.ringBlocked || !fm.rejected.empty())
      std::printf("  bentApex at %g: %d points beyond d, %d rounds blocked, %zu refused of %zu\n", d, far,
        fm.ringBlocked, fm.rejected.size(), fm.triangles.size() / 3);
    CHECK_EQ(far, 0);
    CHECK_EQ(fm.ringBlocked, 0);
    CHECK(fm.rejected.empty());
  }  // At 0.01 the ring stays as cut while refinement asks for it split: counted, meshing by meshing
  // (FaceMesh::ringBlocked).
  cadgeom::Model m = load("bentApex");
  PartOptions po = options(0.01, 0.26);
  po.checkDeviation = false;
  PartMesher pm(m, po);
  CHECK(pm.face(0).ringBlocked >= 2);
  CHECK(pm.face(0).ringBlocked <= pm.rounds() + 1);
}

TEST_CASE("a pole inside the fixed coordinate's range: revolvedLineCone's ring on the face's side, up to the apex") {
  // The revolved line's apex is at v = 2 sqrt 2 in an infinite v range, the surface on both sides of it: the ring on
  // the face's side (towards the circle at z = 1), not towards the other nappe. Meshed with the default checks, none
  // refused, every point between z = 1 and the apex, one at it, the area within the deflection's worth of pi sqrt 2.
  cadgeom::Model m = load("revolvedLineCone");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.01, 10 * M_PI / 180));
  const FaceMesh& fm = pm.face(0);
  if (fm.status != cadgeom::Status::ok) std::printf("  revolvedLineCone: %s\n", fm.cause.c_str());
  REQUIRE(fm.status == cadgeom::Status::ok);
  CHECK(fm.rejected.empty());
  double zlo = INFINITY, zhi = -INFINITY, apex = INFINITY, area = 0;
  for (const Vec3& q : fm.points)
    zlo = std::min(zlo, q.z), zhi = std::max(zhi, q.z), apex = std::min(apex, cadgeom::norm(q - Vec3{0, 0, 2}));
  for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
    const Vec3 a = fm.points[fm.triangles[t]], b = fm.points[fm.triangles[t + 1]], c = fm.points[fm.triangles[t + 2]];
    area += 0.5 * cadgeom::norm(cadgeom::cross(b - a, c - a));
  }
  CHECK(zlo > 1 - 1e-9);
  CHECK(zhi < 2 + 1e-9);
  CHECK(apex < 1e-9);
  // (A chordal mesh's area is a little under the surface's: by about d over the perimeter, 2 pi x 0.01.)
  CHECK(area < M_PI * M_SQRT2 + 1e-9);
  CHECK(area > M_PI * M_SQRT2 - 2 * M_PI * 0.01);
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
    // (With no rounds its boundary's coarse spans leave triangles refused away from the pole, some past d: kept here,
    // the pole's fan being what is judged.)
    o.checkDeviation = false;
    PartMesher pm(m, o);
    if (pm.face(0).status != cadgeom::Status::ok) std::printf("  %s: status %d (%s)\n", name, int(pm.face(0).status),
      pm.face(0).cause.c_str());
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

TEST_CASE("a loop of two one-chord edges (a lens whose chords coincide) gets a sample at each edge's middle: meshed, "
  "its area the lens's within the chords' sag") {
  cadgeom::Model m = load("lensPlane");
  REQUIRE(m.ok());
  // (Its arcs a little longer than the face's spacing, its extent, respace would split them anyway: a spacing past
  // them leaves the two chords, as VW #2408's faces were left.)
  PartOptions o = options(0.1, 0.26);
  o.edgeSpacingScale = 4;
  PartMesher pm(m, o);
  const FaceMesh& fm = pm.face(0);
  REQUIRE(fm.status == cadgeom::Status::ok);
  double area = 0;
  for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
    area += 0.5 * cadgeom::norm(cadgeom::cross(fm.points[fm.triangles[t + 1]] - fm.points[fm.triangles[t]],
      fm.points[fm.triangles[t + 2]] - fm.points[fm.triangles[t]]));
  // (Two segments of height 0.02 over a chord of 2: about 4/3 x 2 x 0.02; the mesh's quadrilateral 2 x 0.02.)
  CHECK(area > 0.03);
  CHECK(area < 0.06);
}

namespace {
// A roof's mesh against its ridge (x = 5): triangles across it (corners either side by more than rounding), refused
// ones, turned-over ones (a facet against a corner's normal), and its points on the ridge by their normals' side.
struct RoofCount {
  int across = 0, refused = 0, turned = 0, left = 0, right = 0;
};
RoofCount roofCount(const FaceMesh& fm) {
  RoofCount c;
  c.refused = static_cast<int>(fm.rejected.size());
  for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
    const int32_t* v = &fm.triangles[t];
    bool lo = false, hi = false, turned = false;
    const Vec3 g = cadgeom::cross(fm.points[v[1]] - fm.points[v[0]], fm.points[v[2]] - fm.points[v[0]]);
    for (int k = 0; k < 3; k++) {
      lo = lo || fm.points[v[k]].x < 5 - 1e-9, hi = hi || fm.points[v[k]].x > 5 + 1e-9;
      turned = turned || cadgeom::dot(g, fm.normals[v[k]]) < 0;
    }
    c.across += lo && hi, c.turned += turned;
  }
  for (size_t i = 0; i < fm.points.size(); i++)
    if (std::fabs(fm.points[i].x - 5) <= 1e-9) (fm.normals[i].x < 0 ? c.left : c.right)++;
  return c;
}
}  // namespace

TEST_CASE("creases as constraints: a roof's ridge kept by the mesh, crossed at its sides (an edge sample placed "
  "there before the first meshing, or a vertex at a junction), its points a normal for each side") {
  for (const char* name : {"roof", "roofJunction", "roofJunctionAt"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    PartOptions o = options(0.01, 0.26);
    PartMesher pm(m, o);
    const FaceMesh& fm = pm.face(0);
    if (fm.status != cadgeom::Status::ok) std::printf("  %s: %s\n", name, fm.cause.c_str());
    REQUIRE(fm.status == cadgeom::Status::ok);
    const RoofCount c = roofCount(fm);
    if (c.across || c.refused || c.turned || c.left != c.right || fm.triangles.size() / 3 > 16)
      std::printf("  %s: %zu triangles, %d across, %d refused, %d turned, ridge points %d left %d right\n", name,
        fm.triangles.size() / 3, c.across, c.refused, c.turned, c.left, c.right);
    CHECK_EQ(c.across, 0);
    CHECK_EQ(c.refused, 0);
    CHECK_EQ(c.turned, 0);
    CHECK(c.left >= 2);
    CHECK_EQ(c.left, c.right);
    CHECK(fm.triangles.size() / 3 <= 16u);  // (two planes: nothing to refine)
    // Without: the triangles across the ridge, refused (refinement chasing them to its cap).
    o.creases = false;
    o.failCapped = false;
    o.maxPointsPerFace = 2000;
    PartMesher plain(m, o);
    CHECK(roofCount(plain.face(0)).refused > 0);
  }
}

TEST_CASE("a crease past half the angle is one: roofShallow's ridge turns 12 degrees, under the profile's 15") {
  // (Under the angle but close to it, a triangle across the ridge has no room left for anything else: refined
  // toward it without end.)
  cadgeom::Model m = load("roofShallow");
  PartMesher pm(m, options(0.001, 0.26));
  const FaceMesh& fm = pm.face(0);
  REQUIRE(fm.status == cadgeom::Status::ok);
  const RoofCount c = roofCount(fm);
  CHECK_EQ(c.across, 0);
  CHECK(c.left > 0);
  CHECK_EQ(c.left, c.right);
}

TEST_CASE("creases crossing, and one curved in 3D: the hip roof's two ridges share their crossing; the arched "
  "roof's ridge sampled as an edge is (none asked split), and 4 times coarser (edgeSpacingScale) split in the rounds") {
  {
    cadgeom::Model m = load("roofCross");
    PartMesher pm(m, options(0.01, 0.26));
    const FaceMesh& fm = pm.face(0);
    if (fm.status != cadgeom::Status::ok) std::printf("  roofCross: %s\n", fm.cause.c_str());
    REQUIRE(fm.status == cadgeom::Status::ok);
    // (Each ridge a crease only where its jump passes half the angle: they fade toward the sides, flat there.)
    int onU = 0, onV = 0, centre = 0;
    for (const Vec3& p : fm.points) {
      onU += std::fabs(p.x - 5) <= 1e-9 && std::fabs(p.y - 4) > 1e-9;
      onV += std::fabs(p.y - 4) <= 1e-9 && std::fabs(p.x - 5) > 1e-9;
      centre += std::fabs(p.x - 5) <= 1e-9 && std::fabs(p.y - 4) <= 1e-9;
    }
    CHECK(onU > 0);
    CHECK(onV > 0);
    CHECK(centre >= 2);  // (the crossing: one point, a copy per side)
    CHECK(fm.rejected.empty());
  }
  for (double scale : {1.0, 4.0}) {
    cadgeom::Model m = load("roofArched");
    PartOptions o = options(0.01, 0.26);
    o.edgeSpacingScale = scale;
    PartMesher pm(m, o);
    const FaceMesh& fm = pm.face(0);
    if (fm.status != cadgeom::Status::ok) std::printf("  roofArched: %s\n", fm.cause.c_str());
    REQUIRE(fm.status == cadgeom::Status::ok);
    const RoofCount c = roofCount(fm);
    if (c.across || c.refused || fm.splitsWanted || (scale == 1) != (pm.rounds() == 0))
      std::printf("  roofArched x %g: %zu triangles, %d across, %d refused, %d rounds, ridge points %d\n", scale,
        fm.triangles.size() / 3, c.across, c.refused, pm.rounds(), c.left);
    CHECK_EQ(c.across, 0);
    CHECK_EQ(c.refused, 0);
    CHECK_EQ(fm.splitsWanted, 0);
    if (scale == 1) CHECK_EQ(pm.rounds(), 0);
    else CHECK(pm.rounds() > 0);
  }
}

TEST_CASE("inexact boundaries, as within a coarse tolerance: a crease's end at a corner the loop reaches along the "
  "ridge (roofNotch: its sample found by its point, the loop labelling it the edge before); an end whose sample's "
  "(u, v) is off the line (roofBent's bowed p-curves, the part's uncertainty 0.05 mm: put on it)") {
  {
    cadgeom::Model m = load("roofNotch");
    PartMesher pm(m, options(0.01, 0.26));
    const FaceMesh& fm = pm.face(0);
    if (fm.status != cadgeom::Status::ok) std::printf("  roofNotch: %s\n", fm.cause.c_str());
    REQUIRE(fm.status == cadgeom::Status::ok);
    const RoofCount c = roofCount(fm);
    CHECK_EQ(c.across, 0);
    CHECK_EQ(c.refused, 0);
  }
  {
    const tessfixtures::Model* t = tessfixtures::model("roofBent");
    REQUIRE(t);
    std::vector<uint8_t> b(t->data, t->data + t->size);
    cadgeom::Model m(b.data(), b.size());
    const_cast<double*>(m.f64(CBR_PART_UNCERTAINTY))[0] = 0.05;
    PartMesher pm(m, options(0.01, 0.26));
    const FaceMesh& fm = pm.face(0);
    if (fm.status != cadgeom::Status::ok) std::printf("  roofBent: %s\n", fm.cause.c_str());
    REQUIRE(fm.status == cadgeom::Status::ok);
    const RoofCount c = roofCount(fm);
    CHECK_EQ(c.turned, 0);
    CHECK_EQ(c.refused, 0);
  }
}

TEST_CASE("a crease within the face's tolerance of its edge (roofNear's ridge 0.2 mm from it, the part's "
  "uncertainty 0.5 mm): a constraint still, the strip beyond meshed") {
  const tessfixtures::Model* t = tessfixtures::model("roofNear");
  REQUIRE(t);
  std::vector<uint8_t> b(t->data, t->data + t->size);
  cadgeom::Model m(b.data(), b.size());
  const_cast<double*>(m.f64(CBR_PART_UNCERTAINTY))[0] = 0.5;
  PartMesher pm(m, options(0.01, 0.26));
  const FaceMesh& fm = pm.face(0);
  if (fm.status != cadgeom::Status::ok) std::printf("  roofNear: %s\n", fm.cause.c_str());
  REQUIRE(fm.status == cadgeom::Status::ok);
  const RoofCount c = roofCount(fm);
  CHECK_EQ(c.across, 0);
  CHECK_EQ(c.refused, 0);
  CHECK(c.right > 0);
}

TEST_CASE("a face's side on a C0 line of a surface going on past it (roofBeyond ends at the ridge): its normals "
  "there from inside") {
  cadgeom::Model m = load("roofBeyond");
  PartMesher pm(m, options(0.01, 0.26));
  const FaceMesh& fm = pm.face(0);
  if (fm.status != cadgeom::Status::ok) std::printf("  roofBeyond: %s\n", fm.cause.c_str());
  REQUIRE(fm.status == cadgeom::Status::ok);
  const RoofCount c = roofCount(fm);
  CHECK(c.left > 0);
  CHECK_EQ(c.right, 0);
  CHECK_EQ(c.turned, 0);
  CHECK_EQ(c.refused, 0);
}

TEST_CASE("countAngles: each face's triangles under minAngle, as counted on the mesh itself in 3D on planes (where "
  "the metric is uniform), by angle, their area; the same mesh") {
  // (On a plane the criteria's metric is isotropic and (u, v) an isometry: the metric's angles are the 3D ones.)
  // (And with a coarse part uncertainty, so short spans are frozen: thin triangles on them.)
  int faces = 0, thin = 0, nearAngle = 0, onFrozenAll = 0, floorAll = 0;
  struct Case {
    const char* name;
    double uncertainty, angle;
  };
  for (const Case c : {Case{"cuspPocket", 0, 0.4}, Case{"cube", 0, 0.4}, Case{"flowerHole", 0, 0.4},
         Case{"cuspPocket", 0.1, 0.3}}) {
    const tessfixtures::Model* t = tessfixtures::model(c.name);
    const fixtures::Model* fx = t ? nullptr : fixtures::model(c.name);
    std::vector<uint8_t> bytes(t ? t->data : fx->data, (t ? t->data : fx->data) + (t ? t->size : fx->size));
    cadgeom::Model m(bytes.data(), bytes.size());
    REQUIRE(m.ok());
    if (c.uncertainty > 0) const_cast<double*>(m.f64(CBR_PART_UNCERTAINTY))[0] = c.uncertainty;
    const char* name = c.name;
    PartOptions o = options(0.01, 0.26), plain = o;
    o.minAngle = plain.minAngle = c.angle;
    o.countAngles = true;
    PartMesher a(m, o), b(m, plain);
    // The edges' samples, and their spans within the refinement floor (frozen), by 3D point.
    std::set<std::array<double, 3>> onEdge;
    std::set<std::pair<std::array<double, 3>, std::array<double, 3>>> frozen;
    const double floor = refinementFloor(cadgeom::Tolerances(m).part(), o.d.linear);
    auto key3 = [](Vec3 p) { return std::array<double, 3>{p.x, p.y, p.z}; };
    for (int e = 0; e < a.edges().edgeCount(); e++) {
      const std::vector<Vec3>& q = a.edges().edge(e).points;
      for (size_t j = 0; j < q.size(); j++) {
        onEdge.insert(key3(q[j]));
        if (j + 1 < q.size() && cadgeom::norm(q[j + 1] - q[j]) <= floor)
          frozen.insert({key3(q[j]), key3(q[j + 1])}), frozen.insert({key3(q[j + 1]), key3(q[j])});
      }
    }
    for (int f = 0; f < m.faces(); f++) {
      const FaceMesh &x = a.face(f), &y = b.face(f);
      CHECK(x.triangles == y.triangles);
      CHECK_EQ(y.thin, 0);
      if (x.status != cadgeom::Status::ok || m.surfaceKind(m.faceSurface(f)) != CBR_SURFACE_PLANE) continue;
      faces++, thin += x.thin;
      int count = 0, bins[kThinBins] = {}, boundary = 0, onFrozen = 0, atAngle = 0, floorSure = 0, floorMaybe = 0;
      double area = 0, atArea = 0;
      for (size_t t = 0; t + 2 < x.triangles.size(); t += 3) {
        const Vec3 p[3] = {x.points[x.triangles[t]], x.points[x.triangles[t + 1]], x.points[x.triangles[t + 2]]};
        double least = M_PI;
        for (int k = 0; k < 3; k++) {
          const Vec3 u = p[(k + 1) % 3] - p[k], v = p[(k + 2) % 3] - p[k];
          least = std::min(least, std::atan2(cadgeom::norm(cadgeom::cross(u, v)), cadgeom::dot(u, v)));
        }
        // (At the angle within rounding, as off-centres place them: the mesher's arcsine of a sine against this
        // atan2, either way; their area too.)
        if (std::fabs(least - c.angle) <= 1e-9 * c.angle)
          atAngle++, atArea += 0.5 * cadgeom::norm(cadgeom::cross(p[1] - p[0], p[2] - p[0]));
        if (!(least < c.angle)) continue;
        nearAngle += least >= 0.9 * c.angle;
        boundary += onEdge.count(key3(p[0])) && onEdge.count(key3(p[1])) && onEdge.count(key3(p[2]));
        // (Within the floor: surely where its box's diagonal is, its longest side within floor / sqrt 2 (a plane's
        // box over the triangle in its own plane); surely not where a side is past it.)
        const double longest = std::max({cadgeom::norm(p[1] - p[0]), cadgeom::norm(p[2] - p[1]),
          cadgeom::norm(p[0] - p[2])});
        floorSure += longest <= floor / std::sqrt(2.0), floorMaybe += longest <= floor;
        bool fz = false;
        for (int k = 0; k < 3; k++) fz = fz || frozen.count({key3(p[k]), key3(p[(k + 1) % 3])});
        onFrozen += fz;
        const double deg = least * 180 / M_PI;
        count++, bins[deg < 1 ? 0 : deg < 2 ? 1 : deg < 5 ? 2 : deg < 8 ? 3 : deg < 10 ? 4 : 5]++;
        area += 0.5 * cadgeom::norm(cadgeom::cross(p[1] - p[0], p[2] - p[0]));
      }
      if (std::abs(count - x.thin) > atAngle)
        std::printf("  %s face %d: %d under the angle, counted %d, %d at it\n", name, f, count, x.thin, atAngle);
      CHECK(std::abs(x.thin - count) <= atAngle);
      for (int k = 0; k + 1 < kThinBins; k++) CHECK_EQ(x.thinByAngle[k], bins[k]);  // (the angles at most 0.4 rad)
      CHECK(std::abs(x.thinByAngle[kThinBins - 1] - bins[kThinBins - 1]) <= atAngle);
      CHECK(std::fabs(x.thinArea - area) <= atArea + 1e-9 * (1 + area));
      CHECK_EQ(x.thinBoundary, boundary);
      CHECK_EQ(x.thinFrozen, onFrozen);
      onFrozenAll += onFrozen;
      CHECK(x.thinFloor >= floorSure);
      CHECK(x.thinFloor <= floorMaybe);
      floorAll += floorSure;
    }
  }
  CHECK(faces > 0);
  CHECK(thin > 0);
  CHECK(nearAngle > 0);  // (some just under the angle: the threshold itself checked)
  CHECK(onFrozenAll > 0);
  CHECK(floorAll > 0);
  if (!nearAngle || !onFrozenAll) std::printf("  countAngles: %d near the angle, %d on frozen spans\n", nearAngle,
    onFrozenAll);
}

TEST_CASE("an edge far off its face's surface: meshed where its feet allow, the distance a deviation defect past the "
  "limits (keepDefects), failed without; feet folding back on themselves, beyond repair; respace's uses said") {
  // edgeBulge: a 10 mm square on z = 0 whose top side is an arc over it 0.5 high at its middle (past 100 x the
  // tolerance and 10 x d at 0.01, far off by the projection's rule), with no p-curve or the line under it: placed on
  // its feet, the side; its face's triangles follow it up to 0.5 off the plane, 50 x max(d, tol).
  for (const char* name : {"edgeBulge", "edgeBulgePcurve"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    PartMesher pm(m, options(0.01, 0.26));
    const FaceMesh& fm = pm.face(0);
    REQUIRE(fm.status == cadgeom::Status::ok);
    CHECK(std::fabs(fm.offSurface - 0.5) < 1e-6);
    CHECK_EQ(fm.offSurfaceWithin, 0.01);
    CHECK_EQ(fm.offSurfaceEdge, 0);
    CHECK(std::fabs(fm.defectDeviation - 50) < 1e-4);
    CHECK(fm.defectPastLimits);
    double top = 0;
    for (const Vec3& p : fm.points) top = std::fmax(top, p.z);
    CHECK(top > 0.45);
    CHECK(top <= 0.5 + 1e-9);
    // (Without a p-curve, its use placed on the projection's feet, not by inversion sample by sample; the given one
    // misses the arc's points by more than 100 x the tolerance, so it only seeds inversion. The arc's samples as the
    // edge's own sampling made them: a far-off edge isn't respaced or split.)
    if (std::strcmp(name, "edgeBulge") == 0) CHECK(pm.edges().coedge(2).fromPcurve);
    EdgeOptions eo;
    eo.deflection = 0.01, eo.angle = 0.26;
    EdgeMesh first(m, eo);
    CHECK_EQ(pm.edges().edge(0).points.size(), first.edge(0).points.size());
    PartOptions strict = options(0.01, 0.26);
    strict.keepDefects = false;
    PartMesher sm(m, strict);
    CHECK(sm.face(0).status == cadgeom::Status::invalidModel);
    CHECK_EQ(sm.face(0).cause, std::string("an edge (#0) 0.5 mm off its surface, 50 x max(d, tol)"));
    CHECK(sm.face(0).triangles.empty());
  }
  // edgeFarOff: the arc 50 up instead, its feet running out past the square's corners along the side and back: a
  // loop with no area, no mesh at all (its distance recorded all the same).
  for (const char* name : {"edgeFarOff", "edgeFarOffPcurve"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    PartMesher pm(m, options(0.01, 0.26));
    const FaceMesh& fm = pm.face(0);
    CHECK(fm.status == cadgeom::Status::invalidModel);
    CHECK(fm.cause.rfind("its boundary in (u, v) crossing itself", 0) == 0);
    CHECK(std::fabs(fm.offSurface - 50) < 1e-6);
  }
  {
    // Edges coarser than the faces want: respace splits them, each use placed again reported with its face.
    cadgeom::Model m = load("spheres");
    PartOptions o = options(0.01, 0.26);
    o.edgeSpacingScale = 0.25;
    bool criteria = false;
    int named = 0;
    o.progress = [&](const PartProgress& p) {
      if (p.phase == PartProgress::criteria) criteria = true;
      else if (criteria && p.phase == PartProgress::edges && p.row >= 0 && p.row < m.faces()) named++;
    };
    PartMesher pm(m, o);
    CHECK(named > 0);
  }
}

TEST_CASE("an edge healing grew past repair: its face meshed, the grown tolerance its distance, judged by the one "
  "healing started from, not the face's grown one; its samples as first made") {
  // edgeBulgeGrown: edgeBulge with the arc's and the face's tolerances 0.6 (covering its 0.5); bulgeEdgePast has
  // healing grow the arc there from 1e-5, past repair: 0.6 over max(0.01, 1e-5), 60 x. Without the analysis, the
  // arc within the face's 0.6: no defect.
  const tessfixtures::Analysis* a = tessfixtures::analysis("bulgeEdgePast");
  REQUIRE(a);
  cadgeom::Model m = load(a->model);
  REQUIRE(m.ok());
  PartOptions o = options(0.01, 0.26);
  PartMesher plain(m, o);
  REQUIRE(plain.face(0).status == cadgeom::Status::ok);
  CHECK_EQ(plain.face(0).defectDeviation, 0.0);
  CHECK(!plain.face(0).defectPastLimits);
  o.analysis = a->data, o.analysisSize = a->size;
  PartMesher pm(m, o);
  const FaceMesh& fm = pm.face(0);
  REQUIRE(fm.status == cadgeom::Status::ok);
  CHECK_EQ(fm.offSurface, 0.6);
  CHECK_EQ(fm.offSurfaceWithin, 0.01);
  CHECK_EQ(fm.offSurfaceEdge, 0);
  CHECK(std::fabs(fm.defectDeviation - 60) < 1e-9);
  CHECK(fm.defectPastLimits);
  EdgeOptions eo;
  eo.deflection = 0.01, eo.angle = 0.26;
  eo.analysis = a->data, eo.analysisSize = a->size;
  EdgeMesh first(m, eo);
  CHECK_EQ(pm.edges().edge(0).points.size(), first.edge(0).points.size());
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

TEST_CASE("an edge ending just past a pole on the far meridian (poleDipFar, poleDipFarLoose): the face meshed, its "
          "area poleDip's but for the bit past the pole") {
  // (edges_test checks their boundaries: each use's end at the pole on the pole line. Off it, poleDipFarLoose's
  // boundary went through its own point, LMP1 #172878 face #1063482's. The face is the sphere but for poleDip's lune,
  // its vertex moved past the pole by at most 2e-3.)
  auto area = [](const FaceMesh& fm) {
    double a = 0;
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
      a += 0.5 * cadgeom::norm(cadgeom::cross(fm.points[fm.triangles[t + 1]] - fm.points[fm.triangles[t]],
        fm.points[fm.triangles[t + 2]] - fm.points[fm.triangles[t]]));
    return a;
  };
  const cadgeom::Model dip = load("poleDip");
  PartMesher ref(dip, options(0.1, 0.26));
  REQUIRE(ref.face(0).status == cadgeom::Status::ok);
  const double want = area(ref.face(0));
  for (const char* name : {"poleDipFar", "poleDipFarLoose"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    PartMesher pm(m, options(0.1, 0.26));
    const FaceMesh& fm = pm.face(0);
    if (fm.status != cadgeom::Status::ok) std::printf("    %s\n", fm.cause.c_str());
    REQUIRE(fm.status == cadgeom::Status::ok);
    CHECK(std::fabs(area(fm) - want) <= 0.01);
  }
}

TEST_CASE("a face whose edge loops are all holes (none winding) is its surface's natural extent less them: "
  "sphereBelt's belt between two circles meshed, not its caps; facing as its sense says; the even one too") {
  struct Case {
    const char* name;
    double lo, hi;
    bool outward;
  };
  for (Case c : {Case{"sphereBelt", -1, 3, true}, Case{"sphereBeltInward", -1, 3, false},
         Case{"sphereBeltEven", -2, 3, true}, Case{"sphereBeltEvenInward", -2, 3, false}}) {
    cadgeom::Model m = load(c.name);
    REQUIRE(m.ok());
    PartMesher pm(m, options(0.05, 0.26));
    const FaceMesh& fm = pm.face(0);
    if (fm.status != cadgeom::Status::ok) std::printf("  %s: %s\n", c.name, fm.cause.c_str());
    REQUIRE(fm.status == cadgeom::Status::ok);
    CHECK(fm.holesOnly);
    double area = 0;
    int outside = 0, against = 0;
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
      const Vec3 p = fm.points[fm.triangles[t]], q = fm.points[fm.triangles[t + 1]], r = fm.points[fm.triangles[t + 2]];
      const Vec3 g = cadgeom::cross(q - p, r - p), mid = (1.0 / 3) * (p + q + r);
      area += 0.5 * cadgeom::norm(g);
      outside += mid.x < c.lo - 0.05 || mid.x > c.hi + 0.05;
      against += (cadgeom::dot(g, mid) > 0) != c.outward;
    }
    const double want = 2 * M_PI * 5 * (c.hi - c.lo);
    if (outside || against || std::fabs(area - want) > 0.01 * want)
      std::printf("  %s: area %.3f (the belt's %.3f), %d triangles outside it, %d against its sense\n", c.name, area,
        want, outside, against);
    CHECK_EQ(outside, 0);
    CHECK_EQ(against, 0);
    CHECK(std::fabs(area - want) <= 0.01 * want);
  }
}

TEST_CASE("a face whose edge loops are all holes on a surface with no natural extent (a plane) fails, said so, "
  "rather than meshing its holes; a face with an outer loop isn't holesOnly") {
  cadgeom::Model m = load("planeHoleOnly");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.05, 0.26));
  const FaceMesh& fm = pm.face(0);
  CHECK(fm.status == cadgeom::Status::unsupported);
  CHECK(fm.cause.find("edge loops all holes") != std::string::npos);
  CHECK(fm.triangles.empty());
  cadgeom::Model band = load("band");
  REQUIRE(band.ok());
  PartMesher pb(band, options(0.05, 0.26));
  for (int f = 0; f < band.faces(); f++) CHECK(!pb.face(f).holesOnly);
}

TEST_CASE("flipTurned (the default): a triangle turned as shipped flipped with its neighbour across an interior edge, "
  "both new ones within the criteria and facing the surface: cornerFoldTight at 1 meshed, failing without it") {
  // (Its corner's point 0.0085 off its (u, v), past the face's tolerance: the fold not repaired, the ear there
  // turned in 3D though accepted in (u, v); a flip across its interior edge leaves two triangles facing the plane.)
  for (const char* name : {"cornerFoldTight", "cornerFoldTightAgainst"}) {
    const bool against = name[15] == 'A';
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    PartOptions on = options(1, 0.26), off = on;
    off.flipTurned = false;
    off.keepDefects = false;  // (its one turned triangle a defect it would be kept with)
    PartMesher a(m, on), b(m, off);
    const FaceMesh& fm = a.face(0);
    REQUIRE(fm.status == cadgeom::Status::ok);
    CHECK(fm.turnedFlips >= 1);
    int facing = 0;
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
      const Vec3 p = fm.points[fm.triangles[t]], q = fm.points[fm.triangles[t + 1]], r = fm.points[fm.triangles[t + 2]];
      facing += (cadgeom::cross(q - p, r - p).z <= 0) != against;
    }
    CHECK_EQ(facing, 0);
    // Its boundary's segments all still in the mesh: none flipped away.
    const FaceBoundary fb = a.edges().face(0);
    std::set<std::pair<Vec3, Vec3>, bool (*)(const std::pair<Vec3, Vec3>&, const std::pair<Vec3, Vec3>&)> edges(
      [](const std::pair<Vec3, Vec3>& x, const std::pair<Vec3, Vec3>& y) {
        return std::tie(x.first.x, x.first.y, x.first.z, x.second.x, x.second.y, x.second.z) <
          std::tie(y.first.x, y.first.y, y.first.z, y.second.x, y.second.y, y.second.z);
      });
    auto both = [&](Vec3 p, Vec3 q) { edges.insert({p, q}), edges.insert({q, p}); };
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
      for (int k = 0; k < 3; k++) both(fm.points[fm.triangles[t + k]], fm.points[fm.triangles[t + (k + 1) % 3]]);
    int missing = 0;
    for (const auto& loop : fb.loops)
      for (size_t k = 0; k < loop.size(); k++)
        missing += !edges.count({loop[k].point, loop[(k + 1) % loop.size()].point});
    CHECK_EQ(missing, 0);
    CHECK(b.face(0).status == cadgeom::Status::noConvergence);
    CHECK_EQ(b.face(0).turnedFlips, 0);
  }
}

TEST_CASE("countExpected: a face's triangles as its own size metric expects them, the band's in closed form; none "
  "without it, the mesh the same") {
  // (The band, radius 2 and 5 high: across its axis the size sqrt(6 d / k) with k = 1 / 2, along it the face's
  // extent, the diagonal of its box (4, 4, 5); its area 2 pi 2 x 5 in the metric's units over an equilateral
  // triangle's sqrt(3) / 4.)
  cadgeom::Model m = load("band");
  REQUIRE(m.ok());
  PartOptions on = options(0.001, 0.26), off = on;
  on.countExpected = true;
  PartMesher a(m, on), b(m, off);
  const double across = std::sqrt(6 * 0.001 * 2), along = std::sqrt(16.0 + 16.0 + 25.0);
  const double want = 2 * M_PI * 2 * 5 / (across * along) / (std::sqrt(3.0) / 4);
  const double got = a.face(0).expectedTriangles;
  if (!(std::fabs(got - want) <= 0.05 * want)) std::printf("  band: expected %.1f, closed form %.1f\n", got, want);
  CHECK(std::fabs(got - want) <= 0.05 * want);
  CHECK_EQ(b.face(0).expectedTriangles, 0.0);
  CHECK(a.face(0).triangles == b.face(0).triangles);
  // A parallelogram, flat: its size the face's extent everywhere, its metric in (u, v) the first fundamental form
  // over it squared, cross term and all (its sides 60 degrees apart): its area over the extent squared, over
  // sqrt(3) / 4. (Without the cross term, 1 / sin 60 degrees as many.)
  cadgeom::Model s = load("skewPatch");
  REQUIRE(s.ok());
  PartMesher ps(s, on);
  const double h = std::hypot(15.0, 10 * std::sin(M_PI / 3)), flat = 10 * 10 * std::sin(M_PI / 3) / (h * h);
  const double skewWant = flat / (std::sqrt(3.0) / 4), skewGot = ps.face(0).expectedTriangles;
  if (!(std::fabs(skewGot - skewWant) <= 0.05 * skewWant))
    std::printf("  skewPatch: expected %.4f, closed form %.4f\n", skewGot, skewWant);
  CHECK(std::fabs(skewGot - skewWant) <= 0.05 * skewWant);
}

TEST_CASE("a collapsed row of poles a fitting's noise apart is a pole to the size metric's grid: the face expects as "
  "many triangles as with the row exact") {
  // (bsplineBallNoisy: the unit ball with its pole rows' poles up to 3e-6 off, within its tolerance, so still poles,
  // but |S_v| there about that, not 0, and the curvature across the row some 1e4. Taken from the row, the grid's
  // sizes, graded over a cell, made the face expect many times as many triangles, and refinement run away near it.
  // The counts from a mesher stopped early (its point cap small, no split rounds), so they fail fast.)
  // (bsplineBallV: the same with u and v swapped, its pole rows v = 0 and 2.)
  for (const char* name : {"bsplineBall", "bsplineBallV"}) {
    const std::string noisyName = std::string(name) == "bsplineBall" ? "bsplineBallNoisy" : "bsplineBallNoisyV";
    cadgeom::Model exact = load(name), noisy = load(noisyName.c_str());
    REQUIRE(exact.ok() && noisy.ok());
    PartOptions o = options(0.1, 0.26);
    o.maxPointsPerFace = 2000, o.maxSplitRounds = 0;
    PartMesher a(exact, o), b(noisy, o);
    const double want = a.face(0).capExpected, got = b.face(0).capExpected;
    if (!(std::fabs(got - want) <= 0.1 * want))
      std::printf("  %s: expected %.1f, exact %.1f\n", noisyName.c_str(), got, want);
    CHECK(want > 0);
    REQUIRE(std::fabs(got - want) <= 0.1 * want);
    // And by default it meshes as the exact ball does.
    PartMesher c(exact, options(0.1, 0.26)), e(noisy, options(0.1, 0.26));
    CHECK(e.face(0).status == cadgeom::Status::ok);
    CHECK_EQ(e.face(0).cap, 200000.0);
    const double n = e.face(0).triangles.size(), m = c.face(0).triangles.size();
    if (!(std::fabs(n - m) <= 0.2 * m)) std::printf("  %s: %.0f triangles, exact %.0f\n", noisyName.c_str(), n, m);
    CHECK(std::fabs(n - m) <= 0.2 * m);
  }
}

TEST_CASE("A refused triangle whose circumcentre lands at a vertex already there is broken at its centroid") {
  // (sineSheet's 40 mm square at 0.1 mm: refinement over its regular grid puts refused triangles' circumcentres on
  // vertices there; left final, 37 of them stayed refused, the L 200 mm sheet's past its deflection.)
  cadgeom::Model m = load("sineSheet40");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 0.26));
  CHECK(pm.face(0).status == cadgeom::Status::ok);
  CHECK_EQ(pm.face(0).rejected.size(), size_t(0));
}

TEST_CASE("a sphere face bounded by one plain circle is the side its loop's direction and the face's sense say, not "
  "the smaller, where it's oriented as its neighbour: ballWithFlat's ball less its cap; ballWithFlatCap's cap; "
  "with no neighbour or one the other way, its loop's inside") {
  struct Case {
    const char* name;
    bool below;
    double area;
  };
  const double h = 1.2, capArea = 2 * M_PI * 2 * (2 - h), ball = 4 * M_PI * 4 - capArea;
  for (Case c : {Case{"ballWithFlat", true, ball}, Case{"ballWithFlatCap", false, capArea}}) {
    cadgeom::Model m = load(c.name);
    REQUIRE(m.ok());
    PartMesher pm(m, options(0.01, 0.26));
    const FaceMesh& fm = pm.face(0);
    if (fm.status != cadgeom::Status::ok) std::printf("  %s: %s\n", c.name, fm.cause.c_str());
    REQUIRE(fm.status == cadgeom::Status::ok);
    double area = 0;
    int wrongSide = 0;
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
      const Vec3 p = fm.points[fm.triangles[t]], q = fm.points[fm.triangles[t + 1]], r = fm.points[fm.triangles[t + 2]];
      area += 0.5 * cadgeom::norm(cadgeom::cross(q - p, r - p));
      wrongSide += ((p.x + q.x + r.x) / 3 < h) != c.below;
    }
    if (wrongSide || std::fabs(area - c.area) > 0.01 * c.area)
      std::printf("  %s: area %.3f (want %.3f), %d triangles on the wrong side of the flat\n", c.name, area, c.area,
        wrongSide);
    CHECK_EQ(wrongSide, 0);
    CHECK(std::fabs(area - c.area) <= 0.01 * c.area);
    CHECK(pm.face(1).status == cadgeom::Status::ok);
  }
  // Its orientation not checked against a neighbour's (the flat using the circle the same way, no flat, or the cap a
  // face of the same sphere its sense reversed, their normals opposite where they meet smoothly): the loop as it has
  // it, the cap beyond the flat, as before.
  for (const char* name : {"ballFlatSameWay", "ballAlone", "ballFlippedCap"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    PartMesher pm(m, options(0.01, 0.26));
    const FaceMesh& fm = pm.face(0);
    double area = 0;
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3) {
      const Vec3 p = fm.points[fm.triangles[t]], q = fm.points[fm.triangles[t + 1]], r = fm.points[fm.triangles[t + 2]];
      area += 0.5 * cadgeom::norm(cadgeom::cross(q - p, r - p));
    }
    if (std::fabs(area - capArea) > 0.01 * capArea)
      std::printf("  %s: area %.3f (the cap %.3f)\n", name, area, capArea);
    CHECK(fm.status == cadgeom::Status::ok);
    CHECK(std::fabs(area - capArea) <= 0.01 * capArea);
  }
}


TEST_CASE("maxEdge: no triangle edge on a long plate or a long band past it; partSize the box's diagonal, a whole "
  "sphere's from its surface") {
  auto load = [](const char* name) {
    const tessfixtures::Model* t = tessfixtures::model(name);
    return t ? std::vector<uint8_t>(t->data, t->data + t->size) : std::vector<uint8_t>{};
  };
  auto longest = [](const FaceMesh& fm) {
    double l = 0;
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
      for (int k = 0; k < 3; k++)
        l = std::max(l, norm(fm.points[fm.triangles[t + (k + 1) % 3]] - fm.points[fm.triangles[t + k]]));
    return l;
  };
  // (Off, each face's longest edge is far past the limits tested: the plate's two triangles' diagonal, the band's
  // straight lines along it. The sweep's normal inward, its principal curvatures the other way round.)
  for (auto [name, size, limit] : {std::tuple{"longPlate", std::hypot(100.0, 4.0), 3.0},
         std::tuple{"longBand", std::sqrt(4 * 4 + 4 * 4 + 100.0 * 100), 1.5},
         std::tuple{"longSweep", std::sqrt(4 * 4 + 4 * 4 + 100.0 * 100), 1.5}}) {
    std::vector<uint8_t> b = load(name);
    REQUIRE(!b.empty());
    const cadgeom::Model m(b.data(), b.size());
    CHECK(std::fabs(partSize(m) - size) <= 1e-9 * size);
    PartMesher off(m, options(0.1, 0.26));
    REQUIRE(off.face(0).status == cadgeom::Status::ok);
    CHECK(longest(off.face(0)) > 4 * limit);
    PartOptions o = options(0.1, 0.26);
    o.d.maxEdge = limit;
    PartMesher pm(m, o);
    const FaceMesh& fm = pm.face(0);
    if (fm.status != cadgeom::Status::ok) std::printf("  %s: %s\n", name, fm.cause.c_str());
    REQUIRE(fm.status == cadgeom::Status::ok);
    const double l = longest(fm);
    if (!(l <= limit * (1 + 1e-9))) std::printf("  %s: longest edge %.6g, limit %.6g\n", name, l, limit);
    CHECK(l <= limit * (1 + 1e-9));
    // (Not much finer than it asks: the longest edge within a factor 2 of it.)
    CHECK(l > 0.5 * limit);
  }
  {
    std::vector<uint8_t> b = load("wholeSphereVertex");
    REQUIRE(!b.empty());
    const cadgeom::Model m(b.data(), b.size());
    CHECK(std::fabs(partSize(m) - 2 * std::sqrt(3.0)) <= 1e-9);
  }
  // A lune across the seam, its (u, v) box its own patch, not the rest of the sphere, a hole's feet past the seam
  // from its outer loop's joined to it; a half disc's arc without a range, its vertices' parameters bounding it, not
  // its whole circle; a quarter disc's, its end's parameter (0) taken a period on; a torus's band the wider way round
  // between its circles, from the one it lies above to the one it lies below (the narrower way, its inside, sqrt 53).
  for (auto [name, size] : {std::pair{"luneAcrossSeam", std::sqrt(1 + 4 * std::pow(std::sin(M_PI / 8), 2) + 4)},
         std::pair{"luneHoleAcrossSeam", std::sqrt(1 + 4 * std::pow(std::sin(M_PI / 8), 2) + 4)},
         std::pair{"halfDisc", std::sqrt(5.0)}, std::pair{"quarterDisc", std::sqrt(2.0)},
         std::pair{"torusOuterBand", std::sqrt(132.0)}}) {
    std::vector<uint8_t> b = load(name);
    REQUIRE(!b.empty());
    const cadgeom::Model m(b.data(), b.size());
    const double got = partSize(m);
    if (!(std::fabs(got - size) <= 1e-9 * size))
      std::printf("  %s: partSize %.12g, expected %.12g\n", name, got, size);
    CHECK(std::fabs(got - size) <= 1e-9 * size);
  }
  {
    // (Its lines' edges without ranges: their vertices bound them.)
    std::vector<uint8_t> b = load("wrongSense");
    REQUIRE(!b.empty());
    const cadgeom::Model m(b.data(), b.size());
    CHECK(std::fabs(partSize(m) - std::sqrt(2.0)) <= 1e-12);
  }
  // A cap's box up to its pole, which its circle doesn't reach (from the edge's points inverted, or its p-curve); the
  // rest of the sphere (the face against its surface, or its use reversed), down to the other pole and out to the
  // equator (within 1 %: the grid's rows miss the equator).
  const double r = std::sqrt(0.5);
  for (auto [name, size, within] : {std::tuple{"cap", std::sqrt(8 * r * r + (1 - r) * (1 - r)), 1e-9},
         std::tuple{"capPcurve", std::sqrt(8 * r * r + (1 - r) * (1 - r)), 1e-9},
         std::tuple{"capRest", std::sqrt(8 + (1 + r) * (1 + r)), 0.01},
         std::tuple{"capBelow", std::sqrt(8 + (1 + r) * (1 + r)), 0.01}}) {
    std::vector<uint8_t> b = load(name);
    REQUIRE(!b.empty());
    const cadgeom::Model m(b.data(), b.size());
    const double got = partSize(m);
    if (!(std::fabs(got - size) <= within * size))
      std::printf("  %s: partSize %.12g, expected %.12g\n", name, got, size);
    CHECK(std::fabs(got - size) <= within * size);
  }
}

TEST_CASE("maxEdge: a pole's fan no longer than it, its spokes (the ring's reach) and its ring's chords") {
  // A sphere's cap (its pole clear of the boundary), a whole sphere (an edge through its pole), a cone's apex and a
  // B-spline's: off, the fans' spokes past the limit; with it, no edge at the pole past it, at the edge rules' angle
  // and at a coarse one (the ring's pieces then as long as their spokes, held by the limit alone).
  const double limit = 0.2;
  for (const char* name : {"cap", "wholeSphereVertex", "coneApexLoop", "bsplineApex"})
    for (double angle : {0.26, 1.5}) {
      const tessfixtures::Model* t = tessfixtures::model(name);
      REQUIRE(t);
      std::vector<uint8_t> b(t->data, t->data + t->size);
      const cadgeom::Model m(b.data(), b.size());
      cadgeom::Status st;
      const std::unique_ptr<cadgeom::Surface> s = cadgeom::makeSurface(m, m.faceSurface(0), st);
      REQUIRE(s);
      std::vector<cadgeom::Singularity> sing;
      s->singularities(sing);
      REQUIRE(!sing.empty());
      // The longest edge with an end at a pole (the fans'), and the longest of the ring's (the fans' far sides).
      auto atPole = [&](const FaceMesh& fm, double& ring) {
        double l = 0;
        ring = 0;
        for (size_t i = 0; i + 2 < fm.triangles.size(); i += 3)
          for (int k = 0; k < 3; k++) {
            const Vec3 p = fm.points[fm.triangles[i + k]], q = fm.points[fm.triangles[i + (k + 1) % 3]],
              r = fm.points[fm.triangles[i + (k + 2) % 3]];
            auto pole = [&](Vec3 x) {
              for (const cadgeom::Singularity& g : sing)
                if (g.kind != cadgeom::Singularity::normalVanishes && norm(x - g.point) < 1e-9) return true;
              return false;
            };
            const bool pp = pole(p), qp = pole(q), rp = pole(r);
            if (pp || qp) l = std::max(l, norm(q - p));
            else if (rp) ring = std::max(ring, norm(q - p));
          }
        return l;
      };
      double ring = 0;
      PartMesher off(m, options(0.1, angle));
      REQUIRE(off.face(0).status == cadgeom::Status::ok);
      CHECK(atPole(off.face(0), ring) > 1.4 * limit);
      PartOptions o = options(0.1, angle);
      o.d.maxEdge = limit;
      PartMesher pm(m, o);
      REQUIRE(pm.face(0).status == cadgeom::Status::ok);
      const double l = atPole(pm.face(0), ring);
      if (!(l <= limit * (1 + 1e-9)) || !(ring <= limit * (1 + 1e-9)))
        std::printf("  %s at %g: spoke %.6g, ring chord %.6g, limit %g\n", name, angle, l, ring, limit);
      CHECK(l <= limit * (1 + 1e-9));
      CHECK(ring <= limit * (1 + 1e-9));
      CHECK(l > 0.5 * limit);
    }
}

TEST_CASE("maxEdge: a pole's edges held to it where a ring's crossing is taken to an edge's sample past the ring") {
  // A sphere's cap and a whole sphere, each with an edge through its pole: over a sweep of limits from the deflection
  // (below it the ring's floor rules) some ring crosses an edge just short of one of its samples, which cutRings
  // takes for the crossing (within the refinement floor), past the ring; the edge's span from the pole and the fans'
  // triangles there still within the limit.
  for (const char* name : {"cap", "wholeSphereVertex"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    cadgeom::Status st;
    const std::unique_ptr<cadgeom::Surface> s = cadgeom::makeSurface(m, m.faceSurface(0), st);
    REQUIRE(s);
    std::vector<cadgeom::Singularity> sing;
    s->singularities(sing);
    auto pole = [&](Vec3 x) {
      for (const cadgeom::Singularity& g : sing)
        if (g.kind != cadgeom::Singularity::normalVanishes && norm(x - g.point) < 1e-9) return true;
      return false;
    };
    int past = 0, meshed = 0;
    for (double limit = 0.1001; limit <= 0.6; limit *= 1.01) {
      PartOptions o = options(0.1, 0.26);
      o.d.maxEdge = limit;
      PartMesher pm(m, o);
      const FaceMesh& fm = pm.face(0);
      if (fm.status != cadgeom::Status::ok) continue;
      meshed++;
      double l = 0;
      for (size_t i = 0; i + 2 < fm.triangles.size(); i += 3) {
        bool at = false;
        for (int k = 0; k < 3; k++) at = at || pole(fm.points[fm.triangles[i + k]]);
        if (at)
          for (int k = 0; k < 3; k++)
            l = std::max(l, norm(fm.points[fm.triangles[i + (k + 1) % 3]] - fm.points[fm.triangles[i + k]]));
      }
      if (!(l <= limit * (1 + 1e-9))) {
        past++;
        std::printf("  %s at a limit of %.6g: an edge at the pole %.6g\n", name, limit, l);
      }
    }
    CHECK(meshed == 180);
    CHECK(past == 0);
  }
}

TEST_CASE("PartOptions::expectedOnly: each face's first meshing's point cap count, no triangles, nothing after (a "
  "fan's cap, a creased roof, the cube, a pinched lune)") {
  for (const char* name : {"cap", "roof", "cube", "lunePinch", "wholeSphereVertex"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    PartOptions o;
    o.d.linear = 0.01, o.d.angular = 0.26;
    // (The full run's first meshing: no split rounds, no stretch retries. expectedOnly with them on, as it's used:
    // nothing after the first meshing runs, so none meshes a face again at another stretch.)
    PartOptions e = o;
    e.expectedOnly = true;
    // (Each face meshed once: progress comes at each meshing's start.)
    std::vector<int> meshed(m.faces(), 0);
    e.progress = [&](const PartProgress& p) {
      if (p.phase == PartProgress::meshing && p.row >= 0 && p.row < m.faces()) meshed[p.row]++;
    };
    o.maxSplitRounds = 0, o.retryStretch = 0;
    PartMesher full(m, o);
    PartMesher only(m, e);
    for (int f = 0; f < m.faces(); f++) {
      const FaceMesh &a = full.face(f), &b = only.face(f);
      if (a.capExpected != b.capExpected || !b.triangles.empty())
        std::printf("  %s face %d: expected %.17g (full) %.17g (expectedOnly), %zu triangles, cause %s\n", name, f,
          a.capExpected, b.capExpected, b.triangles.size() / 3, b.cause.c_str());
      CHECK(a.capExpected == b.capExpected);
      CHECK(b.triangles.empty());
      CHECK(meshed[f] <= 1);
      if (b.capExpected > 0) {
        CHECK(!a.triangles.empty());
        CHECK(b.cause == "expected count only (PartOptions::expectedOnly)");
      }
    }
    CHECK(only.rounds() == 0);
  }
}
