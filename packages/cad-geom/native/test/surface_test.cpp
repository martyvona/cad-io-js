// surface.h on every surface kind: the reference shapes' facts at every variant (points, partials and normals,
// inverses), the catalogue's surface cases (ambiguous projections, singularities, pole lines), and checks against
// independent oracles on every surface of the reference models (near and far from the origin, mirrored): boxes and
// derivative bounds against dense samples over random rectangles, partials to order 3 against central differences
// of the order below, inversion against dense sampling, infinite ranges, and the hint.
#include <cad_geom/curve.h>
#include <cad_geom/surface.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <random>
#include <string>
#include <tuple>

#include "../src/curve_impl.h"
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
  if (!(period > 0)) return d;
  double r = std::fmod(d, period);
  return std::fmin(r, period - r);
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

/**
 * B-splines built here from raw rows, of what the reference models lack: polynomial, a knot of multiplicity 1 in a
 * quadratic direction (S_uu jumps there), and the twisted bilinear patch z = x y; each also 1e6 from the origin.
 */
std::vector<Made> raw() {
  std::vector<Made> z;
  for (double far : {0.0, 1e6}) {
    {
      // Degree 2 in u over knots 0, 1, 2 (C1 at 1), degree 1 in v over [0, 1]: 4 x 2 poles.
      double r[3 + 2 + 24];
      double knots[] = {0, 1, 2, 0, 1};
      std::copy(knots, knots + 5, r);
      double P[4][2][3] = {{{0, 0, 0}, {0, 1, 0.5}}, {{1, 0, 1.5}, {1, 1, 1}}, {{2, 0, -0.5}, {2, 1, 0}},
        {{3, 0, 1}, {3, 1, 2}}};
      for (int i = 0; i < 4; i++)
        for (int j = 0; j < 2; j++)
          for (int a = 0; a < 3; a++) r[5 + (i * 2 + j) * 3 + a] = P[i][j][a] + (a == 0 ? far : a == 1 ? -far : far);
      int32_t in[11 + 3 + 2] = {2, 1, 4, 2, 3, 2, 0, 0, 0, 0, 0, 3, 1, 3, 2, 2};
      Status s;
      auto b = surfaces::makeBSpline(r, in, s);
      REQUIRE(b);
      z.push_back({std::string("raw C1 quadratic") + (far ? " far" : ""), std::move(b)});
    }
    {
      double r[2 + 2 + 12] = {-2, 2, -2, 2};
      double P[2][2][3] = {{{-2, -2, 4}, {-2, 2, -4}}, {{2, -2, -4}, {2, 2, 4}}};
      for (int i = 0; i < 2; i++)
        for (int j = 0; j < 2; j++)
          for (int a = 0; a < 3; a++) r[4 + (i * 2 + j) * 3 + a] = P[i][j][a] + far;
      int32_t in[11 + 4] = {1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 0, 2, 2, 2, 2};
      Status s;
      auto b = surfaces::makeBSpline(r, in, s);
      REQUIRE(b);
      z.push_back({std::string("raw twist") + (far ? " far" : ""), std::move(b)});
    }
  }
  return z;
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
  std::vector<Made> all = zoo({"s1", "far", "mirror", "s1e6"});
  for (Made& m : raw()) all.push_back(std::move(m));
  for (Made& m : all) {
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
      // Each box checked where it's given (an offset's partials have none where its basis's normal may vanish).
      Box3 box[6];
      bool given[6];
      for (int t = 0, i = 0; t <= 2; t++)
        for (int l = 0; l <= t; l++, i++) given[i] = s->derivBox(ru, rv, t - l, l, box[i]) == Status::ok;
      double b1[3], b2[3];
      bool bounds = s->derivBound(ru, rv, 1, b1) == Status::ok && s->derivBound(ru, rv, 2, b2) == Status::ok;
      for (int x = 0; x <= 10; x++)
        for (int y = 0; y <= 10; y++) {
          // (Clamped: the last sample can round past the rectangle's end.)
          double u = std::fmin(ru.lo + (ru.hi - ru.lo) * x / 10, ru.hi);
          double v = std::fmin(rv.lo + (rv.hi - rv.lo) * y / 10, rv.hi);
          Vec3 D[kPartials];
          if (s->derivs(u, v, 2, D) == Status::singular) continue;
          for (int i = 0; i < 6; i++)
            if (given[i] && !inBox(box[i], D[i])) {
              if (bad++ < 10) std::printf("  %s: partial %d at (%.17g, %.17g) %s outside its box [%.17g, %.17g] "
                "[%.17g, %.17g] [%.17g, %.17g] over [%.17g, %.17g] x [%.17g, %.17g]\n", m.name.c_str(), i, u, v,
                show(D[i]).c_str(), box[i].x.lo, box[i].x.hi, box[i].y.lo, box[i].y.hi, box[i].z.lo, box[i].z.hi,
                ru.lo, ru.hi, rv.lo, rv.hi);
            }
          if (bounds && (norm(D[1]) > b1[0] || norm(D[2]) > b1[1] || norm(D[3]) > b2[0] || norm(D[4]) > b2[1]
            || norm(D[5]) > b2[2])) {
            if (bad++ < 10) std::printf("  %s: a derivative bound fails at (%.17g, %.17g)\n", m.name.c_str(), u, v);
          }
          n++;
        }
    }
  }
  CHECK(bad == 0);
  CHECK(n > 20000);
}

TEST_CASE("within: every (u, v) whose point is within d of p is in the ranges given (dense samples)") {
  std::mt19937_64 rng(13);
  std::uniform_real_distribution<double> G(-1, 1);
  int bad = 0, n = 0;
  for (Made& m : zoo({"s1", "far", "mirror"})) {
    const SurfaceImpl* s = impl(m.s.get());
    SurfaceDomain dom = s->domain();
    Range DU, DV;
    sampleRange(dom, DU, DV);
    for (int trial = 0; trial < 4; trial++) {
      Vec3 c[kPartials];
      s->derivs(0.5 * DU.lo + 0.5 * DU.hi, 0.5 * DV.lo + 0.5 * DV.hi, 0, c);
      Vec3 p = c[0] + 2.0 * Vec3{G(rng), G(rng), G(rng)};
      double d = 1 + std::fabs(G(rng));
      Range ru, rv;
      s->within(p, d, ru, rv);
      // Samples over a window three times the ranges given (clipped to the domain), and the sample range.
      auto window = [](Range r, Range D, Range dd) {
        if (!std::isfinite(r.lo) || !std::isfinite(r.hi)) return D;
        double w = r.hi - r.lo;
        return Range{std::fmax(dd.lo, r.lo - w), std::fmin(dd.hi, r.hi + w)};
      };
      Range wu = window(ru, DU, dom.u), wv = window(rv, DV, dom.v);
      for (int x = 0; x <= 60; x++)
        for (int y = 0; y <= 60; y++) {
          double u = wu.lo + (wu.hi - wu.lo) * x / 60, v = wv.lo + (wv.hi - wv.lo) * y / 60;
          Vec3 q[kPartials];
          s->derivs(u, v, 0, q);
          if (norm(q[0] - p) > d) continue;
          n++;
          bool in = (dom.uPeriod > 0 || (u >= ru.lo && u <= ru.hi)) && (dom.vPeriod > 0 || (v >= rv.lo && v <= rv.hi));
          if (!in && bad++ < 10) std::printf("  %s: (%.17g, %.17g) within %g of %s, outside [%.17g, %.17g] x "
            "[%.17g, %.17g]\n", m.name.c_str(), u, v, d, show(p).c_str(), ru.lo, ru.hi, rv.lo, rv.hi);
        }
    }
  }
  CHECK(bad == 0);
  CHECK(n > 1000);
}

TEST_CASE("singularities: each iso-line given is one point on the surface, its partial along it zero") {
  int bad = 0, n = 0;
  for (Made& m : zoo({"s1", "far", "mirror"})) {
    std::vector<Singularity> sing;
    m.s->singularities(sing);
    SurfaceDomain d = m.s->domain();
    Range ru, rv;
    sampleRange(d, ru, rv);
    for (const Singularity& g : sing) {
      if (g.kind == Singularity::normalVanishes) continue;
      for (int k = 0; k <= 6; k++) {
        double t = g.isoU ? rv.lo + (rv.hi - rv.lo) * k / 6 : ru.lo + (ru.hi - ru.lo) * k / 6;
        SurfacePoint q;
        m.s->eval(g.isoU ? g.at : t, g.isoU ? t : g.at, 1, q);
        double size = std::fmax(norm(q.du), norm(q.dv));
        bool ok = norm(q.p - g.point) <= 1e-12 * size + 1e-15 * norm(q.p)
          && norm(g.isoU ? q.dv : q.du) <= 1e-12 * size;
        if (!ok && bad++ < 10) std::printf("  %s: singularity at %s %.17g: %s, not %s\n", m.name.c_str(),
          g.isoU ? "u" : "v", g.at, show(q.p).c_str(), show(g.point).c_str());
        n++;
      }
    }
  }
  CHECK(bad == 0);
  CHECK(n > 50);
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
      // Periodic results in [lo, lo + period).
      if ((d.uPeriod > 0 && !(inv.uv.x >= ru.lo && inv.uv.x < ru.lo + d.uPeriod))
        || (d.vPeriod > 0 && !(inv.uv.y >= rv.lo && inv.uv.y < rv.lo + d.vPeriod))) {
        if (bad++ < 10) std::printf("  %s: (%.17g, %.17g) outside a period\n", m.name.c_str(), inv.uv.x, inv.uv.y);
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

TEST_CASE("inversion of points on the sides the search's rectangles share: on the surface, and just off it") {
  // The search halves rectangles at their middles, so their shared sides lie on dyadic fractions of the range; a foot
  // on one is each rectangle's minimum pushed to its side, which must not count as pushed past it where the push is
  // the gradient's rounding (a point on the surface: the difference S - p is rounding, its direction anything).
  // A B-spline cone (degree 2 by 1, its row v = 0 the apex): half of S(1/6, 1/2), on a ruling at v = 1/4, inverted
  // to the apex 0.357 off before.
  {
    double r[2 + 2 + 18] = {0, 1, 0, 1};
    double arc[3][3] = {{1, 0, 1}, {1, 1, 1}, {0, 1, 1}};
    for (int i = 0; i < 3; i++)
      for (int a = 0; a < 3; a++) r[4 + (i * 2 + 0) * 3 + a] = 0, r[4 + (i * 2 + 1) * 3 + a] = arc[i][a];
    int32_t in[11 + 4] = {2, 1, 3, 2, 2, 2, 0, 0, 0, 0, 0, 3, 3, 2, 2};
    Status st;
    auto cone = surfaces::makeBSpline(r, in, st);
    REQUIRE(cone);
    const SurfaceImpl* s = impl(cone.get());
    SurfaceDomain d = s->domain();
    Vec3 D[kPartials];
    s->derivs(1.0 / 6, 0.5, 0, D);
    Vec3 q = 0.5 * D[0];
    SurfaceInversion inv = invertSurface(*s, q, d.u, d.v, 1e-12);
    if (!(inv.distance < 1e-12)) std::printf("  cone: half of S(1/6, 1/2) at distance %.3g\n", inv.distance);
    CHECK(inv.distance < 1e-12);
  }
  // Every surface: points on it with u or v on a dyadic fraction of the range (to sixteenths) and the other random;
  // on it (the distance under 1e-9 of its size) and 1e-6 of its size off along the normal (the distance that), both
  // to within p's own rounding.
  std::mt19937_64 rng(7);
  std::uniform_real_distribution<double> U(0, 1);
  std::vector<Made> all = zoo({"s1", "far", "mirror"});
  for (Made& m : raw()) all.push_back(std::move(m));
  int bad = 0, n = 0;
  for (Made& m : all) {
    const SurfaceImpl* s = impl(m.s.get());
    SurfaceDomain d = s->domain();
    Range ru, rv;
    sampleRange(d, ru, rv);
    Box3 b;
    s->derivBox(ru, rv, 0, 0, b);
    double size = std::fmax(1e-300, std::hypot(b.x.width(), std::hypot(b.y.width(), b.z.width())));
    for (int k = 1; k < 16; k++)
      for (int side = 0; side < 2; side++) {
        double fu = side ? static_cast<double>(k) / 16 : U(rng), fv = side ? U(rng) : static_cast<double>(k) / 16;
        Vec2 uv{ru.lo + (ru.hi - ru.lo) * fu, rv.lo + (rv.hi - rv.lo) * fv};
        Vec3 D[kPartials];
        s->derivs(uv.x, uv.y, 1, D);
        Vec3 nn = cross(D[pidx(1, 0)], D[pidx(0, 1)]);
        for (double off : {0.0, 1e-6}) {
          if (off > 0 && !(norm(nn) > 0)) continue;
          Vec3 p = off > 0 ? D[0] + (off * size / norm(nn)) * nn : D[0];
          SurfaceInversion inv = invertSurface(*s, p, ru, rv, 1e-12 * size);
          n++;
          // (Plus the rounding of p's coordinates, far from the origin 1e6 x those of a surface about it.)
          bool ok = inv.status == Status::ok &&
            inv.distance <= (off > 0 ? off : 1e-9) * size * (1 + 1e-6) + 1e-12 * size + 1e-14 * norm(p);
          if (!ok && bad++ < 10)
            std::printf("  %s: (%.17g, %.17g) %s: distance %.3g (size %.3g)\n", m.name.c_str(), uv.x, uv.y,
              off > 0 ? "off" : "on", inv.distance, size);
        }
      }
  }
  CHECK_EQ(bad, 0);
  CHECK(n > 1000);
}

TEST_CASE("inversion under a coarse tolerance: a foot within it all over still polished, nearby points apart") {
  // tol a tenth of the surface's size (LMP1's 0.13 on faces of a mm or so): the search stops at rectangles within tol
  // across before it proves one convex, whose point is then polished. Every surface: points on it at random inside
  // (u, v) and 1e-4 of its size off along the normal, each found to within 1e-9 of the size of its own distance; and
  // each with a second point 1e-3 of the size along the surface from it, their (u, v) apart (the B-splines' far
  // copies, with a rectangle's best corner or middle, up to 0.6 of their size off, and pairs on one (u, v)).
  std::mt19937_64 rng(11);
  std::uniform_real_distribution<double> U(0.1, 0.9);
  std::vector<Made> all = zoo({"s1", "far", "mirror"});
  for (Made& m : raw()) all.push_back(std::move(m));
  int bad = 0, same = 0, n = 0;
  for (Made& m : all) {
    const SurfaceImpl* s = impl(m.s.get());
    SurfaceDomain d = s->domain();
    Range ru, rv;
    sampleRange(d, ru, rv);
    Box3 b;
    s->derivBox(ru, rv, 0, 0, b);
    double size = std::fmax(1e-300, std::hypot(b.x.width(), std::hypot(b.y.width(), b.z.width())));
    for (int k = 0; k < 24; k++) {
      Vec2 uv{ru.lo + (ru.hi - ru.lo) * U(rng), rv.lo + (rv.hi - rv.lo) * U(rng)};
      Vec3 D[kPartials];
      s->derivs(uv.x, uv.y, 1, D);
      Vec3 nn = cross(D[pidx(1, 0)], D[pidx(0, 1)]);
      if (!(norm(nn) > 1e-9 * norm(D[pidx(1, 0)]) * norm(D[pidx(0, 1)]))) continue;
      // A range stopping short of the point's u (a tenth of the range): the result in it all the same.
      {
        Range cut{ru.lo, uv.x - 0.1 * (ru.hi - ru.lo)};
        SurfaceInversion inv = invertSurface(*s, D[0], cut, rv, 0.1 * size);
        if (inv.status == Status::ok && !(inv.uv.x >= cut.lo && inv.uv.x <= cut.hi) && bad++ < 10)
          std::printf("  %s: (%.17g, %.17g) over u to %.17g: u %.17g\n", m.name.c_str(), uv.x, uv.y, cut.hi,
            inv.uv.x);
      }
      for (double off : {0.0, 1e-4, 0.03, 0.3}) {
        Vec3 p = D[0] + (off * size / norm(nn)) * nn;
        SurfaceInversion inv = invertSurface(*s, p, ru, rv, 0.1 * size);
        n++;
        // (Far off, near a centre of curvature, feet within tol of the nearest are as good: tol allowed there.)
        double slack = off > 0.01 ? 0.1 * size : 1e-9 * size;
        bool ok = inv.status == Status::ok && inv.distance <= off * size * (1 + 1e-6) + slack + 1e-14 * norm(p);
        if (!ok && bad++ < 10)
          std::printf("  %s: (%.17g, %.17g) %s: distance %.3g (size %.3g)\n", m.name.c_str(), uv.x, uv.y,
            off > 0 ? "off" : "on", inv.distance, size);
        if (off > 0) continue;
        // The second point: along S_u by 1e-3 of the size.
        Vec2 uv2{uv.x + 1e-3 * size / norm(D[pidx(1, 0)]), uv.y};
        Vec3 D2[kPartials];
        s->derivs(uv2.x, uv2.y, 0, D2);
        SurfaceInversion inv2 = invertSurface(*s, D2[0], ru, rv, 0.1 * size);
        if (inv2.status == Status::ok && inv.uv.x == inv2.uv.x && inv.uv.y == inv2.uv.y && same++ < 10)
          std::printf("  %s: (%.17g, %.17g) and a point 1e-3 along: one (u, v)\n", m.name.c_str(), uv.x, uv.y);
      }
    }
  }
  CHECK_EQ(bad, 0);
  CHECK_EQ(same, 0);
  CHECK(n > 500);
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

TEST_CASE("inversion near a pole: points 1e-3 and 1e-6 off the pole line land on their own meridian, not the pole") {
  // A sphere (closed form), the exact B-spline sphere (its poles collapsed rows, searched) and a revolution of a half
  // circle reaching its axis (its profile's ends, searched).
  for (const char* name : {"sphere", "bsplineSphere", "revolutionSphere"}) {
    for (const char* variant : {"s1", "far", "mirror"}) {
      const fixtures::Reference* ref = fixtures::reference(name, variant);
      REQUIRE(ref);
      const Model m(ref->data, ref->size);
      Status s;
      auto S = makeSurface(m, 0, s);
      REQUIRE(S);
      std::vector<Singularity> sing;
      S->singularities(sing);
      SurfaceDomain d = S->domain();
      for (const Singularity& g : sing) {
        if (g.isoU) continue;
        // Toward the domain's inside from the pole line, on the meridian u = u0.
        double inward = g.at > 0.5 * d.v.lo + 0.5 * d.v.hi ? -1 : 1;
        double u0 = d.u.lo + 0.3 * (d.u.hi - d.u.lo);
        for (double off : {1e-3, 1e-6}) {
          double v = g.at + inward * off * (d.v.hi - d.v.lo);
          SurfacePoint q;
          S->eval(u0, v, 1, q);
          Vec3 n;
          S->normal(u0, v, n);
          // Off the surface a little along its normal, and exactly on it. Judged in 3D: near a pole u is known only to
          // the coordinates' rounding over the distance from the axis, but the foot must be the point's own (within
          // tol), not the pole (1e-6 of the range off it is 1e-5 of the radius away, far more than tol).
          for (double h : {0.0, 1e-4}) {
            Vec3 p = q.p + h * n;
            double tol = 1e-9 + 1e-15 * norm(p);
            SurfaceInversion inv = invertSurface(*S, p, d.u, d.v, tol);
            SurfacePoint f;
            S->eval(inv.uv.x, inv.uv.y, 0, f);
            // A foot h off the surface is fixed by a distance tol only to about sqrt(2 h tol) (the distance moves
            // by x^2 / 2h with the foot); near a pole the search may run out of budget there (noConvergence, its
            // foot still that close), never stopping at the pole.
            double fix = 4 * tol + 4 * std::sqrt(h * tol);
            bool ok = (inv.status == Status::ok || (h > 0 && inv.status == Status::noConvergence)) && !inv.atSingularity
              && norm(f.p - q.p) <= fix && norm(f.p - g.point) > 0.5 * norm(q.p - g.point)
              && std::fabs(inv.distance - h) <= 4 * tol;
            if (!ok) {
              CHECK(ok);
              std::printf("  %s-%s pole at %.17g, %g off, %g out: uv (%.17g, %.17g) want (%.17g, %.17g), distance "
                "%.17g, singular %d (status %d)\n", name, variant, g.at, off, h, inv.uv.x, inv.uv.y, u0, v,
                inv.distance, inv.atSingularity, int(inv.status));
            }
          }
        }
      }
    }
  }
}

TEST_CASE("continua of feet: a family on each axis of revolution and tube centre; a sphere's centre none") {
  // The surface row of each kind in a reference model (s1 and mirror), a point whose feet form a known set.
  struct Want {
    const char* name;
    int kind;
    Vec3 local;  // the point in the shape's frame: on the axis, or at the tube's centre
    bool family, familyU;
    double at, distance;
  };
  const double R = 3, r = 1;
  const Want wants[] = {
    // The cylinder r 2 about z from (0, 0, 1.5): the circle v = 1.5, distance 2.
    {"cylinder", CBR_SURFACE_CYLINDER, {0, 0, 1.5}, true, true, 1.5, 2},
    // The cone r 1 at v = 0, semi-angle pi / 6 (k = tan), from (0, 0, 1): its generator's foot v = (z - k r) / (1 +
    // k^2), at distance |r + k z| / sqrt(1 + k^2).
    {"cone", CBR_SURFACE_CONE, {0, 0, 1}, true, true, (1 - std::tan(M_PI / 6)) / (1 + std::tan(M_PI / 6) *
      std::tan(M_PI / 6)), (1 + std::tan(M_PI / 6)) / std::sqrt(1 + std::tan(M_PI / 6) * std::tan(M_PI / 6))},
    // The torus R 3, r 1 from its centre: the inner circle v = pi, distance R - r; from its tube's centre (3, 0, 0):
    // the tube circle at u = 0, distance r.
    {"torus", CBR_SURFACE_TORUS, {0, 0, 0}, true, true, M_PI, R - r},
    {"torus", CBR_SURFACE_TORUS, {R, 0, 0}, true, false, 0, r},
    // The sphere R 2 from its centre: every point, no curve.
    {"sphere", CBR_SURFACE_SPHERE, {0, 0, 0}, false, false, 0, 2},
  };
  for (const Want& w : wants) {
    for (const char* variant : {"s1", "mirror"}) {
      const fixtures::Reference* ref = fixtures::reference(w.name, variant);
      REQUIRE(ref);
      const Model m(ref->data, ref->size);
      int row = -1;
      for (int i = 0; i < m.surfaces() && row < 0; i++)
        if (m.surfaceKind(i) == w.kind) row = i;
      REQUIRE(row >= 0);
      Status s;
      auto S = makeSurface(m, row, s);
      REQUIRE(S);
      // The point at the shape's similarity (x' = s Q x + t).
      Vec3 p{ref->translation[0], ref->translation[1], ref->translation[2]};
      const double* q = ref->rotation;
      p = p + ref->scale * (w.local.x * Vec3{q[0], q[1], q[2]} + w.local.y * Vec3{q[3], q[4], q[5]}
        + w.local.z * Vec3{q[6], q[7], q[8]});
      SurfaceDomain d = S->domain();
      SurfaceInversion inv = invertSurface(*S, p, d.u, d.v, 1e-9);
      // Under the mirror a cylinder's or cone's v and a torus's v change sign (the Maker's maps): compare modulo.
      double det = q[0] * (q[4] * q[8] - q[5] * q[7]) - q[3] * (q[1] * q[8] - q[2] * q[7])
        + q[6] * (q[1] * q[5] - q[2] * q[4]);
      double at = w.familyU && det < 0 ? -w.at : w.at;
      double period = w.familyU ? d.vPeriod : d.uPeriod;
      bool ok = inv.status == Status::ok && inv.certainty == Certainty::ambiguous && !inv.alternatives.empty()
        && check::near(inv.distance, w.distance, 1e-12, 1e-12) && inv.hasFamily == w.family;
      if (w.family) {
        double lo = w.familyU ? d.u.lo : d.v.lo, hi = w.familyU ? d.u.hi : d.v.hi;
        ok = ok && inv.familyU == w.familyU && pdist(inv.familyAt, at, period) <= 1e-9 && inv.familyLo == lo
          && inv.familyHi == hi;
      }
      // Every alternative and the foot are at the distance, and on the family's curve where there is one.
      for (Vec2 a : inv.alternatives) {
        SurfacePoint f;
        S->eval(a.x, a.y, 0, f);
        ok = ok && check::near(norm(f.p - p), w.distance, 1e-12, 1e-12);
        if (w.family) ok = ok && pdist(w.familyU ? a.y : a.x, at, period) <= 1e-9;
      }
      if (!ok) {
        CHECK(ok);
        std::printf("  %s-%s from %s: status %d certainty %d alternatives %zu distance %.17g family %d %d at %.17g "
          "over [%.17g, %.17g]\n", w.name, variant, show(p).c_str(), int(inv.status), int(inv.certainty),
          inv.alternatives.size(), inv.distance, inv.hasFamily, inv.familyU, inv.familyAt, inv.familyLo,
          inv.familyHi);
        for (Vec2 a : inv.alternatives) {
          SurfacePoint f;
          S->eval(a.x, a.y, 0, f);
          std::printf("    alternative (%.17g, %.17g) at %.17g\n", a.x, a.y, norm(f.p - p));
        }
      }
    }
  }
  // The spindle torus's centre, the catalogue's case with its family.
  const fixtures::CaseEntry* e = fixtures::findCase("noninjective-spindle-centre");
  REQUIRE(e);
  const fixtures::Reference& ref = fixtures::references[e->reference];
  const fixtures::InvertSurfaceCase& c = ref.invertSurfaceCases[e->index];
  REQUIRE(c.hasFamily);
  const Model m(ref.data, ref.size);
  Status s;
  auto S = makeSurface(m, c.surface, s);
  REQUIRE(S);
  SurfaceDomain d = S->domain();
  SurfaceInversion inv = invertSurface(*S, V(c.p), d.u, d.v, c.tol);
  CHECK(inv.hasFamily);
  CHECK(inv.familyU == c.familyU);
  CHECK_NEAR(inv.familyAt, c.familyAt, 0, 1e-9);
  CHECK_NEAR(inv.familyLo, c.familyLo, 0, 1e-12);
  CHECK_NEAR(inv.familyHi, c.familyHi, 0, 1e-12);
}

TEST_CASE("searched feet: unique off the axis on the B-spline sphere and torus, the twist's saddle not a foot") {
  // The exact B-spline sphere (R 2) and torus (R 3, r 1) about the origin, z their axis: the foot is radial (in the
  // meridian plane, to the tube's centre circle), unique off the axis and the tube's centre.
  std::mt19937_64 rng(17);
  std::uniform_real_distribution<double> G(-3.5, 3.5);
  for (const char* name : {"bsplineSphere", "bsplineTorus"}) {
    const fixtures::Reference* ref = fixtures::reference(name, "s1");
    REQUIRE(ref);
    const Model m(ref->data, ref->size);
    Status s;
    auto S = makeSurface(m, 0, s);
    REQUIRE(S);
    SurfaceDomain d = S->domain();
    bool torus = std::strcmp(name, "bsplineTorus") == 0;
    for (int k = 0; k < 12; k++) {
      Vec3 p{G(rng), G(rng), G(rng) / 3};
      double rho = std::hypot(p.x, p.y);
      if (rho < 0.3 || (torus && std::hypot(rho - 3, p.z) < 0.3)) continue;
      double want = torus ? std::fabs(std::hypot(rho - 3, p.z) - 1) : std::fabs(norm(p) - 2);
      SurfaceInversion inv = invertSurface(*S, p, d.u, d.v, 1e-9);
      bool ok = inv.status == Status::ok && inv.certainty == Certainty::unique && inv.alternatives.empty()
        && std::fabs(inv.distance - want) <= 1e-9;
      if (!ok) {
        CHECK(ok);
        std::printf("  %s from %s: distance %.17g want %.17g, certainty %d, %zu alternatives (status %d)\n", name,
          show(p).c_str(), inv.distance, want, int(inv.certainty), inv.alternatives.size(), int(inv.status));
      }
    }
  }
  // z = x y over [-2, 2]^2 from (0, 0, 1.5): the origin is a saddle of the distance (its Hessian [1, -1.5; -1.5, 1]
  // has positive diagonal and negative determinant); the feet are at x = y = +/-sqrt(1/2), distance sqrt 2 (on
  // (t, t, t^2) the squared distance 2 t^2 + (t^2 - 1.5)^2 is least at t^2 = 1/2).
  for (Made& m : raw()) {
    if (m.name.find("twist") == std::string::npos) continue;
    SurfaceDomain d = m.s->domain();
    SurfacePoint c;
    m.s->eval(0, 0, 0, c);
    Vec3 p = c.p + Vec3{0, 0, 1.5};
    SurfaceInversion inv = invertSurface(*m.s, p, d.u, d.v, 1e-9);
    CHECK(inv.status == Status::ok);
    CHECK(inv.certainty == Certainty::ambiguous);
    CHECK(inv.alternatives.size() == 1);
    CHECK_NEAR(inv.distance, std::sqrt(2.0), 1e-9, 1e-9);
    CHECK_NEAR(std::fabs(inv.uv.x), std::sqrt(0.5), 0, 1e-7);
    CHECK_NEAR(inv.uv.x, inv.uv.y, 0, 1e-7);
  }
  // A searched kind's seam: an extrusion's point at u = 0 is on the seam, its u in [0, 2 pi).
  const fixtures::Reference* ex = fixtures::reference("extrusion", "mirror");
  REQUIRE(ex);
  const Model me(ex->data, ex->size);
  for (int r = 0; r < me.surfaces(); r++) {
    if (me.surfaceKind(r) != CBR_SURFACE_EXTRUSION) continue;
    Status s;
    auto e = makeSurface(me, r, s);
    for (double u : {0.0, 2 * M_PI - 1e-13, 1e-13}) {
      SurfacePoint q;
      e->eval(u, 0.4, 1, q);
      Vec3 n = (1 / norm(cross(q.du, q.dv))) * cross(q.du, q.dv);
      SurfaceInversion inv = invertSurface(*e, q.p + 0.1 * n, {0, kTwoPi}, {-inf, inf}, 1e-9);
      CHECK(inv.status == Status::ok);
      CHECK(inv.onSeamU);
      CHECK(inv.uv.x >= 0 && inv.uv.x < kTwoPi);
      CHECK_NEAR(inv.uv.y, 0.4, 0, 1e-9);
    }
  }
}

TEST_CASE("cases the planted bugs found: an offset's box at one pole, a foot beside a knot, a hint across a seam") {
  // The offset sphere's box over a strip touching only its north pole holds the strip's points (the reduced normal's
  // sign on that side of the pole line).
  {
    const fixtures::Reference* ref = fixtures::reference("offset", "s1");
    REQUIRE(ref);
    const Model m(ref->data, ref->size);
    Status s;
    auto S = makeSurface(m, 1, s);
    REQUIRE(S);
    const SurfaceImpl* t = impl(S.get());
    // (A narrow range of u, as the search's rectangles near a pole are: over a whole turn the reduced normal's box
    // holds 0 and the box is the basis's widened by |d|.) Tighter than that ball: the offset pole at |z| 2.5, the
    // ball's reaching 1.5.
    for (Range rv : {Range{M_PI / 2 - 0.1, M_PI / 2}, Range{-M_PI / 2, -M_PI / 2 + 0.1}}) {
      Range ru{1, 1.2};
      Box3 b;
      CHECK(t->derivBox(ru, rv, 0, 0, b) == Status::ok);
      CHECK(std::fmin(std::fabs(b.z.lo), std::fabs(b.z.hi)) > 2.2);
      for (int x = 0; x <= 12; x++)
        for (int y = 0; y <= 6; y++) {
          SurfacePoint q;
          S->eval(ru.lo + (ru.hi - ru.lo) * x / 12, rv.lo + (rv.hi - rv.lo) * y / 6, 0, q);
          CHECK(inBox(b, q.p));
        }
    }
  }
  // The B-spline sphere's foot 1e-6 beside its knot line u = 1/4 (where the search's rectangles meet): one foot,
  // not a second at the knot line, whose distance differs by far less than tol.
  {
    const fixtures::Reference* ref = fixtures::reference("bsplineSphere", "s1");
    REQUIRE(ref);
    const Model m(ref->data, ref->size);
    Status s;
    auto S = makeSurface(m, 0, s);
    REQUIRE(S);
    SurfaceDomain d = S->domain();
    for (double du : {1e-6, -1e-6, 1e-8}) {
      SurfacePoint q;
      S->eval(0.25 + du, 0.6, 0, q);
      SurfaceInversion inv = invertSurface(*S, 1.5 * q.p, d.u, d.v, 1e-9);
      CHECK(inv.status == Status::ok);
      CHECK(inv.certainty == Certainty::unique);
      CHECK(inv.alternatives.empty());
      CHECK_NEAR(inv.distance, norm(q.p) * 0.5, 1e-12, 1e-12);
    }
  }
  // The torus's centre with a hint just below u = 2 pi: of the continuum's samples the hint picks u = 0, a seam away
  // (0.05 the short way round), not the nearest by the plain difference.
  {
    const fixtures::Reference* ref = fixtures::reference("torus", "s1");
    REQUIRE(ref);
    const Model m(ref->data, ref->size);
    Status s;
    auto S = makeSurface(m, 0, s);
    REQUIRE(S);
    SurfaceDomain d = S->domain();
    Vec2 hint{kTwoPi - 0.05, M_PI};
    SurfaceInversion inv = invertSurface(*S, {0, 0, 0}, d.u, d.v, 1e-9, &hint);
    CHECK(inv.certainty == Certainty::ambiguous);
    CHECK_NEAR(inv.uv.x, 0, 0, 1e-12);
    CHECK_NEAR(inv.uv.y, M_PI, 0, 1e-9);
  }
}

namespace {

/** A B-spline surface from raw values: degrees, distinct knots and multiplicities, poles[i][j], weights or none. */
std::unique_ptr<Surface> rawSpline(int p, int q, std::vector<double> uk, std::vector<int> um, std::vector<double> vk,
  std::vector<int> vm, const std::vector<std::vector<Vec3>>& P, const std::vector<std::vector<double>>& W = {}) {
  int nu = static_cast<int>(P.size()), nv = static_cast<int>(P[0].size());
  std::vector<int32_t> in{p, q, nu, nv, static_cast<int32_t>(uk.size()), static_cast<int32_t>(vk.size()),
    W.empty() ? 0 : 1, 0, 0, 0, 0};
  in.insert(in.end(), um.begin(), um.end());
  in.insert(in.end(), vm.begin(), vm.end());
  std::vector<double> r(uk);
  r.insert(r.end(), vk.begin(), vk.end());
  for (auto& row : P)
    for (Vec3 x : row) r.insert(r.end(), {x.x, x.y, x.z});
  for (auto& row : W) r.insert(r.end(), row.begin(), row.end());
  Status s;
  return surfaces::makeBSpline(r.data(), in.data(), s);
}

/** A degree-1 tube round z, its section the square (1, 0), (0, 1), (-1, 0), (0, -1) back to (1, 0), z in [0, 1];
 * the last pole of the row at z = 0 moved by `gap` along x (0: closed exactly). */
std::unique_ptr<Surface> tube(double gap) {
  std::vector<Vec3> ring{{1, 0, 0}, {0, 1, 0}, {-1, 0, 0}, {0, -1, 0}, {1, 0, 0}};
  std::vector<std::vector<Vec3>> P(2);
  for (int i = 0; i < 2; i++)
    for (Vec3 x : ring) P[i].push_back(x + Vec3{0, 0, double(i)});
  P[0][4].x += gap;
  return rawSpline(1, 1, {0, 1}, {2, 2}, {0, 1, 2, 3, 4}, {2, 1, 1, 1, 2}, P);
}

} // namespace

TEST_CASE("inversion's span grid: kept for the ranges asked, the feet a fresh surface's whatever was asked before") {
  // One surface asked over the whole domain, then part of v, then the whole again, then a corner: each foot the
  // same as a new surface's, and inside the ranges asked (a grid kept from other ranges would search outside them).
  auto S = tube(0);
  const SurfaceDomain d = S->domain();
  const Vec3 p{-1.2, 0.1, 0.7};
  const std::vector<std::pair<Range, Range>> asks{{d.u, d.v}, {d.u, {0, 1}}, {d.u, d.v}, {{0, 0.5}, {2.5, 3.5}}};
  for (auto [ru, rv] : asks) {
    SurfaceInversion a = invertSurface(*S, p, ru, rv, 1e-9);
    auto fresh = tube(0);
    SurfaceInversion b = invertSurface(*fresh, p, ru, rv, 1e-9);
    CHECK(a.status == Status::ok && b.status == Status::ok);
    CHECK_EQ(a.uv.x, b.uv.x);
    CHECK_EQ(a.uv.y, b.uv.y);
    CHECK_EQ(a.distance, b.distance);
    CHECK(a.uv.x >= ru.lo && a.uv.x <= ru.hi && a.uv.y >= rv.lo && a.uv.y <= rv.hi);
  }
  // The grid: its rectangles the spans (1 in u, 4 in v), kept while the ranges are the same, made again when not.
  const SurfaceImpl::SpanGrid& g = impl(S.get())->spanGrid(d.u, d.v);
  CHECK_EQ(g.us.size(), 2u);
  CHECK_EQ(g.vs.size(), 5u);
  CHECK_EQ(g.box.size(), 4u);
  CHECK(&impl(S.get())->spanGrid(d.u, d.v) == &g);
  const SurfaceImpl::SpanGrid& h = impl(S.get())->spanGrid(d.u, {0, 2});
  CHECK_EQ(h.vs.size(), 3u);
  CHECK(h.v.hi == 2);
  // The grid's boxes prune: over a flat strip of 40 spans, a point above one span examines a few rectangles, not
  // every span's (each one's box distance its lower bound; without them all 40 are taken from the queue).
  std::vector<std::vector<Vec3>> P(2);
  for (int i = 0; i < 2; i++)
    for (int j = 0; j <= 40; j++) P[i].push_back({double(j), double(i), 0});
  std::vector<double> vk;
  std::vector<int> vm;
  for (int j = 0; j <= 40; j++) vk.push_back(j), vm.push_back(j == 0 || j == 40 ? 2 : 1);
  auto strip = rawSpline(1, 1, {0, 1}, {2, 2}, vk, vm, P);
  REQUIRE(strip);
  const SurfaceDomain sd = strip->domain();
  const long before = surfaces::inversionRects;
  SurfaceInversion inv = invertSurface(*strip, {10.3, 0.5, 0.2}, sd.u, sd.v, 1e-9);
  const long examined = surfaces::inversionRects - before;
  CHECK(inv.status == Status::ok);
  CHECK_NEAR(inv.uv.x, 0.5, 1e-12, 0);
  CHECK_NEAR(inv.uv.y, 10.3, 1e-12, 0);
  CHECK_NEAR(inv.distance, 0.2, 1e-12, 0);
  CHECK(examined >= 1 && examined <= 3);
  if (!(examined <= 3)) std::printf("    rectangles examined: %ld\n", examined);
}

TEST_CASE("closeInFact: a tube closed in v, a nearly closed one, a collapsed side, rational closures") {
  const double tol = 1e-7;
  // The tube closes in v (its last section the first): v periodic, period 4, every query reduced.
  {
    auto c = closeInFact(tube(0), tol);
    SurfaceDomain d = c->domain();
    CHECK(d.vPeriod == 4);
    CHECK(d.uPeriod == 0);
    for (double v : {0.3, 1.7, 3.9}) {
      SurfacePoint a, b;
      c->eval(0.4, v, 2, a), c->eval(0.4, v + 4, 2, b);
      CHECK(nearVec(a.p, b.p, 0, 1e-15) && nearVec(a.dv, b.dv, 0, 1e-15));
    }
    // A box across the seam holds the samples either side; breaks across it include the seam.
    Box3 box;
    CHECK(impl(c.get())->derivBox({0, 1}, {3.5, 4.5}, 0, 0, box) == Status::ok);
    for (int k = 0; k <= 20; k++) {
      SurfacePoint q;
      c->eval(0.5, 3.5 + k / 20.0, 0, q);
      CHECK(inBox(box, q.p));
    }
    std::vector<double> us, vs;
    c->breaks({0, 1}, {3.5, 4.5}, us, vs);
    CHECK(std::find(vs.begin(), vs.end(), 4.0) != vs.end());
    CHECK(vs.front() == 3.5 && vs.back() == 4.5);
    // A point outside the seam's corner (1, 0, 0.5): on the seam, its v in [0, 4).
    SurfaceInversion inv = invertSurface(*c, {1.5, 0, 0.5}, d.u, d.v, 1e-9);
    CHECK(inv.status == Status::ok);
    CHECK(inv.onSeamV);
    CHECK(inv.uv.y >= 0 && inv.uv.y < 4);
    CHECK_NEAR(inv.distance, 0.5, 1e-12, 0);
    std::vector<Singularity> g;
    c->singularities(g);
    CHECK(g.empty());
  }
  // A range whose ends hi - (hi - lo) doesn't round back to lo (ec_turbine-A's, lo a few ulps below 0): its ends and
  // everything between evaluated as they are, in the base's domain; a whole period on, the same points.
  {
    const double lo = -3.6595628376880003e-14, hi = 93.029033981724993, w = hi - lo;
    std::vector<Vec3> ring{{1, 0, 0}, {0, 1, 0}, {-1, 0, 0}, {0, -1, 0}, {1, 0, 0}};
    std::vector<std::vector<Vec3>> P(2);
    for (int i = 0; i < 2; i++)
      for (Vec3 x : ring) P[i].push_back(x + Vec3{0, 0, double(i)});
    auto base = [&] { return rawSpline(1, 1, {0, 1}, {2, 2}, {lo, lo + w / 4, lo + w / 2, lo + 3 * w / 4, hi},
      {2, 1, 1, 1, 2}, P); };
    auto plain = base();
    auto c = closeInFact(base(), tol);
    REQUIRE(c->domain().vPeriod > 0);
    for (double v : {lo, hi, lo + w / 3}) {
      SurfacePoint a, b, e;
      CHECK(c->eval(0.4, v, 1, a) == Status::ok);
      CHECK(plain->eval(0.4, v, 1, b) == Status::ok);
      CHECK(nearVec(a.p, b.p, 0, 0) && nearVec(a.dv, b.dv, 0, 0));
      CHECK(c->eval(0.4, v + 2 * c->domain().vPeriod, 0, e) == Status::ok);
      CHECK(nearVec(e.p, b.p, 1e-12, 0));
    }
  }
  // Nearly closed: 1.5 tol off at one of the 9 points, no period; 0.5 tol off, a period. The gap is at the end
  // u = 0 and falls off linearly to 0 at u = 1: at 1.05 tol only the end point itself is off by more than tol.
  {
    auto c = closeInFact(tube(1.5 * tol), tol);
    CHECK(c->domain().vPeriod == 0);
    CHECK(closeInFact(tube(1.05 * tol), tol)->domain().vPeriod == 0);
    auto e = closeInFact(tube(0.5 * tol), tol);
    CHECK(e->domain().vPeriod == 4);
  }
  // A bilinear patch whose side u = 0 meets in a point within tol (0.5 tol apart): a pole line there, at that point;
  // the surface itself reported none (its rows aren't equal). Exactly collapsed, the surface reports it, once.
  for (double off : {0.5 * tol, 0.0}) {
    std::vector<std::vector<Vec3>> P{{{0, 0, 0}, {off, 0, 0}}, {{1, -1, 0}, {1, 1, 0.5}}};
    auto base = rawSpline(1, 1, {0, 1}, {2, 2}, {0, 1}, {2, 2}, P);
    std::vector<Singularity> before;
    base->singularities(before);
    CHECK(before.size() == (off == 0 ? 1u : 0u));
    Surface* raw = base.get();
    auto c = closeInFact(std::move(base), tol);
    std::vector<Singularity> g;
    c->singularities(g);
    REQUIRE(g.size() == 1);
    CHECK(g[0].kind == Singularity::pole);
    CHECK(g[0].isoU);
    CHECK(g[0].at == 0);
    CHECK(nearVec(g[0].point, {0, 0, 0}, 0, tol));
    CHECK(c->domain().uPeriod == 0 && c->domain().vPeriod == 0);
    // Nothing to add where the surface says it all: the surface itself back.
    CHECK((c.get() == raw) == (off == 0));
  }
  // The same side collapsed within tol, on a patch whose rows along it (in v) are at most 4 tol long: no pole, as the
  // surface is about as small as its tolerance that way (1 wide across, in u); 12 tol long, the pole. (v's range
  // [0, 3], not u's, so the rows are measured over their own.)
  for (double half : {2 * tol, 6 * tol}) {
    std::vector<std::vector<Vec3>> P{{{0, 0, 0}, {0.5 * tol, 0, 0}}, {{1, -half, 0}, {1, half, 0}}};
    auto c = closeInFact(rawSpline(1, 1, {0, 1}, {2, 2}, {0, 3}, {2, 2}, P), tol);
    std::vector<Singularity> g;
    c->singularities(g);
    CHECK(g.size() == (half > 3 * tol ? 1u : 0u));
  }
  // Rational: the exact B-spline cylinder closes in u (period 1); the B-spline sphere too, its collapsed rows
  // reported once; a plane, a periodic torus and a far cylinder unchanged or closed alike.
  {
    for (const char* variant : {"s1", "far", "mirror"}) {
      const fixtures::Reference* ref = fixtures::reference("bsplineCylinder", variant);
      REQUIRE(ref);
      const Model m(ref->data, ref->size);
      Status s;
      // (At 1e6 mm the ends agree to the coordinates' rounding: tol relative to the size, as callers pass it.)
      double t = 1e-9 * 20 + 1e-15 * 2e6;
      auto c = closeInFact(makeSurface(m, 0, s), t);
      CHECK(c->domain().uPeriod == 1);
      CHECK(c->domain().vPeriod == 0);
      SurfacePoint q;
      c->eval(0, 0.5, 1, q);
      Vec3 n = (1 / norm(cross(q.du, q.dv))) * cross(q.du, q.dv);
      SurfaceInversion inv = invertSurface(*c, q.p + 0.25 * n, c->domain().u, c->domain().v, t);
      CHECK(inv.onSeamU);
      CHECK(inv.uv.x >= 0 && inv.uv.x < 1);
      CHECK_NEAR(inv.distance, 0.25, 1e-9, t);
    }
    const fixtures::Reference* sp = fixtures::reference("bsplineSphere", "s1");
    const Model ms(sp->data, sp->size);
    Status s;
    auto c = closeInFact(makeSurface(ms, 0, s), tol);
    CHECK(c->domain().uPeriod == 1);
    std::vector<Singularity> g;
    c->singularities(g);
    CHECK(g.size() == 2);
    const fixtures::Reference* to = fixtures::reference("torus", "s1");
    const Model mt(to->data, to->size);
    auto torus = makeSurface(mt, 0, s);
    Surface* raw = torus.get();
    CHECK(closeInFact(std::move(torus), tol).get() == raw);
  }
}

TEST_CASE("degrees past the stack buffers (kStackDegree) evaluate on the heap: linear precision at degree 18") {
  // Evenly spaced poles reproduce a linear function at any degree: P_ij = (i / p, j / q, 0) gives S(u, v) = (u, v, 0).
  const int p = 18, q = 17;
  std::vector<std::vector<Vec3>> P(p + 1, std::vector<Vec3>(q + 1));
  for (int i = 0; i <= p; i++)
    for (int j = 0; j <= q; j++) P[i][j] = {double(i) / p, double(j) / q, 0};
  auto S = rawSpline(p, q, {0, 1}, {p + 1, p + 1}, {0, 1}, {q + 1, q + 1}, P);
  REQUIRE(S);
  for (double u : {0.0, 0.3, 0.77, 1.0})
    for (double v : {0.0, 0.45, 1.0}) {
      SurfacePoint s;
      CHECK(S->eval(u, v, 2, s) == Status::ok);
      CHECK(nearVec(s.p, {u, v, 0}, 0, 1e-13));
      CHECK(nearVec(s.du, {1, 0, 0}, 0, 1e-11) && nearVec(s.dv, {0, 1, 0}, 0, 1e-11));
      CHECK(nearVec(s.duu, {}, 0, 1e-9) && nearVec(s.duv, {}, 0, 1e-9) && nearVec(s.dvv, {}, 0, 1e-9));
    }
  // A curve of degree 18 likewise, through the model's B-spline curve (bspline::eval).
  std::vector<double> r{0, 1};
  for (int i = 0; i <= p; i++) r.insert(r.end(), {double(i) / p, 2.0 * i / p, 0});
  int32_t in[7 + 2] = {p, p + 1, 2, 0, 0, 0, 0, p + 1, p + 1};
  Status st;
  auto C = curves::makeBSpline(r.data(), in, 3, st);
  REQUIRE(C);
  for (double t : {0.0, 0.4, 1.0}) {
    CurvePoint c;
    CHECK(C->eval(t, 2, c) == Status::ok);
    CHECK(nearVec(c.p, {t, 2 * t, 0}, 0, 1e-13));
    CHECK(nearVec(c.d1, {1, 2, 0}, 0, 1e-11));
    CHECK(nearVec(c.d2, {}, 0, 1e-9));
  }
}

TEST_CASE("inversion at a B-spline's collapsed row finishes: the split follows the 3D extent, not the loose boxes") {
  // The rational B-spline sphere's poles, tol 1e-6: the pole is found at once, the rest is proving no other foot.
  // Choosing splits by the partials' boxes (a rational one's is a loose quotient bound) halved u beside the pole,
  // doubling the rectangles touching it: about 700 ms natively. By the sampled extent it is a few ms; the bound
  // below leaves room for ASan and WebAssembly.
  const fixtures::Reference* ref = fixtures::reference("bsplineSphere", "s1");
  REQUIRE(ref);
  const Model m(ref->data, ref->size);
  Status s;
  auto S = makeSurface(m, 0, s);
  REQUIRE(S);
  SurfaceDomain d = S->domain();
  std::vector<Singularity> g;
  S->singularities(g);
  REQUIRE(g.size() == 2);
  for (const Singularity& x : g) {
    auto t0 = std::chrono::steady_clock::now();
    SurfaceInversion inv = invertSurface(*S, x.point, d.u, d.v, 1e-6);
    double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    CHECK(inv.status == Status::ok);
    CHECK(inv.atSingularity);
    CHECK(ms < 200);
    if (ms >= 200) std::printf("  pole at v = %g: %.1f ms\n", x.at, ms);
  }
}

namespace {

/** The diamond tube, its section scaled by `lo` at z = 0 and by `hi` at z = 1, closed in v, or in u (`inU`). */
std::unique_ptr<Surface> taperedTube(double lo, double hi, bool inU = false) {
  std::vector<Vec3> ring{{1, 0, 0}, {0, 1, 0}, {-1, 0, 0}, {0, -1, 0}, {1, 0, 0}};
  std::vector<std::vector<Vec3>> P(2);
  for (int i = 0; i < 2; i++)
    for (Vec3 x : ring) P[i].push_back((i ? hi : lo) * x + Vec3{0, 0, double(i)});
  if (!inU) return rawSpline(1, 1, {0, 1}, {2, 2}, {0, 1, 2, 3, 4}, {2, 1, 1, 1, 2}, P);
  std::vector<std::vector<Vec3>> T(5, std::vector<Vec3>(2));
  for (int i = 0; i < 2; i++)
    for (int j = 0; j < 5; j++) T[j][i] = P[i][j];
  return rawSpline(1, 1, {0, 1, 2, 3, 4}, {2, 1, 1, 1, 2}, {0, 1}, {2, 2}, T);
}

} // namespace

TEST_CASE("closeInFact: a sliver narrower than 10 x tol across stays open, a wider one and a real tube close") {
  // The diamond's perimeter, 4 sqrt 2 x its scale, is what the 64-step polyline measures (its corners on steps).
  const double tol = 0.01, perim = 4 * std::sqrt(2.0);
  for (bool inU : {false, true}) {
    auto period = [&](const std::unique_ptr<Surface>& c) { return inU ? c->domain().uPeriod : c->domain().vPeriod; };
    // Just under 10 x tol across: open, its sides boundaries; just over: closed.
    const double under = 9.9 * tol / perim, over = 10.1 * tol / perim;
    CHECK(period(closeInFact(taperedTube(under, under, inU), tol)) == 0);
    CHECK(period(closeInFact(taperedTube(over, over, inU), tol)) == 4);
    // The widest section decides: narrow at one end, wide at the other, it closes.
    CHECK(period(closeInFact(taperedTube(over, under / 10, inU), tol)) == 4);
    // A real tube at a loose tol (its sides meeting exactly, 5.7 across at tol 0.5): closed.
    CHECK(period(closeInFact(taperedTube(1, 1, inU), 0.5)) == 4);
  }
}

TEST_CASE("closeInFact: an extrusion of a closed profile closes in u though its v is infinite") {
  // The reference B-spline circle (closed in fact: t 0 and 1 one point, not periodic) extruded along (0, 0, 1),
  // magnitude 2: u closes over the window v in [-1, 1]; with the profile's last pole moved 1e-6 it doesn't.
  const fixtures::Reference* ref = fixtures::reference("bsplineCircle", "s1");
  REQUIRE(ref);
  const Model m(ref->data, ref->size);
  double r[4] = {0, 0, 1, 2};
  Status s;
  std::unique_ptr<Surface> e = surfaces::makeExtrusion(m, 0, r, 0, s);
  REQUIRE(e);
  CHECK(e->domain().uPeriod == 0);
  CHECK(!std::isfinite(e->domain().v.hi));
  auto c = closeInFact(std::move(e), 1e-9);
  CHECK(c->domain().uPeriod == 1);
  SurfacePoint a, b;
  c->eval(0.25, 5, 1, a), c->eval(1.25, 5, 1, b);
  CHECK(nearVec(a.p, b.p, 0, 1e-12));
  // A seam point far along v: on the seam, its u in [0, 1).
  SurfacePoint q;
  c->eval(0, 40, 1, q);
  Vec3 n = (1 / norm(cross(q.du, q.dv))) * cross(q.du, q.dv);
  SurfaceInversion inv = invertSurface(*c, q.p + 0.5 * n, c->domain().u, c->domain().v, 1e-9);
  CHECK(inv.status == Status::ok);
  CHECK(inv.onSeamU);
  CHECK(inv.uv.x >= 0 && inv.uv.x < 1);
  CHECK_NEAR(inv.uv.y, 40, 0, 1e-8);
  // Not closed: the same extrusion with its profile's last pole moved 1e-6 stays open at tol 1e-9.
  std::vector<uint8_t> copy(ref->data, ref->data + ref->size);
  std::vector<uint64_t> buf((copy.size() + 7) / 8);
  std::memcpy(buf.data(), copy.data(), copy.size());
  Model mm(reinterpret_cast<const uint8_t*>(buf.data()), copy.size());
  double* reals = const_cast<double*>(mm.curveReals(0));
  int k = mm.curveInts(0)[2], n9 = mm.curveInts(0)[1];
  reals[k + 3 * (n9 - 1)] += 1e-6;
  std::unique_ptr<Surface> open = surfaces::makeExtrusion(mm, 0, r, 0, s);
  REQUIRE(open);
  CHECK(closeInFact(std::move(open), 1e-9)->domain().uPeriod == 0);
}

TEST_CASE("B-spline derivative bounds shrink with the box: at +-0.001 within 2 x the sampled maximum") {
  // Every B-spline of the reference models (near, far, mirrored), a bicubic bump, a rational bilinear patch and a
  // rational dome (a circle swept round a quarter circle): at random points, each order-2 bound over a box +-0.001
  // about the point within one span against the largest of its partial sampled densely in the box. (Across a knot
  // the bound is the spans' hulls': a caller cuts there, as tess-cadio's criteria do.)
  struct S {
    std::string name;
    std::unique_ptr<Surface> s;
  };
  std::vector<S> all;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    if (std::strcmp(ref.variant, "s1") && std::strcmp(ref.variant, "far") && std::strcmp(ref.variant, "mirror"))
      continue;
    const Model m(ref.data, ref.size);
    for (int row = 0; row < m.surfaces(); row++) {
      if (m.surfaceKind(row) != CBR_SURFACE_BSPLINE) continue;
      Status st;
      if (auto s = makeSurface(m, row, st))
        all.push_back({std::string(ref.file) + " " + std::to_string(row), std::move(s)});
    }
  }
  {
    std::vector<std::vector<Vec3>> P(7, std::vector<Vec3>(7));
    for (int i = 0; i < 7; i++)
      for (int j = 0; j < 7; j++) P[i][j] = {i * 10 / 6.0, j * 10 / 6.0, i == 3 && (j == 3 || j == 4) ? 3.0 : 0};
    all.push_back({"bump", rawSpline(3, 3, {0, 1, 2, 3, 4}, {4, 1, 1, 1, 4}, {0, 1, 2, 3, 4}, {4, 1, 1, 1, 4}, P)});
    const double r2 = std::sqrt(0.5);
    const double xy[9][2] = {{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}, {1, 0}};
    const double cw[9] = {1, r2, 1, r2, 1, r2, 1, r2, 1}, mer[3][3] = {{1, 0, 1}, {1, 1, r2}, {0, 1, 1}};
    std::vector<std::vector<Vec3>> Q(9, std::vector<Vec3>(3));
    std::vector<std::vector<double>> W(9, std::vector<double>(3));
    for (int i = 0; i < 9; i++)
      for (int j = 0; j < 3; j++)
        Q[i][j] = {mer[j][0] * xy[i][0], mer[j][0] * xy[i][1], mer[j][1]}, W[i][j] = cw[i] * mer[j][2];
    // A rational bilinear patch (its second partials past the degree, the quotient rule's alone).
    all.push_back({"rational bilinear", rawSpline(1, 1, {0, 1}, {2, 2}, {0, 1}, {2, 2},
      {{{0, 0, 0}, {0, 1, 0.3}}, {{1, 0, 0.2}, {1, 1, 1}}}, {{1, 3}, {2, 0.5}})});
    all.push_back({"dome", rawSpline(2, 2, {0, 1, 2, 3, 4}, {3, 2, 2, 2, 3}, {0, 1}, {3, 3}, Q, W)});
  }
  REQUIRE(all.size() >= 4);
  std::mt19937_64 rng(17);
  std::uniform_real_distribution<double> U(0, 1);
  int bad = 0, n = 0;
  for (S& c : all) {
    SurfaceDomain d = c.s->domain();
    for (int k = 0; k < 12; k++) {
      const double w = 1e-3;
      double u = d.u.lo + w + (d.u.hi - d.u.lo - 2 * w) * U(rng);
      double v = d.v.lo + w + (d.v.hi - d.v.lo - 2 * w) * U(rng);
      std::vector<double> us, vs;
      c.s->breaks({u - w, u + w}, {v - w, v + w}, us, vs);
      if (us.size() > 2 || vs.size() > 2) continue;  // (across a knot)
      double b[3];
      if (c.s->derivBound({u - w, u + w}, {v - w, v + w}, 2, b) != Status::ok) continue;
      double mx[3] = {0, 0, 0}, scale = 0;
      for (int i = 0; i <= 10; i++)
        for (int j = 0; j <= 10; j++) {
          SurfacePoint q;
          c.s->eval(u - w + 0.2 * w * i, v - w + 0.2 * w * j, 2, q);
          mx[0] = std::fmax(mx[0], norm(q.duu)), mx[1] = std::fmax(mx[1], norm(q.duv));
          mx[2] = std::fmax(mx[2], norm(q.dvv));
          scale = std::fmax(scale, std::fmax(norm(q.du), norm(q.dv)));
        }
      // (A partial that's 0 there, a cylinder's S_uv, is held to 1% of the largest: what it adds to a deviation.)
      double big = std::fmax(mx[0], std::fmax(mx[1], mx[2]));
      for (int t = 0; t < 3; t++)
        if (!(b[t] <= 2 * mx[t] + 0.01 * big + 1e-9 * scale)) {
          if (bad++ < 10)
            std::printf("  %s at (%g, %g): bound %d %g against %g\n", c.name.c_str(), u, v, t, b[t], mx[t]);
        }
      n++;
    }
  }
  CHECK(bad == 0);
  CHECK(n > 40);
  // The rational dome at +-0.01 off its knots: within 1.1 x (the magnitudes' recursion alone gives 1.2 x there, the
  // signs lost; the intervals keep them).
  // The rational bilinear patch at +-0.05: its second partials, past the degree, from the intervals' recursion.
  {
    const Surface& bl = *all[all.size() - 2].s;
    for (Vec2 p : {Vec2{0.3, 0.4}, Vec2{0.7, 0.6}}) {
      const double w = 0.05;
      double b[3], mx[3] = {0, 0, 0};
      REQUIRE(bl.derivBound({p.x - w, p.x + w}, {p.y - w, p.y + w}, 2, b) == Status::ok);
      for (int i = 0; i <= 10; i++)
        for (int j = 0; j <= 10; j++) {
          SurfacePoint q;
          bl.eval(p.x - w + 0.2 * w * i, p.y - w + 0.2 * w * j, 2, q);
          mx[0] = std::fmax(mx[0], norm(q.duu)), mx[1] = std::fmax(mx[1], norm(q.duv));
          mx[2] = std::fmax(mx[2], norm(q.dvv));
        }
      // (Within 1.5 x: 1.42 at worst here; from the magnitudes' recursion alone, 1.67.)
      for (int t = 0; t < 3; t++) {
        if (!(b[t] <= 1.5 * mx[t]))
          std::printf("  bilinear at (%g, %g): bound %d %g against %g\n", p.x, p.y, t, b[t], mx[t]);
        CHECK(b[t] <= 1.5 * mx[t]);
      }
    }
  }
  const Surface& dome = *all.back().s;
  for (auto [p, w, f] : {std::tuple{Vec2{1.37, 0.5}, 0.01, 1.1}, std::tuple{Vec2{2.6, 0.3}, 0.01, 1.1},
         std::tuple{Vec2{0.4, 0.7}, 0.01, 1.1}}) {
    double b[3], mx[3] = {0, 0, 0};
    REQUIRE(dome.derivBound({p.x - w, p.x + w}, {p.y - w, p.y + w}, 2, b) == Status::ok);
    for (int i = 0; i <= 10; i++)
      for (int j = 0; j <= 10; j++) {
        SurfacePoint q;
        dome.eval(p.x - w + 0.2 * w * i, p.y - w + 0.2 * w * j, 2, q);
        mx[0] = std::fmax(mx[0], norm(q.duu)), mx[1] = std::fmax(mx[1], norm(q.duv));
        mx[2] = std::fmax(mx[2], norm(q.dvv));
      }
    for (int t = 0; t < 3; t++) {
      if (!(b[t] <= f * mx[t])) std::printf("  dome at (%g, %g): bound %d %g against %g\n", p.x, p.y, t, b[t], mx[t]);
      CHECK(b[t] <= f * mx[t]);
    }
  }
}

TEST_CASE("B-spline partial boxes within one span: orders 0 to 3 hold dense samples, tight, asked in any order") {
  // The boxes of one rectangle's partials share its nets (one sub-net, the partials by its differences, blossomed
  // where those round too much): every B-spline of the reference models, a bump and its twin with the same knots
  // (asked in turn over the same rectangle), the rational dome and bilinear patch, and a degree-8 ribbon 1e4 from
  // the origin (where the differences of a rectangle a millionth wide round too much: the fallback). Rectangles from
  // 0.3 of a span to 1e-7 of it, the partials asked in a shuffled order, two rectangles sharing their u range; each
  // box against a 7 x 7 grid of the partial, and no wider than the grid's spread plus 1e-3 of its size (plus a
  // rounding floor; polynomial surfaces), so a net differenced where it rounds too much (its error carried) is caught
  // as well.
  struct S {
    std::string name;
    std::unique_ptr<Surface> s;
    bool rational = false;
  };
  std::vector<S> all;
  for (int i = 0; i < fixtures::nReferences; i++) {
    const fixtures::Reference& ref = fixtures::references[i];
    if (std::strcmp(ref.variant, "s1") && std::strcmp(ref.variant, "far")) continue;
    const Model m(ref.data, ref.size);
    for (int row = 0; row < m.surfaces(); row++) {
      if (m.surfaceKind(row) != CBR_SURFACE_BSPLINE) continue;
      Status st;
      if (auto s = makeSurface(m, row, st))
        all.push_back({std::string(ref.file) + " " + std::to_string(row), std::move(s), m.surfaceInts(row)[6] != 0});
    }
  }
  auto bump = [](double h) {
    std::vector<std::vector<Vec3>> P(7, std::vector<Vec3>(7));
    for (int i = 0; i < 7; i++)
      for (int j = 0; j < 7; j++) P[i][j] = {i * 10 / 6.0, j * 10 / 6.0, i == 3 && (j == 3 || j == 4) ? h : 0};
    return rawSpline(3, 3, {0, 1, 2, 3, 4}, {4, 1, 1, 1, 4}, {0, 1, 2, 3, 4}, {4, 1, 1, 1, 4}, P);
  };
  const size_t twins = all.size();
  all.push_back({"bump", bump(3)});
  all.push_back({"bump's twin", bump(-5)});
  {
    const double r2 = std::sqrt(0.5);
    const double xy[9][2] = {{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}, {1, 0}};
    const double cw[9] = {1, r2, 1, r2, 1, r2, 1, r2, 1}, mer[3][3] = {{1, 0, 1}, {1, 1, r2}, {0, 1, 1}};
    std::vector<std::vector<Vec3>> Q(9, std::vector<Vec3>(3));
    std::vector<std::vector<double>> W(9, std::vector<double>(3));
    for (int i = 0; i < 9; i++)
      for (int j = 0; j < 3; j++)
        Q[i][j] = {mer[j][0] * xy[i][0], mer[j][0] * xy[i][1], mer[j][1]}, W[i][j] = cw[i] * mer[j][2];
    all.push_back({"dome", rawSpline(2, 2, {0, 1, 2, 3, 4}, {3, 2, 2, 2, 3}, {0, 1}, {3, 3}, Q, W), true});
    all.push_back({"rational bilinear", rawSpline(1, 1, {0, 1}, {2, 2}, {0, 1}, {2, 2},
      {{{0, 0, 0}, {0, 1, 0.3}}, {{1, 0, 0.2}, {1, 1, 1}}}, {{1, 3}, {2, 0.5}}), true});
    std::vector<std::vector<Vec3>> R(9, std::vector<Vec3>(9));
    std::mt19937_64 g(5);
    std::uniform_real_distribution<double> J(-0.3, 0.3);
    for (int i = 0; i < 9; i++)
      for (int j = 0; j < 9; j++) R[i][j] = {1e4 + 0.2 * i + J(g), 2e4 + 0.2 * j + J(g), 3e4 * (i + j) / 16.0 + J(g)};
    all.push_back({"degree-8 ribbon", rawSpline(8, 8, {0, 1}, {9, 9}, {0, 1}, {9, 9}, R)});
  }
  REQUIRE(all.size() > twins + 4);
  std::mt19937_64 rng(23);
  std::uniform_real_distribution<double> U(0, 1);
  const double widths[] = {0.3, 1e-2, 1e-4, 1e-6, 1e-7};
  std::vector<std::pair<int, int>> orders;
  for (int t = 0; t <= 3; t++)
    for (int l = 0; l <= t; l++) orders.push_back({t - l, l});
  const double kInf = std::numeric_limits<double>::infinity();
  int bad = 0, loose = 0, n = 0;
  auto check = [&](const S& c, Range ru, Range rv) {
    const SurfaceImpl* s = impl(c.s.get());
    std::shuffle(orders.begin(), orders.end(), rng);
    for (auto [k, l] : orders) {
      Box3 b;
      if (s->derivBox(ru, rv, k, l, b) != Status::ok) continue;
      Vec3 lo{kInf, kInf, kInf}, hi{-kInf, -kInf, -kInf};
      double mag = 0, size = 0;
      for (int x = 0; x <= 6; x++)
        for (int y = 0; y <= 6; y++) {
          Vec3 D[kPartials];
          const double u = std::fmin(ru.lo + (ru.hi - ru.lo) * x / 6, ru.hi);
          const double v = std::fmin(rv.lo + (rv.hi - rv.lo) * y / 6, rv.hi);
          if (s->derivs(u, v, 3, D) == Status::singular) continue;
          const Vec3 p = D[pidx(k, l)];
          size = std::fmax(size, norm(D[0]));
          n++;
          if (!inBox(b, p) && bad++ < 10)
            std::printf("  %s: partial (%d, %d) at (%.17g, %.17g) %s outside its box [%.17g, %.17g] [%.17g, %.17g] "
              "[%.17g, %.17g] over [%.17g, %.17g] x [%.17g, %.17g]\n", c.name.c_str(), k, l, u, v, show(p).c_str(),
              b.x.lo, b.x.hi, b.y.lo, b.y.hi, b.z.lo, b.z.hi, ru.lo, ru.hi, rv.lo, rv.hi);
          lo = {std::fmin(lo.x, p.x), std::fmin(lo.y, p.y), std::fmin(lo.z, p.z)};
          hi = {std::fmax(hi.x, p.x), std::fmax(hi.y, p.y), std::fmax(hi.z, p.z)};
          mag = std::fmax(mag, std::fmax(std::fabs(p.x), std::fmax(std::fabs(p.y), std::fabs(p.z))));
        }
      // (A rational surface's partials past the first are bounded through the quotient rule's magnitudes, a constant
      // factor loose: tightness is judged on polynomial ones, the degree-8 ribbon's fallbacks among them.)
      if (!(hi.x >= lo.x) || c.rational) continue;
      // The spread the grid can't see (a box holds the whole rectangle, the grid 49 points of it): its sides'
      // second-order change, bounded by the next partials' sizes, under 1e-3 of the partial at these widths but the
      // widest, which is let off.
      // (The rounding floor: differences of coordinates of the surface's size over the widths, k in u and l in v.)
      const double floor = 1e-13 * size / (std::pow(ru.hi - ru.lo, k) * std::pow(rv.hi - rv.lo, l));
      const double slack = 1e-3 * mag + floor + (ru.hi - ru.lo > 1e-3 ? kInf : 0);
      const double over = std::fmax(b.x.width() - (hi.x - lo.x),
        std::fmax(b.y.width() - (hi.y - lo.y), b.z.width() - (hi.z - lo.z)));
      if (!(over <= slack)) {
        if (loose++ < 10)
          std::printf("  %s: partial (%d, %d)'s box over [%.17g, %.17g] x [%.17g, %.17g] wider than its samples by "
            "%g (size %g)\n", c.name.c_str(), k, l, ru.lo, ru.hi, rv.lo, rv.hi, over, mag);
      }
    }
  };
  for (size_t i = 0; i < all.size(); i++) {
    const SurfaceImpl* s = impl(all[i].s.get());
    std::vector<double> us, vs;
    SurfaceDomain d = s->domain();
    s->breaks(d.u, d.v, us, vs);
    for (int trial = 0; trial < 6; trial++)
      for (double w : widths) {
        const size_t a = std::min(us.size() - 2, static_cast<size_t>(U(rng) * (us.size() - 1)));
        const size_t b = std::min(vs.size() - 2, static_cast<size_t>(U(rng) * (vs.size() - 1)));
        const double su = us[a + 1] - us[a], sv = vs[b + 1] - vs[b];
        const double cu = us[a] + su * (w / 2 + (1 - w) * U(rng)), cv = vs[b] + sv * (w / 2 + (1 - w) * U(rng));
        const Range ru{cu - w * su / 2, cu + w * su / 2}, rv{cv - w * sv / 2, cv + w * sv / 2};
        // Over the rectangle, again after another rectangle sharing its u range, and for the bumps, after the twin.
        check(all[i], ru, rv);
        check(all[i], ru, {rv.lo, 0.5 * rv.lo + 0.5 * rv.hi});
        check(all[i], ru, rv);
        if (i == twins || i == twins + 1) {
          check(all[i == twins ? twins + 1 : twins], ru, rv);
          check(all[i], ru, rv);
        }
      }
  }
  CHECK(bad == 0);
  CHECK(loose == 0);
  CHECK(n > 100000);
}
