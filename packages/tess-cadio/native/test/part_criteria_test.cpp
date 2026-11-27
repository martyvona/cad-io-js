// criteria.h through part.h's faces: the size metric, the deviation bounds and verdicts (belowFloor, deviationBound,
// knot cells and spans), the facet and turn tests on boundary points, needles, crowding, facetAgainst, accept().

#include "part_common.h"

TEST_CASE("the criteria's facet tests on the boundary's own points (setBoundaryPoints): a triangle accepted on the "
  "surface's points refused where a corner's own point turns its facet; its deviation still on the surface's") {
  // (pcurveNear's plane: the triangle (0, 0), (3, 0), (0, 3), its first corner's own point (2.5, 2.5, 0), across the
  // far side: the facet as output faces down. Given the corner's own point on the surface, nothing changes.)
  cadgeom::Model m = load("pcurveNear");
  REQUIRE(m.ok());
  cadgeom::Status st;
  auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
  auto c = makeCriteria(m, 0, *s, cadgeom::Box2{{-3, 3}, {-3, 3}}, Deflections{0.1, 0.26}, st);
  REQUIRE(c);
  const Vec2 t[3] = {{0, 0}, {3, 0}, {0, 3}};
  CHECK(c->accept(t));
  c->setBoundaryPoints({{t[0], Vec3{2.5, 2.5, 0}}});
  CHECK(!c->accept(t));
  c->setBoundaryPoints({{t[0], Vec3{0, 0, 0}}});
  CHECK(c->accept(t));
  // Judged as shipped (setOutputOrigin): corners 6e-8, 5.8e-8 and 5.91e-8 up in v (y), the last above the chord of
  // the first two in double, below it as float32 minus an origin 1 below them (1 + 6e-8 rounds up a unit in the last
  // place, the others down to 1): the facet turned as shipped, refused, though accepted in double, its corners the
  // boundary's (their own points the surface's; with a corner the mesher's, too thin to judge, the next case).
  {
    auto c2 = makeCriteria(m, 0, *s, cadgeom::Box2{{-3, 3}, {-3, 3}}, Deflections{0.1, 0.26}, st);
    REQUIRE(c2);
    const Vec2 flip[3] = {{0, 6e-8}, {3, 5.8e-8}, {1.5, 5.91e-8}};
    c2->setBoundaryPoints({{flip[0], Vec3{0, 6e-8, 0}}, {flip[1], Vec3{3, 5.8e-8, 0}},
      {flip[2], Vec3{1.5, 5.91e-8, 0}}});
    CHECK(c2->accept(flip));
    const double origin[3] = {0, -1, 0};
    c2->setOutputOrigin(origin);
    CHECK(!c2->accept(flip));
    c2->setBoundaryPoints({{flip[0], Vec3{0, 6e-8, 0}}, {flip[1], Vec3{3, 5.8e-8, 0}}});
    CHECK(c2->accept(flip));
    c2->setBoundaryPoints({{flip[0], Vec3{0, 6e-8, 0}}, {flip[1], Vec3{3, 5.8e-8, 0}},
      {flip[2], Vec3{1.5, 5.91e-8, 0}}});
    const double none[3] = {NAN, NAN, NAN};
    c2->setOutputOrigin(none);
    CHECK(c2->accept(flip));
    // (And in double again a facet turned is refused.)
    const Vec2 turned[3] = {{0, 0}, {0, 3}, {3, 0}};
    CHECK(!c2->accept(turned));
  }
  // Within the refinement floor (max(tol, d / 10), 0.01 here) the turn on the boundary's own points isn't judged:
  // refinement can't go below the floor, and a boundary off its surface turns slivers it would only thin further.
  const Vec2 tiny[3] = {{0, 0}, {0.003, 0}, {0, 0.003}};
  c->setBoundaryPoints({{tiny[0], Vec3{0.0025, 0.0025, 0}}});
  CHECK(c->accept(tiny));
  // A corner's own point 0.25 off the plane (its edges' middles 0.125 off it, past d; its facet 7 degrees from the
  // plane's normal), its facet still up: accepted, its deviation the surface's (none), the boundary's own point
  // where the model put it.
  c->setBoundaryPoints({{t[0], Vec3{0, 0, 0.25}}});
  CHECK(c->accept(t));
  // A thin triangle whose corner's own point is 0.25 off the plane: its facet 27 degrees from the plane's normal, past
  // the angle, still up. Accepted: the angle is judged on the surface's points (on the output's, refinement thinning
  // the triangle only steepens it).
  const Vec2 thin[3] = {{0, 0}, {3, 0}, {0, 0.5}};
  c->setBoundaryPoints({{thin[0], Vec3{0, 0, 0.25}}});
  CHECK(c->accept(thin));
}

TEST_CASE("a needle too thin for float32 to show its facet's side (at most 4 float32 steps high at its corners' "
  "largest coordinate from the output's origin) with a corner the mesher placed isn't refused for its facet's turn; "
  "with every corner the boundary's, or as a smooth pole's fan, it is") {
  // (pcurveNear's plane, its normal +z, at d 0.1: the floor 0.01. Needles 3 long along x from (0, 0), their apex at
  // v = k x 2^-23, exact in float32: at the origin a reach of 3, so 4 steps are 12 x 2^-23; 11 within, 13 past.)
  cadgeom::Model m = load("pcurveNear");
  REQUIRE(m.ok());
  cadgeom::Status st;
  auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
  const double step = 0x1p-23, zero[3] = {0, 0, 0};
  auto make = [&]() {
    auto c = makeCriteria(m, 0, *s, cadgeom::Box2{{-3, 3}, {-3, 3}}, Deflections{0.1, 0.26}, st);
    REQUIRE(c);
    c->setOutputOrigin(zero);
    return c;
  };
  // Turned in double (clockwise in (u, v), facing -z).
  const Vec2 in[3] = {{0, 0}, {1.5, 11 * step}, {3, 0}}, past[3] = {{0, 0}, {1.5, 13 * step}, {3, 0}};
  {
    auto c = make();
    CHECK(c->accept(in));
    CHECK(c->refusal(in) == Refusal::none);
    CHECK(!c->accept(past));
    CHECK(c->refusal(past) == Refusal::normalFacet);
    // As a fan: refused however thin.
    CHECK(!c->acceptFan(in));
    CHECK(c->refusal(in, true, true) == Refusal::normalFacet);
    // Two corners the boundary's (their own points the surface's), the apex the mesher's: still not refused.
    c->setBoundaryPoints({{in[0], Vec3{0, 0, 0}}, {in[2], Vec3{3, 0, 0}}});
    CHECK(c->accept(in));
    // Every corner the boundary's: refused (splitting adds a mesher point).
    c->setBoundaryPoints({{in[0], Vec3{0, 0, 0}}, {in[1], Vec3{1.5, 11 * step, 0}}, {in[2], Vec3{3, 0, 0}}});
    CHECK(!c->accept(in));
    CHECK(c->refusal(in) == Refusal::normalFacet);
  }
  // The steps at the corners' coordinates from the output's origin: 1,000 below them in x or z, 13 x 2^-23 is within
  // (a reach of 1,003 or 1,000); with no origin known, as at 0.
  {
    auto c = make();
    const double far[3] = {-1000, 0, 0}, below[3] = {0, 0, -1000}, none[3] = {NAN, NAN, NAN};
    c->setOutputOrigin(far);
    CHECK(c->accept(past));
    c->setOutputOrigin(below);
    CHECK(c->accept(past));
    c->setOutputOrigin(none);
    CHECK(!c->accept(past));
  }
  // Facing +z on the surface's points, turned as output by a boundary corner's own point (on the plane, 3 x 11 steps
  // up in y; turnedAsOutput): not refused, the other two corners the mesher's; as a fan, refused.
  {
    auto c = make();
    const Vec2 up[3] = {{0, 0}, {3, 0}, {1.5, 11 * step}};
    CHECK(c->accept(up));
    c->setBoundaryPoints({{up[0], Vec3{0, 33 * step, 0}}});
    CHECK(c->accept(up));
    CHECK(c->refusal(up) == Refusal::none);
    CHECK(!c->acceptFan(up));
    CHECK(c->refusal(up, true, true) == Refusal::normalFacet);
  }
}

TEST_CASE("a point crowds a fixed segment (crowds) within a tenth of the floor of it, along it and past its ends, "
  "whatever the boundary's distance from its surface; a frozen one only where the needle turns as shipped; never a "
  "fold's sliver") {
  // (pcurveNear's plane at d 0.1: the floor 0.01, the band 0.001; the segment (0, 0) to (3, 0).)
  cadgeom::Model m = load("pcurveNear");
  REQUIRE(m.ok());
  cadgeom::Status st;
  auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
  auto c = makeCriteria(m, 0, *s, cadgeom::Box2{{-3, 3}, {-3, 3}}, Deflections{0.1, 0.26}, st);
  REQUIRE(c);
  const Vec2 a{0, 0}, b{3, 0};
  CHECK(c->crowds(a, b, {1.5, 0.0009}, false));
  CHECK(c->crowds(b, a, {1.5, -0.0009}, false));
  CHECK(!c->crowds(a, b, {1.5, 0.0011}, false));
  CHECK(c->crowds(a, b, {3.0009, 0.0005}, false));
  CHECK(c->crowds(a, b, {-0.0009, 0}, false));
  CHECK(!c->crowds(a, b, {3.0011, 0}, false));
  CHECK(!c->crowds(a, b, {-0.0011, 0}, false));
  // Frozen, the needle facing up in double and unrounded: not crowding.
  CHECK(!c->crowds(a, b, {1.5, 0.0009}, true));
  // The boundary 0.005 off its surface (a point's own 0.005 above the plane): the band still a tenth of the floor.
  c->setBoundaryPoints({{a, Vec3{0, 0, 0.005}}});
  CHECK(!c->crowds(a, b, {1.5, 0.0045}, false));
  CHECK(c->crowds(a, b, {1.5, 0.0009}, false));
  c->setBoundaryPoints({});
  // Frozen, a needle turned as shipped (the corners of the setBoundaryPoints case's flip, float32 minus an origin 1
  // below them): crowding; in double, not.
  {
    auto c2 = makeCriteria(m, 0, *s, cadgeom::Box2{{-3, 3}, {-3, 3}}, Deflections{0.1, 0.26}, st);
    REQUIRE(c2);
    const Vec2 fa{0, 6e-8}, fb{3, 5.8e-8}, fq{1.5, 5.91e-8};
    CHECK(!c2->crowds(fa, fb, fq, true));
    const double origin[3] = {0, -1, 0};
    c2->setOutputOrigin(origin);
    CHECK(c2->crowds(fa, fb, fq, true));
    CHECK(c2->crowds(fb, fa, fq, true));
  }
  // A fold's sliver (pleatStrip at a deflection of 1: the floor 0.2, the band 0.02): the segment 0.01 along y from
  // the fold at (0.5, 0.5), across it, isn't crowded by the fold's point; 0.01 along y from it a point off the fold
  // (v 0.25) is.
  cadgeom::Model p = load("pleatStrip");
  REQUIRE(p.ok());
  auto ps = cadgeom::makeSurface(p, p.faceSurface(0), st);
  auto pc = makeCriteria(p, 0, *ps, cadgeom::Box2{{0, 1}, {0, 1}}, Deflections{1, 15 * M_PI / 180}, st);
  REQUIRE(pc);
  const double e = 0.01 / 190;
  CHECK(!pc->crowds({0.5 + e, 0.05}, {0.5 + e, 0.95}, {0.5, 0.5}, false));
  CHECK(pc->crowds({0.5 + e, 0.05}, {0.5 + e, 0.95}, {0.5, 0.25}, false));
}

TEST_CASE("the deviation test counts a corner's own distance from the surface (setBoundaryPoints): a triangle within "
  "d on the surface's points refused where its sag and that distance pass max(d, the face's tolerance); not where the "
  "distance alone is past it") {
  // A triangle across u whose bound on the surface's points is 0.8 d, a corner's own point g off the surface along
  // its normal: refused exactly where g < within = max(d, tol) and the bound > min(d, within - g). On cylinderLong
  // (r 2, bounded), torusOuterHalf, spheres' hemisphere (closed form, then by inversion near its pole),
  // tubeGapFaceTolerance at d 1e-4 (its face's tolerance 1e-3 over the part's: within that, not d) and coneApexLoop
  // away from its apex (closed form).
  struct Case {
    const char* name;
    int face;
    double d;
    bool box;
    cadgeom::Box2 uv;
  };
  for (const Case& k : {Case{"cylinderLong", 0, 0.1, true, {{-1, 1}, {0, 10}}},
         Case{"torusOuterHalf", 0, 0.1, false, {}}, Case{"spheres", 1, 0.1, false, {}},
         Case{"tubeGapFaceTolerance", 0, 1e-4, false, {}}, Case{"coneApexLoop", 0, 0.1, true, {{0, 6.28}, {0, 3}}}}) {
    cadgeom::Model m = load(k.name);
    REQUIRE(m.ok());
    cadgeom::Status st;
    auto s = cadgeom::makeSurface(m, m.faceSurface(k.face), st);
    REQUIRE(s);
    const cadgeom::SurfaceDomain D = s->domain();
    const cadgeom::Box2 box = k.box ? k.uv : cadgeom::Box2{{D.u.lo, D.u.hi}, {D.v.lo, D.v.hi}};
    const double d = k.d, within = std::fmax(d, cadgeom::Tolerances(m).face(k.face));
    const Vec2 c{0.5 * (box.x.lo + box.x.hi), 0.5 * (box.y.lo + box.y.hi)};
    auto tri = [&](double a, Vec2 t[3]) { t[0] = {c.x - a, c.y}, t[1] = {c.x + a, c.y}, t[2] = {c.x, c.y + a}; };
    auto fresh = [&] { return makeCriteria(m, k.face, *s, box, Deflections{d, 1.5}, st); };
    auto c0 = fresh();
    REQUIRE(c0);
    // (The triangle's size by bisection to a bound of 0.8 d.)
    double lo = 1e-6, hi = 0.25 * (box.x.hi - box.x.lo), bound = 0;
    Vec2 t[3];
    for (int i = 0; i < 80; i++) {
      const double a = 0.5 * (lo + hi);
      tri(a, t);
      // (No bound, as over a B-spline's knots far apart may give none: too large.)
      (c0->deviationBound(t, bound) && bound < 0.8 * d ? lo : hi) = a;
    }
    tri(lo, t);
    REQUIRE(c0->deviationBound(t, bound));
    if (!(bound > 0.7 * d && bound < 0.9 * d)) std::printf("  %s: bound %g\n", k.name, bound);
    REQUIRE((bound > 0.7 * d && bound < 0.9 * d));
    CHECK(c0->accept(t));
    cadgeom::SurfacePoint sp;
    REQUIRE(s->eval(t[0].x, t[0].y, 1, sp) == cadgeom::Status::ok);
    Vec3 n = cadgeom::cross(sp.du, sp.dv);
    n = (1 / cadgeom::norm(n)) * n;
    for (double g : {d - bound + 0.05 * d, d - bound - 0.05 * d, within - 0.5 * bound, within + 0.5 * d}) {
      auto c1 = fresh();
      c1->setBoundaryPoints({{t[0], sp.p + g * n}});
      const bool refused = g < within && bound > std::fmin(d, within - g);
      if (c1->accept(t) == refused) std::printf("  %s: g %g bound %g within %g\n", k.name, g, bound, within);
      CHECK_EQ(c1->accept(t), !refused);
      // (Its bound on the surface's points unchanged: the part's check adds the distance itself.)
      double b1;
      REQUIRE(c1->deviationBound(t, b1));
      CHECK_EQ(b1, bound);
    }
  }
}

TEST_CASE("a triangle across a B-spline's knot is within the refinement floor as one within a span is (belowFloor "
  "bounds the pieces between the breaks), not by the poles' hull along the whole other span") {
  // bsplineTube: degree 2 x 1, u knots 0 to 4, one span along v 5 long; at d 0.1 the floor 0.01. A triangle 2e-4
  // across in (u, v), about 4e-4 mm in 3D, across the knot u = 1 and within the span at u = 1.5: both within the
  // floor. (The hull over the knot's spans is the tube's whole length, 5 mm.) One 0.02 across, past the floor: not.
  cadgeom::Model m = load("bsplineTube");
  REQUIRE(m.ok());
  cadgeom::Status st;
  auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
  REQUIRE(s);
  auto c = makeCriteria(m, 0, *s, cadgeom::Box2{{0, 4}, {0, 1}}, Deflections{0.1, 0.26}, st);
  REQUIRE(c);
  auto tri = [](double u, double a, Vec2 t[3]) { t[0] = {u - a, 0.5}, t[1] = {u + a, 0.5}, t[2] = {u, 0.5 + a}; };
  Vec2 t[3];
  tri(1, 1e-4, t);
  CHECK(c->belowFloor(t));
  tri(1.5, 1e-4, t);
  CHECK(c->belowFloor(t));
  tri(1, 0.01, t);
  CHECK(!c->belowFloor(t));
}

TEST_CASE("the criteria's turn on the boundary's own points (setBoundaryPoints) is the part's (checkFacing): the facet "
  "against the mean of its corners' normals, not against any one of them") {
  // (cylinderLong, r = 2: corners at u = -0.1, 0.1 and 0, their normals 0.2 apart; own points whose facet's normal is
  // along (1, 12, 0), against the u = -0.1 corner's normal (0.995, -0.0998, 0) but along their mean.)
  cadgeom::Model m = load("cylinderLong");
  REQUIRE(m.ok());
  cadgeom::Status st;
  auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
  REQUIRE(s);
  auto c = makeCriteria(m, 0, *s, cadgeom::Box2{{-1, 1}, {0, 10}}, Deflections{0.1, 0.26}, st);
  REQUIRE(c);
  const Vec2 t[3] = {{-0.1, 0}, {0.1, 0}, {0, 1}};
  CHECK(c->accept(t));
  cadgeom::SurfacePoint sp;
  REQUIRE(s->eval(t[0].x, t[0].y, 0, sp) == cadgeom::Status::ok);
  const Vec3 q0 = sp.p;
  c->setBoundaryPoints({{t[0], q0}, {t[1], q0 + Vec3{0, 0, 1}}, {t[2], q0 + Vec3{12, -1, 0}}});
  CHECK(c->accept(t));
  // (The same points the other way round: the facet against the mean too, refused.)
  c->setBoundaryPoints({{t[0], q0}, {t[1], q0 + Vec3{12, -1, 0}}, {t[2], q0 + Vec3{0, 0, 1}}});
  CHECK(!c->accept(t));
}

TEST_CASE("facetAgainst: a facet past 90 degrees from a normal, however little; within it not") {
  // A facet in the x-z plane tilted about x from the normal (0, 0, 1) by 89, 90 + 1e-6 and 91 degrees.
  const Vec3 normal{0, 0, 1};
  auto tilted = [](double degrees) {
    const double r = degrees * M_PI / 180;
    return Vec3{0, std::sin(r), std::cos(r)};
  };
  CHECK(!facetAgainst(tilted(0), normal));
  CHECK(!facetAgainst(tilted(89), normal));
  CHECK(facetAgainst(tilted(90 + 1e-6), normal));
  CHECK(facetAgainst(tilted(91), normal));
  CHECK(facetAgainst(tilted(180), normal));
  // A mean of corners' normals, as PartMesher judges a triangle: (0, 0, 1) and (0, 1, 0), a facet 91 degrees off it.
  const Vec3 mean = Vec3{0, 0, 1} + Vec3{0, 1, 0};
  const double off = std::atan2(1.0, 1.0) * 180 / M_PI + 91;
  CHECK(facetAgainst(tilted(off), mean));
  CHECK(!facetAgainst(tilted(off - 2), mean));
}

TEST_CASE("the metric's size ratio is at most 1000 in 3D, not in (u, v): a long cylinder's size along its axis is "
  "its extent (cylinderVast, radius 8000), or 1000 x its size across (cylinderLong, radius 2); the vast one's "
  "straight edges unsplit") {
  // (In (u, v) the ratio would be the 3D one times |S_u| / |S_v| = r: along the axis a few times across.)
  for (auto [name, r, h] : {std::tuple{"cylinderVast", 8000.0, 22600.0}, {"cylinderLong", 2.0, 4000.0}}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    cadgeom::Status st;
    auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
    REQUIRE(s);
    const double d = 0.1;
    auto crit = makeCriteria(m, 0, *s, cadgeom::Box2{{0, M_PI}, {0, h}}, Deflections{d, 0.26}, st);
    REQUIRE(crit);
    const Metric2 g = crit->metric({M_PI / 2, h / 2});
    // (u along the circle, |S_u| = r; v along the axis, |S_v| = 1: the metric diagonal.)
    // (Across, the smaller of the deflection's sqrt(6 d r) and the angle's 0.26 r.)
    const double across = r / std::sqrt(g.a), along = 1 / std::sqrt(g.c),
      want = std::min(std::sqrt(6 * d * r), 0.26 * r);
    // The extent as the criteria sample it: the half cylinder's box, 2 r by r by h.
    const double extent = std::sqrt(4 * r * r + r * r + h * h), alongWant = std::min(extent, 1000 * want);
    CHECK(std::fabs(across - want) < 1e-6 * want);
    CHECK(std::fabs(along - alongWant) < 1e-6 * alongWant);
    if (std::fabs(along - alongWant) >= 1e-6 * alongWant)
      std::printf("  %s: along %.9g want %.9g (across %.9g)\n", name, along, alongWant, across);
  }
  {
    // The worst-point fallback on elementary surfaces only: a triangle far past d across the vast cylinder named,
    // one on bumpPatch's B-spline (past d too) not.
    cadgeom::Model bump = load("bumpPatch");
    cadgeom::Status st;
    auto bs = cadgeom::makeSurface(bump, bump.faceSurface(0), st);
    const cadgeom::SurfaceDomain D = bs->domain();
    auto bc = makeCriteria(bump, 0, *bs, cadgeom::Box2{{D.u.lo, D.u.hi}, {D.v.lo, D.v.hi}}, Deflections{1e-3, 0.26},
      st);
    REQUIRE(bc);
    const Vec2 big[3] = {{D.u.lo, D.v.lo}, {D.u.hi, D.v.lo}, {D.u.lo, D.v.hi}};
    Vec2 at;
    CHECK(!bc->accept(big));
    CHECK(!bc->worstPoint(big, at));
    cadgeom::Model cyl = load("cylinderVast");
    auto cs = cadgeom::makeSurface(cyl, cyl.faceSurface(0), st);
    auto cc = makeCriteria(cyl, 0, *cs, cadgeom::Box2{{0, M_PI}, {0, 22600}}, Deflections{0.1, 0.26}, st);
    REQUIRE(cc);
    const Vec2 wide[3] = {{0.2, 100}, {1.2, 100}, {0.7, 200}};
    CHECK(!cc->accept(wide));
    CHECK(cc->worstPoint(wide, at));
  }
  cadgeom::Model m = load("cylinderVast");
  PartMesher pm(m, options(0.1, 15 * M_PI / 180));
  REQUIRE(pm.face(0).status == cadgeom::Status::ok);
  for (int e = 0; e < m.edges(); e++)
    if (m.curveKind(m.edgeCurve(e)) == CBR_CURVE_LINE) CHECK_EQ(pm.edges().edge(e).points.size(), 2u);
}

TEST_CASE("belowFloor: as the surface's bound over the triangle's (u, v) box alone has it, over random triangles from "
  "well under the floor to well past it, on a cylinder, a sphere, a torus and B-splines") {
  // The criteria settle a triangle whose corners are farther apart than the floor without the bound: the answer
  // must be the bound's (its box's diagonal within the floor), computed here from the surface itself.
  struct Case { const char* model; int face; double d; };
  for (Case c : {Case{"seamCylinder", 0, 0.01}, Case{"spheres", 1, 0.01}, Case{"torusOuterHalf", 0, 0.01},
         Case{"bumpPatch", 0, 1e-3}, Case{"bsplineDome", 0, 1e-3}}) {
    cadgeom::Model m = load(c.model);
    REQUIRE(m.ok());
    cadgeom::Status st;
    auto s = cadgeom::makeSurface(m, m.faceSurface(c.face), st);
    REQUIRE(s);
    // (Its domain's box, an infinite direction cut to [0, 5].)
    cadgeom::SurfaceDomain D = s->domain();
    auto finite = [](cadgeom::Range r) {
      return std::isfinite(r.lo) && std::isfinite(r.hi) ? cadgeom::Interval{r.lo, r.hi} : cadgeom::Interval{0, 5};
    };
    cadgeom::Box2 box{finite(D.u), finite(D.v)};
    auto crit = makeCriteria(m, c.face, *s, box, Deflections{c.d, 0.26}, st);
    REQUIRE(crit);
    const double floor = refinementFloor(cadgeom::Tolerances(m).part(), c.d);
    std::mt19937 rng(7);
    std::uniform_real_distribution<double> unit(0, 1);
    int agree = 0, below = 0, above = 0;
    for (int n = 0; n < 4000; n++) {
      // A size from 1e-6 to 1e-1 of the box, log-uniform; corners about a random point inside it.
      const double scale = std::pow(10.0, -6 + 5 * unit(rng));
      const double W = box.x.hi - box.x.lo, H = box.y.hi - box.y.lo;
      cadgeom::Vec2 o{box.x.lo + W * unit(rng), box.y.lo + H * unit(rng)}, tri[3];
      for (int i = 0; i < 3; i++)
        tri[i] = {std::clamp(o.x + W * scale * (unit(rng) - 0.5), box.x.lo, box.x.hi),
          std::clamp(o.y + H * scale * (unit(rng) - 0.5), box.y.lo, box.y.hi)};
      cadgeom::Range ru{std::min({tri[0].x, tri[1].x, tri[2].x}), std::max({tri[0].x, tri[1].x, tri[2].x})};
      cadgeom::Range rv{std::min({tri[0].y, tri[1].y, tri[2].y}), std::max({tri[0].y, tri[1].y, tri[2].y})};
      cadgeom::Box3 b;
      const bool want = s->bound(ru, rv, b) == cadgeom::Status::ok &&
        std::hypot(b.x.width(), b.y.width(), b.z.width()) <= floor;
      const bool got = crit->belowFloor(tri);
      agree += got == want;
      (want ? below : above)++;
      if (got != want)
        std::printf("  %s: (%g, %g) (%g, %g) (%g, %g): belowFloor %d, the bound's %d\n", c.model, tri[0].x, tri[0].y,
          tri[1].x, tri[1].y, tri[2].x, tri[2].y, got, want);
    }
    CHECK_EQ(agree, 4000);
    // Both answers well represented.
    if (below < 200 || above < 200) std::printf("  %s: %d below the floor, %d above\n", c.model, below, above);
    CHECK(below >= 200);
    CHECK(above >= 200);
  }
}

TEST_CASE("deviationBound: at least the triangle's distance from the surface, over random triangles on a cylinder, a "
  "sphere, a torus's outer half and B-splines; tight where the form is exact") {
  // The flat triangle on the surface's points at its corners, its barycentric lattice of order 6 inverted onto the
  // surface: the bound, where there is one, at least the most (less a rounding share). On the sphere, the cylinder
  // and the torus's outer half the bounds are closed forms or exact derivative bounds: within 2 x of it at least
  // once, so a bound halved shows.
  struct Case { const char* model; int face; double d; };
  for (Case c : {Case{"seamCylinder", 0, 0.01}, Case{"spheres", 1, 0.01}, Case{"torusOuterHalf", 0, 0.01},
         Case{"bumpPatch", 0, 1e-3}, Case{"bsplineDome", 0, 1e-3}}) {
    cadgeom::Model m = load(c.model);
    REQUIRE(m.ok());
    cadgeom::Status st;
    auto s = cadgeom::makeSurface(m, m.faceSurface(c.face), st);
    REQUIRE(s);
    cadgeom::SurfaceDomain D = s->domain();
    auto finite = [](cadgeom::Range r) {
      return std::isfinite(r.lo) && std::isfinite(r.hi) ? cadgeom::Interval{r.lo, r.hi} : cadgeom::Interval{0, 5};
    };
    cadgeom::Box2 box{finite(D.u), finite(D.v)};
    auto crit = makeCriteria(m, c.face, *s, box, Deflections{c.d, 0.26}, st);
    REQUIRE(crit);
    std::mt19937 rng(11);
    std::uniform_real_distribution<double> unit(0, 1);
    int bounded = 0, under = 0, tight = 0, wholes = 0;
    for (int n = 0; n < 100; n++) {
      const double scale = std::pow(10.0, -3 + 2.5 * unit(rng));
      const double W = box.x.hi - box.x.lo, H = box.y.hi - box.y.lo;
      cadgeom::Vec2 o{box.x.lo + W * unit(rng), box.y.lo + H * unit(rng)}, tri[3];
      for (int i = 0; i < 3; i++)
        tri[i] = {std::clamp(o.x + W * scale * (unit(rng) - 0.5), box.x.lo, box.x.hi),
          std::clamp(o.y + H * scale * (unit(rng) - 0.5), box.y.lo, box.y.hi)};
      double bound, whole;
      if (!crit->deviationBound(tri, bound)) continue;
      bounded++;
      // (The box's, without pieces: a bound too, at least the pieces' less rounding.)
      const bool hasWhole = crit->deviationBound(tri, whole, false);
      Vec3 p[3];
      for (int i = 0; i < 3; i++) {
        cadgeom::SurfacePoint q;
        s->eval(tri[i].x, tri[i].y, 0, q);
        p[i] = q.p;
      }
      double dev = 0;
      for (int i = 0; i <= 6; i++)
        for (int j = 0; i + j <= 6; j++) {
          Vec3 x = (i / 6.0) * p[0] + (j / 6.0) * p[1] + ((6 - i - j) / 6.0) * p[2];
          cadgeom::SurfaceInversion inv = cadgeom::invertSurface(*s, x, D.u, D.v, 1e-10);
          if (inv.status == cadgeom::Status::ok) dev = std::fmax(dev, inv.distance);
        }
      if (bound < dev * (1 - 1e-6) - 1e-12 || (hasWhole && whole < dev * (1 - 1e-6) - 1e-12)) {
        under++;
        std::printf("  %s: bound %g (the box's %g) under its deviation %g\n", c.model, bound, hasWhole ? whole : NAN,
          dev);
      }
      wholes += hasWhole;
      tight += dev > 1e-9 && bound < 2 * dev;
    }
    CHECK_EQ(under, 0);
    if (bounded < 25) std::printf("  %s: %d bounded of 100\n", c.model, bounded);
    CHECK(bounded >= 25);
    CHECK_EQ(wholes, bounded);
    if (std::strcmp(c.model, "bumpPatch") != 0 && std::strcmp(c.model, "bsplineDome") != 0) {
      if (tight == 0) std::printf("  %s: never within 2 x\n", c.model);
      CHECK(tight > 0);
    }
  }
}

TEST_CASE("the criteria's deviation verdicts sound inside knot cells: whatever they accept within d, measured "
  "(bumpPatch's bicubic, random triangles in single cells about the size d allows: the cached cell bound's fast "
  "accept among them)") {
  cadgeom::Model m = load("bumpPatch");
  REQUIRE(m.ok());
  cadgeom::Status st;
  auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
  REQUIRE(s);
  const cadgeom::SurfaceDomain D = s->domain();
  int nearAll = 0;
  for (double d : {0.3, 0.1, 1e-2}) {
    auto crit = makeCriteria(m, 0, *s, cadgeom::Box2{{D.u.lo, D.u.hi}, {D.v.lo, D.v.hi}}, Deflections{d, 0.26}, st);
    REQUIRE(crit);
    std::mt19937 rng(5);
    std::uniform_real_distribution<double> unit(0, 1);
    int accepted = 0, over = 0, near = 0, looser = 0;
    for (int n = 0; n < 3000; n++) {
      // A cell of the knots 0..4 both ways, a triangle inside it, its size from a hundredth of the cell up.
      const double cu = std::floor(4 * unit(rng)), cv = std::floor(4 * unit(rng));
      const double size = std::pow(10.0, -1.5 + 1.5 * unit(rng));
      cadgeom::Vec2 o{cu + unit(rng), cv + unit(rng)}, tri[3];
      for (int i = 0; i < 3; i++)
        tri[i] = {std::clamp(o.x + size * (unit(rng) - 0.5), cu, cu + 1),
          std::clamp(o.y + size * (unit(rng) - 0.5), cv, cv + 1)};
      if (!crit->acceptDeviation(tri)) continue;
      accepted++;
      // Never one the triangle's own bounds refuse, the box's and the pieces' (deviationBound): the cell's only
      // accepts sooner, as they would.
      double whole, pieces;
      if (crit->deviationBound(tri, whole, false) && crit->deviationBound(tri, pieces, true) && whole > d &&
        pieces > d)
        looser++;
      Vec3 p[3];
      for (int i = 0; i < 3; i++) {
        cadgeom::SurfacePoint q;
        s->eval(tri[i].x, tri[i].y, 0, q);
        p[i] = q.p;
      }
      double dev = 0;
      for (int i = 0; i <= 8; i++)
        for (int j = 0; i + j <= 8; j++) {
          Vec3 x = (i / 8.0) * p[0] + (j / 8.0) * p[1] + ((8 - i - j) / 8.0) * p[2];
          cadgeom::SurfaceInversion inv = cadgeom::invertSurface(*s, x, D.u, D.v, 1e-10);
          if (inv.status == cadgeom::Status::ok) dev = std::fmax(dev, inv.distance);
        }
      over += dev > d * (1 + 1e-6);
      near += dev > 0.5 * d;
    }
    if (over || looser)
      std::printf("  bumpPatch at %g: %d of %d accepted past d, %d past their own bounds\n", d, over, accepted, looser);
    CHECK_EQ(over, 0);
    CHECK_EQ(looser, 0);
    nearAll += near;
  }
  CHECK(nearAll > 10);  // (accepted triangles close to d: a looser verdict would show)
}

TEST_CASE("the criteria's piece bounds stop once past d (deviationWithin) with the verdict the whole bound gives: "
  "random triangles across knot cells on B-splines, refused for their bound exactly where the box's and the pieces' "
  "bounds (deviationBound, every piece) are past d") {
  // deviationWithin bounds a triangle the 4-point sample passes by its knot cells' cached bound, then its box's, then
  // its pieces', stopping at the first piece that puts the bound past d; deviationBound takes every piece. Triangles
  // over several cells (their pieces many, a late one often the decider) at deflections where both verdicts are
  // common. (No pole: near one the surface's distance by inversion may accept what the bounds refuse.)
  struct Case { const char* model; double d; };
  int refusedAll = 0, acceptedAll = 0;
  for (Case c : {Case{"bumpPatch", 0.3}, Case{"bumpPatch", 0.1}, Case{"bumpPatch", 3e-2}, Case{"bumpPatch", 1e-2},
         Case{"bsplineTube", 0.1}, Case{"bsplineTube", 1e-2}}) {
    cadgeom::Model m = load(c.model);
    REQUIRE(m.ok());
    cadgeom::Status st;
    auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
    REQUIRE(s);
    const cadgeom::SurfaceDomain D = s->domain();
    auto crit = makeCriteria(m, 0, *s, cadgeom::Box2{{D.u.lo, D.u.hi}, {D.v.lo, D.v.hi}}, Deflections{c.d, 0.26}, st);
    REQUIRE(crit);
    std::mt19937 rng(17);
    std::uniform_real_distribution<double> unit(0, 1);
    const double W = D.u.hi - D.u.lo, H = D.v.hi - D.v.lo;
    int differ = 0, refused = 0, accepted = 0;
    for (int n = 0; n < 4000; n++) {
      // From a twentieth of the domain up to most of it: across one to all of its cells.
      const double scale = std::pow(10.0, -1.3 + 1.2 * unit(rng));
      cadgeom::Vec2 o{D.u.lo + W * unit(rng), D.v.lo + H * unit(rng)}, tri[3];
      for (int i = 0; i < 3; i++)
        tri[i] = {std::clamp(o.x + W * scale * (unit(rng) - 0.5), D.u.lo, D.u.hi),
          std::clamp(o.y + H * scale * (unit(rng) - 0.5), D.v.lo, D.v.hi)};
      const Refusal r = crit->refusal(tri, false);
      // (The sample's refusals come before any bound.)
      if (r != Refusal::none && r != Refusal::deviationBounded) continue;
      double whole, pieces;
      if (!crit->deviationBound(tri, whole, false) || !crit->deviationBound(tri, pieces, true)) continue;
      // deviationBound is the least of the cells' bound and the box's (or the pieces'): past d both ways, refused.
      const bool past = whole > c.d && pieces > c.d;
      if (past != (r == Refusal::deviationBounded)) {
        differ++;
        std::printf("  %s at %g: (%g, %g) (%g, %g) (%g, %g): %s, the box's bound %g, the pieces' %g\n", c.model, c.d,
          tri[0].x, tri[0].y, tri[1].x, tri[1].y, tri[2].x, tri[2].y, r == Refusal::none ? "accepted" : "refused",
          whole, pieces);
      }
      refused += past;
      accepted += whole > c.d && pieces <= c.d;
    }
    CHECK_EQ(differ, 0);
    refusedAll += refused, acceptedAll += accepted;
  }
  // Both verdicts after the box's bound: refused by the pieces, and accepted by them alone.
  if (refusedAll < 200 || acceptedAll < 50)
    std::printf("  refused %d, accepted by the pieces %d\n", refusedAll, acceptedAll);
  CHECK(refusedAll >= 200);
  CHECK(acceptedAll >= 50);
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
  // Random triangles on a cylinder, a sphere, two B-splines, a cone and both halves of a torus: none accepted on the
  // bounded ones whose deviation, sampled densely (its barycentric grid against the surface's nearest point), is over
  // the deflection. The torus's inner half, where its closed form doesn't hold, is bounded by its derivatives, so it
  // stays bounded once judged.
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
      if (fc.box.y.lo > 1) CHECK(c->bounded());
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
        // The scale where the dense deviation is 1.02 d, by bisection (to 2^-24 of the start, the deviation within
        // 1e-6 of it: finer moves no triangle across any count below).
        double lo = 0, hi = 0.5, dense = 0, sampled = 0;
        Vec2 t[3];
        auto place = [&](double r) {
          for (int i = 0; i < 3; i++) t[i] = {o.x + r * e[i].x, o.y + r * e[i].y};
          if ((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[2].x - t[0].x) * (t[1].y - t[0].y) <= 0) std::swap(t[1], t[2]);
          deviations(t, dense, sampled);
        };
        place(hi);
        if (dense < 1.02 * d) continue;
        for (int it = 0; it < (spline ? 12 : 24); it++) {
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
  // A triangle within the refinement floor (its patch's bound within max(tolerance, 0.1 x the deflection), 1e-3
  // here): accepted, by accept() and acceptDeviation(), either way round: its corners in (u, v) the wrong way round,
  // its facet turned over, accepted too (nothing refined below the floor; the part's check of its output judges what's
  // shipped), refusal() saying none; as a pole's fan (acceptFan, refusal's fan) still refused. belowFloor() says so
  // either way.
  {
    auto c = criteria("seamCylinder", 0, {{0, 2 * M_PI}, {0, 5}}, 0.01, 0.26, s);
    const Vec2 tiny[3] = {{1, 2}, {1, 2 + 1e-12}, {1 + 1e-12, 2}};
    const Vec2 tinyOk[3] = {{1, 2}, {1 + 1e-12, 2}, {1, 2 + 1e-12}};
    CHECK(c->accept(tiny));
    CHECK(c->refusal(tiny) == Refusal::none);
    CHECK(!c->acceptFan(tiny));
    CHECK(c->refusal(tiny, true, true) == Refusal::normalFacet);
    CHECK(c->accept(tinyOk));
    CHECK(c->acceptFan(tinyOk));
    // Just within it: 2e-4 in (u, v) on the radius 2 cylinder, its patch's bound about 6e-4 mm across.
    const Vec2 within[3] = {{1, 2}, {1, 2 + 2e-4}, {1 + 2e-4, 2}};
    const Vec2 withinOk[3] = {{1, 2}, {1 + 2e-4, 2}, {1, 2 + 2e-4}};
    CHECK(c->belowFloor(within));
    CHECK(c->accept(within));
    CHECK(!c->acceptFan(within));
    CHECK(c->acceptDeviation(within));
    CHECK(c->belowFloor(withinOk));
    CHECK(c->accept(withinOk));
    CHECK(c->refusal(withinOk) == Refusal::none);
    // Just past it: 6e-4 in (u, v), about 1.7e-3 mm across, turned over the same way: refused.
    const Vec2 big[3] = {{1, 2}, {1, 2 + 6e-4}, {1 + 6e-4, 2}};
    CHECK(!c->belowFloor(big));
    CHECK(!c->accept(big));
    // (Refused for its facet against its corners' normals: the deviation passes.)
    CHECK(c->refusal(big) == Refusal::normalFacet);
    CHECK(c->refusal(big, false) == Refusal::none);
    CHECK(c->refusal(within) == Refusal::none);
    CHECK(c->refusal(within, true, true) == Refusal::normalFacet);
    CHECK(c->refusal(within, false) == Refusal::none);
    // Its corners within 1e-6 of one point in 3D across the seam, its patch the whole circle: judged by the patch's
    // bound, not within the floor, refused.
    const Vec2 round[3] = {{0, 2}, {2 * M_PI, 2}, {2 * M_PI, 2 + 1e-6}};
    CHECK(!c->belowFloor(round));
    CHECK(!c->accept(round));
  }
  // Below the floor, a turned-over facet with a corner within the tolerance of a pole: not judged, accepted (at a
  // degenerate spot refinement would chase it to the point cap); away from the pole accepted too, as any within the
  // floor, but as a fan's refused (one of the pair).
  {
    auto sp = criteria("spheres", 1, {{0, 2 * M_PI}, {0, M_PI / 2}}, 0.01, 0.26, s);
    const double e = 2e-4;
    const Vec2 atPole[3] = {{1, M_PI / 2}, {1 + e, M_PI / 2 - e}, {1, M_PI / 2 - e}};
    const Vec2 atPoleOver[3] = {atPole[0], atPole[2], atPole[1]};
    const Vec2 away[3] = {{1, 0.5}, {1, 0.5 + e}, {1 + e, 0.5}};
    const Vec2 awayOver[3] = {away[0], away[2], away[1]};
    REQUIRE(sp->belowFloor(atPoleOver));
    REQUIRE(sp->belowFloor(awayOver));
    // (One of each pair is turned over: as fans, away from the pole exactly one is refused, at it neither.)
    CHECK(sp->accept(away));
    CHECK(sp->accept(awayOver));
    CHECK(sp->acceptFan(away) != sp->acceptFan(awayOver));
    CHECK(sp->accept(atPole));
    CHECK(sp->accept(atPoleOver));
    CHECK(sp->acceptFan(atPole));
    CHECK(sp->acceptFan(atPoleOver));
  }
  // Thin triangles (twice the area over the longest side within the refinement floor, max(tolerance, 0.1 x d) = 0.1
  // at d 1): the facet not held to the angle, only to its corners' side. On the radius 2 cylinder three points round
  // it 0.2 rad apart, the middle 0.005 along it: about 0.011 thick, its facet 64 degrees off its corners' normals,
  // which are within 0.2 rad of one another: accepted at 15 degrees; turned over, refused; as a smooth pole's fan
  // (acceptFan), held to the angle however thin, refused. A thick one past the angle (0.2 rad round, 2 along, about
  // 0.4 mm thick, at 0.01 rad) refused for its facet.
  {
    auto t = criteria("seamCylinder", 0, {{0, 2 * M_PI}, {0, 5}}, 1.0, 0.26, s);
    const Vec2 thin[3] = {{1, 2}, {1.2, 2}, {1.1, 2.005}};
    const Vec2 thinOver[3] = {{1, 2}, {1.1, 2.005}, {1.2, 2}};
    CHECK(!t->belowFloor(thin));
    CHECK(t->accept(thin));
    CHECK(t->refusal(thin) == Refusal::none);
    CHECK(!t->accept(thinOver));
    CHECK(t->refusal(thinOver) == Refusal::normalFacet);
    CHECK(!t->acceptFan(thin));
    CHECK(t->refusal(thin, true, true) == Refusal::normalFacet);
    auto k = criteria("seamCylinder", 0, {{0, 2 * M_PI}, {0, 5}}, 1.0, 0.01, s);
    const Vec2 thick[3] = {{1, 2}, {1.2, 2}, {1, 4}};
    CHECK(!k->accept(thick));
    CHECK(k->refusal(thick) == Refusal::normalFacet);
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
  CHECK(h->refusal(over) != Refusal::none);
  CHECK(h->refusal(fine) == Refusal::none);
  CHECK(h->refusal(pole) == Refusal::none);
}

// A crease between knots a hair apart (kinkStrip, 1e-4 of u wide, its second partial about 1e4 there): every triangle
// across it whose dense deviation is just over the deflection refused by the bounds, none judged by sampling (the face
// stays bounded), and those under kTight of it accepted, where the strip's maxima over its square alone would refuse
// all of them (the bound within 1.1 x the deviation for most, 3.6 x with a corner on the crease and the triangle thin
// along it). Across a v-crease too, and with the crease anywhere in the triangle.
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
    // (refusal() as accept() and acceptDeviation() say: a normals reason, or none by the deviation alone.)
    const Refusal r = c->refusal(t), rd = c->refusal(t, false);
    CHECK((r == Refusal::none) == c->accept(t));
    CHECK((rd == Refusal::none) == c->acceptDeviation(t));
    if (r != Refusal::none && rd == Refusal::none) CHECK((r == Refusal::normalFacet || r == Refusal::normalSpread));
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

TEST_CASE("a B-spline's knot span narrower than the floor in 3D, sharply bent, doesn't set the curvature's sizes: "
  "kinkAtEnd meshed about as its patch without the span, its area the patch's") {
  struct Mesh {
    size_t triangles;
    double area;
  };
  auto mesh = [](const char* name) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    PartMesher pm(m, options(0.1, 0.26));
    const FaceMesh& fm = pm.face(0);
    REQUIRE(fm.status == cadgeom::Status::ok);
    double area = 0;
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
      area += 0.5 * cadgeom::norm(cadgeom::cross(fm.points[fm.triangles[t + 1]] - fm.points[fm.triangles[t]],
        fm.points[fm.triangles[t + 2]] - fm.points[fm.triangles[t]]));
    return Mesh{fm.triangles.size() / 3, area};
  };
  const Mesh kinked = mesh("kinkAtEnd"), plain = mesh("kinkAtEndPlain");
  CHECK(kinked.triangles <= 2 * plain.triangles);
  CHECK(std::fabs(kinked.area - plain.area) < 0.01 * plain.area);
  if (!(kinked.triangles <= 2 * plain.triangles))
    std::printf("  kinkAtEnd: %zu triangles (area %.4f), its plain patch %zu (%.4f)\n", kinked.triangles, kinked.area,
      plain.triangles, plain.area);
}

TEST_CASE("a run of knot spans each narrower than the floor in 3D but not together keeps its curvature's sizes: "
  "kinkStripRun's crease, four spans of 0.04 mm under a floor of 0.05, sized as curved") {
  cadgeom::Model m = load("kinkStripRun");
  REQUIRE(m.ok());
  cadgeom::Status st;
  auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
  REQUIRE(s);
  auto c = makeCriteria(m, 0, *s, {{0, 1}, {0, 1}}, Deflections{0.5, 0.26}, st);
  REQUIRE(c);
  // (Across the crease, u: its slope turning by 2 atan 0.05 over 0.16 mm, a mean curvature k of 0.62 and a size of
  // 0.26 / k = 0.42 mm there, E / h^2 = 100 / 0.42^2 about 570; flat away from it, graded out from the crease.)
  const double across = c->metric({0.5, 0.5}).a, away = c->metric({0.1, 0.5}).a;
  const double k = 2 * std::atan(0.05) / 0.16, want = 100 * (k / 0.26) * (k / 0.26);
  if (!(across > 0.8 * want && across > 10 * away))
    std::printf("  kinkStripRun: metric across %.4g (%.4g asked), away %.4g\n", across, want, away);
  CHECK(across > 0.8 * want);
  CHECK(across > 10 * away);
}

TEST_CASE("a run of knot spans each narrower than the floor in 3D that bends sharply inside and back is sized by its "
  "mean turn, not its pointwise curvature: rippleRun's ripple (k up to 2.5 over 0.16 mm, no turn across) sized as "
  "flat, along u or v, and meshed as a flat strip; kinkStripRun's crease still sized as curved, by its mean "
  "curvature, the line that bends most where a run bends unevenly along it") {
  auto metricAt = [](const char* name, Vec2 p, bool inV) {
    static std::vector<cadgeom::Model> keep;
    keep.push_back(load(name));
    cadgeom::Status st;
    auto s = cadgeom::makeSurface(keep.back(), keep.back().faceSurface(0), st);
    REQUIRE(s);
    auto c = makeCriteria(keep.back(), 0, *s, {{0, 1}, {0, 1}}, Deflections{0.5, 0.26}, st);
    REQUIRE(c);
    const tesscadio::Metric2 M = c->metric(inV ? Vec2{p.y, p.x} : p);
    return inV ? M.c : M.a;
  };
  for (bool inV : {false, true}) {
    const char* name = inV ? "rippleRunV" : "rippleRun";
    // (Across the ripple, at its peak and either side inside the run, against the flat strip away from it.)
    const double away = metricAt(name, {0.1, 0.5}, inV);
    double most = 0;
    for (double x : {0.494, 0.497, 0.5, 0.503, 0.506}) most = std::max(most, metricAt(name, {x, 0.5}, inV));
    if (!(most < 4 * away)) std::printf("  %s: metric across %.4g, away %.4g\n", name, most, away);
    CHECK(most < 4 * away);
  }
  // (The crease, against it: its run turns by 0.1 over 0.16 mm, a mean curvature of about 0.6.)
  CHECK(metricAt("kinkStripRun", {0.5, 0.5}, false) > 10 * metricAt("kinkStripRun", {0.1, 0.5}, false));
  // Stretched 2 x along it (|S| along 20, across 10), sheared and its bend growing along it (z x 0.25 to 1): at the
  // line where it bends most, sized by that line's mean curvature across the run, 2 atan(0.05 f) over its 0.16 mm,
  // not by the least line's nor by the pointwise curvature (4 x the mean there), along u or v.
  for (bool inV : {false, true}) {
    const char* name = inV ? "kinkStripRunShapedV" : "kinkStripRunShaped";
    const double w = 0.95, f = 0.25 + 0.75 * w, k = 2 * std::atan(0.05 * f) / 0.16;
    const double want = 100 * (k / 0.26) * (k / 0.26);
    const double across = metricAt(name, {0.5, w}, inV);
    if (!(across > 0.8 * want && across < 2 * want))
      std::printf("  %s: metric across %.4g, its line's mean curvature asks %.4g\n", name, across, want);
    CHECK(across > 0.8 * want);
    CHECK(across < 2 * want);
  }
  // Meshed within the deflection as about as few triangles as its flat strip (a few dozen), every one accepted.
  cadgeom::Model m = load("rippleRun");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.5, 0.26));
  const FaceMesh& fm = pm.face(0);
  CHECK(fm.status == cadgeom::Status::ok);
  CHECK(fm.rejected.empty());
  if (!(fm.triangles.size() / 3 <= 64)) std::printf("  rippleRun: %zu triangles\n", fm.triangles.size() / 3);
  CHECK(fm.triangles.size() / 3 <= 64);
}

TEST_CASE("a fold (cad-geom's folds.h): a triangle with a corner within the floor of it isn't judged by its normals, "
  "its deviation still is; one away from it is; a smooth pole's fan is") {
  // doubledStrip's folds at t = 0.25 and 0.75 (y = 0.25 and -0.25, its normal turned back between them).
  auto criteria = [](const char* name, std::unique_ptr<cadgeom::Surface>& s, double d = 0.1) {
    static std::vector<cadgeom::Model> keep;
    keep.push_back(load(name));
    cadgeom::Status st;
    s = cadgeom::makeSurface(keep.back(), keep.back().faceSurface(0), st);
    return makeCriteria(keep.back(), 0, *s, {{0, 1}, {0, 1}}, Deflections{d, 0.26}, st);
  };
  std::unique_ptr<cadgeom::Surface> s, s2;
  auto c = criteria("doubledStrip", s);
  REQUIRE(c);
  // Across the fold at t = 0.25 (y 0.2494 at t = 0.24 and 0.26, 0.0006 from the fold's 0.25 in 3D): its corners'
  // normals turned back across it, refused for them but for the fold; within the deviation (0.02 at most of 0.1).
  // (Its corners halfway between the grid's lines u = k / 64, where the fold's crossings are, 0.016 from them in 3D:
  // within the floor of its polyline's segments, not of its points.)
  const Vec2 across[3] = {{26.5 / 64, 0.24}, {38.5 / 64, 0.24}, {32.5 / 64, 0.26}};
  CHECK(c->accept(across));
  CHECK(c->refusal(across, true, false) == Refusal::none);
  // Its corners 0.014 mm from the fold (t = 0.2 and 0.3), past the floor (0.01): judged, refused for its normals.
  const Vec2 wide[3] = {{0.4, 0.2}, {0.6, 0.2}, {0.5, 0.3}};
  CHECK(!c->accept(wide));
  CHECK(c->refusal(wide, true, false) == Refusal::normalFacet);
  // Between the folds, wound against the layer's normal (clockwise in (u, v) where the sheet runs back): refused.
  const Vec2 turned[3] = {{0.4, 0.45}, {0.5, 0.55}, {0.6, 0.45}};
  CHECK(!c->accept(turned));
  CHECK(c->refusal(turned, true, false) == Refusal::normalFacet);
  // A smooth pole's fan is judged however near a fold.
  CHECK(!c->acceptFan(across));
  // With its corners the boundary's own points (setBoundaryPoints, there on the surface), judged as output too: not
  // for its turn either, wound either way (its corners' normals' sum against one of the two facets).
  {
    std::unique_ptr<cadgeom::Surface> s4;
    auto b = criteria("doubledStrip", s4);
    REQUIRE(b);
    std::vector<std::pair<Vec2, Vec3>> own;
    for (Vec2 x : across) {
      cadgeom::SurfacePoint q;
      s4->eval(x.x, x.y, 0, q);
      own.push_back({x, q.p});
    }
    b->setBoundaryPoints(own);
    const Vec2 back[3] = {across[0], across[2], across[1]};
    CHECK(b->accept(across));
    CHECK(b->accept(back));
  }
  // At d = 1 (the floor 0.1) a long triangle across the fold, its patch past the floor and its deviation (about 0.32)
  // within d: accepted. (A band within the face's tolerance isn't kept as a fold, foldNormal's: there the floor is at
  // least the tolerance, so a triangle across the band is a sliver foldSliver accepts; the corpus shows the gate, LMP1
  // #172427's pleats.)
  auto tight = criteria("doubledStrip", s2, 1);
  REQUIRE(tight);
  const Vec2 longAcross[3] = {{0.1, 0.24}, {0.9, 0.24}, {0.5, 0.26}};
  CHECK(tight->accept(longAcross));
}
