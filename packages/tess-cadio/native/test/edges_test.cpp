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
  std::unique_ptr<cadgeom::Surface> s = cadgeom::makeSurface(m, m.faceSurface(f), st);
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
    std::unique_ptr<cadgeom::Surface> s = cadgeom::makeSurface(m, m.faceSurface(f), st);
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
