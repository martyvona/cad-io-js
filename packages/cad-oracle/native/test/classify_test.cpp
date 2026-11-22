// oracle.h's rayFace on the reference shapes' closed shells (each at several variants) against facts that don't need
// the classification under test: a line from far outside to far outside crosses a closed shell an even number of
// times; a line through the middle of a convex solid crosses it twice; a line through the middle of a box's edge has
// a boundary hit; a line missing the solid's box has no hit.

#include <cmath>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>
#include <vector>

#include "brep_models.h"
#include "cad_geom/curve.h"
#include "cad_geom/model.h"
#include "cad_geom/surface.h"
#include "cad_oracle/oracle.h"
#include "check.h"

using namespace cadoracle;
using cadgeom::Model;
using cadgeom::Range;

namespace {

/** The shells' faces: shell s's face uses [first, first + count). */
std::vector<std::vector<int>> shellFaces(const Model& m) {
  std::vector<std::vector<int>> out;
  for (int s = 0; s < m.rows(CBR_SHELL_KIND); s++) {
    std::vector<int> f;
    const int first = m.i32(CBR_SHELL_FIRST)[s], count = m.i32(CBR_SHELL_COUNT)[s];
    for (int i = first; i < first + count; i++) f.push_back(m.i32(CBR_FACE_USE_FACE)[i]);
    out.push_back(f);
  }
  return out;
}

bool allClosed(const Model& m) {
  if (m.rows(CBR_SHELL_KIND) == 0) return false;
  for (int s = 0; s < m.rows(CBR_SHELL_KIND); s++)
    if (m.u8(CBR_SHELL_KIND)[s] != CBR_SHELL_CLOSED) return false;
  return true;
}

/** A box holding the model: its vertices, its edges' curves over their ranges, its faces' finite surfaces. */
void modelBox(const Model& m, Vec3& lo, Vec3& hi) {
  lo = {INFINITY, INFINITY, INFINITY}, hi = {-INFINITY, -INFINITY, -INFINITY};
  auto add = [&](double x0, double x1, double y0, double y1, double z0, double z1) {
    lo = {std::fmin(lo.x, x0), std::fmin(lo.y, y0), std::fmin(lo.z, z0)};
    hi = {std::fmax(hi.x, x1), std::fmax(hi.y, y1), std::fmax(hi.z, z1)};
  };
  for (int v = 0; v < m.vertices(); v++) {
    const Vec3 p = m.vertexPoint(v);
    add(p.x, p.x, p.y, p.y, p.z, p.z);
  }
  for (int e = 0; e < m.edges(); e++) {
    Status st;
    if (m.edgeCurve(e) < 0) continue;
    auto c = cadgeom::makeCurve(m, m.edgeCurve(e), st);
    const Range r = m.edgeRange(e);
    cadgeom::Box3 b;
    if (c && std::isfinite(r.lo) && std::isfinite(r.hi) &&
      c->bound({std::fmin(r.lo, r.hi), std::fmax(r.lo, r.hi)}, b) == Status::ok)
      add(b.x.lo, b.x.hi, b.y.lo, b.y.hi, b.z.lo, b.z.hi);
  }
  for (int f = 0; f < m.faces(); f++) {
    Status st;
    auto s = cadgeom::makeSurface(m, m.faceSurface(f), st);
    if (!s) continue;
    const cadgeom::SurfaceDomain d = s->domain();
    cadgeom::Box3 b;
    if (std::isfinite(d.u.lo) && std::isfinite(d.u.hi) && std::isfinite(d.v.lo) && std::isfinite(d.v.hi) &&
      s->bound(d.u, d.v, b) == Status::ok)
      add(b.x.lo, b.x.hi, b.y.lo, b.y.hi, b.z.lo, b.z.hi);
  }
}

/** The line's hits on a shell's faces: crossings counted, and whether every hit on them is a crossing. */
struct Count {
  int crossings = 0;
  bool clean = true;
};
Count across(Oracle& oracle, const std::vector<int>& faces, Vec3 o, Vec3 d) {
  Count c;
  for (int f : faces) {
    const RayFace r = oracle.rayFace(f, o, d, {0, 1});
    c.clean = c.clean && r.clean();
    for (const FaceHit& h : r.hits) c.crossings += h.kind == FaceHit::crossing;
  }
  return c;
}

} // namespace

TEST_CASE("rayFace: across closed shells far to far an even count, through a convex one's middle two, a box's edge") {
  std::mt19937_64 rng(13);
  std::uniform_real_distribution<double> U(0, 1), G(-1, 1);
  int bad = 0, lines = 0, usable = 0, convexLines = 0, edgeLines = 0;
  const char* convex[] = {"box", "cylinder", "cone", "bsplineCylinder", "bsplineSphere", "revolutionSphere"};
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    bool variant = false;
    for (const char* v : {"s1", "far", "mirror", "s1e3"}) variant = variant || std::strcmp(ref.variant, v) == 0;
    if (!variant) continue;
    const Model m(ref.data, ref.size);
    if (!allClosed(m)) continue;
    Oracle oracle(ref.data, ref.size);
    REQUIRE(oracle.ok());
    const std::vector<std::vector<int>> shells = shellFaces(m);
    Vec3 lo, hi;
    modelBox(m, lo, hi);
    const Vec3 mid = 0.5 * (lo + hi);
    const double L = 10 * cadgeom::norm(hi - lo);
    auto line = [&](Vec3 through, Vec3& o, Vec3& d) {
      Vec3 dir{G(rng), G(rng), G(rng)};
      dir = (1 / cadgeom::norm(dir)) * dir;
      o = through - L * dir, d = (2 * L) * dir;
    };
    // Far to far through random points of the box: even, shell by shell, wherever the line is usable.
    for (int k = 0; k < 6; k++) {
      Vec3 o, d;
      line(lo + Vec3{U(rng) * (hi.x - lo.x), U(rng) * (hi.y - lo.y), U(rng) * (hi.z - lo.z)}, o, d);
      for (const std::vector<int>& faces : shells) {
        const Count c = across(oracle, faces, o, d);
        lines++;
        if (!c.clean) continue;
        usable++;
        if (c.crossings % 2 != 0 && bad++ < 20)
          std::printf("  %s %s: a line far to far crossed a closed shell %d times\n", ref.name, ref.variant,
            c.crossings);
      }
    }
    // Through a convex solid's middle: twice.
    bool isConvex = false;
    for (const char* n : convex) isConvex = isConvex || std::strcmp(ref.name, n) == 0;
    if (isConvex && shells.size() == 1) {
      for (int k = 0; k < 4; k++) {
        Vec3 o, d;
        line(mid, o, d);
        const Count c = across(oracle, shells[0], o, d);
        convexLines++;
        if (c.clean && c.crossings != 2 && bad++ < 20)
          std::printf("  %s %s: a line through the middle crossed %d times\n", ref.name, ref.variant, c.crossings);
      }
    }
    // Through the middle of a box's edge: some face sees it on its boundary.
    if (std::strcmp(ref.name, "box") == 0 && m.edges() > 0) {
      const int e = 0;
      const Vec3 p = 0.5 * (m.vertexPoint(m.edgeStart(e)) + m.vertexPoint(m.edgeEnd(e)));
      Vec3 o, d;
      line(p, o, d);
      bool boundary = false;
      for (int f = 0; f < m.faces(); f++)
        for (const FaceHit& h : oracle.rayFace(f, o, d, {0, 1}).hits)
          boundary = boundary || h.kind == FaceHit::boundary;
      edgeLines++;
      if (!boundary && bad++ < 20) std::printf("  %s %s: a line through an edge's middle on no boundary\n", ref.name,
        ref.variant);
    }
    // Missing the box: nothing.
    {
      const Vec3 o = hi + Vec3{L, L, L}, d = Vec3{L, -0.5 * L, 0.25 * L};
      for (int f = 0; f < m.faces(); f++)
        if (!oracle.rayFace(f, o, d, {0, 1}).hits.empty() && bad++ < 20)
          std::printf("  %s %s: a line clear of the box met face %d\n", ref.name, ref.variant, f);
    }
  }
  CHECK(bad == 0);
  CHECK(usable > 0.8 * lines);
  CHECK(convexLines > 20);
  CHECK(edgeLines >= 4);
}

TEST_CASE("rayFace: rows out of range invalid") {
  const fixtures::Reference& r = *fixtures::reference("box", "s1");
  Oracle oracle(r.data, r.size);
  CHECK(oracle.rayFace(-1, {0, 0, 0}, {1, 0, 0}, {0, 1}).status == Status::invalidModel);
  CHECK(oracle.rayFace(1 << 20, {0, 0, 0}, {1, 0, 0}, {0, 1}).status == Status::invalidModel);
}

TEST_CASE("rayFace: tangent to a sphere, lying in a box's face, along a B-spline cylinder's ruling: unusable") {
  // Each a contact a parity count can't take: a tangency (the one-face spheres, every surface point on the face), an
  // overlap (the plane of a box face, through the face's middle), the search out of budget (a ruling without a
  // closed form). None of the three may come back clean.
  int bad = 0, seen = 0;
  for (const char* variant : {"s1", "far", "mirror"}) {
    for (const char* name : {"bsplineSphere", "revolutionSphere"}) {
      const fixtures::Reference& r = *fixtures::reference(name, variant);
      const Model m(r.data, r.size);
      Oracle oracle(r.data, r.size);
      Status st;
      auto s = cadgeom::makeSurface(m, m.faceSurface(0), st);
      REQUIRE(s);
      const cadgeom::SurfaceDomain d = s->domain();
      cadgeom::SurfacePoint p;
      s->eval(d.u.lo + 0.3 * (d.u.hi - d.u.lo), d.v.lo + 0.4 * (d.v.hi - d.v.lo), 1, p);
      const Vec3 dir = (r.scale / cadgeom::norm(p.du)) * p.du;
      const RayFace hit = oracle.rayFace(0, p.p - 0.5 * dir, dir, {0, 1});
      seen++;
      if (hit.clean() && bad++ < 10) std::printf("  %s %s: a tangent line clean\n", name, variant);
    }
    {
      const fixtures::Reference& r = *fixtures::reference("box", variant);
      const Model m(r.data, r.size);
      Oracle oracle(r.data, r.size);
      // Face 0's plane through its vertices' middle, along an edge of it.
      std::vector<Vec3> v;
      for (int l = m.faceFirstLoop(0); l < m.faceFirstLoop(0) + m.faceLoopCount(0); l++)
        for (int c = m.loopFirst(l); c < m.loopFirst(l) + m.loopCount(l); c++)
          v.push_back(m.vertexPoint(m.edgeStart(m.coedgeEdge(c))));
      REQUIRE(v.size() >= 3);
      Vec3 c{0, 0, 0};
      for (Vec3 x : v) c = c + (1.0 / v.size()) * x;
      const Vec3 dir = 3.0 * (v[1] - v[0]);
      const RayFace hit = oracle.rayFace(0, c - 0.5 * dir, dir, {0, 1});
      seen++;
      if (hit.clean() && bad++ < 10) std::printf("  box %s: a line in its face clean\n", variant);
    }
    {
      const fixtures::Reference& r = *fixtures::reference("bsplineCylinder", variant);
      const Model m(r.data, r.size);
      Oracle oracle(r.data, r.size);
      for (int f = 0; f < m.faces(); f++) {
        Status st;
        auto s = cadgeom::makeSurface(m, m.faceSurface(f), st);
        if (!s || m.surfaceKind(m.faceSurface(f)) != CBR_SURFACE_BSPLINE) continue;
        const cadgeom::SurfaceDomain d = s->domain();
        cadgeom::SurfacePoint p;
        s->eval(d.u.lo + 0.3 * (d.u.hi - d.u.lo), 0.5 * d.v.lo + 0.5 * d.v.hi, 1, p);
        const Vec3 dir = (0.5 * (d.v.hi - d.v.lo)) * p.dv;
        const RayFace hit = oracle.rayFace(f, p.p - 0.5 * dir, dir, {0, 1});
        seen++;
        if (hit.clean() && bad++ < 10) std::printf("  bsplineCylinder %s: a line along its ruling clean\n", variant);
      }
    }
  }
  CHECK(bad == 0);
  CHECK(seen >= 12);
}
