// surface.h on every surface kind: the reference shapes' facts at every variant (points, partials and normals,
// inverses), the catalogue's surface cases (ambiguous projections, singularities, pole lines), and checks against
// independent oracles on every surface of the reference models (near and far from the origin, mirrored): boxes and
// derivative bounds against dense samples over random rectangles, partials to order 3 against central differences
// of the order below, inversion against dense sampling, infinite ranges, and the hint.
#include <cad_geom/surface.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>

#include "../src/surface_impl.h"
#include "brep_models.h"
#include "check.h"

using namespace cadgeom;
using cadgeom::surfaces::kPartials;
using cadgeom::surfaces::pidx;
using cadgeom::surfaces::SurfaceImpl;

namespace {

constexpr double kTwoPi = 6.283185307179586;
const double inf = std::numeric_limits<double>::infinity();

Vec3 V(const fixtures::Vec& v) { return {v.x, v.y, v.z}; }
bool nearVec(Vec3 got, Vec3 want, double tol, double abs) {
  return norm(got - want) <= std::fmax(tol * norm(want), abs);
}
std::string show(Vec3 v) {
  char b[128];
  std::snprintf(b, sizeof b, "(%.17g, %.17g, %.17g)", v.x, v.y, v.z);
  return b;
}
bool inBox(const Box3& b, Vec3 p) { return b.x.contains(p.x) && b.y.contains(p.y) && b.z.contains(p.z); }

/** The parameter distance, a period taken the short way. */
double pdist(double a, double b, double period) {
  double d = std::fabs(a - b);
  return period > 0 ? std::fmin(d, std::fabs(period - std::fmod(d, period))) : d;
}

const SurfaceImpl* impl(const Surface* s) { return dynamic_cast<const SurfaceImpl*>(s); }

/** Every surface row of the reference models at these variants, made. */
struct Made {
  std::string name;
  std::unique_ptr<Surface> s;
};
std::vector<Made> zoo(std::initializer_list<const char*> variants) {
  std::vector<Made> z;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    bool want = false;
    for (const char* v : variants) want = want || std::strcmp(ref.variant, v) == 0;
    if (!want) continue;
    const Model m(ref.data, ref.size);
    for (int row = 0; row < m.surfaces(); row++) {
      Status st;
      auto s = makeSurface(m, row, st);
      if (s) z.push_back({std::string(ref.file) + " surface " + std::to_string(row), std::move(s)});
    }
  }
  return z;
}

/** A finite parameter rectangle to sample: the domain, infinite sides cut to [-3, 3] about 0. */
void sampleRange(const SurfaceDomain& d, Range& ru, Range& rv) {
  ru = std::isfinite(d.u.lo) && std::isfinite(d.u.hi) ? d.u : Range{-3, 3};
  rv = std::isfinite(d.v.lo) && std::isfinite(d.v.hi) ? d.v : Range{-3, 3};
}

} // namespace

// -- The reference shapes.

TEST_CASE("reference surfacePoint facts: points, partials and normals at every variant") {
  int n = 0;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    const Model m(ref.data, ref.size);
    REQUIRE(m.ok());
    for (int j = 0; j < ref.nSurfacePoints; j++) {
      const fixtures::SurfacePoint& f = ref.surfacePoints[j];
      Status s;
      auto S = makeSurface(m, f.surface, s);
      if (!S) {
        CHECK(false);
        std::printf("  %s surface %d: no surface (status %d)\n", ref.file, f.surface, int(s));
        continue;
      }
      SurfacePoint q;
      Status e = S->eval(f.u, f.v, 2, q);
      bool ok = e == Status::ok && nearVec(q.p, V(f.p), f.tol, f.abs) && nearVec(q.du, V(f.du), f.tol, f.abs)
        && nearVec(q.dv, V(f.dv), f.tol, f.abs) && nearVec(q.duu, V(f.duu), f.tol, f.abs)
        && nearVec(q.duv, V(f.duv), f.tol, f.abs) && nearVec(q.dvv, V(f.dvv), f.tol, f.abs);
      Vec3 nrm;
      Status ns = S->normal(f.u, f.v, nrm);
      bool nok = f.hasN ? ns == Status::ok && nearVec(nrm, V(f.n), 1e-12, 1e-12) : ns == Status::singular;
      if (!ok || !nok) {
        CHECK(ok && nok);
        std::printf("  %s surface %d at (%.17g, %.17g): status %d p %s want %s\n    du %s want %s\n    dv %s want %s\n"
          "    duu %s want %s\n    duv %s want %s\n    dvv %s want %s\n    n %s (status %d) want %s (%d)\n", ref.file,
          f.surface, f.u, f.v, int(e), show(q.p).c_str(), show(V(f.p)).c_str(), show(q.du).c_str(),
          show(V(f.du)).c_str(), show(q.dv).c_str(), show(V(f.dv)).c_str(), show(q.duu).c_str(),
          show(V(f.duu)).c_str(), show(q.duv).c_str(), show(V(f.duv)).c_str(), show(q.dvv).c_str(),
          show(V(f.dvv)).c_str(), show(nrm).c_str(), int(ns), show(V(f.n)).c_str(), f.hasN);
      }
      n++;
    }
  }
  CHECK(n > 400);
}

TEST_CASE("reference surfaceInverse facts at every variant") {
  int n = 0;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    const Model m(ref.data, ref.size);
    for (int j = 0; j < ref.nSurfaceInverses; j++) {
      const fixtures::SurfaceInverse& f = ref.surfaceInverses[j];
      Status s;
      auto S = makeSurface(m, f.surface, s);
      REQUIRE(S);
      SurfaceDomain d = S->domain();
      SurfaceInversion inv = invertSurface(*S, V(f.p), d.u, d.v, f.abs);
      // At a singularity u is any; on a seam the foot's own u may be at either end of the period.
      bool uok = f.atSingularity || pdist(inv.uv.x, f.u, d.uPeriod) <= f.ptol;
      bool ok = inv.status == Status::ok && uok && pdist(inv.uv.y, f.v, d.vPeriod) <= f.ptol
        && check::near(inv.distance, f.distance, f.tol, f.abs) && inv.certainty == f.certainty
        && static_cast<int>(inv.alternatives.size()) == f.nAlternatives && inv.onSeamU == f.onSeamU
        && inv.onSeamV == f.onSeamV && inv.atSingularity == f.atSingularity;
      if (!ok) {
        CHECK(ok);
        std::printf("  %s surface %d from %s: uv (%.17g, %.17g) distance %.17g certainty %d alternatives %zu "
          "seams %d %d "
          "singular %d (status %d); want (%.17g, %.17g) %.17g %d %d %d %d %d\n", ref.file, f.surface,
          show(V(f.p)).c_str(), inv.uv.x, inv.uv.y, inv.distance, int(inv.certainty), inv.alternatives.size(),
          inv.onSeamU, inv.onSeamV, inv.atSingularity, int(inv.status), f.u, f.v, f.distance, int(f.certainty),
          f.nAlternatives, f.onSeamU, f.onSeamV, f.atSingularity);
      }
      n++;
    }
  }
  CHECK(n > 100);
}

// -- The catalogue (packages/cad-brep/test/reference/fixtures/case-*-s1.json, "cases").

TEST_CASE("catalogue: invertSurface cases (ambiguous projections, a pole, a spindle torus, an offset past its "
  "radius)") {
  int n = 0;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    const Model m(ref.data, ref.size);
    for (int j = 0; j < ref.nInvertSurfaceCases; j++) {
      const fixtures::InvertSurfaceCase& c = ref.invertSurfaceCases[j];
      Status s;
      auto S = makeSurface(m, c.surface, s);
      REQUIRE(S);
      SurfaceDomain d = S->domain();
      SurfaceInversion inv = invertSurface(*S, V(c.p), d.u, d.v, c.tol);
      // The best foot is any of the equally near ones: the expected one or one of its alternatives.
      auto matches = [&](double u, double v) {
        return (c.atSingularity || pdist(u, c.u, d.uPeriod) <= 1e-7) && pdist(v, c.v, d.vPeriod) <= 1e-7;
      };
      bool foot = matches(inv.uv.x, inv.uv.y);
      for (int a = 0; !foot && a < c.nAlternatives; a++)
        foot = pdist(inv.uv.x, c.alternatives[2 * a], d.uPeriod) <= 1e-7
          && pdist(inv.uv.y, c.alternatives[2 * a + 1], d.vPeriod) <= 1e-7;
      // A continuum: any foot on it.
      if (c.hasFamily) foot = c.familyU ? pdist(inv.uv.y, c.familyAt, d.vPeriod) <= 1e-7
        : pdist(inv.uv.x, c.familyAt, d.uPeriod) <= 1e-7;
      bool ok = inv.status == Status::ok && foot && check::near(inv.distance, c.distance, 1e-12, c.tol)
        && inv.certainty == c.certainty && inv.atSingularity == c.atSingularity
        && (c.certainty == Certainty::ambiguous) == !inv.alternatives.empty();
      // Seam flags only where the foot is the expected one (another foot of a continuum has its own).
      if (!c.hasFamily && matches(inv.uv.x, inv.uv.y)) ok = ok && inv.onSeamU == c.onSeamU && inv.onSeamV == c.onSeamV;
      if (!ok) {
        CHECK(ok);
        std::printf("  %s: uv (%.17g, %.17g) distance %.17g certainty %d alternatives %zu seams %d %d singular %d "
          "(status %d)\n", c.id, inv.uv.x, inv.uv.y, inv.distance, int(inv.certainty), inv.alternatives.size(),
          inv.onSeamU, inv.onSeamV, inv.atSingularity, int(inv.status));
      }
      n++;
    }
  }
  CHECK(n >= 7);
}

TEST_CASE("catalogue: singularities cases (sphere poles, a cone's apex, a spindle torus's axis crossings)") {
  int n = 0;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    const Model m(ref.data, ref.size);
    for (int j = 0; j < ref.nSingularitiesCases; j++) {
      const fixtures::SingularitiesCase& c = ref.singularitiesCases[j];
      Status s;
      auto S = makeSurface(m, c.surface, s);
      REQUIRE(S);
      std::vector<Singularity> got;
      S->singularities(got);
      bool ok = static_cast<int>(got.size()) == c.nSingularities;
      static const char* kinds[] = {"pole", "apex", "normalVanishes"};
      for (int k = 0; ok && k < c.nSingularities; k++) {
        const fixtures::ExpectedSingularity& e = c.singularities[k];
        ok = std::strcmp(kinds[got[k].kind], e.kind) == 0 && got[k].isoU == e.isoU
          && std::fabs(got[k].at - e.at) <= 1e-12 * std::fmax(1.0, std::fabs(e.at))
          && nearVec(got[k].point, V(e.point), 1e-12, 1e-12);
      }
      if (!ok) {
        CHECK(ok);
        std::printf("  %s: %zu singularities, want %d\n", c.id, got.size(), c.nSingularities);
        for (const Singularity& g : got)
          std::printf("    %s isoU %d at %.17g %s\n", kinds[g.kind], g.isoU, g.at, show(g.point).c_str());
      }
      n++;
    }
  }
  CHECK(n >= 3);
}

TEST_CASE("catalogue: classify2's and nest2's pole lines are the face's surface's singular iso-lines") {
  int n = 0;
  auto check = [&](const Model& m, const char* id, int face, const double* pu, int npu, const double* pv, int npv,
    bool has) {
    if (!has) return;
    Status s;
    auto S = makeSurface(m, m.faceSurface(face), s);
    REQUIRE(S);
    std::vector<Singularity> g;
    S->singularities(g);
    std::vector<double> gu, gv;
    for (const Singularity& x : g)
      if (x.kind != Singularity::normalVanishes) (x.isoU ? gu : gv).push_back(x.at);
    bool ok = static_cast<int>(gu.size()) == npu && static_cast<int>(gv.size()) == npv;
    for (int k = 0; ok && k < npu; k++) ok = std::fabs(gu[k] - pu[k]) <= 1e-12;
    for (int k = 0; ok && k < npv; k++) ok = std::fabs(gv[k] - pv[k]) <= 1e-12;
    if (!ok) {
      CHECK(ok);
      std::printf("  %s: surface's pole lines %zu in u, %zu in v; the case's %d, %d\n", id, gu.size(), gv.size(), npu,
        npv);
    }
    n++;
  };
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    const Model m(ref.data, ref.size);
    for (int j = 0; j < ref.nClassify2Cases; j++) {
      const auto& c = ref.classify2Cases[j];
      check(m, c.id, c.face, c.poleU, c.nPoleU, c.poleV, c.nPoleV, c.hasPoles);
    }
    for (int j = 0; j < ref.nNest2Cases; j++) {
      const auto& c = ref.nest2Cases[j];
      check(m, c.id, c.face, c.poleU, c.nPoleU, c.poleV, c.nPoleV, c.hasPoles);
    }
  }
  CHECK(n > 30);
}

// -- Oracles over every surface of the reference models, near, far and mirrored.

TEST_CASE("bounds hold: boxes of partials to order 2 and derivative bounds against dense samples") {
  std::mt19937_64 rng(11);
  int bad = 0, n = 0;
  for (Made& m : zoo({"s1", "far", "mirror", "s1e6"})) {
    const SurfaceImpl* s = impl(m.s.get());
    REQUIRE(s);
    SurfaceDomain d = s->domain();
    Range DU, DV;
    sampleRange(d, DU, DV);
    std::uniform_real_distribution<double> U(0, 1);
    for (int trial = 0; trial < 6; trial++) {
      double a = U(rng), b = U(rng), c = U(rng), e = U(rng);
      if (trial == 0) a = 0, b = 1, c = 0, e = 1;
      Range ru{DU.lo + (DU.hi - DU.lo) * std::fmin(a, b), DU.lo + (DU.hi - DU.lo) * std::fmax(a, b)};
      Range rv{DV.lo + (DV.hi - DV.lo) * std::fmin(c, e), DV.lo + (DV.hi - DV.lo) * std::fmax(c, e)};
      Box3 box[6];
      bool ok = true;
      for (int t = 0, i = 0; t <= 2; t++)
        for (int l = 0; l <= t; l++, i++) ok = ok && s->derivBox(ru, rv, t - l, l, box[i]) == Status::ok;
      double b1[3], b2[3];
      ok = ok && s->derivBound(ru, rv, 1, b1) == Status::ok && s->derivBound(ru, rv, 2, b2) == Status::ok;
      if (!ok) continue;  // an offset whose basis's normal may vanish there: no bound, said so
      for (int x = 0; x <= 10; x++)
        for (int y = 0; y <= 10; y++) {
          // (Clamped: the last sample can round past the rectangle's end.)
          double u = std::fmin(ru.lo + (ru.hi - ru.lo) * x / 10, ru.hi);
          double v = std::fmin(rv.lo + (rv.hi - rv.lo) * y / 10, rv.hi);
          Vec3 D[kPartials];
          s->derivs(u, v, 2, D);
          for (int i = 0; i < 6; i++)
            if (!inBox(box[i], D[i])) {
              if (bad++ < 10) std::printf("  %s: partial %d at (%.17g, %.17g) %s outside its box [%.17g, %.17g] "
                "[%.17g, %.17g] [%.17g, %.17g] over [%.17g, %.17g] x [%.17g, %.17g]\n", m.name.c_str(), i, u, v,
                show(D[i]).c_str(), box[i].x.lo, box[i].x.hi, box[i].y.lo, box[i].y.hi, box[i].z.lo, box[i].z.hi,
                ru.lo, ru.hi, rv.lo, rv.hi);
            }
          if (norm(D[1]) > b1[0] || norm(D[2]) > b1[1] || norm(D[3]) > b2[0] || norm(D[4]) > b2[1]
            || norm(D[5]) > b2[2]) {
            if (bad++ < 10) std::printf("  %s: a derivative bound fails at (%.17g, %.17g)\n", m.name.c_str(), u, v);
          }
          n++;
        }
    }
  }
  CHECK(bad == 0);
  CHECK(n > 20000);
}

TEST_CASE("partials to order 3 agree with central differences of the order below") {
  std::mt19937_64 rng(5);
  int bad = 0, n = 0;
  for (Made& m : zoo({"s1", "far", "mirror"})) {
    const SurfaceImpl* s = impl(m.s.get());
    SurfaceDomain d = s->domain();
    Range ru, rv;
    sampleRange(d, ru, rv);
    std::uniform_real_distribution<double> U(0.05, 0.95);
    for (int trial = 0; trial < 8; trial++) {
      double u = ru.lo + (ru.hi - ru.lo) * U(rng), v = rv.lo + (rv.hi - rv.lo) * U(rng);
      double hu = 1e-5 * (ru.hi - ru.lo), hv = 1e-5 * (rv.hi - rv.lo);
      Vec3 D[kPartials], A[kPartials], B[kPartials], C[kPartials], E[kPartials];
      if (s->derivs(u, v, 3, D) != Status::ok) continue;
      s->derivs(u + hu, v, 2, A), s->derivs(u - hu, v, 2, B), s->derivs(u, v + hv, 2, C), s->derivs(u, v - hv, 2, E);
      for (int t = 0; t <= 2; t++)
        for (int l = 0; l <= t; l++) {
          int k = t - l;
          Vec3 fu = (1 / (2 * hu)) * (A[pidx(k, l)] - B[pidx(k, l)]);
          Vec3 fv = (1 / (2 * hv)) * (C[pidx(k, l)] - E[pidx(k, l)]);
          Vec3 gu = D[pidx(k + 1, l)], gv = D[pidx(k, l + 1)];
          double scale = norm(D[pidx(k, 0)]) + norm(D[pidx(0, l)]) + norm(gu) + norm(gv) + 1e-300;
          // Rounding of a difference far from the origin: the partial's own size over the step.
          double fl = t == 0 ? 1e-15 * norm(D[0]) / std::fmin(hu, hv) : 0;
          if (norm(fu - gu) > 1e-6 * scale + fl || norm(fv - gv) > 1e-6 * scale + fl) {
            if (bad++ < 10) std::printf("  %s at (%.17g, %.17g): order (%d, %d) differs from its differences\n",
              m.name.c_str(), u, v, k, l);
          }
          n++;
        }
    }
  }
  CHECK(bad == 0);
  CHECK(n > 3000);
}

TEST_CASE("inversion: points near every surface against dense sampling, the foot at the distance reported") {
  std::mt19937_64 rng(3);
  int bad = 0, n = 0;
  for (Made& m : zoo({"s1", "far", "mirror"})) {
    const SurfaceImpl* s = impl(m.s.get());
    SurfaceDomain d = s->domain();
    Range ru, rv;
    sampleRange(d, ru, rv);
    std::uniform_real_distribution<double> U(0, 1), G(-1, 1);
    for (int trial = 0; trial < 4; trial++) {
      Vec3 D[kPartials];
      s->derivs(ru.lo + (ru.hi - ru.lo) * U(rng), rv.lo + (rv.hi - rv.lo) * U(rng), 0, D);
      Box3 b;
      s->derivBox(ru, rv, 0, 0, b);
      double size = std::fmax(1e-300, std::hypot(b.x.width(), std::hypot(b.y.width(), b.z.width())));
      Vec3 p = D[0] + (0.2 * size) * Vec3{G(rng), G(rng), G(rng)};
      double tol = 1e-9 * size;
      SurfaceInversion inv = invertSurface(*s, p, ru, rv, tol);
      if (inv.status != Status::ok) {
        if (bad++ < 10) std::printf("  %s: status %d\n", m.name.c_str(), int(inv.status));
        continue;
      }
      Vec3 f[kPartials];
      s->derivs(inv.uv.x, inv.uv.y, 0, f);
      double best = inf;
      for (int x = 0; x <= 120; x++)
        for (int y = 0; y <= 120; y++) {
          Vec3 q[kPartials];
          s->derivs(ru.lo + (ru.hi - ru.lo) * x / 120, rv.lo + (rv.hi - rv.lo) * y / 120, 0, q);
          best = std::fmin(best, norm(q[0] - p));
        }
      bool ok = std::fabs(norm(f[0] - p) - inv.distance) <= 1e-12 * size + 1e-15 * norm(p)
        && inv.distance <= best + tol + 1e-12 * size;
      if (!ok && bad++ < 10) std::printf("  %s: distance %.17g, the samples' %.17g\n", m.name.c_str(), inv.distance,
        best);
      n++;
    }
  }
  CHECK(bad == 0);
  CHECK(n > 200);
}

TEST_CASE("inversion over infinite ranges: a plane and a cylinder from far along the free direction") {
  const fixtures::Reference* ref = fixtures::reference("box", "moved");
  REQUIRE(ref);
  const Model m(ref->data, ref->size);
  Status s;
  auto plane = makeSurface(m, 0, s);
  REQUIRE(plane);
  for (Vec2 uv : {Vec2{1e5, -3e4}, Vec2{-7e6, 2e6}, Vec2{0.25, 0.5}}) {
    SurfacePoint q;
    plane->eval(uv.x, uv.y, 1, q);
    Vec3 n = (1 / norm(cross(q.du, q.dv))) * cross(q.du, q.dv);
    SurfaceInversion inv = invertSurface(*plane, q.p + 2.0 * n, {-inf, inf}, {-inf, inf}, 1e-9);
    CHECK(inv.status == Status::ok);
    CHECK_NEAR(inv.uv.x, uv.x, 0, 1e-9 * std::fmax(1.0, std::fabs(uv.x)));
    CHECK_NEAR(inv.uv.y, uv.y, 0, 1e-9 * std::fmax(1.0, std::fabs(uv.y)));
    CHECK_NEAR(inv.distance, 2, 1e-9, 0);
    CHECK(inv.certainty == Certainty::unique);
  }
  const fixtures::Reference* cy = fixtures::reference("cylinder", "mirror");
  REQUIRE(cy);
  const Model mc(cy->data, cy->size);
  int row = -1;
  for (int r = 0; r < mc.surfaces(); r++)
    if (mc.surfaceKind(r) == CBR_SURFACE_CYLINDER) row = r;
  REQUIRE(row >= 0);
  auto cyl = makeSurface(mc, row, s);
  REQUIRE(cyl);
  for (double v : {1e6, -3e5, 2.5}) {
    SurfacePoint q;
    cyl->eval(1.25, v, 1, q);
    Vec3 n = (1 / norm(cross(q.du, q.dv))) * cross(q.du, q.dv);
    SurfaceInversion inv = invertSurface(*cyl, q.p + 0.5 * n, {0, kTwoPi}, {-inf, inf}, 1e-9);
    CHECK(inv.status == Status::ok);
    CHECK_NEAR(inv.uv.x, 1.25, 0, 1e-9);
    CHECK_NEAR(inv.uv.y, v, 0, 1e-9 * std::fmax(1.0, std::fabs(v)));
    CHECK_NEAR(inv.distance, 0.5, 1e-9, 0);
  }
  // An extrusion's free direction, searched by branch and bound after the cut.
  const fixtures::Reference* ex = fixtures::reference("extrusion", "moved");
  REQUIRE(ex);
  const Model me(ex->data, ex->size);
  for (int r = 0; r < me.surfaces(); r++) {
    if (me.surfaceKind(r) != CBR_SURFACE_EXTRUSION) continue;
    auto e = makeSurface(me, r, s);
    REQUIRE(e);
    SurfacePoint q;
    e->eval(2.0, 3e4, 1, q);
    Vec3 n = (1 / norm(cross(q.du, q.dv))) * cross(q.du, q.dv);
    SurfaceInversion inv = invertSurface(*e, q.p + 0.25 * n, {0, kTwoPi}, {-inf, inf}, 1e-9);
    CHECK(inv.status == Status::ok);
    CHECK_NEAR(inv.uv.x, 2.0, 0, 1e-8);
    CHECK_NEAR(inv.uv.y, 3e4, 0, 1e-8 * 3e4);
    CHECK_NEAR(inv.distance, 0.25, 1e-8, 0);
  }
}

TEST_CASE("the hint picks among equally near feet, and never replaces the search") {
  const fixtures::Reference* ref = fixtures::reference("case-parabolic", "s1");
  REQUIRE(ref);
  const Model m(ref->data, ref->size);
  Status s;
  auto S = makeSurface(m, 0, s);
  REQUIRE(S);
  // (3, 0, 0) is nearest at u = -1 and u = 1 alike.
  for (double side : {-1.0, 1.0}) {
    Vec2 hint{0.9 * side, 0.2};
    SurfaceInversion inv = invertSurface(*S, {3, 0, 0}, {-3, 3}, {-inf, inf}, 1e-9, &hint);
    CHECK(inv.status == Status::ok);
    CHECK(inv.certainty == Certainty::ambiguous);
    CHECK_NEAR(inv.uv.x, side, 0, 1e-9);
    REQUIRE(inv.alternatives.size() == 1);
    CHECK_NEAR(inv.alternatives[0].x, -side, 0, 1e-9);
  }
  // A hint near a farther local minimum: the global one still wins. (1.5, 0, 0) is nearest the vertex; from (0.5, 5)
  // the parameters' far side.
  Vec2 far{2.5, 5};
  SurfaceInversion inv = invertSurface(*S, {1.5, 0, 0.4}, {-3, 3}, {-inf, inf}, 1e-9, &far);
  CHECK(inv.certainty == Certainty::unique);
  CHECK_NEAR(inv.uv.x, 0, 0, 1e-9);
  CHECK_NEAR(inv.uv.y, 0.2, 0, 1e-9);
  CHECK_NEAR(inv.distance, 1.5, 1e-12, 0);
}

TEST_CASE("cones and tori: the cone's apex and seam, a spindle torus, feet in closed form against the search") {
  const fixtures::Reference* ref = fixtures::reference("case-singular", "s1");
  REQUIRE(ref);
  const Model m(ref->data, ref->size);
  int row = -1;
  for (int r = 0; r < m.surfaces(); r++)
    if (m.surfaceKind(r) == CBR_SURFACE_CONE) row = r;
  REQUIRE(row >= 0);
  Status s;
  auto cone = makeSurface(m, row, s);
  REQUIRE(cone);
  // The apex (0, 0, -1): a singularity, u arbitrary; the seam at u = 0 and 2 pi.
  SurfaceInversion a = invertSurface(*cone, {0, 0, -1}, {0, kTwoPi}, {-inf, inf}, 1e-9);
  CHECK(a.atSingularity);
  CHECK(!a.onSeamU);
  CHECK_NEAR(a.uv.y, -1, 0, 1e-9);
  CHECK_NEAR(a.distance, 0, 0, 1e-12);
  SurfacePoint q;
  cone->eval(0, -0.5, 1, q);
  SurfaceInversion b = invertSurface(*cone, q.p, {0, kTwoPi}, {-inf, inf}, 1e-9);
  CHECK(b.onSeamU);
  CHECK(!b.atSingularity);
  CHECK_NEAR(b.uv.y, -0.5, 0, 1e-12);
  // A point on the axis below the apex: nearest the lower nappe (v < -1, the radius r + v k negative), all round the
  // circle at v = -2, radius 1: a continuum at distance sqrt 2, nearer than the apex at 2.
  SurfaceInversion c = invertSurface(*cone, {0, 0, -3}, {0, kTwoPi}, {-inf, inf}, 1e-9);
  CHECK(!c.atSingularity);
  CHECK(c.certainty == Certainty::ambiguous);
  CHECK_NEAR(c.uv.y, -2, 0, 1e-9);
  CHECK_NEAR(c.distance, std::sqrt(2.0), 1e-12, 0);
  // Closed forms against branch and bound on a quarter of the domain (no closed form there), points all round.
  std::mt19937_64 rng(9);
  std::uniform_real_distribution<double> G(-3, 3);
  for (Made& z : zoo({"s1", "mirror"})) {
    const SurfaceImpl* t = impl(z.s.get());
    std::vector<Vec2> cands;
    SurfaceDomain d = t->domain();
    if (!t->footCandidates({1, 1, 1}, d.u, std::isfinite(d.v.lo) ? d.v : Range{-inf, inf}, 1e-9, cands)) continue;
    for (int k = 0; k < 20; k++) {
      Vec3 p{G(rng), G(rng), G(rng)};
      SurfaceInversion whole = invertSurface(*t, p, d.u, d.v, 1e-10);
      // The same over four quarters in u, searched: the least of their distances.
      double best = inf;
      for (int j = 0; j < 4; j++) {
        Range ru{d.u.lo + (d.u.hi - d.u.lo) * j / 4, d.u.lo + (d.u.hi - d.u.lo) * (j + 1) / 4};
        SurfaceInversion part = invertSurface(*t, p, ru, d.v, 1e-10);
        if (part.status == Status::ok) best = std::fmin(best, part.distance);
      }
      bool ok = whole.status == Status::ok && std::fabs(whole.distance - best) <= 1e-9 * (1 + best);
      if (!ok) {
        CHECK(ok);
        std::printf("  %s from %s: closed form %.17g, searched %.17g\n", z.name.c_str(), show(p).c_str(),
          whole.distance, best);
      }
    }
  }
}
