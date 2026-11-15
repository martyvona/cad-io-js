// mesh2d.h on a real face: cad-brep's seamCylinder test model (a cylinder of radius 2 and height 5, its side one face
// bounded by the bottom and top circles and its seam used twice), its loop turned into a (u, v) domain through
// cad-geom: each edge sampled once at parameters on its 3D curve, the face's points the p-curves at the same
// parameters (a p-curve's parameter is its edge's, as STEP has it), so the seam's two uses are two copies of one
// edge's samples at u = 0 and u = 2 pi. The size field is the surface's first fundamental form scaled to the wanted
// 3D edge length; accept() takes a triangle whose middle is within the deflection of the surface. Then the mesh in
// 3D: its area against the band's, its normals outward, every triangle within the deflection, the seam's copies one
// set of 3D points.
#include <tess_cadio/mesh2d.h>

#include <cad_geom/curve.h>
#include <cad_geom/surface.h>

#include <cmath>
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
  // The edges sampled finer than the deflection needs on the circles (a chord l on radius r deviates by l^2 / 8 r:
  // 0.1 gives 6.3e-4 under 1e-3), as the edge sampler will choose: a fixed boundary too coarse can't be met inside.
  const double h = 0.1, deflection = 1e-3;

  // Each edge's samples, once: n + 1 parameters over its range (an edge from a vertex to itself on a periodic
  // curve, the whole period).
  int l = m.faceFirstLoop(0);
  Domain2 d;
  std::vector<int32_t> loop;
  std::vector<Vec3> threeD;  // the 3D point each domain point stands for (the edge's sample)
  for (int k = 0; k < m.loopCount(l); k++) {
    int c = m.loopFirst(l) + k, e = m.coedgeEdge(c);
    std::unique_ptr<cadgeom::Curve> curve = cadgeom::makeCurve(m, m.edgeCurve(e), st);
    std::unique_ptr<cadgeom::Curve> pcurve = cadgeom::makeCurve(m, m.coedgePcurve(c), st);
    REQUIRE(curve && pcurve);
    // The edge's range: given, else its vertices inverted onto its curve (from a vertex to itself on a periodic
    // curve, the whole period).
    cadgeom::Range r = m.edgeRange(e);
    if (std::isnan(r.lo)) {
      cadgeom::CurveDomain dom = curve->domain();
      if (m.edgeStart(e) == m.edgeEnd(e)) {
        REQUIRE(dom.period > 0);
        r = {dom.range.lo, dom.range.lo + dom.period};
      } else {
        double t[2];
        for (int j = 0; j < 2; j++) {
          cadgeom::CurveInversion inv = cadgeom::invertCurve(*curve, m.vertexPoint(j ? m.edgeEnd(e) : m.edgeStart(e)),
            dom.range, 1e-9);
          REQUIRE(inv.status == cadgeom::Status::ok && inv.distance < 1e-9);
          t[j] = inv.t;
        }
        REQUIRE(t[1] > t[0]);  // (a periodic curve would take a period on where needed)
        r = {t[0], t[1]};
      }
    }
    // Along the coedge: reversed where it runs against its edge. Its last point is the next coedge's first.
    bool forward = m.coedgeOrientation(c) == CBR_ORIENTATION_FORWARD;
    double len = 0;
    cadgeom::Estimate L = cadgeom::arcLength(*curve, r.lo, r.hi, 1e-10);
    len = L.value;
    int n = std::max(2, static_cast<int>(std::ceil(len / h)));
    for (int i = 0; i < n; i++) {
      double f = static_cast<double>(i) / n, t = forward ? r.lo + f * (r.hi - r.lo) : r.hi - f * (r.hi - r.lo);
      cadgeom::CurvePoint q, p;
      curve->eval(t, 0, q);
      pcurve->eval(t, 0, p);
      loop.push_back(static_cast<int32_t>(d.points.size()));
      d.points.push_back({p.p.x, p.p.y});
      threeD.push_back(q.p);
    }
  }
  d.loops.push_back(loop);
  SurfaceField field(*surface, h, deflection);
  Mesh2 mesh = mesh2(d, field);
  REQUIRE(mesh.status == cadgeom::Status::ok);
  CHECK(mesh.rejected.empty());

  // The domain's points on the surface are the edges' samples: the seam's two copies the same 3D points.
  double off = 0;
  for (size_t i = 0; i < d.points.size(); i++) off = std::fmax(off, cadgeom::norm(field.at(d.points[i]) - threeD[i]));
  CHECK(off < 1e-12);
  // In 3D: the area a little under the band's 2 pi r H (chords inside the surface), the normals outward.
  double area = 0, inward = 0, refused = 0;
  int nt = static_cast<int>(mesh.triangles.size() / 3);
  for (int t = 0; t < nt; t++) {
    Vec2 uv[3];
    Vec3 p[3];
    for (int i = 0; i < 3; i++) uv[i] = mesh.points[mesh.triangles[3 * t + i]], p[i] = field.at(uv[i]);
    Vec3 n = cadgeom::cross(p[1] - p[0], p[2] - p[0]);
    area += 0.5 * cadgeom::norm(n);
    Vec3 g = (1.0 / 3) * (p[0] + p[1] + p[2]);
    inward += cadgeom::dot(n, Vec3{g.x, g.y, 0}) <= 0;
    refused += !field.accept(uv);
  }
  CHECK_EQ(refused, 0);
  const double band = 2 * M_PI * 2 * 5;
  CHECK(area < band);
  CHECK(area > band * (1 - 2 * deflection / 2));  // a chord's sagitta s: area down by about s / r
  CHECK_EQ(inward, 0);
  CHECK(nt > 200);
}
