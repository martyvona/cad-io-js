// surface.h's intersectLine on every surface of the reference models (near and far from the origin, mirrored) against
// independent oracles: lines through points of the surface in random directions, each such point found; every hit on
// the line and on the surface (by inversion); and dense sampling of the distance along the line, every place it comes
// within tol of the surface near a hit reported.
#include <cad_geom/surface.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>

#include "../src/surface_impl.h"
#include "brep_models.h"
#include "check.h"

using namespace cadgeom;
using cadgeom::surfaces::kEps;
using cadgeom::surfaces::kPartials;
using cadgeom::surfaces::SurfaceImpl;

namespace {

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
      if (s) z.push_back({std::string(ref.file) + " " + ref.variant + " surface " + std::to_string(row), std::move(s)});
    }
  }
  return z;
}

/** A finite parameter rectangle: the domain, infinite sides cut to [-3, 3] about 0. */
void sampleRange(const SurfaceDomain& d, Range& ru, Range& rv) {
  ru = std::isfinite(d.u.lo) && std::isfinite(d.u.hi) ? d.u : Range{-3, 3};
  rv = std::isfinite(d.v.lo) && std::isfinite(d.v.hi) ? d.v : Range{-3, 3};
}

double distanceTo(const Surface& s, Vec3 p, Range ru, Range rv, double tol) {
  return invertSurface(s, p, ru, rv, tol, nullptr, nullptr, true).distance;
}

} // namespace

TEST_CASE("intersectLine: lines through surface points, every hit on both, every contact sampled along it found") {
  std::mt19937_64 rng(5);
  int bad = 0, lines = 0, planted = 0, missed = 0, crossings = 0;
  for (Made& m : zoo({"s1", "far", "mirror"})) {
    const Surface& s = *m.s;
    const SurfaceDomain d = s.domain();
    Range ru, rv;
    sampleRange(d, ru, rv);
    Box3 b;
    dynamic_cast<const SurfaceImpl&>(s).derivBox(ru, rv, 0, 0, b);
    const double size = std::fmax(1e-300, std::hypot(b.x.width(), std::hypot(b.y.width(), b.z.width())));
    const double tol = 1e-9 * size;
    std::uniform_real_distribution<double> U(0, 1), G(-1, 1);
    for (int trial = 0; trial < 3; trial++) {
      const Vec2 uv0{ru.lo + (ru.hi - ru.lo) * U(rng), rv.lo + (rv.hi - rv.lo) * U(rng)};
      SurfacePoint sp;
      if (s.eval(uv0.x, uv0.y, 0, sp) != Status::ok) continue;
      Vec3 dir{G(rng), G(rng), G(rng)};
      dir = (size / norm(dir)) * dir;
      const Vec3 o = sp.p - 0.5 * dir;
      const LineIntersection li = intersectLine(s, o, dir, {0, 1}, ru, rv, tol);
      lines++;
      if (li.status != Status::ok) {
        if (bad++ < 10) std::printf("  %s: status %d\n", m.name.c_str(), int(li.status));
        continue;
      }
      crossings += static_cast<int>(li.crossings.size());
      // Every hit on the line, on the surface at its (u, v), and within tol of the surface.
      std::vector<LineHit> all = li.crossings;
      all.insert(all.end(), li.tangencies.begin(), li.tangencies.end());
      // (A tangency within its search's finest size of the line, 1e-6 of the range's size.)
      for (const LineHit& h : all) {
        SurfacePoint q;
        s.eval(h.uv.x, h.uv.y, 0, q);
        const Vec3 onLine = o + h.t * dir;
        const bool crossing = &h - all.data() < static_cast<long>(li.crossings.size());
        const double reach = crossing ? 2 * tol + 1e-12 * size : 2e-6 * size;
        const bool ok = norm(q.p - h.point) <= 1e-12 * size + 1e-15 * norm(q.p) && norm(onLine - h.point) <= reach
          && distanceTo(s, onLine, ru, rv, tol) <= reach;
        if (!ok && bad++ < 10)
          std::printf("  %s: hit t %.17g off: |S - p| %.3g, |line - p| %.3g\n", m.name.c_str(), h.t,
            norm(q.p - h.point), norm(onLine - h.point));
      }
      // The contract: every crossing at least kLineMargin from tangent.
      for (const LineHit& h : li.crossings)
        if (!(std::fabs(h.cosine) >= kLineMargin) && bad++ < 10)
          std::printf("  %s: a crossing at cosine %.3g\n", m.name.c_str(), h.cosine);
      // Crossings apart: one found from two rectangles (or on a seam's two copies) given once.
      for (size_t i = 0; i < li.crossings.size(); i++)
        for (size_t j = i + 1; j < li.crossings.size(); j++)
          if (norm(li.crossings[i].point - li.crossings[j].point) <= tol && bad++ < 10)
            std::printf("  %s: crossings %zu and %zu one point\n", m.name.c_str(), i, j);
      // The point the line was made through, at t = 1/2 (a crossing, or a tangency where the line grazes there).
      bool found = false;
      for (const LineHit& h : all) found = found || norm(h.point - sp.p) <= 4 * tol + 1e-12 * size;
      for (const Range& r : li.overlaps) found = found || (r.lo <= 0.5 && r.hi >= 0.5);
      planted++;
      if (!found) {
        missed++;
        if (bad++ < 10) std::printf("  %s: the point at t 1/2 not found (%zu crossings)\n", m.name.c_str(),
          li.crossings.size());
      }
      // Dense sampling along the line: each local minimum of the distance, refined, within 10 tol must be near a hit.
      const int n = 64;
      std::vector<double> dist(n + 1);
      // (The samples only place the minima: their distances to 1e-4 of the spacing.)
      for (int k = 0; k <= n; k++) dist[k] = distanceTo(s, o + (double(k) / n) * dir, ru, rv, 1e-4 * size / n);
      for (int k = 1; k < n; k++) {
        // (Only a minimum within a sample's spacing of the surface can hide a contact between samples.)
        if (!(dist[k] <= dist[k - 1] && dist[k] <= dist[k + 1]) || dist[k] > size / n) continue;
        // (Golden section to 1e-11 of the line's length, one inversion a step.)
        const double g = 0.6180339887498949;
        double lo = double(k - 1) / n, hi = double(k + 1) / n, a = hi - g * (hi - lo), c = lo + g * (hi - lo);
        double fa = distanceTo(s, o + a * dir, ru, rv, tol), fc = distanceTo(s, o + c * dir, ru, rv, tol);
        while (hi - lo > 1e-11) {
          if (fa < fc) hi = c, c = a, fc = fa, a = hi - g * (hi - lo), fa = distanceTo(s, o + a * dir, ru, rv, tol);
          else lo = a, a = c, fa = fc, c = lo + g * (hi - lo), fc = distanceTo(s, o + c * dir, ru, rv, tol);
        }
        const double t = 0.5 * lo + 0.5 * hi;
        if (distanceTo(s, o + t * dir, ru, rv, tol) > 10 * tol) continue;
        bool near = false;
        for (const LineHit& h : all) near = near || (t >= h.span.lo - 1e-6 && t <= h.span.hi + 1e-6);
        for (const Range& r : li.overlaps) near = near || (t >= r.lo - 1e-6 && t <= r.hi + 1e-6);
        if (!near && bad++ < 10) std::printf("  %s: a contact at t %.12g not reported\n", m.name.c_str(), t);
      }
    }
  }
  CHECK(bad == 0);
  CHECK(missed == 0);
  CHECK(lines > 150);
  CHECK(crossings >= planted);
}

TEST_CASE("intersectLine: lines tangent to every surface along S_u and S_v, the point a tangency or an overlap") {
  // A line along a tangent at S(u0, v0) touches the surface there (a sphere's, a torus's outer side), or lies in it
  // (a plane, a cylinder's or cone's generator, an extrusion's line): a tangency or an overlap holding the point,
  // never a crossing within 2 tol of it. (Mirroring changes nothing for a tangent: the plain and far variants.)
  std::mt19937_64 rng(7);
  int bad = 0, lines = 0, overlaps = 0, tangencies = 0, unresolved = 0;
  for (Made& m : zoo({"s1", "far"})) {
    const Surface& s = *m.s;
    const SurfaceDomain d = s.domain();
    Range ru, rv;
    sampleRange(d, ru, rv);
    Box3 b;
    dynamic_cast<const SurfaceImpl&>(s).derivBox(ru, rv, 0, 0, b);
    const double size = std::fmax(1e-300, std::hypot(b.x.width(), std::hypot(b.y.width(), b.z.width())));
    const double tol = 1e-9 * size;
    std::uniform_real_distribution<double> U(0.1, 0.9);
    for (int trial = 0; trial < 2; trial++) {
      const Vec2 uv0{ru.lo + (ru.hi - ru.lo) * U(rng), rv.lo + (rv.hi - rv.lo) * U(rng)};
      SurfacePoint sp;
      if (s.eval(uv0.x, uv0.y, 1, sp) != Status::ok) continue;
      for (int along = 0; along < 2; along++) {
        const Vec3 t = along ? sp.dv : sp.du;
        if (!(norm(t) > 0)) continue;
        const Vec3 dir = (0.25 * size / norm(t)) * t, o = sp.p - 0.5 * dir;
        const LineIntersection li = intersectLine(s, o, dir, {0, 1}, ru, rv, tol);
        lines++;
        // A line lying in a surface without a closed form for it (a B-spline cylinder's generator) can run out the
        // budget: said so, and counted.
        if (li.status == Status::noConvergence) {
          unresolved++;
          continue;
        }
        if (li.status != Status::ok) {
          if (bad++ < 40) std::printf("  %s: status %d\n", m.name.c_str(), int(li.status));
          continue;
        }
        int held = 0;
        for (const LineHit& h : li.tangencies) held += h.span.lo <= 0.5 && h.span.hi >= 0.5;
        for (const Range& r : li.overlaps) held += r.lo <= 0.5 + 1e-9 && r.hi >= 0.5 - 1e-9;
        if (held > 1 && bad++ < 40) std::printf("  %s: the tangent point held %d times\n", m.name.c_str(), held);
        for (const LineHit& h : li.crossings)
          if (norm(h.point - sp.p) <= 2 * tol + 1e-12 * size && bad++ < 40)
            std::printf("  %s: a crossing at the tangent point (cosine %.3g)\n", m.name.c_str(), h.cosine);
        if (!held && bad++ < 40)
          std::printf("  %s: the tangent point not held (%zu tangencies, %zu overlaps, %zu crossings)\n",
            m.name.c_str(), li.tangencies.size(), li.overlaps.size(), li.crossings.size());
        overlaps += static_cast<int>(li.overlaps.size()), tangencies += static_cast<int>(li.tangencies.size());
        // Along S_v (u fixed) with u's range moved off u0: a line that lay in the surface is outside the range now.
        if (!li.overlaps.empty() && along && (d.uPeriod > 0 || !std::isfinite(d.u.lo))) {
          const double w = d.uPeriod > 0 ? 0.25 * d.uPeriod : 1;
          const LineIntersection l3 = intersectLine(s, o, dir, {0, 1}, {uv0.x + w, uv0.x + 2 * w}, rv, tol);
          if (l3.status == Status::ok && !(l3.overlaps.empty() && l3.crossings.empty()) && bad++ < 40)
            std::printf("  %s: a line in the surface at u0 met it over a u range off u0\n", m.name.c_str());
        }
        // The same line moved 3 tol along the normal either way: where it lay in the surface (an overlap), now clear
        // of it all along, nothing; elsewhere no crossing within 2 tol of the tangent point.
        Vec3 n;
        if (s.normal(uv0.x, uv0.y, n) != Status::ok) continue;
        // Moved 0.5 tol off a surface it didn't lie in: still within tol of it there, a contact near the point.
        for (double side : {0.5, -0.5}) {
          if (!li.overlaps.empty()) break;
          const LineIntersection l2 = intersectLine(s, o + (side * tol) * n, dir, {0, 1}, ru, rv, tol);
          if (l2.status != Status::ok) continue;
          bool near = false;
          for (const LineHit& h : l2.tangencies) near = near || (h.span.lo <= 0.5 + 1e-4 && h.span.hi >= 0.5 - 1e-4);
          for (const LineHit& h : l2.crossings) near = near || std::fabs(h.t - 0.5) <= 1e-4;
          if (!near && bad++ < 40)
            std::printf("  %s: a line 0.5 tol off the tangent point met nothing near it\n", m.name.c_str());
        }
        for (double side : {3.0, -3.0}) {
          const Vec3 o2 = o + (side * tol) * n;
          const LineIntersection l2 = intersectLine(s, o2, dir, {0, 1}, ru, rv, tol);
          if (l2.status != Status::ok) continue;
          if (!li.overlaps.empty() && !(l2.overlaps.empty() && l2.crossings.empty() && l2.tangencies.empty())
            && bad++ < 40)
            std::printf("  %s: a line 3 tol off the surface it lay in met it (%zu overlaps, %zu crossings, %zu "
              "tangencies)\n", m.name.c_str(), l2.overlaps.size(), l2.crossings.size(), l2.tangencies.size());
          for (const LineHit& h : l2.crossings)
            if (norm(h.point - sp.p) <= 5 * tol + 1e-12 * size && bad++ < 40)
              std::printf("  %s: a crossing beside the tangent point, 3 tol off (cosine %.3g)\n", m.name.c_str(),
                h.cosine);
        }
      }
    }
  }
  CHECK(bad == 0);
  CHECK(overlaps > 0);
  CHECK(tangencies > 0);
  // (Lines lying in ruled surfaces without a closed form: a few in each kind's two tangent directions.)
  CHECK(unresolved < lines / 4);
}

TEST_CASE("intersectLine: lines on the search's shared sides, from a segment's end, oblique by 3e-3 and 1e-4") {
  // Points on the surface's breaks, its periodic seams and the range's middles (where the search's rectangles meet),
  // and lines through them in random directions: where the line is clearly transversal there, exactly one crossing at
  // the point, its periodic parameters in [lo, lo + period). The same from the point (a segment starting on the
  // surface), and from 0.5 tol past it: a crossing at t = 0. And lines through a point at an angle to the tangent
  // plane: 3e-3 (past the margin) a crossing or a tangency holding the point, 1e-4 (inside it) never a crossing near
  // it. (Up to 60 failures listed.)
  std::mt19937_64 rng(11);
  int bad = 0, sides = 0, ends = 0, oblique = 0;
  for (Made& m : zoo({"s1", "far"})) {
    const Surface& s = *m.s;
    const SurfaceDomain d = s.domain();
    Range ru, rv;
    sampleRange(d, ru, rv);
    Box3 b;
    dynamic_cast<const SurfaceImpl&>(s).derivBox(ru, rv, 0, 0, b);
    const double size = std::fmax(1e-300, std::hypot(b.x.width(), std::hypot(b.y.width(), b.z.width())));
    const double tol = 1e-9 * size;
    std::vector<double> us, vs;
    s.breaks(ru, rv, us, vs);
    std::vector<Vec2> pts;
    std::uniform_real_distribution<double> U(0.05, 0.95), G(-1, 1);
    for (size_t i = 1; i + 1 < us.size() && i < 4; i++) pts.push_back({us[i], rv.lo + (rv.hi - rv.lo) * U(rng)});
    for (size_t j = 1; j + 1 < vs.size() && j < 4; j++) pts.push_back({ru.lo + (ru.hi - ru.lo) * U(rng), vs[j]});
    if (d.uPeriod > 0) pts.push_back({ru.lo, rv.lo + (rv.hi - rv.lo) * U(rng)});  // the seam
    if (d.vPeriod > 0) pts.push_back({ru.lo + (ru.hi - ru.lo) * U(rng), rv.lo});
    pts.push_back({0.5 * ru.lo + 0.5 * ru.hi, rv.lo + (rv.hi - rv.lo) * U(rng)});
    pts.push_back({ru.lo + (ru.hi - ru.lo) * U(rng), 0.5 * rv.lo + 0.5 * rv.hi});
    for (Vec2 uv : pts) {
      SurfacePoint sp;
      Vec3 n;
      if (s.eval(uv.x, uv.y, 1, sp) != Status::ok || s.normal(uv.x, uv.y, n) != Status::ok) continue;
      Vec3 dir{G(rng), G(rng), G(rng)};
      dir = (size / norm(dir)) * dir;
      if (std::fabs(dot(dir, n)) / norm(dir) < 0.1) continue;  // clearly transversal only
      // Through the point.
      {
        const LineIntersection li = intersectLine(s, sp.p - 0.5 * dir, dir, {0, 1}, ru, rv, tol);
        int at = 0;
        for (const LineHit& h : li.crossings) {
          at += norm(h.point - sp.p) <= 4 * tol + 1e-12 * size;
          // Periodic parameters in [lo, lo + period).
          if (((d.uPeriod > 0 && !(h.uv.x >= ru.lo && h.uv.x < ru.lo + d.uPeriod))
                || (d.vPeriod > 0 && !(h.uv.y >= rv.lo && h.uv.y < rv.lo + d.vPeriod))) && bad++ < 60)
            std::printf("  %s: a crossing's (%.17g, %.17g) outside a period\n", m.name.c_str(), h.uv.x, h.uv.y);
        }
        sides++;
        if (li.status == Status::ok && at != 1 && bad++ < 60)
          std::printf("  %s: (%.17g, %.17g) on a shared side crossed %d times (%zu crossings, %zu tangencies; "
            "dir %.17g %.17g %.17g)\n", m.name.c_str(), uv.x, uv.y, at, li.crossings.size(), li.tangencies.size(),
            dir.x, dir.y, dir.z);
      }
      // From the point, and from 0.5 tol past it (the crossing within tol of the segment's start, before it).
      for (double past : {0.0, 0.5}) {
        const LineIntersection li = intersectLine(s, sp.p + (past * tol / norm(dir)) * dir, dir, {0, 1}, ru, rv, tol);
        bool at = false;
        for (const LineHit& h : li.crossings) at = at || (std::fabs(h.t) * size <= 4 * tol + 1e-12 * size);
        ends++;
        if (li.status == Status::ok && !at && bad++ < 60)
          std::printf("  %s: the segment's start (%.17g, %.17g) %g tol past the surface not crossed (%zu crossings, "
            "%zu tangencies; dir %.17g %.17g %.17g)\n", m.name.c_str(), uv.x, uv.y, past, li.crossings.size(),
            li.tangencies.size(), dir.x, dir.y, dir.z);
      }
    }
    // Oblique: in the tangent plane along S_u turned toward n by the angle.
    for (int trial = 0; trial < 2; trial++) {
      const Vec2 uv{ru.lo + (ru.hi - ru.lo) * U(rng), rv.lo + (rv.hi - rv.lo) * U(rng)};
      SurfacePoint sp;
      Vec3 n;
      if (s.eval(uv.x, uv.y, 1, sp) != Status::ok || s.normal(uv.x, uv.y, n) != Status::ok || !(norm(sp.du) > 0))
        continue;
      const Vec3 e = (1 / norm(sp.du)) * sp.du;
      for (double angle : {3e-3, 1e-4}) {
        const Vec3 dir = (0.25 * size) * (std::cos(angle) * e + std::sin(angle) * n);
        const LineIntersection li = intersectLine(s, sp.p - 0.5 * dir, dir, {0, 1}, ru, rv, tol);
        if (li.status != Status::ok) continue;
        oblique++;
        int crossingAt = 0;
        bool held = false;
        // (Along a line at an angle a to the surface its crossing is placed to g's rounding over sin a: 1e6 from the
        // origin, 1e-6 of the size at 3e-3.)
        const double reach = 4 * tol + 1e-12 * size + 64 * kEps * norm(sp.p) / std::sin(angle);
        for (const LineHit& h : li.crossings) {
          const bool here = norm(h.point - sp.p) <= reach;
          crossingAt += here, held = held || here;
        }
        for (const LineHit& h : li.tangencies) held = held || (h.span.lo <= 0.5 && h.span.hi >= 0.5);
        for (const Range& r : li.overlaps) held = held || (r.lo <= 0.5 && r.hi >= 0.5);
        if (angle > kLineMargin && !held && bad++ < 60)
          std::printf("  %s: a line at %g to the tangent plane missed the point (%.17g, %.17g): %zu crossings, %zu "
            "tangencies, %zu overlaps\n", m.name.c_str(), angle, uv.x, uv.y, li.crossings.size(), li.tangencies.size(),
            li.overlaps.size());
        if (angle < kLineMargin && crossingAt && bad++ < 60)
          std::printf("  %s: a line at %g to the tangent plane crossing at the point\n", m.name.c_str(), angle);
      }
    }
  }
  CHECK(bad == 0);
  CHECK(sides > 50);
  CHECK(ends == 2 * sides);
  CHECK(oblique > 100);
}

TEST_CASE("intersectLine: lines along a normal of a surface curved within a few tol, a crossing each, no tangency") {
  // A cylinder of radius 0.15, a sphere of 0.15 and a torus (1, 0.15) at tol 0.05 (a narrow face's, its point moved
  // off along the normal): rectangles reach tol's size before Krawczyk's test settles the root, and being transversal
  // they're split on, not taken as contacts. From 10 tol off to 2 tol past: from outside one crossing, at the point;
  // from inside (10 tol is past the far wall) two, one at the point. (The sphere's points with |v| <= 0.6: nearer a
  // pole, its rectangles there, never transversal, are contacts within the reach that takes the crossing in.)
  const double tol = 0.05, R = 0.15;
  std::vector<double> fr{0, 0, 0, 0, 0, 1, 1, 0, 0, R}, tr{0, 0, 0, 0, 0, 1, 1, 0, 0, 1, R};
  std::vector<std::pair<const char*, std::unique_ptr<SurfaceImpl>>> ss;
  ss.emplace_back("cylinder", surfaces::makeCone(fr.data(), R, 0));
  ss.emplace_back("sphere", surfaces::makeSphere(fr.data()));
  ss.emplace_back("torus", surfaces::makeTorus(tr.data()));
  std::mt19937_64 rng(5);
  std::uniform_real_distribution<double> U(0, 1);
  int bad = 0, lines = 0;
  for (auto& [name, s] : ss) {
    const SurfaceDomain d = s->domain();
    for (int i = 0; i < 40; i++) {
      const bool sphere = std::strcmp(name, "sphere") == 0;
      const Vec2 uv{d.u.lo + (d.u.hi - d.u.lo) * U(rng), sphere ? -0.6 + 1.2 * U(rng)
        : std::isfinite(d.v.lo) ? d.v.lo + (d.v.hi - d.v.lo) * U(rng) : -1 + 2 * U(rng)};
      SurfacePoint sp;
      Vec3 n;
      if (s->eval(uv.x, uv.y, 0, sp) != Status::ok || s->normal(uv.x, uv.y, n) != Status::ok) continue;
      const Range ru = d.u, rv = std::isfinite(d.v.lo) ? d.v : Range{-3, 3};
      for (int side : {1, -1}) {
        const Vec3 o = sp.p + (side * 10 * tol) * n, dir = -(side * 12 * tol) * n;
        const LineIntersection li = intersectLine(*s, o, dir, {0, 1}, ru, rv, tol);
        lines++;
        int at = 0;
        for (const LineHit& h : li.crossings) at += norm(h.point - sp.p) <= 1e-9;
        const bool good = li.status == Status::ok && li.crossings.size() == (side > 0 ? 1u : 2u)
          && li.tangencies.empty() && at == 1;
        if (!good && bad++ < 20)
          std::printf("  %s (%.6g, %.6g) side %d: %zu crossings, %zu tangencies\n", name, uv.x, uv.y, side,
            li.crossings.size(), li.tangencies.size());
      }
    }
  }
  CHECK(bad == 0);
  CHECK(lines >= 200);
}

TEST_CASE("intersectLine: a transversal crossing exactly on the search range's side, a tangency there, settled") {
  // A cylinder of radius 0.15 at tol 0.05, searched over u in [0, 1] (a range cut short, not the period): lines along
  // the normal at u = 0 cross on the range's side, where Krawczyk's test has no room past the root; the rectangles
  // there split down to their coordinates' rounding and end as a contact, a tangency holding the point, within the
  // budget.
  const double tol = 0.05, R = 0.15;
  std::vector<double> fr{0, 0, 0, 0, 0, 1, 1, 0, 0, R};
  const std::unique_ptr<SurfaceImpl> s = surfaces::makeCone(fr.data(), R, 0);
  int bad = 0;
  for (double v : {-0.7, -0.2, 0.0, 0.4, 0.9}) {
    SurfacePoint sp;
    Vec3 n;
    REQUIRE(s->eval(0, v, 0, sp) == Status::ok && s->normal(0, v, n) == Status::ok);
    const Vec3 o = sp.p + (10 * tol) * n, dir = -(12 * tol) * n;
    const LineIntersection li = intersectLine(*s, o, dir, {0, 1}, {0, 1}, {-3, 3}, tol);
    bool held = false;
    for (const LineHit& h : li.tangencies) held = held || (h.span.lo <= 10.0 / 12 && h.span.hi >= 10.0 / 12);
    for (const LineHit& h : li.crossings) held = held || norm(h.point - sp.p) <= 1e-9;
    if ((li.status != Status::ok || !held) && bad++ < 20)
      std::printf("  v %g: status %d, %zu crossings, %zu tangencies\n", v, int(li.status), li.crossings.size(),
        li.tangencies.size());
  }
  CHECK(bad == 0);
}
