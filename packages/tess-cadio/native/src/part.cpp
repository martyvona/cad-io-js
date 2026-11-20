// part.h: the edges sampled twice, first to find each face's (u, v) box for its criteria, then with the spacing the
// criteria ask of each face's edges; every face meshed; then rounds of the splits the faces' meshes want (mesh2d.h's
// splitWanted), mapped from their Domain2 segments to edges' spans (found among the face's edges by their points: a
// segment's ends may be labelled with other edges, a junction's point carrying the edge before it), one
// EdgeMesh::split for all, and the faces whose edges changed meshed again. Every face's mesh is made
// from the samples as they finally are, so faces sharing an edge share its points.
#include "tess_cadio/part.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <set>
#include <tuple>

#include "cad_geom/surface.h"
#include "mesh2d_impl.h"
#include "poles.h"

namespace tesscadio {

/** The deviation check's progress: a report as each face's starts, and again every this many triangles measured. */
constexpr int kDeviationReport = 64;

using namespace cadgeom;

struct PartMesher::Impl {
  const Model& m;
  PartOptions o;
  std::vector<std::unique_ptr<Surface>> surfaces;
  std::vector<std::unique_ptr<SurfaceCriteria>> criteria;
  std::vector<Status> criteriaStatus;
  std::vector<std::string> criteriaWhy;
  std::unique_ptr<EdgeMesh> em;
  std::vector<FaceMesh> faces;
  /** Per face, the edges (model and pseudo) its boundary has points of, and the splits its mesh wants. */
  std::vector<std::set<int>> edgesOf;
  std::vector<std::vector<SplitRequest>> wanted;
  /** Per face, how many of its mesh's triangles are the mesher's (the fans' come after them). */
  std::vector<size_t> mesherTriangles;
  /** Each face's rounds with refinement blocked by a ring's segment (FaceMesh::ringBlocked). */
  std::vector<int> ringBlocked;
  /** The refinement floor (criteria.h): an edge's span whose chord is no longer is never split (EdgeMesh::split). */
  double floor = 0;
  /** Per face, its poles' rings (poles.h), shared across faces and cut into their edges before any face is meshed. */
  std::vector<std::vector<PoleRing>> rings;
  /**
   * Per face, its refused triangles (FaceMesh::rejected, in order): their (u, v) corners and their vertices' indices
   * into the face's points, for the deviation check (PartOptions::maxDeviationFactor).
   */
  struct Refused {
    Vec2 uv[3];
    int32_t v[3];
  };
  std::vector<std::vector<Refused>> refused;
  int rounds = 0;
  /** The progress of the pass under way (PartOptions::progress). */
  PartProgress at;
  void report(const PartProgress& p) const {
    if (o.progress) o.progress(p);
  }
  /** An EdgeMesh's progress as PartMesher's, in phase `phase`. */
  std::function<void(int, int, int)> edgeProgress(PartProgress::Phase phase) const {
    if (!o.progress) return {};
    return [this, phase](int done, int total, int face) { o.progress({phase, face, 0, done, total}); };
  }

  Impl(const Model& model, const PartOptions& options) : m(model), o(options) {}

  EdgeOptions edgeOptions() const {
    EdgeOptions e;
    e.projectMissingPcurves = o.projectMissingPcurves;
    e.deflection = o.d.linear;
    e.angle = o.d.angular;
    return e;
  }

  /**
   * The span of one of face f's edges that boundary points a and b bound (adjacent samples, found by their points: a
   * one-span edge between two vertices has neither end labelled with it, a junction's point carrying the edge before
   * it), and whether a to b runs up its samples; false if none (a pole line's segment).
   */
  /**
   * A pole's fan: a run of a loop's points at a pole (or apex) replaced by a ring of points near it, the ring's
   * chain (its ends the boundary points either side of the run) joined to the pole in 3D by triangles made here,
   * outside the mesher, which can't make good ones there: the pole line is one point in 3D, so a triangle the mesher
   * finds well shaped in (u, v) can have its two other corners on one meridian.
   */
  struct Fan {
    int loop;
    /** The chain's positions in its (new) loop, the run's ends either side; the pole's (u, v) row and side. */
    std::vector<int> chain;
    Vec3 pole;
    bool isoU;
    double at;
    /** The run's first and last points (on the row). */
    BoundaryPoint first, last;
    /** Whether the pole is smooth (its fan's normals judged) or apex-like (its deviation alone), PoleRing::smooth. */
    bool smooth = true;
  };

  static double fixedOf(Vec2 p, bool isoU) { return isoU ? p.x : p.y; }
  static double freeOf(Vec2 p, bool isoU) { return isoU ? p.y : p.x; }
  static Vec2 uvOf(double fixed, double fr, bool isoU) { return isoU ? Vec2{fixed, fr} : Vec2{fr, fixed}; }

  /**
   * Face f's runs of loop points at a pole replaced by rings (each loop's points as they come, the fans' chains
   * recorded): a run of two points or more (a pole line's, or a junction at the pole) between regular points on one
   * side of the pole's row, which are the incident curves' crossings of the ring (cutRings made them). The ring is the
   * pole's (rings[f]): its row at the pole's radius, in pieces by the edge rules (ringPieces). A pole with no ring
   * keeps its run as it is.
   */
  std::vector<Fan> makeFans(int f, FaceBoundary& fb) const {
    std::vector<Fan> fans;
    const Surface& s = *surfaces[f];
    std::vector<Singularity> sing;
    s.singularities(sing);
    if (sing.empty()) return fans;
    // At a pole: on its row in (u, v).
    auto poleOf = [&](const BoundaryPoint& p) -> int {
      for (size_t g = 0; g < sing.size(); g++) {
        if (sing[g].kind == Singularity::normalVanishes) continue;
        double F = fixedOf(p.uv, sing[g].isoU);
        if (std::fabs(F - sing[g].at) <= 1e-12 * (1 + std::fabs(sing[g].at))) return static_cast<int>(g);
      }
      return -1;
    };
    for (size_t li = 0; li < fb.loops.size(); li++) {
      std::vector<BoundaryPoint>& L = fb.loops[li];
      int n = static_cast<int>(L.size());
      std::vector<int> at(n);
      int start = -1;
      for (int i = 0; i < n; i++) {
        at[i] = poleOf(L[i]);
        if (at[i] < 0 && start < 0) start = i;
      }
      if (start < 0) continue;
      std::vector<BoundaryPoint> out;
      std::vector<Fan> mine;
      for (int k = 0; k < n;) {
        int i = (start + k) % n;
        if (at[i] < 0) {
          out.push_back(L[i]);
          k++;
          continue;
        }
        int g = at[i], len = 0;
        while (k + len < n && at[(start + k + len) % n] == g) len++;
        const Singularity& S = sing[g];
        const BoundaryPoint& a = L[(start + k - 1 + n) % n];
        const BoundaryPoint& b = L[(start + k + len) % n];
        const BoundaryPoint& first = L[i];
        const BoundaryPoint& last = L[(start + k + len - 1) % n];
        double da = fixedOf(a.uv, S.isoU) - S.at, db = fixedOf(b.uv, S.isoU) - S.at;
        // (Not where an end is on the row itself, all but: a sample inverted to the pole from an edge a little off its
        // surface, its own point not at the pole. The pole line stays as it is there.)
        double onRow = 1e-9 * (1 + std::fabs(S.at));
        const PoleRing* ring = nullptr;
        for (const PoleRing& pr : rings[f])
          if (pr.singularity == g && pr.radius > 0) ring = &pr;
        if (len < 2 || !(da * db > 0) || std::fabs(da) <= onRow || std::fabs(db) <= onRow || !ring) {
          for (int j = 0; j < len; j++) out.push_back(L[(start + k + j) % n]);
          k += len;
          continue;
        }
        Fan fan;
        fan.loop = static_cast<int>(li);
        fan.isoU = S.isoU;
        fan.at = S.at;
        fan.pole = S.point;
        for (int j = 0; j < len; j++) {
          const BoundaryPoint& q = L[(start + k + j) % n];
          if (q.kind == BoundaryPoint::edgeSample || q.kind == BoundaryPoint::pseudoSample) fan.pole = q.point;
        }
        fan.first = first, fan.last = last;
        double side = da > 0 ? 1 : -1, q0 = freeOf(first.uv, S.isoU), q1 = freeOf(last.uv, S.isoU);
        // The ring: its pole's (poles.h: the radius by the pole-ring rule, one reach for every face at the pole, cut
        // into the curves through it), in pieces by the edge rules, at the radius throughout so it stays under the
        // clearance. An end off the row by over half as much again (a curve whose crossing at the shared reach is
        // farther out in this face's fixed coordinate) is reached along its own row of the free coordinate, so the
        // chain runs beside no other boundary. The pieces span the chain from end to end: an end on the ring is
        // where the chain starts in the free coordinate, which can be far along the row from the run's own ends (a
        // curve's crossing of the ring away from where it meets the pole), and the ring's segments are never split
        // later.
        const PoleRing& R = *ring;
        const double r = R.radius;
        fan.smooth = R.smooth;
        const bool farA = std::fabs(da) > 1.5 * r, farB = std::fabs(db) > 1.5 * r;
        const double lo = farA ? q0 : freeOf(a.uv, S.isoU), hi = farB ? q1 : freeOf(b.uv, S.isoU);
        const int pieces = ringPieces(s, R, {lo, hi}, r, o.d.linear, o.d.angular);
        std::vector<double> qs;
        double piece = (hi - lo) / pieces;
        if (farA) qs.push_back(q0);
        for (int j = 1; j < pieces; j++) qs.push_back(lo + j * piece);
        if (farB) qs.push_back(q1);
        fan.chain.push_back(static_cast<int>(out.size()) - 1);
        for (double qj : qs) {
          BoundaryPoint q;
          q.kind = BoundaryPoint::vertexPoint;
          q.uv = uvOf(S.at + side * r, qj, S.isoU);
          SurfacePoint sp;
          s.eval(q.uv.x, q.uv.y, 0, sp);
          q.point = sp.p;
          fan.chain.push_back(static_cast<int>(out.size()));
          out.push_back(q);
        }
        fan.chain.push_back(static_cast<int>(out.size()));  // b, pushed next (or the loop's first point)
        mine.push_back(fan);
        k += len;
      }
      // A chain's last position past the end is the loop's first point (b was where the rotation started).
      for (Fan& fan : mine) {
        if (fan.chain.front() < 0) fan.chain.front() += static_cast<int>(out.size());
        if (fan.chain.back() >= static_cast<int>(out.size())) fan.chain.back() -= static_cast<int>(out.size());
        fans.push_back(fan);
      }
      L = out;
    }
    return fans;
  }

  /** Triangle t turned counterclockwise in (u, v). */
  static void orient(Vec2 t[3]) {
    if (cross(t[1] - t[0], t[2] - t[0]) < 0) std::swap(t[1], t[2]);
  }

  /**
   * Why the mesher refused face f's domain, from the segments it names (mesh2d.h): two of the boundary's points at
   * one (u, v), a segment through another point, or two that cross; and what they're of (an edge's samples, a cut's,
   * a pole line, a pole's ring).
   */
  static std::string meshWhy(const Mesh2& mesh, const std::vector<BoundaryPoint>& bp) {
    const std::vector<int32_t>& r = mesh.rejected;
    auto of = [&](int32_t i) -> std::string {
      if (i < 0 || i >= static_cast<int32_t>(bp.size())) return "a point";
      switch (bp[i].kind) {
        case BoundaryPoint::edgeSample: return "an edge";
        case BoundaryPoint::pseudoSample: return "a cut";
        case BoundaryPoint::poleLine: return "a pole line";
        default: return "a pole's ring or a vertex";
      }
    };
    if (r.size() == 2) return "two of its boundary's points at one (u, v) (" + of(r[0]) + ", " + of(r[1]) + ")";
    if (r.size() >= 4 && r[2] == r[3])
      return "its boundary in (u, v) through its own point (" + of(r[0]) + " through " + of(r[2]) + ")";
    if (r.size() >= 4) return "its boundary in (u, v) crossing itself (" + of(r[0]) + " and " + of(r[2]) + ")";
    return "its boundary not a domain in (u, v) (a loop under 3 points, a segment not closed)";
  }

  bool spanOf(int f, const BoundaryPoint& a, const BoundaryPoint& b, int& edge, int& span, bool& forward) const {
    auto same = [](Vec3 x, Vec3 y) { return x.x == y.x && x.y == y.y && x.z == y.z; };
    for (int e : edgesOf[f]) {
      const std::vector<Vec3>& p = em->edge(e).points;
      for (size_t j = 0; j + 1 < p.size(); j++)
        if ((same(p[j], a.point) && same(p[j + 1], b.point)) || (same(p[j], b.point) && same(p[j + 1], a.point))) {
          edge = e, span = static_cast<int>(j), forward = same(p[j], a.point);
          return true;
        }
    }
    return false;
  }

  /**
   * Faces left farther from their surfaces than maxDeviationFactor x the larger of the deflection and the face's
   * tolerance (cad-geom's Tolerances::face: the part's, widened by the face's own; the limit) fail: below its
   * tolerance the model doesn't say where the surface is. A refused
   * triangle is settled without measuring where its criteria's bound (deviationBound) plus its corners' distances from
   * the surface's points at their (u, v) is within the limit: its points' distances are at most that. Otherwise the
   * points of its barycentric lattice of order 4 but its corners are inverted onto the surface, the face failing at the
   * first past the limit: the verdict as measuring them all would give it (where inversion finds the nearest point),
   * the measure in its cause a lower bound on the worst.
   */
  void checkDeviation() {
    if (!(o.maxDeviationFactor > 0)) return;
    const cadgeom::Tolerances tols(m);
    const int nf = static_cast<int>(faces.size());
    for (int f = 0; f < nf; f++) {
      FaceMesh& fm = faces[f];
      if (fm.status != Status::ok || fm.rejected.empty() || !surfaces[f]) continue;
      const double within = std::fmax(o.d.linear, tols.face(f)), limit = o.maxDeviationFactor * within;
      const Surface& s = *surfaces[f];
      const SurfaceDomain D = s.domain();
      const PartProgress here{PartProgress::deviation, f, rounds, f, nf};
      report(here);
      double worst = 0;
      bool past = false;
      for (size_t k = 0; k < fm.rejected.size() && !past; k++) {
        // (The box's bound first, the pieces' only where that doesn't settle it: over a B-spline's many knots the
        // pieces cost far more, tens of thousands of refused triangles at a point cap.)
        if (refused[f].size() == fm.rejected.size() && criteria[f]) {
          const Refused& r = refused[f][k];
          double gap = 0;
          for (int i = 0; i < 3; i++) {
            SurfacePoint q;
            gap = s.eval(r.uv[i].x, r.uv[i].y, 0, q) == Status::ok ? std::fmax(gap, norm(fm.points[r.v[i]] - q.p))
                                                                   : INFINITY;
          }
          double bound;
          if (gap < limit && criteria[f]->deviationBound(r.uv, bound, false) && bound + gap <= limit) continue;
          if (gap < limit && criteria[f]->deviationBound(r.uv, bound, true) && bound + gap <= limit) continue;
        }
        if (fm.deviationMeasured++ % kDeviationReport == kDeviationReport - 1) report(here);
        const int32_t t = fm.rejected[k];
        // Each corner's (u, v), where the refused triangle's record has it: the surface's point at a lattice point's
        // barycentric (u, v), inside its domain, is a point of the surface, so its distance bounds the point's own
        // from above, and only a point it doesn't put within the limit is inverted (globally, over the whole domain:
        // dear on a B-spline).
        Vec2 uvc[3];
        bool haveUv = refused[f].size() == fm.rejected.size();
        for (int c = 0; c < 3 && haveUv; c++) {
          int at = -1;
          for (int i = 0; i < 3; i++)
            if (refused[f][k].v[i] == fm.triangles[3 * t + c]) at = i;
          haveUv = at >= 0;
          if (haveUv) uvc[c] = refused[f][k].uv[at];
        }
        for (int i = 0; i <= 4 && !past; i++)
          for (int j = 0; i + j <= 4 && !past; j++) {
            if ((i == 4) || (j == 4) || (i + j == 0)) continue;  // (the corners: on the surface)
            const Vec3 x = (i / 4.0) * fm.points[fm.triangles[3 * t]] + (j / 4.0) * fm.points[fm.triangles[3 * t + 1]]
              + ((4 - i - j) / 4.0) * fm.points[fm.triangles[3 * t + 2]];
            if (haveUv) {
              const Vec2 uv = (i / 4.0) * uvc[0] + (j / 4.0) * uvc[1] + ((4 - i - j) / 4.0) * uvc[2];
              SurfacePoint q;
              const bool inside = uv.x >= D.u.lo && uv.x <= D.u.hi && uv.y >= D.v.lo && uv.y <= D.v.hi;
              if (inside && s.eval(uv.x, uv.y, 0, q) == Status::ok && norm(x - q.p) <= limit) continue;
            }
            const SurfaceInversion inv = invertSurface(s, x, D.u, D.v, 1e-3 * o.d.linear);
            if (inv.status != Status::ok) continue;
            worst = std::fmax(worst, inv.distance);
            past = worst > limit;
          }
      }
      fm.worstDeviation = worst;
      if (!past) continue;
      char why[240];
      std::snprintf(why, sizeof why, "meshed past its deflection: at least %.3g x the deflection (a refused triangle's "
        "point inverted onto its surface), past %.3g x max(d, tol) = %.3g x %.3g mm", worst / o.d.linear,
        o.maxDeviationFactor, o.maxDeviationFactor, within);
      fm.status = Status::noConvergence;
      fm.cause = why;
      fm.points.clear(), fm.normals.clear(), fm.triangles.clear(), fm.rejected.clear();
      refused[f].clear();
    }
  }

  /**
   * Faces whose mesher's triangles include one turned against its surface (its facet against the mean of its corners'
   * normals) fail as one past its deflection does (PartOptions::failTurnedOver): wrong output however small. Such a
   * triangle is one its criteria refused that refinement didn't mend (they refuse a facet turned against any corner's
   * normal). Not judged so: a pole's fans, and a triangle with a corner within the face's tolerance of a pole or apex
   * (the normal there a limit, on a strongly curved patch).
   */
  void checkFacing() {
    if (!o.failTurnedOver) return;
    const cadgeom::Tolerances tols(m);
    for (size_t f = 0; f < faces.size(); f++) {
      FaceMesh& fm = faces[f];
      if (fm.status != Status::ok || !surfaces[f]) continue;
      std::vector<Singularity> sing;
      surfaces[f]->singularities(sing);
      const double near = tols.face(static_cast<int>(f));
      auto atSingular = [&](Vec3 p) {
        for (const Singularity& g : sing)
          if (g.kind != Singularity::normalVanishes && norm(p - g.point) <= near) return true;
        return false;
      };
      int against = 0;
      for (size_t t = 0; t + 2 < fm.triangles.size() && t / 3 < mesherTriangles[f]; t += 3) {
        const int32_t* v = &fm.triangles[t];
        if (atSingular(fm.points[v[0]]) || atSingular(fm.points[v[1]]) || atSingular(fm.points[v[2]])) continue;
        const Vec3 g = cross(fm.points[v[1]] - fm.points[v[0]], fm.points[v[2]] - fm.points[v[0]]);
        against += facetAgainst(g, fm.normals[v[0]] + fm.normals[v[1]] + fm.normals[v[2]]);
      }
      if (!against) continue;
      char why[160];
      std::snprintf(why, sizeof why, "meshed with %d triangles turned against its surface (their facets against their "
        "corners' normals, refused and not mended)", against);
      fm.status = Status::noConvergence;
      fm.cause = why;
      fm.points.clear(), fm.normals.clear(), fm.triangles.clear(), fm.rejected.clear();
    }
  }

  void meshFace(int f) {
    at.row = f;
    if (o.progress) o.progress(at);
    FaceMesh& out = faces[f];
    out = {};
    refused[f].clear();
    wanted[f].clear();
    edgesOf[f].clear();
    if (!surfaces[f]) {
      out.cause = "its surface not made (a kind or form cad-geom lacks)";
      return;
    }
    if (!criteria[f]) {
      out.status = criteriaStatus[f];
      out.cause = criteriaWhy[f];
      return;
    }
    FaceBoundary fb = em->face(f);
    if (fb.status != Status::ok && fb.status != Status::singular) {
      out.status = fb.status;
      out.cause = fb.cause;
      return;
    }
    if (fb.status == Status::singular) {
      out.note = "a seam's side in (u, v) not settled by its neighbours";
      out.seamUnsettled = true;
    }
    out.againstSense = fb.againstSense;
    out.foldsRepaired = fb.foldsRepaired;
    // (Not where the seam's side wasn't settled: such a boundary is a guess, and its face stays singular.)
    std::vector<Fan> fans;
    if (fb.status == Status::ok) fans = makeFans(f, fb);
    // The domain: the loops' points, then the interior chains' (segments between consecutive ones). A point exactly
    // equal to one before, in (u, v) and in 3D, is that point again (mesh2d.h's Domain2): a vertex a loop passes
    // twice (a hole of circles touching at their vertices), or loops share.
    Domain2 d;
    std::vector<BoundaryPoint> bp;
    std::map<std::tuple<double, double, double, double, double>, int32_t> seen;
    auto index = [&](const BoundaryPoint& p) {
      auto [it, added] = seen.try_emplace({p.uv.x, p.uv.y, p.point.x, p.point.y, p.point.z},
        static_cast<int32_t>(bp.size()));
      if (added) bp.push_back(p);
      return it->second;
    };
    for (const auto& l : fb.loops) {
      std::vector<int32_t> loop;
      for (const BoundaryPoint& p : l) loop.push_back(index(p));
      d.loops.push_back(loop);
    }
    for (const auto& c : fb.interior) {
      std::vector<int32_t> chain;
      for (const BoundaryPoint& p : c) chain.push_back(index(p));
      for (size_t i = 0; i + 1 < chain.size(); i++) d.segments.insert(d.segments.end(), {chain[i], chain[i + 1]});
    }
    // Its edges: its loops' model edges, and the pseudo-edges its boundary has.
    for (int i = 0; i < m.faceLoopCount(f); i++) {
      int l = m.faceFirstLoop(f) + i;
      if (m.loopKind(l) == CBR_LOOP_EDGE)
        for (int k = 0; k < m.loopCount(l); k++) edgesOf[f].insert(m.coedgeEdge(m.loopFirst(l) + k));
    }
    for (const BoundaryPoint& p : bp) {
      d.points.push_back(p.uv);
      if (p.kind == BoundaryPoint::pseudoSample) edgesOf[f].insert(p.edgeIndex);
    }
    // The segments the edges won't split (an edge's span whose chord is within the refinement floor, as
    // EdgeMesh::split has it): frozen, so the mesher inserts past them rather than asking.
    auto frozenSpan = [&](int32_t a, int32_t b) -> uint8_t {
      int edge, span;
      bool forward;
      return a != b && norm(bp[b].point - bp[a].point) <= floor && spanOf(f, bp[a], bp[b], edge, span, forward);
    };
    for (const auto& l : d.loops)
      for (size_t k = 0; k < l.size(); k++) d.frozen.push_back(frozenSpan(l[k], l[(k + 1) % l.size()]));
    for (size_t k = 0; k + 1 < d.segments.size(); k += 2)
      d.frozen.push_back(frozenSpan(d.segments[k], d.segments[k + 1]));
    // Each fan's ring as domain points (its chain's positions in its loop, through the loop's indices).
    std::vector<std::vector<int32_t>> ring(fans.size());
    for (size_t k = 0; k < fans.size(); k++)
      for (int j : fans[k].chain) ring[k].push_back(d.loops[fans[k].loop][j]);
    MeshOptions mo;
    mo.maxPoints = o.maxPointsPerFace;
    mo.minAngle = o.minAngle;
    if (o.progress) mo.onWork = [this] { o.progress(at); };
    static_assert(sizeof(Mesh2Detail::inserted) / sizeof(int) == kInsertionKinds);
    Mesh2Detail detail;
    Mesh2 mesh = o.countInsertions ? mesh2Detailed(d, *criteria[f], mo, &detail) : mesh2(d, *criteria[f], mo);
    if (o.countInsertions) std::copy(detail.inserted, detail.inserted + kInsertionKinds, out.inserted);
    if (mesh.status != Status::ok && mesh.status != Status::noConvergence) {
      // (A boundary whose seam side wasn't settled fails for that.)
      out.status = fb.status == Status::singular ? Status::singular : mesh.status;
      out.cause = fb.status == Status::singular ? fb.cause : meshWhy(mesh, bp);
      // Two segments that cross, or one through a point: each segment that is an edge's span split at its middle,
      // for the next round to mesh again (two edges leaving a vertex nearly tangent: the coarser one's chord across
      // the other's samples, which no criterion of either edge sees).
      if (mesh.rejected.size() >= 4)
        for (size_t k = 0; k < 4; k += 2) {
          const int32_t a = mesh.rejected[k], b = mesh.rejected[k + 1];
          int edge, span;
          bool forward;
          if (a >= 0 && b >= 0 && a < static_cast<int32_t>(bp.size()) && b < static_cast<int32_t>(bp.size()) &&
            spanOf(f, bp[a], bp[b], edge, span, forward))
            wanted[f].push_back({edge, span, 0.5});
        }
      out.splitsWanted = static_cast<int>(wanted[f].size());
      return;
    }
    out.status = Status::ok;
    if (mesh.status == Status::noConvergence) {
      out.note += std::string(out.note.empty() ? "" : "; ") + "refinement stopped at its point cap";
      out.capped = true;
    }
    // The segments' pairs, as mesh2d.h numbers them: each loop's, then the interior ones.
    std::vector<std::pair<int32_t, int32_t>> segs;
    for (const auto& l : d.loops)
      for (size_t k = 0; k < l.size(); k++) segs.push_back({l[k], l[(k + 1) % l.size()]});
    for (size_t k = 0; k + 1 < d.segments.size(); k += 2) segs.push_back({d.segments[k], d.segments[k + 1]});
    // (A ring's segments, consecutive in a fan's ring, aren't an edge's: counted, as refinement is blocked there.)
    std::set<std::pair<int32_t, int32_t>> ringSegments;
    for (const auto& rg : ring)
      for (size_t j = 0; j + 1 < rg.size(); j++)
        ringSegments.insert({std::min(rg[j], rg[j + 1]), std::max(rg[j], rg[j + 1])});
    bool blocked = false;
    for (const SplitWanted& w : mesh.splitWanted) {
      if (w.segment < 0 || w.segment >= static_cast<int32_t>(segs.size())) continue;
      int edge, span;
      bool forward;
      auto [a, b] = segs[w.segment];
      if (spanOf(f, bp[a], bp[b], edge, span, forward))
        wanted[f].push_back({edge, span, forward ? w.fraction : 1 - w.fraction});
      else
        blocked = blocked || ringSegments.count({std::min(a, b), std::max(a, b)});
    }
    if (blocked) ringBlocked[f]++;
    out.ringBlocked = ringBlocked[f];
    // (A pole line's segments, which the floored metric can find long, can't be split; a ring is fixed: its segments
    // are this code's own, and the edges' spans inside it are kept empty, cutRings.)
    out.splitsWanted = static_cast<int>(wanted[f].size());
    out.sampled = !criteria[f]->bounded();
    // In 3D: the boundary's points exactly, the mesher's on the surface.
    const Surface& s = *surfaces[f];
    double sense = m.faceSameSense(f) ? 1 : -1;
    size_t n = mesh.points.size();
    out.points.resize(n);
    out.normals.assign(n, Vec3{0, 0, 0});
    std::vector<char> regular(n, 0);
    for (size_t i = 0; i < n; i++) {
      if (i < bp.size()) {
        out.points[i] = bp[i].point;
      } else {
        SurfacePoint q;
        s.eval(mesh.points[i].x, mesh.points[i].y, 0, q);
        out.points[i] = q.p;
      }
      // (At a singular point, the limit where the surface gives one: surface.h's normal() with Status::singular.)
      Vec3 nn;
      Status ns = s.normal(mesh.points[i].x, mesh.points[i].y, nn);
      if ((ns == Status::ok || ns == Status::singular) && std::isfinite(norm(nn)) && std::fabs(norm(nn) - 1) < 1e-9) {
        out.normals[i] = sense * nn;
        regular[i] = 1;
      }
    }
    auto samePoint = [](Vec3 a, Vec3 b) { return a.x == b.x && a.y == b.y && a.z == b.z; };
    std::set<int32_t> refusedHere(mesh.rejected.begin(), mesh.rejected.end());
    for (size_t t = 0; t + 2 < mesh.triangles.size(); t += 3) {
      int32_t a = mesh.triangles[t], b = mesh.triangles[t + 1], c = mesh.triangles[t + 2];
      if (samePoint(out.points[a], out.points[b]) || samePoint(out.points[b], out.points[c]) ||
        samePoint(out.points[a], out.points[c]))
        continue;  // two corners on a pole line: no triangle in 3D
      if (refusedHere.count(static_cast<int32_t>(t / 3))) {
        out.rejected.push_back(static_cast<int32_t>(out.triangles.size() / 3));
        const Vec2 tri[3] = {mesh.points[a], mesh.points[b], mesh.points[c]};
        out.refusedBy[static_cast<int>(criteria[f]->refusal(tri))]++;
        refused[f].push_back({{tri[0], tri[1], tri[2]}, {a, b, c}});
      }
      // Counterclockwise in (u, v) is about S_u x S_v: turned where the face's normal is the opposite.
      if (sense > 0) out.triangles.insert(out.triangles.end(), {a, b, c});
      else out.triangles.insert(out.triangles.end(), {a, c, b});
    }
    mesherTriangles[f] = out.triangles.size() / 3;
    // The fans: each ring's chain to its pole, a point of its own (the run's edge sample there, else the surface's).
    for (size_t k = 0; k < fans.size(); k++) {
      const Fan& fan = fans[k];
      int32_t pole = static_cast<int32_t>(out.points.size());
      out.points.push_back(fan.pole);
      Vec3 nn{0, 0, 0};
      double q0 = freeOf(fan.first.uv, fan.isoU), q1 = freeOf(fan.last.uv, fan.isoU);
      Vec2 puv = uvOf(fan.at, 0.5 * (q0 + q1), fan.isoU);
      Status ns = s.normal(puv.x, puv.y, nn);
      bool reg = (ns == Status::ok || ns == Status::singular) && std::isfinite(norm(nn)) &&
        std::fabs(norm(nn) - 1) < 1e-9;
      out.normals.push_back(reg ? sense * nn : Vec3{0, 0, 0});
      regular.push_back(reg);
      for (size_t j = 0; j + 1 < ring[k].size(); j++) {
        int32_t a = ring[k][j], b = ring[k][j + 1];
        double qa = freeOf(mesh.points[a], fan.isoU), qb = freeOf(mesh.points[b], fan.isoU);
        const Vec2 apex = uvOf(fan.at, 0.5 * (qa + qb), fan.isoU);
        Vec2 tri[3] = {mesh.points[a], mesh.points[b], apex};
        orient(tri);
        if (!(fan.smooth ? criteria[f]->acceptFan(tri) : criteria[f]->acceptDeviation(tri))) {
          out.rejected.push_back(static_cast<int32_t>(out.triangles.size() / 3));
          out.refusedBy[static_cast<int>(criteria[f]->refusal(tri, fan.smooth, true))]++;
          refused[f].push_back({{mesh.points[a], mesh.points[b], apex}, {a, b, pole}});
        }
        // Counterclockwise about the face's normals at its other corners (in (u, v) an end's triangle along its row
        // has no area to tell by).
        Vec3 g = cross(out.points[b] - out.points[a], out.points[pole] - out.points[a]);
        if (dot(g, out.normals[a] + out.normals[b]) >= 0) out.triangles.insert(out.triangles.end(), {a, b, pole});
        else out.triangles.insert(out.triangles.end(), {b, a, pole});
      }
    }
    n = out.points.size();
    // At a singular point (a pole, an apex) with no limit given: the mean of its triangles' other corners' normals,
    // else of the triangles' own normals, else any regular vertex's.
    for (size_t i = 0; i < n; i++) {
      if (regular[i]) continue;
      Vec3 sum{0, 0, 0}, geo{0, 0, 0};
      for (size_t t = 0; t + 2 < out.triangles.size(); t += 3) {
        const int32_t* v = &out.triangles[t];
        if (v[0] != int32_t(i) && v[1] != int32_t(i) && v[2] != int32_t(i)) continue;
        for (int k = 0; k < 3; k++)
          if (v[k] != int32_t(i) && regular[v[k]]) sum = sum + out.normals[v[k]];
        geo = geo + cross(out.points[v[1]] - out.points[v[0]], out.points[v[2]] - out.points[v[0]]);
      }
      Vec3 pick = norm(sum) > 0 ? sum : geo;
      if (!(norm(pick) > 0))
        for (size_t j = 0; j < n && !(norm(pick) > 0); j++)
          if (regular[j]) pick = out.normals[j];
      out.normals[i] = norm(pick) > 0 ? (1 / norm(pick)) * pick : Vec3{0, 0, 1};
    }
  }
};

PartMesher::PartMesher(const Model& model, const PartOptions& options) : impl_(new Impl(model, options)) {
  Impl& I = *impl_;
  const Model& m = model;
  int nf = m.faces();
  I.surfaces.resize(nf);
  I.criteria.resize(nf);
  I.criteriaStatus.assign(nf, Status::unsupported);
  I.criteriaWhy.assign(nf, "");
  I.faces.resize(nf);
  I.edgesOf.resize(nf);
  I.wanted.resize(nf);
  I.rings.resize(nf);
  I.mesherTriangles.assign(nf, 0);
  I.ringBlocked.assign(nf, 0);
  I.refused.resize(nf);
  const cadgeom::Tolerances tols(m);
  I.floor = refinementFloor(tols.part(), I.o.d.linear);
  for (int f = 0; f < nf; f++) {
    Status st;
    // (A face with no loops too: its surface's natural extent, where it has one, edges.h.)
    I.report({PartProgress::surfaces, f, 0, f, nf});
    I.surfaces[f] = closedSurface(m, tols, f, st);
  }
  // The edges sampled once, at their own deflection and angle; the faces' (u, v) boxes from those samples, their
  // criteria, then the edges refined to the spacing the criteria ask (EdgeMesh::respace): each use traced once.
  std::vector<double> spacing(nf, INFINITY);
  {
    EdgeOptions eo = I.edgeOptions();
    eo.progress = I.edgeProgress(PartProgress::edges);
    I.em = std::make_unique<EdgeMesh>(m, eo);
    EdgeMesh& first = *I.em;
    for (int f = 0; f < nf; f++) {
      I.report({PartProgress::criteria, f, 0, f, nf});
      if (!I.surfaces[f]) continue;
      FaceBoundary fb = first.face(f);
      Box2 box{{INFINITY, -INFINITY}, {INFINITY, -INFINITY}};
      auto add = [&](Vec2 p) {
        box.x.lo = std::min(box.x.lo, p.x), box.x.hi = std::max(box.x.hi, p.x);
        box.y.lo = std::min(box.y.lo, p.y), box.y.hi = std::max(box.y.hi, p.y);
      };
      for (const auto& l : fb.loops)
        for (const BoundaryPoint& p : l) add(p.uv);
      for (const auto& c : fb.interior)
        for (const BoundaryPoint& p : c) add(p.uv);
      if (!(box.x.lo <= box.x.hi)) {
        I.criteriaStatus[f] = fb.status == Status::ok ? Status::invalidModel : fb.status;
        I.criteriaWhy[f] = !fb.cause.empty() ? fb.cause : "its boundary gives no points in (u, v)";
        continue;
      }
      I.criteria[f] = makeCriteria(m, f, *I.surfaces[f], box, I.o.d, I.criteriaStatus[f]);
      if (!I.criteria[f]) I.criteriaWhy[f] = "no criteria for it (its (u, v) box not finite)";
      if (I.criteria[f]) spacing[f] = I.criteria[f]->edgeSpacing() * I.o.edgeSpacingScale;
    }
  }
  I.em->respace(spacing);
  // The poles' rings: each face's, one reach per pole across faces, cut into the edges through them once for all.
  {
    std::vector<const Surface*> sp(nf, nullptr);
    for (int f = 0; f < nf; f++) {
      sp[f] = I.surfaces[f].get();
      if (!I.surfaces[f] || !I.criteria[f]) continue;
      FaceBoundary fb = I.em->face(f);
      if (fb.status != Status::ok) continue;
      I.rings[f] = facePoles(m, f, *I.surfaces[f], fb, *I.em, *I.criteria[f], tols.face(f), I.o.d.linear,
        I.o.d.angular);
    }
    shareRings(sp, I.rings, tols.part());
    std::vector<RingCut> cuts;
    std::set<std::tuple<int, double, double>> seen;
    for (int f = 0; f < nf; f++)
      for (const PoleRing& r : I.rings[f])
        for (const RingCut& c : ringCuts(*I.em, r))
          if (seen.insert({c.edge, c.approach, c.crossing}).second) cuts.push_back(c);
    if (!cuts.empty()) I.em->cutRings(cuts);
  }
  I.at = {PartProgress::meshing, 0, 0, 0, nf};
  for (int f = 0; f < nf; f++, I.at.facesDone++) I.meshFace(f);
  for (I.rounds = 0; I.rounds < I.o.maxSplitRounds; I.rounds++) {
    // Every face's wanted splits, each span once (the first face's fraction).
    std::vector<SplitRequest> requests;
    std::set<std::pair<int, int>> seen;
    for (int f = 0; f < nf; f++)
      for (const SplitRequest& r : I.wanted[f])
        if (seen.insert({r.edge, r.span}).second) requests.push_back(r);
    if (requests.empty()) break;
    I.report({PartProgress::splitting, -1, I.rounds + 1, 0, static_cast<int>(requests.size())});
    I.em->split(requests);
    std::set<int> touched;
    for (const SplitRequest& r : requests) touched.insert(r.edge);
    std::vector<int> redo;
    for (int f = 0; f < nf; f++) {
      bool again = false;
      for (int e : touched) again = again || I.edgesOf[f].count(e);
      if (again) redo.push_back(f);
    }
    I.at = {PartProgress::meshing, 0, I.rounds + 1, 0, static_cast<int>(redo.size())};
    for (int f : redo) {
      I.meshFace(f);
      I.at.facesDone++;
    }
  }
  I.checkDeviation();
  I.checkFacing();
}

PartMesher::~PartMesher() { delete impl_; }
const FaceMesh& PartMesher::face(int f) const { return impl_->faces[f]; }
const EdgeMesh& PartMesher::edges() const { return *impl_->em; }
int PartMesher::rounds() const { return impl_->rounds; }

} // namespace tesscadio
