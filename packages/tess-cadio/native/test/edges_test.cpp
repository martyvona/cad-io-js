// edges.h on cad-brep's test models and tess-cadio's (native/test/models.ts), each checked by properties found
// independently of the sampler: the curve between consecutive samples measured densely against their chord (within
// the deflection, plus the vertex's gap at an end), spans' arc lengths (cad-geom's arcLength) within the spacing,
// the tangent's turn across each span within the angle, every use's (u, v) on the surface at the edge's points; then
// each face's boundary meshed through mesh2d.h, its 3D area against the face's own in closed form, and cuts, pole
// lines, seams by inversion and splits checked by what they must give.
#include <tess_cadio/edges.h>
#include <cstring>
#include <tess_cadio/mesh2d.h>

#include <cad_geom/curve.h>
#include <cad_geom/surface.h>

#include <cmath>
#include <cstdio>
#include <memory>
#include <set>
#include <string>

#include "brep_models.h"
#include "check.h"
#include "tess_models.h"

using namespace tesscadio;
using cadgeom::Vec2;
using cadgeom::Vec3;

namespace {

const cadgeom::Model load(const char* name) {
  if (const tessfixtures::Model* t = tessfixtures::model(name)) return cadgeom::Model(t->data, t->size);
  const fixtures::Model* f = fixtures::model(name);
  return cadgeom::Model(f ? f->data : nullptr, f ? f->size : 0);
}

/** C(t) on an edge: its 3D curve, or its first use's p-curve through that face's surface. */
struct EdgeCurve {
  std::unique_ptr<cadgeom::Curve> c, pc;
  std::unique_ptr<cadgeom::Surface> s;
  EdgeCurve(const cadgeom::Model& m, int e) {
    cadgeom::Status st;
    if (m.edgeCurve(e) >= 0) {
      c = cadgeom::makeCurve(m, m.edgeCurve(e), st);
      return;
    }
    for (int f = 0; f < m.faces() && !pc; f++)
      for (int i = 0; i < m.faceLoopCount(f); i++) {
        int l = m.faceFirstLoop(f) + i;
        if (m.loopKind(l) != CBR_LOOP_EDGE) continue;
        for (int k = 0; k < m.loopCount(l) && !pc; k++) {
          int co = m.loopFirst(l) + k;
          if (m.coedgeEdge(co) != e || m.coedgePcurve(co) < 0) continue;
          pc = cadgeom::makeCurve(m, m.coedgePcurve(co), st);
          s = cadgeom::makeSurface(m, m.faceSurface(f), st);
        }
      }
  }
  Vec3 at(double t) const {
    cadgeom::CurvePoint q;
    if (c) {
      c->eval(t, 0, q);
      return q.p;
    }
    pc->eval(t, 0, q);
    cadgeom::SurfacePoint p;
    s->eval(q.p.x, q.p.y, 0, p);
    return p.p;
  }
  Vec3 tangent(double t) const {
    cadgeom::CurvePoint q;
    if (c) {
      c->eval(t, 1, q);
      return q.d1;
    }
    pc->eval(t, 1, q);
    cadgeom::SurfacePoint p;
    s->eval(q.p.x, q.p.y, 1, p);
    return q.d1.x * p.du + q.d1.y * p.dv;
  }
};

double distToSegment(Vec3 p, Vec3 a, Vec3 b) {
  Vec3 d = b - a;
  double l2 = cadgeom::dot(d, d), s = l2 > 0 ? std::clamp(cadgeom::dot(p - a, d) / l2, 0.0, 1.0) : 0;
  return cadgeom::norm(p - (a + s * d));
}

/** The largest angle between any two of these unit tangents. */
double turn(const std::vector<Vec3>& u) {
  double most = 0;
  for (size_t i = 0; i < u.size(); i++)
    for (size_t j = i + 1; j < u.size(); j++)
      most = std::fmax(most, std::atan2(cadgeom::norm(cadgeom::cross(u[i], u[j])), cadgeom::dot(u[i], u[j])));
  return most;
}

struct Measured {
  double deviation = 0, excess = 0, longest = 0, angle = 0;
  int spans = 0;
};
/**
 * An edge's samples measured densely: the most the curve strays from a span's chord beyond what's allowed (the
 * deflection, plus at an end the vertex's distance from its curve there), the longest 3D span by arc length (dense
 * polyline), the most the tangent turns across a span (between any two of its points).
 */
Measured measure(const cadgeom::Model& m, int e, const EdgeSamples& s, double deflection) {
  Measured r;
  EdgeCurve ec(m, e);
  int n = static_cast<int>(s.t.size());
  std::vector<Vec3> tangents;
  for (int i = 0; i + 1 < n; i++) {
    Vec3 a = s.points[i], b = s.points[i + 1];
    double allowed = deflection;
    if (i == 0) allowed += cadgeom::norm(a - ec.at(s.t[0]));
    if (i + 1 == n - 1) allowed += cadgeom::norm(b - ec.at(s.t[n - 1]));
    double len = 0;
    Vec3 prev = ec.at(s.t[i]);
    for (int k = 0; k <= 200; k++) {
      double t = s.t[i] + (s.t[i + 1] - s.t[i]) * k / 200.0;
      Vec3 p = ec.at(t);
      double dv = distToSegment(p, a, b);
      r.deviation = std::fmax(r.deviation, dv);
      r.excess = std::fmax(r.excess, dv - allowed);
      if (k) len += cadgeom::norm(p - prev);
      prev = p;
      if (k == 0 || k == 200) continue;  // (at a break the tangent is the next piece's)
      Vec3 tg = ec.tangent(t);
      double tn = cadgeom::norm(tg);
      if (tn > 0) tangents.push_back((1 / tn) * tg);
    }
    r.angle = std::fmax(r.angle, turn(tangents));
    tangents.clear();
    r.longest = std::fmax(r.longest, len);
    r.spans++;
  }
  return r;
}

/** The surface's first fundamental form over h^2, and a triangle accepted where its middle is within d of S. */
struct Field : SizeField {
  const cadgeom::Surface& s;
  double h, d;
  Field(const cadgeom::Surface& surface, double size, double dev) : s(surface), h(size), d(dev) {}
  Vec3 at(Vec2 p) const {
    cadgeom::SurfacePoint q;
    s.eval(p.x, p.y, 0, q);
    return q.p;
  }
  Metric2 metric(Vec2 p) const override {
    cadgeom::SurfacePoint q;
    s.eval(p.x, p.y, 1, q);
    // (At a pole S_u vanishes: a floor keeps the metric positive definite.)
    double a = std::fmax(cadgeom::dot(q.du, q.du), 1e-6), b = cadgeom::dot(q.du, q.dv);
    double c = std::fmax(cadgeom::dot(q.dv, q.dv), 1e-6);
    return {a / (h * h), b / (h * h), c / (h * h)};
  }
  bool accept(const Vec2 t[3]) const override {
    Vec3 a = at(t[0]), b = at(t[1]), c = at(t[2]);
    Vec3 mid = at({(t[0].x + t[1].x + t[2].x) / 3, (t[0].y + t[1].y + t[2].y) / 3});
    return cadgeom::norm(mid - (1.0 / 3) * (a + b + c)) <= d;
  }
};

/** A face's boundary as a Domain2 (every loop, interior chains as segments or points), with each point's 3D. */
Domain2 domainOf(const FaceBoundary& fb) {
  Domain2 d;
  for (const auto& l : fb.loops) {
    std::vector<int32_t> loop;
    for (const BoundaryPoint& p : l) loop.push_back(static_cast<int32_t>(d.points.size())), d.points.push_back(p.uv);
    d.loops.push_back(loop);
  }
  for (const auto& c : fb.interior) {
    int32_t first = static_cast<int32_t>(d.points.size());
    for (const BoundaryPoint& p : c) d.points.push_back(p.uv);
    for (int32_t i = 0; i + 1 < static_cast<int32_t>(c.size()); i++)
      d.segments.insert(d.segments.end(), {first + i, first + i + 1});
  }
  return d;
}

/** The face meshed in its (u, v) at size h; its 3D area (and whether the mesher was content). */
double meshArea(const cadgeom::Model& m, int f, const FaceBoundary& fb, double h, double dev, Mesh2* out = nullptr) {
  cadgeom::Status st;
  // (The surface as it closes in fact, as the face's: a boundary a period off its own range lands on it.)
  std::unique_ptr<cadgeom::Surface> s = closedSurface(m, cadgeom::Tolerances(m), f, st);
  Field field(*s, h, dev);
  Mesh2 mesh = mesh2(domainOf(fb), field);
  double area = 0;
  for (size_t t = 0; t + 2 < mesh.triangles.size(); t += 3) {
    Vec3 a = field.at(mesh.points[mesh.triangles[t]]), b = field.at(mesh.points[mesh.triangles[t + 1]]);
    Vec3 c = field.at(mesh.points[mesh.triangles[t + 2]]);
    area += 0.5 * cadgeom::norm(cadgeom::cross(b - a, c - a));
  }
  if (out) *out = mesh;
  return mesh.status == cadgeom::Status::ok ? area : -1;
}

/** Every edge's samples within the options; returns failures. */
int checkEdges(const cadgeom::Model& m, const EdgeMesh& em, const EdgeOptions& o, const char* what) {
  int bad = 0;
  for (int e = 0; e < m.edges(); e++) {
    const EdgeSamples& s = em.edge(e);
    if (s.status != cadgeom::Status::ok || s.t.size() < 2) {
      std::printf("  %s: edge %d status %d, %zu samples\n", what, e, int(s.status), s.t.size());
      bad++;
      continue;
    }
    Measured r = measure(m, e, s, o.deflection);
    bool ok = r.excess <= 1e-12 && r.longest <= o.maxSpacing * (1 + 1e-9) &&
      (o.angle == 0 || r.angle <= o.angle * (1 + 1e-9));
    if (!ok) {
      std::printf("  %s: edge %d excess %g longest %g angle %g\n", what, e, r.excess, r.longest, r.angle);
      bad++;
    }
  }
  return bad;
}

/** Every coedge's (u, v) on the surface at its edge's points, within `gap`. */
int checkCoedges(const cadgeom::Model& m, const EdgeMesh& em, double gap, const char* what) {
  int bad = 0;
  for (int f = 0; f < m.faces(); f++) {
    cadgeom::Status st;
    std::unique_ptr<cadgeom::Surface> s = closedSurface(m, cadgeom::Tolerances(m), f, st);
    for (int i = 0; i < m.faceLoopCount(f); i++) {
      int l = m.faceFirstLoop(f) + i;
      if (m.loopKind(l) != CBR_LOOP_EDGE) continue;
      for (int k = 0; k < m.loopCount(l); k++) {
        int c = m.loopFirst(l) + k;
        const CoedgeSamples& cs = em.coedge(c);
        const EdgeSamples& es = em.edge(m.coedgeEdge(c));
        bool reversed = m.coedgeOrientation(c) == CBR_ORIENTATION_REVERSED;
        double worst = 0;
        for (size_t j = 0; j < cs.uv.size(); j++) {
          size_t want = reversed ? es.t.size() - 1 - j : j;
          if (cs.index[j] != static_cast<int32_t>(want)) worst = 1e300;
          cadgeom::SurfacePoint q;
          s->eval(cs.uv[j].x, cs.uv[j].y, 0, q);
          worst = std::fmax(worst, cadgeom::norm(q.p - es.points[cs.index[j]]));
        }
        if (cs.uv.size() != es.t.size() || worst > gap || std::fabs(worst - cs.gap) > 1e-12) {
          std::printf("  %s: coedge %d off by %g (gap %g)\n", what, c, worst, cs.gap);
          bad++;
        }
      }
    }
  }
  return bad;
}

} // namespace

TEST_CASE("the cube: twelve lines, each one span, shared by its two faces' loops; the squares meshed to their area") {
  cadgeom::Model m = load("cube");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 0.01;
  EdgeMesh em(m, o);
  CHECK_EQ(checkEdges(m, em, o, "cube"), 0);
  CHECK_EQ(checkCoedges(m, em, 1e-12, "cube"), 0);
  for (int e = 0; e < m.edges(); e++) CHECK_EQ(em.edge(e).t.size(), 2u);
  CHECK_EQ(em.edgeCount(), m.edges());
  // A spacing limit splits the lines evenly: a unit line at 0.3, 4 spans.
  o.maxSpacing = 0.3;
  EdgeMesh fine(m, o);
  CHECK_EQ(checkEdges(m, fine, o, "cube 0.3"), 0);
  for (int f = 0; f < m.faces(); f++) {
    FaceBoundary fb = fine.face(f);
    REQUIRE(fb.status == cadgeom::Status::ok);
    CHECK_EQ(fb.loops.size(), 1u);
    double area = meshArea(m, f, fb, 0.3, 1e-3);
    CHECK(std::fabs(area - 1) < 1e-12);
  }
}

TEST_CASE("curves: circles, a B-spline, a helix with no 3D curve, within the deflection, the spacing and the angle") {
  for (const char* name : {"seamCylinder", "splineEdge", "pcurveOnly", "everyKind", "polylineEdge", "pcurveCircle",
         "arcSegment"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    for (double d : {1e-2, 1e-4}) {
      EdgeOptions o;
      o.deflection = d;
      EdgeMesh em(m, o);
      CHECK_EQ(checkEdges(m, em, o, name), 0);
      o.maxSpacing = 0.2;
      o.angle = 0.1;
      EdgeMesh lim(m, o);
      CHECK_EQ(checkEdges(m, lim, o, name), 0);
    }
  }
  // The circle of radius 2 at deflection 1e-4: chords of at most sqrt(8 r d) = 0.04, so at least 4 pi / 0.04 spans;
  // the bounds are no worse than twice that.
  cadgeom::Model m = load("seamCylinder");
  EdgeOptions o;
  o.deflection = 1e-4;
  EdgeMesh em(m, o);
  size_t n = em.edge(0).t.size() - 1;
  CHECK(n >= 315 && n <= 630);
}

TEST_CASE("near a zero-speed point the curve doesn't report: no span refined below 10 x the tolerance") {
  // nearCusp6: a cubic whose speed nearly vanishes at t = 0.5 (cuspEdge's cusp, a pole moved 1e-6), where the
  // angle's speed bound shrinks towards 0; at the angle alone the samples stop at the floor, no two closer than the
  // tolerance (1e-6, the part giving none), within the deflection; cuspEdge's exact cusp, which the curve reports,
  // likewise.
  for (const char* name : {"nearCusp6", "cuspEdge"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 1e-2;
    o.angle = 0.26;
    EdgeMesh em(m, o);
    const EdgeSamples& s = em.edge(0);
    REQUIRE(s.status == cadgeom::Status::ok);
    double shortest = INFINITY;
    for (size_t i = 0; i + 1 < s.points.size(); i++)
      shortest = std::fmin(shortest, cadgeom::norm(s.points[i + 1] - s.points[i]));
    if (!(shortest >= 1e-6) || s.t.size() > 120) std::printf("  %s: %zu samples, shortest %g\n", name, s.t.size(),
      shortest);
    CHECK(shortest >= 1e-6);
    CHECK(s.t.size() <= 120);
    // The exact cusp, reported, isn't refined for the angle at all (36 samples; down to the floor, 75).
    if (std::strcmp(name, "cuspEdge") == 0) CHECK(s.t.size() <= 50);
    CHECK(measure(m, 0, s, o.deflection).excess <= 1e-12);
  }
}

TEST_CASE("the angle alone, closed edges in 3 spans at least, the faces' spacing on their edges") {
  cadgeom::Model m = load("seamCylinder");
  REQUIRE(m.ok());
  // Deflection 1 asks for little; the angle 0.05: an arc's tangent turns by its angle, so a circle needs at least
  // 2 pi / 0.05 spans.
  EdgeOptions o;
  o.deflection = 1;
  o.angle = 0.05;
  EdgeMesh em(m, o);
  CHECK_EQ(checkEdges(m, em, o, "angle"), 0);
  CHECK(em.edge(0).t.size() - 1 >= 126u);
  CHECK(em.edge(0).t.size() - 1 <= 140u);
  // The angle 0.01 at deflection 1: 628 spans by the angle, but none refined below the refinement floor (0.1 here):
  // about 2 pi 2 / 0.1 spans, the turn across each about 0.05.
  o.angle = 0.01;
  EdgeMesh floored(m, o);
  CHECK(floored.edge(0).t.size() - 1 <= 140u);
  CHECK(floored.edge(0).t.size() - 1 >= 120u);
  // Deflection 100 asks for nothing: a closed circle still 3 spans, the seam 1.
  o = {};
  o.deflection = 100;
  EdgeMesh coarse(m, o);
  CHECK_EQ(coarse.edge(0).t.size(), 4u);
  CHECK_EQ(coarse.edge(1).t.size(), 4u);
  CHECK_EQ(coarse.edge(2).t.size(), 2u);
  // A face's spacing limits its edges as maxSpacing would.
  o.deflection = 1e-2;
  EdgeMesh spaced(m, o, {0.3});
  EdgeOptions as = o;
  as.maxSpacing = 0.3;
  CHECK_EQ(checkEdges(m, spaced, as, "face spacing"), 0);
  CHECK(spaced.edge(2).t.size() - 1 >= 17u);
}

TEST_CASE("the angle is the tangent's turn across a span: a 0.5 mm hole at medium, an S-bend") {
  // Medium's 0.1 mm and 15 degrees on a circle of radius 0.25: the deflection allows chords of 107 degrees, the
  // turn 15, so 24 spans at least; the bound's room (2 sin(a / 2) of the speed, not a) and the 3 spans a closed edge
  // starts from make it 27.
  {
    cadgeom::Model m = load("smallHole");
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 0.1;
    o.angle = 15 * M_PI / 180;
    EdgeMesh em(m, o);
    CHECK_EQ(checkEdges(m, em, o, "smallHole"), 0);
    size_t n = em.edge(0).t.size() - 1;
    if (n < 24 || n > 28) std::printf("  smallHole: %zu spans\n", n);
    CHECK(n >= 24 && n <= 28);
  }
  // The S-bend's tangents at its ends lie along its chord: measured densely here, the one chord's largest angle to the
  // tangent is under the angle asked for and the tangent's whole turn over it, so a chord-to-tangent rule would keep
  // the bend as one span; the turn splits it.
  cadgeom::Model m = load("sBend");
  REQUIRE(m.ok());
  EdgeCurve ec(m, 0);
  Vec3 chord = ec.at(1) - ec.at(0);
  std::vector<Vec3> tangents;
  double toChord = 0;
  for (int k = 0; k <= 400; k++) {
    Vec3 tg = ec.tangent(k / 400.0);
    tg = (1 / cadgeom::norm(tg)) * tg;
    tangents.push_back(tg);
    toChord = std::fmax(toChord, std::acos(std::clamp(cadgeom::dot(tg, chord) / cadgeom::norm(chord), -1.0, 1.0)));
  }
  double whole = turn(tangents);
  REQUIRE(whole > 1.5 * toChord);
  EdgeOptions o;
  o.deflection = 10;
  o.angle = (toChord + whole) / 2;
  EdgeMesh em(m, o);
  CHECK_EQ(checkEdges(m, em, o, "sBend"), 0);
  CHECK(em.edge(0).t.size() >= 3u);
  // At 15 degrees, as many spans as its total turning needs, within 3 x (the bound's check counts its speed changing
  // too, as an arc's doesn't; pieces counted by the bound over the long first span are 3 times as many again).
  double total = 0;
  for (size_t i = 0; i + 1 < tangents.size(); i++)
    total += std::acos(std::clamp(cadgeom::dot(tangents[i], tangents[i + 1]), -1.0, 1.0));
  o.angle = 15 * M_PI / 180;
  EdgeMesh at15(m, o);
  CHECK_EQ(checkEdges(m, at15, o, "sBend at 15"), 0);
  size_t need = static_cast<size_t>(std::ceil(total / o.angle)), spans = at15.edge(0).t.size() - 1;
  if (spans < need || spans > 3 * need) std::printf("  sBend at 15: %zu spans, its turning needs %zu\n", spans, need);
  CHECK(spans >= need && spans <= 3 * need);
}

TEST_CASE("a span over a pole: a sample where its foot is the pole, the loop across the pole line the face's way") {
  // offPoleArc's arc lies 7e-4 inside its sphere, under the north pole at its middle: whatever the sampling, a
  // sample on the axis (its foot the pole), so the loop crosses the pole line; offPoleRest, the rest of the sphere,
  // then winds and is cut to the south pole. By inversion at uncertainty 1e-5 (no p-curve within it); projected at
  // 1e-3 (the Loose ones), the pole the projection's cut a sample.
  for (const char* name : {"offPoleArc", "offPoleRest", "offPoleArcLoose", "offPoleRestLoose"})
    for (double d : {0.1, 0.05, 0.03, 0.01})
      for (double a : {0.0, 0.26, 0.2}) {
        cadgeom::Model m = load(name);
        REQUIRE(m.ok());
        EdgeOptions o;
        o.deflection = d;
        o.angle = a;
        EdgeMesh em(m, o);
        bool onAxis = false;
        for (Vec3 p : em.edge(0).points) onAxis = onAxis || std::hypot(p.x, p.y) < 1e-9;
        FaceBoundary fb = em.face(0);
        bool cut = false;
        for (const auto& l : fb.loops)
          for (const BoundaryPoint& p : l) cut = cut || p.kind == BoundaryPoint::pseudoSample;
        bool want = std::strstr(name, "offPoleRest") == name, loose = std::strstr(name, "Loose") != nullptr;
        bool projected = false;
        for (int c = 0; c < m.coedges(); c++)
          if (m.coedgeEdge(c) == 0) projected = projected || em.coedge(c).projected;
        if (!onAxis || fb.status != cadgeom::Status::ok || cut != want || projected != loose)
          std::printf("  %s at %g, %g: on the axis %d, status %d, cut %d, projected %d\n", name, d, a, onAxis,
            int(fb.status), cut, projected);
        CHECK(onAxis);
        CHECK(fb.status == cadgeom::Status::ok);
        CHECK(cut == want);
        CHECK(projected == loose);
        // Projected, the pole a sample at the projection's own cut there (the arc's parameter pi / 2, exactly).
        if (loose) {
          bool atCut = false;
          for (double t : em.edge(0).t) atCut = atCut || t == M_PI / 2;
          CHECK(atCut);
        }
      }
  // A circle round a pole, not over it, in 3 spans (deflection 100): its jumps a third of the period each, none of its
  // spans' feet at the pole, no sample added for one (the 5th the cut's crossing).
  cadgeom::Model m = load("cap");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 100;
  EdgeMesh em(m, o);
  CHECK_EQ(em.edge(0).t.size(), 5u);
}

TEST_CASE("a vertex off its curves: the end spans within the deflection plus its gap, the uses' gaps reported") {
  cadgeom::Model m = load("offVertex");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 1e-4;
  EdgeMesh em(m, o);
  CHECK_EQ(checkEdges(m, em, o, "offVertex"), 0);
  // The corner's point is the vertex's, 1e-3 above both lines' ends; the plane's uses see that as their gap.
  CHECK(em.edge(1).points.back().z == 1e-3 && em.edge(2).points.front().z == 1e-3);
  Measured r = measure(m, 1, em.edge(1), o.deflection);
  CHECK(r.deviation > o.deflection);  // the gap, not the curve
  CHECK(r.deviation <= o.deflection + 1e-3 + 1e-15);
  CHECK_EQ(checkCoedges(m, em, 1e-3 + 1e-12, "offVertex"), 0);
  CHECK(std::fabs(em.coedge(1).gap - 1e-3) < 1e-15);
  CHECK(em.coedge(0).gap == 0);
}

TEST_CASE("a seam: two copies of one edge's samples at u = 0 and 2 pi, by p-curves or by inversion; a valid domain") {
  for (const char* name : {"seamCylinder", "seamByInversion"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 1e-3;
    o.maxSpacing = 0.25;
    EdgeMesh em(m, o);
    CHECK_EQ(checkEdges(m, em, o, name), 0);
    CHECK_EQ(checkCoedges(m, em, 1e-9, name), 0);
    FaceBoundary fb = em.face(0);
    REQUIRE(fb.status == cadgeom::Status::ok);
    REQUIRE(fb.loops.size() == 1u);
    // The seam's samples twice, once at each u, the same 3D points; no cut (the seam is the face's own).
    std::set<double> seamU;
    int seamPoints = 0, pseudo = 0;
    for (const BoundaryPoint& p : fb.loops[0]) {
      pseudo += p.kind != BoundaryPoint::edgeSample;
      if (p.edgeIndex == 2 && p.sample > 0 && p.sample + 1 < static_cast<int>(em.edge(2).t.size())) {
        seamU.insert(std::round(p.uv.x * 1e9) / 1e9), seamPoints++;
      }
    }
    CHECK_EQ(pseudo, 0);
    CHECK_EQ(em.edgeCount(), m.edges());
    CHECK(seamU.size() == 2u && seamU.count(0) && seamU.count(std::round(2 * M_PI * 1e9) / 1e9));
    CHECK_EQ(seamPoints, 2 * (static_cast<int>(em.edge(2).t.size()) - 2));
    double area = meshArea(m, 0, fb, 0.25, 1e-3);
    CHECK(area < 20 * M_PI && area > 20 * M_PI * (1 - 1e-3));
  }
}

TEST_CASE("a vertex's foot per use: a seam vertex's copy on its next sample's side, a pole's free coordinate its") {
  // seamByInversion's vertex on the seam is used by both of the seam's copies and by both circles (each closed at
  // it), none with a p-curve: each use's ends at the copy its next sample continues on, no period between them.
  {
    cadgeom::Model m = load("seamByInversion");
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 1e-3;
    EdgeMesh em(m, o);
    int ends = 0;
    for (int c = 0; c < m.coedges(); c++) {
      const CoedgeSamples& s = em.coedge(c);
      REQUIRE(s.status == cadgeom::Status::ok);
      REQUIRE(s.uv.size() >= 2u);
      const size_t n = s.uv.size();
      for (auto [a, b] : {std::pair{s.uv[0], s.uv[1]}, std::pair{s.uv[n - 1], s.uv[n - 2]}}) {
        if (std::fabs(a.x - b.x) > 1) std::printf("  coedge %d: end at u %g, next at %g\n", c, a.x, b.x);
        CHECK(std::fabs(a.x - b.x) < 1);
        ends++;
      }
    }
    CHECK_EQ(ends, 2 * m.coedges());
  }
  // uFoldVertex's vertex has two feet, one on each arm of the U (u in [0, 1] and [2, 3]), the nearer on the other
  // arm: the use's ends on its own arm, by its next samples.
  {
    cadgeom::Model m = load("uFoldVertex");
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 1e-2;
    EdgeMesh em(m, o);
    const CoedgeSamples& s = em.coedge(0);
    REQUIRE(s.status == cadgeom::Status::ok);
    const size_t n = s.uv.size();
    REQUIRE(n >= 3u);
    for (size_t i : {size_t(0), n - 1}) {
      if (!(s.uv[i].x < 1)) std::printf("  uFoldVertex: end %zu at u %g\n", i, s.uv[i].x);
      CHECK(s.uv[i].x < 1);
    }
  }
  // pcurveOnlyWest's helix has only its p-curve, ending at the seam vertex's copy u = 2 pi, its range by inversion:
  // its parameters there of the copy the p-curve passes, 0 to its length.
  {
    cadgeom::Model m = load("pcurveOnlyWest");
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 1e-3;
    EdgeMesh em(m, o);
    CHECK_EQ(checkEdges(m, em, o, "pcurveOnlyWest"), 0);
    CHECK_EQ(checkCoedges(m, em, 1e-9, "pcurveOnlyWest"), 0);
    const EdgeSamples& h = em.edge(2);
    REQUIRE(h.status == cadgeom::Status::ok);
    const double len = std::hypot(M_PI / 2, 2);
    if (!(std::fabs(h.t.front()) < 1e-9 && std::fabs(h.t.back() - len) < 1e-9))
      std::printf("  pcurveOnlyWest: t %g to %g\n", h.t.front(), h.t.back());
    CHECK(std::fabs(h.t.front()) < 1e-9);
    CHECK(std::fabs(h.t.back() - len) < 1e-9);
    CHECK(em.face(0).status == cadgeom::Status::ok);
  }
  // meridianHemisphere's vertex is the south pole, its great circle there at both ends: its free coordinate (u)
  // there the next sample's, by continuation.
  {
    cadgeom::Model m = load("meridianHemisphere");
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 1e-3;
    EdgeMesh em(m, o);
    const CoedgeSamples& s = em.coedge(0);
    REQUIRE(s.status == cadgeom::Status::ok);
    const size_t n = s.uv.size();
    REQUIRE(n >= 3u);
    CHECK(std::fabs(s.uv[0].y + M_PI / 2) < 1e-9);
    CHECK(std::fabs(s.uv[n - 1].y + M_PI / 2) < 1e-9);
    CHECK(std::fabs(s.uv[0].x - s.uv[1].x) < 1e-9);
    CHECK(std::fabs(s.uv[n - 1].x - s.uv[n - 2].x) < 1e-9);
  }
}

TEST_CASE("no fold judged between points within the tolerance: a meridian's sample at the pole beside its pole line") {
  // The south vertex 1e-11 off the pole either way across either meridian, so the 3D turn at a meridian's sample
  // beside the pole line's point (after it, or before) is rounding of either sign: no fold.
  for (const char* name : {"luneOffPole", "luneOffPoleBack", "luneOffPoleC", "luneOffPoleCBack"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 1e-2;
    EdgeMesh em(m, o);
    const FaceBoundary fb = em.face(0);
    REQUIRE(fb.status == cadgeom::Status::ok);
    if (fb.foldsRepaired) std::printf("  %s: %d folds repaired\n", name, fb.foldsRepaired);
    CHECK_EQ(fb.foldsRepaired, 0);
  }
}

TEST_CASE("a band with no seam edge: one cut, a pseudo-edge used both ways, away from the circles' vertex") {
  for (const char* name : {"band", "bandByInversion"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 1e-3;
    o.maxSpacing = 0.25;
    EdgeMesh em(m, o, {0.2});
    CHECK_EQ(checkEdges(m, em, o, name), 0);
    CHECK_EQ(checkCoedges(m, em, 1e-9, name), 0);
    REQUIRE(em.edgeCount() == m.edges() + 1);
    CHECK(em.isPseudo(m.edges()) && !em.isPseudo(m.edges() - 1));
    const EdgeSamples& cut = em.edge(m.edges());
    REQUIRE(cut.status == cadgeom::Status::ok);
    // From the bottom circle to the top, at the face's spacing (5 / 0.2: 25 spans, 26 where the bound on |S_v| is
    // a rounding over 1), its ends on the circles' samples.
    CHECK(cut.t.size() == 26u || cut.t.size() == 27u);
    CHECK(cut.points.front().z == 0 && std::fabs(cut.points.back().z - 5) < 1e-12);
    // Not at u = 0 (the circles' vertex is there): at the middle of the widest gap between the circles' samples,
    // here the middle of a span of both.
    double u = std::atan2(cut.points[1].y, cut.points[1].x);
    if (u < 0) u += 2 * M_PI;
    CHECK(std::fabs(u) > 1e-3);
    // (The crossing is a sample of the circle now: the others, its spans as sampled before it.)
    const EdgeSamples& bottom = em.edge(0);
    double nearest = 1e9, span = 2 * M_PI / (static_cast<double>(bottom.t.size()) - 2);
    for (double t : bottom.t) {
      double x = std::fabs(std::fmod(t + 2 * M_PI, 2 * M_PI) - u);
      if (x > 1e-9) nearest = std::fmin(nearest, x);
    }
    CHECK(nearest > 0.45 * span && nearest < 0.55 * span);
    FaceBoundary fb = em.face(0);
    REQUIRE(fb.status == cadgeom::Status::ok);
    REQUIRE(fb.loops.size() == 1u);
    int pseudo = 0;
    for (const BoundaryPoint& p : fb.loops[0]) {
      pseudo += p.kind == BoundaryPoint::pseudoSample;
      if (p.kind == BoundaryPoint::pseudoSample) CHECK_EQ(p.edgeIndex, m.edges());
    }
    CHECK_EQ(pseudo, 2 * (static_cast<int>(cut.t.size()) - 2));
    double area = meshArea(m, 0, fb, 0.25, 1e-3);
    CHECK(area < 20 * M_PI && area > 20 * M_PI * (1 - 1e-3));
  }
}

TEST_CASE("a step of half a period between samples (a semicircle's ends alone): which way decided at its middle") {
  // Each arc one span: by p-curves (theirs, a period apart), projected and by inversion, across the seam and away
  // from it, the loop runs half a period in u and back (no winding, no cut), counterclockwise round the half the
  // face is: (u, v) area pi h = 4 pi. (Not meshed: one span per arc, its chord a fixed segment.)
  struct Case {
    const char* model;
    bool project;
  };
  for (Case c : {Case{"halfCylinderPcurves", true}, Case{"halfCylinderApart", true}, Case{"halfCylinderBare", true},
         Case{"halfCylinderBare", false}, Case{"halfCylinderWest", true}, Case{"halfCylinderWest", false}}) {
    cadgeom::Model m = load(c.model);
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 3;
    o.projectMissingPcurves = c.project;
    EdgeMesh em(m, o);
    REQUIRE(em.edge(0).t.size() == 2u && em.edge(1).t.size() == 2u);
    CHECK_EQ(checkEdges(m, em, o, c.model), 0);
    CHECK_EQ(checkCoedges(m, em, 1e-9, c.model), 0);
    CHECK_EQ(em.edgeCount(), m.edges());
    FaceBoundary fb = em.face(0);
    if (fb.status != cadgeom::Status::ok) std::printf("  %s (%d): %s\n", c.model, c.project, fb.cause.c_str());
    CHECK(fb.status == cadgeom::Status::ok);
    REQUIRE(fb.loops.size() == 1u);
    double lo = INFINITY, hi = -INFINITY, area = 0;
    const std::vector<BoundaryPoint>& l = fb.loops[0];
    for (size_t i = 0; i < l.size(); i++) {
      Vec2 a = l[i].uv, b = l[(i + 1) % l.size()].uv;
      lo = std::fmin(lo, a.x), hi = std::fmax(hi, a.x), area += 0.5 * (a.x * b.y - b.x * a.y);
    }
    CHECK(std::fabs(hi - lo - M_PI) < 1e-9);
    if (std::fabs(area - 4 * M_PI) >= 1e-9) std::printf("  %s (%d): (u, v) area %.9g\n", c.model, c.project, area);
    CHECK(std::fabs(area - 4 * M_PI) < 1e-9);
    // Its middle in u the half's: x = 2 across the seam (u = 0), x = -2 away from it (u = pi).
    cadgeom::Status st;
    std::unique_ptr<cadgeom::Surface> s = cadgeom::makeSurface(m, m.faceSurface(0), st);
    cadgeom::SurfacePoint q;
    s->eval(0.5 * (lo + hi), 1, 0, q);
    CHECK((q.p.x > 1.9) == (std::strcmp(c.model, "halfCylinderWest") != 0));
  }
}

TEST_CASE("a cut crossing a loop in its closing span, an edge whose two samples are junctions: found on that edge") {
  // arcBand: the cut at the widest gap's middle, u = 1.7 pi, inside each loop's closing arc (edges 2 and 4, one
  // span each), whose ends the loop gives as other edges' samples (the bottom's: edges 1 and 0; the top's: 3 twice).
  cadgeom::Model m = load("arcBand");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 1;
  o.maxSpacing = 3.8;
  EdgeMesh em(m, o);
  CHECK_EQ(checkEdges(m, em, o, "arcBand"), 0);
  FaceBoundary fb = em.face(0);
  if (fb.status != cadgeom::Status::ok) std::printf("  arcBand: %s\n", fb.cause.c_str());
  CHECK(fb.status == cadgeom::Status::ok);
  REQUIRE(em.edgeCount() == m.edges() + 1);
  // Each closing arc's crossing a sample of it, between its ends.
  for (int e : {2, 4}) {
    const EdgeSamples& s = em.edge(e);
    REQUIRE(s.t.size() == 3u);
    CHECK(std::fabs(s.t[1] - 1.7 * M_PI) < 1e-9);
  }
  // Cut open, one loop round the band in (u, v): area 2 pi x 5. (Not meshed: the closing arcs' chords are fixed.)
  REQUIRE(fb.loops.size() == 1u);
  double area = 0;
  const std::vector<BoundaryPoint>& l = fb.loops[0];
  for (size_t i = 0; i < l.size(); i++) {
    Vec2 a = l[i].uv, b = l[(i + 1) % l.size()].uv;
    area += 0.5 * (a.x * b.y - b.x * a.y);
  }
  CHECK(std::fabs(area - 10 * M_PI) < 1e-9);
}

TEST_CASE("an apex within the tolerance: a projected use's samples there take the nearest regular sample's u") {
  // spindleApex: its lines end 0.005 across the axis from the apex, their last points' feet across it (u half a turn
  // round); those points are at the apex within the tolerance (0.2), so their u is arbitrary: the nearest sample's
  // beyond it along the use, up to periods, projected as by inversion. The face winds round nothing: no cut.
  for (bool project : {true, false}) {
    cadgeom::Model m = load("spindleApex");
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 0.1;
    o.projectMissingPcurves = project;
    EdgeMesh em(m, o);
    const Vec3 apex{0, 0, 20 * std::sin(2 * M_PI / 3)};
    int at = 0;
    for (int c = 0; c < m.coedges(); c++) {
      const CoedgeSamples& s = em.coedge(c);
      const EdgeSamples& es = em.edge(m.coedgeEdge(c));
      if (project) CHECK(s.projected);
      auto near = [&](size_t i) { return cadgeom::norm(es.points[s.index[i]] - apex) <= 0.2; };
      for (size_t i = 0; i < s.uv.size(); i++) {
        if (!near(i)) continue;
        at++;
        size_t j = i;
        for (size_t k = 1; k < s.uv.size() && j == i; k++) {
          if (i + k < s.uv.size() && !near(i + k)) j = i + k;
          else if (i >= k && !near(i - k)) j = i - k;
        }
        REQUIRE(j != i);
        double du = std::remainder(s.uv[i].x - s.uv[j].x, 2 * M_PI);
        if (std::fabs(du) > 1e-9)
          std::printf("  spindleApex (%d): coedge %d sample %zu u off by %.6g\n", project, c, i, du);
        CHECK(std::fabs(du) <= 1e-9);
      }
    }
    CHECK(at >= (project ? 4 : 2));  // (the lines' ends; projected, the pole's sample on each too)
    FaceBoundary fb = em.face(0);
    CHECK(fb.status == cadgeom::Status::ok);
    CHECK_EQ(em.edgeCount(), m.edges());
  }
}

TEST_CASE("poles: a hemisphere's vertex loop, a cap with none, a lune's jumps; meshed to their areas") {
  struct Case {
    const char* model;
    int face;
    double area;
  };
  // The hemisphere 2 pi; the cap over latitude pi / 4, 2 pi (1 - sin(pi / 4)); the quarter lune 2 (pi / 2). (A
  // cone's apex waits for cad-geom's cones.)
  for (Case c : {Case{"spheres", 1, 2 * M_PI}, Case{"cap", 0, 2 * M_PI * (1 - M_SQRT1_2)},
         Case{"luneQuarter", 0, M_PI}}) {
    cadgeom::Model m = load(c.model);
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 1e-3;
    o.maxSpacing = 0.1;
    EdgeMesh em(m, o);
    CHECK_EQ(checkEdges(m, em, o, c.model), 0);
    CHECK_EQ(checkCoedges(m, em, 1e-9, c.model), 0);
    FaceBoundary fb = em.face(c.face);
    if (fb.status != cadgeom::Status::ok) std::printf("  %s: face status %d\n", c.model, int(fb.status));
    CHECK(fb.status == cadgeom::Status::ok);
    REQUIRE(fb.loops.size() == 1u);
    int pole = 0;
    for (const BoundaryPoint& p : fb.loops[0]) pole += p.kind == BoundaryPoint::poleLine;
    CHECK(pole >= 1);
    Mesh2 mesh;
    double area = meshArea(m, c.face, fb, 0.1, 1e-3, &mesh);
    if (!(area < c.area && area > c.area * (1 - 2e-3)))
      std::printf("  %s: area %.9g want %.9g (status %d)\n", c.model, area, c.area, int(mesh.status));
    CHECK(area < c.area && area > c.area * (1 - 2e-3));
  }
}

TEST_CASE("edges with no 3D curve, a slit inside, an arc through 0 with no range: the faces' areas") {
  EdgeOptions o;
  o.deflection = 1e-4;
  // The disc by its p-curve-only circle, less its chords' segments; the slit an interior chain of its samples.
  cadgeom::Model d = load("pcurveCircle");
  REQUIRE(d.ok());
  EdgeMesh ed(d, o);
  CHECK_EQ(checkEdges(d, ed, o, "pcurveCircle"), 0);
  FaceBoundary fd = ed.face(0);
  REQUIRE(fd.status == cadgeom::Status::ok);
  REQUIRE(fd.interior.size() == 1u);
  CHECK(fd.interior[0].size() >= 2u);
  CHECK(std::fabs(fd.interior[0].front().uv.x + 0.3) < 1e-12 && std::fabs(fd.interior[0].back().uv.x - 0.3) < 1e-12);
  double area = meshArea(d, 0, fd, 0.2, 1e-3);
  CHECK(area < M_PI && area > M_PI * (1 - 1e-3));
  // The arc from -pi / 4 to pi / 4: through 0, its range found from its vertices the short way.
  cadgeom::Model a = load("arcSegment");
  REQUIRE(a.ok());
  EdgeMesh ea(a, o);
  CHECK_EQ(checkEdges(a, ea, o, "arcSegment"), 0);
  double seg = (M_PI / 2 - 1) / 2, got = meshArea(a, 0, ea.face(0), 0.1, 1e-3);
  CHECK(got < seg && got > seg * (1 - 1e-2));
}

TEST_CASE("a projected closed edge on a surface closed in fact within its tolerance: its use closes in (u, v)") {
  // tubeGapUncertainty: open at its seam by 5e-4, closed in fact within 1e-3, no p-curves. Each circle's projection
  // ends within tol of its vertex's foot, not on it (u 3.9998 for 4): its ends at the vertex's foot, a period apart
  // exactly, or the loop doesn't close.
  cadgeom::Model m = load("tubeGapUncertainty");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 0.05;
  EdgeMesh em(m, o);
  for (int c = 0; c < m.coedges(); c++) {
    const CoedgeSamples& s = em.coedge(c);
    REQUIRE(s.projected);
    CHECK_EQ(std::fabs(s.uv.back().x - s.uv.front().x), 4.0);
    CHECK_EQ(s.uv.back().y, s.uv.front().y);
  }
}

TEST_CASE("a seam use by inversion that no neighbour places: Status::singular, not a guess") {
  cadgeom::Model m = load("luneOnSeam");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 1e-3;
  o.projectMissingPcurves = false;
  EdgeMesh em(m, o);
  CHECK_EQ(checkEdges(m, em, o, "luneOnSeam"), 0);
  CHECK(em.face(0).status == cadgeom::Status::singular);
  // Placed by its neighbours but on the wrong side for its direction and the face's sense: singular too.
  cadgeom::Model f = load("seamFlipped");
  REQUIRE(f.ok());
  EdgeMesh ef(f, o);
  CHECK(ef.face(0).status == cadgeom::Status::singular);
  CHECK(EdgeMesh(load("seamByInversion"), o).face(0).status == cadgeom::Status::ok);
  // Projected, each seam use takes the copy its direction and the face's sense give (seamUseTakesTwin): the lune's
  // placed; the flipped face's too, meshed as the face's sense has it, its loop reported against the face's sense
  // (the valid ones not).
  o.projectMissingPcurves = true;
  EdgeMesh pm(m, o);
  CHECK_EQ(checkEdges(m, pm, o, "luneOnSeam projected"), 0);
  CHECK(pm.face(0).status == cadgeom::Status::ok);
  CHECK(!pm.face(0).againstSense);
  FaceBoundary flipped = EdgeMesh(f, o).face(0);
  CHECK(flipped.status == cadgeom::Status::ok);
  CHECK(flipped.againstSense);
  FaceBoundary valid = EdgeMesh(load("seamByInversion"), o).face(0);
  CHECK(valid.status == cadgeom::Status::ok);
  CHECK(!valid.againstSense);
}

TEST_CASE("a split in an edge's end span kept past the near-end drop (min(tol, d / 10) of the end), toward the span's "
  "other sample; in an end span with no room for one, dropped") {
  // (d = 10 tol: the reach, min(tol, d / 10), and the refinement floor, max(tol, d / 10), the same, so a span past
  // the floor may still have its middle within the reach: trj6 pm4-ec-203's tori, tol 0.01 at d 0.1.)
  cadgeom::Model m = load("cube");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 10 * cadgeom::Tolerances(m).part();
  o.maxSpacing = 0.25;
  EdgeMesh em(m, o);
  const int e = 0;
  const double within = std::fmin(cadgeom::Tolerances(m).part(), 0.1 * o.deflection);
  const Vec3 end = em.edge(e).points.front();
  // (The first span cut to 1.5 x the reach by an exact split: its middle, 0.75 x, would be dropped.)
  const double first = cadgeom::norm(em.edge(e).points[1] - end);
  REQUIRE(first > 2 * within);
  REQUIRE(em.split({{e, 0, 1.5 * within / first, true}}) == cadgeom::Status::ok);
  REQUIRE(std::fabs(cadgeom::norm(em.edge(e).points[1] - end) - 1.5 * within) <= 1e-6 * within);
  CHECK(!em.endSpanFrozen(e, 0));
  const size_t n = em.edge(e).t.size();
  CHECK(em.split({{e, 0, 0.5}}) == cadgeom::Status::ok);
  REQUIRE(em.edge(e).t.size() == n + 1);
  const double kept = cadgeom::norm(em.edge(e).points[1] - end);
  CHECK(kept > within);
  CHECK(kept < 1.1 * within);
  // Now the first span is just past the reach: 0.9 of the way isn't, so it's frozen and a split there dropped. A
  // span inside the edge never frozen for it (the next, within the floor), nor one out of range; the one after, out
  // to the edge's sample, split.
  CHECK(em.endSpanFrozen(e, 0));
  CHECK(em.split({{e, 0, 0.5}}) == cadgeom::Status::ok);
  CHECK_EQ(em.edge(e).t.size(), n + 1);
  CHECK(!em.endSpanFrozen(e, 1));
  CHECK(!em.endSpanFrozen(-1, 0));
  CHECK(em.split({{e, 2, 0.5}}) == cadgeom::Status::ok);
  CHECK_EQ(em.edge(e).t.size(), n + 2);
  // The last span made as short (an exact split 1.01 x the reach from the far end): frozen, the ones inside not.
  const std::vector<Vec3>& q = em.edge(e).points;
  const size_t k = q.size();
  const double last = cadgeom::norm(q[k - 1] - q[k - 2]);
  REQUIRE(em.split({{e, static_cast<int32_t>(k - 2), 1 - 1.01 * within / last, true}}) == cadgeom::Status::ok);
  const int spans = static_cast<int>(em.edge(e).t.size()) - 1;
  CHECK(em.endSpanFrozen(e, spans - 1));
  CHECK(!em.endSpanFrozen(e, 1));
  CHECK(!em.endSpanFrozen(e, spans - 2));
}

TEST_CASE("a span with no width in parameter never split, however long (an end vertex off its curve's end)") {
  cadgeom::Model m = load("cube");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 1e-3;
  o.maxSpacing = 0.25;
  EdgeMesh em(m, o);
  const int e = 0;
  // (A sample 1e-15 of the range past the edge's second, its point 0.2 off it: a span of no width, 0.2 long.)
  EdgeSamples s = em.edge(e);
  REQUIRE(s.t.size() >= 4u);
  const double w = 1e-15 * (s.t.back() - s.t.front());
  s.t.insert(s.t.begin() + 2, s.t[1] + w);
  s.points.insert(s.points.begin() + 2, s.points[1] + Vec3{0, 0, 0.2});
  em.restore(e, s);
  const size_t n = em.edge(e).t.size();
  CHECK(em.split({{e, 1, 0.5}}) == cadgeom::Status::ok);
  CHECK_EQ(em.edge(e).t.size(), n);
  CHECK(em.split({{e, 1, 0.5, true}}) == cadgeom::Status::ok);
  CHECK_EQ(em.edge(e).t.size(), n);
  // The span after it, as wide as any: split.
  CHECK(em.split({{e, 2, 0.5}}) == cadgeom::Status::ok);
  CHECK_EQ(em.edge(e).t.size(), n + 1);
}

TEST_CASE("rings cut into edges: the approach and the crossing samples, nothing between, never refilled") {
  // The cube's edge 0 (shared by two faces), sampled at 0.25: a ring from its start vertex to 0.4 of the way along.
  cadgeom::Model m = load("cube");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 1e-3;
  o.maxSpacing = 0.25;
  EdgeMesh em(m, o);
  const int e = 0;
  const std::vector<double> t0 = em.edge(e).t;
  REQUIRE(t0.size() >= 4u);
  const Vec3 vertex = em.edge(e).points.front();
  const double a = t0.front(), c = t0.front() + 0.4 * (t0.back() - t0.front());
  CHECK(em.cutRings({{e, a, c}}) == cadgeom::Status::ok);
  const EdgeSamples& s = em.edge(e);
  CHECK(s.points.front().x == vertex.x && s.points.front().y == vertex.y && s.points.front().z == vertex.z);
  REQUIRE(s.t.size() >= 3u);
  CHECK_EQ(s.t[1], c);
  Vec3 pc = em.point(e, c);
  CHECK(cadgeom::norm(s.points[1] - pc) == 0);
  for (double t : s.t) CHECK(!(t > std::min(a, c) && t < std::max(a, c)));
  // Both faces using it have its samples as the edge has them: the crossing, nothing inside the ring.
  int faces = 0;
  for (int f = 0; f < m.faces(); f++) {
    FaceBoundary fb = em.face(f);
    bool uses = false, crossing = false, inside = false;
    for (const auto& l : fb.loops)
      for (const BoundaryPoint& p : l)
        if (p.edgeIndex == e && p.kind == BoundaryPoint::edgeSample) {
          uses = true;
          crossing = crossing || cadgeom::norm(p.point - pc) == 0;
          double t = s.t[p.sample];
          inside = inside || (t > std::min(a, c) && t < std::max(a, c));
        }
    if (!uses) continue;
    faces++;
    CHECK(crossing && !inside);
  }
  CHECK_EQ(faces, 2);
  // Its uses redone: each as many samples as the edge, each on the surface at the edge's point.
  for (int co = 0; co < m.coedges(); co++)
    if (m.coedgeEdge(co) == e) CHECK_EQ(em.coedge(co).index.size(), s.t.size());
  CHECK_EQ(checkCoedges(m, em, 1e-9, "cube ring"), 0);
  // A split inside the ring's span is dropped; one beyond it applies.
  const size_t n = s.t.size();
  CHECK(em.split({{e, 0, 0.5}}) == cadgeom::Status::ok);
  CHECK_EQ(em.edge(e).t.size(), n);
  CHECK(em.split({{e, 1, 0.5}}) == cadgeom::Status::ok);
  CHECK_EQ(em.edge(e).t.size(), n + 1);
  // Repeated rounds asking the ring's span split at every fraction: still empty.
  for (double f : {0.1, 0.3, 0.5, 0.7, 0.9}) em.split({{e, 0, f}});
  for (double t : em.edge(e).t) CHECK(!(t > std::min(a, c) && t < std::max(a, c)));
  // The ring shrunk (a cut from its approach, its crossing inside it): a sample at the new crossing, the ring to it,
  // the span from there to the old crossing split as any; inside the smaller ring still dropped.
  const double c2 = a + 0.25 * (c - a);
  CHECK(em.cutRings({{e, a, c2}}) == cadgeom::Status::ok);
  REQUIRE(em.edge(e).rings.size() == 1u);
  CHECK(em.edge(e).rings[0].lo == std::min(a, c2));
  CHECK(em.edge(e).rings[0].hi == std::max(a, c2));
  CHECK(em.edge(e).t[1] == c2);
  CHECK(em.edge(e).t[2] == c);
  const size_t m2 = em.edge(e).t.size();
  CHECK(em.split({{e, 1, 0.5}}) == cadgeom::Status::ok);
  CHECK_EQ(em.edge(e).t.size(), m2 + 1);
  CHECK(em.split({{e, 0, 0.5}}) == cadgeom::Status::ok);
  CHECK_EQ(em.edge(e).t.size(), m2 + 1);
  CHECK_EQ(checkCoedges(m, em, 1e-9, "cube ring shrunk"), 0);
  // Its samples saved, split, then restored: as saved, rings included, its uses placed on them again.
  const EdgeSamples saved = em.edge(e);
  em.split({{e, 2, 0.5}});
  REQUIRE(em.edge(e).t.size() == saved.t.size() + 1);
  em.restore(e, saved);
  CHECK(em.edge(e).t == saved.t);
  CHECK_EQ(em.edge(e).rings.size(), saved.rings.size());
  for (int co = 0; co < m.coedges(); co++)
    if (m.coedgeEdge(co) == e) CHECK_EQ(em.coedge(co).index.size(), saved.t.size());
  CHECK_EQ(checkCoedges(m, em, 1e-9, "cube ring restored"), 0);
  // An approach between samples (a curve passing the pole): a sample there too, the ring the span to the crossing.
  const int e2 = 1;
  const std::vector<double> u = em.edge(e2).t;
  REQUIRE(u.size() >= 4u);
  const double ua = 0.5 * (u[1] + u[2]), uc = u.back();
  CHECK(em.cutRings({{e2, ua, uc}}) == cadgeom::Status::ok);
  const std::vector<double>& u2 = em.edge(e2).t;
  REQUIRE(u2.size() == 4u);
  CHECK(u2[0] == u[0] && u2[1] == u[1] && u2[2] == ua && u2[3] == uc);
  // Bad cuts ignored, reported: no such edge, not finite, outside the edge, approach equal to crossing.
  const std::vector<double> before = em.edge(2).t;
  CHECK(em.cutRings({{-1, 0, 1}, {9999, 0, 1}, {2, NAN, 1}, {2, before.front(), before.back() + 10},
          {2, before.front(), before.front()}}) == cadgeom::Status::invalidModel);
  CHECK(em.edge(2).t == before);
  // A cut's pseudo-edge (band's): the same.
  cadgeom::Model b = load("band");
  EdgeMesh eb(b, o, {0.2});
  const int pe = b.edges();
  REQUIRE(eb.isPseudo(pe));
  const std::vector<double> pt = eb.edge(pe).t;
  REQUIRE(pt.size() >= 4u);
  CHECK(eb.cutRings({{pe, pt.front(), pt[pt.size() / 2]}}) == cadgeom::Status::ok);
  CHECK_EQ(eb.edge(pe).t.size(), pt.size() - (pt.size() / 2 - 1));
}

TEST_CASE("a use's p-curve checked between its samples against its edge's curve: ends alone, a span's quarter") {
  // wrongEndPcurve's bottom p-curve runs to (0.5, 0.3), not (1, 0): off its line by far more than 100 x the tolerance
  // at its span's quarters and middle (it has no inside sample), so the use is placed by inversion, the square's
  // boundary its own (area 1). The right p-curves of the other sides are still used.
  cadgeom::Model m = load("wrongEndPcurve");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 1e-3;
  EdgeMesh em(m, o);
  REQUIRE(em.edge(0).t.size() == 2u);
  CHECK(!em.coedge(0).fromPcurve);
  for (int c = 1; c < 4; c++) CHECK(em.coedge(c).fromPcurve);
  CHECK_EQ(checkCoedges(m, em, 1e-9, "wrongEndPcurve"), 0);
  FaceBoundary fb = em.face(0);
  REQUIRE(fb.status == cadgeom::Status::ok);
  double area = meshArea(m, 0, fb, 0.25, 1e-3);
  CHECK(std::fabs(area - 1) < 1e-9);
  // wigglePcurve's, right at the samples and the spans' middles (two spans at a spacing of 0.6), wrong at the second
  // span's first quarter: by inversion too.
  cadgeom::Model w = load("wigglePcurve");
  REQUIRE(w.ok());
  o.maxSpacing = 0.6;
  EdgeMesh ew(w, o);
  REQUIRE(ew.edge(0).t.size() == 3u);
  CHECK(!ew.coedge(0).fromPcurve);
  CHECK_EQ(checkCoedges(w, ew, 1e-9, "wigglePcurve"), 0);
}

TEST_CASE("a local foot stuck where it started while its point moved falls back on the global search") {
  // uFoldFlat: its loop on the U's first arm, spans of 0.05 within its tolerance (0.1), so a foot left at the sample
  // before's (u, v) passes the distance check; a stub local foot that never moves: every inside sample falls back,
  // saying so, and each lands on its point.
  cadgeom::Model m = load("uFoldFlat");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 0.1;
  o.maxSpacing = 0.05;
  o.projectMissingPcurves = false;
  EdgeMesh plain(m, o);
  REQUIRE(plain.traceFallbacks().empty());
  o.localFootForTests = [&](int, Vec3 p, Vec2 start, Vec2& foot, double& distance) {
    foot = start;
    distance = cadgeom::norm(p - Vec3{10 * start.x, 0, 10 * start.y});
    return true;
  };
  EdgeMesh em(m, o);
  const CoedgeSamples& cs = em.coedge(0);
  REQUIRE(cs.uv.size() > 8);
  int stuck = 0;
  for (const TraceFallback& f : em.traceFallbacks()) stuck += std::strstr(f.why, "didn't move") != nullptr;
  CHECK_EQ(stuck, static_cast<int>(cs.uv.size()) - 2);
  CHECK_EQ(checkCoedges(m, em, 1e-9, "uFoldFlat stuck"), 0);
}

TEST_CASE("a local foot a rounding's worth off a seam is on it, as the global search judges: its seam use recognized") {
  // torusWide traced sample by sample (projection off), with a stub local foot 1e-10 off the torus's foot in u (1e-9
  // in 3D, within the tolerance; past 1e-12 of the period): its tube at u = 0 is still a seam use, placed from its
  // neighbours, so the far tube (over half a period away) isn't put at the seam's nearer copy; the loop over u 0 to
  // pi + 0.4, valid.
  cadgeom::Model m = load("torusWide");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 1e-2;
  o.projectMissingPcurves = false;
  o.localFootForTests = [&](int, Vec3 p, Vec2 start, Vec2& foot, double& distance) {
    const double rho = std::hypot(p.x, p.y);
    const double u = start.x + std::remainder(std::atan2(p.y, p.x) - start.x, 2 * M_PI) + 1e-10;
    const double v = start.y + std::remainder(std::atan2(p.z, rho - 5) - start.y, 2 * M_PI);
    foot = {u, v};
    const Vec3 q{(5 + std::cos(v)) * std::cos(u), (5 + std::cos(v)) * std::sin(u), std::sin(v)};
    distance = cadgeom::norm(p - q);
    return true;
  };
  EdgeMesh em(m, o);
  REQUIRE(em.traces().local > 0);
  const FaceBoundary fb = em.face(0);
  if (fb.status != cadgeom::Status::ok) std::printf("  torusWide off by 1e-10: %s\n", fb.cause.c_str());
  REQUIRE(fb.status == cadgeom::Status::ok);
  double lo = INFINITY, hi = -INFINITY;
  for (const BoundaryPoint& q : fb.loops[0]) lo = std::min(lo, q.uv.x), hi = std::max(hi, q.uv.x);
  CHECK(std::fabs(hi - lo - (M_PI + 0.4)) < 1e-6);
}

TEST_CASE("a use without p-curve traced from sample to sample: its feet stay on its own arm of a thin U") {
  // uFold: the loop's middle 0.07 off its arm towards the other, 0.03 from it. Every inside sample's foot continued
  // from the one before, on the face's arm (u within [0, 1]); none fell back on the global search.
  cadgeom::Model m = load("uFold");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 0.1;
  o.projectMissingPcurves = false;
  EdgeMesh em(m, o);
  const CoedgeSamples& cs = em.coedge(0);
  REQUIRE(cs.uv.size() > 8);
  int off = 0;
  for (Vec2 p : cs.uv) off += !(p.x >= 0 && p.x <= 1 + 1e-9);
  if (off) std::printf("  uFold: %d of %zu samples off the arm\n", off, cs.uv.size());
  CHECK_EQ(off, 0);
  CHECK_EQ(em.traces().local, static_cast<int>(cs.uv.size()) - 2);
  CHECK(em.traceFallbacks().empty());
  CHECK(em.face(0).status == cadgeom::Status::ok);
  // uFoldAway: 0.3 off the far side, past the tolerance (0.1), within the samples' spacing: continued all the same.
  cadgeom::Model a = load("uFoldAway");
  REQUIRE(a.ok());
  EdgeMesh ea(a, o);
  for (const TraceFallback& f : ea.traceFallbacks()) std::printf("  uFoldAway: at %g, %g off: %s\n", f.t, f.distance,
    f.why);
  CHECK(ea.traceFallbacks().empty());
  CHECK_EQ(ea.traces().local, static_cast<int>(ea.coedge(0).uv.size()) - 2);
  // uFoldFar: 3 off, past the tolerance and the spacing: the samples after the vertex fall back, each said, the
  // global search's foot kept (on the arm: the far side is nearer it than the other arm).
  cadgeom::Model far = load("uFoldFar");
  REQUIRE(far.ok());
  EdgeMesh ef(far, o);
  REQUIRE(!ef.traceFallbacks().empty());
  for (const TraceFallback& f : ef.traceFallbacks()) {
    CHECK_EQ(f.coedge, 0);
    CHECK(std::string(f.why).find("farther") != std::string::npos);
    CHECK(f.distance > 0.1);
  }
  CHECK_EQ(ef.traces().local + ef.traces().global, static_cast<int>(ef.coedge(0).uv.size()));
}

TEST_CASE("a winding loops' cut across no hole: bandTwoSlots' widest gap between its points inside slot B, the "
  "period's start across slot A; the cut placed past both, the boundary a domain") {
  cadgeom::Model m = load("bandTwoSlots");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 0.5;
  EdgeMesh em(m, o);
  const FaceBoundary fb = em.face(0);
  REQUIRE(fb.status == cadgeom::Status::ok);
  // (The cut, a pseudo-edge along u = const: its u from its points in 3D, the cylinder's (cos u, sin u, v).)
  int cuts = 0;
  for (int e = 0; e < em.edgeCount(); e++) {
    if (!em.isPseudo(e)) continue;
    cuts++;
    for (const Vec3& p : em.edge(e).points) {
      const double u = std::atan2(p.y, p.x);
      CHECK(!(std::fabs(u) <= 0.3));
      CHECK(!(u >= 1.05 && u <= 2.85));
      if ((std::fabs(u) <= 0.3) || (u >= 1.05 && u <= 2.85)) std::printf("  bandTwoSlots: the cut at u %g\n", u);
    }
  }
  CHECK_EQ(cuts, 1);
}

TEST_CASE("a p-curve healing made (the analysis's pcurveFrom healed), with placeHealedPcurves: placed as a projected "
  "one, its samples and ends at their points' feet; without the analysis, kept as given within the tolerance") {
  // pcurveNear's p-curve 0.003 off in u, under the tolerance 0.005: as given, its samples 0.003 off their points; as
  // healing's (pcurveNearHealed: a trace at 0.005), at their feet, and its vertex's too.
  cadgeom::Model m = load("pcurveNear");
  REQUIRE(m.ok());
  const tessfixtures::Analysis* a = tessfixtures::analysis("pcurveNearHealed");
  REQUIRE(a);
  for (bool healed : {false, true}) {
    EdgeOptions o;
    o.deflection = 0.01;
    if (healed) o.analysis = a->data, o.analysisSize = a->size, o.placeHealedPcurves = true;
    EdgeMesh em(m, o);
    const CoedgeSamples& cs = em.coedge(0);
    REQUIRE(cs.fromPcurve);
    REQUIRE(cs.uv.size() > 4);
    double worst = 0;
    for (size_t i = 0; i < cs.uv.size(); i++) {
      const Vec3 P = em.edge(0).points[cs.index[i]];
      worst = std::fmax(worst, std::hypot(cs.uv[i].x - P.x, cs.uv[i].y - P.y));
    }
    if (healed ? !(worst < 1e-9) : !(worst > 0.0029 && worst < 0.0031))
      std::printf("  pcurveNear (healed %d): a sample %g off its point\n", int(healed), worst);
    if (healed) CHECK(worst < 1e-9);
    else CHECK(worst > 0.0029 && worst < 0.0031);
    CHECK_EQ(cs.projected, healed);
  }
  // Off by default: the analysis given, the p-curve kept as given.
  EdgeOptions o;
  o.deflection = 0.01;
  o.analysis = a->data, o.analysisSize = a->size;
  EdgeMesh em(m, o);
  CHECK(!em.coedge(0).projected);
}

TEST_CASE("an edge or vertex whose tolerance healing grew past repair (the analysis's toleranceError): each face with "
  "a loop through it fails at once, said so with its id and growth, the edge not sampled; the rest as without") {
  // (poleLunes's edge 0 and vertex 0; wholeSphereVertex's vertex, its face's one loop.)
  for (const char* name : {"lunesEdgePast", "lunesVertexPast", "sphereVertexPast"}) {
    const tessfixtures::Analysis* a = tessfixtures::analysis(name);
    REQUIRE(a);
    cadgeom::Model m = load(a->model);
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 0.01;
    EdgeMesh plain(m, o);
    o.analysis = a->data, o.analysisSize = a->size;
    EdgeMesh em(m, o);
    const bool edge = std::strcmp(name, "lunesEdgePast") == 0;
    const char* what = edge ? "an edge (#" : "a vertex (#";
    int failed = 0;
    for (int f = 0; f < m.faces(); f++) {
      // (Through it: a loop using edge 0, or an edge ending at vertex 0.)
      bool through = false;
      for (int i = 0; i < m.faceLoopCount(f); i++) {
        const int l = m.faceFirstLoop(f) + i;
        if (m.loopKind(l) == CBR_LOOP_VERTEX) {
          through = through || (!edge && m.loopFirst(l) == 0);
          continue;
        }
        for (int k = 0; k < m.loopCount(l); k++) {
          const int e = m.coedgeEdge(m.loopFirst(l) + k);
          through = through || (edge ? e == 0 : m.edgeStart(e) == 0 || m.edgeEnd(e) == 0);
        }
      }
      const FaceBoundary fb = em.face(f), pb = plain.face(f);
      if (through) {
        failed++;
        CHECK(fb.status == cadgeom::Status::invalidModel);
        CHECK(fb.cause.rfind(what, 0) == 0);
        CHECK(fb.cause.find("past repair") != std::string::npos);
        CHECK(fb.cause.find("from 1e-05") != std::string::npos);
      } else {
        CHECK(fb.status == pb.status);
      }
    }
    CHECK(failed > 0);
    if (edge) CHECK(em.edge(0).points.empty());
  }
}

TEST_CASE("a given p-curve off its edge's points past the tolerance: used, its inside samples polished onto them") {
  // pcurveShifted: its p-curve 0.3 off in u at a tolerance of 0.005 (within the 0.5 allowed): from the p-curve, every
  // inside sample's (u, v) now on its point within the tolerance, the use counted as given and off; pcurveCircle's,
  // through its p-curve, on its points: given, not off.
  cadgeom::Model m = load("pcurveShifted");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 0.01;
  EdgeMesh em(m, o);
  const CoedgeSamples& cs = em.coedge(0);
  REQUIRE(cs.fromPcurve);
  REQUIRE(cs.uv.size() > 4);
  double worst = 0;
  for (size_t i = 1; i + 1 < cs.uv.size(); i++) {
    const Vec3 P = em.edge(0).points[cs.index[i]];
    worst = std::fmax(worst, std::hypot(cs.uv[i].x - P.x, cs.uv[i].y - P.y));
  }
  if (!(worst <= 0.005)) std::printf("  pcurveShifted: an inside sample %g off its point\n", worst);
  CHECK(worst <= 0.005);
  CHECK_EQ(em.givenPcurves().used, 1);
  CHECK_EQ(em.givenPcurves().offTolerance, 1);
  cadgeom::Model c = load("pcurveCircle");
  REQUIRE(c.ok());
  EdgeMesh ec(c, o);
  CHECK(ec.givenPcurves().used >= 1);
  CHECK_EQ(ec.givenPcurves().offTolerance, 0);
}

TEST_CASE("respace judges a span by its length, as sampling does: arcChord's arc split at a spacing over its chord") {
  // The arc is 1 long and 0.9974 across: at spacing 0.9996 (between them, and over the 0.99935 that two chords of it
  // give), sampling at that spacing gives the arc 2 spans, and respace does too, so the loop has 3 points; the chord
  // stays one span.
  cadgeom::Model m = load("arcChord");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 0.1;
  o.angle = 0.26;
  EdgeMesh em(m, o);
  REQUIRE(em.edge(0).t.size() == 2u);
  REQUIRE(em.respace({0.9996}) == cadgeom::Status::ok);
  CHECK_EQ(em.edge(0).t.size(), 3u);
  CHECK_EQ(em.edge(1).t.size(), 2u);
  EdgeOptions at = o;
  at.maxSpacing = 0.9996;
  EdgeMesh sampled(m, at);
  CHECK_EQ(sampled.edge(0).t.size(), em.edge(0).t.size());
  const FaceBoundary fb = em.face(0);
  REQUIRE(fb.status == cadgeom::Status::ok);
  CHECK_EQ(fb.loops[0].size(), 3u);
}

TEST_CASE("respace: every span split to the faces' spacing, the samples there kept, the uses redone") {
  // band: its circles sampled at the deflection alone (spans of about 1.2), then the face's spacing 0.1 asked, more
  // than one pass's 9 pieces: every span's chord within it, each sample before still there, each use's (u, v) count
  // its edge's.
  cadgeom::Model m = load("band");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 0.1;
  EdgeMesh em(m, o);
  std::vector<std::vector<double>> before;
  for (int e = 0; e < m.edges(); e++) before.push_back(em.edge(e).t);
  REQUIRE(em.respace(std::vector<double>(m.faces(), 0.1)) == cadgeom::Status::ok);
  for (int e = 0; e < m.edges(); e++) {
    const EdgeSamples& s = em.edge(e);
    double longest = 0;
    for (size_t i = 0; i + 1 < s.points.size(); i++)
      longest = std::fmax(longest, cadgeom::norm(s.points[i + 1] - s.points[i]));
    if (!(longest <= 0.3)) std::printf("  band edge %d: a span of %g\n", e, longest);
    CHECK(longest <= 0.1);
    CHECK(s.t.size() > before[e].size());
    for (double t : before[e]) CHECK(std::find(s.t.begin(), s.t.end(), t) != s.t.end());
  }
  for (int c = 0; c < m.coedges(); c++)
    CHECK_EQ(em.coedge(c).uv.size(), em.edge(m.coedgeEdge(c)).t.size());
}

TEST_CASE("no split on a span whose chord is within the refinement floor, though asked; longer ones split") {
  // spindleApex's uncertainty is 0.2, so at a deflection of 4 the floor is max(0.2, 0.4) = 0.4, above the tolerance:
  // a split asked on a span whose chord is over 0.4 is made, one on a span of chord at most 0.4 dropped (between the
  // tolerance and the floor too).
  cadgeom::Model m = load("spindleApex");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 4;
  EdgeMesh em(m, o);
  int e = -1;
  for (int k = 0; k < m.edges() && e < 0; k++)
    if (m.curveKind(m.edgeCurve(k)) == CBR_CURVE_CIRCLE) e = k;
  REQUIRE(e >= 0);
  // Halve its first span while asked, round after round: each split made while its chord is over the floor, none
  // after.
  int made = 0, dropped = 0, droppedOverTolerance = 0;
  for (int round = 0; round < 12; round++) {
    const auto& P = em.edge(e).points;
    const double chord = cadgeom::norm(P[1] - P[0]);
    const size_t before = P.size();
    REQUIRE(em.split({{e, 0, 0.5}}) == cadgeom::Status::ok);
    const size_t after = em.edge(e).points.size();
    if (chord > 0.4) {
      CHECK_EQ(after, before + 1);
      made++;
    } else {
      CHECK_EQ(after, before);
      dropped++;
      droppedOverTolerance += chord > 0.2;
    }
  }
  CHECK(made > 0);
  CHECK(dropped > 0);
  // (The first span's chord ends over the tolerance: the floor, not the tolerance, stopped it.)
  CHECK(droppedOverTolerance > 0);
  const double last = cadgeom::norm(em.edge(e).points[1] - em.edge(e).points[0]);
  CHECK(last > 0.2 && last <= 0.4);
}

TEST_CASE("a given p-curve whose domain ends within 1e-9 of the use's range: clamped, used; farther refused") {
  // pcurveShortHair's bottom p-curve ends 5e-10 short of its edge's range [0, 1]: its end evaluated at the domain's
  // end, the p-curve used, the end's (u, v) (1 - 5e-10, 0). pcurveShortFar's, 1e-6 short: refused as before, the use
  // by inversion.
  // pcurveShortStart's begins 5e-10 past its start: used too, its first (u, v) (5e-10, 0).
  for (const char* name : {"pcurveShortHair", "pcurveShortFar", "pcurveShortStart"}) {
    const bool start = std::string(name) == "pcurveShortStart", hair = start || std::string(name) == "pcurveShortHair";
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 0.01;
    EdgeMesh em(m, o);
    const CoedgeSamples& cs = em.coedge(0);
    if (cs.fromPcurve != hair) std::printf("  %s: fromPcurve %d\n", name, int(cs.fromPcurve));
    CHECK(cs.fromPcurve == hair);
    REQUIRE(!cs.uv.empty());
    if (hair && !start) CHECK(std::fabs(cs.uv.back().x - (1 - 5e-10)) < 1e-15);
    if (start) CHECK(std::fabs(cs.uv.front().x - 5e-10) < 1e-15);
    CHECK(em.face(0).status == cadgeom::Status::ok);
  }
}

TEST_CASE("a curve's break at an end's point within rounding is that point: no sample beside it") {
  // knotAtEnd's bottom edge, its knots 1e-13 from each end of its range: no two samples within 1e-9 of each other,
  // the knots dropped (its samples otherwise its middle knot's and the deflection's).
  cadgeom::Model m = load("knotAtEnd");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 0.01;
  EdgeMesh em(m, o);
  const EdgeSamples& es = em.edge(0);
  REQUIRE(es.t.size() >= 3u);
  double closest = INFINITY;
  for (size_t i = 0; i + 1 < es.points.size(); i++) closest = std::fmin(closest, cadgeom::norm(es.points[i + 1] -
    es.points[i]));
  if (!(closest > 1e-9)) std::printf("  knotAtEnd: samples %.3g apart\n", closest);
  CHECK(closest > 1e-9);
  CHECK(em.face(0).status == cadgeom::Status::ok);
}

TEST_CASE("a projected use's inside samples at their points' feet, not the p-curve's: at the edge's tolerance or not") {
  // coarseProjection's bottom edge, 0.004 off its cylinder under a tolerance of 0.01, projected at that (the mesh's,
  // 5e-4, too tight): its p-curve within 0.01 of the feet, its samples polished to them, (atan2(y, x), z).
  // fineProjection's, 1e-4 off, projected within the mesh's tolerance: polished the same.
  for (const char* name : {"coarseProjection", "fineProjection"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    EdgeOptions o;
    o.deflection = 0.01;
    EdgeMesh em(m, o);
    REQUIRE(em.coedge(0).projected);
    const CoedgeSamples& cs = em.coedge(0);
    const EdgeSamples& es = em.edge(m.coedgeEdge(0));
    REQUIRE(cs.uv.size() > 4u);
    double worst = 0;
    for (size_t j = 1; j + 1 < cs.uv.size(); j++) {
      const Vec3 p = es.points[cs.index[j]];
      worst = std::fmax(worst, std::hypot(cs.uv[j].x - std::atan2(p.y, p.x), cs.uv[j].y - p.z));
    }
    if (!(worst <= 1e-9)) std::printf("  %s: a sample %.3g from its foot\n", name, worst);
    CHECK(worst <= 1e-9);
    CHECK(em.face(0).status == cadgeom::Status::ok);
    // (The bottom's projection at the edge's tolerance for the coarse one, within the mesh's for the fine one.)
    const ProjectionCounts& pc = em.projections();
    CHECK(std::string(name) == "coarseProjection" ? pc.atEdgeTolerance > 0 : pc.atEdgeTolerance == 0);
  }
}

TEST_CASE("a use's given p-curve a whole period off its surface's own range, the surface closed in fact: used") {
  // tubeQuarterPeriodUp's rulings, their p-curves at u = 5 and 6 on a B-spline whose range in u is [0, 4], closed in
  // fact (period 4): each checked on the surface as it closes, so on its edge, and used; the boundary the quarter's
  // (area 5 pi).
  cadgeom::Model m = load("tubeQuarterPeriodUp");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 1e-3;
  EdgeMesh em(m, o);
  CHECK(em.coedge(1).fromPcurve && !em.coedge(1).projected);
  CHECK(em.coedge(3).fromPcurve && !em.coedge(3).projected);
  // (The arcs' by inversion, within its tolerance of them.)
  CHECK_EQ(checkCoedges(m, em, 1e-5, "tubeQuarterPeriodUp"), 0);
  FaceBoundary fb = em.face(0);
  REQUIRE(fb.status == cadgeom::Status::ok);
  REQUIRE(fb.loops.size() == 1u);
  // The loop the quarter's, u 1 to 2 (the rulings' p-curves reduced into the range) and v 0 to 1: area 1 in (u, v).
  double area = 0, lo = INFINITY, hi = -INFINITY;
  const auto& L = fb.loops[0];
  for (size_t k = 0; k < L.size(); k++) {
    Vec2 a = L[k].uv, b = L[(k + 1) % L.size()].uv;
    area += 0.5 * (a.x * b.y - b.x * a.y);
    lo = std::fmin(lo, a.x), hi = std::fmax(hi, a.x);
  }
  if (std::fabs(area - 1) > 1e-9 || lo != 1 || hi != 2)
    std::printf("  tubeQuarterPeriodUp: (u, v) area %.12g, u %g to %g\n", area, lo, hi);
  CHECK(std::fabs(area - 1) < 1e-9);
  CHECK(std::fabs(lo - 1) < 1e-12);
  CHECK(std::fabs(hi - 2) < 1e-12);
}

TEST_CASE("splits: a sample inside the span asked, clamped, the rest kept; bad requests ignored and reported") {
  cadgeom::Model m = load("band");
  REQUIRE(m.ok());
  EdgeOptions o;
  o.deflection = 1e-2;
  EdgeMesh em(m, o, {0.5});
  const int cutEdge = m.edges();
  std::vector<double> before0 = em.edge(0).t, before1 = em.edge(1).t, beforeCut = em.edge(cutEdge).t;
  std::vector<Vec3> p0 = em.edge(0).points;
  // Span 3 of the bottom at a half, span 5 at 0 (clamped to a tenth) and again at 0.05 (a tenth of the span from
  // that one: dropped), the cut's span 0 at 0.7; then a bad edge, a bad span and a NaN.
  Status st = em.split({{0, 3, 0.5}, {0, 5, 0}, {0, 5, 0.05}, {cutEdge, 0, 0.7}, {99, 0, 0.5}, {1, 1000, 0.5},
    {1, 0, NAN}});
  CHECK(st == cadgeom::Status::invalidModel);
  const EdgeSamples& s0 = em.edge(0);
  REQUIRE(s0.t.size() == before0.size() + 2);
  CHECK(s0.t[4] == before0[3] + 0.5 * (before0[4] - before0[3]));
  CHECK(s0.t[7] == before0[5] + 0.1 * (before0[6] - before0[5]));
  // The old samples kept, in place where before the new ones and shifted after.
  for (size_t i = 0; i < before0.size(); i++) {
    size_t j = i <= 3 ? i : i <= 5 ? i + 1 : i + 2;
    CHECK(s0.t[j] == before0[i] && s0.points[j].x == p0[i].x && s0.points[j].y == p0[i].y);
  }
  CHECK(em.edge(1).t == before1);
  REQUIRE(em.edge(cutEdge).t.size() == beforeCut.size() + 1);
  CHECK(em.edge(cutEdge).t[1] == beforeCut[0] + 0.7 * (beforeCut[1] - beforeCut[0]));
  // The bottom's use redone: as many (u, v) as samples, on the surface.
  CHECK_EQ(em.coedge(0).uv.size(), s0.t.size());
  CHECK_EQ(checkCoedges(m, em, 1e-9, "split band"), 0);
  CHECK_EQ(checkEdges(m, em, o, "split band"), 0);
  // The face again: valid, the new samples in it.
  FaceBoundary fb = em.face(0);
  REQUIRE(fb.status == cadgeom::Status::ok);
  double area = meshArea(m, 0, fb, 0.5, 1e-2);
  CHECK(area < 20 * M_PI && area > 20 * M_PI * (1 - 1e-2));
  // Only good requests: ok. The last sample isn't a span's start.
  CHECK(em.split({{1, 0, 0.5}}) == cadgeom::Status::ok);
  std::vector<double> t1 = em.edge(1).t;
  CHECK(em.split({{1, static_cast<int32_t>(t1.size()) - 1, 0.5}}) == cadgeom::Status::invalidModel);
  CHECK(em.edge(1).t == t1);
}

TEST_CASE("an edge ending just past a pole on the far meridian (poleDipFar, poleDipFarLoose): each use's samples at "
          "the pole beside its pole line on the line, S there no farther from their points than the pole (part_test "
          "meshes them)") {
  // (poleDipFar's ends 1e-7 past the pole: doubled across it, their copies at the line's ends, which fold repair
  // must leave there. poleDipFarLoose's 2e-3 past it at an uncertainty of 0.01, as LMP1 #172878's: no sample at the
  // pole, its ends at the pole by their points taking a neighbour's free coordinate, the meridian they came down by,
  // which off the line put S farther from them than the pole and the boundary through its own point.)
  for (const char* name : {"poleDipFar", "poleDipFarLoose"}) {
    cadgeom::Model m = load(name);
    REQUIRE(m.ok());
    EdgeOptions o;
    EdgeMesh em(m, o);
    const FaceBoundary fb = em.face(0);
    REQUIRE(fb.status == cadgeom::Status::ok);
    cadgeom::Status st;
    std::unique_ptr<cadgeom::Surface> s = closedSurface(m, cadgeom::Tolerances(m), 0, st);
    REQUIRE(s != nullptr);
    const Vec3 pole{0, 0, -1};
    int beside = 0;
    for (const auto& loop : fb.loops)
      for (size_t i = 0; i < loop.size(); i++) {
        const BoundaryPoint& q = loop[i];
        const BoundaryPoint &a = loop[(i + loop.size() - 1) % loop.size()], &b = loop[(i + 1) % loop.size()];
        const double d = cadgeom::norm(q.point - pole);
        if (q.kind != BoundaryPoint::edgeSample || d > 0.01) continue;
        if (a.kind != BoundaryPoint::poleLine && b.kind != BoundaryPoint::poleLine) continue;
        beside++;
        CHECK(q.uv.y == -M_PI / 2);
        cadgeom::SurfacePoint sp;
        s->eval(q.uv.x, q.uv.y, 0, sp);
        CHECK(cadgeom::norm(sp.p - q.point) <= d * (1 + 1e-9) + 1e-15);
      }
    CHECK(beside >= 2);
    CHECK(fb.foldsRepaired == 0);
  }
}
