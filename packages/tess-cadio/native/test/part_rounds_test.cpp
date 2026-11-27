// part.h's rounds on whole parts: split rounds and their end, verdicts reused across meshings (reuseVerdicts),
// keepSteiner, defects kept or failed (keepDefects, keepDeviation, failTurnedOver), point caps (freezeCapped) and
// retries (retryStretch).

#include "part_common.h"

TEST_CASE("a face left past its deflection, max(d, tol), measured to keepDeviation's limit: past it, marked past the "
  "limits (failed without keepDefects), as measuring every refused triangle would say, the measure a lower bound; "
  "within it, its triangles as without the check; progress as it goes") {
  // Faces meshed with no Steiner points and no split rounds, their boundary's triangles refused: spheres' hemisphere
  // (its bound in closed form, tight: past W none measured), bumpPatch's B-spline (by its derivative bounds; at 1e-6
  // some of its refused within by them), and torusOuterHalf's torus (its distance function's form not holding on such
  // triangles: all its some 330 measured, its progress reported again as they go).
  // The truth: every refused triangle's lattice (order 4, its corners left out) inverted here, W the most; then for
  // keep limits either side of W (and past max(d, tol)), past the limits exactly where W is past the keep limit, its
  // measure past it and at most W.
  struct Case { const char* model; int face; double d; };
  for (Case c : {Case{"spheres", 1, 0.1}, Case{"bumpPatch", 0, 1e-4}, Case{"bumpPatch", 0, 1e-6},
         Case{"torusOuterHalf", 0, 1e-3}}) {
    cadgeom::Model m = load(c.model);
    REQUIRE(m.ok());
    PartOptions o = options(c.d, 0.26);
    o.maxPointsPerFace = 0;
    o.failCapped = false;  // (capped at none on purpose: the boundary's own triangles)
    o.failTurnedOver = false;  // (meshed with no Steiner points, turned-over triangles kept: the deviation alone)
    o.maxSplitRounds = 0;
    o.checkDeviation = false;
    PartMesher keep(m, o);
    const FaceMesh& k = keep.face(c.face);
    REQUIRE(k.status == cadgeom::Status::ok);
    CHECK_EQ(k.worstDeviation, 0);
    CHECK_EQ(k.deviationMeasured, 0);
    cadgeom::Status st;
    auto s = cadgeom::makeSurface(m, m.faceSurface(c.face), st);
    REQUIRE(s);
    const cadgeom::SurfaceDomain D = s->domain();
    // W the worst over the refused triangles, Wmin the least of their own worsts.
    double W = 0, Wmin = INFINITY;
    for (int32_t t : k.rejected) {
      double Wt = 0;
      for (int i = 0; i <= 4; i++)
        for (int j = 0; i + j <= 4; j++) {
          if (i == 4 || j == 4 || i + j == 0) continue;
          Vec3 x = (i / 4.0) * k.points[k.triangles[3 * t]] + (j / 4.0) * k.points[k.triangles[3 * t + 1]] +
            ((4 - i - j) / 4.0) * k.points[k.triangles[3 * t + 2]];
          cadgeom::SurfaceInversion inv = cadgeom::invertSurface(*s, x, D.u, D.v, 1e-6 * c.d);
          if (inv.status == cadgeom::Status::ok) Wt = std::fmax(Wt, inv.distance);
        }
      W = std::fmax(W, Wt), Wmin = std::fmin(Wmin, Wt);
    }
    if (k.rejected.empty() || !(W > c.d))
      std::printf("  %s at %g: %zu refused, worst %g x d\n", c.model, c.d, k.rejected.size(), W / c.d);
    REQUIRE(k.rejected.size() > 0);
    REQUIRE(W > std::fmax(c.d, cadgeom::Tolerances(m).face(c.face)));
    (void)Wmin;
    // Keep limits each side of W, all past max(d, tol): 1.05 W, 2 W, 0.95 W, and half way from max(d, tol) to W.
    const double base = std::fmax(c.d, cadgeom::Tolerances(m).face(c.face));  // (max(d, tol))
    for (double limit : {1.05 * W, 2.0 * W, 0.95 * W, 0.5 * (base + W)}) {
      if (!(limit > base)) continue;
      o.checkDeviation = true;
      o.keepDeviation = limit / base;
      std::vector<PartProgress> seen;
      o.progress = [&](const PartProgress& p) { seen.push_back(p); };
      PartMesher pm(m, o);
      const FaceMesh& fm = pm.face(c.face);
      const bool past = W > limit;
      CHECK(fm.status == cadgeom::Status::ok);
      CHECK_EQ(fm.defectPastLimits, past);
      CHECK(fm.deviationMeasured <= static_cast<int>(k.rejected.size()));
      CHECK_EQ(fm.triangles.size(), k.triangles.size());
      if (past) {
        CHECK(fm.deviationMeasured >= 1);
        CHECK(fm.worstDeviation > limit);
        CHECK(fm.worstDeviation <= W * (1 + 1e-6) + 1e-3 * c.d);
      } else {
        CHECK(fm.worstDeviation <= limit);
      }
      // Without keepDefects, failed: the cause's measure a lower bound past max(d, tol).
      if (limit == 2.0 * W) {
        PartOptions strict = o;
        strict.keepDefects = false, strict.progress = nullptr;
        PartMesher ps(m, strict);
        CHECK(ps.face(c.face).status == cadgeom::Status::noConvergence);
        CHECK(ps.face(c.face).triangles.empty());
        CHECK(ps.face(c.face).cause.find("past its deflection: at least ") != std::string::npos);
        CHECK(ps.face(c.face).worstDeviation > base);
      }
      // Its progress: the check's phase after every meshing report, for this face a report as it starts and one
      // more every 64 triangles measured.
      int reports = 0;
      bool after = true;
      size_t lastMeshing = 0;
      for (size_t i = 0; i < seen.size(); i++)
        if (seen[i].phase == PartProgress::meshing) lastMeshing = i;
      for (size_t i = 0; i < seen.size(); i++) {
        if (seen[i].phase != PartProgress::deviation) continue;
        after = after && i > lastMeshing;
        if (seen[i].row != c.face) continue;
        reports++;
        CHECK_EQ(seen[i].facesDone, c.face);
        CHECK_EQ(seen[i].facesTotal, m.faces());
      }
      CHECK(after);
      CHECK_EQ(reports, 1 + fm.deviationMeasured / 64);
    }
  }
  // Meshed as usual, nothing refused: nothing measured, ok.
  cadgeom::Model m = load("spheres");
  PartMesher pm(m, options(0.1, 0.26));
  CHECK(pm.face(1).status == cadgeom::Status::ok);
  CHECK(pm.face(1).rejected.empty());
}

TEST_CASE("keepDefects (the default): a face past its deflection kept within keepDeviation x max(d, tol), its measure "
  "recorded, past it kept marked past the limits; one turned triangle kept within keepTurned, past it marked; a "
  "capped face kept, past the limits where its mesh is; each failed without keepDefects") {
  {
    // spheres' hemisphere meshed from its boundary alone (as the strict case above): W its worst, past d.
    cadgeom::Model m = load("spheres");
    REQUIRE(m.ok());
    PartOptions o = options(0.1, 0.26);
    o.maxPointsPerFace = 0, o.failCapped = false, o.failTurnedOver = false, o.maxSplitRounds = 0;
    o.checkDeviation = false;
    PartMesher plain(m, o);
    const FaceMesh& k = plain.face(1);
    REQUIRE(k.status == cadgeom::Status::ok);
    cadgeom::Status st;
    auto s = cadgeom::makeSurface(m, m.faceSurface(1), st);
    const cadgeom::SurfaceDomain D = s->domain();
    double W = 0;
    for (int32_t t : k.rejected)
      for (int i = 0; i <= 4; i++)
        for (int j = 0; i + j <= 4; j++) {
          if (i == 4 || j == 4 || i + j == 0) continue;
          Vec3 x = (i / 4.0) * k.points[k.triangles[3 * t]] + (j / 4.0) * k.points[k.triangles[3 * t + 1]] +
            ((4 - i - j) / 4.0) * k.points[k.triangles[3 * t + 2]];
          cadgeom::SurfaceInversion inv = cadgeom::invertSurface(*s, x, D.u, D.v, 1e-8);
          if (inv.status == cadgeom::Status::ok) W = std::fmax(W, inv.distance);
        }
    const double base = std::fmax(0.1, cadgeom::Tolerances(m).face(1));
    REQUIRE(W > base);
    o.checkDeviation = true;
    o.keepDeviation = 1.5 * W / base;
    PartMesher kept(m, o);
    const FaceMesh& fk = kept.face(1);
    CHECK(fk.status == cadgeom::Status::ok);
    // (The lattice's worst, measured on to the keep limit: W itself, its points the same, within the inversion's
    // tolerance.)
    if (!(std::fabs(fk.defectDeviation - W / base) <= 1e-6 * W / base))
      std::printf("  kept at %g x, W %g x\n", fk.defectDeviation, W / base);
    CHECK(std::fabs(fk.defectDeviation - W / base) <= 1e-6 * W / base);
    CHECK_EQ(fk.defectTurned, 0);
    CHECK(!fk.defectCapped);
    CHECK(!fk.defectPastLimits);
    // Past the limit: kept, marked, its measure a lower bound past the limit (measured until past it).
    o.keepDeviation = 0.75 * W / base;
    PartMesher past(m, o);
    CHECK(past.face(1).status == cadgeom::Status::ok);
    CHECK(past.face(1).defectPastLimits);
    CHECK(past.face(1).defectDeviation > 0.75 * W / base);
    CHECK(past.face(1).defectDeviation <= W / base * (1 + 1e-6));
    o.keepDefects = false;
    PartMesher failed(m, o);
    CHECK(failed.face(1).status == cadgeom::Status::noConvergence);
    CHECK(failed.face(1).cause.find("past its deflection") != std::string::npos);
    CHECK_EQ(failed.face(1).defectDeviation, 0);
    // A capped face (20 points), its mesh far past d: kept, past the limits; kept within them where they're wide.
    PartOptions c = options(1e-3, 0.26);
    c.maxPointsPerFace = 20;
    PartMesher cf(m, c);
    CHECK(cf.face(1).status == cadgeom::Status::ok);
    CHECK(cf.face(1).defectCapped);
    CHECK(cf.face(1).defectPastLimits);
    c.keepDeviation = 1e9;
    PartMesher ck(m, c);
    CHECK(ck.face(1).status == cadgeom::Status::ok);
    CHECK(ck.face(1).capped);
    CHECK(ck.face(1).defectCapped);
    CHECK(!ck.face(1).defectPastLimits);
    CHECK(ck.face(1).defectDeviation > 1);
  }
  {
    // cornerFoldTight without the flip: one triangle turned as shipped; kept, said; failed at keepTurned 0, and at a
    // turned area share of 0.
    cadgeom::Model m = load("cornerFoldTight");
    REQUIRE(m.ok());
    PartOptions o = options(1, 0.26);
    o.flipTurned = false;
    PartMesher a(m, o);
    CHECK(a.face(0).status == cadgeom::Status::ok);
    CHECK_EQ(a.face(0).defectTurned, 1);
    CHECK(!a.face(0).defectPastLimits);
    o.keepTurned = 0;
    PartMesher b(m, o);
    CHECK(b.face(0).status == cadgeom::Status::ok);
    CHECK(b.face(0).defectPastLimits);
    o.keepTurned = 16, o.keepTurnedShare = 0;
    PartMesher c(m, o);
    CHECK(c.face(0).defectPastLimits);
    o.keepTurnedShare = 0.01, o.keepDefects = false;
    PartMesher d(m, o);
    CHECK(d.face(0).status == cadgeom::Status::noConvergence);
    CHECK(d.face(0).cause.find("turned against its surface") != std::string::npos);
  }
}

TEST_CASE("checkDeviation's limit is max(d, the face's tolerance): the same mesh past d kept within its tolerance, "
  "failed under it; a part's uncertainty counts alike; the limit named in the cause") {
  // spheres' hemisphere at 0.1 mm, no Steiner points, no split rounds: its refused triangles some 1.7 x d off (W).
  // Its face's tolerance 0.2 mm: the limit 0.2, past W, the face kept, the same triangles as with no check; 0.05 mm:
  // the limit d, under W, failed. The part's uncertainty at 0.2 mm (its floor too, so its own mesh): failed exactly
  // where that mesh's W is past 0.2.
  const tessfixtures::Model* tm = tessfixtures::model("spheres");
  const fixtures::Model* fx = tm ? nullptr : fixtures::model("spheres");
  const uint8_t* data = tm ? tm->data : fx->data;
  const size_t size = tm ? tm->size : fx->size;
  auto withTolerance = [&](double face, double part) {
    std::vector<uint8_t> b(data, data + size);
    cadgeom::Model m(b.data(), b.size());
    if (std::isfinite(face)) const_cast<double*>(m.f64(CBR_FACE_TOLERANCE))[1] = face;
    if (std::isfinite(part)) const_cast<double*>(m.f64(CBR_PART_UNCERTAINTY))[0] = part;
    return b;
  };
  PartOptions o = options(0.1, 0.26);
  o.maxPointsPerFace = 0;
  o.failCapped = false;  // (capped at none on purpose: the boundary's own triangles)
  o.maxSplitRounds = 0;
  o.failTurnedOver = false;  // (meshed with no Steiner points, turned-over triangles kept: the deviation alone)
  o.keepDefects = false;  // (the strict verdict; keepDefects' own case below)
  const double F = 1;  // (the cause says the limit as a multiple of max(d, tol))
  auto worst = [&](const cadgeom::Model& m, const FaceMesh& k) {
    cadgeom::Status st;
    auto s = cadgeom::makeSurface(m, m.faceSurface(1), st);
    const cadgeom::SurfaceDomain D = s->domain();
    double W = 0;
    for (int32_t t : k.rejected)
      for (int i = 0; i <= 4; i++)
        for (int j = 0; i + j <= 4; j++) {
          if (i == 4 || j == 4 || i + j == 0) continue;
          Vec3 x = (i / 4.0) * k.points[k.triangles[3 * t]] + (j / 4.0) * k.points[k.triangles[3 * t + 1]] +
            ((4 - i - j) / 4.0) * k.points[k.triangles[3 * t + 2]];
          cadgeom::SurfaceInversion inv = cadgeom::invertSurface(*s, x, D.u, D.v, 1e-9);
          if (inv.status == cadgeom::Status::ok) W = std::fmax(W, inv.distance);
        }
    return W;
  };
  for (double part : {static_cast<double>(NAN), 0.2}) {
    for (double face : {0.2, 0.05}) {
      std::vector<uint8_t> b = withTolerance(face, part);
      cadgeom::Model m(b.data(), b.size());
      REQUIRE(m.ok());
      PartOptions keep = o;
      keep.checkDeviation = false;
      PartMesher k(m, keep);
      REQUIRE(k.face(1).status == cadgeom::Status::ok);
      const double W = worst(m, k.face(1));
      const double tol = std::fmax(face, std::isfinite(part) ? part : 0);
      const double limit = F * std::fmax(0.1, tol);
      if (!(W > F * 0.1) || std::fabs(W - limit) < 0.01)
        std::printf("  face %g, part %g: worst %g, limit %g\n", face, part, W, limit);
      // (Past d, but where the part's tolerance puts the refinement floor at 0.2: its boundary triangles, thinner than
      // that, aren't held to the angle for their facets, and those left refused are within d.)
      if (std::isfinite(part)) {
        CHECK(W <= limit);
      } else {
        REQUIRE(W > F * 0.1);
      }
      PartMesher pm(m, o);
      const FaceMesh& fm = pm.face(1);
      CHECK_EQ(fm.status == cadgeom::Status::noConvergence, W > limit);
      if (W > limit) {
        char want[64];
        std::snprintf(want, sizeof want, "past %.3g x max(d, tol) = %.3g x %.3g mm", F, F, std::fmax(0.1, tol));
        if (fm.cause.find(want) == std::string::npos) std::printf("  cause: %s\n", fm.cause.c_str());
        CHECK(fm.cause.find(want) != std::string::npos);
      } else {
        CHECK(fm.triangles == k.face(1).triangles);
      }
    }
  }
  // The same mesh both ways: with no uncertainty, the face's 0.2 mm keeps what its 0.05 mm fails.
  std::vector<uint8_t> lo = withTolerance(0.05, NAN), hi = withTolerance(0.2, NAN);
  cadgeom::Model ml(lo.data(), lo.size()), mh(hi.data(), hi.size());
  PartMesher pl(ml, o), ph(mh, o);
  CHECK(pl.face(1).status == cadgeom::Status::noConvergence);
  CHECK(ph.face(1).status == cadgeom::Status::ok);
  PartOptions keep = o;
  keep.checkDeviation = false;
  PartMesher kl(ml, keep);
  CHECK(ph.face(1).triangles == kl.face(1).triangles);
  bool samePoints = ph.face(1).points.size() == kl.face(1).points.size();
  for (size_t i = 0; samePoints && i < kl.face(1).points.size(); i++)
    samePoints = norm(ph.face(1).points[i] - kl.face(1).points[i]) == 0;
  CHECK(samePoints);
}

TEST_CASE("a face meshed with a triangle turned against its surface fails, said so; failTurnedOver false keeps it") {
  // torusOuterHalf with no Steiner points and no split rounds: its boundary's triangulation alone, some of its
  // triangles across the tube turned against the surface. Failed (noConvergence, the cause counting them, no
  // triangles); with the option off, kept as meshed, the count as the cause says.
  cadgeom::Model m = load("torusOuterHalf");
  REQUIRE(m.ok());
  PartOptions o = options(0.1, 0.26);
  o.maxPointsPerFace = 0;
  o.failCapped = false;  // (capped at none on purpose: the boundary's own triangles)
  o.maxSplitRounds = 0;
  o.checkDeviation = false;
  o.keepDefects = false;  // (the strict verdict; keepDefects' own case)
  PartMesher failing(m, o);
  const FaceMesh& f = failing.face(0);
  CHECK(f.status == cadgeom::Status::noConvergence);
  CHECK(f.triangles.empty());
  int said = -1;
  if (std::sscanf(f.cause.c_str(), "meshed with %d triangles turned against its surface", &said) != 1)
    std::printf("  cause: %s\n", f.cause.c_str());
  CHECK(said > 0);
  o.failTurnedOver = false;
  PartMesher keeping(m, o);
  const FaceMesh& k = keeping.face(0);
  REQUIRE(k.status == cadgeom::Status::ok);
  int against = 0;
  for (size_t t = 0; t + 2 < k.triangles.size(); t += 3) {
    const int32_t* v = &k.triangles[t];
    const Vec3 g = cadgeom::cross(k.points[v[1]] - k.points[v[0]], k.points[v[2]] - k.points[v[0]]);
    against += cadgeom::dot(g, k.normals[v[0]] + k.normals[v[1]] + k.normals[v[2]]) < 0;
  }
  CHECK_EQ(against, said);
  // Meshed as usual: none turned over, kept.
  PartMesher usual(m, options(0.1, 0.26));
  CHECK(usual.face(0).status == cadgeom::Status::ok);
}

TEST_CASE("splits: a boundary too coarse for the face's criteria split until none is wanted, both faces meeting") {
  // The seam cylinder at a tight deflection, its angle loose: the circles' spacing from their own curvature alone
  // would do, but the face's criteria ask more of the seam's neighbours; whatever is asked, the rounds end with no
  // split wanted and the edges shared.
  cadgeom::Model m = load("seamCylinder");
  PartMesher pm(m, options(0.002, 1.0));
  REQUIRE(pm.face(0).status == cadgeom::Status::ok);
  CHECK_EQ(pm.face(0).splitsWanted, 0);
  CHECK(pm.face(0).rejected.empty());
  CHECK_EQ(sharedEdges(m, pm, "split cylinder"), 0);
  CHECK(pm.rounds() < 4);
}

TEST_CASE("edges allowed 4 times coarser than the faces want: split until they're not, every triangle accepted") {
  for (const char* name : {"seamCylinder", "band", "spheres", "twisted"}) {
    cadgeom::Model m = load(name);
    PartOptions o = options(0.01, 0.26);
    o.edgeSpacingScale = 4;
    PartMesher pm(m, o);
    CHECK_EQ(sharedEdges(m, pm, name), 0);
    for (int f = 0; f < m.faces(); f++) {
      const FaceMesh& fm = pm.face(f);
      if (fm.status != cadgeom::Status::ok) continue;
      if (fm.splitsWanted) std::printf("  %s: face %d still wants %d after %d rounds\n", name, f, fm.splitsWanted,
        pm.rounds());
      CHECK_EQ(fm.splitsWanted, 0);
    }
    // Every triangle accepted at the end but slivers in a pole's fan.
    for (int f = 0; f < m.faces(); f++) {
      int n = poleFanOnly(pm.face(f), Vec3{10, 0, 1});
      if (n) std::printf("  %s face %d: %d refused after %d rounds, %d splits wanted\n", name, f, n, pm.rounds(),
        pm.face(f).splitsWanted);
      CHECK_EQ(n, 0);
    }
  }
}

TEST_CASE("split rounds: a band's hole of straight edges, the triangles beside them split until accepted") {
  // (The metric along a cylinder's axis is its extent, so the hole's axial edges stay one span; the triangles round
  // the band next to them, wider than its angle allows, ask them split.)
  cadgeom::Model m = load("bandHoleAtVertex");
  PartMesher pm(m, options(0.01, 0.26));
  REQUIRE(pm.face(0).status == cadgeom::Status::ok);
  CHECK(pm.rounds() >= 1);
  CHECK(pm.face(0).rejected.empty());
  CHECK_EQ(pm.face(0).splitsWanted, 0);
}

TEST_CASE("verdicts reused across meshings (reuseVerdicts): the same meshes bit for bit as asking the criteria again") {
  // Parts whose faces are meshed again in split rounds (edges 4 times coarser than the faces want, a band's hole, a
  // cusp), some meshed once, and some whose points crowd their boundary (SizeField::crowds: a tube thinner than its
  // tolerance, a fold at a corner).
  struct Case {
    const char* name;
    double d, angle, scale;
  };
  const Case cases[] = {{"seamCylinder", 0.01, 0.26, 4}, {"band", 0.01, 0.26, 4}, {"spheres", 0.01, 0.26, 4},
    {"twisted", 0.01, 0.26, 4}, {"bandHoleAtVertex", 0.01, 0.26, 1}, {"cuspPocket", 0.3, 0.12, 1},
    {"cube", 0.01, 0.26, 1}, {"luneQuarter", 0.01, 0.26, 1}, {"thinTube", 0.1, 0.26, 1}, {"thinTube", 0.01, 0.26, 1},
    {"cornerFoldTight", 0.1, 0.26, 1}, {"cornerFoldTight", 0.01, 0.26, 1}};
  for (const Case& c : cases) {
    cadgeom::Model m = load(c.name);
    PartOptions o = options(c.d, c.angle), fresh = o;
    o.edgeSpacingScale = fresh.edgeSpacingScale = c.scale;
    fresh.reuseVerdicts = false;
    // And within a budget of 64 KB: the least recently meshed faces' dropped, then nothing more kept.
    PartOptions tight = o;
    tight.verdictBudget = 64 << 10;
    PartMesher a(m, o), b(m, fresh), t(m, tight);
    CHECK_EQ(a.rounds(), b.rounds());
    CHECK_EQ(t.rounds(), b.rounds());
    CHECK_EQ(b.verdictPeak(), 0u);
    CHECK(t.verdictPeak() <= tight.verdictBudget);
    CHECK(a.verdictPeak() > 0u);
    for (int f = 0; f < m.faces(); f++) {
      const FaceMesh &z = t.face(f), &y = b.face(f);
      bool same = z.status == y.status && z.triangles == y.triangles && z.rejected == y.rejected &&
        z.points.size() == y.points.size();
      for (size_t i = 0; same && i < z.points.size(); i++) same = key(z.points[i]) == key(y.points[i]);
      if (!same) std::printf("  %s face %d differs within the budget\n", c.name, f);
      CHECK(same);
    }
    for (int f = 0; f < m.faces(); f++) {
      const FaceMesh &x = a.face(f), &y = b.face(f);
      bool same = x.status == y.status && x.triangles == y.triangles && x.rejected == y.rejected &&
        x.splitsWanted == y.splitsWanted && x.sampled == y.sampled && x.points.size() == y.points.size();
      for (size_t i = 0; same && i < x.points.size(); i++)
        same = key(x.points[i]) == key(y.points[i]) && key(x.normals[i]) == key(y.normals[i]);
      if (!same) std::printf("  %s face %d differs (rounds %d)\n", c.name, f, a.rounds());
      CHECK(same);
    }
  }
}

TEST_CASE("verdicts reused (reuseVerdicts) shipped far from the origin: the same meshes as asking again, positions "
  "the output would weld kept apart alike (SizeField::shippedAt)") {
  // (seamCylinder at d 0.01 shipped from an origin 1e8 away, float32 there 8 apart: points refinement would put at
  // one position.)
  cadgeom::Model m = load("seamCylinder");
  REQUIRE(m.ok());
  PartOptions o = options(0.01, 0.26), fresh = o;
  o.outputOrigin[0] = fresh.outputOrigin[0] = 1e8;
  o.outputOrigin[1] = o.outputOrigin[2] = fresh.outputOrigin[1] = fresh.outputOrigin[2] = 0;
  fresh.reuseVerdicts = false;
  PartMesher a(m, o), b(m, fresh);
  for (int f = 0; f < m.faces(); f++) {
    const FaceMesh &x = a.face(f), &y = b.face(f);
    bool same = x.status == y.status && x.triangles == y.triangles && x.points.size() == y.points.size();
    for (size_t i = 0; same && i < x.points.size(); i++) same = key(x.points[i]) == key(y.points[i]);
    if (!same) std::printf("  spheres far: face %d differs\n", f);
    CHECK(same);
  }
}

TEST_CASE("keepSteiner (the default): a face meshed again from its fourth meshing on starts from its last mesh's "
  "points, so its rounds' asks settle: bumpPatch at 0.005 in fewer rounds than from its boundary alone, both "
  "within d; the same bytes run to run") {
  // (Meshed from scratch each round, the face's leftover refusals land somewhere new each time; kept, they settle.)
  cadgeom::Model m = load("bumpPatch");
  REQUIRE(m.ok());
  PartOptions on = options(0.005, 0.26), off = on;
  off.keepSteiner = false;
  CHECK(PartOptions{}.keepSteiner);
  PartMesher a(m, on), b(m, off), c(m, on);
  for (int f = 0; f < m.faces(); f++) {
    CHECK(a.face(f).status == cadgeom::Status::ok);
    CHECK(b.face(f).status == cadgeom::Status::ok);
    CHECK(a.face(f).triangles == c.face(f).triangles);
    CHECK(a.face(f).points.size() == c.face(f).points.size());
    for (size_t i = 0; i < a.face(f).points.size() && i < c.face(f).points.size(); i++)
      CHECK(std::memcmp(&a.face(f).points[i], &c.face(f).points[i], sizeof(Vec3)) == 0);
  }
  CHECK(a.rounds() < b.rounds());
  CHECK(b.rounds() >= 4);
  // A seeded mesh that leaves a refused triangle is meshed again from its boundary alone: a kept point can stand in
  // the way of a refused triangle that asks no split (pcurveOnlyWest at 0.001: 20 rounds without that, 6 with it).
  cadgeom::Model w = load("pcurveOnlyWest");
  REQUIRE(w.ok());
  PartOptions onW = options(0.001, 0.26), offW = onW;
  offW.keepSteiner = false;
  PartMesher wa(w, onW), wb(w, offW);
  CHECK(wa.rounds() <= wb.rounds());
}

TEST_CASE("the rounds end once no split changes an edge: clampedCorner's face still asks a split EdgeMesh::split "
          "drops, the rounds short of the cap") {
  // (Its loop reversing in (u, v), the crossing segments' spans asked split within the floor. Meshing it again on the
  // same edges would ask the same, every round to the cap.)
  cadgeom::Model m = load("clampedCorner");
  PartOptions o = options(0.1, 0.26);
  PartMesher pm(m, o);
  int wanting = 0;
  for (int f = 0; f < m.faces(); f++) wanting += pm.face(f).splitsWanted > 0;
  CHECK(wanting > 0);
  CHECK(pm.rounds() < o.maxSplitRounds);
}

TEST_CASE("each face's point cap: max(capFloor, capMultiple x its expected triangles), at most capCeiling; a face "
  "past it fails, its cap and expected count said") {
  // (The band at 0.001: its expected count in closed form, 176.6 (countExpected's test).)
  cadgeom::Model band = load("band");
  REQUIRE(band.ok());
  PartOptions o = options(0.001, 0.26);
  o.capFloor = 100, o.capMultiple = 2;
  PartMesher a(band, o);
  const double want = 2 * M_PI * 2 * 5 / (std::sqrt(6 * 0.001 * 2) * std::sqrt(57.0)) / (std::sqrt(3.0) / 4);
  if (!(std::fabs(a.face(0).capExpected - want) <= 0.1 * want))
    std::printf("  band: expected %.1f before meshing, closed form %.1f\n", a.face(0).capExpected, want);
  CHECK(std::fabs(a.face(0).capExpected - want) <= 0.1 * want);
  CHECK(std::fabs(a.face(0).cap - 2 * a.face(0).capExpected) <= 1e-9 * a.face(0).cap);
  o.capCeiling = 150;
  PartMesher ceilinged(band, o);
  CHECK_EQ(ceilinged.face(0).cap, 150.0);
  o.capCeiling = 1e7, o.capMultiple = 0.01;
  PartMesher floored(band, o);
  CHECK_EQ(floored.face(0).cap, 100.0);  // (the floor)
  // bumpPatch at 0.001 meshes some 33,000 triangles against about 4,500 expected: capped at 1 x expected, it fails.
  cadgeom::Model bump = load("bumpPatch");
  REQUIRE(bump.ok());
  PartOptions c = options(0.001, 0.26);
  c.capFloor = 1000, c.capMultiple = 1;
  c.keepDefects = false;
  PartMesher pc(bump, c);
  const FaceMesh& fm = pc.face(0);
  CHECK(fm.status == cadgeom::Status::noConvergence);
  CHECK(fm.capped);
  char want2[96];
  std::snprintf(want2, sizeof want2, "(its cap %.0f: %.0f expected)", fm.cap, fm.capExpected);
  if (fm.cause.find(want2) == std::string::npos) std::printf("  bumpPatch: %s\n", fm.cause.c_str());
  CHECK(fm.cause.find(want2) != std::string::npos);
  CHECK(fm.cap > 1000);
  // The defaults: the face meshes, its cap the floor's 200,000 (about 4,500 x 64 is more).
  PartMesher pd(bump, options(0.001, 0.26));
  CHECK(pd.face(0).status == cadgeom::Status::ok);
  const double byRule = std::max(200000.0, 64 * pd.face(0).capExpected);
  CHECK_EQ(pd.face(0).cap, byRule);
}

TEST_CASE("freezeCapped (the default): a face capped at two meshings in a row, refusing no fewer, frozen: no more "
  "meshings or split requests, kept at its cap (keepDefects) or failed as capped") {
  // (bumpPatch at 0.001 capped at 1 x its expected triangles: each split round meshes it again at the cap. The retry
  // off: its rounds the freeze's alone.)
  cadgeom::Model bump = load("bumpPatch");
  REQUIRE(bump.ok());
  PartOptions c = options(0.001, 0.26);
  c.capFloor = 1000, c.capMultiple = 1, c.retryStretch = 0;
  c.freezeCapped = false;
  PartMesher off(bump, c);
  CHECK(!off.face(0).frozen);
  CHECK(off.face(0).capped);
  c.freezeCapped = true;
  PartMesher on(bump, c);
  const FaceMesh& fm = on.face(0);
  // (Off, it's meshed in every round to the rounds' limit; on, frozen at its second meshing, the first round's.)
  if (!fm.frozen || on.rounds() != 1)
    std::printf("  rounds off %d on %d, frozen %d, status %d\n", off.rounds(), on.rounds(), int(fm.frozen),
      int(fm.status));
  CHECK(off.rounds() > 2);
  CHECK(fm.frozen);
  CHECK(fm.status == cadgeom::Status::ok);
  CHECK(fm.capped);
  CHECK(fm.defectCapped);
  CHECK_EQ(on.rounds(), 1);
  c.keepDefects = false;
  PartMesher strict(bump, c);
  CHECK(strict.face(0).frozen);
  CHECK(strict.face(0).status == cadgeom::Status::noConvergence);
  CHECK(strict.face(0).cause.rfind("refinement stopped at its point cap, ", 0) == 0);
}

TEST_CASE("freezeCapped: a face frozen at its cap while its neighbour still splits their shared edge is meshed in no "
  "later round, then once more after the rounds, on the edge as its neighbour left it") {
  // bumpPair at 0.003: the gentle face (0), its cap the floor, 1000, capped by the samples the sharp face (1), its cap
  // 16 x its expected count, puts on their shared edge; frozen at its second meshing, the first round's, while the
  // sharp face's splits run on. Every meshing reports its face and round (PartProgress).
  cadgeom::Model m = load("bumpPair");
  REQUIRE(m.ok());
  PartOptions c = options(0.003, 0.26);
  c.capFloor = 1000, c.capMultiple = 16, c.retryStretch = 0;
  std::map<int, std::set<int>> rounds;
  c.progress = [&](const PartProgress& p) {
    if (p.phase == PartProgress::meshing) rounds[p.row].insert(p.round);
  };
  PartMesher pm(m, c);
  REQUIRE(pm.face(0).status == cadgeom::Status::ok);
  REQUIRE(pm.face(1).status == cadgeom::Status::ok);
  CHECK(pm.face(0).frozen);
  CHECK(pm.face(0).capped);
  CHECK(!pm.face(1).capped);
  CHECK(!pm.face(1).frozen);
  // (The sharp face meshed in rounds past the one the gentle face froze in; the gentle one in rounds 0 and 1 and
  // once after the rounds, reported at the last round's number.)
  CHECK(rounds[1].size() > 3);
  const std::set<int> expected{0, 1, pm.rounds()};
  CHECK(rounds[0] == expected);
  CHECK(pm.rounds() > 2);
  CHECK_EQ(sharedEdges(m, pm, "bumpPair"), 0);
}

TEST_CASE("retryStretch: a sliver, its boundary farther from its surface than it is wide, not retried for its patch "
  "ratio, which then says nothing of it") {
  // lanternSliver: lanternBand's circles 0.3 outside the tube, the band 0.16 across; at d 0.1 its ratio is past 1.1.
  cadgeom::Model m = load("lanternSliver");
  REQUIRE(m.ok());
  PartMesher pm(m, options(0.1, 0.26));
  const FaceMesh& fm = pm.face(0);
  REQUIRE(fm.status == cadgeom::Status::ok);
  CHECK(fm.patchRatio > 1.1);
  CHECK(!fm.retried);
}

TEST_CASE("retryStretch (the default): a lantern, its mesh far over its patch, meshed again at the capped stretch: its "
  "area the exact's; off, the lantern kept") {
  // lanternBand at d 0.1: its circles' chords sag about as far as the tube's radius, the band meshed across the tube
  // 1.14 x its area, its patch ratio past 1.1. Retried: within 1% of 2 pi r (1.6 R + 2 r sin 0.8), its ratio under
  // 1.1, its first point cap kept.
  cadgeom::Model m = load("lanternBand");
  REQUIRE(m.ok());
  const double exact = 2 * M_PI * 0.1 * (1.6 * 29 + 0.2 * std::sin(0.8));
  auto area = [](const FaceMesh& fm) {
    double a = 0;
    for (size_t t = 0; t + 2 < fm.triangles.size(); t += 3)
      a += 0.5 * norm(cross(fm.points[fm.triangles[t + 1]] - fm.points[fm.triangles[t]],
        fm.points[fm.triangles[t + 2]] - fm.points[fm.triangles[t]]));
    return a;
  };
  PartOptions o = options(0.1, 0.26);
  o.retryStretch = 0;
  PartMesher plain(m, o);
  REQUIRE(plain.face(0).status == cadgeom::Status::ok);
  CHECK(!plain.face(0).retried);
  CHECK(area(plain.face(0)) > 1.1 * exact);
  PartMesher retried(m, options(0.1, 0.26));
  const FaceMesh& fm = retried.face(0);
  REQUIRE(fm.status == cadgeom::Status::ok);
  if (!(std::fabs(area(fm) / exact - 1) < 0.01)) std::printf("  lanternBand: area %g of %g\n", area(fm), exact);
  CHECK(fm.retried);
  CHECK(std::fabs(area(fm) / exact - 1) < 0.01);
  CHECK(fm.patchRatio <= 1.1);
  CHECK_EQ(fm.cap, plain.face(0).cap);
}
