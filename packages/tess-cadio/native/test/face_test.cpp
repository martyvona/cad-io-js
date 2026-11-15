// mesh2d.h on a real face: cad-brep's seamCylinder test model (a cylinder of radius 2 and height 5, its side one face
// bounded by the bottom and top circles and its seam used twice), its loop turned into a (u, v) domain through
// cad-geom: each edge sampled once at parameters on its 3D curve, the face's points the p-curves at the same
// parameters (a p-curve's parameter is its edge's, as STEP has it), so the seam's two uses are two copies of one
// edge's samples at u = 0 and u = 2 pi. The size field is the surface's first fundamental form scaled to the wanted
// 3D edge length; accept() takes a triangle whose middle is within the deflection of the surface. Then the mesh in
// 3D: its area against the band's, its normals outward, every triangle within the deflection, the seam's copies one
// set of 3D points. Then the circles sampled too coarsely for the deflection: their segments, and only theirs,
// reported to split, and once split on the edges' curves, a mesh that meets it.
#include <tess_cadio/mesh2d.h>

#include <cad_geom/curve.h>
#include <cad_geom/surface.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>

#include "brep_models.h"
#include "check.h"

using namespace tesscadio;
using cadgeom::Vec2;
using cadgeom::Vec3;

namespace {

/** The surface's first fundamental form at (u, v) over h^2: lengths in it are 3D lengths over h. */
struct SurfaceField : SizeField {
  const cadgeom::Surface& s;
  double h, deflection;
  SurfaceField(const cadgeom::Surface& surface, double size, double d) : s(surface), h(size), deflection(d) {}
  Metric2 metric(Vec2 p) const override {
    cadgeom::SurfacePoint q;
    s.eval(p.x, p.y, 1, q);
    return {cadgeom::dot(q.du, q.du) / (h * h), cadgeom::dot(q.du, q.dv) / (h * h), cadgeom::dot(q.dv, q.dv) / (h * h)};
  }
  Vec3 at(Vec2 p) const {
    cadgeom::SurfacePoint q;
    s.eval(p.x, p.y, 0, q);
    return q.p;
  }
  /** The surface at the triangle's (u, v) middle within the deflection of the flat triangle there. */
  bool accept(const Vec2 t[3]) const override {
    Vec3 a = at(t[0]), b = at(t[1]), c = at(t[2]);
    Vec3 m = at({(t[0].x + t[1].x + t[2].x) / 3, (t[0].y + t[1].y + t[2].y) / 3});
    Vec3 flat = (1.0 / 3) * (a + b + c);
    return cadgeom::norm(m - flat) <= deflection;
  }
};

/** The face's loop: each coedge's curves and its sample parameters along it (its last the next one's first). */
struct Coedge {
  std::unique_ptr<cadgeom::Curve> curve, pcurve;
  bool closed;  // an edge from a vertex to itself (here the circles; the seam isn't)
  double length;
  std::vector<double> t;
};

/** The domain from the coedges' samples (each's last left to the next), and the 3D point of each. */
Domain2 domainOf(const std::vector<Coedge>& coedges, std::vector<Vec3>& threeD) {
  Domain2 d;
  std::vector<int32_t> loop;
  threeD.clear();
  for (const Coedge& c : coedges)
    for (size_t i = 0; i + 1 < c.t.size(); i++) {
      cadgeom::CurvePoint q, p;
      c.curve->eval(c.t[i], 0, q);
      c.pcurve->eval(c.t[i], 0, p);
      loop.push_back(static_cast<int32_t>(d.points.size()));
      d.points.push_back({p.p.x, p.p.y});
      threeD.push_back(q.p);
    }
  d.loops.push_back(loop);
  return d;
}

/** The 3D mesh's measures: area, triangles facing in, triangles the field refuses. */
struct InThreeD {
  double area = 0;
  int inward = 0, refused = 0, nt = 0;
};
InThreeD measure(const Mesh2& mesh, const SurfaceField& field) {
  InThreeD r;
  r.nt = static_cast<int>(mesh.triangles.size() / 3);
  for (int t = 0; t < r.nt; t++) {
    Vec2 uv[3];
    Vec3 p[3];
    for (int i = 0; i < 3; i++) uv[i] = mesh.points[mesh.triangles[3 * t + i]], p[i] = field.at(uv[i]);
    Vec3 n = cadgeom::cross(p[1] - p[0], p[2] - p[0]);
    r.area += 0.5 * cadgeom::norm(n);
    Vec3 g = (1.0 / 3) * (p[0] + p[1] + p[2]);
    r.inward += cadgeom::dot(n, Vec3{g.x, g.y, 0}) <= 0;
    r.refused += !field.accept(uv);
  }
  return r;
}

} // namespace

TEST_CASE("a cylinder band from cad-brep's seamCylinder: its loop through cad-geom, meshed, true to the surface") {
  const fixtures::Model* fm = fixtures::model("seamCylinder");
  REQUIRE(fm);
  const cadgeom::Model m(fm->data, fm->size);
  REQUIRE(m.ok());
  cadgeom::Status st;
  REQUIRE(m.faces() == 1);
  std::unique_ptr<cadgeom::Surface> surface = cadgeom::makeSurface(m, m.faceSurface(0), st);
  REQUIRE(surface);
  const double deflection = 1e-3;

  // Each coedge's curves and range along it (reversed where it runs against its edge): the edge's range given, else
  // its vertices inverted onto its curve (from a vertex to itself on a periodic curve, the whole period).
  int l = m.faceFirstLoop(0);
  std::vector<Coedge> coedges;
  for (int k = 0; k < m.loopCount(l); k++) {
    int c = m.loopFirst(l) + k, e = m.coedgeEdge(c);
    Coedge ce;
    ce.curve = cadgeom::makeCurve(m, m.edgeCurve(e), st);
    ce.pcurve = cadgeom::makeCurve(m, m.coedgePcurve(c), st);
    REQUIRE(ce.curve && ce.pcurve);
    ce.closed = m.edgeStart(e) == m.edgeEnd(e);
    cadgeom::Range r = m.edgeRange(e);
    if (std::isnan(r.lo)) {
      cadgeom::CurveDomain dom = ce.curve->domain();
      if (ce.closed) {
        REQUIRE(dom.period > 0);
        r = {dom.range.lo, dom.range.lo + dom.period};
      } else {
        double t[2];
        for (int j = 0; j < 2; j++) {
          cadgeom::CurveInversion inv = cadgeom::invertCurve(*ce.curve,
            m.vertexPoint(j ? m.edgeEnd(e) : m.edgeStart(e)), dom.range, 1e-9);
          REQUIRE(inv.status == cadgeom::Status::ok && inv.distance < 1e-9);
          t[j] = inv.t;
        }
        REQUIRE(t[1] > t[0]);  // (a periodic curve would take a period on where needed)
        r = {t[0], t[1]};
      }
    }
    bool forward = m.coedgeOrientation(c) == CBR_ORIENTATION_FORWARD;
    ce.length = cadgeom::arcLength(*ce.curve, r.lo, r.hi, 1e-10).value;
    ce.t = {forward ? r.lo : r.hi, forward ? r.hi : r.lo};
    coedges.push_back(std::move(ce));
  }
  REQUIRE(coedges.size() == 4u);
  // Each coedge sampled uniformly in its parameter (arc length, on these curves) at about `circles` on the closed
  // edges and `seam` on the others.
  auto sample = [&](double circles, double seam) {
    for (Coedge& c : coedges) {
      double lo = c.t.front(), hi = c.t.back();
      int n = std::max(2, static_cast<int>(std::ceil(c.length / (c.closed ? circles : seam))));
      c.t.clear();
      for (int i = 0; i <= n; i++) c.t.push_back(i == n ? hi : lo + (hi - lo) * i / n);
    }
  };

  // The edges sampled finer than the deflection needs on the circles (a chord l on radius r deviates by l^2 / 8 r:
  // 0.1 gives 6.3e-4 under 1e-3), as the edge sampler will choose; the size 0.1.
  sample(0.1, 0.1);
  std::vector<Vec3> threeD;
  Domain2 d = domainOf(coedges, threeD);
  SurfaceField field(*surface, 0.1, deflection);
  Mesh2 mesh = mesh2(d, field);
  REQUIRE(mesh.status == cadgeom::Status::ok);
  CHECK(mesh.rejected.empty());
  CHECK(mesh.splitWanted.empty());
  // The domain's points on the surface are the edges' samples: the seam's two copies the same 3D points.
  double off = 0;
  for (size_t i = 0; i < d.points.size(); i++) off = std::fmax(off, cadgeom::norm(field.at(d.points[i]) - threeD[i]));
  CHECK(off < 1e-12);
  // In 3D: the area a little under the band's 2 pi r H (chords inside the surface), the normals outward.
  InThreeD r = measure(mesh, field);
  CHECK_EQ(r.refused, 0);
  const double band = 2 * M_PI * 2 * 5;
  CHECK(r.area < band);
  CHECK(r.area > band * (1 - 2 * deflection / 2));  // a chord's sagitta s: area down by about s / r
  CHECK_EQ(r.inward, 0);
  CHECK(r.nt > 200);

  // The circles at 0.2 (sagitta 2.5e-3, over the deflection), the seam at 0.1, the size 0.25: the boundary within
  // the size, so only the deflection asks for more, and only at the circles. Their segments are reported, each, and
  // the seam's none (at 0.25 some of the seam's would be too: a triangle along it must be under about 0.07 radians
  // wide for the deflection, so skinny, and its points encroach); the triangles on them stay in rejected, the status
  // ok.
  sample(0.2, 0.1);
  d = domainOf(coedges, threeD);
  SurfaceField coarse(*surface, 0.25, deflection);
  Mesh2 cm = mesh2(d, coarse);
  REQUIRE(cm.status == cadgeom::Status::ok);
  CHECK(!cm.rejected.empty());
  CHECK_EQ(measure(cm, coarse).refused, static_cast<int>(cm.rejected.size()));
  std::vector<int32_t> circleSegments, reported;
  std::vector<std::pair<int, int>> where;  // each segment's coedge and first sample
  for (int k = 0; k < static_cast<int>(coedges.size()); k++)
    for (int i = 0; i + 1 < static_cast<int>(coedges[k].t.size()); i++) {
      if (coedges[k].closed) circleSegments.push_back(static_cast<int32_t>(where.size()));
      where.push_back({k, i});
    }
  for (const SplitWanted& w : cm.splitWanted) reported.push_back(w.segment);
  CHECK(reported == circleSegments);
  // Split where asked, on the edge's curve at the parameter the fraction gives (the p-curve's the same), then meshed
  // again: nothing wanted, nothing rejected, true to the surface.
  std::map<int, std::vector<double>> inserts;
  for (const SplitWanted& w : cm.splitWanted) {
    REQUIRE(w.segment >= 0 && w.segment < static_cast<int32_t>(where.size()));
    auto [c, i] = where[w.segment];
    const std::vector<double>& t = coedges[c].t;
    inserts[c].push_back(t[i] + w.fraction * (t[i + 1] - t[i]));
    CHECK(std::fabs(w.fraction - 0.5) < 1e-9);  // the size the same at both ends
  }
  for (auto& [c, ts] : inserts) {
    std::vector<double>& t = coedges[c].t;
    bool up = t.back() > t.front();
    t.insert(t.end(), ts.begin(), ts.end());
    std::sort(t.begin(), t.end(), [&](double a, double b) { return up ? a < b : a > b; });
  }
  d = domainOf(coedges, threeD);
  Mesh2 again = mesh2(d, coarse);
  REQUIRE(again.status == cadgeom::Status::ok);
  CHECK(again.splitWanted.empty());
  CHECK(again.rejected.empty());
  InThreeD r2 = measure(again, coarse);
  CHECK_EQ(r2.refused, 0);
  CHECK_EQ(r2.inward, 0);
  CHECK(r2.area < band && r2.area > band * (1 - deflection));
}
